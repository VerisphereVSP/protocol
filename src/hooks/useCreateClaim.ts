// protocol/src/hooks/useCreateClaim.ts
import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address } from "viem";
import { useMetaTx } from "./useMetaTx.js";
import { fetchAllowance, fetchBalance, checkClaimOnChain } from "./relay.js";
import { PostRegistryABI } from "../abis.js";
import { getAddresses } from "../addresses/index.js";
import type { RelayResponse, ClaimState, SimilarClaim } from "./types.js";

const API_BASE =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE) || "/api";

const DEFAULT_POSTING_FEE = BigInt("1000000000000000000"); // 1 VSP fallback

function errorToString(err: any): string {
  if (typeof err === "string") return err;
  if (err?.shortMessage) return err.shortMessage;
  if (err?.message) return err.message;
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

/** Response shape from /api/claims/check-similar */
interface CheckSimilarResponse {
  matches: SimilarClaim[];
  provider?: string;
  error?: string;
}

/** Call /api/claims/check-similar to find semantically similar existing claims. */
async function checkSimilarClaims(apiBase: string, text: string): Promise<CheckSimilarResponse> {
  try {
    const res = await fetch(
      `${apiBase}/claims/check-similar?text=${encodeURIComponent(text)}&threshold=0.85&top_k=5`,
    );
    if (!res.ok) return { matches: [] };
    return await res.json();
  } catch {
    return { matches: [] };  // Fail open
  }
}

export function useCreateClaim() {
  const { address: userAddress, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { sendMetaTx } = useMetaTx();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [claimState, setClaimState] = useState<ClaimState | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [similarClaims, setSimilarClaims] = useState<SimilarClaim[]>([]);

  const getPermitIfNeeded = useCallback(
    async () => {
      if (!userAddress || !publicClient || !walletClient || !chain) return undefined;
      const addresses = getAddresses(chain.id);
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

  /**
   * Pre-flight duplicate check. Returns:
   *   { proceed: true }                     — no duplicates found, safe to create
   *   { proceed: false, blocked: true }     — high-similarity or exact match, creation prohibited
   *   { proceed: false, blocked: false }    — medium-similarity, user should confirm
   */
  const checkDuplicates = useCallback(
    async (text: string): Promise<{ proceed: boolean; blocked?: boolean; state?: ClaimState }> => {
      setError(null);
      setIsDuplicate(false);
      setSimilarClaims([]);

      // Step 1: Exact on-chain duplicate check (always runs, even with stub embeddings)
      const existing = await checkClaimOnChain(API_BASE, text);
      if (existing.exists && existing.post_id != null) {
        const state: ClaimState = {
          post_id: existing.post_id,
          text,
          creator: userAddress || "",
          support_total: 0,
          challenge_total: 0,
        };
        setClaimState(state);
        setIsDuplicate(true);
        setError(`This exact claim already exists (post #${existing.post_id}). Stake on the existing claim instead.`);
        window.dispatchEvent(new CustomEvent("verisphere:toast", {
          detail: { message: `Claim already exists as post #${existing.post_id}`, type: "warning" },
        }));
        return { proceed: false, blocked: true, state };
      }

      // Step 2: Semantic similarity check (only meaningful with real embeddings)
      const similar = await checkSimilarClaims(API_BASE, text);

      // If using stub provider, skip semantic analysis
      if (similar.provider === "stub") {
        return { proceed: true };
      }

      if (similar.matches && similar.matches.length > 0) {
        setSimilarClaims(similar.matches);

        // All semantic matches warn — only exact on-chain text match blocks.
        const topMatch = similar.matches[0];
        const pct = (topMatch.similarity * 100).toFixed(0);
        const isHigh = topMatch.level === "high";
        const preview = topMatch.text.slice(0, 80) + (topMatch.text.length > 80 ? "…" : "");
        setError(
          isHigh
            ? `Very similar claim exists: "${preview}" (post #${topMatch.post_id}, ${pct}% similar). Create anyway?`
            : `Similar claim found: "${preview}" (post #${topMatch.post_id}, ${pct}% similar). Create anyway?`,
        );
        if (isHigh) {
          window.dispatchEvent(new CustomEvent("verisphere:toast", {
            detail: {
              message: `Very similar claim exists (post #${topMatch.post_id}, ${pct}% match). Create anyway?`,
              type: "warning",
            },
          }));
        }
        return { proceed: false, blocked: false };
      }

      return { proceed: true };
    },
    [userAddress],
  );

  const createClaim = useCallback(
    async (text: string, skipDuplicateCheck?: boolean): Promise<ClaimState | null> => {
      if (!userAddress) { throw new Error("Wallet not connected"); }
      setLoading(true); setError(null); setTxHash(null); setClaimState(null);
      setIsDuplicate(false); setSimilarClaims([]);
      try {
        const addresses = getAddresses(chain?.id ?? 43113);
        const postingFee = DEFAULT_POSTING_FEE;

        // Check balance
        const balance = await fetchBalance(API_BASE, userAddress);
        if (balance < postingFee) {
          const msg = "Insufficient VSP balance (need 1 VSP to create a claim)";
          setError(msg);
          throw new Error(msg);
        }

        // Duplicate checks (unless explicitly skipped)
        if (!skipDuplicateCheck) {
          const dupResult = await checkDuplicates(text);
          if (!dupResult.proceed) {
            if (dupResult.blocked) {
              // Exact on-chain match — hard block
              throw new Error("This exact claim already exists");
            }
            // Semantic similarity warning — toast was shown, proceed anyway.
            // The user already clicked "Create & stake" expressing intent.
          }
        }

        // Get permit if needed
        const permit = await getPermitIfNeeded();

        // Encode createClaim calldata
        const calldata = encodeFunctionData({
          abi: PostRegistryABI,
          functionName: "createClaim",
          args: [text],
        });

        const result: RelayResponse = await sendMetaTx(
          addresses.PostRegistry as Address, calldata,
          { gasLimit: 2_000_000, permitSpec: permit },
        );

        // Check if the relay detected a duplicate (belt-and-suspenders)
        if (result.duplicate) {
          setIsDuplicate(true);
          const msg = result.claim
            ? `This claim already exists (post #${result.claim.post_id}). No VSP was charged.`
            : "This claim already exists on-chain. No VSP was charged.";
          setError(msg);
          window.dispatchEvent(new CustomEvent("verisphere:toast", {
            detail: { message: msg, type: "warning" },
          }));
          if (result.claim) setClaimState(result.claim);
          throw new Error("Claim creation failed");
        }

        setTxHash(result.tx_hash);
        if (result.claim) { setClaimState(result.claim); return result.claim; }

        // tx_hash present but backend didn't decode claim state — retry lookup
        if (result.tx_hash) {
          try {
            const lookup = await checkClaimOnChain(API_BASE, text);
            if (lookup.exists && lookup.post_id != null) {
              const state: ClaimState = {
                post_id: lookup.post_id, text, creator: userAddress,
                support_total: 0, challenge_total: 0,
              };
              setClaimState(state);
              return state;
            }
          } catch {}
        }
        return null;
      } catch (err: any) {
        const msg = errorToString(err);
        if (msg.toLowerCase().includes("claim already exists") || msg.toLowerCase().includes("duplicate")) {
          setIsDuplicate(true);
          setError("This claim already exists on-chain. No VSP was charged.");
        } else {
          setError(msg);
        }
        console.error("createClaim error:", err);
        throw err;
      } finally { setLoading(false); }
    },
    [userAddress, sendMetaTx, getPermitIfNeeded, checkDuplicates],
  );

  return {
    createClaim,
    checkDuplicates,
    loading, error, txHash, claimState,
    isDuplicate, similarClaims,
    needsApproval: false, approveVSP: async () => {},
  };
}
