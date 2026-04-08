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
   * @param currentTick – live tick from slot0
   * @param width – half-width in tick-spacing multiples (default 10)
   * @returns new TickRange aligned to tickSpacing
   */
  computeNewRange(currentTick: number, width = 10): TickRange {
    const aligned = this.alignTick(currentTick);
    const halfSpan = width * this.tickSpacing;
    return {
      tickLower: aligned - halfSpan,
      tickUpper: aligned + halfSpan,
    };
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
