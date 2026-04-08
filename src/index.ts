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
} from "./config/index.js";
import { PoolObserver, type Slot0Snapshot } from "./monitor/PoolObserver.js";
import { RangeEngine } from "./strategy/RangeEngine.js";
import { StateManager } from "./strategy/StateManager.js";
import { analyzeVolatilityAndDecide, type VolatilityData } from "./strategy/AIBrain.js";
import { Rebalancer } from "./executor/Rebalancer.js";
import { Swapper } from "./executor/Swapper.js";
import { nonfungiblePositionManagerAbi } from "./abi/NonfungiblePositionManager.js";
import { getTokenBalance, ensureApproval } from "./utils/tokens.js";

// ---------------------------------------------------------------------------
// Configuration — edit these for the target pool / position
// ---------------------------------------------------------------------------

/** WBNB / USDT 0.25 % pool on PancakeSwap V3 (BSC). */
const TARGET_POOL: Address = "0x36696169C63e42cd08ce11f5deeBbCeBae652050";
const TICK_SPACING = 50;
const FEE_TIER = 2500;

let POSITION_ID: bigint | null = null;

const TOKEN0: Address = TOKENS.USDT;
const TOKEN1: Address = TOKENS.WBNB;

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

  // Simple ATR proxy: average of |close(i) - close(i-1)| over the window
  let atrSum = 0;
  for (let i = 1; i < prices.length; i++) {
    atrSum += Math.abs(prices[i] - prices[i - 1]);
  }
  const atr = prices.length > 1 ? atrSum / (prices.length - 1) : 0;
  const volatilityPct =
    currentPrice > 0 ? ((high24h - low24h) / currentPrice) * 100 : 0;

  return { high24h, low24h, currentPrice, atr, volatilityPct };
}

// ---------------------------------------------------------------------------
// Periodic AI cron (runs every ~5 min if enabled)
// ---------------------------------------------------------------------------

const AI_CRON_INTERVAL_MS = 5 * 60 * 1000;
let aiCronTimer: ReturnType<typeof setInterval> | null = null;

async function aiCronJob(currentPrice: number): Promise<void> {
  const data = buildVolatilityData(currentPrice);
  await analyzeVolatilityAndDecide(data);
}

function startAICron(getCurrentPrice: () => number): void {
  if (aiCronTimer) return;
  aiCronTimer = setInterval(
    () => void aiCronJob(getCurrentPrice()),
    AI_CRON_INTERVAL_MS,
  );
}

function stopAICron(): void {
  if (aiCronTimer) {
    clearInterval(aiCronTimer);
    aiCronTimer = null;
  }
}

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
          "\x1b[36m\n🧠 AI Brain Engaged. Next cron job will fetch LLM strategy.\x1b[0m",
        );
        startAICron(() => latestPrice);
        void aiCronJob(latestPrice);
      } else {
        console.log(
          "\x1b[33m\n⚠️  AI Brain Disabled. Using fallback spread.\x1b[0m",
        );
        stopAICron();
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
  console.log(`balances : ${bal0.formatted} ${bal0.symbol} / ${bal1.formatted} ${bal1.symbol}`);

  if (POSITION_ID == null) {
    console.log("mode     : DRY-RUN (no POSITION_ID — rebalance will be simulated)");
  } else {
    console.log(`position : #${POSITION_ID}`);
    const pm = CONTRACTS.nonfungiblePositionManager;
    await ensureApproval(publicClient, walletClient, TOKEN0, pm);
    await ensureApproval(publicClient, walletClient, TOKEN1, pm);
    console.log("approvals: OK");
  }

  console.log(`AI brain : OFF (press T to toggle)\n`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let rebalancing = false;
let latestPrice = 0;

async function onTick(snapshot: Slot0Snapshot): Promise<void> {
  const { tick, price, priceInverted } = snapshot;
  latestPrice = priceInverted;
  recordPrice(priceInverted);

  const spreadLabel = StateManager.isAIEngineActive ? "AI" : "fixed";
  console.log(
    `[tick=${tick}] BNB/USDT=${priceInverted.toFixed(2)} | spread=${StateManager.effectiveSpread.toFixed(2)}(${spreadLabel}) | range=[${engine.tickLower}, ${engine.tickUpper})`,
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

  console.log("[rebalance] tick left active range — starting rebalance…");
  rebalancing = true;

  try {
    // Ask AI for fresh spread before computing range (if enabled)
    if (StateManager.isAIEngineActive) {
      await aiCronJob(priceInverted);
    }

    const newRange = engine.computeNewRange(tick, DEFAULT_RANGE_WIDTH);

    // ----- DRY-RUN path -----
    if (POSITION_ID == null) {
      console.warn("[rebalance] DRY-RUN — simulating full 3-phase cycle");
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
      slippageBps: 50,
    });

    engine.updateRange(newRange);
    console.log(
      `[rebalance] done — new range [${newRange.tickLower}, ${newRange.tickUpper})`,
    );
    console.log(
      `[rebalance] withdraw: ${result.withdrawTx} | swap: ${result.swap.needed ? result.swap.txHash : "none"} | mint: ${result.mintTx}`,
    );
  } catch (err) {
    console.error("[rebalance] failed:", err);
  } finally {
    rebalancing = false;
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

  setupHotkeyListener();
  observer.startPolling(onTick, POLL_INTERVAL_MS);
}

void main();

// Graceful shutdown
const shutdown = () => {
  console.log("\n[shutdown] stopping…");
  observer.stopPolling();
  stopAICron();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
