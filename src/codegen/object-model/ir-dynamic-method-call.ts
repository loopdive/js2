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
import { emitThrowTypeError } from "../js-errors.js";
import { captureReceiverSequence } from "../ir-dynamic-construct.js";
import { helperFunctionContext, publishHelperFunction } from "../helpers/ir-helper-function.js";
import {
  compileTemplateExpressionAs as compileAs,
  irTemplateWrapperLane,
  parseDetachedTemplate,
} from "../helpers/template-wrapper.js";
import { ensureObjectRuntime, WRAPPER_PRIMITIVE_KEY } from "../object-runtime.js";
import { nativeStringLiteralInstrs } from "../native-strings.js";
// The bridge reads the lane through this module, its one codegen edge for the wrapper.
export { irTemplateWrapperLane };

const RECEIVER = "__ir_dmc_recv";
const METHOD_VALUE = "__ir_dmc_fn";
const BRAND_FIRST = "__ir_dmc_brand_first";
const argumentName = (index: number): string => `__ir_dmc_arg${index}`;
const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * (#7119, option a) Does `recv` take legacy's brand branch FIRST? A primitive
 * wrapper object (`new Number(x)`, `Object(sym)`: a `$Object` carrying the
 * internal `[[PrimitiveValue]]` slot) with no OWN `method` reads a built-in
 * method value through its native prototype (#4248), and a reflective
 * `f.call(recv, …)` on that value throws where legacy's brand dispatch answers
 * (#6610 `wrapperReceiver`). An own `method` on the wrapper is a user value and
 * keeps the own-method branch. Leaves an i32 on the stack.
 */
function wrapperBrandFirstInstrs(ctx: CodegenContext, method: string): Instr[] {
  const { objectTypeIdx } = ensureObjectRuntime(ctx);
  const objFind = ctx.funcMap.get("__obj_find");
  if (objFind === undefined) throw new Error("ir/dynamic-method-call: __obj_find is not registered");
  const found = (key: string): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    ...nativeStringLiteralInstrs(ctx, key),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: objFind },
    { op: "ref.is_null" },
  ];
  const i32: Instr = { op: "i32.const", value: 0 };
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        ...found(WRAPPER_PRIMITIVE_KEY),
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [i32],
          else: found(method),
        },
      ],
      else: [{ ...i32 }],
    },
  ];
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
  if (!irTemplateWrapperLane(ctx)) return undefined;
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
  const brandFirst = allocLocal(helper, BRAND_FIRST, I32);
  const { read, own, branded, missing } = template(method, arity);
  const errorsBefore = ctx.errors.length;
  helper.body.push(...wrapperBrandFirstInstrs(ctx, method), { op: "local.set", index: brandFirst });

  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]);
  flushLateImportShifts(ctx, helper);
  compileAs(ctx, helper, read, EXTERNREF);
  helper.body.push({ op: "local.set", index: methodValue });
  const isCallable = ctx.funcMap.get("__is_callable");
  if (isCallable === undefined) throw new Error("ir/dynamic-method-call: __is_callable is not registered");
  // own-method branch: a callable `f` the receiver does not take brand-first.
  helper.body.push(
    { op: "local.get", index: methodValue },
    { op: "call", funcIdx: isCallable },
    { op: "local.get", index: brandFirst },
    { op: "i32.eqz" },
    { op: "i32.and" },
  );

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
  const takesBrand: Instr[] = [{ op: "local.get", index: brandFirst }, ...missingTest, { op: "i32.or" }];
  helper.body.push(branch(ownBranch, [...takesBrand, branch(brandedBranch, notAFunction)]));

  if (ctx.errors.length !== errorsBefore) {
    ctx.errors.length = errorsBefore;
    return undefined;
  }
  flushLateImportShifts(ctx, helper);
  return publishHelperFunction(ctx, helper);
}
