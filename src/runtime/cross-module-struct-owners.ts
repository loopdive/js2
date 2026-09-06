// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// cross-module-struct-owners.ts — (#5225) the INBOUND twin of #5222.
//
// #5222 fixed the EXIT boundary of the #2527 linked-provider seam: a value the
// PROVIDER minted keeps the host mirror bound to the provider's exports, so the
// consumer can still decode it. This file answers the other direction.
//
// A raw WasmGC struct carries no decoder. Everything that reads one —
// `__struct_field_names`, `__sget_<field>`, `__call_fn_*` — is an EXPORT of one
// specific module, and every runtime read path resolves those exports from the
// module it is currently running inside (`callbackState.getExports()`). That is
// correct for a single module and wrong the moment two linked modules exchange
// values: an object literal built in the CONSUMER and handed to a provider
// function reaches the provider's `__extern_get` with the provider's exports,
// which cannot name a single one of its fields. It reads as an opaque object
// with zero members (`Temporal.PlainDate.from({year, month, day})` →
// "year is required").
//
// The registry below records every module of one linked project and answers
// "who can decode this value?". It is deliberately a MISS-PATH mechanism: the
// callers consult it only after the local exports have already failed to name
// the struct or to serve the field, so the single-module lane and the linked
// hot path (`__extern_get` runs ~10k times per `run()` on mixed/csv-parse,
// #3903) are byte-identical to before. With fewer than two modules registered
// the whole thing short-circuits on one boolean.

/**
 * Registry of the modules taking part in one linked project, and a cache of
 * which of them owns (can decode) a given compiled struct.
 */
export function createCrossModuleStructOwners(canBeWeakKey: (value: unknown) => boolean) {
  const modules = new Set<Record<string, Function>>();
  const owners = new WeakMap<object, Record<string, Function>>();
  const states = new WeakMap<Record<string, Function>, { getExports: () => Record<string, Function> }>();
  // Sentinel for "nothing in this project can name it" (closures, vecs, plain
  // host objects). Caching the NEGATIVE is load-bearing, not tidiness: without
  // it every host-object read in a linked project re-probes every module's
  // `__struct_field_names` — two Wasm calls on the `__extern_get` hot path
  // (#3903, ~10k per `run()`).
  const NONE: Record<string, Function> = Object.create(null);
  // Fast opt-out: one module (or none) means every value is already local.
  let enabled = false;

  /**
   * Whether `exports` can name this struct's fields. `__struct_field_names` is
   * a `ref.test` ladder that answers "" for a type the module does not know, so
   * probing a foreign module's helper is safe — it cannot trap.
   */
  const decodes = (exports: Record<string, Function>, obj: object): boolean => {
    const fn = exports.__struct_field_names;
    if (typeof fn !== "function") return false;
    try {
      const csv = fn(obj);
      return typeof csv === "string" && csv !== "";
    } catch {
      return false;
    }
  };

  return {
    registerModule(exports: Record<string, Function> | undefined): void {
      if (exports === undefined || !canBeWeakKey(exports) || modules.has(exports)) return;
      modules.add(exports);
      enabled = modules.size > 1;
    },

    /**
     * The exports that own `obj` when `local` does NOT — `undefined` when
     * `local` is already the right decoder, when nothing in the project can
     * decode `obj` (closures, vecs and other unnamed shapes answer "" in their
     * own module too), or when no linked project is live.
     */
    decoderFor(obj: unknown, local: Record<string, Function> | undefined): Record<string, Function> | undefined {
      if (!enabled || !canBeWeakKey(obj)) return undefined;
      const cached = owners.get(obj as object);
      if (cached !== undefined) return cached === local || cached === NONE ? undefined : cached;
      if (local !== undefined && decodes(local, obj as object)) {
        owners.set(obj as object, local);
        return undefined;
      }
      for (const peer of modules) {
        if (peer === local) continue;
        if (decodes(peer, obj as object)) {
          owners.set(obj as object, peer);
          return peer;
        }
      }
      owners.set(obj as object, NONE);
      return undefined;
    },

    /**
     * (#5364) Forget every module of the project that just finished.
     *
     * The registry is MODULE-LEVEL state, so a process that instantiates a
     * second linked project against the SAME provider binary (the compile-once
     * Temporal provider, re-instantiated once per test262 row in a long-lived
     * fork) would otherwise still hold project 1's exports. Those exports share
     * canonical WasmGC types with project 2's, so `decodes` answers TRUE for a
     * struct project 1 never minted and `decoderFor` hands back the wrong
     * module — a complete, internally consistent, WRONG mirror.
     *
     * `owners` and `states` are deliberately NOT cleared: both are WeakMaps
     * keyed on the per-instance objects of the project being dropped, so they
     * become unreachable with it. Clearing `modules` is what actually retires
     * the project, and dropping `enabled` back to false restores the
     * single-module fast path byte-for-byte until the next project registers
     * two modules.
     */
    reset(): void {
      modules.clear();
      enabled = false;
    },

    /**
     * A `callbackState` view of a foreign module's exports, so a read path that
     * threads state (rather than exports) can be redirected with one
     * substitution. One allocation per module, not per call.
     */
    stateFor(exports: Record<string, Function>): { getExports: () => Record<string, Function> } {
      let state = states.get(exports);
      if (state === undefined) {
        state = { getExports: () => exports };
        states.set(exports, state);
      }
      return state;
    },
  };
}
