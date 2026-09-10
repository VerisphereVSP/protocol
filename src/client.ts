// protocol/src/client.ts
// Server-side protocol client using viem.
// Used by the app backend for direct chain reads and writes.

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
  getContract,
  type GetContractReturnType,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, avalanche } from "viem/chains";

import {
  PostRegistryABI,
  StakeEngineABI,
  LinkGraphABI,
  ProtocolViewsABI,
} from "./abis.js";
import type { ContractAddresses } from "./types.js";

export type { ContractAddresses };

const CHAINS: Record<number, Chain> = {
  43113: avalancheFuji,
  43114: avalanche,
};

export type ProtocolClientOpts = {
  rpcUrl: string;
  privateKey?: `0x${string}`;
  addresses: ContractAddresses;
  chainId?: number;
};

export class ProtocolClient {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly addresses: ContractAddresses;

  constructor(opts: ProtocolClientOpts) {
    // Review 3 (2026-09-10): fail CLOSED on an unknown chain id — silently
    // falling back to Fuji would transact against a surprising network.
    const requestedChainId = opts.chainId ?? 43113;
    const chain = CHAINS[requestedChainId];
    if (!chain) throw new Error(`Unsupported chain ID ${requestedChainId}`);

    this.publicClient = createPublicClient({
      chain,
      transport: http(opts.rpcUrl),
    });

    if (opts.privateKey) {
      const account = privateKeyToAccount(opts.privateKey);
      this.walletClient = createWalletClient({
        chain,
        transport: http(opts.rpcUrl),
        account,
      });
    }

    this.addresses = opts.addresses;
  }

  // ─── Reads ──────────────────────────────────────────────────

  async getPost(postId: bigint) {
    return this.publicClient.readContract({
      address: this.addresses.PostRegistry,
      abi: PostRegistryABI,
      functionName: "getPost",
      args: [postId],
    });
  }

  async getClaim(claimId: bigint): Promise<string> {
    return this.publicClient.readContract({
      address: this.addresses.PostRegistry,
      abi: PostRegistryABI,
      functionName: "getClaim",
      args: [claimId],
    }) as Promise<string>;
  }

  async getNextPostId(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.addresses.PostRegistry,
      abi: PostRegistryABI,
      functionName: "nextPostId",
    }) as Promise<bigint>;
  }

  // ─── Writes (require privateKey) ────────────────────────────

  async createClaim(
    content: string,
  ): Promise<{ txHash: string; postId?: bigint }> {
    if (!this.walletClient) throw new Error("createClaim requires privateKey");

    const hash = await this.walletClient.writeContract({
      chain: null,
      account: null,
      address: this.addresses.PostRegistry,
      abi: PostRegistryABI,
      functionName: "createClaim",
      args: [content],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    // Parse PostCreated event
    const postId = receipt.logs
      .map((log) => {
        try {
          // PostCreated event topic
          return log.topics[1] ? BigInt(log.topics[1]) : undefined;
        } catch {
          return undefined;
        }
      })
      .find((id) => id !== undefined);

    return { txHash: hash, postId };
  }

  async stake(
    postId: bigint,
    side: 0 | 1,
    amount: bigint,
  ): Promise<{ txHash: string }> {
    if (!this.walletClient) throw new Error("stake requires privateKey");

    const hash = await this.walletClient.writeContract({
      chain: null,
      account: null,
      address: this.addresses.StakeEngine,
      abi: StakeEngineABI,
      functionName: "stake",
      args: [postId, side, amount],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }
}
