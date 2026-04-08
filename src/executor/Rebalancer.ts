import {
  type PublicClient,
  type WalletClient,
  type Address,
  type Hash,
  encodeFunctionData,
  maxUint128,
} from "viem";
import { nonfungiblePositionManagerAbi } from "../abi/NonfungiblePositionManager.js";
import { CONTRACTS } from "../config/index.js";

export interface MintParams {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  recipient: Address;
}

export class Rebalancer {
  private readonly positionManager: Address;

  constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
  ) {
    this.positionManager = CONTRACTS.nonfungiblePositionManager;
  }

  /**
   * Full rebalance cycle:
   *   1. decreaseLiquidity  – withdraw all liquidity
   *   2. collect             – sweep tokens + accrued fees
   *   3. mint                – open a new position at the new range
   *
   * All three calls are batched into a single multicall transaction.
   */
  async execute(
    positionId: bigint,
    liquidity: bigint,
    mintParams: MintParams,
  ): Promise<Hash> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min
    const account = this.walletClient.account;
    if (!account) throw new Error("WalletClient has no account attached");

    // ----- 1. decreaseLiquidity -----
    const decreaseData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: positionId,
          liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        },
      ],
    });

    // ----- 2. collect -----
    const collectData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: positionId,
          recipient: account.address,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        },
      ],
    });

    // ----- 3. mint -----
    const mintData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [
        {
          token0: mintParams.token0,
          token1: mintParams.token1,
          fee: mintParams.fee,
          tickLower: mintParams.tickLower,
          tickUpper: mintParams.tickUpper,
          amount0Desired: mintParams.amount0Desired,
          amount1Desired: mintParams.amount1Desired,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: mintParams.recipient,
          deadline,
        },
      ],
    });

    // ----- multicall -----
    const txHash = await this.walletClient.writeContract({
      address: this.positionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "multicall",
      args: [[decreaseData, collectData, mintData]],
      chain: this.publicClient.chain,
      account,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    console.log(
      `[Rebalancer] tx confirmed in block ${receipt.blockNumber} — ${txHash}`,
    );

    return txHash;
  }
}
