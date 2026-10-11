// protocol/src/hooks/useStake.ts
import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, parseUnits, type Address } from "viem";
import { useMetaTx } from "./useMetaTx.js";
import { fetchAllowance } from "./relay.js";
import { StakeEngineABI, VSPTokenABI } from "../abis.js";
import { getAddresses } from "../addresses/index.js";
import type { ClaimState } from "./types.js";

const API_BASE =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE) || "/api";

function errorToString(err: any): string {
  if (typeof err === "string") return err;
  if (err?.shortMessage) return err.shortMessage;
  if (err?.message) return err.message;
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

export function useStake() {
  const { address: userAddress, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { sendMetaTx } = useMetaTx();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [claimState, setClaimState] = useState<ClaimState | null>(null);

  const getPermitIfNeeded = useCallback(
    async (amountWei: bigint) => {
      if (!userAddress || !publicClient || !walletClient || !chain) return undefined;
      const addresses = getAddresses(chain.id);
      const currentAllowance = await fetchAllowance(
        API_BASE, userAddress, addresses.StakeEngine,
      );
      if (currentAllowance >= amountWei) return undefined;
      // patch_protocol_gas_fee: a STANDING allowance (10,000 VSP, or twice this
      // stake if larger) instead of twice each stake — one prompt, not one per
      // raise. StakeEngine can only draw on it through a setStake the user
      // signs, so a large allowance adds no exposure.
      const STANDING = parseUnits("10000", 18);
      return {
        tokenAddress: addresses.VSPToken as Address,
        spender: addresses.StakeEngine as Address,
        value: amountWei * 2n > STANDING ? amountWei * 2n : STANDING,
      };
    },
    [userAddress, publicClient, walletClient, chain],
  );

  /** Set stake to target value. Positive = support, negative = challenge, 0 = withdraw all.
   *  Single contract call via setStake(uint256 postId, int256 target). */
  const setStake = useCallback(
    async (postId: number, target: number): Promise<ClaimState | null> => {
      if (!userAddress) { setError("Wallet not connected"); return null; }
      setLoading(true); setError(null); setTxHash(null); setClaimState(null);
      try {
        const addresses = getAddresses(chain?.id ?? 43113);
        // For staking (target > current), we need a permit for the additional VSP
        const targetWei = parseUnits(Math.abs(target).toString(), 18);
        const permit = target !== 0 ? await getPermitIfNeeded(targetWei) : undefined;
        // Encode setStake(uint256 postId, int256 target)
        // target is in wei, signed: positive = support, negative = challenge
        const targetWeiSigned = target >= 0
          ? parseUnits(target.toString(), 18)
          : -parseUnits(Math.abs(target).toString(), 18);
        const calldata = encodeFunctionData({
          abi: [{
            name: "setStake",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "postId", type: "uint256" },
              { name: "target", type: "int256" },
            ],
            outputs: [],
          }],
          functionName: "setStake",
          args: [BigInt(postId), targetWeiSigned],
        });
        const result = await sendMetaTx(
          addresses.StakeEngine as Address, calldata,
          { gasLimit: 800_000, permitSpec: permit },
        );
        setTxHash(result.tx_hash);
        if (result.claim) { setClaimState(result.claim); return result.claim; }
        return null;
      } catch (err: any) {
        setError(errorToString(err));
        console.error("setStake error:", err);
        throw err;
      } finally { setLoading(false); }
    },
    [userAddress, sendMetaTx, getPermitIfNeeded],
  );

  // Legacy wrappers for compatibility
  const stake = useCallback(
    async (postId: number, side: "support" | "challenge", amount: number) => {
      const target = side === "support" ? amount : -amount;
      return setStake(postId, target);
    },
    [setStake],
  );

  const withdraw = useCallback(
    async (postId: number, side: "support" | "challenge", amount: number) => {
      // For legacy withdraw, we'd need current position to compute new target.
      // This is only used by old code paths — new code should use setStake directly.
      return setStake(postId, 0); // Withdraw all as fallback
    },
    [setStake],
  );

  return { stake, withdraw, setStake, loading, error, txHash, claimState,
    needsApproval: false, approveVSP: async () => {} };
}
