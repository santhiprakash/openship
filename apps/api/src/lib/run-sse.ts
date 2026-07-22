/**
 * Shared run-progress SSE plumbing for the FSM-style features (backup runs,
 * restores, docker migrations). Each feature keeps its own event union + DB
 * row; this module owns the two things they were copy-pasting:
 *
 *   createRunBus  — a per-id EventEmitter topic that flushes + closes when a
 *                   terminal event is published.
 *   streamRunSSE  — the connect handler: emit a snapshot, short-circuit if the
 *                   run already finished, else stream live events until a
 *                   terminal one. Mirrors the deployment session-manager pattern.
 *
 * The DB row remains the source of truth; SSE only amplifies it, so a client
 * that (re)connects after the run finished still gets the terminal snapshot.
 */

import { EventEmitter } from "node:events";
import type { Context } from "hono";
import { streamSSE } from "./sse";

export interface RunBus<E> {
  /** Emit to every subscriber; close the channel after a terminal event. */
  publish(id: string, event: E): void;
  /** Attach a listener; returns an unsubscribe fn. */
  subscribe(id: string, listener: (event: E) => void): () => void;
}

/**
 * A per-id event topic. `isFinal` decides when the channel closes — after a
 * terminal event, listeners are removed on the next tick (so pending writes
 * flush first). `maxListeners` allows for multiple dashboard tabs on one run.
 */
export function createRunBus<E>(
  isFinal: (event: E) => boolean,
  maxListeners = 32,
): RunBus<E> {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(maxListeners);
  return {
    publish(id, event) {
      emitter.emit(id, event);
      if (isFinal(event)) {
        setImmediate(() => emitter.removeAllListeners(id));
      }
    },
    subscribe(id, listener) {
      const wrapped = (event: E) => listener(event);
      emitter.on(id, wrapped);
      return () => emitter.off(id, wrapped);
    },
  };
}

/**
 * Stream a run channel over SSE. `E` must carry a `type` (used as the SSE event
 * name). The caller builds the snapshot event, and — when the run is already
 * terminal at connect time — a `terminalComplete` event to send before closing.
 */
export function streamRunSSE<E extends { type: string }>(
  c: Context,
  opts: {
    bus: RunBus<E>;
    id: string;
    snapshot: E;
    /** Non-null when the run has already finished — sent, then the stream closes. */
    terminalComplete: E | null;
    /** True when a live event ends the stream (typically the "complete" event). */
    isFinalEvent: (event: E) => boolean;
  },
): ReturnType<typeof streamSSE> {
  const { bus, id, snapshot, terminalComplete, isFinalEvent } = opts;
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: snapshot.type, data: JSON.stringify(snapshot) });

    if (terminalComplete) {
      await stream.writeSSE({
        event: terminalComplete.type,
        data: JSON.stringify(terminalComplete),
      });
      return;
    }

    const events: E[] = [];
    let waiter: (() => void) | null = null;
    const unsubscribe = bus.subscribe(id, (ev) => {
      events.push(ev);
      waiter?.();
    });

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      unsubscribe();
      waiter?.();
    });

    try {
      while (!aborted) {
        if (events.length === 0) {
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
          waiter = null;
        }
        const drained = events.splice(0, events.length);
        let terminal = false;
        for (const ev of drained) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          if (isFinalEvent(ev)) terminal = true;
        }
        if (terminal) break;
      }
    } finally {
      unsubscribe();
    }
  });
}
