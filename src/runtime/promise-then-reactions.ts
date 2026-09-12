// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5372) Host `Promise.prototype.then` reaction imports for the JS-host lane.
//
// `Promise_then(p, cb)` / `Promise_then2(p, cb1, cb2)` register wasm reactions
// (arity-1, #1382) through the resolver's reaction wrapper (`_wrapPromiseReaction`
// in runtime.ts: marshals the callback and re-wraps a wasm thenable result).
//
// `Promise_then2_frame(p, cb1, cb2, resultPromise)` is the async resume
// machine's variant (async-frame.ts, `ensureAsyncResumeFunction`): a wasm TRAP
// raised while a driven state resumes (`ref.cast` failure, `unreachable`) is
// uncatchable by `catch_all`, so it used to escape the reaction as a rejection
// of the DROPPED derivative promise — an unhandled rejection that kills the
// host process (marked `Hooks.test.js` read 0/30 once the pre-existing #5345
// `illegal cast` became reachable inside a driven resume). The frame variant
// catches it and rejects the frame's own result promise instead, which is what
// the caller of the former synchronous pass-through observed: a thrown error.

/** A reaction as `Promise.prototype.then` accepts it. */
type Reaction = ((value: unknown) => unknown) | null | undefined;

/** The frame's result promise as `Promise_new_pending` shapes it (`__j` = its reject capability). */
interface FramePromise {
  readonly __j?: (reason: unknown) => void;
}

/** The resolver's reaction wrapper: marshals a wasm callback; non-callables pass through. */
export type PromiseReactionWrapper = (cb: unknown) => unknown;

/** Resolve one of the three `then` reaction imports by name. */
export function createPromiseThenImport(name: string, wrap: PromiseReactionWrapper): Function {
  if (name === "Promise_then") return (p: Promise<unknown>, cb: unknown) => p.then(wrap(cb) as Reaction);
  if (name === "Promise_then2") {
    return (p: Promise<unknown>, cb1: unknown, cb2: unknown) => p.then(wrap(cb1) as Reaction, wrap(cb2) as Reaction);
  }
  return (p: Promise<unknown>, cb1: unknown, cb2: unknown, rp: FramePromise | null | undefined) => {
    const guard = (cb: unknown): Reaction => {
      const reaction = wrap(cb);
      if (typeof reaction !== "function") return reaction as Reaction;
      return (value: unknown) => {
        try {
          return reaction(value);
        } catch (error) {
          if (rp && typeof rp.__j === "function") return rp.__j(error);
          throw error;
        }
      };
    };
    return p.then(guard(cb1), guard(cb2));
  };
}
