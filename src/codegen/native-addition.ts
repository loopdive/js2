// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Whole addition owns operand evaluation and ordered primitive conversion. */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import { addOperandCallableSourceText, emitAddOrdinaryToPrimitiveResidue } from "./add-to-primitive.js";
import { admitsObjectAddition } from "./addition-to-primitive.js";
import { callableToStringLiteral } from "./callable-to-string.js";
import { getExternrefToStringProvider } from "./coercion-engine.js";
import { addStringConstantGlobal, localGlobalIdx } from "./registry/imports.js";
import { stringConstantExternrefInstrs, ensureNativeStringHelpers } from "./native-strings.js";
import { resolveStructNameForExpr, resolveStructName } from "./property-access.js";
import { compileExpression, coerceType, flushLateImportShifts } from "./shared.js";
import { addUnionImports } from "./index.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./expressions/helpers.js";
import { collectConcatOperands } from "./native-batched-concat.js";
import { compileStringBinaryOp } from "./string-ops.js";
import { readEnv } from "../env.js";

// (#3753 S2) An `any`-typed operand the whole-program fixpoint already PROVED
// numeric is not really `any` for arithmetic purposes. Inside a fnctor
// prototype method `this` is untyped, so `this.acc + this.nextCode()` reads
// as any+any and routes to the generic `__any_add` — boxing BOTH operands
// into `$AnyValue` and tag-dispatching the result back out, five box/unbox
// operations per iteration on values that are f64 on both sides (#3753).
//
// `numericPropertyNames` (#3683 S4a) and `numericFunctionNames` are verdicts
// from the same fixpoint that already gave `this.acc` a physical f64 slot —
// so trusting them here is consistent with the representation those fields
// ALREADY have, not a new claim. Standalone-only, like the verdicts.
export function provenNumericOperand(ctx: CodegenContext, e: ts.Expression): boolean {
  if (!ctx.standalone || readEnv("JS2WASM_NUMERIC_OPERANDS") === "0") return false;
  const bare = ts.isParenthesizedExpression(e) ? e.expression : e;
  // `this.f` where every write to `f` is numeric.
  if (
    ts.isPropertyAccessExpression(bare) &&
    bare.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ctx.numericPropertyNames?.has(bare.name.text) === true
  ) {
    return true;
  }
  // `<recv>.m()` where `m` provably returns a number on every path.
  //
  // (#3744) The receiver is deliberately NOT constrained to `this`. The
  // verdict is a WHOLE-PROGRAM property of the method NAME — "every function
  // named `m` returns a number on every path" — so it holds for any
  // receiver. Restricting it to `this` was an accident of where #3753 was
  // measured (a tokenizer, whose calls are all `this.next()`); the `method`
  // axis calls `p.inc()` on a plain local and got none of the benefit.
  if (
    ts.isCallExpression(bare) &&
    ts.isPropertyAccessExpression(bare.expression) &&
    ctx.numericFunctionNames?.has(bare.expression.name.text) === true
  ) {
    return true;
  }
  return false;
}

/**
 * An `any`-typed operand whose LOCAL representation is already numeric, so
 * `+` over it cannot concatenate: a numeric (non-BigInt) local, or `.length` of
 * a local that inference typed as a native string. The native-first any-add
 * admission below otherwise boxes `input.length + 1` through the generic
 * `ToPrimitive` addition (~35x slower on the npm-compat react/standalone lane).
 */
function representationallyNumericOperand(ctx: CodegenContext, fctx: FunctionContext, e: ts.Expression): boolean {
  let bare = e;
  while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
  const localTypeOf = (node: ts.Expression): ValType | undefined => {
    if (!ts.isIdentifier(node)) return undefined;
    const index = fctx.localMap.get(node.text);
    return index === undefined ? undefined : getLocalType(fctx, index);
  };
  if (ts.isIdentifier(bare)) {
    const type = localTypeOf(bare);
    return type?.kind === "f64" || type?.kind === "i32";
  }
  if (ts.isPropertyAccessExpression(bare) && bare.name.text === "length") {
    const type = localTypeOf(bare.expression);
    if (type?.kind !== "ref" && type?.kind !== "ref_null") return false;
    return (
      type.typeIdx >= 0 &&
      (type.typeIdx === ctx.anyStrTypeIdx ||
        type.typeIdx === ctx.nativeStrTypeIdx ||
        type.typeIdx === ctx.consStrTypeIdx)
    );
  }
  return false;
}

/**
 * An `any` operand that is a number at runtime: proven by the whole-program
 * numeric facts, or already held in an f64/i32 local (untyped JS parameters
 * get numeric locals from their call sites). Such an operand needs neither the
 * AnyValue tag dispatch nor the generic any-add lane.
 */
export function numericAnyOperand(ctx: CodegenContext, fctx: FunctionContext, e: ts.Expression): boolean {
  return provenNumericOperand(ctx, e) || representationallyNumericOperand(ctx, fctx, e);
}

/** Admit any/unknown operands through the existing host or native string-capable addition lane. */
export function admitsAnyAdditionOperands(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  left: ts.Type,
  right: ts.Type,
): boolean {
  if (
    ctx.anyValueTypeIdx < 0 ||
    (ctx.targetProfile.semanticProviders === "native-first" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0)
  ) {
    // The earlier AnyValue arm uses the whole-program numeric proof only for
    // nonnegative indices; keep that admission unchanged.
    const usesGroundedProof = ctx.anyValueTypeIdx >= 0;
    // An operand already held in an f64/i32 local is a number whatever its
    // checker type, so the generic lane would only box it, run a no-op
    // ToPrimitive and add numerically — identical to the f64 lowering. This
    // holds without an AnyValue type too: standalone native-first builds
    // (anyValueTypeIdx < 0) give untyped JS parameters numeric locals from
    // their call sites, and previously boxed both of them on every `a + b`.
    const numeric = (operand: ts.Expression): boolean =>
      representationallyNumericOperand(ctx, fctx, operand) || (usesGroundedProof && provenNumericOperand(ctx, operand));
    const leftIsAnyish = (left.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 && !numeric(expr.left);
    const rightIsAnyish = (right.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 && !numeric(expr.right);
    return leftIsAnyish || rightIsAnyish;
  }
  return false;
}

/**
 * (#2358) A typed object literal / class instance compiles to a NOMINAL WasmGC
 * struct (`__anon_N` / `ClassName`), whose concrete `typeIdx` carries the static
 * `valueOf` / `@@toPrimitive` the `coerceType(ref-struct → f64)` engine
 * (`type-coercion.ts:1723`) can dispatch at compile time. The moment that struct
 * is coerced to externref (`extern.convert_any`), the typeIdx is erased and the
 * standalone native `__to_primitive` helper — which only recognises the dynamic
 * `$Object` runtime struct via `ref.test objectTypeIdx` — can no longer reduce
 * it (it returns the object unchanged → caller `__unbox_number` → NaN/null).
 *
 * So when an `emitAnyAdd` operand is a nominal struct with a *static*
 * number-producing ToPrimitive (a `valueOf` or `@@toPrimitive`), reduce it to a
 * primitive HERE, while the typeIdx is still known, reusing the single #1917
 * coercion engine — then box. The result is an already-primitive externref, so
 * the later `__to_primitive` call in the §13.15.3 dispatch is a no-op on it.
 *
 * Scoped to valueOf/@@toPrimitive (number-producing) only: a `toString`-only
 * struct stays on the existing `extern.convert_any` path (no behaviour change),
 * because the f64 reduction would lossily NaN a string-returning `toString`.
 */
function structHasStaticNumericToPrimitive(ctx: CodegenContext, name: string | undefined): boolean {
  if (name === undefined || !ctx.structMap.has(name)) return false;
  // Class / standalone-function form: ClassName_@@toPrimitive / ClassName_valueOf.
  if (ctx.funcMap.get(`${name}_@@toPrimitive`) !== undefined) return true;
  if (ctx.funcMap.get(`${name}_valueOf`) !== undefined) return true;
  // Object-literal form: a `valueOf` field holding a callable zero-arg closure
  // tracked for this struct (the eqref/ref closure path coerceType dispatches).
  const fields = ctx.structFields.get(name);
  if (fields) {
    const vof = fields.find((f) => f.name === "valueOf");
    if (vof) {
      const tracked = ctx.valueOfClosureTypes.get(name);
      if (tracked && tracked.length > 0) return true;
      // A `valueOf` field holding a closure ref is still reduced by the static
      // engine's closure-ref subpath even without separately-tracked types.
      if (vof.type.kind === "ref" || vof.type.kind === "ref_null" || vof.type.kind === "eqref") return true;
    }
  }
  return false;
}

/**
 * (#2358) Compile one `+` operand into a fresh externref temp and return its
 * index (or null if the operand failed to compile).
 *
 * The common case keeps the status-quo `{externref}` expectedType, which keeps a
 * runtime string boxed (no ToNumber coercion) so §13.15.3 can concatenate —
 * byte-identical to before. The ONLY divergence is when the operand statically
 * resolves (through `as`/parenthesized/non-null wrappers) to a NOMINAL object
 * struct with a number-producing ToPrimitive (`valueOf`/`@@toPrimitive`): then it
 * is compiled WITHOUT the hint and saved with its concrete `typeIdx`. Its
 * shared-engine conversion is deferred until both source expressions finish,
 * while the exact physical type remains available. Crossing the externref boundary unreduced would strand the struct
 * — the native `__to_primitive` helper only recognises the dynamic `$Object`, so
 * it passes a nominal struct through → `__unbox_number` → NaN/null.
 *
 * Scoped to valueOf/@@toPrimitive (number-producing) so the §13.15.3 string-vs-
 * numeric decision still sees the right primitive; a `toString`-only struct stays
 * on the existing boxed-externref path (string concat unaffected).
 */
interface DeferredAddOperand {
  readonly rawLocal: number;
  readonly rawType: ValType;
  readonly targetLocal: number;
  readonly callableText?: string;
}

function saveDeferredAddOperand(
  fctx: FunctionContext,
  rawType: ValType,
  deferred: DeferredAddOperand[],
  callableText?: string,
): number {
  const rawLocal = allocTempLocal(fctx, rawType);
  const targetLocal = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: rawLocal });
  deferred.push({ rawLocal, rawType, targetLocal, callableText });
  return targetLocal;
}

function emitAddOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  deferred: DeferredAddOperand[],
  callableText?: string,
): number | null {
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";
  if (noJsHost && callableText !== undefined) {
    // Match the existing concat operand's physical-carrier check. Evaluate the
    // original expression once, even when its callable has no closure carrier;
    // defer its established NativeFunction rendering until both sides exist.
    const opType = compileExpression(ctx, fctx, expr);
    if (!opType) return null;
    const isReference = opType.kind === "externref" || opType.kind === "ref" || opType.kind === "ref_null";
    return saveDeferredAddOperand(fctx, opType, deferred, isReference ? callableText : undefined);
  }
  // Unwrap `as`/parenthesized/non-null/satisfies wrappers (e.g. `(o as any)`):
  // the wrappers are type-only / identity, but they make TS report the operand
  // type as `any` (so the struct name can't be resolved) and make
  // `compileExpression` coerce the struct to externref internally (erasing the
  // typeIdx). Resolving + compiling the UNWRAPPED inner expression recovers both.
  let inner: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = (inner as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  // (#4491 T4) §20.2.3.5 step 1 — a top-level function operand reduces to its
  // captured SOURCE TEXT, the same string `fn.toString()` already returns
  // (#1463). Materialize it here so the two spellings agree; without this the
  // runtime residue fallback answers step 3's NativeFunction placeholder and
  // `f1 + 1 === f1.toString() + 1` is false. See add-to-primitive.ts for the
  // four guards that keep the fold honest.
  const callableSource = addOperandCallableSourceText(ctx, fctx, inner);
  if (callableSource !== undefined) {
    addStringConstantGlobal(ctx, callableSource);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, callableSource));
    const srcTmp = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: srcTmp });
    return srcTmp;
  }
  let structName = noJsHost ? resolveStructNameForExpr(ctx, fctx, inner) : undefined;
  if (noJsHost && structName === undefined && ts.isIdentifier(inner)) {
    const localIdx = fctx.localMap.get(inner.text);
    const localType =
      localIdx === undefined
        ? undefined
        : localIdx < fctx.params.length
          ? fctx.params[localIdx]?.type
          : fctx.locals[localIdx - fctx.params.length]?.type;
    if (localType?.kind === "ref" || localType?.kind === "ref_null") {
      structName = ctx.typeIdxToStructName.get(localType.typeIdx);
    }
    if (structName === undefined) {
      const declaration = ctx.checker.getSymbolAtLocation(inner)?.valueDeclaration;
      const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      if (initializer) {
        structName = resolveStructName(ctx, ctx.checker.getTypeAtLocation(initializer));
        if (structName === undefined && ts.isObjectLiteralExpression(initializer)) {
          const memberNames = initializer.properties
            .map((member) => {
              if (ts.isShorthandPropertyAssignment(member)) return member.name.text;
              if (
                (ts.isPropertyAssignment(member) ||
                  ts.isMethodDeclaration(member) ||
                  ts.isGetAccessorDeclaration(member) ||
                  ts.isSetAccessorDeclaration(member)) &&
                (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))
              ) {
                return member.name.text;
              }
              return undefined;
            })
            .filter((name): name is string => name !== undefined)
            .sort();
          for (const [candidate, fields] of ctx.structFields) {
            const fieldNames = fields.map((field) => field.name).sort();
            if (
              fieldNames.length === memberNames.length &&
              fieldNames.every((name, index) => name === memberNames[index])
            ) {
              structName = candidate;
              break;
            }
          }
        }
      }
    }
  }
  if (noJsHost && structHasStaticNumericToPrimitive(ctx, structName)) {
    const opType = compileExpression(ctx, fctx, inner);
    if (!opType) return null;
    // Save the physical value without invoking user conversion. Both source
    // expressions must finish before either operand's ToPrimitive runs.
    return saveDeferredAddOperand(fctx, opType, deferred);
  }

  // Status-quo path: externref hint keeps runtime strings boxed for §13.15.3.
  const opType = compileExpression(ctx, fctx, expr, { kind: "externref" });
  if (!opType) return null;
  if (opType.kind !== "externref") {
    coerceType(ctx, fctx, opType, { kind: "externref" });
  }
  const tmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/** Materialize one saved operand at its ordered conversion point. */
function finishDeferredAddOperand(ctx: CodegenContext, fctx: FunctionContext, operand: DeferredAddOperand): void {
  const { rawLocal, rawType, targetLocal } = operand;
  if (operand.callableText !== undefined) {
    addStringConstantGlobal(ctx, operand.callableText);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, operand.callableText));
  } else {
    fctx.body.push({ op: "local.get", index: rawLocal });
    if (rawType.kind === "ref" || rawType.kind === "ref_null") {
      coerceType(ctx, fctx, rawType, { kind: "f64" }, "default");
      addUnionImports(ctx);
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
      else coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
    } else if (rawType.kind !== "externref") {
      coerceType(ctx, fctx, rawType, { kind: "externref" });
    }
  }
  fctx.body.push({ op: "local.set", index: targetLocal });
  releaseTempLocal(fctx, rawLocal);
}

/**
 * (#2058) Emit `+` for two operands where at least one is a dynamic externref
 * (an `any`/`unknown`/boxed value). The operands are already on the Wasm stack
 * (left below right). Per §13.15.3 ApplyStringOrNumericBinaryOperator a runtime
 * string on either side must CONCATENATE, not coerce to f64 — so we cannot take
 * the externref-numeric f64 fast path.
 *
 * JS-host mode delegates to `__host_add` (JS `+`), which gives ToPrimitive, the
 * string-if-either-is-string rule, and object valueOf/toString ordering for
 * free. Standalone/WASI has no JS host, so we build the operation in-module from
 * the union-native typeof/unbox probes + native string concat. If neither host
 * nor native-string support is available we fall back to the legacy f64 add
 * (status quo — no regression).
 *
 * Returns the value type left on the stack (`externref` for the host/native
 * paths — a boxed number-or-string the caller stores into the `any` slot — or
 * `f64` for the legacy numeric fallback).
 */
export function emitAnyAdd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  callableText?: readonly [string | undefined, string | undefined],
): ValType {
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";

  // #1988: in standalone/WASI the §13.15.3 string-vs-numeric decision must be
  // made on the ToPrimitive(default) results, not the raw operands — an object
  // or array reduces (valueOf→toString) to a STRING, which forces string
  // concatenation. The native `__to_primitive` helper that performs that
  // reduction is registered by `ensureObjectRuntime`. Run it here, BEFORE the
  // operands are compiled into `fctx.body`, so any one-time funcIdx setup it
  // does cannot desync the current function body. It registers only defined
  // funcs (no import shift) and is idempotent, so this is a no-op when the
  // object runtime is already present.
  if (noJsHost && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureObjectRuntime(ctx);
  }

  // Evaluate both expressions once. Nominal values requiring static reduction
  // retain their actual physical type in a raw local; the ordered runtime
  // reduction below performs that conversion only after RHS evaluation.
  const deferred: DeferredAddOperand[] = [];
  const lTmp = emitAddOperand(ctx, fctx, expr.left, deferred, callableText?.[0]);
  if (lTmp === null) return { kind: "externref" };
  const rTmp = emitAddOperand(ctx, fctx, expr.right, deferred, callableText?.[1]);
  if (rTmp === null) {
    for (const operand of deferred) releaseTempLocal(fctx, operand.rawLocal);
    releaseTempLocal(fctx, lTmp);
    return { kind: "externref" };
  }
  return emitAnyAddFromExternTemps(ctx, fctx, lTmp, rTmp, deferred);
}

/**
 * (#3673) The §13.15.3 `+` dispatch for two operands ALREADY evaluated into
 * externref temps — the temps-based twin of {@link emitAnyAdd}, mirroring
 * `emitAnyEqFromExternTemps`.
 *
 * Split out because the compound `obj.prop += rhs` lowering
 * (`operator-assignment.ts`) has no `ts.BinaryExpression` to hand `emitAnyAdd`:
 * its left operand is the value it just READ back out of the property. The host
 * lane could paper over that by calling `__host_add` directly (#2850), but the
 * standalone lane has no such import, so it was left on an unconditional
 * numeric `f64.add` — which silently NaN'd every dynamic string `+=`.
 *
 * Consumes (and releases) both temps; returns the ValType left on the stack —
 * `externref` on the real dispatch, `f64` on the no-native-strings fallback.
 */
export function emitAnyAddFromExternTemps(
  ctx: CodegenContext,
  fctx: FunctionContext,
  lTmp: number,
  rTmp: number,
  deferred: readonly DeferredAddOperand[] = [],
): ValType {
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";

  // ── JS-host: JS `+` via __host_add ──
  if (!noJsHost) {
    fctx.body.push({ op: "local.get", index: lTmp });
    fctx.body.push({ op: "local.get", index: rTmp });
    releaseTempLocal(fctx, rTmp);
    releaseTempLocal(fctx, lTmp);
    const hostIdx = ensureLateImport(
      ctx,
      "__host_add",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalIdx = ctx.funcMap.get("__host_add") ?? hostIdx;
    if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __host_add");
    fctx.body.push({ op: "call", funcIdx: finalIdx });
    return { kind: "externref" };
  }

  // ── Standalone / WASI: build §13.15.3 in-module ──
  // Requires native-string support for the concat arm; otherwise fall back.
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureNativeStringHelpers(ctx);
    addUnionImports(ctx);
    const typeofStr = ctx.funcMap.get("__typeof_string");
    const unboxNum = ctx.funcMap.get("__unbox_number");
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
    // #1988: the native ToPrimitive helper registered by `ensureObjectRuntime`
    // (called at the top of this function). Reducing the operands to primitives
    // BEFORE the string-vs-numeric test is what §13.15.3 requires — an object /
    // array operand becomes its toString string, forcing concatenation. When it
    // is unavailable (older minimal standalone path) we degrade to the previous
    // raw-operand dispatch rather than failing.
    if (typeofStr !== undefined && unboxNum !== undefined && concatIdx !== undefined) {
      // ToString(externref) → ref $AnyString, via the runtime walker (handles
      // boxed strings, numbers, null/undefined, and struct valueOf/toString).
      ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);

      // §13.15.3 step 1-2: lprim = ToPrimitive(left, default); rprim =
      // ToPrimitive(right, default). The "default" hint maps to valueOf→toString
      // ordering; `__to_primitive` treats a null hint as default. Plain objects
      // and arrays (no exotic valueOf) reduce to their toString string, so the
      // string test below then forces concatenation. Reduce into fresh temps so
      // both the typeof test and the two arms operate on the SAME primitives
      // (no double-evaluation of valueOf/toString).
      const lPrim = allocTempLocal(fctx, { kind: "externref" });
      const rPrim = allocTempLocal(fctx, { kind: "externref" });
      for (const [source, destination] of [
        [lTmp, lPrim],
        [rTmp, rPrim],
      ] as const) {
        const saved = deferred.find((operand) => operand.targetLocal === source);
        if (saved) finishDeferredAddOperand(ctx, fctx, saved);
        // Static conversion can acquire providers and shift imports. Read the
        // canonical mappings again after it; never retain a provisional index.
        const currentToPrim = ctx.funcMap.get("__to_primitive");
        const currentToString = getExternrefToStringProvider(ctx);
        fctx.body.push({ op: "local.get", index: source });
        if (currentToPrim !== undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "call", funcIdx: currentToPrim });
        }
        fctx.body.push({ op: "local.set", index: destination });
        // Finish the left conversion before starting the right, including the
        // nominal/callable residue. Both expressions have already evaluated.
        if (currentToPrim !== undefined && currentToString !== undefined) {
          emitAddOrdinaryToPrimitiveResidue(ctx, fctx, destination, currentToString);
        }
      }

      if (ctx.symbolTypeIdx >= 0) {
        // Both operands have evaluated and completed ToPrimitive. Preserve a
        // right conversion's exception before refusing a left Symbol, as JS +
        // requires. Acquire/flush the error producer before caching branch ids.
        const symbolError = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value", { flush: fctx });
        fctx.body.push(
          { op: "local.get", index: lPrim },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
          { op: "local.get", index: rPrim },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
          { op: "i32.or" },
          { op: "if", blockType: { kind: "empty" }, then: symbolError, else: [] },
        );
      }
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const liveToString = getExternrefToStringProvider(ctx);
      const liveTypeofString = ctx.funcMap.get("__typeof_string");
      const liveUnboxNumber = ctx.funcMap.get("__unbox_number");
      const liveConcat = ctx.nativeStrHelpers.get("__str_concat");
      const finalBoxNum = ctx.funcMap.get("__box_number");
      if (
        liveToString === undefined ||
        liveTypeofString === undefined ||
        liveUnboxNumber === undefined ||
        liveConcat === undefined ||
        finalBoxNum === undefined
      )
        throw new Error("Native addition lost its canonical providers");
      const emitToAnyString = (tmp: number): Instr[] => [
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: liveToString },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      ];

      // if (__typeof_string(lprim) | __typeof_string(rprim)) → concat both as
      //                                            strings
      //                                      else            → f64.add(unbox, unbox)
      const concatArm: Instr[] = [
        ...emitToAnyString(lPrim),
        ...emitToAnyString(rPrim),
        { op: "call", funcIdx: liveConcat },
        { op: "extern.convert_any" },
      ];
      const numericArm: Instr[] = [
        { op: "local.get", index: lPrim },
        { op: "call", funcIdx: liveUnboxNumber },
        { op: "local.get", index: rPrim },
        { op: "call", funcIdx: liveUnboxNumber },
        { op: "f64.add" },
      ];
      // Box the numeric arm's f64 result back to externref so both arms agree.
      numericArm.push({ op: "call", funcIdx: finalBoxNum! });

      fctx.body.push({ op: "local.get", index: lPrim });
      fctx.body.push({ op: "call", funcIdx: liveTypeofString });
      fctx.body.push({ op: "local.get", index: rPrim });
      fctx.body.push({ op: "call", funcIdx: liveTypeofString });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: concatArm,
        else: numericArm,
      });
      releaseTempLocal(fctx, rPrim);
      releaseTempLocal(fctx, lPrim);
      releaseTempLocal(fctx, rTmp);
      releaseTempLocal(fctx, lTmp);
      return { kind: "externref" };
    }
  }

  // ── Fallback: no host, no native strings → legacy f64 add (status quo) ──
  // Keep its existing conversion behavior, after both source evaluations and
  // in operand order, even when no complete native string graph is present.
  for (const source of [lTmp, rTmp]) {
    const saved = deferred.find((operand) => operand.targetLocal === source);
    if (saved) finishDeferredAddOperand(ctx, fctx, saved);
    fctx.body.push({ op: "local.get", index: source });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
  }
  releaseTempLocal(fctx, rTmp);
  releaseTempLocal(fctx, lTmp);
  fctx.body.push({ op: "f64.add" });
  return { kind: "f64" };
}

/** Operators whose result is a Number or BigInt, whatever their operands are. */
const NUMERIC_RESULT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/** A local or module binding whose physical slot can only hold a primitive (native string, number, boolean). */
function primitiveBindingSlot(ctx: CodegenContext, fctx: FunctionContext, node: ts.Identifier): boolean {
  const localIdx = fctx.localMap.get(node.text);
  let type: ValType | undefined;
  if (localIdx !== undefined) type = getLocalType(fctx, localIdx);
  else {
    const globalIdx = ctx.moduleGlobals.get(node.text);
    if (globalIdx !== undefined) type = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
  }
  // i32 slots hold numbers or booleans; i64 (BigInt) is deliberately excluded.
  if (type?.kind === "f64" || type?.kind === "i32") return true;
  if (type?.kind !== "ref" && type?.kind !== "ref_null") return false;
  return (
    type.typeIdx >= 0 &&
    (type.typeIdx === ctx.anyStrTypeIdx || type.typeIdx === ctx.nativeStrTypeIdx || type.typeIdx === ctx.consStrTypeIdx)
  );
}

/**
 * Positive proof only: annotations and names cannot establish values. With a
 * function context, a binding whose physical slot is a native string, f64 or i32 is
 * primitive by representation (not by its declared type).
 */
export function isPrimitiveConcatProducer(
  expression: ts.Expression,
  ctx?: CodegenContext,
  fctx?: FunctionContext,
): boolean {
  let node = expression;
  let asserted = false;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    if (!ts.isParenthesizedExpression(node)) asserted = true;
    node = node.expression;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return true;
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  // An assertion (`n as string`) makes the chain's static string type a lie:
  // numeric slots must then keep the dynamic `+` dispatch.
  if (ctx && fctx && ts.isIdentifier(node)) return !asserted && primitiveBindingSlot(ctx, fctx, node);
  // These operators produce primitive values even when their operand evaluates
  // an object. Evaluation (including throws) still occurs at its original node.
  if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node))
    return (
      node.operator === ts.SyntaxKind.ExclamationToken ||
      // Unary `+` is ToNumber (throws on BigInt), so it always yields a Number.
      node.operator === ts.SyntaxKind.PlusToken ||
      isPrimitiveConcatProducer(node.operand, ctx, fctx)
    );
  if (ts.isConditionalExpression(node))
    return isPrimitiveConcatProducer(node.whenTrue, ctx, fctx) && isPrimitiveConcatProducer(node.whenFalse, ctx, fctx);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    // Arithmetic and bitwise operators apply ToNumeric at their own node. With
    // a Number literal operand (or `>>>`), mixing in a BigInt throws there, so
    // the result is a Number even over object operands (`seed % 7`).
    if (
      NUMERIC_RESULT_OPERATORS.has(op) &&
      (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        ts.isNumericLiteral(node.left) ||
        ts.isNumericLiteral(node.right))
    )
      return true;
    // Otherwise only recursively primitive operands earn batching. Unknown
    // operations (assignment, comma, comparison of objects) decline.
    if (
      NUMERIC_RESULT_OPERATORS.has(op) ||
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return isPrimitiveConcatProducer(node.left, ctx, fctx) && isPrimitiveConcatProducer(node.right, ctx, fctx);
    }
  }
  return false;
}

/** Preserve cached source types while choosing ordered addition or the existing string operation. */
export function compileStringBinaryOpWithNativeAddition(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  leftType: ts.Type,
  rightType: ts.Type,
): ValType | null {
  if (
    op !== ts.SyntaxKind.PlusToken ||
    !noJsHost(ctx) ||
    !ctx.nativeStrings ||
    ctx.anyStrTypeIdx < 0 ||
    collectConcatOperands(ctx, expr).every((operand) => isPrimitiveConcatProducer(operand, ctx, fctx))
  )
    return compileStringBinaryOp(ctx, fctx, expr, op);
  // The existing object-addition arm declines callables whose runtime closure
  // carrier is unproved (builtins, reassigned bindings, callable Proxies).
  // Preserve their existing concat rendering per operand, without sending a
  // dynamic sibling back through string-hint conversion or flattening a chain.
  const callableText = (operand: ts.Expression, type: ts.Type): string | undefined => {
    const text = callableToStringLiteral(type);
    return text !== undefined && !admitsObjectAddition(ctx, type, type, operand, operand) ? text : undefined;
  };
  // Return the runtime representation, not the type asserted on the source.
  return emitAnyAdd(ctx, fctx, expr, [callableText(expr.left, leftType), callableText(expr.right, rightType)]);
}
