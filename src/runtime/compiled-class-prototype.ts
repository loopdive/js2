// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5347) `[[Prototype]]` of a WasmGC carrier that represents a COMPILED CLASS
// INSTANCE — the residual #5325 declined.
//
// #5325 gave the host `__getPrototypeOf` import real answers for the built-in
// carriers (Date / Array / closure) and stopped exactly here, because nothing
// the module exported could separate `new C()` from `C.prototype`: both are
// `$ClassName` structs, and `__is_data_struct` says 1 for each. So both fell to
// the ordinary-object default, `%Object.prototype%`.
//
// That default is not merely imprecise, it inverts a widely-used predicate.
// redux 5's `isPlainObject` walks the chain to its terminal and compares:
//
//   let proto = obj;
//   while (getPrototypeOf(proto) !== null) proto = getPrototypeOf(proto);
//   return getPrototypeOf(obj) === proto || getPrototypeOf(obj) === null;
//
// With `getPrototypeOf(new C())` answering `%Object.prototype%`, the walk's
// terminal IS that same object, so `isPlainObject(new C())` answered TRUE and
// `isAction(new Action())` — whose whole point is to reject a class instance —
// answered true with it.
//
// The missing half is codegen-side: `__class_instance_proto`
// (src/codegen/class-instance-proto.ts) is a `ref.test` cascade over the
// module's own class-struct set that answers the class's prototype carrier for
// a genuine instance, materializing the lazily-initialised singleton if no
// `C.prototype` read has yet. It returns null — "no answer, keep your
// fallback" — for the two other `$ClassName`-typed values, the prototype
// singleton itself and the class-object singleton, so both keep the caller's
// existing `%Object.prototype%` answer.
//
// The returned value is the RAW struct, deliberately not a `_wrapForHost`
// proxy: compiled code reading `C.prototype` gets that same externref, so
// `Object.getPrototypeOf(new C()) === C.prototype` has to hold by `===` across
// the two lanes. (`_classObjectPrototypeStruct` returns the raw struct for the
// same reason.)
//
// DELIBERATELY NOT ANSWERED — measured, recorded in the issue, unchanged here:
//
//   - `getPrototypeOf(<Derived>.prototype)` still answers `%Object.prototype%`
//     rather than `Base.prototype` (§15.7.14 step 6). The prototype singleton
//     declines above, so the parent link is a separate change. It does not
//     affect the walk's OUTCOME for an instance: the chain still terminates at
//     `%Object.prototype%`, which is still not `Derived.prototype`.
//   - a class whose instances are host objects (`class C extends Array`) — its
//     instances never reach the host as a WasmGC struct at all, so this query
//     is not the one they take.

/**
 * The prototype carrier of the compiled class that minted `obj`, or `undefined`
 * when `obj` is not a compiled class instance (the caller then keeps its own
 * fallback).
 *
 * Callers must consult the explicit `setPrototypeOf` link, the `Object.create`
 * record and the fnctor instance→ctor link FIRST: a receiver that already has a
 * user-visible prototype is not answered here. `__class_instance_proto` is
 * emitted only by JS-host-mode modules that reach the `__getPrototypeOf`
 * import, so its absence is the ordinary case and must stay silent.
 */
export function compiledClassInstancePrototype(
  obj: unknown,
  exports: Record<string, Function> | undefined,
): unknown | undefined {
  const classInstanceProto = exports?.__class_instance_proto as ((value: unknown) => unknown) | undefined;
  if (typeof classInstanceProto !== "function") return undefined;
  try {
    const proto = classInstanceProto(obj);
    return proto == null ? undefined : proto;
  } catch {
    // Missing/stale bridge export — retain the caller's fallback.
    return undefined;
  }
}
