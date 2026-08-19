// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3954 phase 1 — `JS_TAG_DOMAIN`: ECMAScript as a {@link TagDomain}.
 *
 * This is the ONE place in the tree where the compiler states, in a form a
 * reviewer can check clause by clause, what it believes about ECMAScript's
 * dynamic values. Everything here is either a citation of ECMA-262 or an
 * explicitly-labelled representation decision of ours — and the two are never
 * mixed in one sentence. That distinction is the deliverable of #3954: before
 * it, reading `dyn.truthy` could not tell you whether "`null` is falsy" was
 * §7.1.2 or an emitter shortcut.
 *
 * ## Layering (why this is a second file and not part of `tag-domain.ts`)
 *
 * `tag-domain.ts` is the language-NEUTRAL interface and has zero imports.
 * This file is the ECMAScript instance, and imports exactly two import-free
 * leaves: `tag-domain.ts` (types only) and `js-tag.ts` (the `JsTag` enum whose
 * values are ABI — they must match the runtime tags written by the
 * `__any_box_*` helpers in `codegen/any-helpers.ts`, asserted by tests).
 * Nothing else. The TDZ/module-graph hazard documented in `js-tag.ts`'s header
 * applies verbatim: `IrType` lives in `nodes.ts`, which every IR module and
 * codegen imports, so a domain leaf that pulled in `ts-api` or the codegen
 * context types would knot the graph.
 *
 * ## Tag ids ARE `JsTag` values
 *
 * `JS_TAG_IDS.String === JsTag.String` numerically, by construction. That is
 * not an accident of implementation but a requirement: the `IrType` dynamic
 * leaf's refinement is consumed by the WasmGC lowering
 * (`integration.ts` `IrDynamicLowering`), which emits these exact integers as
 * `$AnyValue.tag` constants. A future domain may renumber freely; THIS one
 * may not.
 *
 * ## Not modelled here
 *
 * ECMAScript has two further `typeof` partitions the `JsTag` enum does not
 * carry — `symbol` and `bigint`. Their absence is a compiler limitation, not a
 * spec reading; where a coercion rule would differ for them the comment says
 * so rather than pretending the partition does not exist.
 */

import { JsTag, jsTagUnboxKind } from "./js-tag.js";
import {
  asTagId,
  type TagCarrierKind,
  type TagDomain,
  type TagId,
  type TagNumericCoercion,
  type TagTruthiness,
} from "./tag-domain.js";

/** Every `JsTag` member's name, in enum order. */
type JsTagName = "Null" | "Undefined" | "NumberI32" | "NumberF64" | "Boolean" | "String" | "Object" | "Function";

/**
 * The ECMAScript partitions as opaque {@link TagId}s.
 *
 * This is what a PRODUCER (`from-ast.ts` — the JavaScript front-end) names
 * when it proves a partition statically, e.g.
 * `irDynamic(JS_TAG_IDS.String)`. The IR core must not: it sees only `TagId`.
 */
export const JS_TAG_IDS: Readonly<Record<JsTagName, TagId>> = {
  Null: asTagId(JsTag.Null),
  Undefined: asTagId(JsTag.Undefined),
  NumberI32: asTagId(JsTag.NumberI32),
  NumberF64: asTagId(JsTag.NumberF64),
  Boolean: asTagId(JsTag.Boolean),
  String: asTagId(JsTag.String),
  Object: asTagId(JsTag.Object),
  Function: asTagId(JsTag.Function),
};

/** Bridge INTO the domain: a `JsTag` as an opaque tag id. */
export function tagIdOfJsTag(tag: JsTag): TagId {
  return asTagId(tag);
}

/**
 * Bridge OUT of the domain: an opaque tag id back to the `JsTag` the WasmGC
 * lowering still speaks.
 *
 * Phase 1 moved `IrType`'s dynamic leaf to `TagId`; #3954 phase 3 (W4/W5) moved
 * the `unbox`/`tag.test` instruction fields and the builder APIs that construct
 * them. What remains typed in `JsTag` is the `IrDynamicLowering` handle contract
 * (`backend/handles.ts`, frozen #3029-S1) — W2/W6 — so this function is the
 * single conversion at that ONE remaining boundary, called from `lower.ts`'s
 * box / unbox / tag.test dynamic arms.
 *
 * The runtime check is load-bearing beyond diagnostics: `TagId` is a branded
 * `number` and TypeScript assigns a branded number straight to a numeric enum,
 * so `TagId → JsTag` has NO compile-time barrier. This throw is the only thing
 * standing between a foreign partition and a bogus `$AnyValue.tag` constant.
 */
export function jsTagOf(tag: TagId): JsTag {
  const n = tag as number;
  if (JS_TAG_BY_ID.has(n)) return n as JsTag;
  throw new Error(`ir/js-tag-domain: tag id ${n} is not an ECMAScript partition (#3954)`);
}

const JS_TAG_BY_ID: ReadonlyMap<number, JsTagName> = new Map<number, JsTagName>([
  [JsTag.Null, "Null"],
  [JsTag.Undefined, "Undefined"],
  [JsTag.NumberI32, "NumberI32"],
  [JsTag.NumberF64, "NumberF64"],
  [JsTag.Boolean, "Boolean"],
  [JsTag.String, "String"],
  [JsTag.Object, "Object"],
  [JsTag.Function, "Function"],
]);

/**
 * The `typeof` partition each tag belongs to (invariant V1: the tag equals the
 * value's ECMAScript type partition, with `null` split out of `"object"`).
 *
 * `NumberI32` and `NumberF64` deliberately share `"number"` — invariant V2:
 * they are ONE JS type differing only in which `$AnyValue` payload field
 * carries them. Equality (§7.2.15/§7.2.16), the relational operators
 * (§7.2.13) and `typeof` (§13.5.3) must treat them as a single class; the
 * split is OUR representation choice, not the spec's.
 */
function classOfTag(tag: JsTag): string {
  switch (tag) {
    // §4.4.13 — the `null` value. `typeof null` is `"object"` (§13.5.3, a
    // famously-preserved web-compat wart), but the VALUE partition is its own;
    // splitting it out is what invariant V1 means by "with null split out".
    case JsTag.Null:
      return "null";
    case JsTag.Undefined:
      return "undefined"; // §4.4.12
    case JsTag.NumberI32:
    case JsTag.NumberF64:
      return "number"; // §6.1.6.1 (invariant V2 — one type, two carriers)
    case JsTag.Boolean:
      return "boolean"; // §6.1.3
    case JsTag.String:
      return "string"; // §6.1.4
    case JsTag.Object:
      return "object"; // §6.1.7
    case JsTag.Function:
      // §13.5.3 `typeof` yields `"function"` for a callable object. A function
      // IS an Object (§6.1.7); the separate partition exists because `typeof`
      // and our boxing distinguish it. Today closures still box as `Object`
      // (see `js-tag.ts`) — this arm is reserved for that later phase.
      return "function";
  }
}

/**
 * ToBoolean — **ECMA-262 §7.1.2**.
 *
 * The spec table, transcribed, one arm per clause:
 *
 *   | argument type | result                                      |
 *   | ------------- | ------------------------------------------- |
 *   | Undefined     | `false`                                     |
 *   | Null          | `false`                                     |
 *   | Boolean       | the argument                                |
 *   | Number        | `false` if `+0`, `-0` or `NaN`; else `true` |
 *   | String        | `false` if empty; else `true`               |
 *   | Symbol        | `true`                                      |
 *   | BigInt        | `false` if `0n`; else `true`                |
 *   | Object        | `true`                                      |
 *
 * Two things a reader should be able to take from this without re-deriving
 * them:
 *
 * - Object → `always-true` is a CONFORMANCE fact (§7.1.2), not a shortcut we
 *   take because references are convenient to test. The `[[IsHTMLDDA]]`
 *   exotic object (Annex B §B.3.6, `document.all`) is the sole exception in
 *   the whole language, and js2wasm does not model it — see the `IsHTMLDDA`
 *   test262 feature skip in `tests/test262-runner.ts`.
 * - Number → `payload-dependent` covers BOTH numeric carriers: the i32 carrier
 *   is falsy at `0` and the f64 carrier is additionally falsy at `-0` and
 *   `NaN`. The existing f64 lowering `abs(x) > 0` is exactly this clause
 *   (`f64.abs` folds `-0` to `0`; `NaN > 0` is false).
 */
function truthinessOfTag(tag: JsTag): TagTruthiness {
  switch (tag) {
    case JsTag.Undefined: // §7.1.2, Undefined row
    case JsTag.Null: // §7.1.2, Null row
      return "always-false";
    case JsTag.Boolean: // §7.1.2, Boolean row — the argument itself
    case JsTag.NumberI32: // §7.1.2, Number row — false at +0/-0/NaN
    case JsTag.NumberF64:
    case JsTag.String: // §7.1.2, String row — false iff length is 0
      return "payload-dependent";
    case JsTag.Object: // §7.1.2, Object row (modulo [[IsHTMLDDA]], not modelled)
    case JsTag.Function: // a function is an Object (§6.1.7) ⇒ same row
      return "always-true";
  }
}

/**
 * ToNumber — **ECMA-262 §7.1.4**.
 *
 * The spec table, transcribed:
 *
 *   | argument type | result                                             |
 *   | ------------- | -------------------------------------------------- |
 *   | Undefined     | `NaN`                                              |
 *   | Null          | `+0`                                               |
 *   | Boolean       | `1` if `true`, `+0` if `false`                     |
 *   | Number        | the argument                                       |
 *   | String        | StringToNumber(argument) — §7.1.4.1                |
 *   | Symbol        | throw a **TypeError**                              |
 *   | BigInt        | throw a **TypeError**                              |
 *   | Object        | ToPrimitive(argument, number) then ToNumber — §7.1.1 |
 *
 * The classification an optimizer actually needs is which arms are PURE. The
 * first five are total, side-effect-free functions of the value; the Object
 * arm is not — §7.1.1 ToPrimitive invokes `@@toPrimitive` / `valueOf` /
 * `toString`, i.e. arbitrary user code, which may throw and may mutate. So a
 * dynamic ToNumber on a possibly-Object value may not be hoisted out of a
 * loop, duplicated across a branch, or dropped as dead.
 *
 * Note the asymmetry with §7.1.2: ToBoolean never runs user code, ToNumber
 * can. That is why truthiness of an object folds to a constant and numeric
 * coercion of an object does not.
 */
function numericCoercionOfTag(tag: JsTag): TagNumericCoercion {
  switch (tag) {
    case JsTag.Undefined:
      return { kind: "constant", value: Number.NaN }; // §7.1.4, Undefined row
    case JsTag.Null:
      return { kind: "constant", value: 0 }; // §7.1.4, Null row — +0
    case JsTag.Boolean: // §7.1.4, Boolean row — 1 / +0
    case JsTag.NumberI32: // §7.1.4, Number row — identity
    case JsTag.NumberF64:
      return { kind: "payload" };
    case JsTag.String:
      // §7.1.4.1 StringToNumber — a real grammar (StringNumericLiteral):
      // whitespace trimming, `0x`/`0o`/`0b`, `Infinity`, empty string → +0.
      // Pure, but not a payload read; the backend must implement it.
      return { kind: "parse" };
    case JsTag.Object: // §7.1.4, Object row → §7.1.1 ToPrimitive → user code
    case JsTag.Function: // a function is an Object ⇒ same row
      return { kind: "user-observable" };
  }
}

/**
 * Wasm-carrier kind of a partition's unboxed payload.
 *
 * This one is NOT a spec fact — it is our `$AnyValue` representation decision
 * (the ratified #1852 table), and it is stated in `js-tag.ts` as
 * `jsTagUnboxKind`. The domain deliberately DELEGATES rather than restating
 * it: two tables would be a second tag/boxing table, which the June audit's
 * D4 rule forbids outright.
 */
function carrierKindOfTag(tag: JsTag): TagCarrierKind {
  return jsTagUnboxKind(tag);
}

/**
 * Join in the refinement lattice.
 *
 * ECMAScript's partitions are FLAT: no partition is a subtype of another, so
 * any two distinct tags join to the lattice top ("partition unknown"). This is
 * the rule `IrType`'s dynamic leaf already documents — "the refinement is
 * erased at joins" — stated once, here, instead of being re-derived at each
 * merge point.
 *
 * `NumberI32` and `NumberF64` are the one tempting exception, and they are
 * deliberately NOT joined to a single "number" tag: they are one JS type
 * (invariant V2) but two CARRIERS, and there is no third tag meaning "a number
 * in either payload field". Joining them to top is correct — the value is a
 * number whose carrier is not statically known, which is exactly what an
 * unrefined dynamic means. A domain with a genuine hierarchy (Python's
 * `bool <: int`) would return a proper supertag here.
 */
function joinJsTags(a: TagId, b: TagId): TagId | undefined {
  return a === b ? a : undefined;
}

function nameOfTag(tag: TagId): JsTagName {
  const name = JS_TAG_BY_ID.get(tag as number);
  if (name === undefined) {
    throw new Error(`ir/js-tag-domain: tag id ${tag as number} is not an ECMAScript partition (#3954)`);
  }
  return name;
}

/**
 * The ECMAScript tag domain — the SOLE {@link TagDomain} implementation in
 * tree. Chosen through `producer.ts`, never imported directly by IR core code
 * that is meant to stay language-neutral.
 */
export const JS_TAG_DOMAIN: TagDomain = {
  id: "javascript",
  tags: [
    JS_TAG_IDS.Null,
    JS_TAG_IDS.Undefined,
    JS_TAG_IDS.NumberI32,
    JS_TAG_IDS.NumberF64,
    JS_TAG_IDS.Boolean,
    JS_TAG_IDS.String,
    JS_TAG_IDS.Object,
    JS_TAG_IDS.Function,
  ],
  nameOf(tag: TagId): string {
    return nameOfTag(tag);
  },
  classOf(tag: TagId): string {
    return classOfTag(jsTagOf(tag));
  },
  carrierKindOf(tag: TagId): TagCarrierKind {
    return carrierKindOfTag(jsTagOf(tag));
  },
  truthinessOf(tag: TagId): TagTruthiness {
    return truthinessOfTag(jsTagOf(tag));
  },
  numericCoercionOf(tag: TagId): TagNumericCoercion {
    return numericCoercionOfTag(jsTagOf(tag));
  },
  joinTags: joinJsTags,
};
