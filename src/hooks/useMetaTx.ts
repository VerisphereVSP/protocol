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
import { fetchNonce, signPermit, submitRelayAsync, readPermitNonce, readEip712Domain, fetchFeePolicy, fetchFeeQuote } from "./relay.js";
import { walletPrompt } from "./walletPrompt.js";  // patch_protocol_gas_fee
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

      // Standing fee allowance (ERC-2612 permit) to the fee COLLECTOR.
      // patch_protocol_gas_fee: the relay quotes and collects its own
      // gas-indexed fee (no contract carries fee logic), so the spender is the
      // relay wallet from /api/relay/fee-policy — the Forwarder only on an older
      // backend without that endpoint. Size and renewal rule unchanged from the
      // security review (C1 blast radius): 100 VSP, re-signed below 10 VSP.
      // patch_relay_permit: the fee permit rides the relay request body; the
      // server executes body.permit (posting) BEFORE body.fee_permit, so nonces
      // are posting = base N, fee = N+1.
      let needFeePermit = false;
      const APPROVAL_AMOUNT = BigInt("100000000000000000000"); // 100 VSP
      const policy = await fetchFeePolicy(API_BASE);
      const feeSpender = (policy?.collector || addresses.Forwarder) as Address | undefined;
      if (feeSpender) {
        const currentAllowance = (await publicClient.readContract({
          address: addresses.VSPToken as Address,
          abi: VSPTokenABI,
          functionName: "allowance",
          args: [userAddress, feeSpender],
        })) as bigint;

        const MIN_ALLOWANCE = BigInt("10000000000000000000"); // 10 VSP
        if (currentAllowance < MIN_ALLOWANCE) {
          needFeePermit = true; // signed AFTER the posting permit (nonce order)
        }
      }

      // The fee for THIS action, quoted by the relay from gas before anything
      // is signed. Shown by the app (verisphere:fee-quote); sent back with the
      // request so the relay can never charge more than what was displayed.
      const quote = await fetchFeeQuote(API_BASE, targetContract, calldata, userAddress);
      window.dispatchEvent(
        new CustomEvent("verisphere:fee-quote", {
          detail: quote
            ? { fee_vsp: quote.fee_total_vsp, fee_usd: quote.fee_usd, action_type: quote.action_type, available: true }
            : { available: false },
        }),
      );

      // Every wallet request of this action goes through walletPrompt(): one at
      // a time, announced to the page until it resolves (lost-prompt fix).
      const promptCount = (options?.permitSpec ? 1 : 0) + (needFeePermit ? 1 : 0) + 1;
      let promptIndex = 0;

      // Posting permit (PostRegistry/StakeEngine spend) — signed HERE, after any
      // fee permit, so it gets the next sequential nonce (base+1 if the fee
      // permit fired, base otherwise). This is what kills the nonce collision.
      const postingPermit = options?.permitSpec
        ? await walletPrompt("Allow the protocol to use your VSP (one-time)", ++promptIndex, promptCount, () =>
            signPermit({
              walletClient,
              publicClient,
              tokenAddress: options.permitSpec!.tokenAddress,
              spender: options.permitSpec!.spender,
              value: options.permitSpec!.value,
              chainId: chain.id,
              nonceOverride: permitNonce,
            }),
          )
        : undefined;

      // Fee permit rides the relay body (fee_permit); the server executes it
      // AFTER the posting permit, so it takes the next sequential nonce.
      const feePermit = needFeePermit
        ? await walletPrompt("Allow relay fees to be taken in VSP (one-time, 100 VSP standing)", ++promptIndex, promptCount, () =>
            signPermit({
              walletClient,
              publicClient,
              tokenAddress: addresses.VSPToken as Address,
              spender: feeSpender as Address,
              value: APPROVAL_AMOUNT,
              chainId: chain.id,
              nonceOverride: postingPermit ? permitNonce + 1n : permitNonce,
            }),
          )
        : undefined;
      // ForwardRequest EIP-712 domain read from the Forwarder's eip712Domain()
      // (EIP-5267), read-or-throw — same anti-drift guard as the permit domain.
      // Requires the deployed Forwarder to expose eip712Domain() (OZ
      // ERC2771Forwarder extends EIP712, so it does).
      const fwdDomain = await readEip712Domain(
        publicClient,
        addresses.Forwarder as Address,
      );
      const actionLabel = quote
        ? `Sign the action — relay fee ${quote.fee_total_vsp.toFixed(4)} VSP`
        : "Sign the action";
      const signature = await walletPrompt(actionLabel, ++promptIndex, promptCount, () =>
        walletClient.signTypedData({
          domain: {
            name: fwdDomain.name,
            version: fwdDomain.version,
            chainId: chain.id,
            verifyingContract: addresses.Forwarder as Address,
          },
          types: FORWARD_REQUEST_TYPES,
          primaryType: "ForwardRequest",
          message: forwardRequest,
        }),
      );

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
        quote?.fee_total_vsp,  // patch_protocol_gas_fee: never charged more than displayed
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
