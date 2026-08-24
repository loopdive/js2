// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4201) `__dyn_valueOf(externref) -> externref` — §20.1.3.7 /
 * §20.3.3.3 / §21.1.3.7 / §22.1.3.28 `valueOf` for a receiver whose type is
 * only known at RUNTIME, under `--target standalone`.
 *
 * ## What was wrong
 *
 * `compileReceiverMethodCall` ends with a blanket
 *
 * ```ts
 * if (propAccess.name.text === "valueOf" && expr.arguments.length === 0)
 *   return compileExpression(ctx, fctx, propAccess.expression);
 * ```
 *
 * — "`valueOf()` on non-primitive types typically returns the object itself".
 * That is `Object.prototype.valueOf`, and it is the right answer only when
 * nothing EARLIER in the receiver's prototype chain overrides it. Every arm
 * above it resolves the overriding cases from the receiver's STATIC TypeScript
 * type (`new Number(x).valueOf()` → the [[NumberData]] slot, and so on). A
 * receiver typed `any` — i.e. every receiver in compiled JavaScript, which is
 * what test262 is — reaches none of those arms, so the blanket identity
 * swallowed BOTH overriding cases at once:
 *
 * ```js
 * var b = new Boolean(true);
 * b.valueOf() === b        // was TRUE   — must be false
 * ({ valueOf: function () { return 7; } }).valueOf()   // was the object, not 7
 * ```
 *
 * The wrapper case is invisible in error text: the wrapper stringifies as its
 * primitive, so a failing test262 assertion renders `SameValue(«true», «true»)`
 * — a TYPE bug that reads as a VALUE bug.
 *
 * ## Why a runtime helper and not more static arms
 *
 * The receiver's shape is genuinely unknown at compile time, and the three
 * answers are distinguished only by what the object carries:
 *
 * 1. an own/inherited `valueOf` property → call it (user override wins);
 * 2. else a primitive-wrapper [[PrimitiveValue]] slot → return the slot
 *    (`WRAPPER_PRIMITIVE_KEY`, the FLAG_INTERNAL entry `__new_Number` /
 *    `__new_String` / `__new_Boolean` install and `__to_primitive` already
 *    reads first);
 * 3. else the receiver itself (`Object.prototype.valueOf`).
 *
 * Note the ordering is the SPEC's, not a heuristic: standalone ships no
 * `Boolean.prototype.valueOf` object, so an own `valueOf` and the intrinsic
 * cannot both be present, and probing the property first is what makes a
 * user override beat the slot.
 *
 * A NON-`$Object` receiver (native string, boxed number/boolean, closed
 * struct, vec, closure) returns unchanged — identical to the blanket fallback
 * this replaces, so nothing that worked before moves.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY, ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { compileExpression } from "./shared.js";
import { receiverIsPrimitiveWrapper } from "./object-ctor-primitive-receiver.js";

const HELPER = "__dyn_valueOf";

/**
 * Emit `<recv>.valueOf()` for a receiver whose type the ORACLE cannot pin down
 * (`any` / `unknown`) under `--target standalone`. Returns the result ValType
 * when it took the call, or `undefined` to leave the caller's historical
 * blanket-identity fallback in place.
 *
 * The caller has already established `propAccess.name.text === "valueOf"` with
 * zero arguments, so this is the ONLY syntactic shape that can change: a module
 * with no zero-arg `<expr>.valueOf()` property-access call site compiles
 * byte-identically. That bound is what makes the change's regression surface
 * enumerable rather than estimated.
 *
 * Gated on the oracle fact rather than the raw checker type / physical carrier
 * that `compileReceiverMethodCall` resolves further down, so no existing
 * receiver-resolution ordering moves (`resolveWasmType` registers module
 * types — reordering it would perturb far more than this call site).
 */
export function tryEmitDynamicValueOfCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  const fact = ctx.oracle.typeFactOf(propAccess.expression).kind;
  // (#4491 wave-5 T2) …plus the one receiver whose static type is a LIE about
  // its shape: `new Object(<primitive>)` types as `Object`, but §20.1.1.1 makes
  // it a String/Number/Boolean wrapper. `Object(1.1)` types as `any` and has
  // always come here; `new Object(1.1)` did not, and fell to the caller's
  // blanket `Object.prototype.valueOf` identity — returning the WRAPPER where
  // §21.1.3.7 requires its [[NumberData]]. The two spellings are spec-identical,
  // so this makes the lowering agree with itself. Same predicate #4232 uses to
  // stand the `.constructor` fold down for these receivers.
  if (fact !== "any" && fact !== "unknown" && !receiverIsPrimitiveWrapper(ctx, propAccess.expression)) {
    return undefined;
  }
  const helperIdx = ensureDynamicValueOfHelper(ctx);
  if (helperIdx < 0) return undefined;
  flushLateImportShifts(ctx, fctx);
  compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return { kind: "externref" };
}

/**
 * Register (idempotently) the dynamic-`valueOf` helper and return its func
 * index, or `-1` when the object runtime is unavailable — in which case the
 * caller keeps its prior blanket-identity fallback, so a module that cannot
 * host the helper stays byte-identical.
 */
export function ensureDynamicValueOfHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(HELPER);
  if (existing !== undefined) return existing;

  ensureObjectRuntime(ctx);
  const objTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  if (
    objTypes === undefined ||
    objFindIdx === undefined ||
    externGetIdx === undefined ||
    applyClosureIdx === undefined ||
    objVecNewIdx === undefined
  ) {
    return -1;
  }
  const { objectTypeIdx, propEntryTypeIdx } = objTypes;

  // Locals: 1 `a` anyref (receiver as anyref), 2 `m` externref (resolved
  // `valueOf`), 3 `e` the [[PrimitiveValue]] entry.
  const A = 1;
  const M = 2;
  const E = 3;
  const externref: ValType = { kind: "externref" };

  const stringExtern = (lit: string): Instr[] => {
    addStringConstantGlobal(ctx, lit);
    return stringConstantExternrefInstrs(ctx, lit);
  };

  // (#2106 S1) a property MISS resolves to the undefined singleton, not a null
  // externref — normalize so the `ref.is_null` below sees the miss.
  const nullishIdx = ctx.funcMap.get("__nullish_to_null");
  const normalizeMiss: Instr[] = nullishIdx !== undefined ? [{ op: "call", funcIdx: nullishIdx }] : [];

  // Arm 3 → Arm 2: no `valueOf` property. Return the wrapper's
  // [[PrimitiveValue]] slot when the FLAG_INTERNAL entry is present, else the
  // receiver (Object.prototype.valueOf).
  const slotOrSelf: Instr[] = [
    { op: "local.get", index: A },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    ...stringExtern(WRAPPER_PRIMITIVE_KEY),
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: E },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [{ op: "local.get", index: 0 }],
      else: [
        { op: "local.get", index: E },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
        { op: "i32.const", value: FLAG_INTERNAL },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: [
            { op: "local.get", index: E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value
            { op: "extern.convert_any" },
          ],
          else: [{ op: "local.get", index: 0 }],
        },
      ],
    },
  ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: A },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        // m = __extern_get(recv, "valueOf")
        { op: "local.get", index: 0 },
        ...stringExtern("valueOf"),
        { op: "call", funcIdx: externGetIdx },
        ...normalizeMiss,
        { op: "local.tee", index: M },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: slotOrSelf,
          // __apply_closure(m, recv, __objvec_new())
          else: [
            { op: "local.get", index: M },
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: objVecNewIdx },
            { op: "call", funcIdx: applyClosureIdx },
          ],
        },
      ],
      // Non-`$Object` receiver — unchanged, exactly the blanket fallback.
      else: [{ op: "local.get", index: 0 }],
    },
  ];

  const typeIdx = addFuncType(ctx, [externref], [externref]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER,
    typeIdx,
    locals: [
      { name: "a", type: { kind: "anyref" } },
      { name: "m", type: externref },
      { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    ],
    body,
    exported: false,
  });
  // Defensive: a minted index that did not land is a silent mis-call later.
  return definedFuncAt(ctx, funcIdx) ? funcIdx : -1;
}
