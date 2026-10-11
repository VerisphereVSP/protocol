// protocol/src/hooks/walletPrompt.ts — patch_protocol_gas_fee
//
// One wallet request at a time, and the page always knows one is open.
//
// MetaMask shows a single window per request and silently queues the rest; if
// the app fires two requests at once, or a previous one was never answered,
// the next window never appears and the only sign is the badge on the
// extension icon. Toasts fade. So: every signing step goes through
// walletPrompt(), which serialises requests through one promise chain and
// dispatches `verisphere:wallet-prompt` events the app renders as a persistent
// bar ("Signature request waiting in MetaMask — 1 of 2") until the request
// resolves. While a prompt is open the app suppresses non-essential toasts.

export interface WalletPromptDetail {
  state: "open" | "closed";
  /** What the user is being asked to sign, in their words. */
  label: string;
  /** 1-based position within this action's sequence, and the sequence length. */
  index: number;
  count: number;
  /** Set on "closed" when the request failed or was rejected. */
  error?: string;
}

let chain: Promise<unknown> = Promise.resolve();

function emit(detail: WalletPromptDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WalletPromptDetail>("verisphere:wallet-prompt", { detail }));
}

/** Run one wallet request after any other that is still open, announcing it
 *  to the page before and after. */
export function walletPrompt<T>(
  label: string,
  index: number,
  count: number,
  fn: () => Promise<T>,
): Promise<T> {
  const run = chain.then(async () => {
    emit({ state: "open", label, index, count });
    try {
      const out = await fn();
      emit({ state: "closed", label, index, count });
      return out;
    } catch (e: any) {
      emit({ state: "closed", label, index, count, error: e?.shortMessage || e?.message || String(e) });
      throw e;
    }
  });
  // keep the chain alive past a rejection
  chain = run.catch(() => undefined);
  return run;
}
