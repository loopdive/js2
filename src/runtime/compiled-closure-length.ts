// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5365) §10.2.4 `length` of a COMPILED CLOSURE read as a first-class value in
// JS-host (`gc`) mode.
//
// A closure read at its own declaration site answers `.length` from a static
// fold, so `f.length` was always right. The moment the same closure crosses a
// CALL boundary as a value — `function viaParam(x) { return x.length; }` — the
// receiver is an opaque WasmGC carrier and the read lowers to
// `__extern_get(carrier, "length")`, which had no answer for a closure at all.
//
// What came back depended on the rest of the module. A closure struct has no
// field-name registry, so `_structOwnFieldStatus` answers `undefined` ("unknown
// shape") and `wsh.readField` probes a `__sget_length` getter anyway. That
// getter exists in almost every real module — minted for the unrelated vec
// shape whose struct really does have a `length` field — it cast-succeeds on
// the closure, and it reads back its miss-default **0**. That is the #1629
// anti-pattern (`_readOwnDescriptor` carries the same warning for the same
// getter), reached through the one receiver nobody had a positive
// discriminator for. In a module with no vec there is no getter to probe and
// the read answered **undefined** instead. Both are wrong; the `0` is the one
// that is silent, and it is the one every package hits.
//
// The carrier does hold the number: every struct in the funcref-wrapper
// hierarchy stores its declared formal count in the `$arity` header slot
// (#3673), and the module already exports `__closure_arity(externref) -> i32`
// for it (`src/codegen/closure-exports.ts`), answering `-1` for anything that is
// not a registered closure. So this is a read of an export that already exists:
// no new codegen, no new struct field, no module-size delta.
//
// Measured (hono `src/helper/dev/index.test.ts`): route classification is
// `const isMiddleware = (handler) => handler.length > 1`, and every handler
// reaches `inspectRoutes` through `#addRoute(method, path, handler)` — across
// exactly this boundary — so every route was labelled `[handler]`.
//
// SCOPE — this is the DECLARED formal count. A REST parameter is already
// excluded from `$arity` (`(a, ...rest) => a` answers 1, the spec value), but a
// DEFAULTED parameter is not (`(a, b = 1) => a` answers 2 where §15.1.5 gives
// 1). `$arity` cannot be re-pointed at the spec value: `closure-exports.ts`
// widens an under-applied dispatch to `max(n, $arity)` and would stop padding
// omitted arguments (#4436 R2 records exactly this). Closing the defaulted-
// parameter divergence in host mode needs the per-declaration
// `$__fn_instance_meta` carrier (#4437), which is standalone-only today. The
// declared count is closer to the spec value than the `0` it replaces for every
// shape, and exact for every shape without a defaulted parameter.

/**
 * `length` for a compiled-closure receiver, or `undefined` when this is not
 * that read (the caller then keeps its own answer).
 *
 * `ownFieldStatus` is the caller's `_structOwnFieldStatus` verdict for `key`:
 * `true` means the struct GENUINELY owns a field of that name, and the field
 * read wins. Callers must also have consulted the sidecar, the descriptor
 * table and the delete tombstone first, so an explicit `f.length = 5`, a
 * `defineProperty`, or a `delete f.length` still outranks the declaration.
 */
export function compiledClosureLength(
  obj: unknown,
  key: unknown,
  ownFieldStatus: boolean | undefined,
  exports: Record<string, Function> | undefined,
): number | undefined {
  if (key !== "length" || ownFieldStatus === true) return undefined;
  const closureArity = exports?.__closure_arity as ((value: unknown) => number) | undefined;
  if (typeof closureArity !== "function") return undefined;
  let arity: number;
  try {
    arity = closureArity(obj);
  } catch {
    // Missing/stale bridge export, or a carrier minted by another module —
    // keep the caller's existing fallback rather than guessing.
    return undefined;
  }
  return typeof arity === "number" && arity >= 0 ? arity : undefined;
}
