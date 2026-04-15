import {
  type PublicClient,
  type WalletClient,
  type Address,
  type Hash,
  encodeFunctionData,
  formatUnits,
  maxUint128,
  parseEventLogs,
} from "viem";
import { nonfungiblePositionManagerAbi } from "../abi/NonfungiblePositionManager.js";
import { CONTRACTS } from "../config/index.js";
import { getTokenBalance, ensureApproval } from "../utils/tokens.js";
import { writeSession } from "../utils/logger.js";
import { Swapper, type SwapResult } from "./Swapper.js";

export interface RebalanceParams {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  recipient: Address;
  /** Current pool price (token1 per token0) from slot0. */
  currentPrice: number;
  /** Basis-point slippage tolerance for the mint (default 50 = 0.5 %). */
  slippageBps?: number;
  /**
   * If simulated mint deposit (token1 value) is below this fraction of the
   * pre-mint wallet total (token1 value), skip mint. 0 disables the check.
   */
  minMintDeployedToWalletRatio?: number;
}

export interface RebalanceResult {
  withdrawTx: Hash | null;
  swap: SwapResult;
  mintTx: Hash | null;
  /** The tokenId of the newly minted position NFT, or the prior id if mint was skipped. */
  newTokenId: bigint;
  /** True when mint was skipped because simulated deposit was below the ratio threshold. */
  mintSkipped: boolean;
  amount0Used: bigint;
  amount1Used: bigint;
  /** Post-withdraw balances (includes collected fees). */
  collected0: { formatted: string; symbol: string };
  collected1: { formatted: string; symbol: string };
  /** Final wallet balances after mint. */
  walletBal0: { formatted: string; symbol: string };
  walletBal1: { formatted: string; symbol: string };
}

export class Rebalancer {
  private readonly positionManager: Address;
  private readonly swapper: Swapper;

  constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
  ) {
    this.positionManager = CONTRACTS.nonfungiblePositionManager;
    this.swapper = new Swapper(walletClient, publicClient);
  }

  /**
   * Three-phase rebalance:
   *
   *   Phase 1:  decreaseLiquidity + collect  → tokens return to wallet
   *   Phase 2:  read balances → detect imbalance → swap to ~50/50
   *   Phase 3:  read NEW balances → mint with balanced amounts
   */
  async execute(
    positionId: bigint,
    liquidity: bigint,
    params: RebalanceParams,
  ): Promise<RebalanceResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient has no account attached");

    const targetRange = { tickLower: params.tickLower, tickUpper: params.tickUpper };

    // ======================= Phase 1: Withdraw =======================
    console.log("[Rebalancer] Phase 1/3: withdrawing liquidity…");
    writeSession("WITHDRAW", targetRange);
    const withdrawTx = await this.withdraw(positionId, liquidity, account.address);

    // ======================= Phase 2: Swap to balance =================
    console.log("[Rebalancer] Phase 2/3: checking portfolio balance…");
    writeSession("SWAP", targetRange);
    const [bal0Pre, bal1Pre] = await Promise.all([
      getTokenBalance(this.publicClient, params.token0, account.address),
      getTokenBalance(this.publicClient, params.token1, account.address),
    ]);
    console.log(
      `[Rebalancer] post-withdraw: ${bal0Pre.formatted} ${bal0Pre.symbol} / ${bal1Pre.formatted} ${bal1Pre.symbol}`,
    );

    const swap = await this.swapper.balancePortfolio(
      bal0Pre,
      bal1Pre,
      params.currentPrice,
      params.fee,
    );

    // ======================= Phase 3: Mint ============================
    console.log("[Rebalancer] Phase 3/3: minting new position…");
    writeSession("MINT", targetRange);

    const blockTag = swap.confirmedBlock
      ? ({ blockNumber: swap.confirmedBlock } as const)
      : undefined;

    const [bal0, bal1] = await Promise.all([
      getTokenBalance(this.publicClient, params.token0, account.address, blockTag),
      getTokenBalance(this.publicClient, params.token1, account.address, blockTag),
    ]);

    console.log(
      `[Rebalancer] pre-mint: ${bal0.formatted} ${bal0.symbol} / ${bal1.formatted} ${bal1.symbol}`,
    );

    if (bal0.raw === 0n && bal1.raw === 0n) {
      throw new Error("Both token balances are 0 — nothing to mint. Aborting.");
    }

    await Promise.all([
      ensureApproval(this.publicClient, this.walletClient, params.token0, this.positionManager, bal0.raw),
      ensureApproval(this.publicClient, this.walletClient, params.token1, this.positionManager, bal1.raw),
    ]);

    const minRatio = params.minMintDeployedToWalletRatio ?? 0;
    if (minRatio > 0) {
      const preMintWalletToken1 = portfolioValueToken1(
        bal0.raw,
        bal1.raw,
        bal0.decimals,
        bal1.decimals,
        params.currentPrice,
      );

      if (preMintWalletToken1 > 0) {
        let mintSkipped = false;
        try {
          const previewDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
          const { result: mintPreview } = await this.publicClient.simulateContract({
            address: this.positionManager,
            abi: nonfungiblePositionManagerAbi,
            functionName: "mint",
            args: [
              {
                token0: params.token0,
                token1: params.token1,
                fee: params.fee,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                amount0Desired: bal0.raw,
                amount1Desired: bal1.raw,
                amount0Min: 0n,
                amount1Min: 0n,
                recipient: params.recipient,
                deadline: previewDeadline,
              },
            ],
            account,
          });
          const [, , simAmount0, simAmount1] = mintPreview;

          const deployedToken1 = portfolioValueToken1(
            simAmount0,
            simAmount1,
            bal0.decimals,
            bal1.decimals,
            params.currentPrice,
          );
          const threshold = preMintWalletToken1 * minRatio;
          if (deployedToken1 < threshold) {
            console.log(
              `[Rebalancer] mint skipped — simulated deposit ≈${deployedToken1.toFixed(4)} (token1) ` +
                `< ${(minRatio * 100).toFixed(1)}% of pre-mint wallet ≈${preMintWalletToken1.toFixed(4)} (token1)`,
            );
            mintSkipped = true;
          }
        } catch (err) {
          console.warn("[Rebalancer] simulateContract(mint) failed — proceeding with mint anyway:", err);
        }

        if (mintSkipped) {
          const [walBal0, walBal1] = await Promise.all([
            getTokenBalance(this.publicClient, params.token0, account.address),
            getTokenBalance(this.publicClient, params.token1, account.address),
          ]);
          return {
            withdrawTx,
            swap,
            mintTx: null,
            newTokenId: positionId,
            mintSkipped: true,
            amount0Used: 0n,
            amount1Used: 0n,
            collected0: { formatted: bal0Pre.formatted, symbol: bal0Pre.symbol },
            collected1: { formatted: bal1Pre.formatted, symbol: bal1Pre.symbol },
            walletBal0: { formatted: walBal0.formatted, symbol: walBal0.symbol },
            walletBal1: { formatted: walBal1.formatted, symbol: walBal1.symbol },
          };
        }
      }
    }

    const { hash: mintTx, newTokenId } = await this.mint({
      ...params,
      amount0Desired: bal0.raw,
      amount1Desired: bal1.raw,
      amount0Min: 0n,
      amount1Min: 0n,
    });

    const [walBal0Final, walBal1Final] = await Promise.all([
      getTokenBalance(this.publicClient, params.token0, account.address),
      getTokenBalance(this.publicClient, params.token1, account.address),
    ]);

    return {
      withdrawTx,
      swap,
      mintTx,
      newTokenId,
      mintSkipped: false,
      amount0Used: bal0.raw,
      amount1Used: bal1.raw,
      collected0: { formatted: bal0Pre.formatted, symbol: bal0Pre.symbol },
      collected1: { formatted: bal1Pre.formatted, symbol: bal1Pre.symbol },
      walletBal0: { formatted: walBal0Final.formatted, symbol: walBal0Final.symbol },
      walletBal1: { formatted: walBal1Final.formatted, symbol: walBal1Final.symbol },
    };
  }

  // ---------------------------------------------------------------------------
  // Public: withdraw a single position (reads liquidity from chain).
  // Used by the stale-position consolidation flow.
  // ---------------------------------------------------------------------------

  async withdrawPosition(
    positionId: bigint,
    recipient: Address,
  ): Promise<Hash | null> {
    const position = await this.publicClient.readContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [positionId],
    });
    const liquidity = position[7];

    if (liquidity > 0n) {
      console.log(`[Rebalancer] withdrawPosition #${positionId} — liquidity=${liquidity}`);
      return this.withdraw(positionId, liquidity, recipient);
    }

    // liquidity=0 but there may be uncollected fees — sweep them.
    console.log(`[Rebalancer] withdrawPosition #${positionId} — liquidity=0, collecting residual fees`);
    return this.collectOnly(positionId, recipient);
  }

  // ---------------------------------------------------------------------------
  // Phase 1: decreaseLiquidity + collect
  // ---------------------------------------------------------------------------

  private async withdraw(
    positionId: bigint,
    liquidity: bigint,
    recipient: Address,
  ): Promise<Hash | null> {
    if (liquidity === 0n) {
      console.log("[Rebalancer] liquidity=0 — skipping withdraw (position already empty)");
      return null;
    }

    const account = this.walletClient.account!;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const decreaseData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: positionId,
          liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        },
      ],
    });

    const collectData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: positionId,
          recipient,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        },
      ],
    });

    const hash = await this.walletClient.writeContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "multicall",
      args: [[decreaseData, collectData]],
      chain: this.publicClient.chain,
      account,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[Rebalancer] withdraw confirmed block ${receipt.blockNumber} — ${hash}`);
    return hash;
  }

  /** Collect any uncollected fees from a position that already has 0 liquidity. */
  private async collectOnly(
    positionId: bigint,
    recipient: Address,
  ): Promise<Hash | null> {
    const account = this.walletClient.account!;
    const hash = await this.walletClient.writeContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: positionId,
          recipient,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        },
      ],
      chain: this.publicClient.chain,
      account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[Rebalancer] collect confirmed block ${receipt.blockNumber} — ${hash}`);
    return hash;
  }

  // ---------------------------------------------------------------------------
  // Phase 3: mint
  // ---------------------------------------------------------------------------

  private async mint(p: {
    token0: Address;
    token1: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: Address;
  }): Promise<{ hash: Hash; newTokenId: bigint }> {
    const account = this.walletClient.account!;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const hash = await this.walletClient.writeContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [
        {
          token0: p.token0,
          token1: p.token1,
          fee: p.fee,
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          amount0Desired: p.amount0Desired,
          amount1Desired: p.amount1Desired,
          amount0Min: p.amount0Min,
          amount1Min: p.amount1Min,
          recipient: p.recipient,
          deadline,
        },
      ],
      chain: this.publicClient.chain,
      account,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    // Extract new tokenId from ERC-721 Transfer(address,address,uint256) event
    const transferAbi = [
      {
        type: "event" as const,
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "tokenId", type: "uint256", indexed: true },
        ],
      },
    ] as const;
    const logs = parseEventLogs({
      abi: transferAbi,
      logs: receipt.logs,
      eventName: "Transfer",
    });
    const mintTransfer = logs.find(
      (l) => l.address.toLowerCase() === this.positionManager.toLowerCase(),
    );
    if (!mintTransfer) {
      throw new Error(
        `Mint tx ${hash} succeeded but no Transfer event found from NPM — cannot determine new tokenId. Check tx on explorer.`,
      );
    }
    const newTokenId = mintTransfer.args.tokenId;

    console.log(
      `[Rebalancer] mint confirmed block ${receipt.blockNumber} — ${hash} (NFT #${newTokenId})`,
    );
    return { hash, newTokenId };
  }
}

/** Total portfolio value in token1 units (same convention as Swapper: price = token1 per token0). */
function portfolioValueToken1(
  amount0Raw: bigint,
  amount1Raw: bigint,
  decimals0: number,
  decimals1: number,
  priceToken1PerToken0: number,
): number {
  if (!Number.isFinite(priceToken1PerToken0) || priceToken1PerToken0 <= 0) return 0;
  const f0 = Number(formatUnits(amount0Raw, decimals0));
  const f1 = Number(formatUnits(amount1Raw, decimals1));
  return f0 * priceToken1PerToken0 + f1;
}
