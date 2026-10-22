// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 compareArray.format) `__ir_arr_borrow_<m>_<n>(recv, a0, …) -> externref`
 * — the IR's `Array.prototype.<m>.call(recv, a0, …)` over a DYNAMIC receiver
 * on the non-fast host-free lanes.
 *
 * The IR has no exact carrier for `Array.prototype.<m>` as a value (#7123),
 * and legacy never materializes one either: its borrow compiler
 * (`array-prototype-borrow.ts`) recognises the whole `.call` shape and runs
 * the §23.1.3 generic algorithm over the receiver. This wrapper is exactly
 * that emission, compiled once per (method, arity) over a fixed template
 * whose only free names are its externref parameters — the dynamic carrier of
 * these lanes, which is legacy's `any`. The borrow compiler's `any`-receiver
 * arm is the array-like loop (`__extern_length` / `__extern_get_idx`), the
 * same one a legacy site with an untyped receiver takes.
 *
 * The naming contract lives in `ir/array-prototype-borrow-call.ts`; the
 * template-wrapper mechanics are shared with the dynamic method-call wrapper
 * (`ir-dynamic-construct.ts`).
 */
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { flushLateImportShifts } from "../shared.js";
import {
  compileTemplateExpressionAsExternref,
  irDynamicMethodCallWrapperLane,
  parseDetachedTemplate,
  publishReceiverHelper,
  receiverHelperContext,
} from "../ir-dynamic-construct.js";
import { arrayPrototypeBorrowCompilesHostFree } from "../array-prototype-borrow.js";

const BORROW_RECEIVER = "__ir_apb_recv";
const borrowArgumentName = (index: number): string => `__ir_apb_arg${index}`;

/**
 * May this lane build `Array.prototype.<method>.call(recv, …)` as a wrapper?
 * The host-free non-fast lanes and a method legacy's borrow compiler builds
 * host-free. (Whether the pair is nameable is the IR contract's question —
 * the bridge composes both.)
 */
export function irArrayPrototypeBorrowWrapperLane(ctx: CodegenContext, method: string): boolean {
  return irDynamicMethodCallWrapperLane(ctx) && arrayPrototypeBorrowCompilesHostFree(method);
}

/**
 * Reserve (once per method/arity) the wrapper `name` — the IR names it
 * (`ir/array-prototype-borrow-call.ts`), and only an identifier-safe `method`
 * reaches here. Returns its function index, or undefined off the wrapper
 * lanes or when legacy's borrow compiler reports an error for the template
 * (its diagnostics are dropped).
 */
export function ensureIrArrayPrototypeBorrowHelper(
  ctx: CodegenContext,
  name: string,
  method: string,
  arity: number,
): number | undefined {
  if (!irArrayPrototypeBorrowWrapperLane(ctx, method)) return undefined;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const params = [BORROW_RECEIVER, ...Array.from({ length: arity }, (_, index) => borrowArgumentName(index))];
  const helper = receiverHelperContext(
    name,
    params.map((param) => ({ name: param, type: externref })),
    externref,
  );
  const [borrow] = parseDetachedTemplate(
    "__ir_arr_borrow.js",
    `function __ir_apb(${params.join(", ")}) {\n  Array.prototype.${method}.call(${params.join(", ")});\n}`,
    1,
  );
  const errorsBefore = ctx.errors.length;
  compileTemplateExpressionAsExternref(ctx, helper, borrow!);
  if (ctx.errors.length !== errorsBefore) {
    ctx.errors.length = errorsBefore;
    return undefined;
  }
  flushLateImportShifts(ctx, helper);
  return publishReceiverHelper(ctx, helper, [externref]);
}
