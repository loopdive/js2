// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2949 (IR dynamic value representation, slice 1) — the canonical `JsTag`
 * enum, extracted from `value-tags.ts` into a dependency-free leaf module.
 *
 * #3113 — this leaf now lives under `src/ir/` (was `src/codegen/js-tag.ts`).
 * It is shared vocabulary consumed by IR core files (nodes/verify/builder/
 * from-ast) AND by codegen (`value-tags.ts`). Homing it in `src/ir/` puts it
 * BELOW the codegen layer, so the IR core files import it in-layer instead of
 * reaching up into `src/codegen/` — removing that IR→codegen import inversion.
 * codegen (above IR) importing it via `value-tags.ts` is the correct downward
 * direction. The file still has ZERO imports, so the move is pure relocation.
 *
 * WHY the extraction: the IR type lattice (`src/ir/nodes.ts`) now carries a
 * `{ kind: "dynamic", tag?: JsTag }` leaf, so the IR layer needs the tag
 * enum. `value-tags.ts` (the tag POLICY home — classifier, boxing entry
 * point, undefined sentinel) transitively imports `ts-api` and the codegen
 * context types; importing it from `ir/nodes.ts` (a pure leaf consumed by
 * every IR module AND by codegen) would create a module-graph knot with
 * TDZ hazards for module-load-time enum reads. This file has ZERO imports,
 * so both layers share ONE tag table (June audit D4 rule: never mint a
 * second tag/boxing table) with no cycle risk. `value-tags.ts` re-exports
 * `JsTag`, so every existing import site is unchanged.
 *
 * Canonical JS-type tag for the `$AnyValue` boxed representation.
 *
 * Invariant V1 (tag fidelity): the tag always equals the value's ECMAScript
 * type partition (the `typeof` partition with `null` split out). No consumer
 * may infer a JS type from a Wasm kind.
 *
 * Invariant V2 (numeric class): tags 2 and 3 are ONE JS type (`number`) — one
 * uses the i32 payload, one the f64 payload. Equality / relational / typeof /
 * ToString helpers must treat `{2,3}` as a single class.
 *
 * These values MUST match the runtime tags written by the `__any_box_*`
 * helpers in `any-helpers.ts` (asserted by tests). `Function` (7) is reserved
 * for a later phase (today closures box as `Object`).
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

/**
 * #2949 slice 1 — the Wasm-carrier *kind* of a `JsTag` partition's unboxed
 * payload on the WasmGC backend, per the ratified #1852 representation table
 * and the `$AnyValue` struct layout (`any-helpers.ts`:
 * `{tag:i32, i32val:i32, f64val:f64, refval:eqref, externval:externref}`).
 *
 * Used by the IR verifier to check `unbox`/`tag.test` consistency on
 * `dynamic`-typed operands:
 *
 *   - `"i32"` / `"f64"` — exact scalar payload kind; the unbox target
 *     ValType must match exactly (NumberI32/Boolean → i32val, NumberF64 →
 *     f64val).
 *   - `"ref"` — the partition's payload is reference-shaped (String →
 *     externval or a native `$AnyString` ref; Object/Function → refval or
 *     externval). The exact ValType is a backend/resolver decision at
 *     lowering time, so the verifier only requires a ref-shaped target.
 *   - `null` — the partition has NO payload (Null/Undefined are singleton
 *     partitions). `unbox` with these tags is invalid; identity is observed
 *     via `tag.test` alone.
 */
export function jsTagUnboxKind(tag: JsTag): "i32" | "f64" | "ref" | null {
  switch (tag) {
    case JsTag.NumberI32:
    case JsTag.Boolean:
      return "i32";
    case JsTag.NumberF64:
      return "f64";
    case JsTag.String:
    case JsTag.Object:
    case JsTag.Function:
      return "ref";
    case JsTag.Null:
    case JsTag.Undefined:
      return null;
  }
}
