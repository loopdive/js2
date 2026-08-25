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
 * #2949 slice 1 — the enum itself moved to the dependency-free leaf module
 * `js-tag.ts` so the IR type lattice (`src/ir/nodes.ts`, which carries
 * `{ kind: "dynamic", tag?: JsTag }`) can import it without pulling this
 * module's `ts-api` / codegen-context dependency chain into the IR leaf.
 * Re-exported here so every existing import site is unchanged; this file
 * remains the tag POLICY home (classifier, boxing entry point, sentinel).
 * See `js-tag.ts` for the invariants (V1 tag fidelity, V2 numeric class).
 */
export { JsTag, jsTagUnboxKind } from "../ir/js-tag.js";

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

/**
 * (#4491 T11) The **absence** twin of {@link UNDEF_F64_BITS}: a second,
 * distinct signaling-NaN payload meaning *this index is not present*, as
 * opposed to *this index holds the value `undefined`*.
 *
 * The two must be distinct because they answer PRESENCE differently:
 * `[0, , 2]` and `[0, undefined, 2]` agree on every VALUE question (`x[1]` is
 * `undefined` for both, `join` renders `""` for both) and disagree on every
 * PRESENCE question (`1 in x`, `x.hasOwnProperty("1")`, `Object.keys(x)`, and
 * the §23.1.3 HOF hole-skip). One payload cannot carry both answers.
 *
 * Same signaling-NaN exponent as `UNDEF_F64_BITS`, so the same "JS arithmetic
 * only ever produces the QUIET NaN `0x7FF8000000000000`" argument applies: the
 * pattern cannot collide with a computed value.
 *
 * **Invariant** (inherited from `array-holes.ts`): a hole is never observed AS
 * the marker. Every value-producing read of a slot that may hold it maps
 * `HOLE → UNDEF` at the read boundary (`vec-f64-hole-presence.ts`), so the ~28
 * existing `UNDEF_F64_BITS` observers keep working unchanged.
 */
export const HOLE_F64_BITS = 0x7ff00000deadc01en;

/** Push the undefined-f64 sentinel onto the stack (`i64.const` + reinterpret). */
export function pushUndefF64(body: Instr[]): void {
  body.push({ op: "i64.const", value: UNDEF_F64_BITS });
  body.push({ op: "f64.reinterpret_i64" });
}

/**
 * Emit a test that the f64 on the stack is exactly the undefined sentinel,
 * leaving an i32 (1 = is-undef) on the stack. Uses the i64 bit pattern compare
 * (NOT `f64.eq`, which is false for any NaN including the sentinel).
 */
export function emitIsUndefF64(body: Instr[]): void {
  body.push({ op: "i64.reinterpret_f64" });
  body.push({ op: "i64.const", value: UNDEF_F64_BITS });
  body.push({ op: "i64.eq" });
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
      // A statically-null reference must always box as tag 0.  Keeping this
      // dispatch in the canonical entry point lets specialized callers retain
      // null identity without opening a direct __any_box_null site (#2104).
      if (
        (from.kind === "externref" || from.kind === "ref" || from.kind === "ref_null") &&
        emit("__any_box_null", [{ op: "drop" }])
      ) {
        return true;
      }
      break;
    case "undefined":
      // (#2106 S1) Statically-undefined value: drop the carrier (null extern /
      // singleton extern / UNDEF_F64-sentinel f64 — the only values an
      // `undefined`-typed slot can hold) and box tag-1. Regime-gated; the
      // legacy path keeps the historical kind-keyed dispatch below.
      if (
        ctx.undefinedSingleton === true &&
        (ctx.standalone || ctx.nativeStrings) &&
        (from.kind === "externref" || from.kind === "ref" || from.kind === "ref_null" || from.kind === "f64") &&
        emit("__any_box_undefined", [{ op: "drop" }])
      ) {
        return true;
      }
      break;
    default:
      break;
  }

  // ── Wasm-kind-keyed dispatch (historical default, behaviour-preserving) ──
  // (#745 S4, flag-gated) A BOOLEAN-branded i32 (e.g. the read-site unbox of a
  // `boolean|string` union local, or a computed predicate) must re-box tag-4,
  // not tag-2 — `__any_strict_eq`/`typeof` classify tag-2 as number. Gated on
  // `unionAnyRep` so flag-off boxing stays byte-identical.
  if (ctx.unionAnyRep && from.kind === "i32" && (from as { boolean?: true }).boolean === true) {
    return emit("__any_box_bool");
  }
  if (from.kind === "i32") return emit("__any_box_i32");
  if (from.kind === "f64") return emit("__any_box_f64");
  if (from.kind === "i64") return emit("__any_box_f64", [{ op: "f64.convert_i64_s" }]);
  if (from.kind === "externref") {
    // (#2141 S1) Stage-B regime: honest runtime classification behind the
    // `honestAnyBoxing` flag (default OFF until slice S4), via
    // `__any_from_extern` — whose null + fallback arms are honest under the
    // same flag (see ensureAnyFromExternHelper), covering BOTH generic-boxing
    // chokepoints with one helper. It is pre-registered by `ensureAnyHelpers`
    // under the flag; if absent (availability preconditions unmet) fall back
    // to the legacy lie so the flag can never produce a compile-time hole.
    if (ctx.honestAnyBoxing && emit("__any_from_extern")) return true;
    // (#2106 S1) NULLISH-honest boxing under the `undefinedSingleton` regime:
    // null → tag-0, the singleton / UNDEF-box → tag-1, everything else keeps
    // the legacy tag-5 wrap byte-equivalently (see __any_box_extern_s1 —
    // deliberately NOT the full-honest #2141 classification, whose solo flip
    // measured −788/−794). Without this, `u === miss` over two `any` operands
    // boxes both nullish values as tag-5 "strings" and __any_strict_eq's
    // guarded string arm answers 0.
    if (ctx.undefinedSingleton === true && (ctx.standalone || ctx.nativeStrings) && emit("__any_box_extern_s1")) {
      return true;
    }
    // #1888 (regression −788/−794): do NOT route generic externref boxing
    // through honest tag recovery. The test262 harness comparator (`isSameValue`
    // over the externref ABI with `any` params) depends on main's tag-5
    // box-the-externref behaviour; honest recovery here flipped ~794 baseline
    // standalone passes. Numeric honesty for open-any dispatch is provided
    // downstream by the $BoxedNumber recovery arm in `__any_to_f64`. Keep tag-5.
    // Consumers are being made tag-agnostic (#2141 S2/S3); the flip is S4.
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
    return emit("__any_box_string", [{ op: "extern.convert_any" }]);
  }
  if (from.kind === "ref" || from.kind === "ref_null") return emit("__any_box_ref");
  return false;
}
