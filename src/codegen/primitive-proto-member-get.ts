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
 * never reached the boxing site. The axis that decides WHETHER the read works
 * at all is the receiver's static type; the axis that decides WHICH value the
 * accessor sees is strictness (next section).
 *
 * ## The §10.4.3 axis IS load-bearing — and the row that proves it was the one
 * ## not in the failing list
 *
 * A first cut of this arm always handed the accessor the UNBOXED primitive.
 * That passed all three failing rows — `10.4.3-1-{103,104,106}` — and REGRESSED
 * `10.4.3-1-105`, which was *passing on the base for the wrong reason*: it is
 * `noStrict` and asserts `(5).x === 5` is **false** and `typeof (5).x` is
 * `"object"`, both of which a `null` satisfies. Boxing is therefore not
 * optional garnish; the four rows pin all four cells:
 *
 * | row | flags      | asserts                              | `this` must be |
 * | --- | ---------- | ------------------------------------ | -------------- |
 * | 103 | noStrict   | `(5).x == 5`, `(5).x == 0` false     | either (blind) |
 * | 105 | noStrict   | `(5).x === 5` false, typeof "object" | **wrapper**    |
 * | 104 | onlyStrict | `(5).x === 5`                        | **primitive**  |
 * | 106 | onlyStrict | `typeof (5).x` is "number"           | **primitive**  |
 *
 * So the receiver representation is chosen by strictness: `__new_Number` /
 * `__new_Boolean` (a real wrapper `$Object`, `typeof` "object", ToPrimitive
 * recovers the value) in sloppy code, `__box_number` / `__box_boolean` (the
 * primitive carrier) in strict code.
 *
 * ## What decides strictness here, and where the proxy can be wrong
 *
 * §10.4.3 keys on the strictness of the FUNCTION BEING CALLED — the accessor —
 * and the read site cannot know it, because the getter is found by a runtime
 * chain walk. `isStrictContext(expr, …)` on the read site is a proxy: it is
 * exact whenever the read and the accessor share a strictness region, which is
 * every corpus shape (a whole-file `"use strict"`, or none). A sloppy accessor
 * reached from strict code (or the reverse) gets the wrong `this` — a genuine
 * residual, recorded in the issue file. It is not a regression: the base
 * answered `null` for every one of these reads.
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
import { isStrictContext } from "./helpers/is-strict-function.js";
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

  // §10.4.3 — a NON-strict accessor sees the primitive boxed to its wrapper
  // OBJECT; a strict one sees the primitive itself. What decides it is the
  // strictness of the ACCESSOR, which the read site cannot know (the getter is
  // found by a runtime chain walk). The best available proxy is the read's own
  // lexical strictness region: in every corpus shape the read and the accessor
  // sit in the same one — a whole-file `"use strict"` makes both strict, its
  // absence makes both sloppy. `ctx.inferModuleStrictArguments` is the same
  // flag `explicit-null-receiver.ts` uses, and it is what stops the test262
  // harness's synthetic `export function test()` wrapper from reading every
  // sloppy script as strict module code (#2119).
  const strictReceiver = isStrictContext(expr, ctx.inferModuleStrictArguments);

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (boxNumberIdx === undefined) return undefined;
  if (fact.kind === "boolean" && boxBooleanIdx === undefined) return undefined;

  // The ToObject helpers, needed only on the sloppy side. `__new_Boolean` takes
  // an f64 (calls-guards.ts converts the same way).
  let toObjectIdx: number | undefined;
  if (!strictReceiver) {
    const ctorName = fact.kind === "boolean" ? "__new_Boolean" : "__new_Number";
    const lateIdx = ensureLateImport(ctx, ctorName, [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    toObjectIdx = ctx.funcMap.get(ctorName) ?? lateIdx;
    // Absent-not-wrong: with no ToObject helper, answering the strict
    // (unboxed) shape in sloppy code would be a WRONG `this`, so decline and
    // leave the read to the legacy tail. Nothing has been emitted yet.
    if (toObjectIdx === undefined) return undefined;
  }

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
    fctx.body.push(
      toObjectIdx !== undefined ? { op: "call", funcIdx: toObjectIdx } : { op: "call", funcIdx: boxNumberIdx },
    );
  } else if (recvType.kind === "i32") {
    const asBoolean = recvType.boolean === true || fact.kind === "boolean";
    if (toObjectIdx !== undefined) {
      // Both `__new_Number` and `__new_Boolean` take an f64.
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toObjectIdx });
    } else if (asBoolean && boxBooleanIdx !== undefined) {
      // A boolean-branded i32 must box as a Boolean so the walk starts at
      // `Boolean.prototype`; an unbranded i32 is a number in disguise.
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
