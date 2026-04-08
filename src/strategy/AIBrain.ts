import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY } from "../config/index.js";
import { StateManager } from "./StateManager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VolatilityData {
  high24h: number;
  low24h: number;
  currentPrice: number;
  atr: number;
  volatilityPct: number;
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
  return `你是一个专业的 DeFi 量化策略引擎。以下是目标资产过去 24 小时的价格特征数据：
{
  "high24h": ${data.high24h},
  "low24h": ${data.low24h},
  "currentPrice": ${data.currentPrice},
  "atr": ${data.atr},
  "volatilityPct": ${data.volatilityPct}
}

你的任务是判断当前属于低波动震荡市还是高波动趋势市，并给出一个 Uniswap V3 的区间宽度建议（Spread Multiplier）。
- 震荡市：建议 0.5 到 1.0
- 趋势市/极度波动：建议 1.5 到 3.0

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
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: buildPrompt(data),
    });

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
