// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5194 r3-1) `__extern_method_call`'s missing `$__ta_dyn_view` receiver arm.
 *
 * ## What was broken
 *
 * Every `testWithTypedArrayConstructors(function (TA) { var sample = new TA([…]);
 * sample.<m>(…) })` row calls a `%TypedArray%.prototype` method on a receiver
 * whose STATIC type is `any` and whose RUNTIME brand is `$__ta_dyn_view`. Such a
 * call converges — through `__call_m_<m>_N` for a local receiver, directly for a
 * parameter receiver — on `__extern_method_call`, which had no arm for that
 * brand. It therefore fell to the generic `$__vec_base` arms the dyn view
 * subtypes, which answer for the WRONG object: `includes(42)` produced the
 * NUMBER `1`, `indexOf()` produced `0`, `sort`/`keys` produced `null`.
 *
 * ## Shape, and why it is narrow
 *
 * The arm is a `ref.eq` ladder over the INTERNED method-name globals, and it
 * claims a call ONLY for a name whose native `__ta_dyn_<m>` helper is already in
 * `funcMap` at finalize. A method with no helper falls through to exactly the
 * body it reaches today, so nothing that answers correctly by accident is
 * displaced — the ladder grows as helpers land (r3-2…r3-5), one method at a
 * time, and each addition is measurable on its own rows.
 *
 * A name that is not the interned literal (a rope, a runtime-built string)
 * misses the `ref.eq` and keeps today's behaviour. That is the same documented
 * residual the #3673 string fast path in `object-runtime.ts` carries.
 *
 * ## Own properties still shadow (§7.3.2)
 *
 * `view.includes = f; view.includes()` must call `f`. The dyn view's expando
 * side-table (`$__ta_dyn_view` field 4) is consulted FIRST and, on an own hit,
 * the arm declines so the ordinary resolution path runs. Without that check the
 * ladder would silently outrank a user-installed own method.
 *
 * ## Why FINALIZE
 *
 * Same reason as `native-proto-method-call.ts`: the `$__ta_dyn_view` type and
 * the `__ta_dyn_*` helpers are both registered lazily while call sites compile,
 * so a body-build-time splice would bake an empty ladder. Unshifting at finalize
 * reads the final `funcMap`, and a module with no dynamic view registers no type
 * and gets no arm at all — byte-identical output.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { i32ByteVec } from "./dataview-native.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * Method names this arm can dispatch, in the order they are tested. A name is
 * emitted only when `__ta_dyn_<name>` exists in `funcMap` at finalize.
 *
 * `set`/`fill`/`copyWithin`/`reverse` already have helpers (#2872/#5194 slice A)
 * and join for free; the call-site two-arm in `call-receiver-method.ts` stays as
 * the faster direct exit for the shapes it already served, so its bytes do not
 * move.
 */
export const TA_DYN_METHOD_CALL_NAMES: readonly string[] = [
  "set",
  "fill",
  "copyWithin",
  "reverse",
  "includes",
  "indexOf",
  "lastIndexOf",
  "join",
  "sort",
  "keys",
  "values",
  "entries",
  "every",
  "some",
  "forEach",
  "find",
  "findIndex",
  "reduce",
  "reduceRight",
  "map",
  "filter",
  "toLocaleString",
];

/**
 * Native helper name for a dispatched method. The pre-existing #2872 helper for
 * `copyWithin` is spelled all-lowercase, so the mapping is not a plain
 * concatenation — getting it wrong silently drops the method from the ladder.
 */
export function taDynMethodHelperName(method: string): string {
  return `__ta_dyn_${method === "copyWithin" ? "copywithin" : method}`;
}

/**
 * (#1645 S1) `%TypedArray%.prototype` methods whose step 1 is ValidateTypedArray
 * (§23.2.4.4), so a DETACHED viewed buffer must make them throw a TypeError
 * before any other observable step runs.
 *
 * Deliberately WIDER than {@link TA_DYN_METHOD_CALL_NAMES}: that list names the
 * methods with a native `__ta_dyn_<m>` helper, and most of the detached-buffer
 * corpus calls methods that have none (`some`, `sort`, `keys`, `values`,
 * `entries`, `find`, `findIndex`, …). Measured on 68bcd9eb4d, those fall through
 * to the generic `$__vec_base` handling — which a `$__ta_dyn_view` subtypes —
 * and answer from the view's post-detach length of 0, i.e. return NORMALLY
 * where §23.2.4.4 requires a throw. That is the whole of "Expected a TypeError
 * to be thrown but no exception was thrown at all", the reported error on 24 of
 * the 33 ES2015 detached rows.
 *
 * `subarray` is deliberately ABSENT: §23.2.4.4 is not applied to it (it makes a
 * new view over the same buffer and does not throw on a detached one), and
 * `built-ins/TypedArray/prototype/subarray/detached-buffer.js` asserts exactly
 * that. `buffer`/`byteLength`/`byteOffset`/`length`/`BYTES_PER_ELEMENT` are
 * accessors, not methods, so they never reach a method dispatcher.
 */
const TA_DYN_VALIDATE_METHOD_NAMES: readonly string[] = [
  "at",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "reverse",
  "set",
  "slice",
  "some",
  "sort",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toString",
  "values",
  "with",
];

/** Does `method` begin with §23.2.4.4 ValidateTypedArray on a dynamic view? */
function taDynMethodValidatesTypedArray(method: string): boolean {
  return TA_DYN_VALIDATE_METHOD_NAMES.includes(method);
}

/**
 * (#1645 S1) Build the §23.2.4.4 step-5 detached-buffer prologue for a
 * `$__ta_dyn_view` receiver already materialized into `anyLocalIdx`:
 *
 * ```
 * if (ref.test $__ta_dyn_view recv && recv.expando == null && recv.buf.length < 0)
 *   throw new TypeError(…)
 * ```
 *
 * The detach marker IS the shared backing vec's `length` forced to `-1`
 * (`tryCompileStandaloneDetachedWrite`, dataview-native.ts) — unreachable for a
 * live buffer, so `< 0` is exact — and a dyn view's field 1 holds that very
 * struct, which is why the state is observable at the dispatcher without any
 * per-method helper.
 *
 * Callers are the per-method `__call_m_<name>_<arity>` / `_vararg` dispatchers,
 * where the method name is a compile-time constant, so no runtime name ladder is
 * needed. Returns `[]` — byte-identical output — when the module registered no
 * dynamic view, when the native `TypeError` constructor is unavailable, or when
 * `method` does not validate.
 *
 * The `expando == null` clause is §7.3.2 shadowing in its conservative form: a
 * view carrying ANY own expando declines the throw and keeps its existing
 * resolution, so `view.some = f; view.some()` can never be preempted.
 * `__hasOwnProperty` is deliberately not used — it does not report a dyn view's
 * own keys (see the search-trio arm's note in closed-method-dispatch.ts).
 *
 * `pushLocal` appends the scratch buffer local and returns its index; the caller
 * owns the locals array, so it must be called before that array is frozen onto
 * the function.
 */
export function taDynDetachedGuardInstrs(
  ctx: CodegenContext,
  method: string,
  anyLocalIdx: number,
  pushLocal: (name: string, type: ValType) => number,
): Instr[] {
  if (!ctx.standalone) return [];
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx === undefined || dynIdx < 0) return [];
  if (!taDynMethodValidatesTypedArray(method)) return [];
  // `assert.throws(TypeError, …)` checks `instanceof`, so this needs a real
  // TypeError INSTANCE, and the constructor has to ALREADY be in `funcMap`.
  // Two things are deliberately not done at this seam:
  //  - no `ensureLateImport` (hence `forceInModuleCtor`) — an import added here
  //    would shift every funcIdx already emitted in the module;
  //  - no MINTING either. `buildThrowJsErrorInstrs` would otherwise register the
  //    `$Error_struct` type and define `__new_TypeError` on demand, and the
  //    dispatcher fill runs late enough that introducing a new struct type is
  //    not a cost worth paying for a guard. Declining costs nothing measurable:
  //    with the check in place the 33-row detached list still scores 9 pass, so
  //    no row depends on the mint.
  if (ctx.funcMap.get("__new_TypeError") === undefined) return [];
  const throwInstrs = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: Cannot perform operation on a detached ArrayBuffer",
    { forceInModuleCtor: true },
  );
  const bufVecTypeIdx = i32ByteVec(ctx).vecTypeIdx;
  const bufLocal = pushLocal("__tadyn_det_buf", { kind: "ref_null", typeIdx: bufVecTypeIdx });
  const lengthIsNegative: Instr[] = [
    { op: "local.get", index: bufLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
  ];
  const bufIsPresent: Instr[] = [
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.cast", typeIdx: dynIdx },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
    { op: "local.tee", index: bufLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: lengthIsNegative },
  ];
  const noOwnExpando: Instr[] = [
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.cast", typeIdx: dynIdx },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 4 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: bufIsPresent },
  ];
  return [
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.test", typeIdx: dynIdx },
    { op: "if", blockType: { kind: "empty" }, then: noOwnExpando },
  ];
}

/**
 * Prepend the `$__ta_dyn_view`-receiver arm onto `__extern_method_call`.
 *
 * No-op outside standalone, when the module registered no dynamic-view type,
 * when the args carrier types are absent, or when no dispatchable helper exists.
 *
 * ABI of the host function: param 0 = receiver externref, 1 = key externref,
 * 2 = args `$ObjVec` (as externref). Helper ABI:
 * `__ta_dyn_<m>(recv, a0, a1, a2, argc) -> externref`.
 */
export function unshiftExternMethodCallTaDynViewArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx === undefined || dynIdx < 0) return;
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return;
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  if (objVecTypeIdx === undefined || objVecArrTypeIdx === undefined) return;
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  if (!fn) return;

  const dispatchable = TA_DYN_METHOD_CALL_NAMES.map((name) => ({
    name,
    idx: ctx.funcMap.get(taDynMethodHelperName(name)),
  })).filter((entry): entry is { name: string; idx: number } => entry.idx !== undefined);
  if (dispatchable.length === 0) return;

  const base = 3 + fn.locals.length;
  const RECV_ANY = base;
  const NAME_STR = base + 1;
  const ARGS_ANY = base + 2;
  const ARGC = base + 3;
  const A0 = base + 4;
  const A1 = base + 5;
  const A2 = base + 6;
  const EXP = base + 7;
  const newLocals: { name: string; type: ValType }[] = [
    { name: "tadmc_recv", type: { kind: "anyref" } },
    { name: "tadmc_name", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "tadmc_args", type: { kind: "anyref" } },
    { name: "tadmc_argc", type: { kind: "i32" } },
    { name: "tadmc_a0", type: { kind: "externref" } },
    { name: "tadmc_a1", type: { kind: "externref" } },
    { name: "tadmc_a2", type: { kind: "externref" } },
    { name: "tadmc_exp", type: { kind: "externref" } },
  ];

  const loadArgSlot = (slot: number, local: number): Instr[] => [
    { op: "local.get", index: ARGC },
    { op: "i32.const", value: slot + 1 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ARGS_ANY },
        { op: "ref.cast", typeIdx: objVecTypeIdx },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: slot },
        { op: "array.get", typeIdx: objVecArrTypeIdx },
        { op: "local.set", index: local },
      ],
    },
  ];

  // argc / a0..a2 from the `$ObjVec` args carrier (null-safe: argc 0).
  const loadArgs: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: ARGC },
    { op: "ref.null.extern" },
    { op: "local.set", index: A0 },
    { op: "ref.null.extern" },
    { op: "local.set", index: A1 },
    { op: "ref.null.extern" },
    { op: "local.set", index: A2 },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: ARGS_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ARGS_ANY },
        { op: "ref.cast", typeIdx: objVecTypeIdx },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: ARGC },
        ...loadArgSlot(0, A0),
        ...loadArgSlot(1, A1),
        ...loadArgSlot(2, A2),
      ],
    },
  ];

  const body: Instr[] = [
    // Receiver must be a dynamic typed-array view.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: RECV_ANY },
    { op: "ref.test", typeIdx: dynIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    // The name must be an interned native string; a rope declines.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.nativeStrTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx },
    { op: "local.set", index: NAME_STR },
  ];
  if (hasOwnIdx !== undefined) {
    // §7.3.2: an own expando member shadows the inherited prototype method.
    body.push(
      { op: "local.get", index: RECV_ANY },
      { op: "ref.cast", typeIdx: dynIdx },
      { op: "struct.get", typeIdx: dynIdx, fieldIdx: 4 },
      { op: "local.tee", index: EXP },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: EXP },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: hasOwnIdx },
          { op: "br_if", depth: 1 },
        ],
      },
    );
  }
  body.push(...loadArgs);
  for (const entry of dispatchable) {
    body.push(
      { op: "local.get", index: NAME_STR },
      ...nativeStringLiteralInstrs(ctx, entry.name),
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: A0 },
          { op: "local.get", index: A1 },
          { op: "local.get", index: A2 },
          { op: "local.get", index: ARGC },
          { op: "call", funcIdx: entry.idx },
          { op: "return" },
        ],
      },
    );
  }

  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}
