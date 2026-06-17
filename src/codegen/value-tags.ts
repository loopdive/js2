// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2104 (value-rep P1) — the single canonical home for AnyValue tag policy.
 *
 * Before this module the tag enum, the JS-type classifier, the undefined-f64
 * sentinel, and the `__any_box_*` selection logic were scattered across
 * `any-helpers.ts`, `type-coercion.ts`, and `expressions.ts`, each re-deriving
 * the value's JS type from its Wasm ValType kind. That is the root disease of
 * the value-representation cluster (#2072/#2080 P0 fixed the producer side for
 * literals; this module gives the policy one home so the fix cannot erode as new
 * boxing sites are added).
 *
 * Phase 1 scope (this file): the `JsTag` enum, the `JsStaticType` classifier,
 * the `UNDEF_F64` sentinel + its push/test helpers, and the `boxToAny` boxing
 * entry point. `boxToAny` is **behaviour-preserving** when called with
 * `jsType: "unknown"` — it reproduces the exact kind-keyed dispatch that
 * `coerceType`'s AnyValue arm did, including the #1888 externref→tag-5 decision
 * (honest tag recovery there flips ~794 baseline standalone passes — see the
 * note at the externref arm). The optional `jsType` hint is the seam that
 * P2 (boolean brand) and P3 (undefined observability) consume to pick the exact
 * helper; Phase 1 only threads it, it does not change any emitted default path.
 *
 * Full design: plan/log/analysis-2026-06/02-value-representation-spec.md §2.1-2.2.
 */
import { isBigIntType, isBooleanType, isNumberType, isStringType } from "../checker/type-mapper.js";
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * Canonical JS-type tag for the `$AnyValue` boxed representation.
 *
 * Invariant V1 (tag fidelity): the tag always equals the value's ECMAScript
 * type partition (the `typeof` partition with `null` split out). No consumer may
 * infer a JS type from a Wasm kind.
 *
 * Invariant V2 (numeric class): tags 2 and 3 are ONE JS type (`number`) — one
 * uses the i32 payload, one the f64 payload. Equality / relational / typeof /
 * ToString helpers must treat `{2,3}` as a single class.
 *
 * These values MUST match the runtime tags written by the `__any_box_*` helpers
 * in `any-helpers.ts` (asserted by tests). `Function` (7) is reserved for a
 * later phase (today closures box as `Object`).
 *
 * (Plain `enum`, not `const enum` — Biome's `noConstEnum` forbids the latter;
 * the numeric values are still inlined at our use sites.)
 */
export enum JsTag {
  Null = 0,
  Undefined = 1,
  NumberI32 = 2,
  NumberF64 = 3,
  Boolean = 4,
  String = 5,
  Object = 6,
  Function = 7,
}

/** Static JS-type classification of an expression, resolved from its TS type. */
export type JsStaticType =
  | "null"
  | "undefined"
  | "boolean"
  | "number"
  | "string"
  | "bigint"
  | "object"
  | "function"
  | "unknown";

/**
 * Classify a TS type into its JS-type partition. Returns `"unknown"` for
 * `any`/`unknown`/unions that don't resolve to a single partition — callers
 * then fall back to the Wasm-kind-keyed boxing path (behaviour-preserving).
 */
export function jsStaticType(t: ts.Type | undefined): JsStaticType {
  if (!t) return "unknown";
  const f = t.flags;
  if (f & ts.TypeFlags.Null) return "null";
  if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return "undefined";
  if (isBooleanType(t)) return "boolean";
  if (isNumberType(t)) return "number";
  if (isStringType(t)) return "string";
  if (isBigIntType(t)) return "bigint";
  // A callable type (has call signatures and no construct-only shape) is a
  // function. Guard with getCallSignatures so plain objects aren't misread.
  if (f & ts.TypeFlags.Object) {
    const callSigs = t.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) return "function";
    return "object";
  }
  return "unknown";
}

/**
 * The de-facto undefined-in-f64 sentinel, named once here (14 ad-hoc sites
 * elsewhere predate this module). It is a SIGNALING NaN — JS arithmetic only
 * ever produces the quiet NaN `0x7FF8000000000000`, so this bit pattern can
 * carry "undefined" through an f64 carrier without colliding with a computed
 * NaN. Observers in unsound contexts (`=== undefined`, `??`, `typeof`,
 * ToString) test for it; sound contexts (arithmetic, relational, ToBoolean)
 * ignore it because it already behaves as NaN. P3 (#2106) wires the observers;
 * Phase 1 only centralizes the constant + emit helpers.
 */
export const UNDEF_F64_BITS = 0x7ff00000deadc0den;

/** Push the undefined-f64 sentinel onto the stack (`i64.const` + reinterpret). */
export function pushUndefF64(body: Instr[]): void {
  body.push({ op: "i64.const", value: UNDEF_F64_BITS });
  body.push({ op: "f64.reinterpret_i64" } as Instr);
}

/**
 * Emit a test that the f64 on the stack is exactly the undefined sentinel,
 * leaving an i32 (1 = is-undef) on the stack. Uses the i64 bit pattern compare
 * (NOT `f64.eq`, which is false for any NaN including the sentinel).
 */
export function emitIsUndefF64(body: Instr[]): void {
  body.push({ op: "i64.reinterpret_f64" } as Instr);
  body.push({ op: "i64.const", value: UNDEF_F64_BITS });
  body.push({ op: "i64.eq" } as Instr);
}

/**
 * Box a value of Wasm ValType `from` (top of stack) into a `ref $AnyValue`,
 * the single boxing entry point. `jsType` is the static JS-type hint when
 * resolvable; `"unknown"` reproduces the historical Wasm-kind-keyed dispatch
 * exactly so this is behaviour-preserving by construction.
 *
 * Returns true if it emitted a box call (caller is done); false if no helper
 * was available (caller falls through to its prior handling — matches the old
 * `if (funcIdx !== undefined)` guards).
 *
 * `ensureAnyHelpers`/`addUnionImports` are the caller's responsibility (as in
 * the old `coerceType` arm) — this function only selects + emits the call so it
 * stays a pure dispatch over `ctx.funcMap` and cannot itself trigger a
 * late-import funcIdx shift between resolution and call.
 */
export function boxToAny(ctx: CodegenContext, fctx: FunctionContext, from: ValType, jsType: JsStaticType): boolean {
  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const emit = (name: string, pre?: Instr[]): boolean => {
    const idx = get(name);
    if (idx === undefined) return false;
    if (pre) for (const i of pre) fctx.body.push(i);
    fctx.body.push({ op: "call", funcIdx: idx });
    return true;
  };

  // ── jsType-directed boxing (the consolidation seam) ──
  // Only used where the hint is BOTH resolvable AND consistent with the Wasm
  // kind that already reached here — never to override representation. This
  // keeps Phase 1 behaviour-identical to the kind-keyed path below for every
  // existing caller (all of which pass "unknown" today) while giving P2/P3 a
  // single place to make boxing type-aware.
  switch (jsType) {
    case "boolean":
      if (from.kind === "i32") return emit("__any_box_bool");
      break;
    case "number":
      if (from.kind === "i32") return emit("__any_box_i32");
      if (from.kind === "f64") return emit("__any_box_f64");
      if (from.kind === "i64") return emit("__any_box_f64", [{ op: "f64.convert_i64_s" }]);
      break;
    case "null":
      // Only honor when the value is a discardable reference carrier; otherwise
      // fall through (a non-ref "null" hint shouldn't drop a live scalar).
      break;
    case "undefined":
      break;
    default:
      break;
  }

  // ── Wasm-kind-keyed dispatch (historical default, behaviour-preserving) ──
  if (from.kind === "i32") return emit("__any_box_i32");
  if (from.kind === "f64") return emit("__any_box_f64");
  if (from.kind === "i64") return emit("__any_box_f64", [{ op: "f64.convert_i64_s" }]);
  if (from.kind === "externref") {
    // #1888 (regression −788/−794): do NOT route generic externref boxing
    // through honest tag recovery. The test262 harness comparator (`isSameValue`
    // over the externref ABI with `any` params) depends on main's tag-5
    // box-the-externref behaviour; honest recovery here flipped ~794 baseline
    // standalone passes. Numeric honesty for open-any dispatch is provided
    // downstream by the $BoxedNumber recovery arm in `__any_to_f64`. Keep tag-5.
    return emit("__any_box_string");
  }
  // (#42) A native WasmGC string is a `ref $AnyString` (nativeStrings/standalone),
  // not an externref — without this arm it fell through to `__any_box_ref` below
  // and was boxed as a tag-6 OBJECT (refval), so `const s: any = "x"; s + s`
  // mis-dispatched `__any_add` (object-ToString, not string concat). Recover the
  // string by wrapping the ref to externref and boxing it as a tag-5 STRING, the
  // same representation `const s: any = "x"` carries on a direct read.
  if (
    (from.kind === "ref" || from.kind === "ref_null") &&
    ctx.anyStrTypeIdx >= 0 &&
    (from as { typeIdx: number }).typeIdx === ctx.anyStrTypeIdx
  ) {
    return emit("__any_box_string", [{ op: "extern.convert_any" } as Instr]);
  }
  if (from.kind === "ref" || from.kind === "ref_null") return emit("__any_box_ref");
  return false;
}
