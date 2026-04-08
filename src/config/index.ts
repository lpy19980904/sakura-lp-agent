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

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export const chain = bsc;

// ---------------------------------------------------------------------------
// PancakeSwap V3 contract addresses (BSC mainnet)
// ---------------------------------------------------------------------------

export const CONTRACTS = {
  pancakeV3Factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  nonfungiblePositionManager:
    "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  swapRouter: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  tickLens: "0x9a489505a00cE272eAa5e07Dba6491314CaE3796",
  smartRouterV3: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
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
