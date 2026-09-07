// protocol/src/hooks/useMetaTx.ts
// Core meta-transaction hook (bundle 4b-1 — async-by-default).
//
// Flow:
//   1. Sign EIP-712 ForwardRequest in user's wallet.
//   2. POST /api/relay/async  → returns { tx_hash, tx_log_id } immediately.
//   3. Await tx resolution via the verisphere:tx-resolved window event,
//      which is dispatched by NotificationsProvider when it sees a
//      tx_log row flip out of 'pending'.
//   4. On confirmed: return synthetic RelayResponse shaped like the old
//      synchronous endpoint's response (sans `claim`, which callers
//      reconstruct via checkClaimOnChain if they need it).
//   5. On reverted/dropped: throw with the error message.
//
// Callers see no API change. The `RelayResponse` interface remains the
// same; `result.claim` is now usually undefined, and callers already
// have fallback paths that fetch claim state if missing.
import { useCallback } from "react";
import { useWalletClient, usePublicClient, useAccount } from "wagmi";
import type { Hex, Address } from "viem";
import { getAddresses } from "../addresses/index.js";
import { VSPTokenABI } from "../abis.js";
import { fetchNonce, signPermit, submitRelayAsync, readPermitNonce, readEip712Domain } from "./relay.js";
// patch_bundle04_5_p4_useMetaTx_rewire
import { waitForTxConfirmation } from "./useTxConfirmation.js";
import type { RelayResponse, PermitData } from "./types.js";

const API_BASE =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_API_BASE) || "/api";

// Window-event-based wait. Inverse of NotificationsProvider's dispatch.
// Timeout default is generous: chain confirmation + indexer poll interval
// can take 20-30s on Fuji. The user sees a notifications-panel entry
// throughout, so a longer wait doesn't feel broken.
// patch_bundle04_5_p5_strip_tx_diag: dead pre-patch-4 wait helper and its
// supporting type/const removed, along with diagnostic console output
// added in patch 3.6.2 for the staking-timeout investigation.

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
} as const;

export { type RelayResponse };

export function useMetaTx() {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { chain } = useAccount();

  const sendMetaTx = useCallback(
    async (
      targetContract: Address,
      calldata: Hex,
      options?: { gasLimit?: number; value?: number; permitSpec?: { tokenAddress: Address; spender: Address; value: bigint } },
    ): Promise<RelayResponse> => {
      if (!walletClient || !publicClient || !chain)
        throw new Error("Wallet not connected");

      const userAddress = walletClient.account.address;
      const addresses = getAddresses(chain.id);
      const nonce = await fetchNonce(API_BASE, userAddress);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      // Sequential permit-nonce allocation: the fee permit and the posting
      // permit are both EIP-2612 permits on VSPToken and must use consecutive
      // nonces in execution order (fee, then posting), or the second reverts
      // ERC2612InvalidSigner. Read the base nonce once; hand out base, base+1.
      let permitNonce = await readPermitNonce(
        publicClient,
        addresses.VSPToken as Address,
        userAddress,
      );

      const forwardRequest = {
        from: userAddress,
        to: targetContract,
        value: BigInt(options?.value ?? 0),
        gas: BigInt(options?.gasLimit ?? 1_500_000),
        nonce: BigInt(nonce),
        deadline,
        data: calldata,
      };

      // One-time forwarder VSP allowance (ERC-2612 permit).
      // patch_relay_permit: the fee permit used to execute EAGERLY via
      // POST /api/mm/execute-permit — an MM-prefixed route retired by the
      // Phase 4 410 (and its executor was MM-wallet-funded, which dies at
      // Phase 5 anyway). The relay endpoint natively accepts fee_permit in
      // the request body (relay-wallet-funded, guard-ordered), so the fee
      // permit now RIDES THE RELAY REQUEST instead. Server executes
      // body.permit (posting) BEFORE body.fee_permit, so nonces are:
      // posting = base N, fee = N+1 — the reverse of the old eager order.
      let needFeePermit = false;
      // security review 2026-09 (C1 blast radius): the standing fee permit
      // was 10,000 VSP per user. With the forwarder drain fixed this is
      // defense in depth — a bug in that path now costs at most 100 VSP per
      // user, at the price of re-signing after ~20 relayed actions.
      const APPROVAL_AMOUNT = BigInt("100000000000000000000"); // 100 VSP
      if (addresses.Forwarder) {
        const currentAllowance = (await publicClient.readContract({
          address: addresses.VSPToken as Address,
          abi: VSPTokenABI,
          functionName: "allowance",
          args: [userAddress, addresses.Forwarder as Address],
        })) as bigint;

        const MIN_ALLOWANCE = BigInt("10000000000000000000"); // 10 VSP
        if (currentAllowance < MIN_ALLOWANCE) {
          window.dispatchEvent(
            new CustomEvent("verisphere:toast", {
              detail: {
                message:
                  "One-time approval: sign a permit to allow relay fees (no gas needed)",
                type: "info",
              },
            }),
          );
          needFeePermit = true; // signed AFTER the posting permit (nonce order)
        }
      }

      // Posting permit (PostRegistry/StakeEngine spend) — signed HERE, after any
      // fee permit, so it gets the next sequential nonce (base+1 if the fee
      // permit fired, base otherwise). This is what kills the nonce collision.
      const postingPermit = options?.permitSpec
        ? await signPermit({
            walletClient,
            publicClient,
            tokenAddress: options.permitSpec.tokenAddress,
            spender: options.permitSpec.spender,
            value: options.permitSpec.value,
            chainId: chain.id,
            nonceOverride: permitNonce,
          })
        : undefined;

      // Fee permit rides the relay body (fee_permit); the server executes it
      // AFTER the posting permit, so it takes the next sequential nonce.
      const feePermit = needFeePermit
        ? await signPermit({
            walletClient,
            publicClient,
            tokenAddress: addresses.VSPToken as Address,
            spender: addresses.Forwarder as Address,
            value: APPROVAL_AMOUNT,
            chainId: chain.id,
            nonceOverride: postingPermit ? permitNonce + 1n : permitNonce,
          })
        : undefined;

      window.dispatchEvent(
        new CustomEvent("verisphere:toast", {
          detail: { message: "Confirm transaction in wallet", type: "info" },
        }),
      );
      // ForwardRequest EIP-712 domain read from the Forwarder's eip712Domain()
      // (EIP-5267), read-or-throw — same anti-drift guard as the permit domain.
      // Requires the deployed Forwarder to expose eip712Domain() (OZ
      // ERC2771Forwarder extends EIP712, so it does).
      const fwdDomain = await readEip712Domain(
        publicClient,
        addresses.Forwarder as Address,
      );
      const signature = await walletClient.signTypedData({
        domain: {
          name: fwdDomain.name,
          version: fwdDomain.version,
          chainId: chain.id,
          verifyingContract: addresses.Forwarder as Address,
        },
        types: FORWARD_REQUEST_TYPES,
        primaryType: "ForwardRequest",
        message: forwardRequest,
      });

      // Convert bigints to numbers for JSON serialization
      const relayRequest = {
        ...forwardRequest,
        value: Number(forwardRequest.value),
        gas: Number(forwardRequest.gas),
        nonce: Number(forwardRequest.nonce),
      };

      const submitResp = await submitRelayAsync(
        API_BASE,
        relayRequest,
        signature,
        postingPermit,
        feePermit,
      );

      // Server pre-flight may detect a duplicate claim before submission.
      if (submitResp.status === "duplicate_claim") {
        return {
          ok: false,
          tx_hash: null,
          duplicate: true,
          claim: submitResp.claim,
        };
      }

      // Submitted to chain; await the notifications watcher's resolution.
      // patch_bundle04_5_p4_useMetaTx_rewire: key by tx_hash, not tx_log_id.
      // Reason: the unified notifications feed dedupes by tx_hash and the
      // winning row often has source !== "tx_log" (chain_tx wins on
      // confirmed protocol events). The dispatch fires per tx_hash so
      // the resolution-wait must subscribe by tx_hash too.
      const resolved = await waitForTxConfirmation(submitResp.tx_hash);

      if (resolved.status === "confirmed") {
        // Synthesize RelayResponse shape. `claim` is intentionally
        // undefined here; callers that need ClaimState reconstruct it
        // via checkClaimOnChain in their own fallback paths
        // (useCreateClaim / useStake already do this).
        return {
          ok: true,
          tx_hash: submitResp.tx_hash,
        };
      }

      // reverted or dropped — throw so callers handle in their catch.
      const msg = resolved.error_message || (resolved.status === "dropped"
        ? "Transaction was dropped from the mempool — try again"
        : "Transaction reverted on-chain");
      throw new Error(msg);
    },
    [walletClient, publicClient, chain],
  );

  return { sendMetaTx };
}
