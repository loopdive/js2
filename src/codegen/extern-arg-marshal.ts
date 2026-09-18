// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// extern-arg-marshal.ts — the ONE place that marshals externref arguments into
// a compiled function's declared parameter types, and its result back.
//
// Extracted verbatim from `closed-method-dispatch.ts` (#5383 S2g) when a second
// finalize-time caller appeared: `standalone-class-construct.ts`'s per-class
// `construct` trampoline has exactly the same job as a method dispatcher's
// entry arm — take values that arrive as externref, hand them to a function
// whose formals are `f64`/`i32`/struct refs, box what comes back. Keeping one
// copy is what makes a fix to the #5380 omitted-argument sentinel (a defaulted
// `f64` formal must still run its default for a PRESENT-but-`undefined`
// argument) reach both callers instead of one.
//
// Behaviour is unchanged from the code this replaces; the extraction is
// byte-neutral (proved by a sha256 A/B over 6 modules × 2 targets in #5383's
// S2g notes).

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs, usesNativeJsErrors } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobals } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** Coerce helper funcIdxs, read once per fill pass (registered at reserve). */
export type CoerceIdxs = {
  boxNumIdx?: number;
  /** (#5241) `__box_boolean` — a boolean-returning method's `i32` result. */
  boxBoolIdx?: number;
  unboxNumIdx?: number;
  unboxBoolIdx?: number;
  undefinedIdx?: number;
  /**
   * (#5380) Lazy accessor for `__unbox_number_or_omitted` — see
   * {@link ensureUnboxNumberOrOmitted}. A THUNK, not an index: the helper is
   * minted only when an arm actually has a defaulted f64 formal, so a module
   * without one emits exactly the bytes it did before.
   */
  unboxNumOrOmitted?: () => number | undefined;
  /**
   * (#6619) Lazy accessor for `__unbox_number_checked` — see
   * {@link ensureUnboxNumberChecked}. `undefined` unless this module armed
   * the guard, so an unarmed module keeps calling `__unbox_number` directly.
   */
  unboxNumChecked?: () => number | undefined;
  /**
   * (#6615) Lazy accessor for the LENIENT ref-argument marshal — see
   * {@link ensureLenientRefArgHelper}. A thunk taking the formal's `want` type
   * and whether that formal is defaulted, so a module that never armed the
   * guard (or a `want` the helper cannot express) keeps its previous
   * `any.convert_extern` + hard `ref.cast` bytes exactly.
   */
  lenientRefArg?: (want: ValType, optionalHere: boolean) => number | undefined;
  /**
   * (#6634 S49) Lazy accessor for the OBJECT-TO-STRUCT ref-argument marshal —
   * see {@link ensureStructFromObjectCoercionHelper}. Only consulted when the
   * caller explicitly opts in (`externArgCoercionInstrs`'s `allowObjectCoercion`
   * flag) — an unarmed call site keeps its previous unconditional `ref.cast`
   * bytes exactly.
   */
  structFromObject?: (want: ValType) => number | undefined;
};

const EXTERNREF_VT: ValType = { kind: "externref" };

/**
 * (#6615) The message the lenient ref-argument marshal throws with. Worded as
 * the polyfill's own `Ve` does (`expected a string, not …`) minus the value,
 * which the marshal cannot stringify without running user code.
 */
const REF_ARG_TYPE_ERROR_MESSAGE = "argument type is not assignable to the callee's declared parameter type";

/**
 * (#6615) Per-module armed TypeError template for the lenient ref-argument
 * marshal. A `WeakMap` rather than a `CodegenContext` field for the same reason
 * `construct-is-constructor-guard.ts` uses one: an UNARMED module must be
 * byte-indistinguishable from one compiled before this existed.
 */
const armedRefArgThrow = new WeakMap<CodegenContext, Instr[]>();

/**
 * (#6615) Arm the lenient ref-argument marshal for this module.
 *
 * Reserve-then-fill, exactly as `armConstructIsConstructorGuard` does and for
 * the same reason: the marshal runs at FINALIZE, but building a real TypeError
 * instance materialises an error constructor and a string-constant GLOBAL, and
 * a finalize-time global append is not safe. So the terminal throw is built
 * HERE, mid-compile, against a live `fctx` the late-import shifter can relocate.
 *
 * No-JS-host lanes only (`--target standalone` / `wasi`): the JS-host lane
 * marshals dynamic arguments through its own mirrors, must stay byte-identical,
 * and is the one lane where the throw would need a late IMPORT that cannot be
 * added at fill time.
 */
export function armExternRefArgTypeGuard(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!usesNativeJsErrors(ctx)) return;
  if (armedRefArgThrow.has(ctx)) return;
  armedRefArgThrow.set(ctx, buildThrowJsErrorInstrs(ctx, "TypeError", REF_ARG_TYPE_ERROR_MESSAGE, { flush: fctx }));
}

/**
 * (#6615) Arm the same guard for a module compiled AS A LINKED PROVIDER.
 *
 * The site above is the module's own dynamic `new <value>` expression, and it
 * is not the only way to reach a construct trampoline: `classConstructWanted`
 * also turns them on for `ctx.exportsConsumedByWasm`, where the dynamic caller
 * lives in ANOTHER module entirely (`__js2wasm_link_construct` on the provider
 * side). Measured: the `@js-temporal/polyfill` provider compiles no dynamic
 * `new <value>` site of its own, so arming only at the expression site left its
 * artifact byte-identical and every `new Temporal.PlainDate(2000, 5, 2, null)`
 * still trapped across the link.
 *
 * Called once per module from the post-bodies point of BOTH codegen paths —
 * late enough that arming costs a module which never needed it nothing, early
 * enough that it is not a finalize-time mutation. No `fctx` to flush against
 * because no body is live there, and none is needed: under
 * `semanticProviders: "native-first"` `__new_TypeError` routes to
 * `emitWasiErrorConstructor` (a DEFINED function, no import, no index shift)
 * and, with `nativeStrings`, the message adds a string-pool entry rather than
 * an imported global.
 */
export function armExternRefArgTypeGuardForLinkedProvider(ctx: CodegenContext): void {
  if (!ctx.exportsConsumedByWasm) return;
  if (!usesNativeJsErrors(ctx)) return;
  if (armedRefArgThrow.has(ctx)) return;
  armedRefArgThrow.set(ctx, buildThrowJsErrorInstrs(ctx, "TypeError", REF_ARG_TYPE_ERROR_MESSAGE));
}

/**
 * (#6619) Per-module armed TypeError templates for the Symbol/BigInt-checked
 * numeric-argument marshal — the f64 twin of {@link armedRefArgThrow}. Two
 * templates because §7.1.4 ToNumber's TypeError text names the operand kind
 * and test262 assertions (`invalid-type.js`) exercise both.
 */
const armedF64ArgThrow = new WeakMap<CodegenContext, { symbol: Instr[]; bigint: Instr[] }>();

/**
 * (#6619) Arm the Symbol/BigInt-checked numeric-argument marshal for this
 * module — the f64 twin of {@link armExternRefArgTypeGuard}.
 *
 * `new Temporal.Duration(Symbol())` / `(0n)` reach `__unbox_number` through
 * the SAME construct-trampoline marshal `armExternRefArgTypeGuard` protects,
 * but `__unbox_number` itself must stay lenient: it doubles as the
 * numeric-key probe for `__extern_set` on a vec receiver (`arr[sym] = v`,
 * an ordinary property write that must not throw — see
 * `tonumber-fast-paths.ts`'s `symbolThrowArm` for the identical reasoning on
 * the general ToNumber path). So the guard lives in a WRAPPER
 * (`ensureUnboxNumberChecked`) consulted only by this dynamic-argument
 * marshal, never by `__unbox_number` itself.
 */
export function armExternF64ArgTypeGuard(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!usesNativeJsErrors(ctx)) return;
  if (armedF64ArgThrow.has(ctx)) return;
  armedF64ArgThrow.set(ctx, {
    symbol: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a number", { flush: fctx }),
    bigint: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a BigInt value to a number", { flush: fctx }),
  });
}

/**
 * (#6619) Arm the same guard for a module compiled AS A LINKED PROVIDER — the
 * f64 twin of {@link armExternRefArgTypeGuardForLinkedProvider}, for the same
 * reason: `classConstructWanted` also turns the trampolines on for
 * `ctx.exportsConsumedByWasm`, where the dynamic caller is on the OTHER side
 * of the link (`__js2wasm_link_construct`).
 */
export function armExternF64ArgTypeGuardForLinkedProvider(ctx: CodegenContext): void {
  if (!ctx.exportsConsumedByWasm) return;
  if (!usesNativeJsErrors(ctx)) return;
  if (armedF64ArgThrow.has(ctx)) return;
  armedF64ArgThrow.set(ctx, {
    symbol: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a number"),
    bigint: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a BigInt value to a number"),
  });
}

/**
 * (#6619) Mint (once) `__unbox_number_checked(externref) -> f64`: the plain
 * numeric unbox, except a Symbol or BigInt operand throws a catchable
 * TypeError per §7.1.4 ToNumber, instead of `__unbox_number`'s silent `NaN`.
 *
 * Returns `undefined` (caller keeps calling `__unbox_number` directly) unless
 * this module armed the guard — an unarmed module's bytes are unchanged.
 *
 * A helper FUNCTION, for the same double-evaluation reason
 * {@link ensureUnboxNumberOrOmitted} is one: the argument may come from
 * `__extern_get_idx`.
 */
function ensureUnboxNumberChecked(ctx: CodegenContext, unboxIdx: number | undefined): number | undefined {
  const existing = ctx.funcMap.get("__unbox_number_checked");
  if (existing !== undefined) return existing;
  const throwTemplates = armedF64ArgThrow.get(ctx);
  if (unboxIdx === undefined || throwTemplates === undefined) return undefined;
  const typeIdx = addFuncType(ctx, [EXTERNREF_VT], [{ kind: "f64" }], "$__unbox_number_checked_type");
  const body: Instr[] = [];
  if (ctx.symbolTypeIdx >= 0) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [...throwTemplates.symbol] },
    );
  }
  if (ctx.nativeBigIntTypeIdx >= 0) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [...throwTemplates.bigint] },
    );
  }
  body.push({ op: "local.get", index: 0 }, { op: "call", funcIdx: unboxIdx });
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__unbox_number_checked",
    typeIdx,
    locals: [],
    body,
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set("__unbox_number_checked", funcIdx);
  return funcIdx;
}

/**
 * (#6615) Mint (once per formal type) `__extern_arg_ref_<typeIdx>[_opt]
 * (externref) -> (ref [null] $T)`: the ref-typed replacement for the
 * unconditional `ref.cast` the ref arm used to emit inline.
 *
 * ## Why the hard cast is unsound HERE and not at a static call site
 *
 * A dynamic caller — `__class_construct_dispatch`'s per-class trampoline, a
 * closed-method dispatcher — hands the callee whatever value the PROGRAM
 * produced, while the callee's formal carries whatever type the CHECKER
 * inferred. For a parameter typed only by its own default initializer
 * (`constructor(y, m, d, calendar = "iso8601")` ⇒ `calendar: string`) those two
 * are not the same question: the declared type describes the default, not the
 * argument. `ref.cast` on a mismatch is a wasm TRAP — it kills the instance,
 * so no `catch` in the program can see it, and the spec-mandated TypeError the
 * callee's own body would have thrown never runs.
 *
 * Three arms, and the ONLY values that reach arms 1 and 3 are exactly the ones
 * `ref.cast` would already have trapped on, so this cannot change the answer of
 * any program that previously worked:
 *
 * 1. **`undefined` into a DEFAULTED nullable formal → `ref.null`.** The callee's
 *    parameter prologue fires a ref-typed default on `ref.is_null`
 *    (`function-body.ts`), so a typed null IS the "run your default" signal —
 *    the ref-lane twin of #5380's f64 sNaN sentinel. `new
 *    Temporal.PlainDate(2020, 12, 24, undefined)` must behave as the 3-argument
 *    call does (`calendar-undefined.js`).
 * 2. **A value that inhabits `$T` → the same cast as before**, byte for byte.
 * 3. **Anything else → a catchable `TypeError`.** `null`, `true`, `1`, `1n`,
 *    `{}`, a symbol, a foreign instance: none can be REPRESENTED in a
 *    `(ref null $string)` formal, so the callee cannot run its own check on the
 *    raw value. Throwing is what the callee would have done for every one of
 *    the ten values `calendar-wrong-type.js` passes (the polyfill's `Ve` is
 *    `if ("string" != typeof e) throw new TypeError(…)`), and unlike a trap it
 *    is catchable and leaves the instance alive.
 *
 * A helper FUNCTION rather than inline instructions, for the same reason
 * {@link ensureUnboxNumberOrOmitted} is one: the caller's argument may come from
 * `__extern_get_idx`, so the sequence must not evaluate it twice — and a
 * function needs no scratch local in callers whose local layout was fixed at
 * reserve time.
 *
 * Returns `undefined` (caller keeps its previous bytes) when the module never
 * armed the throw, when `__extern_is_undefined` is unavailable, or when `want`
 * carries no concrete type index.
 */
function ensureLenientRefArgHelper(ctx: CodegenContext, want: ValType, optionalHere: boolean): number | undefined {
  const throwInstrs = armedRefArgThrow.get(ctx);
  if (throwInstrs === undefined || throwInstrs.length === 0) return undefined;
  const typeIdx = (want as { typeIdx?: number }).typeIdx;
  if (typeIdx === undefined || typeIdx < 0) return undefined;
  const nullable = want.kind === "ref_null";
  // Arm 1 needs a formal that can HOLD the typed null and a callee prologue
  // that reads it as "absent" — i.e. a defaulted, nullable formal.
  const defaultOnUndefined = nullable && optionalHere;
  const name = `__extern_arg_ref_${typeIdx}${defaultOnUndefined ? "_opt" : ""}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (defaultOnUndefined && isUndefinedIdx === undefined) return undefined;
  const result: ValType = nullable ? { kind: "ref_null", typeIdx } : { kind: "ref", typeIdx };
  const inhabitsOrThrow: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: result },
      then: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx }],
      else: [...throwInstrs],
    },
  ];
  const body: Instr[] =
    defaultOnUndefined && isUndefinedIdx !== undefined
      ? [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: isUndefinedIdx },
          {
            op: "if",
            blockType: { kind: "val", type: result },
            then: [{ op: "ref.null", typeIdx }],
            else: inhabitsOrThrow,
          },
        ]
      : inhabitsOrThrow;
  const fnTypeIdx = addFuncType(ctx, [EXTERNREF_VT], [result], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx: fnTypeIdx, locals: [], body, exported: false } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * (#6634 S49) Mint (once per struct typeIdx) `__extern_arg_obj_<typeIdx>
 * (externref) -> (ref [null] $T)`: an OBJECT-TO-STRUCT ref-argument marshal,
 * for the specific closed-method-dispatch arms that opt in via
 * `externArgCoercionInstrs`'s `allowObjectCoercion` flag.
 *
 * ## Why the unconditional `ref.cast` is unsound for a MIXED class+literal
 * dispatcher arm
 *
 * `c.compute({year, month, day})` on an interface `Calc` with BOTH an
 * object-literal implementer and a CLASS implementer (#6634) routes the
 * call through the closed-method dispatcher's runtime `ref.test` cascade —
 * the call site cannot know statically which implementer will answer, so
 * the argument is compiled generically (`compileInternalCallArgument`
 * deliberately widens an object-literal argument to the open `$Object`
 * carrier whenever the parameter's expected type is `externref`, see that
 * file's #4383/native-first note). Every dispatcher arm then receives the
 * SAME `$Object` value and unconditionally `ref.cast`s it to its own
 * candidate's closed struct — which the `$Object` value never inhabits,
 * regardless of which arm runs. That is a Wasm TRAP, not a JS `TypeError`,
 * on a call that is otherwise perfectly well-typed (#6634 repro17).
 *
 * The mismatch is representational, not semantic: the `$Object` genuinely
 * has the right fields (`year`/`month`/`day`), just not the closed struct's
 * physical layout. This helper closes that gap generically — the same way
 * `resolveStructNameForExpr`'s #5187 fallback reaches a field the checker
 * could not name — by reading each declared field off the externref value
 * through the ordinary `[[Get]]` implementation (`__extern_get`) and
 * `struct.new`-ing the target shape, INSTEAD OF assuming the value already
 * IS that struct.
 *
 * Two arms:
 * 1. **The value already inhabits `$T`** (the common case — an already-closed
 *    struct crossing a dispatcher unchanged) → the same `ref.cast` as before,
 *    byte for byte.
 * 2. **Anything else** → read each field the target struct declares via
 *    `__extern_get(value, "<fieldName>")`, coerce to the field's own type,
 *    and `struct.new`. Scoped to structs whose every field is `f64` or
 *    `externref` (#6634's exact repro shape, plus the common case of a
 *    destructured numeric-fields object) — a struct with any other field
 *    kind (nested ref, i32, i64) declines (returns `undefined`), so the
 *    caller keeps the unconditional cast for shapes this helper cannot yet
 *    express safely.
 *
 * Declining (returning `undefined`) is always safe: the caller's fallback is
 * the EXACT bytes this helper replaces, so an unsupported shape is no worse
 * off than before #6634 exposed this gap.
 */
function ensureStructFromObjectCoercionHelper(ctx: CodegenContext, want: ValType): number | undefined {
  if (want.kind !== "ref" && want.kind !== "ref_null") return undefined;
  const typeIdx = (want as { typeIdx?: number }).typeIdx;
  if (typeIdx === undefined || typeIdx < 0) return undefined;
  const name = `__extern_arg_obj_${typeIdx}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const structName = ctx.typeIdxToStructName.get(typeIdx);
  if (structName === undefined) return undefined;
  const fields = ctx.structFields.get(structName);
  if (fields === undefined || fields.length === 0) return undefined;
  if (fields.some((f) => f.type.kind !== "f64" && f.type.kind !== "externref")) return undefined;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) return undefined;
  const needsUnbox = fields.some((f) => f.type.kind === "f64");
  const unboxNumIdx = needsUnbox ? ctx.funcMap.get("__unbox_number") : undefined;
  if (needsUnbox && unboxNumIdx === undefined) return undefined;
  // Field-name string constants: mint them (a no-op if already registered).
  // `addStringConstantGlobals` is explicitly designed for finalize-time
  // callers like this one — see its own doc comment.
  addStringConstantGlobals(
    ctx,
    fields.map((f) => f.name),
  );
  const nullable = want.kind === "ref_null";
  const result: ValType = nullable ? { kind: "ref_null", typeIdx } : { kind: "ref", typeIdx };
  const buildFromObject: Instr[] = [];
  for (const f of fields) {
    buildFromObject.push({ op: "local.get", index: 0 });
    buildFromObject.push(...stringConstantExternrefInstrs(ctx, f.name));
    buildFromObject.push({ op: "call", funcIdx: externGetIdx });
    if (f.type.kind === "f64") buildFromObject.push({ op: "call", funcIdx: unboxNumIdx! });
  }
  buildFromObject.push({ op: "struct.new", typeIdx });
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: result },
      then: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx }],
      else: buildFromObject,
    },
  ];
  const fnTypeIdx = addFuncType(ctx, [EXTERNREF_VT], [result], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx: fnTypeIdx, locals: [], body, exported: false } as WasmFunction);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * (#5380) Mint (once) `__unbox_number_or_omitted(externref) -> f64`: the plain
 * numeric unbox, except that an explicit host `undefined` becomes the
 * omitted-argument sNaN sentinel the callee's parameter prologue recognises.
 *
 * `f(undefined)` must run `f`'s default (§10.2.11 / FunctionDeclarationInstan-
 * tiation), and an f64 formal has no other way to carry "absent": a plain
 * unboxing `undefined` numerically yields a quiet NaN, indistinguishable from a real
 * `NaN` argument. The MISSING-argument arm of `buildEntryArm` already pushes
 * this sentinel; this is the same value for an argument that is present but
 * undefined.
 *
 * A helper FUNCTION rather than inline instructions because the arm's argument
 * may be produced by `__extern_get_idx` — evaluating it twice (once to test,
 * once to unbox) would both cost and, for an accessor-backed element, observe
 * the read twice. Returns `undefined` when either primitive is unavailable, so
 * the caller keeps its previous bytes.
 */
function ensureUnboxNumberOrOmitted(
  ctx: CodegenContext,
  unboxIdx: number | undefined,
  checkedIdx: number | undefined,
): number | undefined {
  const existing = ctx.funcMap.get("__unbox_number_or_omitted");
  if (existing !== undefined) return existing;
  const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
  if (unboxIdx === undefined || isUndefIdx === undefined) return undefined;
  // (#6619) A present-but-Symbol/BigInt argument still must throw — only an
  // ABSENT (`undefined`) one takes the sentinel. Prefer the checked unbox
  // when this module armed it, so a defaulted f64 formal gets the same
  // §7.1.4 ToNumber behaviour as a non-defaulted one.
  const effectiveUnboxIdx = checkedIdx ?? unboxIdx;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$__unbox_number_or_omitted_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: "__unbox_number_or_omitted",
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isUndefIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }],
        else: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: effectiveUnboxIdx },
        ],
      },
    ],
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set("__unbox_number_or_omitted", funcIdx);
  return funcIdx;
}

/**
 * Read the coercion helper indices for a FILL pass.
 *
 * Exported so every finalize-time caller that marshals externref arguments into
 * a compiled function's declared parameter types reads the SAME set — the
 * alternative is a second hand-rolled unbox/box helper-index table
 * drifting away from this one.
 */
export function buildCoerceIdxs(ctx: CodegenContext): CoerceIdxs {
  const ci: CoerceIdxs = {
    boxNumIdx: ctx.funcMap.get("__box_number"),
    boxBoolIdx: ctx.funcMap.get("__box_boolean"),
    unboxNumIdx: ctx.funcMap.get("__unbox_number"),
    unboxBoolIdx: ctx.funcMap.get("__unbox_boolean"),
    undefinedIdx: ctx.funcMap.get("__get_undefined"),
    unboxNumChecked: () => ensureUnboxNumberChecked(ctx, ci.unboxNumIdx),
    unboxNumOrOmitted: () => ensureUnboxNumberOrOmitted(ctx, ci.unboxNumIdx, ci.unboxNumChecked?.()),
    lenientRefArg: (want, optionalHere) => ensureLenientRefArgHelper(ctx, want, optionalHere),
    structFromObject: (want) => ensureStructFromObjectCoercionHelper(ctx, want),
  };
  return ci;
}

/**
 * Coerce the externref value ALREADY ON THE STACK to the declared param type
 * `want`. `optionalHere` selects the #5380 sentinel-preserving unboxer for a
 * DEFAULTED f64 formal (a present-but-`undefined` argument must still run the
 * default), so a non-optional formal keeps its previous bytes exactly.
 *
 * `allowObjectCoercion` (#6634 S49, default `false`) opts a ref-typed formal
 * into {@link ensureStructFromObjectCoercionHelper} as a fallback BEHIND the
 * existing `lenientRefArg` priority, when the plain `ref.cast` would trap. A
 * call site that does not pass it keeps its previous bytes exactly — only
 * `closed-method-dispatch.ts`'s mixed class+literal-implementer arms opt in.
 */
export function externArgCoercionInstrs(
  ci: CoerceIdxs,
  want: ValType,
  optionalHere: boolean,
  allowObjectCoercion = false,
): Instr[] {
  const { unboxNumIdx, unboxBoolIdx } = ci;
  const out: Instr[] = [];
  if (want.kind === "f64") {
    const omittedAwareIdx = optionalHere ? ci.unboxNumOrOmitted?.() : undefined;
    // (#6619) The checked unbox — armed modules only, byte-identical
    // otherwise — throws for a Symbol/BigInt argument instead of silently
    // answering NaN (§7.1.4 ToNumber).
    const checkedIdx = ci.unboxNumChecked?.();
    if (omittedAwareIdx !== undefined) out.push({ op: "call", funcIdx: omittedAwareIdx });
    else if (checkedIdx !== undefined) out.push({ op: "call", funcIdx: checkedIdx });
    else if (unboxNumIdx !== undefined) out.push({ op: "call", funcIdx: unboxNumIdx });
    else out.push({ op: "drop" }, { op: "f64.const", value: 0 });
  } else if (want.kind === "i32") {
    if ((want as { boolean?: true }).boolean && unboxBoolIdx !== undefined) {
      out.push({ op: "call", funcIdx: unboxBoolIdx });
    } else if (unboxNumIdx !== undefined) {
      out.push({ op: "call", funcIdx: unboxNumIdx });
      out.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      out.push({ op: "drop" }, { op: "i32.const", value: 0 });
    }
  } else if (want.kind === "ref" || want.kind === "ref_null") {
    // (#6615) The lenient marshal when this module armed it; otherwise the
    // unconditional cast, byte for byte.
    const lenientIdx = ci.lenientRefArg?.(want, optionalHere);
    // (#6634 S49) A mixed class+literal-implementer dispatcher arm's opt-in
    // fallback — see `ensureStructFromObjectCoercionHelper`. Only consulted
    // when `lenientRefArg` declined AND the call site passed
    // `allowObjectCoercion`; every other call site keeps the unconditional
    // cast exactly.
    const objIdx = lenientIdx === undefined && allowObjectCoercion ? ci.structFromObject?.(want) : undefined;
    if (lenientIdx !== undefined) {
      out.push({ op: "call", funcIdx: lenientIdx });
    } else if (objIdx !== undefined) {
      out.push({ op: "call", funcIdx: objIdx });
    } else {
      out.push({ op: "any.convert_extern" });
      out.push({ op: "ref.cast", typeIdx: (want as { typeIdx: number }).typeIdx });
    }
  }
  // externref param: already externref — no coercion.
  return out;
}

/** Box a call RESULT already on the stack back to externref. */
export function resultBoxingInstrs(ci: CoerceIdxs, resultType: ValType): Instr[] {
  const { boxNumIdx, boxBoolIdx } = ci;
  const out: Instr[] = [];
  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    out.push({ op: "extern.convert_any" });
  } else if (resultType.kind === "f64") {
    if (boxNumIdx !== undefined) out.push({ op: "call", funcIdx: boxNumIdx });
    else out.push({ op: "drop" }, { op: "ref.null.extern" });
  } else if (resultType.kind === "i32") {
    // (#5241) A BOOLEAN return also lowers to `i32`, and the ValType carries
    // the `boolean` marker the ARGUMENT coercion above already honours. Boxing
    // it as a number answered `1`/`0` where the same call on a TYPED receiver
    // answered `true`/`false` — measured on a plain class,
    // `String(inst.bigger(0))` → `"1"` through this dispatcher, `"true"`
    // direct. Pre-existing; it became reachable for more names once #5241
    // stopped the extern-class hijack from consuming those calls first.
    if ((resultType as { boolean?: true }).boolean && boxBoolIdx !== undefined) {
      out.push({ op: "call", funcIdx: boxBoolIdx });
    } else {
      out.push({ op: "f64.convert_i32_s" });
      if (boxNumIdx !== undefined) out.push({ op: "call", funcIdx: boxNumIdx });
      else out.push({ op: "drop" }, { op: "ref.null.extern" });
    }
  }
  // externref result: no coercion.
  return out;
}
