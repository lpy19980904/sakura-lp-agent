import {
  type PublicClient,
  type WalletClient,
  type Address,
  type Hash,
  formatUnits,
} from "viem";
import { swapRouterAbi } from "../abi/SwapRouter.js";
import { CONTRACTS } from "../config/index.js";
import { ensureApproval } from "../utils/tokens.js";
import type { TokenBalance } from "../utils/tokens.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwapInstruction {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Human-readable descriptions for logging. */
  symbolIn: string;
  symbolOut: string;
  formattedIn: string;
  estimatedOut: string;
}

export interface SwapResult {
  needed: boolean;
  instruction: SwapInstruction | null;
  txHash: Hash | null;
}

// ---------------------------------------------------------------------------
// Swapper
// ---------------------------------------------------------------------------

/**
 * Detects single-sided exposure after a withdraw and swaps the excess
 * token back to a ~50/50 value split so the subsequent mint succeeds.
 */
export class Swapper {
  private readonly router: Address;

  constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
    /** Imbalance threshold (0–1). Swap triggers when one side > this ratio. */
    private readonly imbalanceThreshold = 0.6,
    /** Swap slippage in basis points (default 100 = 1 %). */
    private readonly slippageBps = 100,
  ) {
    this.router = CONTRACTS.swapRouter;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether a swap is needed and, if so, compute the instruction.
   *
   * @param bal0    – token0 balance after withdraw
   * @param bal1    – token1 balance after withdraw
   * @param price   – pool price expressed as token1-per-token0 (raw from slot0)
   * @param fee     – pool fee tier (e.g. 2500 for 0.25 %)
   */
  evaluate(
    bal0: TokenBalance,
    bal1: TokenBalance,
    price: number,
    fee: number,
  ): SwapInstruction | null {
    if (price <= 0) return null;

    const float0 = Number(formatUnits(bal0.raw, bal0.decimals));
    const float1 = Number(formatUnits(bal1.raw, bal1.decimals));

    // Value everything in token1 units.
    const val0InToken1 = float0 * price;
    const val1InToken1 = float1;
    const totalInToken1 = val0InToken1 + val1InToken1;

    if (totalInToken1 === 0) return null;

    const ratio0 = val0InToken1 / totalInToken1;

    console.log(
      `[Swapper] portfolio split: ${bal0.symbol}=${(ratio0 * 100).toFixed(1)}% / ${bal1.symbol}=${((1 - ratio0) * 100).toFixed(1)}%`,
    );

    if (ratio0 > this.imbalanceThreshold) {
      // Too much token0 → swap excess token0 → token1
      const excessInToken1 = val0InToken1 - totalInToken1 / 2;
      const swapFloat0 = excessInToken1 / price;
      const amountIn = this.floatToBigInt(swapFloat0, bal0.decimals);

      return {
        tokenIn: bal0.address,
        tokenOut: bal1.address,
        amountIn,
        symbolIn: bal0.symbol,
        symbolOut: bal1.symbol,
        formattedIn: formatUnits(amountIn, bal0.decimals),
        estimatedOut: excessInToken1.toFixed(6),
      };
    }

    if (ratio0 < 1 - this.imbalanceThreshold) {
      // Too much token1 → swap excess token1 → token0
      const excessInToken1 = val1InToken1 - totalInToken1 / 2;
      const amountIn = this.floatToBigInt(excessInToken1, bal1.decimals);
      const estimatedOutFloat0 = excessInToken1 / price;

      return {
        tokenIn: bal1.address,
        tokenOut: bal0.address,
        amountIn,
        symbolIn: bal1.symbol,
        symbolOut: bal0.symbol,
        formattedIn: formatUnits(amountIn, bal1.decimals),
        estimatedOut: estimatedOutFloat0.toFixed(6),
      };
    }

    return null;
  }

  /**
   * Execute a swap on-chain via the PancakeSwap V3 SwapRouter.
   */
  async executeSwap(
    instruction: SwapInstruction,
    fee: number,
  ): Promise<Hash> {
    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient has no account attached");

    // Ensure router is approved to spend tokenIn.
    await ensureApproval(
      this.publicClient,
      this.walletClient,
      instruction.tokenIn,
      this.router,
      instruction.amountIn,
    );

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const minOut =
      instruction.amountIn -
      (instruction.amountIn * BigInt(this.slippageBps)) / 10_000n;

    const hash = await this.walletClient.writeContract({
      address: this.router,
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: instruction.tokenIn,
          tokenOut: instruction.tokenOut,
          fee,
          recipient: account.address,
          deadline,
          amountIn: instruction.amountIn,
          amountOutMinimum: minOut > 0n ? minOut : 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      chain: this.publicClient.chain,
      account,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `[Swapper] swap confirmed block ${receipt.blockNumber} — ${hash}`,
    );
    return hash;
  }

  /**
   * Convenience: evaluate + execute in one call. Returns full result.
   */
  async balancePortfolio(
    bal0: TokenBalance,
    bal1: TokenBalance,
    price: number,
    fee: number,
  ): Promise<SwapResult> {
    const instruction = this.evaluate(bal0, bal1, price, fee);

    if (!instruction) {
      console.log("[Swapper] portfolio balanced — no swap needed");
      return { needed: false, instruction: null, txHash: null };
    }

    console.log(
      `[Swapper] swapping ${instruction.formattedIn} ${instruction.symbolIn} → ~${instruction.estimatedOut} ${instruction.symbolOut}`,
    );

    const txHash = await this.executeSwap(instruction, fee);
    return { needed: true, instruction, txHash };
  }

  // ---------------------------------------------------------------------------
  // Dry-run simulation (no on-chain tx)
  // ---------------------------------------------------------------------------

  simulateBalance(
    bal0: TokenBalance,
    bal1: TokenBalance,
    price: number,
  ): void {
    const instruction = this.evaluate(bal0, bal1, price, 0);

    if (!instruction) {
      console.log("[Simulate Swap] Portfolio balanced — no swap needed.");
      return;
    }

    console.log(
      `[Simulate Swap] Excess ${instruction.symbolIn} detected. ` +
        `Swapping ${instruction.formattedIn} ${instruction.symbolIn} to ~${instruction.estimatedOut} ${instruction.symbolOut} to balance portfolio.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private floatToBigInt(value: number, decimals: number): bigint {
    if (value <= 0) return 0n;
    const str = value.toFixed(decimals);
    const [whole = "0", frac = ""] = str.split(".");
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole + padded);
  }
}
