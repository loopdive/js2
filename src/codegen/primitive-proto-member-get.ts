// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4668) A property read on a `number` / `boolean` PRIMITIVE receiver must WALK the
 * wrapper prototype chain when the module has put something on it.
 *
 * ## The defect
 *
 * §9.1 (ToObject) + §10.5 (OrdinaryGet): `(5).x` boxes `5` and walks
 * `Number.prototype → Object.prototype`. #4483 taught the codegen the ABSENT
 * case (nothing on the chain ⇒ `undefined`) and deliberately DECLINES the
 * moment the module writes to one of those prototypes — at which point the read
 * fell all the way through `finalizeStructAndDynamicMemberGet` to its terminal
 * `ref.null.extern` placeholder. Measured on this branch's base
 * (`runTest262File(…, "standalone")`, one module per row):
 *
 * | module                                                          | base    | spec        |
 * | --------------------------------------------------------------- | ------- | ----------- |
 * | `Object.defineProperty(Object.prototype,"x",{get(){…}}); (5).x`  | `null`  | getter runs |
 * | `Object.prototype.z = 7; (5).z`                                  | `null`  | `7`         |
 * | `Object.defineProperty(Object.prototype,"x",{get(){…}}); ({}).x` | getter runs | getter runs |
 * | `function f(v){return v.x} … f(5)` (receiver statically `any`)   | getter runs | getter runs |
 *
 * The last two rows are the load-bearing ones: the RUNTIME is already correct.
 * `__extern_get` (object-runtime.ts) handles a boxed-primitive receiver — its
 * chain-exhausted miss arm is receiver-aware (#4160/#4176) and consults the
 * receiver's own brand companion before `Object.prototype`'s. Only the STATIC
 * dispatch was missing: a receiver whose checker type is `number`/`boolean`
 * never reached the boxing site, so the deciding axis is the receiver's static
 * type, not strictness and not the property.
 *
 * ## Why this is not the §10.4.3 primitive-`this` boxing rule
 *
 * `language/function-code/10.4.3-1-{103,104,106}` were grouped as a
 * strictness × this-value-type family. Measured, they are not: with the arm
 * below the getter receives the UNBOXED primitive in both strictness modes,
 * which is right for the two `onlyStrict` rows (104, 106) and is not
 * observable by the non-strict row (103 asserts `== 5` / `== 0`, and a
 * `Number` wrapper and the primitive `5` agree on both). The genuine §10.4.3
 * residual — a NON-strict accessor should see a boxed `Number` — survives and
 * is recorded in the issue file; no ES≤5 row in the corpus detects it.
 *
 * ## Narrowing (absent-not-wrong)
 *
 * - Standalone/WASI only. The JS-host lane has its own `__extern_get` import
 *   and its own receiver conventions; it is not measured here.
 * - The oracle must prove the receiver is exactly `number` or `boolean`. A
 *   boxed `new Number(1)` is an object type and never matches.
 * - The module must actually EXTEND `Number.prototype` / `Boolean.prototype` /
 *   `Object.prototype` ({@link moduleExtendsPrimitiveProtos}). This is the
 *   exact complement of #4483's gate: where that arm can prove the property
 *   absent it keeps its cheap constant fold, and this arm only takes over the
 *   shapes it hands off. A module that touches no primitive prototype compiles
 *   byte-identically.
 * - `WRAPPER_CHAIN_MEMBERS` (`toFixed`, `valueOf`, `length`, …) keep their
 *   existing lowerings.
 * - Not an assignment target, not a `delete` operand, not the CALLEE of a call.
 *   The callee case is a wrong-answer hazard rather than a missing one: the
 *   call lowering owns `this`-binding (measured working today for
 *   `Number.prototype.m = function(){…}; (5).m()`), and this arm can only hand
 *   back a bare function value.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  WRAPPER_CHAIN_MEMBERS,
  isWriteOrDeleteTarget,
  moduleExtendsPrimitiveProtos,
} from "./primitive-absent-property.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, addUnionImports } from "./registry/imports.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { emitRuntimeEvalSharedValueUnwrap } from "./global-environment.js";

/** True when this member expression is the callee of a call — `(5).m()`. */
function isCallCallee(expr: ts.PropertyAccessExpression): boolean {
  const parent = expr.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) && parent.expression === expr) return true;
  if (ts.isNewExpression(parent) && parent.expression === expr) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === expr) return true;
  return false;
}

/**
 * Box a `number`/`boolean` primitive receiver and read `propName` off it
 * through `__extern_get`, or return `undefined` to leave the expression to the
 * existing lowerings.
 */
export function tryEmitPrimitiveProtoMemberGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (ts.isPrivateIdentifier(expr.name)) return undefined;
  if (WRAPPER_CHAIN_MEMBERS.has(propName)) return undefined;
  if (isWriteOrDeleteTarget(expr)) return undefined;
  if (isCallCallee(expr)) return undefined;

  const fact = ctx.oracle.typeFactOf(expr.expression);
  if (fact.kind !== "number" && fact.kind !== "boolean") return undefined;

  // The complement of #4483's gate: only take over when a write to one of the
  // three prototypes makes the chain walk observable.
  if (!moduleExtendsPrimitiveProtos(expr.getSourceFile())) return undefined;

  // ── Everything that can DECLINE happens before a single instruction is
  // emitted. A decline after `compileExpression` would leave the receiver on
  // the operand stack and let the caller emit its own fallback on top of it —
  // an unbalanced body the emitter accepts and the engine rejects. Resolve
  // every helper and constant first, then commit unconditionally.
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return undefined;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (boxNumberIdx === undefined) return undefined;
  if (fact.kind === "boolean" && boxBooleanIdx === undefined) return undefined;

  // Feasibility probe only — the instructions actually emitted are recomputed
  // AFTER the receiver, matching every other `__extern_get` call site: a
  // string-constant accessor can bake a funcIdx, and the receiver's own
  // compilation may shift it.
  addStringConstantGlobal(ctx, propName);
  if (stringConstantExternrefInstrs(ctx, propName).length === 0) return undefined;

  // ── committed ───────────────────────────────────────────────────────────
  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (recvType === null) {
    // Unreachable for a number/boolean fact (the receiver is an expression
    // with a value). Keep the stack balanced rather than declining, so a
    // future receiver shape cannot turn this into a validation failure.
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind === "f64") {
    fctx.body.push({ op: "call", funcIdx: boxNumberIdx });
  } else if (recvType.kind === "i32") {
    // A boolean-branded i32 must box as a Boolean so the walk starts at
    // `Boolean.prototype`; an unbranded i32 is a number in disguise.
    if ((recvType.boolean === true || fact.kind === "boolean") && boxBooleanIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxBooleanIdx });
    } else {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: boxNumberIdx });
    }
  } else if (recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx });
  if (ctx.runtimeEvalGlobalFunctionBindings === true) {
    emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
  }
  // Keep the honest externref: the read's checker type is `any` for every
  // shape this arm admits, and a numeric consumer re-narrows through its own
  // coercion rather than dragging a getter's object result through
  // `__unbox_number`.
  return { kind: "externref" };
}
