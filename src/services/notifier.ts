// ---------------------------------------------------------------------------
// Telegram Bot Notifier — sends rebalance reports & alerts via Bot API.
// Gracefully no-ops when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset.
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

const enabled = BOT_TOKEN.length > 0 && CHAT_ID.length > 0;

async function sendMessage(text: string): Promise<void> {
  if (!enabled) return;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[Notifier] Telegram API ${res.status}: ${body}`);
    }
  } catch (err) {
    const tag = (err as Error)?.name === "TimeoutError" ? "timeout" : "error";
    console.warn(`[Notifier] send ${tag}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export interface RebalanceReport {
  price: number;
  pairLabel: string;
  tickLower: number;
  tickUpper: number;
  feesCollected: { symbol0: string; amount0: string; symbol1: string; amount1: string };
  wallet: { symbol0: string; amount0: string; symbol1: string; amount1: string };
  withdrawTx: string;
  mintTx: string;
  swapTx: string | null;
}

export async function sendRebalanceReport(r: RebalanceReport): Promise<void> {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);

  const text = [
    "🌸 <b>Sakura Rebalance Report</b>",
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `💰 <b>Price:</b>  ${r.price.toFixed(4)} ${r.pairLabel}`,
    `📐 <b>Range:</b>  [${r.tickLower}, ${r.tickUpper})`,
    "",
    `💸 <b>Collected Fees</b>`,
    `   ${r.feesCollected.amount0} ${r.feesCollected.symbol0}`,
    `   ${r.feesCollected.amount1} ${r.feesCollected.symbol1}`,
    "",
    `🏦 <b>Wallet Balance</b>`,
    `   ${r.wallet.amount0} ${r.wallet.symbol0}`,
    `   ${r.wallet.amount1} ${r.wallet.symbol1}`,
    "",
    `🔗 <b>Txns</b>`,
    `   withdraw: <code>${r.withdrawTx}</code>`,
    r.swapTx ? `   swap:     <code>${r.swapTx}</code>` : "   swap:     —",
    `   mint:     <code>${r.mintTx}</code>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `✅ Completed at ${ts} UTC`,
  ].join("\n");

  await sendMessage(text);
}

const ALERT_COOLDOWN_MS = 60_000;
let lastAlertSentAt = 0;
let suppressedAlertCount = 0;

export async function sendAlert(summary: string): Promise<void> {
  const now = Date.now();
  if (now - lastAlertSentAt < ALERT_COOLDOWN_MS) {
    suppressedAlertCount++;
    console.warn(`[Notifier] alert suppressed (${suppressedAlertCount} in cooldown)`);
    return;
  }
  lastAlertSentAt = now;

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const suppressed = suppressedAlertCount > 0
    ? `\n⏸ ${suppressedAlertCount} duplicate alert(s) suppressed`
    : "";
  suppressedAlertCount = 0;

  const text = [
    "🚨 <b>ALERT: Rebalance Failed!</b>",
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `<pre>${escapeHtml(summary.slice(0, 1500))}</pre>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `⏰ ${ts} UTC${suppressed}`,
  ].join("\n");

  await sendMessage(text);
}

export async function sendShutdownNotice(): Promise<void> {
  await sendMessage("⚠️ <b>Sakura Agent 进程已安全结束</b>");
}

export function isNotifierEnabled(): boolean {
  return enabled;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
