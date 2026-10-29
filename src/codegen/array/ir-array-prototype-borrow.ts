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
 * (`helpers/template-wrapper.ts`, `ir-dynamic-construct.ts`).
 */
import type { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { flushLateImportShifts } from "../shared.js";
import { helperFunctionContext, publishHelperFunction } from "../helpers/ir-helper-function.js";
import {
  compileTemplateExpressionAs,
  irTemplateWrapperLane,
  parseDetachedTemplate,
} from "../helpers/template-wrapper.js";
import { carrierOf } from "../struct-carrier-inhabits.js";
import { arrayPrototypeBorrowCompilesHostFree, isStringCarrier } from "../array-prototype-borrow.js";

const BORROW_RECEIVER = "__ir_apb_recv";
const borrowArgumentName = (index: number): string => `__ir_apb_arg${index}`;

/**
 * May this lane build `Array.prototype.<method>.call(recv, …)` as a wrapper?
 * The host-free non-fast lanes and a method legacy's borrow compiler builds
 * host-free.
 */
export function irArrayPrototypeBorrowWrapperLane(ctx: CodegenContext, method: string): boolean {
  return irTemplateWrapperLane(ctx) && arrayPrototypeBorrowCompilesHostFree(method);
}

/**
 * The selector option: may the IR claim this `Array.prototype.<method>.call`?
 * Legacy's borrow compiler must build `method` host-free (the lane is the
 * selector's `dynamic-method-call-wrapper` capability, the nameable pair the
 * IR's own shape match), and where the borrow's value reaches a typed slot
 * (`resultReachesTypedSlot` — a return, an argument, an initializer), legacy's
 * typing of that slot must be one the IR's carrier reaches
 * ({@link borrowResultReachesCarrier}). A member receiver (`….join(", ")`) or a
 * discarded statement value stays the carrier, whatever the checker types the
 * borrow, so the typing question is not asked there.
 */
export function irArrayPrototypeBorrowAdmitted(
  ctx: CodegenContext,
  call: ts.CallExpression,
  method: string,
  resultReachesTypedSlot: boolean,
): boolean {
  if (!arrayPrototypeBorrowCompilesHostFree(method)) return false;
  return !resultReachesTypedSlot || borrowResultReachesCarrier(ctx, call);
}

/**
 * Legacy types a slot holding the borrow from the checker's type of the call
 * (`resolveWasmType` — `any[]` for `slice`/`map`/…, `void` for `forEach`,
 * `any` for `pop`, `string` for `join`) and the enclosing function's ABI with
 * it; the IR answers the dynamic carrier and coerces it into the slot. The two
 * ABIs agree only where legacy's carrier for that type is one the dynamic
 * carrier reaches: the carrier itself (`any`, `unknown`, a host-typed iterator
 * from `keys`/`entries`/`values`), a scalar the IR unboxes, or the lane's
 * string. A vec or struct ref, or no slot at all (`void`), types the function
 * past the IR's signature — finalize's `abi-signature-parity` demote — so the
 * selector refuses the borrow in such a position instead of claiming it.
 */
function borrowResultReachesCarrier(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const fact = ctx.oracle.typeFactOf(call);
  if (fact.kind === "void" || fact.kind === "undefined") return false;
  const carrier = carrierOf(ctx, call);
  return (
    carrier.kind === "externref" || carrier.kind === "f64" || carrier.kind === "i32" || isStringCarrier(ctx, carrier)
  );
}

/**
 * Reserve (once per method/arity) the wrapper `name` — the IR names it
 * (`ir/array-prototype-borrow-call.ts`), and only an identifier-safe `method`
 * reaches here. Returns its function index, or undefined off the wrapper
 * lanes. Legacy's borrow compiler reports an error only for the methods
 * {@link irArrayPrototypeBorrowWrapperLane} already excludes, so the template
 * compiles clean by admission.
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
  const helper = helperFunctionContext(
    name,
    params.map((param) => ({ name: param, type: externref })),
    externref,
  );
  const [borrow] = parseDetachedTemplate(
    "__ir_arr_borrow.js",
    `function __ir_apb(${params.join(", ")}) {\n  Array.prototype.${method}.call(${params.join(", ")});\n}`,
    1,
  );
  compileTemplateExpressionAs(ctx, helper, borrow!, externref);
  flushLateImportShifts(ctx, helper);
  return publishHelperFunction(ctx, helper);
}
