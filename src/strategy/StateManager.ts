/** Default spread multiplier when AI is off. */
const FALLBACK_SPREAD = 1.0;

/**
 * Singleton that holds global runtime state for the bot.
 * Shared across strategy, AI, and executor layers.
 */
class _StateManager {
  /** Whether the AI engine is active (burns Gemini tokens). */
  isAIEngineActive = false;

  /** Latest spread multiplier suggested by the AI (or fallback). */
  currentSpread = FALLBACK_SPREAD;

  /** Fixed spread used when AI is disabled. */
  readonly fallbackSpread = FALLBACK_SPREAD;

  toggleAIEngine(): boolean {
    this.isAIEngineActive = !this.isAIEngineActive;
    if (!this.isAIEngineActive) {
      this.currentSpread = this.fallbackSpread;
    }
    return this.isAIEngineActive;
  }

  /** Called by AIBrain after a successful LLM response. */
  updateSpread(spread: number): void {
    if (spread > 0) {
      this.currentSpread = spread;
    }
  }

  /** The effective spread: AI-driven or fallback. */
  get effectiveSpread(): number {
    return this.isAIEngineActive ? this.currentSpread : this.fallbackSpread;
  }
}

export const StateManager = new _StateManager();
