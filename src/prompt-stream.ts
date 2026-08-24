// Long-lived streaming-input prompt channel for query().
//
// The Agent SDK accepts `prompt: AsyncIterable<SDKUserMessage>` and pumps it
// to the CLI's stdin. Parking that iterable for the life of the query lets a
// later turn push a follow-up user message into the same Claude Code
// subprocess — the session is never interrupted at tool boundaries, so the
// resumed model never sees the "[Request interrupted by user]" marker that
// used to trigger the "no prior work ... interrupted" stub.
//
// Design follows pi-claude-bridge's PromptStream: push() resolves only after
// the SDK's pump has written the message to stdin (the yield boundary proves
// the write completed), so callers can order a steer before a tool result on
// the same FIFO.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PromptStream {
  stream: AsyncGenerator<SDKUserMessage>;
  /** Enqueue a message; resolves once the SDK has written it to stdin.
   *  Rejects (never hangs) if the stream is already ended or failed. */
  push: (msg: SDKUserMessage) => Promise<void>;
  /** Close the input: the generator returns, the SDK closes the CLI's stdin. */
  end: () => void;
  /** Abandon the input, rejecting every queued and in-flight ack. */
  fail: (error: Error) => void;
}

export function makePromptStream(): PromptStream {
  type Item = { msg: SDKUserMessage; resolve: () => void; reject: (e: Error) => void };
  const queue: Item[] = [];
  // The item currently parked at `yield`. Tracked separately so fail() can
  // settle it — a dying CLI may abandon the pump without ever resuming us,
  // and an unsettled ack would wedge tool-result delivery forever.
  let inflight: Item | null = null;
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const kick = () => {
    wake?.();
    wake = null;
  };

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done && !failure) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (failure) throw failure;
        const item = queue.shift();
        if (!item) return; // ended and drained
        inflight = item;
        try {
          yield item.msg;
          item.resolve();
        } finally {
          // Reached either normally (no-op, already resolved) or when the
          // pump abandons iteration — a `for await` break/throw calls
          // gen.return(), which resumes the yield as a return.
          inflight = null;
        }
      }
    } finally {
      done = true;
      kick();
    }
  }

  return {
    stream: gen(),
    push: (msg) =>
      failure || done
        ? Promise.reject(failure ?? new Error("prompt stream ended"))
        : new Promise<void>((resolve, reject) => {
            queue.push({ msg, resolve, reject });
            kick();
          }),
    end: () => {
      done = true;
      kick();
    },
    fail: (error) => {
      failure = error;
      inflight?.reject(error);
      inflight = null;
      for (const item of queue.splice(0)) item.reject(error);
      kick();
    },
  };
}
