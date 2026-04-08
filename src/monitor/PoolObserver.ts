import type { PublicClient, Address } from "viem";
import { poolAbi } from "../abi/NonfungiblePositionManager.js";

export interface Slot0Snapshot {
  sqrtPriceX96: bigint;
  tick: number;
  /** token1 per token0 (raw pool direction). */
  price: number;
  /** token0 per token1 (inverted — useful when token1 is the "base" asset). */
  priceInverted: number;
}

export class PoolObserver {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly poolAddress: Address,
    private readonly token0Decimals = 18,
    private readonly token1Decimals = 18,
  ) {}

  /** One-shot read of the pool's slot0. */
  async getCurrentTick(): Promise<Slot0Snapshot> {
    const data = await this.client.readContract({
      address: this.poolAddress,
      abi: poolAbi,
      functionName: "slot0",
    });

    const sqrtPriceX96 = data[0];
    const tick = data[1];
    const price = this.sqrtPriceX96ToPrice(
      sqrtPriceX96,
      this.token0Decimals,
      this.token1Decimals,
    );

    const priceInverted = price > 0 ? 1 / price : 0;
    return { sqrtPriceX96, tick, price, priceInverted };
  }

  /** Begin polling slot0 at the given interval. */
  startPolling(
    callback: (snapshot: Slot0Snapshot) => void | Promise<void>,
    intervalMs: number,
  ): void {
    if (this.timer) return;

    const poll = async () => {
      try {
        const snapshot = await this.getCurrentTick();
        await callback(snapshot);
      } catch (err) {
        console.error("[PoolObserver] polling error:", err);
      }
    };

    // Fire immediately, then repeat.
    void poll();
    this.timer = setInterval(() => void poll(), intervalMs);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert sqrtPriceX96 to a human-readable price (token1 per token0),
   * accounting for decimal differences between the two tokens.
   */
  private sqrtPriceX96ToPrice(
    sqrtPriceX96: bigint,
    decimals0: number,
    decimals1: number,
  ): number {
    const Q96 = 2n ** 96n;
    const numerator = sqrtPriceX96 * sqrtPriceX96;
    const denominator = Q96 * Q96;
    const raw = Number(numerator) / Number(denominator);
    const decimalAdjustment = 10 ** (decimals0 - decimals1);
    return raw * decimalAdjustment;
  }
}
