import {
  type PublicClient,
  type WalletClient,
  type Address,
  type Hash,
  encodeFunctionData,
  maxUint128,
} from "viem";
import { nonfungiblePositionManagerAbi } from "../abi/NonfungiblePositionManager.js";
import { CONTRACTS } from "../config/index.js";
import { getTokenBalance, ensureApproval } from "../utils/tokens.js";
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
}

export interface RebalanceResult {
  withdrawTx: Hash;
  swap: SwapResult;
  mintTx: Hash;
  amount0Used: bigint;
  amount1Used: bigint;
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

    // ======================= Phase 1: Withdraw =======================
    console.log("[Rebalancer] Phase 1/3: withdrawing liquidity…");
    const withdrawTx = await this.withdraw(positionId, liquidity, account.address);

    // ======================= Phase 2: Swap to balance =================
    console.log("[Rebalancer] Phase 2/3: checking portfolio balance…");
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

    // Re-read balances after the swap (or use pre-swap if no swap happened).
    const [bal0, bal1] = swap.needed
      ? await Promise.all([
          getTokenBalance(this.publicClient, params.token0, account.address),
          getTokenBalance(this.publicClient, params.token1, account.address),
        ])
      : [bal0Pre, bal1Pre];

    if (swap.needed) {
      console.log(
        `[Rebalancer] post-swap: ${bal0.formatted} ${bal0.symbol} / ${bal1.formatted} ${bal1.symbol}`,
      );
    }

    // Ensure position manager is approved for both tokens.
    await Promise.all([
      ensureApproval(this.publicClient, this.walletClient, params.token0, this.positionManager, bal0.raw),
      ensureApproval(this.publicClient, this.walletClient, params.token1, this.positionManager, bal1.raw),
    ]);

    const slippageBps = params.slippageBps ?? 50;
    const mintTx = await this.mint({
      ...params,
      amount0Desired: bal0.raw,
      amount1Desired: bal1.raw,
      amount0Min: bal0.raw - (bal0.raw * BigInt(slippageBps)) / 10_000n,
      amount1Min: bal1.raw - (bal1.raw * BigInt(slippageBps)) / 10_000n,
    });

    return {
      withdrawTx,
      swap,
      mintTx,
      amount0Used: bal0.raw,
      amount1Used: bal1.raw,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: decreaseLiquidity + collect
  // ---------------------------------------------------------------------------

  private async withdraw(
    positionId: bigint,
    liquidity: bigint,
    recipient: Address,
  ): Promise<Hash> {
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
  }): Promise<Hash> {
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
    console.log(`[Rebalancer] mint confirmed block ${receipt.blockNumber} — ${hash}`);
    return hash;
  }
}
