// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3954 phase 1 — the tag-domain seam.
//
// Three things are pinned here, in increasing order of how much they would
// cost to get wrong:
//
//   1. ABI — `JS_TAG_IDS` are numerically the `JsTag` values, which are the
//      runtime `$AnyValue.tag` constants written by `__any_box_*`.
//   2. NO SECOND TABLE — the domain's carrier kinds are `jsTagUnboxKind`, not
//      a re-derivation of it (June-audit D4: never mint a second tag table).
//   3. SPEC TRANSCRIPTION — the ToBoolean (§7.1.2) and ToNumber (§7.1.4)
//      classifications are cross-checked against a REAL ECMAScript engine
//      (the Node this test runs on), not just restated. That is what makes
//      them conformance claims rather than assertions about our own comments.
//
// It also constructs a NON-JS domain to show the interface is implementable
// without ECMAScript. That is a shape check only — actually lowering IR under
// a synthetic domain through `backend/bytecode-vm.ts` is #3954 PHASE 3, and is
// deliberately not attempted here.

import { describe, expect, it } from "vitest";

import { JsTag, jsTagUnboxKind } from "../src/ir/js-tag.js";
import { JS_TAG_DOMAIN, JS_TAG_IDS, jsTagOf, tagIdOfJsTag } from "../src/ir/js-tag-domain.js";
import { IR_DEFAULT_PRODUCER, defaultTagDomain, tagDomainForProducer } from "../src/ir/producer.js";
import {
  asTagId,
  formatTagRefinement,
  isSingletonTag,
  joinTagRefinement,
  tagIdValue,
  tagRefinementEquals,
  type TagCarrierKind,
  type TagDomain,
  type TagId,
  type TagNumericCoercion,
  type TagTruthiness,
} from "../src/ir/tag-domain.js";
import { irDynamic, irTypeEquals } from "../src/ir/nodes.js";

const ALL_JS_TAGS: readonly JsTag[] = [
  JsTag.Null,
  JsTag.Undefined,
  JsTag.NumberI32,
  JsTag.NumberF64,
  JsTag.Boolean,
  JsTag.String,
  JsTag.Object,
  JsTag.Function,
];

describe("#3954 phase 1 — JS_TAG_DOMAIN is the ECMAScript tag domain", () => {
  it("is the domain the default producer resolves to, at one wiring point", () => {
    expect(IR_DEFAULT_PRODUCER).toBe("javascript");
    expect(defaultTagDomain()).toBe(JS_TAG_DOMAIN);
    expect(tagDomainForProducer("javascript")).toBe(JS_TAG_DOMAIN);
    expect(JS_TAG_DOMAIN.id).toBe("javascript");
  });

  it("tag ids ARE the JsTag values — they are the runtime $AnyValue.tag ABI", () => {
    // If this ever drifts, the WasmGC lowering emits the wrong tag constant and
    // every `__any_box_*` / `tag.test` pair silently disagrees at runtime.
    expect(tagIdValue(JS_TAG_IDS.Null)).toBe(0);
    expect(tagIdValue(JS_TAG_IDS.Undefined)).toBe(1);
    expect(tagIdValue(JS_TAG_IDS.NumberI32)).toBe(2);
    expect(tagIdValue(JS_TAG_IDS.NumberF64)).toBe(3);
    expect(tagIdValue(JS_TAG_IDS.Boolean)).toBe(4);
    expect(tagIdValue(JS_TAG_IDS.String)).toBe(5);
    expect(tagIdValue(JS_TAG_IDS.Object)).toBe(6);
    expect(tagIdValue(JS_TAG_IDS.Function)).toBe(7);
  });

  it("covers exactly the JsTag partition set, and round-trips both directions", () => {
    expect(JS_TAG_DOMAIN.tags).toHaveLength(ALL_JS_TAGS.length);
    for (const t of ALL_JS_TAGS) {
      const id = tagIdOfJsTag(t);
      expect(JS_TAG_DOMAIN.tags).toContain(id);
      expect(jsTagOf(id)).toBe(t);
      expect(JS_TAG_DOMAIN.nameOf(id)).toBe(JsTag[t]);
    }
  });

  it("rejects a tag id from a foreign domain rather than emitting a bogus tag", () => {
    expect(() => jsTagOf(asTagId(42))).toThrow(/not an ECMAScript partition/);
    expect(() => JS_TAG_DOMAIN.carrierKindOf(asTagId(-1))).toThrow(/not an ECMAScript partition/);
  });

  it("delegates carrier kinds to jsTagUnboxKind — no second tag table (D4)", () => {
    for (const t of ALL_JS_TAGS) {
      expect(JS_TAG_DOMAIN.carrierKindOf(tagIdOfJsTag(t))).toBe(jsTagUnboxKind(t));
    }
    // The singleton predicate is exactly "no payload".
    expect(isSingletonTag(JS_TAG_DOMAIN, JS_TAG_IDS.Null)).toBe(true);
    expect(isSingletonTag(JS_TAG_DOMAIN, JS_TAG_IDS.Undefined)).toBe(true);
    expect(isSingletonTag(JS_TAG_DOMAIN, JS_TAG_IDS.String)).toBe(false);
  });

  it("keeps invariant V2: the two numeric carriers are ONE language type", () => {
    expect(JS_TAG_DOMAIN.classOf(JS_TAG_IDS.NumberI32)).toBe("number");
    expect(JS_TAG_DOMAIN.classOf(JS_TAG_IDS.NumberF64)).toBe("number");
    // …while remaining distinct PARTITIONS, because they use different payload
    // fields. Nothing joins them to a third "number" tag: there isn't one.
    expect(JS_TAG_DOMAIN.carrierKindOf(JS_TAG_IDS.NumberI32)).toBe("i32");
    expect(JS_TAG_DOMAIN.carrierKindOf(JS_TAG_IDS.NumberF64)).toBe("f64");
    expect(JS_TAG_DOMAIN.joinTags(JS_TAG_IDS.NumberI32, JS_TAG_IDS.NumberF64)).toBeUndefined();
  });
});

describe("#3954 phase 1 — ECMA-262 predicates behind the seam", () => {
  const EXPECTED_TRUTHINESS: ReadonlyArray<readonly [JsTag, TagTruthiness]> = [
    [JsTag.Undefined, "always-false"],
    [JsTag.Null, "always-false"],
    [JsTag.Boolean, "payload-dependent"],
    [JsTag.NumberI32, "payload-dependent"],
    [JsTag.NumberF64, "payload-dependent"],
    [JsTag.String, "payload-dependent"],
    [JsTag.Object, "always-true"],
    [JsTag.Function, "always-true"],
  ];

  it("§7.1.2 ToBoolean: the classification matches the spec table", () => {
    for (const [tag, expected] of EXPECTED_TRUTHINESS) {
      expect(JS_TAG_DOMAIN.truthinessOf(tagIdOfJsTag(tag))).toBe(expected);
    }
  });

  it("§7.1.2 ToBoolean: cross-checked against a real ECMAScript engine", () => {
    // Representative values per partition. `always-*` must hold for EVERY
    // sample; `payload-dependent` must have at least one true and one false
    // sample, or the classification is over-conservative and would block a
    // legitimate fold.
    const samples: ReadonlyArray<readonly [JsTag, readonly unknown[]]> = [
      [JsTag.Undefined, [undefined]],
      [JsTag.Null, [null]],
      [JsTag.Boolean, [true, false]],
      [JsTag.NumberI32, [1, -1, 0]],
      [JsTag.NumberF64, [1.5, Number.NaN, 0, -0, Number.POSITIVE_INFINITY]],
      [JsTag.String, ["a", "", "0"]],
      [JsTag.Object, [{}, [], new Date(0), Object.create(null)]],
      [JsTag.Function, [() => 0, function named() {}, Math.max]],
    ];
    for (const [tag, values] of samples) {
      const kind = JS_TAG_DOMAIN.truthinessOf(tagIdOfJsTag(tag));
      const results = values.map((v) => Boolean(v));
      if (kind === "always-true") expect(results.every((r) => r === true)).toBe(true);
      else if (kind === "always-false") expect(results.every((r) => r === false)).toBe(true);
      else {
        expect(results).toContain(true);
        expect(results).toContain(false);
      }
    }
  });

  const EXPECTED_TO_NUMBER: ReadonlyArray<readonly [JsTag, TagNumericCoercion]> = [
    [JsTag.Undefined, { kind: "constant", value: Number.NaN }],
    [JsTag.Null, { kind: "constant", value: 0 }],
    [JsTag.Boolean, { kind: "payload" }],
    [JsTag.NumberI32, { kind: "payload" }],
    [JsTag.NumberF64, { kind: "payload" }],
    [JsTag.String, { kind: "parse" }],
    [JsTag.Object, { kind: "user-observable" }],
    [JsTag.Function, { kind: "user-observable" }],
  ];

  it("§7.1.4 ToNumber: the classification matches the spec table", () => {
    for (const [tag, expected] of EXPECTED_TO_NUMBER) {
      expect(JS_TAG_DOMAIN.numericCoercionOf(tagIdOfJsTag(tag))).toEqual(expected);
    }
  });

  it("§7.1.4 ToNumber: the constant arms are the values the engine produces", () => {
    const undef = JS_TAG_DOMAIN.numericCoercionOf(JS_TAG_IDS.Undefined);
    const nul = JS_TAG_DOMAIN.numericCoercionOf(JS_TAG_IDS.Null);
    expect(undef.kind).toBe("constant");
    expect(nul.kind).toBe("constant");
    if (undef.kind === "constant") expect(Number.isNaN(undef.value)).toBe(Number.isNaN(Number(undefined)));
    // +0, and it must be POSITIVE zero — `Object.is` distinguishes -0.
    if (nul.kind === "constant") expect(Object.is(nul.value, Number(null))).toBe(true);
  });

  it("§7.1.4 ToNumber: `user-observable` is exactly the arm that can run user code", () => {
    // The distinction that matters to an optimizer: everything but the Object
    // row is a pure function of the value, so only Object/Function coercions
    // are movement-hostile. Demonstrated, not asserted: a `valueOf` side effect
    // is observable through ToNumber on an object and on nothing else.
    let calls = 0;
    const spy = {
      valueOf() {
        calls += 1;
        return 7;
      },
    };
    expect(Number(spy)).toBe(7);
    expect(calls).toBe(1);
    expect(JS_TAG_DOMAIN.numericCoercionOf(JS_TAG_IDS.Object).kind).toBe("user-observable");
    for (const tag of [JsTag.Undefined, JsTag.Null, JsTag.Boolean, JsTag.NumberF64, JsTag.String]) {
      expect(JS_TAG_DOMAIN.numericCoercionOf(tagIdOfJsTag(tag)).kind).not.toBe("user-observable");
    }
  });
});

describe("#3954 phase 1 — the refinement lattice on IrType's dynamic leaf", () => {
  it("irDynamic carries the opaque id and compares exactly", () => {
    expect(irDynamic(JS_TAG_IDS.String)).toEqual({ kind: "dynamic", tag: JS_TAG_IDS.String });
    expect(irDynamic()).toEqual({ kind: "dynamic" });
    expect(irTypeEquals(irDynamic(JS_TAG_IDS.String), irDynamic(JS_TAG_IDS.String))).toBe(true);
    expect(irTypeEquals(irDynamic(JS_TAG_IDS.String), irDynamic(JS_TAG_IDS.Object))).toBe(false);
    expect(irTypeEquals(irDynamic(JS_TAG_IDS.String), irDynamic())).toBe(false);
  });

  it("join: top absorbs, equal refinements survive, distinct partitions widen", () => {
    const d = JS_TAG_DOMAIN;
    expect(joinTagRefinement(d, JS_TAG_IDS.String, JS_TAG_IDS.String)).toBe(JS_TAG_IDS.String);
    expect(joinTagRefinement(d, JS_TAG_IDS.String, JS_TAG_IDS.Object)).toBeUndefined();
    expect(joinTagRefinement(d, JS_TAG_IDS.String, undefined)).toBeUndefined();
    expect(joinTagRefinement(d, undefined, undefined)).toBeUndefined();
    expect(tagRefinementEquals(undefined, undefined)).toBe(true);
    expect(tagRefinementEquals(JS_TAG_IDS.String, undefined)).toBe(false);
    expect(formatTagRefinement(d, undefined)).toBe("?");
    expect(formatTagRefinement(d, JS_TAG_IDS.String)).toBe("String");
  });
});

describe("#3954 phase 1 — the interface is implementable without ECMAScript", () => {
  // A deliberately un-JS-like value model: arbitrary-precision integers (no
  // f64 anywhere), codepoint strings, a unit type, and a REAL subtype relation
  // (`Bool <: Int`, as in Python) so `joinTags` returns a proper supertag
  // rather than always widening to top. None of this is expressible with the
  // `JsTag` enum, which is the point.
  const Toy = { Unit: 0, Bool: 1, Int: 2, Text: 3 } as const;
  type ToyTag = (typeof Toy)[keyof typeof Toy];
  const id = (t: ToyTag): TagId => asTagId(t);

  const TOY_DOMAIN: TagDomain = {
    id: "toy",
    tags: [id(Toy.Unit), id(Toy.Bool), id(Toy.Int), id(Toy.Text)],
    nameOf: (t) => ["Unit", "Bool", "Int", "Text"][tagIdValue(t)] ?? "?",
    classOf: (t) => (tagIdValue(t) === Toy.Bool || tagIdValue(t) === Toy.Int ? "integer" : TOY_DOMAIN.nameOf(t)),
    carrierKindOf: (t): TagCarrierKind => {
      switch (tagIdValue(t)) {
        case Toy.Unit:
          return null;
        case Toy.Bool:
          return "i32";
        default:
          return "ref"; // bignum + codepoint text are both heap values here
      }
    },
    truthinessOf: (t): TagTruthiness => (tagIdValue(t) === Toy.Unit ? "always-false" : "payload-dependent"),
    numericCoercionOf: (t): TagNumericCoercion =>
      tagIdValue(t) === Toy.Text ? { kind: "throws" } : { kind: "payload" },
    // Bool ⊑ Int — a genuine hierarchy, unlike ECMAScript's flat partitions.
    joinTags: (a, b) => {
      if (a === b) return a;
      const pair = new Set([tagIdValue(a), tagIdValue(b)]);
      if (pair.has(Toy.Bool) && pair.has(Toy.Int)) return id(Toy.Int);
      return undefined;
    },
  };

  it("a non-JS domain satisfies the interface with no JS concepts at all", () => {
    expect(TOY_DOMAIN.tags).toHaveLength(4);
    expect(TOY_DOMAIN.carrierKindOf(id(Toy.Unit))).toBeNull();
    expect(isSingletonTag(TOY_DOMAIN, id(Toy.Unit))).toBe(true);
    // No f64 carrier exists in this model — a shape ECMAScript cannot have.
    expect(TOY_DOMAIN.tags.map((t) => TOY_DOMAIN.carrierKindOf(t))).not.toContain("f64");
    expect(TOY_DOMAIN.numericCoercionOf(id(Toy.Text))).toEqual({ kind: "throws" });
  });

  it("a domain with a real subtype relation joins to a supertag, not to top", () => {
    expect(joinTagRefinement(TOY_DOMAIN, id(Toy.Bool), id(Toy.Int))).toBe(id(Toy.Int));
    expect(joinTagRefinement(TOY_DOMAIN, id(Toy.Bool), id(Toy.Text))).toBeUndefined();
    // The generic helpers are domain-agnostic — same code, different lattice.
    expect(formatTagRefinement(TOY_DOMAIN, id(Toy.Text))).toBe("Text");
  });

  it("an IrType can carry the toy domain's tag (phase 3 owns lowering it)", () => {
    const t = irDynamic(id(Toy.Int));
    expect(t).toEqual({ kind: "dynamic", tag: id(Toy.Int) });
    expect(irTypeEquals(t, irDynamic(id(Toy.Int)))).toBe(true);
    expect(irTypeEquals(t, irDynamic(id(Toy.Text)))).toBe(false);
  });
});
