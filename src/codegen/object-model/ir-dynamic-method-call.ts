// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 Stage 4, #7117) `__ir_dyn_mcall_<m>_<n>(recv, a0, …) -> externref` —
 * the IR's built-in (or wider than one-argument) method call on a DYNAMIC
 * receiver on the non-fast host-free lanes.
 *
 * The generic `__ir_dyn_method_call_N` → `__extern_method_call` route answers
 * `undefined` for every receiver the native object runtime has no brand arm
 * for (a string, a number, a vec, a Map …): it dispatches open-`$Object`
 * methods only. Legacy, for the same `any`-receiver call site, emits brand
 * dispatch by method name — the native string arm, `__extern_toString`, the
 * reflective `.call`/`.apply`, the vec push/pop arms, the closed-method
 * dispatcher `__call_m_<m>_<n>`.
 *
 * This wrapper is that emission, plus the one step legacy's brand arms skip.
 * Once per (method, arity) it compiles, with legacy's own emitters over a fixed
 * template whose only free names are the wrapper's externref parameters (the
 * dynamic carrier of these lanes, which is legacy's `any`):
 *
 *   f = recv.m                      // the call's single [[Get]]
 *   IsCallable(f) ? f.call(recv, a0, …)   // an own / inherited method value
 *                 : recv.m(a0, …)       // legacy's any-receiver brand dispatch
 *
 * Legacy's brand arms do not consult the receiver for a built-in name — its
 * `join` on any receiver is the generic array-like algorithm, so
 * `{ join() {…} }.join()` and a constructor-prototype `join` were missed. A
 * built-in method of a primitive or vec receiver has no runtime value, so the
 * read answers undefined there and the brand arm runs.
 *
 * The template is a runtime operation, not source: its text is a function of
 * (method, arity) alone, parsed into its own detached file, so legacy's checker
 * queries on it answer "unknown" — the receiver/argument facts of an `any`
 * call site. The callable test is emitted directly (`__is_callable`), not as a
 * template `typeof`: legacy folds `typeof` on a detached node statically.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { irDynamicMethodCallHelperName, irDynamicMethodCallIsNameable } from "../../ir/dynamic-method-call-names.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression, flushLateImportShifts, VOID_RESULT } from "../shared.js";
import { coerceType } from "../type-coercion.js";
import { emitUndefined, ensureLateImport } from "../expressions/late-imports.js";
import { addFuncType } from "../registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { noJsHost } from "../js-errors.js";

const RECEIVER = "__ir_dmc_recv";
const METHOD_VALUE = "__ir_dmc_fn";
const argumentName = (index: number): string => `__ir_dmc_arg${index}`;
const EXTERNREF: ValType = { kind: "externref" };

/**
 * The host-free lanes whose dynamic carrier is legacy's `any` externref (the
 * selector's `dynamic-method-call-wrapper` capability). A host lane's adapter
 * may refuse a legacy import the emitters reach (`__js_array_new` under the
 * native-first kill switch, measured), so it keeps the generic call.
 */
export function irDynamicMethodCallWrapperLane(ctx: CodegenContext): boolean {
  return noJsHost(ctx) && !ctx.fast;
}

interface Template {
  /** `recv.m` */
  readonly read: ts.Expression;
  /** `f.call(recv, a0, …)` */
  readonly own: ts.Expression;
  /** `recv.m(a0, …)` */
  readonly branded: ts.Expression;
}

/** The fixed template, parsed with real positions and parents in a detached file. */
function template(method: string, arity: number): Template {
  const args = Array.from({ length: arity }, (_, index) => argumentName(index));
  const text =
    `function __ir_dmc(${[RECEIVER, ...args].join(", ")}) {\n` +
    `  ${RECEIVER}.${method};\n` +
    `  ${METHOD_VALUE}.call(${[RECEIVER, ...args].join(", ")});\n` +
    `  ${RECEIVER}.${method}(${args.join(", ")});\n` +
    `}`;
  const file = ts.createSourceFile("__ir_dyn_mcall.js", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const fn = file.statements[0];
  const statements = fn && ts.isFunctionDeclaration(fn) ? fn.body?.statements : undefined;
  const expressions = statements?.map((statement) =>
    ts.isExpressionStatement(statement) ? statement.expression : undefined,
  );
  const [read, own, branded] = expressions ?? [];
  if (!read || !own || !branded || expressions?.length !== 3) {
    throw new Error(`ir/dynamic-method-call: template did not parse for ${method}/${arity}`);
  }
  return { read, own, branded };
}

/** Compile one template expression as an externref value onto `helper.body`. */
function compileExtern(ctx: CodegenContext, helper: FunctionContext, expression: ts.Expression): void {
  const result = compileExpression(ctx, helper, expression, EXTERNREF);
  if (result === null || (result as unknown) === VOID_RESULT) emitUndefined(ctx, helper);
  else if (result.kind !== "externref") coerceType(ctx, helper, result, EXTERNREF);
}

/**
 * Compile one branch into a detached sequence. Every completed sequence stays
 * parked in `savedBodies` until the join, so a late import registered by a
 * later branch still shifts its call indices.
 */
function compileBranch(
  ctx: CodegenContext,
  helper: FunctionContext,
  expression: ts.Expression,
  parked: Instr[][],
): Instr[] {
  helper.body = [];
  compileExtern(ctx, helper, expression);
  const branch = helper.body;
  helper.savedBodies.push(branch);
  parked.push(branch);
  // The live body is never also parked: one shift walk per sequence.
  helper.body = [];
  return branch;
}

/**
 * Reserve (once per method/arity) the wrapper. Returns its function index, or
 * undefined off the wrapper lanes or when legacy's emitter reports an error for
 * the template (its diagnostics are dropped; the IR call site's preparation
 * then fails cleanly).
 */
export function ensureIrDynamicMethodCallHelper(
  ctx: CodegenContext,
  method: string,
  arity: number,
): number | undefined {
  if (!irDynamicMethodCallWrapperLane(ctx) || !irDynamicMethodCallIsNameable(method, arity)) return undefined;
  const name = irDynamicMethodCallHelperName(method, arity);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const params = [RECEIVER, ...Array.from({ length: arity }, (_, index) => argumentName(index))].map((param) => ({
    name: param,
    type: EXTERNREF,
  }));
  const methodValue = params.length;
  const helper: FunctionContext = {
    name,
    params,
    locals: [{ name: METHOD_VALUE, type: EXTERNREF }],
    localMap: new Map([...params.map((param, index) => [param.name, index] as const), [METHOD_VALUE, methodValue]]),
    returnType: EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const { read, own, branded } = template(method, arity);
  const errorsBefore = ctx.errors.length;

  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, helper);
  compileExtern(ctx, helper, read);
  helper.body.push({ op: "local.set", index: methodValue });
  const isCallable = ctx.funcMap.get("__is_callable");
  if (isCallable === undefined) throw new Error("ir/dynamic-method-call: __is_callable is not registered");
  helper.body.push({ op: "local.get", index: methodValue }, { op: "call", funcIdx: isCallable });

  const outer = helper.body;
  helper.savedBodies.push(outer);
  const parked: Instr[][] = [outer];
  helper.body = [];
  const ownBranch = compileBranch(ctx, helper, own, parked);
  const brandedBranch = compileBranch(ctx, helper, branded, parked);
  flushLateImportShifts(ctx, helper);
  helper.savedBodies.splice(helper.savedBodies.length - parked.length, parked.length);
  helper.body = outer;
  helper.body.push({ op: "if", blockType: { kind: "val", type: EXTERNREF }, then: ownBranch, else: brandedBranch });

  if (ctx.errors.length !== errorsBefore) {
    ctx.errors.length = errorsBefore;
    return undefined;
  }
  flushLateImportShifts(ctx, helper);
  const typeIdx = addFuncType(
    ctx,
    params.map((param) => param.type),
    [EXTERNREF],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: helper.locals, body: helper.body, exported: false });
  return funcIdx;
}
