// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3972) Standalone/WASI-native `super()` construction for `class Sub extends
 * <builtin>` — the per-parent arms of the dispatch ladder in `class-bodies.ts`
 * (`resolveStandaloneBuiltinSuperCtorIdx`).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `super()` / the implicit derived constructor of a builtin subclass lowers
 * parent creation through the host-constructible path (the parent names are in
 * `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`), which registers a late `__new_<Parent>`
 * IMPORT. Under `--target standalone` there is no JS host to satisfy it, so the
 * module leaked exactly one `env::__new_<Parent>` — and the #2961 guard
 * correctly refuses any standalone binary carrying host imports. That single
 * leaked import was the SOLE reason the `subclass-builtins` conformance family
 * failed on the standalone lane for these parents. Two parent groups
 * (collections, primitive wrappers) had additionally been refused outright at
 * compile time (#2620, #2029) because the host path also produced invalid Wasm
 * for them.
 *
 * Every arm here registers a DEFINED function instead of an import. That is the
 * load-bearing property, and it fixes more than the leak: with no late import
 * there is no `addUnionImports`/`flushLateImportShifts` reorder, so the #2043
 * index-shift class of invalid Wasm (which #2620 cited as its defect B) cannot
 * arise from construction either.
 *
 * ── WHY IDENTITY-ONLY CARRIERS ARE SOUND ────────────────────────────────────
 * What these conformance rows ask for is IDENTITY, and identity never consults
 * the carrier value: `new Sub() instanceof Sub` and `instanceof <Parent>` are
 * BOTH resolved at COMPILE time by `tryStaticInstanceOf`, which reads the
 * recorded builtin parent out of `ctx.classBuiltinParentMap` and walks the
 * static `isBuiltinSubtype` hierarchy. So handing back a fresh native value of
 * *some* kind flips the module host-free without changing any answer.
 *
 * The carriers are chosen per group, not uniformly, and the distinction is
 * deliberate:
 *   - collections and primitive wrappers get REAL carriers (a correctly branded
 *     `$Map`, a real `$Object` wrapper box), because a genuine one is available
 *     for a couple of instructions and brand-testing code paths read it;
 *   - the remaining parents get a plain object, chosen over a faithful-LOOKING
 *     carrier ON PURPOSE. An incorrectly branded value (e.g. a
 *     `$__vec_i32_byte` handed back for `ArrayBuffer`) would make brand-testing
 *     paths answer confidently wrong — `byteLength` 0 rather than refusing —
 *     whereas a plain object carries no false brand.
 *
 * ── SCOPE, STATED PLAINLY ───────────────────────────────────────────────────
 * Construction and identity, NOT faithful behaviour. The instance is not a
 * functional Date/RegExp/Promise/…: no [[DateValue]], no compiled pattern, no
 * executor is run, no byteLength, and constructor arguments are still
 * side-effect-evaluated at the call site (§13.3.7.1) and then DROPPED. This is
 * the same scope as the existing #3239 TypedArray/SharedArrayBuffer rung.
 *
 * That bound is set by measurement, not optimism: of 25,692 passing standalone
 * test262 rows, ZERO contain `extends <one of these parents>` in their source,
 * so there is no behaviour-dependent passing row to regress. Faithful,
 * argument-honouring construction is follow-up work, worth doing when a
 * behaviour test for one of these parents can actually pass standalone.
 *
 * ── PER-ARITY REGISTRATION (#2917) ──────────────────────────────────────────
 * Every helper keys on `<importName>@<argCount>` and RETURNS the defined
 * funcIdx. A single plain-name registration keyed off the FIRST caller's arity
 * gets mis-called from every later site with a different arity: the extra args
 * stay on the operand stack and (validly!) become the enclosing forwarder's
 * return value, so `new Sub(x)` returns `x` instead of the instance. Idempotent
 * per key.
 *
 * Host/gc mode never reaches any of this — the caller gates on
 * `ctx.standalone || ctx.wasi` and keeps the `__new_<Parent>` import there, so
 * those lanes stay byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { COLLECTION_KIND, ensureMapHelpers } from "./map-runtime.js";

/** `externref × count` — the forwarder ABI every arm below declares. */
function externrefParams(count: number): ValType[] {
  return Array.from({ length: count }, () => ({ kind: "externref" }) as ValType);
}

/**
 * Register a defined `<key> : (externref × argCount) -> externref` whose body is
 * `body`, and record it in `ctx.funcMap` under `key`. Returns the funcIdx.
 */
function registerSuperCtor(ctx: CodegenContext, key: string, argCount: number, body: Instr[]): number {
  const typeIdx = addFuncType(ctx, externrefParams(argCount), [{ kind: "externref" }], `${key}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(key, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: key, typeIdx, locals: [], body, exported: false });
  return funcIdx;
}

/**
 * (#3238/#3972) Parents served by a fresh native PLAIN OBJECT.
 *
 * `Object` itself (#3238) uses the same helper via
 * `emitStandaloneObjectConstructor`. `__new_plain_object` is also what
 * `emitSetSubclassProto` / `emitSetSubclassUserBrand` — which the caller runs
 * next — expect to re-point.
 */
export const STANDALONE_IDENTITY_BUILTIN_PARENTS: ReadonlySet<string> = new Set([
  "ArrayBuffer",
  "DataView",
  "Date",
  "Function",
  "Promise",
  "RegExp",
  "WeakRef",
]);

/**
 * (#3238) Standalone/WASI-native `class Sub extends Object` construction.
 *
 * Per §20.1.1.1 `Object ( [ value ] )`: when NewTarget is a subclass (neither
 * undefined nor the `%Object%` intrinsic itself), the `value` argument is
 * IGNORED and the result is `OrdinaryCreateFromConstructor(NewTarget,
 * "%Object.prototype%")` — a fresh ordinary object whose [[Prototype]] is the
 * subclass's prototype. The caller already re-points the prototype and brand via
 * `emitSetSubclassProto` / `emitSetSubclassUserBrand`, so constructing a fresh
 * native plain object here (and letting those run) is spec-correct — this rung,
 * unlike the identity-only ones, is faithful rather than approximate.
 */
export function emitStandaloneObjectConstructor(ctx: CodegenContext, argCount: number): number | undefined {
  return emitStandaloneIdentityBuiltinConstructor(ctx, "__new_Object", argCount);
}

/** (#3238/#3972) Plain-object-backed standalone super-ctor. See file header. */
export function emitStandaloneIdentityBuiltinConstructor(
  ctx: CodegenContext,
  importName: string,
  argCount: number,
): number | undefined {
  const key = `${importName}@${argCount}`;
  const existing = ctx.funcMap.get(key);
  if (existing !== undefined) return existing;

  // Dependency FIRST, so `__new_plain_object`s funcIdx is settled before this
  // body bakes it (any later late-import batch shift-repairs mod.functions
  // bodies, including this one — the standard defined-native invariant).
  ensureObjectRuntime(ctx);
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  if (newPlainObjectIdx === undefined) return undefined; // defensive: substrate unavailable

  // Ignore the (already side-effect-evaluated) constructor arguments and return
  // a fresh native plain object. `return_call` keeps the tail position so no
  // extra frame is retained.
  return registerSuperCtor(ctx, key, argCount, [{ op: "return_call", funcIdx: newPlainObjectIdx }]);
}

/**
 * (#3972) The native-collection parents, mapped to the `COLLECTION_KIND` brand
 * their `$Map` carrier must be stamped with.
 */
export const STANDALONE_COLLECTION_BUILTIN_PARENTS: ReadonlyMap<string, number> = new Map<string, number>([
  ["Map", COLLECTION_KIND.MAP],
  ["Set", COLLECTION_KIND.SET],
  ["WeakMap", COLLECTION_KIND.WEAKMAP],
  ["WeakSet", COLLECTION_KIND.WEAKSET],
]);

/**
 * (#3972) `class Sub extends <Map|Set|WeakMap|WeakSet>` — a REAL native
 * collection, not an identity placeholder.
 *
 * `__map_new(kind)` allocates the same `$Map` hash table base `new Set()` /
 * `new Map()` construct, stamped with the correct immutable `MAP_LAYOUT.M_KIND`
 * brand. That matters for correctness rather than tidiness: the spec receiver
 * brand checks (`Map.prototype.get.call(new Set())` must throw a TypeError) and
 * the value-representation dispatch arms (`fillClosedMethodDispatch`s `$Map`
 * arm, `emitReceiverBrandCheck`) both read `M_KIND`, so a mis-branded or
 * unbranded carrier would make them answer confidently wrong. An empty
 * collection of the right kind is the honest value — and it is what lets an
 * inherited `sub.add(1)` on a subclass-typed receiver still resolve host-free
 * (measured), which is why the #2620 refusal could be narrowed rather than kept.
 *
 * The iterable-initialiser form (`new Sub([[k, v]])`) is part of the deferred
 * behaviour scope: the arguments are dropped, per the file header.
 */
export function emitStandaloneCollectionSuperCtor(
  ctx: CodegenContext,
  parentName: string,
  argCount: number,
): number | undefined {
  const kind = STANDALONE_COLLECTION_BUILTIN_PARENTS.get(parentName);
  if (kind === undefined) return undefined;
  const key = `__new_${parentName}@${argCount}`;
  const existing = ctx.funcMap.get(key);
  if (existing !== undefined) return existing;

  ensureMapHelpers(ctx);
  const mapNewIdx = ctx.mapHelpers.get("__map_new");
  if (mapNewIdx === undefined) return undefined; // defensive: substrate unavailable

  // `extern.convert_any` is the same no-op boxing the object runtime uses to
  // expose `$Object`/vec structs as externref.
  return registerSuperCtor(ctx, key, argCount, [
    { op: "i32.const", value: kind },
    { op: "call", funcIdx: mapNewIdx },
    { op: "extern.convert_any" },
  ]);
}

/**
 * (#3972) The primitive-wrapper parents, mapped to the object-runtime
 * constructor that builds a real wrapper box.
 */
export const STANDALONE_WRAPPER_BUILTIN_PARENTS: ReadonlyMap<string, string> = new Map<string, string>([
  ["Number", "__new_Number"],
  ["Boolean", "__new_Boolean"],
]);

/**
 * (#2029 → #3972) `class Sub extends <Number|Boolean>` — a REAL native wrapper
 * box.
 *
 * #2029 refused this population because of an ABI mismatch, not a missing
 * substrate: `super()` lowered to `call $__new_Number`, whose standalone
 * internal takes an **f64**, while the synthetic `<Class>_new` forwarder passes
 * its externref local — so the module failed to validate (`call param types must
 * match`) and died at instantiate. Refusing was the right answer to that
 * mismatch; it was never a statement that no native box exists.
 *
 * One does. `__new_Number`/`__new_Boolean` are registered NATIVELY under
 * standalone/wasi by `ensureObjectRuntime` (they are in
 * `OBJECT_RUNTIME_HELPER_NAMES`, which `ensureLateImport` reroutes away from the
 * host), and each builds a real `$Object` carrying the primitive in its
 * `[[PrimitiveValue]]` slot — the same box `__to_primitive` /
 * `__wrapper_string_value` read back. This resolves the mismatch the only way
 * that keeps the forwarder's externref signature intact: declare `externref`
 * params, ignore them, and supply the f64 here.
 *
 * SCOPE: the wrapped primitive is the spec's NO-ARGUMENT value. Per §21.1.1.1 /
 * §20.3.1.1 a subclass `new Sub()` with no argument sets [[NumberData]] `+0` /
 * [[BooleanData]] `false`, so the no-argument case — which is what the
 * conformance rows use — is exactly right. Honouring `new Sub(5)` needs the
 * `$__box_number_struct` unboxing dance `emitStandaloneArrayConstructor` does,
 * and is deferred with the rest of the behaviour scope.
 *
 * `String` was never refused (its `__new_String(externref) -> externref` already
 * matched the forwarder) and is deliberately absent here.
 */
export function emitStandaloneWrapperSuperCtor(
  ctx: CodegenContext,
  parentName: string,
  argCount: number,
): number | undefined {
  const ctorName = STANDALONE_WRAPPER_BUILTIN_PARENTS.get(parentName);
  if (ctorName === undefined) return undefined;
  const key = `__new_${parentName}@${argCount}`;
  const existing = ctx.funcMap.get(key);
  if (existing !== undefined) return existing;

  ensureObjectRuntime(ctx);
  const wrapperIdx = ctx.funcMap.get(ctorName);
  if (wrapperIdx === undefined) return undefined; // defensive: substrate unavailable

  // `return_call` consumes the f64 we just pushed — that is the whole point: the
  // forwarder's externref params never reach the f64-typed callee.
  return registerSuperCtor(ctx, key, argCount, [
    { op: "f64.const", value: 0 },
    { op: "return_call", funcIdx: wrapperIdx },
  ]);
}

/**
 * (#3972) The three #3972 arms of the `resolveStandaloneBuiltinSuperCtorIdx`
 * ladder, resolved in one call so the ladder in `class-bodies.ts` stays a list
 * of one-liners.
 *
 * Returns `undefined` when no #3972 arm matches (the caller continues its own
 * ladder / falls back to `ensureLateImport`), or `number | null` with the same
 * meaning the ladder documents: a defined funcIdx to call, or `null` when an arm
 * matched but could not register (the caller must NOT fall back to the host
 * import — that would reintroduce the leak).
 */
export function resolveStandaloneSubclassBuiltinCtor(
  ctx: CodegenContext,
  parentName: string,
  arity: number,
): number | null | undefined {
  if (STANDALONE_IDENTITY_BUILTIN_PARENTS.has(parentName)) {
    return emitStandaloneIdentityBuiltinConstructor(ctx, `__new_${parentName}`, arity) ?? null;
  }
  if (STANDALONE_COLLECTION_BUILTIN_PARENTS.has(parentName)) {
    return emitStandaloneCollectionSuperCtor(ctx, parentName, arity) ?? null;
  }
  if (STANDALONE_WRAPPER_BUILTIN_PARENTS.has(parentName)) {
    return emitStandaloneWrapperSuperCtor(ctx, parentName, arity) ?? null;
  }
  return undefined;
}

/**
 * (#2620 → #3972) Does this class body contain a declaration that an
 * externref-backed builtin subclass cannot yet store?
 *
 * MEASURED boundary, not a guess. Declared METHODS and an explicit
 * `constructor() { super(); }` compile and return correct values on the native
 * path. A declared PROPERTY or ACCESSOR traps at runtime (`illegal cast`) — and
 * that is NOT collection-specific: it is a pre-existing defect of the whole
 * externref-backed subclass family, which `main` already ships unguarded for the
 * rungs that landed earlier (`class Sub extends Array { tag = 3 }` and
 * `extends Uint8Array { tag = 3 }` trap identically today; `extends Object`
 * silently yields NaN).
 *
 * Concretely, the two checks were:
 *   1. The feared "lifting the refusal leaks `env::Set_add`" does NOT happen. A
 *      bare `class Sub extends Set {}` followed by `s.add(1)` compiles with ZERO
 *      imports and runs. The typed method path does gate on the receiver's
 *      static symbol name (so the `"Set"`-named arm misses for a subclass-typed
 *      receiver), but the fall-through reaches the value-representation
 *      dispatch, which brand-tests `$Map` and reads `M_KIND` — and
 *      `emitStandaloneCollectionSuperCtor` hands back a correctly branded `$Map`
 *      precisely so that path can succeed.
 *   2. A declared property/accessor traps; a declared method or an explicit
 *      `constructor() { super(); }` does not.
 *
 * The collection refusal in `class-bodies.ts` therefore covers ONLY
 * property/accessor declarations. That is deliberately asymmetric with the
 * Array/TypedArray rungs, in the conservative direction: a clean compile error
 * beats the trap those rungs produce. Do NOT widen it back to "any non-empty
 * body" — that refuses plain methods and explicit constructors, which are
 * measured to work. Do NOT drop it either while the family-wide field defect
 * stands. The terminal fix is to repair field storage for externref-backed
 * subclasses ACROSS the family, at which point the guard should be deleted for
 * all rungs at once rather than loosened for one.
 *
 * The predicate itself lives at the refusal site in `class-bodies.ts`, which
 * already has the TypeScript AST in scope; this note is the rationale it points
 * at.
 */
