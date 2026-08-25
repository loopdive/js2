// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3954 phase 1 — the TAG-DOMAIN SEAM: the IR's dynamic value model, named.
 *
 * ## What this file is for
 *
 * Before this seam the IR did not have "a dynamic value type" — it had
 * *ECMAScript's* dynamic value type, spelled as the closed `JsTag` enum
 * (`js-tag.ts`) and baked straight into the IR type lattice
 * (`IrType = … | { kind: "dynamic"; tag?: JsTag }`). Every consumer of that
 * leaf therefore encoded ECMA-262 semantics as if they were facts about
 * compilation in general, and there was no boundary a reviewer could hold a
 * change against.
 *
 * A `TagDomain` is the whole of what a source language must say about its
 * dynamic values for the IR to compile them:
 *
 *   1. **The partition set** — which runtime tags exist at all.
 *   2. **The carrier kind of each tag** — what shape the unboxed payload has
 *      in the backend's value representation (generalizes `jsTagUnboxKind`).
 *   3. **The refinement lattice** — how a statically-proven tag joins with
 *      another at a control-flow merge.
 *   4. **The coercion predicates** — truthiness and numeric coercion, which
 *      are pure LANGUAGE SEMANTICS and not lowering conveniences.
 *
 * Point 4 is the reason this file exists rather than a type alias. A reader
 * of `dyn.truthy` could not previously tell whether "null is falsy" was
 * ECMA-262 §7.1.2 or an emitter shortcut. In the JS implementation
 * (`js-tag-domain.ts`) every predicate arm carries its spec clause, so the
 * conformance decisions are legible as conformance decisions.
 *
 * ## Layering
 *
 * This file has **ZERO imports**, deliberately and load-bearingly — the same
 * rule `js-tag.ts` documents in its own header. `IrType` lives in `nodes.ts`,
 * which is imported by every IR module and by codegen; a domain leaf that
 * transitively pulled `ts-api` or the codegen context types would create a
 * module-graph knot with TDZ hazards for module-load-time reads. Keep it
 * import-free: the concrete domain (`js-tag-domain.ts`) is the layer that may
 * import, and it imports only `js-tag.ts` (itself import-free) and this file.
 *
 * ## Scope (phase 1)
 *
 * JavaScript remains the ONLY implementation (`JS_TAG_DOMAIN`), wired at a
 * single place (`producer.ts`). Phase 1 is behaviour-neutral: emitted bytes
 * must not move.
 *
 * ## What phase 3 found (2026-08-19)
 *
 * `tests/issue-3954-phase3-nonjs-domain.test.ts` ran the falsification with a
 * synthetic non-JS domain. Result: **this seam is real for the type lattice
 * and NOMINAL for every operation on a dynamic value.** A foreign domain's
 * partitions ride an `IrType` through the production lowerer and execute on
 * the bytecode VM, but `unbox`/`tag.test`/`box`-with-a-proven-partition were
 * `JsTag` end to end — the node fields (`nodes.ts`), the verifier
 * (`verify.ts` read `defaultTagDomain()` and had no channel to be told
 * otherwise), the builder API and the frozen `IrDynamicLowering` contract.
 * The six walls, with file:line and what closing each costs, are in the
 * "Phase 3 (the falsification)" section of the issue file.
 *
 * ## What the phase-3 FOLLOW-UP closed
 *
 * W4, W5 and W3: the `unbox`/`tag.test` fields are a neutral `tagId: TagId`,
 * `IrFunctionBuilder` HOLDS a domain (ctor arg, defaulting to `producer.ts`'s)
 * and answers carrier questions from it, and `verifyIrFunction(func, domain?)`
 * takes the domain and threads it to the per-instruction rules. So a foreign
 * partition can now be NAMED, BUILT and VERIFIED against its own domain.
 *
 * **Still open**: LOWERING a dynamic value (W2/W6 — the #3029-S1-frozen
 * `IrDynamicLowering` contract is `JsTag`-typed member by member, so `lower.ts`
 * crosses through `jsTagOf` and throws on a foreign id) and the bytecode
 * backend's lack of a boxed-value representation (W1, #1584). Do not read this
 * interface's existence as evidence that a second producer would work today.
 */

/**
 * An opaque identifier for one partition of a {@link TagDomain}.
 *
 * Deliberately BRANDED. `IrType`'s dynamic leaf carries a `TagId`, not a
 * `JsTag`, so the IR core cannot name an ECMAScript partition by accident:
 * a bare `number` (and therefore a numeric-enum member such as `JsTag.String`)
 * is not assignable here. The only sanctioned ways to obtain one are a
 * domain's own exported constants (e.g. `JS_TAG_IDS.String`) or
 * {@link asTagId} inside a domain implementation.
 *
 * The underlying representation is a plain number, and each domain is free to
 * choose the numbering. The JS domain deliberately reuses the `JsTag` values,
 * which are ABI — they must match the runtime tags written by the
 * `__any_box_*` helpers in `codegen/any-helpers.ts`.
 */
declare const TAG_ID_BRAND: unique symbol;
export type TagId = number & { readonly [TAG_ID_BRAND]: "ir.TagId" };

/**
 * The shape of a partition's unboxed payload in a backend's value
 * representation. Generalizes `jsTagUnboxKind` (`js-tag.ts`) to any domain.
 *
 *   - `"i32"` / `"f64"` — exact scalar payload kind; an `unbox` target
 *     ValType must match exactly.
 *   - `"ref"` — reference-shaped payload; the exact ValType is a
 *     backend/resolver decision at lowering time, so the verifier only
 *     requires a ref-shaped target.
 *   - `null` — the partition is a SINGLETON with no payload at all
 *     (ECMAScript's `null` / `undefined`, Python's `None`). `unbox` on such a
 *     tag is invalid; identity is observed via a tag test alone.
 */
export type TagCarrierKind = "i32" | "f64" | "ref" | null;

/**
 * What a partition contributes to a boolean coercion, independent of its
 * payload value.
 *
 *   - `"always-true"` / `"always-false"` — every value of this partition
 *     coerces the same way, so a producer holding a static tag refinement may
 *     fold the coercion to a constant.
 *   - `"payload-dependent"` — the answer needs the payload (JS: `0`, `NaN`,
 *     `""`, `false`), so the coercion must be emitted.
 *   - `"not-coercible"` — the source language has NO implicit boolean coercion
 *     for this partition: a conditional must be given a boolean, and offering
 *     one of these is a type error in the producer, not a coercion the backend
 *     emits. ECMAScript never returns this (§7.1.2 is total over every type),
 *     which is exactly why it is easy to leave out — and leaving it out forces
 *     any language without ToBoolean to answer with a JavaScript-shaped lie.
 *     Added by #3954 PHASE 3, when the synthetic non-JS domain could not state
 *     its own semantics without it. Note the asymmetry it removes:
 *     {@link TagNumericCoercion} already had a `"throws"` arm for "this
 *     language refuses", and truthiness did not.
 *
 * NOTE: this is a *semantic* fact about the source language, not a statement
 * about what the current lowering does. Phase 1 does not fold anything (it is
 * byte-neutral); the classification exists so that a folding pass, and any
 * non-JS domain, has one authoritative place to read the rule from. Nothing
 * under `src/` consumes it yet, so widening the union moves no bytes.
 */
export type TagTruthiness = "always-true" | "always-false" | "payload-dependent" | "not-coercible";

/**
 * What a partition contributes to a numeric coercion.
 *
 *   - `{ kind: "constant", value }` — the coercion ignores the payload and
 *     yields a fixed number (JS: `null` → `+0`, `undefined` → `NaN`).
 *   - `{ kind: "payload" }` — a total, side-effect-free function of the
 *     payload (JS: `boolean` → 0/1, `number` → itself).
 *   - `{ kind: "parse" }` — a total, side-effect-free but non-trivial
 *     conversion the backend must implement (JS: StringToNumber).
 *   - `{ kind: "user-observable" }` — coercion can run USER CODE and/or throw,
 *     so it is not a pure rewrite and may not be hoisted, duplicated or
 *     eliminated (JS: ToPrimitive on an object calls `valueOf`/`toString`).
 *   - `{ kind: "throws" }` — coercion always raises (JS: Symbol, BigInt —
 *     partitions the current `JsTag` enum does not model).
 *
 * The `user-observable` / `throws` arms are the ones that matter to an
 * optimizer: everything else is a pure function and freely movable.
 */
export type TagNumericCoercion =
  | { readonly kind: "constant"; readonly value: number }
  | { readonly kind: "payload" }
  | { readonly kind: "parse" }
  | { readonly kind: "user-observable" }
  | { readonly kind: "throws" };

/**
 * The dynamic value model of ONE source language.
 *
 * Implementations must be pure and stateless: every method is a total
 * function of its arguments, and calling one must never depend on compilation
 * order. `JS_TAG_DOMAIN` (`js-tag-domain.ts`) is the only implementation in
 * tree; `producer.ts` is the single place a producer's domain is chosen.
 */
export interface TagDomain {
  /** Stable identifier of the source language this domain models. */
  readonly id: string;
  /** Every partition, in a stable order. */
  readonly tags: readonly TagId[];
  /** Debug/diagnostic name of a partition (e.g. `"NumberF64"`). */
  nameOf(tag: TagId): string;
  /**
   * The SOURCE-LANGUAGE type a partition belongs to (e.g. `"number"`).
   *
   * Distinct from {@link nameOf}: several partitions may be different
   * *representations* of one language-level type. In ECMAScript this is
   * invariant V2 — `NumberI32` and `NumberF64` are one JS `number`, split only
   * by which payload field carries them — and equality / relational / `typeof`
   * must treat them as one class.
   */
  classOf(tag: TagId): string;
  /** The unboxed payload's shape; `null` for a payload-less singleton. */
  carrierKindOf(tag: TagId): TagCarrierKind;
  /** Boolean-coercion behaviour of the partition. */
  truthinessOf(tag: TagId): TagTruthiness;
  /** Numeric-coercion behaviour of the partition. */
  numericCoercionOf(tag: TagId): TagNumericCoercion;
  /**
   * Least upper bound of two partitions in the REFINEMENT lattice, or
   * `undefined` for the lattice top ("partition unknown").
   *
   * The refinement lattice is what a control-flow merge needs: a value proven
   * `String` on one edge and `Object` on the other is simply "some dynamic
   * value" at the join. Domains whose partitions form a real hierarchy (a
   * Python `bool <: int`) may return a proper supertag instead.
   */
  joinTags(a: TagId, b: TagId): TagId | undefined;
}

/**
 * Mint a {@link TagId} from its numeric representation.
 *
 * FOR DOMAIN IMPLEMENTATIONS ONLY. Consumers must take tag ids from a
 * domain's own exported constants; calling this outside a `*-tag-domain.ts`
 * file re-opens exactly the hole the brand closes.
 */
export function asTagId(value: number): TagId {
  return value as TagId;
}

/** The numeric representation of a tag id (for serialization / diagnostics). */
export function tagIdValue(tag: TagId): number {
  return tag as number;
}

/**
 * Join two OPTIONAL tag refinements, where `undefined` is the lattice top
 * ("partition unknown"). Top absorbs: joining a refined value with an
 * unrefined one yields unrefined, which is the conservative answer every
 * consumer of `IrType`'s dynamic leaf already assumes.
 */
export function joinTagRefinement(domain: TagDomain, a: TagId | undefined, b: TagId | undefined): TagId | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (a === b) return a;
  return domain.joinTags(a, b);
}

/** Structural equality of two optional tag refinements. */
export function tagRefinementEquals(a: TagId | undefined, b: TagId | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** Render an optional refinement for diagnostics (`"?"` = partition unknown). */
export function formatTagRefinement(domain: TagDomain, tag: TagId | undefined): string {
  return tag === undefined ? "?" : domain.nameOf(tag);
}

/**
 * True when the partition carries no payload — its only observable content is
 * its own identity, so an `unbox` on it is a producer bug (ECMAScript R2 rule
 * in `verify.ts`).
 */
export function isSingletonTag(domain: TagDomain, tag: TagId): boolean {
  return domain.carrierKindOf(tag) === null;
}
