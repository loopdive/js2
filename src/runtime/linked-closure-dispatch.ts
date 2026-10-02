// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// linked-closure-dispatch.ts — (#6757) route a compiled closure to the module
// that can actually call it, inside a linked project (#3451 harness provider,
// #2527 package linker).
//
// A closure the host holds is invoked through a bridge that calls one module's
// `__call_fn_N` / `__call_fn_method_N` dispatcher. Those dispatchers match a
// closure by its exact function type, so they know only the closures of their
// own module. A closure that belongs to ANOTHER module of the same project can
// match no arm, and the dispatcher's #4618 terminal hands the callee back to
// the host as `__call_function_N(fn, …)` — the arm meant for a genuine host
// function. The host wraps it with the calling module's state, which yields
// the same bridge through the same dispatcher, and the round trip repeats until
// the stack overflows.
//
// Measured on the linked test262 lane: `built-ins/RegExp/named-groups/
// duplicate-names-matchall.js` passes its validators (`v => assert.compareArray
// (v, e)`, minted in the test body) to the harness provider's
// `assert.compareIterator`, which calls `validators[i](value)`. The bridge was
// bound to the PROVIDER, the provider's `__call_fn_method_1` missed, and every
// run ended in `RangeError: Maximum call stack size exceeded`.
//
// Not every fallback is that loop. A re-entered bridge can pick a DIFFERENT
// dispatcher (another arity, the free-call family instead of the method one)
// and succeed — `for-of/typedarray-backed-by-resizable-buffer-shrink-to-zero-
// mid-iteration.js` depends on exactly that. So the detection has two halves:
//
// 1. The host `__call_function_N` import reports a call of the closure the
//    innermost bridge is dispatching, from the module doing the dispatch, with
//    the receiver it dispatched on (`noteFallback`). That is the dispatcher's
//    terminal giving the closure back; it proceeds as before.
// 2. When the re-entered bridge is about to call the SAME dispatcher export of
//    the SAME module for that closure (`isRepeat`), the arms it would test are
//    the ones that just missed — a loop by construction. The outer dispatch is
//    marked missed and unwinds; the bridge then retries through the other
//    modules of the project and remembers the one that ran the closure.
//
// With no linked project live no frame is ever pushed, so both halves answer
// immediately and callers take exactly the old path.

type Exports = Record<string, Function>;
type PeerRegistry = {
  peersOf(local: Exports | undefined): Exports[];
  stateFor(exports: Exports): { getExports: () => Exports };
};
type WrapClosure = (
  closure: any,
  state: { getExports: () => Exports },
  rawDispatch: boolean,
  linkedPeer: boolean,
) => Function | null;

// Captured at load: a test may replace `Reflect.apply` long before a bridge runs.
const reflectApply = Reflect.apply;
const reflectConstruct = Reflect.construct;

interface DispatchFrame {
  closure: object;
  exports: Exports;
  route: string | undefined;
  receiver: unknown;
  fallback: boolean;
  missed: boolean;
}

// Export names every module with a closure dispatcher carries. Two export views
// of one instance (the init-time funcref snapshot and the post-instantiation
// exports object) are different containers holding the SAME function objects,
// so modules are compared by function identity, never by the container.
const MODULE_IDENTITY_EXPORTS = ["__closure_arity", "__is_closure", "__call_fn_0", "__call_fn_1"] as const;

function sameModule(a: Exports, b: Exports | undefined): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  for (const name of MODULE_IDENTITY_EXPORTS) {
    const fa = a[name];
    const fb = b[name];
    if (typeof fa === "function" && typeof fb === "function") return fa === fb;
  }
  return false;
}

/** A dispatcher terminal passes `null` where a free call has no receiver. */
function sameReceiver(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}

export interface LinkedClosureDispatch {
  /** Called by the host `__call_function_N` import with the raw callee, before it wraps it. */
  noteFallback(fn: unknown, thisArg: unknown, exports: Exports | undefined): void;
  /**
   * Called by a bridge right before it calls dispatcher export `route` of
   * `exports` for `closure`. True means the enclosing dispatch of this closure
   * fell back to the host from that same export: the caller must return
   * without calling it (the enclosing dispatch is marked missed and retried).
   */
  isRepeat(closure: object, exports: Exports, route: string, receiver: unknown): boolean;
  /**
   * Run `through(module)` for `local` (or the module already known to own
   * `closure`) and then each peer, until one dispatch is not marked missed.
   * Throws a TypeError when no module of the project can call the closure.
   */
  invoke(closure: object, local: Exports, peers: readonly Exports[], through: (exports: Exports) => unknown): unknown;
  /** The bridge that dispatches `closure` through `exports`, built once by `make`. */
  bridgeFor(closure: object, exports: Exports, make: () => Function | null): Function | null;
  /** Wire this runtime copy's #5225 registry and its dynamic-bridge factory (once, at load). */
  configure(registry: PeerRegistry, wrap: WrapClosure): void;
  /**
   * What a dynamic bridge applies: `dispatch` itself, or — while a linked
   * project is live — a wrapper that runs `dispatch` through {@link invoke}.
   */
  routed(closure: unknown, local: Exports, dispatch: Function, rawDispatch: boolean): Function;
}

export function createLinkedClosureDispatch(): LinkedClosureDispatch {
  const frames: DispatchFrame[] = [];
  const owners = new WeakMap<object, Exports>();
  const bridges = new WeakMap<object, Map<Exports, Function | null>>();
  let registry: PeerRegistry | undefined;
  let wrap: WrapClosure | undefined;

  const api: LinkedClosureDispatch = {
    configure(peerRegistry, wrapClosure) {
      registry = peerRegistry;
      wrap = wrapClosure;
    },

    routed(closure, local, dispatch, rawDispatch) {
      if (registry === undefined || wrap === undefined || closure == null || typeof closure !== "object")
        return dispatch;
      const peers = registry.peersOf(local);
      if (peers.length === 0) return dispatch;
      const peerBridge = (via: Exports) =>
        api.bridgeFor(closure, via, () => wrap!(closure, registry!.stateFor(via), rawDispatch, true)) ?? dispatch;
      return function linkedClosureRoute(this: unknown, ...args: unknown[]): unknown {
        const newTarget = new.target;
        return api.invoke(closure, local, peers, (via) => {
          const fn = via === local ? dispatch : peerBridge(via);
          return newTarget === undefined ? reflectApply(fn, this, args) : reflectConstruct(fn, args, newTarget);
        });
      };
    },

    noteFallback(fn, thisArg, exports) {
      const top = frames[frames.length - 1];
      if (top === undefined || top.closure !== fn || top.route === undefined) return;
      if (sameModule(top.exports, exports) && sameReceiver(top.receiver, thisArg)) top.fallback = true;
    },

    isRepeat(closure, exports, route, receiver) {
      const current = frames[frames.length - 1];
      if (current === undefined || current.closure !== closure || !sameModule(current.exports, exports)) return false;
      const outer = frames[frames.length - 2];
      if (outer !== undefined && outer.fallback && outer.closure === closure && outer.route === route) {
        if (sameModule(outer.exports, exports)) {
          outer.missed = true;
          return true;
        }
      }
      current.route = route;
      current.receiver = receiver;
      return false;
    },

    invoke(closure, local, peers, through) {
      const known = owners.get(closure);
      const order: Exports[] = [local, ...peers];
      if (known !== undefined && known !== local && peers.includes(known)) {
        order.splice(order.indexOf(known), 1);
        order.unshift(known);
      }
      for (const exports of order) {
        const frame: DispatchFrame = {
          closure,
          exports,
          route: undefined,
          receiver: undefined,
          fallback: false,
          missed: false,
        };
        frames.push(frame);
        let result: unknown;
        try {
          result = through(exports);
        } finally {
          frames.pop();
        }
        if (!frame.missed) {
          if (exports !== local) owners.set(closure, exports);
          return result;
        }
      }
      throw new TypeError("compiled function is not callable by any module of this linked project");
    },

    bridgeFor(closure, exports, make) {
      let perModule = bridges.get(closure);
      if (perModule === undefined) bridges.set(closure, (perModule = new Map()));
      if (!perModule.has(exports)) perModule.set(exports, make());
      return perModule.get(exports) ?? null;
    },
  };
  return api;
}

/** The dispatcher this runtime copy's bridges and host-call imports share. */
export const linkedClosureDispatch = createLinkedClosureDispatch();
