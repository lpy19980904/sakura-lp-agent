import { bsc } from "viem/chains";
import "dotenv/config";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const BSC_RPC_URL = requireEnv("BSC_RPC_URL");
export const PRIVATE_KEY = requireEnv("PRIVATE_KEY") as `0x${string}`;
export const GEMINI_API_KEY = requireEnv("GEMINI_API_KEY");

/** NFT position ID — null means DRY-RUN mode. Updated at runtime after rebalance. */
export let POSITION_ID: bigint | null =
  process.env.POSITION_ID ? BigInt(process.env.POSITION_ID) : null;

export function setPositionId(id: bigint): void {
  POSITION_ID = id;
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export const chain = bsc;

// ---------------------------------------------------------------------------
// Uniswap V3 contract addresses (BSC mainnet)
// ---------------------------------------------------------------------------

export const CONTRACTS = {
  uniswapV3Factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
  nonfungiblePositionManager:
    "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
  swapRouter: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
} as const;

// ---------------------------------------------------------------------------
// Common BSC token addresses
// ---------------------------------------------------------------------------

export const TOKENS = {
  WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  BUSD: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
} as const;

// ---------------------------------------------------------------------------
// Bot parameters
// ---------------------------------------------------------------------------

/** Polling interval in ms — roughly one BSC block (~3 s). */
export const POLL_INTERVAL_MS = 3_000;

/** Default tick-spacing width for narrow range strategy (in tick-spacing units). */
export const DEFAULT_RANGE_WIDTH = 10;

/**
 * Skip opening a new LP position after rebalance when the simulated on-chain mint
 * deposit (amount0+amount1 valued in token1) is below this fraction of the
 * pre-mint wallet total (same valuation). Set to 0 to disable. Default 0.05 = 5%.
 */
/**
 * Comma-separated list of NFT position IDs to withdraw & consolidate on boot.
 * Example: STALE_POSITION_IDS=1764367,1764365,1764209
 * Empty or unset = no cleanup.
 */
export const STALE_POSITION_IDS: bigint[] = (() => {
  const raw = process.env.STALE_POSITION_IDS;
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
})();

export const MIN_MINT_DEPLOYED_TO_WALLET_RATIO = (() => {
  const raw = process.env.MIN_MINT_DEPLOYED_TO_WALLET_RATIO;
  if (raw === undefined || raw === "") return 0.05;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 0.99);
})();
