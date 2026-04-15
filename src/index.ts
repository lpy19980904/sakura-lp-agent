import "dotenv/config";
import * as readline from "readline";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  chain,
  BSC_RPC_URL,
  PRIVATE_KEY,
  CONTRACTS,
  TOKENS,
  POLL_INTERVAL_MS,
  DEFAULT_RANGE_WIDTH,
  POSITION_ID,
  setPositionId,
  MIN_MINT_DEPLOYED_TO_WALLET_RATIO,
  STALE_POSITION_IDS,
} from "./config/index.js";
import { PoolObserver, type Slot0Snapshot } from "./monitor/PoolObserver.js";
import { RangeEngine } from "./strategy/RangeEngine.js";
import { StateManager } from "./strategy/StateManager.js";
import { analyzeVolatilityAndDecide, type VolatilityData } from "./strategy/AIBrain.js";
import { Rebalancer } from "./executor/Rebalancer.js";
import { Swapper } from "./executor/Swapper.js";
import { nonfungiblePositionManagerAbi } from "./abi/NonfungiblePositionManager.js";
import { getTokenBalance, ensureApproval } from "./utils/tokens.js";
import {
  sendRebalanceReport,
  sendAlert,
  sendShutdownNotice,
  isNotifierEnabled,
} from "./services/notifier.js";
import { writeSession, clearSession } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Configuration — edit these for the target pool / position
// ---------------------------------------------------------------------------

/** GENIUS / USDT 0.3 % pool on Uniswap V3 (BSC). */
const TARGET_POOL: Address = "0xD77865e605049Bb362E9a6C5a1df7b033C376811";
const TICK_SPACING = 60;
const FEE_TIER = 3000;

const TOKEN0: Address = "0x1F12B85aAC097E43Aa1555b2881E98a51090e9A6"; // GENIUS
const TOKEN1: Address = TOKENS.USDT;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain,
  transport: http(BSC_RPC_URL),
});

const walletClient = createWalletClient({
  chain,
  transport: http(BSC_RPC_URL),
  account,
});

// ---------------------------------------------------------------------------
// Core modules
// ---------------------------------------------------------------------------

const observer = new PoolObserver(publicClient, TARGET_POOL, 18, 18);
const engine = new RangeEngine(0, 0, TICK_SPACING);
const rebalancer = new Rebalancer(walletClient, publicClient);
const swapper = new Swapper(walletClient, publicClient);

// ---------------------------------------------------------------------------
// Price history ring buffer (for AI volatility input)
// ---------------------------------------------------------------------------

const PRICE_HISTORY_SIZE = 480; // ~24 h at 3 s intervals
const priceHistory: number[] = [];

function recordPrice(price: number): void {
  priceHistory.push(price);
  if (priceHistory.length > PRICE_HISTORY_SIZE) {
    priceHistory.shift();
  }
}

function buildVolatilityData(currentPrice: number): VolatilityData {
  const prices = priceHistory.length > 0 ? priceHistory : [currentPrice];
  const high24h = Math.max(...prices);
  const low24h = Math.min(...prices);

  let atrSum = 0;
  for (let i = 1; i < prices.length; i++) {
    atrSum += Math.abs(prices[i] - prices[i - 1]);
  }
  const atr = prices.length > 1 ? atrSum / (prices.length - 1) : 0;
  const volatilityPct =
    currentPrice > 0 ? ((high24h - low24h) / currentPrice) * 100 : 0;

  return {
    pairLabel: `${sym0}/${sym1}`,
    high24h,
    low24h,
    currentPrice,
    atr,
    volatilityPct,
    sampleCount: prices.length,
  };
}

/** Cooldown: no rebalance attempts until this timestamp. */
let rebalanceCooldownUntil = 0;

// ---------------------------------------------------------------------------
// Terminal hotkey listener (T to toggle AI)
// ---------------------------------------------------------------------------

function setupHotkeyListener(): void {
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;

    // Ctrl-C still exits
    if (key.ctrl && key.name === "c") {
      shutdown();
      return;
    }

    if (key.name === "t") {
      const nowActive = StateManager.toggleAIEngine();

      if (nowActive) {
        console.log(
          "\x1b[36m\n🧠 AI Brain Engaged. Gemini will be consulted on next rebalance.\x1b[0m",
        );
      } else {
        console.log(
          "\x1b[33m\n⚠️  AI Brain Disabled. Using fallback spread.\x1b[0m",
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------

async function preflight(): Promise<void> {
  const [bal0, bal1] = await Promise.all([
    getTokenBalance(publicClient, TOKEN0, account.address),
    getTokenBalance(publicClient, TOKEN1, account.address),
  ]);
  sym0 = bal0.symbol;
  sym1 = bal1.symbol;
  console.log(`pair     : ${sym0}/${sym1}`);
  console.log(`balances : ${bal0.formatted} ${sym0} / ${bal1.formatted} ${sym1}`);

  if (POSITION_ID == null) {
    console.log("mode     : DRY-RUN (no POSITION_ID — rebalance will be simulated)");
  } else {
    console.log(`position : #${POSITION_ID}`);

    const position = await publicClient.readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [POSITION_ID],
    });
    const posTickLower = position[5];
    const posTickUpper = position[6];
    const posLiquidity = position[7];
    engine.updateRange({ tickLower: posTickLower, tickUpper: posTickUpper });
    console.log(`on-chain : [${posTickLower}, ${posTickUpper}) liq=${posLiquidity}`);

    const pm = CONTRACTS.nonfungiblePositionManager;
    await ensureApproval(publicClient, walletClient, TOKEN0, pm);
    await ensureApproval(publicClient, walletClient, TOKEN1, pm);
    console.log("approvals: OK");
  }

  console.log(`AI brain : ${StateManager.isAIEngineActive ? "ON" : "OFF"} (press T to toggle — runs on rebalance only)`);
  console.log(`telegram : ${isNotifierEnabled() ? "ON" : "OFF (set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID)"}\n`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let rebalancing = false;
let shuttingDown = false;
let latestPrice = 0;
let sym0 = "TOKEN0";
let sym1 = "TOKEN1";

/** Extract the most useful parts from viem / generic errors for Telegram. */
function extractErrorSummary(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 1500);

  const name = err.constructor.name;
  const record = err as unknown as Record<string, unknown>;
  const short = record.shortMessage;
  const details = record.details;

  const parts: string[] = [name];
  if (typeof short === "string") {
    parts.push(short);
  } else {
    parts.push(err.message.slice(0, 600));
  }
  if (typeof details === "string") {
    parts.push(`Details: ${details}`);
  }
  return parts.join("\n").slice(0, 1500);
}

async function onTick(snapshot: Slot0Snapshot): Promise<void> {
  if (shuttingDown) return;

  const { tick, price, priceInverted } = snapshot;
  latestPrice = priceInverted;
  recordPrice(priceInverted);

  const spreadLabel = StateManager.isAIEngineActive ? "AI" : "fixed";
  console.log(
    `[tick=${tick}] ${sym0}/${sym1}=${priceInverted.toFixed(4)} | spread=${StateManager.effectiveSpread.toFixed(2)}(${spreadLabel}) | range=[${engine.tickLower}, ${engine.tickUpper})`,
  );

  if (engine.tickLower === 0 && engine.tickUpper === 0) {
    const initial = engine.computeNewRange(tick, DEFAULT_RANGE_WIDTH);
    engine.updateRange(initial);
    console.log(
      `[init] seeded range [${initial.tickLower}, ${initial.tickUpper})`,
    );
    return;
  }

  if (!engine.shouldRebalance(tick)) return;
  if (rebalancing) return;
  if (Date.now() < rebalanceCooldownUntil) return;

  console.log("[rebalance] tick left active range — starting rebalance…");
  rebalancing = true;

  try {
    if (StateManager.isAIEngineActive) {
      await analyzeVolatilityAndDecide(buildVolatilityData(priceInverted));
    }

    const newRange = engine.computeNewRange(tick, DEFAULT_RANGE_WIDTH);

    // ----- DRY-RUN path -----
    if (POSITION_ID == null) {
      console.warn("[rebalance] DRY-RUN — simulating full 3-phase cycle");
      writeSession("WITHDRAW", newRange);
      console.log(
        `[rebalance] new range would be [${newRange.tickLower}, ${newRange.tickUpper})`,
      );

      const [bal0, bal1] = await Promise.all([
        getTokenBalance(publicClient, TOKEN0, account.address),
        getTokenBalance(publicClient, TOKEN1, account.address),
      ]);
      console.log(
        `[Simulate Withdraw] Would collect: ${bal0.formatted} ${bal0.symbol} + ${bal1.formatted} ${bal1.symbol}`,
      );
      swapper.simulateBalance(bal0, bal1, price);
      console.log(
        `[Simulate Mint] Would open position at [${newRange.tickLower}, ${newRange.tickUpper}) with balanced assets`,
      );

      engine.updateRange(newRange);
      clearSession();
      return;
    }

    // ----- LIVE path -----
    const position = await publicClient.readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [POSITION_ID],
    });
    const liquidity = position[7];

    const result = await rebalancer.execute(POSITION_ID, liquidity, {
      token0: TOKEN0,
      token1: TOKEN1,
      fee: FEE_TIER,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      recipient: account.address,
      currentPrice: price,
      slippageBps: 500,
      minMintDeployedToWalletRatio: MIN_MINT_DEPLOYED_TO_WALLET_RATIO,
    });

    if (result.mintSkipped) {
      console.warn(
        `[rebalance] mint skipped (deposit < ${(MIN_MINT_DEPLOYED_TO_WALLET_RATIO * 100).toFixed(1)}% of wallet) — funds left in wallet, NOT updating range`,
      );
      clearSession();
      // Long cooldown: no point retrying quickly when the amounts are dust.
      rebalanceCooldownUntil = Date.now() + 300_000; // 5 min
      return;
    }

    setPositionId(result.newTokenId);
    console.log(`[rebalance] tracking new NFT #${result.newTokenId}`);

    engine.updateRange(newRange);
    clearSession();

    // 15-second cooldown after success to avoid thrashing at range boundaries
    rebalanceCooldownUntil = Date.now() + 15_000;

    console.log(
      `[rebalance] done — new range [${newRange.tickLower}, ${newRange.tickUpper})`,
    );
    console.log(
      `[rebalance] withdraw: ${result.withdrawTx ?? "skipped"} | swap: ${result.swap.needed ? result.swap.txHash : "none"} | mint: ${result.mintTx ?? "skipped"}`,
    );

    void sendRebalanceReport({
      price: priceInverted,
      pairLabel: `${sym0}/${sym1}`,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      feesCollected: {
        symbol0: result.collected0.symbol,
        amount0: result.collected0.formatted,
        symbol1: result.collected1.symbol,
        amount1: result.collected1.formatted,
      },
      wallet: {
        symbol0: result.walletBal0.symbol,
        amount0: result.walletBal0.formatted,
        symbol1: result.walletBal1.symbol,
        amount1: result.walletBal1.formatted,
      },
      withdrawTx: result.withdrawTx ?? "skipped",
      mintTx:
        result.mintTx ??
        `skipped (simulated deposit < ${(MIN_MINT_DEPLOYED_TO_WALLET_RATIO * 100).toFixed(0)}% of wallet)`,
      swapTx: result.swap.txHash,
    });
  } catch (err: unknown) {
    console.error("[rebalance] failed:", err);
    void sendAlert(extractErrorSummary(err));
    // 30-second cooldown after failure to prevent rapid-fire retries
    rebalanceCooldownUntil = Date.now() + 30_000;
  } finally {
    rebalancing = false;
  }
}

// ---------------------------------------------------------------------------
// Stale position consolidation (runs once on boot)
// ---------------------------------------------------------------------------

async function consolidateStalePositions(): Promise<void> {
  if (STALE_POSITION_IDS.length === 0) return;

  console.log(
    `\n[consolidate] found ${STALE_POSITION_IDS.length} stale position(s) to clean up: ${STALE_POSITION_IDS.map(String).join(", ")}`,
  );

  for (const id of STALE_POSITION_IDS) {
    try {
      const tx = await rebalancer.withdrawPosition(id, account.address);
      console.log(`[consolidate] #${id} withdrawn — tx: ${tx ?? "nothing to collect"}`);
    } catch (err) {
      console.error(`[consolidate] #${id} withdraw failed:`, err);
      void sendAlert(`Consolidate: failed to withdraw #${id} — ${extractErrorSummary(err)}`);
    }
  }

  const [bal0, bal1] = await Promise.all([
    getTokenBalance(publicClient, TOKEN0, account.address),
    getTokenBalance(publicClient, TOKEN1, account.address),
  ]);
  console.log(
    `[consolidate] wallet after withdrawals: ${bal0.formatted} ${bal0.symbol} / ${bal1.formatted} ${bal1.symbol}`,
  );

  if (bal0.raw === 0n && bal1.raw === 0n) {
    console.warn("[consolidate] wallet is empty after withdrawals — nothing to mint");
    return;
  }

  const snapshot = await observer.getCurrentTick();
  const { tick, price } = snapshot;
  console.log(`[consolidate] current tick=${tick} price=${price.toFixed(6)}`);

  const swapResult = await swapper.balancePortfolio(bal0, bal1, price, FEE_TIER);

  const [bal0Post, bal1Post] = await Promise.all([
    getTokenBalance(publicClient, TOKEN0, account.address),
    getTokenBalance(publicClient, TOKEN1, account.address),
  ]);
  console.log(
    `[consolidate] wallet after swap: ${bal0Post.formatted} ${bal0Post.symbol} / ${bal1Post.formatted} ${bal1Post.symbol}`,
  );

  const newRange = engine.computeNewRange(tick, DEFAULT_RANGE_WIDTH);
  console.log(`[consolidate] minting new position at [${newRange.tickLower}, ${newRange.tickUpper})`);

  const pm = CONTRACTS.nonfungiblePositionManager;
  await ensureApproval(publicClient, walletClient, TOKEN0, pm, bal0Post.raw);
  await ensureApproval(publicClient, walletClient, TOKEN1, pm, bal1Post.raw);

  const result = await rebalancer.execute(0n, 0n, {
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE_TIER,
    tickLower: newRange.tickLower,
    tickUpper: newRange.tickUpper,
    recipient: account.address,
    currentPrice: price,
    slippageBps: 500,
    minMintDeployedToWalletRatio: 0,
  });

  if (result.mintTx) {
    setPositionId(result.newTokenId);
    engine.updateRange(newRange);
    console.log(
      `[consolidate] done — new NFT #${result.newTokenId} at [${newRange.tickLower}, ${newRange.tickUpper})`,
    );
    console.log(`[consolidate] mint tx: ${result.mintTx}`);

    void sendRebalanceReport({
      price: snapshot.priceInverted,
      pairLabel: `${sym0}/${sym1}`,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      feesCollected: {
        symbol0: result.collected0.symbol,
        amount0: result.collected0.formatted,
        symbol1: result.collected1.symbol,
        amount1: result.collected1.formatted,
      },
      wallet: {
        symbol0: result.walletBal0.symbol,
        amount0: result.walletBal0.formatted,
        symbol1: result.walletBal1.symbol,
        amount1: result.walletBal1.formatted,
      },
      withdrawTx: `consolidated ${STALE_POSITION_IDS.length} stale positions`,
      mintTx: result.mintTx,
      swapTx: swapResult.txHash,
    });
  } else {
    console.warn("[consolidate] mint was skipped — no new position created");
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Sakura LP Agent ===");
  console.log(`chain    : ${chain.name} (id ${chain.id})`);
  console.log(`pool     : ${TARGET_POOL}`);
  console.log(`wallet   : ${account.address}`);
  console.log(`interval : ${POLL_INTERVAL_MS} ms`);

  await preflight();
  await consolidateStalePositions();

  setupHotkeyListener();
  observer.startPolling(onTick, POLL_INTERVAL_MS);
}

void main().catch(async (err) => {
  console.error("[fatal] unhandled error in main:", err);
  await sendAlert(`FATAL — ${extractErrorSummary(err)}`).catch(() => {});
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("\n[shutdown] 准备安全下线...");
  observer.stopPolling();
  clearSession();

  const forceTimer = setTimeout(() => {
    console.log("[shutdown] force exit (Telegram timeout)");
    process.exit(0);
  }, 5_000);
  forceTimer.unref();

  sendShutdownNotice()
    .catch(() => {})
    .finally(() => {
      console.log("[shutdown] bye 🌸");
      process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Global safety nets
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
  void sendAlert(extractErrorSummary(reason));
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  sendAlert(`UncaughtException — ${extractErrorSummary(err)}`)
    .catch(() => {})
    .finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5_000).unref();
});
