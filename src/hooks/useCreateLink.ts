// protocol/src/hooks/useCreateLink.ts
import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address } from "viem";
import { useMetaTx } from "./useMetaTx.js";
import { fetchAllowance } from "./relay.js";
import { PostRegistryABI } from "../abis.js";
import { getAddresses } from "../addresses/index.js";

const API_BASE =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE) || "/api";

const DEFAULT_POSTING_FEE = BigInt("1000000000000000000"); // fallback
const PERMIT_BUFFER_MULTIPLIER = 10n;

export function useCreateLink() {
  const { address: userAddress, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { sendMetaTx } = useMetaTx();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getPermitIfNeeded = useCallback(
    async () => {
      if (!userAddress || !publicClient || !walletClient || !chain) return undefined;
      const addresses = getAddresses(chain.id);
      const postingFee = DEFAULT_POSTING_FEE;
      const currentAllowance = await fetchAllowance(
        API_BASE, userAddress, addresses.PostRegistry,
      );
      if (currentAllowance >= DEFAULT_POSTING_FEE) return undefined;
      return {
        tokenAddress: addresses.VSPToken as Address,
        spender: addresses.PostRegistry as Address,
        value: DEFAULT_POSTING_FEE * 100n,  // patch_protocol_gas_fee: standing allowance for 100 posts, one prompt
      };
    },
    [userAddress, publicClient, walletClient, chain],
  );

  const createLink = useCallback(
    async (fromPostId: number, toPostId: number, isChallenge: boolean): Promise<string | null> => {
      if (!userAddress || !publicClient) { throw new Error("Wallet not connected"); }
      setIsLoading(true); setError(null);
      try {
        const addresses = getAddresses(chain?.id ?? 43113);
        const permit = await getPermitIfNeeded();
        const calldata = encodeFunctionData({
          abi: PostRegistryABI,
          functionName: "createLink",
          args: [BigInt(fromPostId), BigInt(toPostId), isChallenge],
        });
        const result = await sendMetaTx(
          addresses.PostRegistry as Address, calldata,
          { gasLimit: 1_000_000, permitSpec: permit },
        );
        return result.tx_hash;
      } catch (err: any) {
        setError(err?.message || "Failed to create link");
        console.error("createLink error:", err);
        throw err;
      } finally { setIsLoading(false); }
    },
    [userAddress, publicClient, sendMetaTx, getPermitIfNeeded],
  );

  return { createLink, isLoading, error };
}
