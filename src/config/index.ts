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
