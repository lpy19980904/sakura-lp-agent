import { StateManager } from "./StateManager.js";

export interface TickRange {
  tickLower: number;
  tickUpper: number;
}

export class RangeEngine {
  public tickLower: number;
  public tickUpper: number;

  constructor(
    tickLower: number,
    tickUpper: number,
    private readonly tickSpacing: number,
  ) {
    this.tickLower = tickLower;
    this.tickUpper = tickUpper;
  }

  /** Returns true when the current tick has left our active range. */
  shouldRebalance(currentTick: number): boolean {
    return currentTick < this.tickLower || currentTick >= this.tickUpper;
  }

  /**
   * Compute a new symmetric range centered on `currentTick`.
   *
   * The effective half-width is:
   *   baseWidth * effectiveSpread * tickSpacing
   *
   * - When AI is OFF, `effectiveSpread` = 1.0 (fallback)
   * - When AI is ON,  `effectiveSpread` comes from the last Gemini suggestion
   *
   * @param currentTick – live tick from slot0
   * @param baseWidth   – base half-width in tick-spacing multiples (default 10)
   */
  computeNewRange(currentTick: number, baseWidth = 10): TickRange {
    const spread = StateManager.effectiveSpread;
    const aligned = this.alignTick(currentTick);
    const halfSpan = Math.round(baseWidth * spread) * this.tickSpacing;

    const range: TickRange = {
      tickLower: aligned - halfSpan,
      tickUpper: aligned + halfSpan,
    };

    const source = StateManager.isAIEngineActive ? "AI" : "fallback";
    console.log(
      `[RangeEngine] spread=${spread.toFixed(2)} (${source}) → halfSpan=${halfSpan} ticks`,
    );

    return range;
  }

  /** Update the engine's active range after a successful rebalance. */
  updateRange(range: TickRange): void {
    this.tickLower = range.tickLower;
    this.tickUpper = range.tickUpper;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Round a tick down to the nearest multiple of tickSpacing. */
  private alignTick(tick: number): number {
    return Math.floor(tick / this.tickSpacing) * this.tickSpacing;
  }
}
