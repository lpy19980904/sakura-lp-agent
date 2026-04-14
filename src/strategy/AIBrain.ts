import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY } from "../config/index.js";
import { StateManager } from "./StateManager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VolatilityData {
  pairLabel: string;
  high24h: number;
  low24h: number;
  currentPrice: number;
  atr: number;
  volatilityPct: number;
  /** Number of data points in the price history. */
  sampleCount: number;
}

interface AIResponse {
  suggestedSpread: number;
}

// ---------------------------------------------------------------------------
// AIBrain
// ---------------------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const MODEL = "gemini-2.5-flash-lite";

function buildPrompt(data: VolatilityData): string {
  const historyNote = data.sampleCount < 60
    ? `\n注意：当前价格采样点仅 ${data.sampleCount} 个（不足 3 分钟），数据可能不充分，建议偏向保守（更宽区间）。`
    : "";

  return `你是一个专业的 DeFi 量化策略引擎，负责管理 Uniswap V3 上 ${data.pairLabel} 交易对的 LP 仓位。

以下是该资产近期的价格特征数据：
{
  "pair": "${data.pairLabel}",
  "high": ${data.high24h},
  "low": ${data.low24h},
  "currentPrice": ${data.currentPrice},
  "atr": ${data.atr.toFixed(6)},
  "volatilityPct": ${data.volatilityPct.toFixed(2)},
  "sampleCount": ${data.sampleCount}
}${historyNote}

你的任务是判断当前属于低波动震荡市还是高波动趋势市，并给出一个区间宽度建议（Spread Multiplier）。
- 震荡市（volatilityPct < 3%）：建议 0.5 到 1.0（窄区间，赚取更多手续费）
- 中等波动（3%-8%）：建议 1.0 到 1.5
- 趋势市/极度波动（>8%）：建议 1.5 到 3.0（宽区间，减少调仓频率）

你必须且只能返回一段纯 JSON 格式的数据，不要包含任何 Markdown 标记（如 \`\`\`json），不要有任何解释性文字。格式严格如下：
{"suggestedSpread": 1.2}`;
}

/**
 * Strip markdown code fences and any non-JSON text the LLM might wrap around
 * its response, then parse into a typed object.
 */
function sanitizeAndParse(raw: string): AIResponse {
  let cleaned = raw.trim();

  // Remove ```json ... ``` or ``` ... ```
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Aggressively extract the first { ... } block
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (!match) {
    throw new Error(`AIBrain: no JSON object found in response: ${raw}`);
  }

  const parsed: unknown = JSON.parse(match[0]);

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "suggestedSpread" in parsed &&
    typeof (parsed as AIResponse).suggestedSpread === "number"
  ) {
    return parsed as AIResponse;
  }

  throw new Error(`AIBrain: unexpected response shape: ${match[0]}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask Gemini to evaluate market volatility and suggest a spread multiplier.
 *
 * - If `StateManager.isAIEngineActive` is false, returns immediately (no API call).
 * - On success, updates `StateManager.currentSpread`.
 * - On failure, logs the error and leaves the spread unchanged.
 */
export async function analyzeVolatilityAndDecide(
  data: VolatilityData,
): Promise<number | null> {
  if (!StateManager.isAIEngineActive) {
    return null;
  }

  console.log("[AIBrain] querying Gemini for spread recommendation…");

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: buildPrompt(data),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout (5s)")), 5_000),
      ),
    ]);

    const text = response.text ?? "";
    console.log(`[AIBrain] raw response: ${text}`);

    const { suggestedSpread } = sanitizeAndParse(text);

    const clamped = Math.max(0.5, Math.min(suggestedSpread, 3.0));
    StateManager.updateSpread(clamped);
    console.log(`[AIBrain] spread updated → ${clamped}`);

    return clamped;
  } catch (err) {
    console.error("[AIBrain] Gemini call failed, keeping current spread:", err);
    return null;
  }
}
