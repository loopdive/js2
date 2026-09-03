import { buildStandardTryTable } from "../ir/try-table.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268 r3 step R3-1) `Array.from` (§23.1.2.1) and `Array.of` (§23.1.2.3) as
 * real natives for the STANDALONE / WASI lane.
 *
 * ## What was missing
 * Neither algorithm existed in the module. `Array.from` was three disjoint
 * approximations:
 *
 * - the 1-arg call drained through `__iterator` ONLY, so an array-LIKE source
 *   (`{length: 4, 0: …}`) threw `value is not iterable` — §23.1.2.1 step 6's
 *   whole array-like branch was missing;
 * - the 2-arg call composed `__array_from_iter_n` THEN `__hof_map`, i.e. it
 *   drained the source completely BEFORE mapping. That calls the mapper with
 *   `(v, i, recv)` (three args, `iter-map-fn-args` measures two), never runs
 *   IteratorClose when the mapper throws (`iter-map-fn-err`, `closeCount`), and
 *   blows up on an iterator that only terminates because the mapper throws
 *   ("requested new array is too large");
 * - the VALUE form (`var f = Array.from` / `Array.from.call(C, items)`) had no
 *   case at all in `ensureStandaloneBuiltinStaticMethodClosure`, so it reified
 *   with the generic catchable-TypeError body ("Array.from is not yet
 *   implemented in --target standalone").
 *
 * ## Shape of the fix
 * One native per builtin, both host-free, both composed from runtime natives
 * that already exist:
 *
 * - {@link ensureNativeArrayFrom} → `__array_from_native(C, items, mapFn,
 *   thisArg)`. `C` is the `this` value (§23.1.2.1 step 1) — `ref.null.extern`
 *   from a direct `Array.from(…)` call site (the default lane: the result is a
 *   fresh `$ObjVec`), the reflective receiver from the `.call` form.
 * - {@link ensureNativeArrayOf} → `__array_of_native(C, argsVec)`.
 *
 * ## Two source branches, and how the branch is chosen
 * §23.1.2.1 branches on `GetMethod(items, @@iterator)`. The test is the
 * `__iterator_method_present` predicate (iterator-native.ts, #5268 r3 F2): a
 * finalize-filled `ref.test` ladder over every shape whose `@@iterator` is a
 * STATIC member — closed structs with a `<Struct>_@@iterator` method or an
 * `@@iterator` closure field, driven generator frames, the lazy helper — and,
 * for everything else, `HasProperty(items, @@iterator)` (`__extern_has`, own
 * and prototype chain; a present-but-nullish method still reaches the
 * iterator branch and raises its own TypeError). It is a HasProperty, not a
 * `[[Get]]`, so an `@@iterator` accessor fires exactly once — inside
 * `__iterator`'s GetMethod (round-3 review F4). The round-2 cut
 * used the property read alone plus "no `length`" as a tell for closed
 * structs; a closed-struct iterable that ALSO carried `length` then walked as
 * an array-like and answered `undefined × length` where the previous lowering
 * threw. The decision is now carried by what the value IS.
 *
 * A source that answers falsy takes the array-like branch, but is first passed
 * through `__array_from_iter_n(items, -1)`. That helper returns an indexable
 * source UNCHANGED and drains a genuinely-drainable one (a `$Vec`, or a
 * closed-struct user iterable whose type the #3100 S5 finalize pass taught it),
 * so the branch keeps working for every source the previous drain-only lowering
 * handled — a closed-struct iterable literal is drained rather than read as a
 * zero-length array-like. Its elements are then walked with
 * `__extern_length` / `__extern_get_idx`.
 *
 * ## Why the iterator branch is hand-written rather than composed
 * The three properties the composed version could not have are all in the LOOP:
 * the mapper sees exactly `(value, k)`, the define happens per element (so an
 * infinite iterator terminates on the first abrupt), and an abrupt mapper or
 * define runs IteratorClose (`__iterator_return`) before rethrowing. The
 * rethrow is a standardized `try_table` with one tagged catch that re-throws
 * the payload — the same scaffold `promise-executor.ts` uses.
 *
 * ## The two result lanes
 * `IsConstructor(C)` decides. Default lane (`C` null/undefined, i.e. an
 * ordinary `Array.from(…)`): elements go into a `$ObjVec` with `__objvec_push`
 * and there is no trailing `length` write — the carrier's length IS its
 * element count, and pushing consults no prototype (which is what
 * `of/does-not-use-prototype-properties` asserts). Constructor lane: `A =
 * Construct(C)` / `Construct(C, «len»)` through the native construct driver,
 * each element is a CreateDataPropertyOrThrow (`__defineProperty_value` with
 * the full data-descriptor flag word, then the plain `[[Set]]` that
 * `emitArraySpeciesResultSwap` documents for the `$vec` dense lane), and
 * `length` is written LAST through `__extern_set_strict` — a plain `[[Set]]`,
 * so a poisoned `length` setter on `C.prototype` propagates
 * (`iter-set-length-err`).
 *
 * WASI declines the constructor lane with a catchable TypeError (#5268 r3 F5):
 * `__extern_set` on WASI traps `illegal cast` inside `__obj_find` for any
 * constructed instance (a plain `o.length = 2` on `{}` traps the same way on
 * that target, before and after this change), so the CreateDataProperty step
 * would turn the TypeError the previous lowering raised into an uncatchable
 * trap. The default lane (`Array.from(…)` / `Array.from.call(undefined, …)`)
 * is unaffected.
 *
 * Standalone/WASI only: every dep is standalone-gated, and the JS-host lane
 * keeps its `env.__array_from` bridge byte-for-byte.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import {
  ensureNativeArrayFromIterN,
  ensureNativeIteratorMethodPresent,
  ensureNativeIteratorRuntime,
} from "./iterator-native.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { reserveNativeConstructDriver } from "./native-construct.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { ensureLateImport } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/**
 * `__defineProperty_value` flag word for a full
 * `{value, writable: true, enumerable: true, configurable: true}` data
 * descriptor (the encoding `array-species.ts` documents).
 */
const CREATE_DATA_PROPERTY_FLAGS = 0b1011_1111;

interface FromDeps {
  externSetStrict: number;
  externLength: number;
  externGetIdx: number;
  externIsUndefined: number;
  boxNumber: number;
  defineValue: number;
  externSet: number;
  toString: number;
  isTruthy: number;
  typeofFunction: number;
  isConstructor: number;
  construct0: number;
  construct1: number;
  objVecNew: number;
  objVecPush: number;
  applyClosure: number;
  iterator: number;
  iteratorNext: number;
  iteratorReturn: number;
  arrayFromIterN: number;
  iteratorMethodPresent: number;
}

/**
 * Register every native the two bodies call and resolve their indices in ONE
 * batch, before any index is read — each is a defined native under the
 * native-first provider, so a later registration shifts the ones already
 * resolved (the #2043 late-shift class).
 */
function prepareFromDeps(ctx: CodegenContext): FromDeps | undefined {
  ensureObjectRuntime(ctx);
  ensureNativeIteratorRuntime(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  const arrayFromIterN = ensureNativeArrayFromIterN(ctx);
  // `__box_symbol` feeds the predicate's dynamic probe (`__extern_has` comes
  // with the object runtime), so it is registered before the reserve.
  ensureLateImport(ctx, "__extern_set", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  ensureLateImport(ctx, "__extern_length", [EXTERNREF], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXTERNREF, F64], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__box_number", [F64], [EXTERNREF]);
  ensureLateImport(ctx, "__defineProperty_value", [EXTERNREF, EXTERNREF, EXTERNREF, F64], []);
  ensureLateImport(ctx, "__extern_toString", [EXTERNREF], [EXTERNREF]);
  addStringConstantGlobal(ctx, "length");
  ensureReflectIsConstructor(ctx);
  reserveNativeConstructDriver(ctx, 0, stringConstantExternrefInstrs(ctx, "prototype"));
  reserveNativeConstructDriver(ctx, 1, stringConstantExternrefInstrs(ctx, "prototype"));
  const iteratorMethodPresent = ensureNativeIteratorMethodPresent(ctx);

  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const externSetStrict = get("__extern_set_strict");
  const externSet = get("__extern_set");
  const externLength = get("__extern_length");
  const externGetIdx = get("__extern_get_idx");
  const externIsUndefined = get("__extern_is_undefined");
  const boxNumber = get("__box_number");
  const defineValue = get("__defineProperty_value");
  const externToString = get("__extern_toString");
  const isTruthy = get("__is_truthy");
  const typeofFn = get("__typeof_function");
  const isConstructor = get("__reflect_is_constructor");
  const construct0 = get("__native_construct_0");
  const construct1 = get("__native_construct_1");
  const objVecNew = get("__objvec_new");
  const objVecPush = get("__objvec_push");
  const iterator = get("__iterator");
  const iteratorNext = get("__iterator_next");
  const iteratorReturn = get("__iterator_return");
  if (
    iteratorMethodPresent === undefined ||
    externSetStrict === undefined ||
    externSet === undefined ||
    externLength === undefined ||
    externGetIdx === undefined ||
    externIsUndefined === undefined ||
    boxNumber === undefined ||
    defineValue === undefined ||
    externToString === undefined ||
    isTruthy === undefined ||
    typeofFn === undefined ||
    isConstructor === undefined ||
    construct0 === undefined ||
    construct1 === undefined ||
    objVecNew === undefined ||
    objVecPush === undefined ||
    iterator === undefined ||
    iteratorNext === undefined ||
    iteratorReturn === undefined
  ) {
    return undefined;
  }
  return {
    externSetStrict,
    externSet,
    externLength,
    externGetIdx,
    externIsUndefined,
    boxNumber,
    defineValue,
    toString: externToString,
    isTruthy,
    typeofFunction: typeofFn,
    isConstructor,
    construct0,
    construct1,
    objVecNew,
    objVecPush,
    applyClosure,
    iterator,
    iteratorNext,
    iteratorReturn,
    arrayFromIterN,
    iteratorMethodPresent,
  };
}

/**
 * `usingCtor = C is present ∧ IsConstructor(C)` → local `dst`.
 *
 * (#5268 r3 F5) On WASI a constructor receiver is declined with a catchable
 * TypeError instead: the constructor lane's CreateDataProperty `[[Set]]`
 * (`__extern_set`) traps `illegal cast` in `__obj_find` on that target for
 * every constructed instance — the round-2 lowering turned the TypeError the
 * previous `.call` reification raised into an uncatchable trap. The default
 * lane is untouched.
 */
function usingCtorInstrs(ctx: CodegenContext, d: FromDeps, cLocal: number, dst: number): Instr[] {
  const wasiDecline: Instr[] = ctx.wasi
    ? [
        { op: "local.get", index: dst },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(
            ctx,
            "TypeError",
            "Array.from/Array.of: a constructor receiver is not supported in --target wasi",
          ),
          else: [],
        },
      ]
    : [];
  return [
    { op: "local.get", index: cLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: dst },
      ],
      else: [
        { op: "local.get", index: cLocal },
        { op: "call", funcIdx: d.externIsUndefined },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: dst },
          ],
          else: [
            { op: "local.get", index: cLocal },
            { op: "call", funcIdx: d.isConstructor },
            { op: "local.set", index: dst },
          ],
        },
      ],
    },
    ...wasiDecline,
  ];
}

/**
 * CreateDataPropertyOrThrow(A, k, value) for both lanes.
 *
 * Default lane (`$ObjVec`): `__objvec_push` — append, no prototype consult, no
 * descriptor machinery. Constructor lane: `__defineProperty_value` with the
 * full data-descriptor flags followed by the plain `[[Set]]` that
 * `emitArraySpeciesResultSwap` (`array-species.ts`) documents — the define
 * lands the ATTRIBUTES and raises the §10.1.6.3 TypeErrors, and on a `$vec`
 * target the `[[Set]]` is what the dense index lane actually reads back.
 */
function createDataPropertyInstrs(
  d: FromDeps,
  usingCtorLocal: number,
  aLocal: number,
  kLocal: number,
  valueLocal: number,
): Instr[] {
  return [
    { op: "local.get", index: usingCtorLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: aLocal },
        { op: "local.get", index: kLocal },
        { op: "call", funcIdx: d.boxNumber },
        { op: "call", funcIdx: d.toString },
        { op: "local.get", index: valueLocal },
        { op: "f64.const", value: CREATE_DATA_PROPERTY_FLAGS },
        { op: "call", funcIdx: d.defineValue },
        { op: "local.get", index: aLocal },
        { op: "local.get", index: kLocal },
        { op: "call", funcIdx: d.boxNumber },
        { op: "local.get", index: valueLocal },
        { op: "call", funcIdx: d.externSet },
      ],
      else: [
        { op: "local.get", index: aLocal },
        { op: "local.get", index: valueLocal },
        { op: "call", funcIdx: d.objVecPush },
      ],
    },
  ];
}

/**
 * `Set(A, "length", n, true)` — constructor lane only. The `$ObjVec` default
 * lane carries its own length, and writing one would be an observable the spec
 * does not have there (the fresh array's length is already `n`).
 */
function setLengthInstrs(ctx: CodegenContext, d: FromDeps, usingCtorLocal: number, aLocal: number, nLocal: number) {
  return [
    { op: "local.get", index: usingCtorLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: aLocal },
        ...stringConstantExternrefInstrs(ctx, "length"),
        { op: "local.get", index: nLocal },
        { op: "call", funcIdx: d.boxNumber },
        { op: "call", funcIdx: d.externSetStrict },
      ],
      else: [],
    },
  ] satisfies Instr[];
}

/**
 * `mapped = mapping ? Call(mapFn, thisArg, «value, k») : value`.
 *
 * The argument vector holds exactly TWO slots, so the mapper's `arguments`
 * object has length 2 (`iter-map-fn-args`) — the composed `__hof_map` route
 * pushed a third (the receiver).
 */
function mapValueInstrs(
  d: FromDeps,
  mappingLocal: number,
  mapFnParam: number,
  thisArgParam: number,
  kLocal: number,
  valueLocal: number,
  argsLocal: number,
  outLocal: number,
): Instr[] {
  return [
    { op: "local.get", index: mappingLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: d.objVecNew },
        { op: "local.set", index: argsLocal },
        { op: "local.get", index: argsLocal },
        { op: "local.get", index: valueLocal },
        { op: "call", funcIdx: d.objVecPush },
        { op: "local.get", index: argsLocal },
        { op: "local.get", index: kLocal },
        { op: "call", funcIdx: d.boxNumber },
        { op: "call", funcIdx: d.objVecPush },
        { op: "local.get", index: mapFnParam },
        { op: "local.get", index: thisArgParam },
        { op: "local.get", index: argsLocal },
        { op: "call", funcIdx: d.applyClosure },
        { op: "local.set", index: outLocal },
      ],
      else: [
        { op: "local.get", index: valueLocal },
        { op: "local.set", index: outLocal },
      ],
    },
  ];
}

/**
 * §23.1.2.1 step 6: the ARRAY-LIKE branch — `len = LengthOfArrayLike(items)`,
 * `A = usingCtor ? Construct(C, «len») : $ObjVec`, then a `Get(items, k)` /
 * map / CreateDataPropertyOrThrow walk, and `Set(A, "length", len)` last.
 *
 * Split out of {@link ensureNativeArrayFrom} to keep that builder under the
 * #3400 per-function LOC ratchet; every instruction object is still minted
 * fresh per call (factory discipline, #5188 followUp 4).
 */
function buildArrayLikeBranch(
  ctx: CodegenContext,
  d: FromDeps,
  ix: {
    ITEMS: number;
    SRC: number;
    LEN: number;
    USING: number;
    C: number;
    A: number;
    K: number;
    VALUE: number;
  },
  perElement: Instr[],
): Instr[] {
  const { ITEMS, SRC, LEN, USING, C, A, K, VALUE } = ix;
  return [
    // Normalize: an indexable source passes through unchanged; a drainable one
    // (a `$Vec`, or a closed-struct user iterable the #3100 S5 finalize pass
    // taught `__array_from_iter_n`) is drained, which is exactly what the
    // pre-existing drain-only lowering did for it.
    { op: "local.get", index: ITEMS },
    { op: "f64.const", value: -1 },
    { op: "call", funcIdx: d.arrayFromIterN },
    { op: "local.set", index: SRC },
    { op: "local.get", index: SRC },
    { op: "call", funcIdx: d.externLength },
    { op: "local.set", index: LEN },
    { op: "local.get", index: USING },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "ref.null.extern" },
        { op: "local.get", index: LEN },
        { op: "call", funcIdx: d.boxNumber },
        { op: "call", funcIdx: d.construct1 },
        { op: "local.set", index: A },
      ],
      else: [
        { op: "call", funcIdx: d.objVecNew },
        { op: "local.set", index: A },
      ],
    },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: K },
            { op: "local.get", index: LEN },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: SRC },
            { op: "local.get", index: K },
            { op: "call", funcIdx: d.externGetIdx },
            { op: "local.set", index: VALUE },
            ...perElement,
            { op: "local.get", index: K },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...setLengthInstrs(ctx, d, USING, A, LEN),
  ];
}

/**
 * Register `__array_from_native(C, items, mapFn, thisArg) -> externref`
 * (§23.1.2.1). Idempotent, standalone-only; `undefined` when a runtime dep is
 * missing so the caller keeps its existing routing.
 */
export function ensureNativeArrayFrom(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  const existing = ctx.funcMap.get("__array_from_native");
  if (existing !== undefined) return existing;
  const d = prepareFromDeps(ctx);
  if (!d) return undefined;

  // params: 0 = C, 1 = items, 2 = mapFn, 3 = thisArg
  const C = 0;
  const ITEMS = 1;
  const MAPFN = 2;
  const THISARG = 3;
  // `mapFn` is an externref, and an externref NULL is what a compiled `null`
  // literal lowers to — so the value alone cannot distinguish
  // `Array.from(x, null)` (a TypeError: null is not callable) from
  // `Array.from(x)` (no mapper at all). The caller therefore states the
  // arity: this flag travels WITH the call rather than being re-derived from
  // the value's shape.
  const GIVEN = 4; // i32 param — a mapFn argument was supplied
  // locals
  const USING = 5; // i32
  const MAPPING = 6; // i32
  const A = 7; // externref
  const ITER = 8; // externref
  const K = 9; // f64
  const DONE = 10; // i32
  const VALUE = 11; // externref
  const MAPPED = 12; // externref
  const ARGS = 13; // externref
  const LEN = 14; // f64
  const SRC = 15; // externref
  const EXN = 16; // externref

  const exnTag = ensureExnTag(ctx);

  // §23.1.2.1 step 2: mapFn present ⇒ must be callable, checked BEFORE
  // GetMethod(items, @@iterator).
  const mapFnCheck: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: MAPPING },
    { op: "local.get", index: GIVEN },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: MAPFN },
        { op: "call", funcIdx: d.externIsUndefined },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: MAPFN },
            { op: "call", funcIdx: d.typeofFunction },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: buildThrowJsErrorInstrs(ctx, "TypeError", "Array.from: mapfn is not a function"),
              else: [],
            },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: MAPPING },
          ],
          else: [],
        },
      ],
      else: [],
    },
  ];

  // Nullish source: GetMethod on `undefined`/`null` throws first (§7.3.9 →
  // §7.1.18 ToObject), so one guard at the top is spec-equivalent for both
  // branches.
  const nullishGuard: Instr[] = [
    { op: "local.get", index: ITEMS },
    { op: "ref.is_null" },
    { op: "local.get", index: ITEMS },
    { op: "call", funcIdx: d.externIsUndefined },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert undefined or null to object"),
      else: [],
    },
  ];

  // usingIterator = GetMethod(items, @@iterator) is not undefined —
  // `__iterator_method_present` (iterator-native.ts): static closed-struct /
  // generator-frame arms filled at finalize, then HasProperty(items,
  // @@iterator) (a present-but-nullish method reaches `__iterator`'s own
  // TypeError; no probing [[Get]], so an accessor fires once). No `length`
  // heuristics (#5268 r3 F2/F4).
  const hasIter: Instr[] = [
    { op: "local.get", index: ITEMS },
    { op: "call", funcIdx: d.iteratorMethodPresent },
  ];

  // Per-element work, shared by both branches: map then define. Wrapped by the
  // caller in the iterator branch's IteratorClose scaffold.
  const perElement: Instr[] = [
    ...mapValueInstrs(d, MAPPING, MAPFN, THISARG, K, VALUE, ARGS, MAPPED),
    ...createDataPropertyInstrs(d, USING, A, K, MAPPED),
  ];

  const iteratorBranch: Instr[] = [
    // A = usingCtor ? Construct(C) : $ObjVec
    { op: "local.get", index: USING },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "ref.null.extern" },
        { op: "call", funcIdx: d.construct0 },
        { op: "local.set", index: A },
      ],
      else: [
        { op: "call", funcIdx: d.objVecNew },
        { op: "local.set", index: A },
      ],
    },
    { op: "local.get", index: ITEMS },
    { op: "call", funcIdx: d.iterator },
    { op: "local.set", index: ITER },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: ITER },
            { op: "call", funcIdx: d.iteratorNext },
            { op: "local.set", index: VALUE },
            { op: "local.set", index: DONE },
            { op: "local.get", index: DONE },
            { op: "br_if", depth: 1 },
            // IteratorClose on an abrupt mapper / define (§23.1.2.1 steps
            // 6.e.viii-ix): catch, `__iterator_return(iter)`, rethrow.
            buildStandardTryTable({ kind: "empty" }, perElement, [
              {
                kind: "catch",
                tagIdx: exnTag,
                payloadType: EXTERNREF,
                body: [
                  { op: "local.set", index: EXN },
                  // §7.4.9 IteratorClose step 5: when the completion being
                  // propagated is already a THROW, an abrupt `return()` —
                  // including the "iterator result is not an object" refusal
                  // `__iterator_return` raises for a `return` method that
                  // answers a non-object — is DISCARDED. Only the original
                  // exception escapes (`iter-map-fn-err` asserts the mapper's
                  // own error, with `closeCount === 1`).
                  buildStandardTryTable(
                    { kind: "empty" },
                    [
                      { op: "local.get", index: ITER },
                      { op: "call", funcIdx: d.iteratorReturn },
                    ],
                    [
                      {
                        kind: "catch",
                        tagIdx: exnTag,
                        payloadType: EXTERNREF,
                        body: [{ op: "drop" }],
                      },
                    ],
                  ),
                  { op: "local.get", index: EXN },
                  { op: "throw", tagIdx: exnTag },
                ],
              },
            ]),
            { op: "local.get", index: K },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...setLengthInstrs(ctx, d, USING, A, K),
  ];

  const arrayLikeBranch: Instr[] = buildArrayLikeBranch(ctx, d, { ITEMS, SRC, LEN, USING, C, A, K, VALUE }, perElement);

  const body: Instr[] = [
    ...mapFnCheck,
    ...nullishGuard,
    ...usingCtorInstrs(ctx, d, C, USING),
    ...hasIter,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: iteratorBranch,
      else: arrayLikeBranch,
    },
    { op: "local.get", index: A },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF, I32], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__array_from_native", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__array_from_native",
    typeIdx,
    locals: [
      { name: "usingCtor", type: I32 },
      { name: "mapping", type: I32 },
      { name: "a", type: EXTERNREF },
      { name: "iter", type: EXTERNREF },
      { name: "k", type: F64 },
      { name: "done", type: I32 },
      { name: "value", type: EXTERNREF },
      { name: "mapped", type: EXTERNREF },
      { name: "args", type: EXTERNREF },
      { name: "len", type: F64 },
      { name: "src", type: EXTERNREF },
      { name: "exn", type: EXTERNREF },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Register `__array_of_native(C, argsVec) -> externref` (§23.1.2.3). `argsVec`
 * is the `$ObjVec` holding the call's arguments.
 */
export function ensureNativeArrayOf(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  const existing = ctx.funcMap.get("__array_of_native");
  if (existing !== undefined) return existing;
  const d = prepareFromDeps(ctx);
  if (!d) return undefined;

  // params: 0 = C, 1 = argsVec
  const C = 0;
  const ARGV = 1;
  const USING = 2; // i32
  const A = 3; // externref
  const K = 4; // f64
  const LEN = 5; // f64
  const VALUE = 6; // externref

  const body: Instr[] = [
    ...usingCtorInstrs(ctx, d, C, USING),
    // `Array.of()` with no arguments hands the variadic closure a null vec.
    { op: "local.get", index: ARGV },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: LEN },
      ],
      else: [
        { op: "local.get", index: ARGV },
        { op: "call", funcIdx: d.externLength },
        { op: "local.set", index: LEN },
      ],
    },
    { op: "local.get", index: USING },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: C },
        { op: "ref.null.extern" },
        { op: "local.get", index: LEN },
        { op: "call", funcIdx: d.boxNumber },
        { op: "call", funcIdx: d.construct1 },
        { op: "local.set", index: A },
      ],
      else: [
        { op: "call", funcIdx: d.objVecNew },
        { op: "local.set", index: A },
      ],
    },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: K },
            { op: "local.get", index: LEN },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: ARGV },
            { op: "local.get", index: K },
            { op: "call", funcIdx: d.externGetIdx },
            { op: "local.set", index: VALUE },
            ...createDataPropertyInstrs(d, USING, A, K, VALUE),
            { op: "local.get", index: K },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...setLengthInstrs(ctx, d, USING, A, LEN),
    { op: "local.get", index: A },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__array_of_native", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__array_of_native",
    typeIdx,
    locals: [
      { name: "usingCtor", type: I32 },
      { name: "a", type: EXTERNREF },
      { name: "k", type: F64 },
      { name: "len", type: F64 },
      { name: "value", type: EXTERNREF },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
