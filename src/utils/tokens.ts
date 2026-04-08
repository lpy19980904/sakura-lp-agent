import {
  type PublicClient,
  type WalletClient,
  type Address,
  maxUint256,
  formatUnits,
} from "viem";
import { erc20Abi } from "../abi/ERC20.js";

// ---------------------------------------------------------------------------
// Balance helpers
// ---------------------------------------------------------------------------

export interface TokenBalance {
  address: Address;
  raw: bigint;
  formatted: string;
  decimals: number;
  symbol: string;
}

/** Read ERC-20 balance, decimals and symbol in a single multicall. */
export async function getTokenBalance(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<TokenBalance> {
  const [raw, decimals, symbol] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    }),
  ]);

  return {
    address: token,
    raw,
    formatted: formatUnits(raw, decimals),
    decimals,
    symbol,
  };
}

// ---------------------------------------------------------------------------
// Approval helpers
// ---------------------------------------------------------------------------

/** Check current allowance for `spender`. */
export async function getAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

/**
 * Ensure the spender has sufficient allowance.
 * If current allowance < requiredAmount, sends an unlimited approve tx.
 * Returns true if a new approval was sent.
 */
export async function ensureApproval(
  publicClient: PublicClient,
  walletClient: WalletClient,
  token: Address,
  spender: Address,
  requiredAmount: bigint = 0n,
): Promise<boolean> {
  const account = walletClient.account;
  if (!account) throw new Error("WalletClient has no account attached");

  const current = await getAllowance(publicClient, token, account.address, spender);

  if (current >= (requiredAmount > 0n ? requiredAmount : maxUint256 / 2n)) {
    return false;
  }

  console.log(
    `[approval] approving ${token} for spender ${spender} …`,
  );

  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
    chain: publicClient.chain,
    account,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[approval] approved — tx ${hash}`);
  return true;
}
