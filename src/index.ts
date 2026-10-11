// protocol/src/index.ts
// Public API of @verisphere/protocol.
// Single source of truth for frontend: ABIs, types, deployment addresses, and hooks.

// ABIs (for use with wagmi/viem in frontends)
export {
  PostRegistryABI,
  StakeEngineABI,
  LinkGraphABI,
  ProtocolViewsABI,
  VSPTokenABI,
} from "./abis.js";

// Types
export type {
  Address,
  Post,
  Link,
  StakeSide,
  ContractAddresses,
} from "./types.js";

// Bundle 5 contract cap constants (manually synced to chain values)
export {
  POST_REGISTRY_MAX_CLAIM_LENGTH,
  LINKGRAPH_MAX_OUTGOING_LINKS_PER_CLAIM,
  LINKGRAPH_MAX_INCOMING_LINKS_PER_CLAIM,
  STAKE_ENGINE_MAX_STAKE_AMOUNT,
} from "./constants.js";

// Deployment addresses (written by post-deploy.sh)
export { FUJI_ADDRESSES, getAddresses, setRuntimeAddresses, SUPPORTED_CHAINS } from "./addresses/index.js";

// Server-side ethers client (Node.js / backend use)
export { ProtocolClient } from "./client.js";
export type { ProtocolClientOpts } from "./client.js";

// React hooks — relay-based, no direct chain access
// Frontend imports: import { useCreateClaim, useStake } from "@verisphere/protocol"
export {
  useMetaTx,
  useCreateClaim,
  useCreateLink,
  useStake,
  fetchAllowance,
  fetchBalance,
  checkClaimOnChain,
  fetchPostingFee,
  fetchFeePolicy,   // patch_protocol_gas_fee
  fetchFeeQuote,    // patch_protocol_gas_fee
  walletPrompt,     // patch_protocol_gas_fee
} from "./hooks/index.js";
export type {
  RelayResponse,
  ClaimState,
  WriteHookState,
  FeePolicy,            // patch_protocol_gas_fee
  FeeQuote,             // patch_protocol_gas_fee
  WalletPromptDetail,   // patch_protocol_gas_fee
} from "./hooks/index.js";
