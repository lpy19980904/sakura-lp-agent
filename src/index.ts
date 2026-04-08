import "dotenv/config";
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
import { Rebalancer } from "./executor/Rebalancer.js";
import { nonfungiblePositionManagerAbi } from "./abi/NonfungiblePositionManager.js";

// ---------------------------------------------------------------------------
// Configuration — edit these for the target pool / position
// ---------------------------------------------------------------------------

/** WBNB / USDT 0.25 % pool on PancakeSwap V3 (BSC). */
const TARGET_POOL: Address = "0x36696169C63e42cd08ce11f5deeBbCeBae652050";
const TICK_SPACING = 50; // 0.25 % fee tier

/** Set to your NFT position token ID once a position is opened. */
let POSITION_ID: bigint | null = null;

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

const observer = new PoolObserver(
  publicClient,
  TARGET_POOL,
  18, // WBNB decimals
  18, // USDT decimals
);

const engine = new RangeEngine(0, 0, TICK_SPACING);

const rebalancer = new Rebalancer(walletClient, publicClient);

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let rebalancing = false;

async function onTick(snapshot: Slot0Snapshot): Promise<void> {
  const { tick, price } = snapshot;
  console.log(
    `[tick=${tick}] price=${price.toFixed(4)} | range=[${engine.tickLower}, ${engine.tickUpper})`,
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
    if (POSITION_ID == null) {
      console.warn(
        "[rebalance] no POSITION_ID set — skipping execution (dry-run mode)",
      );
      const newRange = engine.computeNewRange(tick, DEFAULT_RANGE_WIDTH);
      engine.updateRange(newRange);
      console.log(
        `[rebalance] new range would be [${newRange.tickLower}, ${newRange.tickUpper})`,
      );
      return;
    }

    const position = await publicClient.readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [POSITION_ID],
    });

    const liquidity = position[7]; // uint128 liquidity

    const newRange = engine.computeNewRange(tick, DEFAULT_RANGE_WIDTH);

    await rebalancer.execute(POSITION_ID, liquidity, {
      token0: TOKENS.WBNB,
      token1: TOKENS.USDT,
      fee: 2500,
      tickLower: newRange.tickLower,
      tickUpper: newRange.tickUpper,
      amount0Desired: 0n, // filled from collected tokens in production
      amount1Desired: 0n,
      recipient: account.address,
    });

    engine.updateRange(newRange);
    console.log(
      `[rebalance] done — new range [${newRange.tickLower}, ${newRange.tickUpper})`,
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

console.log("=== Sakura LP Agent ===");
console.log(`chain    : ${chain.name} (id ${chain.id})`);
console.log(`pool     : ${TARGET_POOL}`);
console.log(`wallet   : ${account.address}`);
console.log(`interval : ${POLL_INTERVAL_MS} ms`);
console.log();

observer.startPolling(onTick, POLL_INTERVAL_MS);

// Graceful shutdown
const shutdown = () => {
  console.log("\n[shutdown] stopping observer…");
  observer.stopPolling();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
