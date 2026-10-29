// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 Stage 4, #7119) `__ir_dyn_mcall_<m>_<n>(recv, a0, …) -> externref` —
 * the IR's built-in (or wider than one-argument) method call on a DYNAMIC
 * receiver on the non-fast host-free lanes.
 *
 * The generic `__ir_dyn_method_call_N` → `__extern_method_call` route answers
 * `undefined` for every receiver the native object runtime has no brand arm
 * for (a string, a number, a vec …): it dispatches open-`$Object` methods
 * only. Legacy, for the same `any`-receiver call site, emits brand dispatch by
 * method name — the native string arm, `__extern_toString`, the reflective
 * `.call`/`.apply`, the vec push/pop arms, the closed-method dispatcher
 * `__call_m_<m>_<n>`. This wrapper is that emission plus the steps legacy's
 * brand arms skip. Once per (method, arity) it compiles, with legacy's own
 * emitters over a fixed template whose only free names are its externref
 * parameters (the dynamic carrier of these lanes, which is legacy's `any`):
 *
 *   f = recv.m
 *   IsCallable(f)   ? f.call(recv, a0, …)   // an own / inherited method value
 *   : f === undefined ? recv.m(a0, …)       // legacy's any-receiver brand dispatch
 *                     : throw TypeError     // a non-callable own property
 *
 * Legacy's brand arms do not consult the receiver for a built-in name — its
 * `join` on any receiver is the generic array-like algorithm, so
 * `{ join() {…} }.join()` and a constructor-prototype `join` were missed, and
 * `{ join: 1 }.join()` ran the algorithm instead of throwing (measured). A
 * built-in method of a primitive or vec receiver has no runtime value, so the
 * read answers undefined there and the brand arm runs.
 *
 * Known limit: the brand arm is legacy's `recv.m(…)`, which performs its own
 * [[Get]] — an accessor `m` whose getter answers undefined runs twice.
 *
 * The template is a runtime operation, not source: its text is a function of
 * (method, arity) alone, parsed into its own detached file, so legacy's checker
 * queries on it answer "unknown" — the facts of an `any` call site. The
 * callable test is emitted directly (`__is_callable`): legacy folds a template
 * `typeof` on a detached node statically (measured: `i32.const 0`).
 */
import type { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { flushLateImportShifts } from "../shared.js";
import { ensureLateImport } from "../expressions/late-imports.js";
import { emitThrowTypeError, noJsHost } from "../js-errors.js";
import { captureReceiverSequence } from "../ir-dynamic-construct.js";
import { helperFunctionContext, publishHelperFunction } from "../helpers/ir-helper-function.js";
import { compileTemplateExpressionAs as compileAs, parseDetachedTemplate } from "../helpers/template-wrapper.js";

const RECEIVER = "__ir_dmc_recv";
const METHOD_VALUE = "__ir_dmc_fn";
const argumentName = (index: number): string => `__ir_dmc_arg${index}`;
const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

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
  /** `f === undefined` */
  readonly missing: ts.Expression;
}

/** The fixed template, parsed with real positions and parents in a detached file. */
function template(method: string, arity: number): Template {
  const args = Array.from({ length: arity }, (_, index) => argumentName(index));
  const text =
    `function __ir_dmc(${[RECEIVER, ...args].join(", ")}) {\n` +
    `  ${RECEIVER}.${method};\n` +
    `  ${METHOD_VALUE}.call(${[RECEIVER, ...args].join(", ")});\n` +
    `  ${RECEIVER}.${method}(${args.join(", ")});\n` +
    `  ${METHOD_VALUE} === undefined;\n` +
    `}`;
  const [read, own, branded, missing] = parseDetachedTemplate("__ir_dyn_mcall.js", text, 4);
  return { read: read!, own: own!, branded: branded!, missing: missing! };
}

/**
 * Reserve (once per method/arity) the wrapper `name` — the IR names it
 * (`ir/dynamic-method-call-names.ts`), and only an identifier-safe `method`
 * reaches here. Returns its function index, or undefined off the wrapper lanes
 * or when legacy's emitter reports an error for the template (its diagnostics
 * are dropped; the IR call site's preparation then fails cleanly).
 */
export function ensureIrDynamicMethodCallHelper(
  ctx: CodegenContext,
  name: string,
  method: string,
  arity: number,
): number | undefined {
  if (!irDynamicMethodCallWrapperLane(ctx)) return undefined;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const helper = helperFunctionContext(
    name,
    [RECEIVER, ...Array.from({ length: arity }, (_, index) => argumentName(index))].map((param) => ({
      name: param,
      type: EXTERNREF,
    })),
    EXTERNREF,
  );
  const methodValue = allocLocal(helper, METHOD_VALUE, EXTERNREF);
  const { read, own, branded, missing } = template(method, arity);
  const errorsBefore = ctx.errors.length;

  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]);
  flushLateImportShifts(ctx, helper);
  compileAs(ctx, helper, read, EXTERNREF);
  helper.body.push({ op: "local.set", index: methodValue });
  const isCallable = ctx.funcMap.get("__is_callable");
  if (isCallable === undefined) throw new Error("ir/dynamic-method-call: __is_callable is not registered");
  helper.body.push({ op: "local.get", index: methodValue }, { op: "call", funcIdx: isCallable });

  // Every completed sequence stays parked until the join, so a late import a
  // later branch registers still shifts its call indices.
  const park = { park: true } as const;
  const ownBranch = captureReceiverSequence(helper, () => compileAs(ctx, helper, own, EXTERNREF), park);
  const missingTest = captureReceiverSequence(helper, () => compileAs(ctx, helper, missing, I32), park);
  const brandedBranch = captureReceiverSequence(helper, () => compileAs(ctx, helper, branded, EXTERNREF), park);
  const notAFunction = captureReceiverSequence(
    helper,
    () => emitThrowTypeError(ctx, helper, `${method} is not a function`),
    park,
  );
  flushLateImportShifts(ctx, helper);
  helper.savedBodies.splice(-4);
  const branch = (then: Instr[], otherwise: Instr[]): Instr => ({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then,
    else: otherwise,
  });
  helper.body.push(branch(ownBranch, [...missingTest, branch(brandedBranch, notAFunction)]));

  if (ctx.errors.length !== errorsBefore) {
    ctx.errors.length = errorsBefore;
    return undefined;
  }
  flushLateImportShifts(ctx, helper);
  return publishHelperFunction(ctx, helper);
}
