// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import * as oldErrors from "../src/ir/outcomes.js";
import * as errors from "../src/shared/contracts/ir-preparation-errors.js";
import * as oldGlobals from "../src/ir/abi-bindings.js";
import * as globals from "../src/ir/core/global-binding-keys.js";
import * as oldDeclared from "../src/ir/declared-types.js";
import * as declared from "../src/ir/core/declared-types.js";
import * as oldFnctor from "../src/ir/fnctor-abi.js";
import * as fnctor from "../src/ir/core/fnctor-abi.js";
import * as oldTags from "../src/ir/tag-domain.js";
import * as tags from "../src/ir/core/tag-domain.js";
import * as oldJsTags from "../src/ir/js-tag-domain.js";
import * as jsTags from "../src/ir/runtime/js-tag-domain.js";
import * as oldProducer from "../src/ir/producer.js";
import * as producer from "../src/ir/runtime/producer.js";
import * as oldStrings from "../src/ir/string-runtime.js";
import * as strings from "../src/ir/core/string-runtime.js";
import * as oldSites from "../src/ir/counted-string-append-provenance.js";
import * as sites from "../src/shared/contracts/ir-counted-string-site-id.js";
import * as oldSurrogates from "../src/string-surrogate.js";
import * as surrogates from "../src/shared/contracts/string-surrogate.js";
import * as oldSymbols from "../src/ir/runtime-symbols.js";
import * as symbols from "../src/ir/core/runtime-symbols.js";
import * as oldDates from "../src/ir/date-runtime.js";
import * as dates from "../src/ir/core/date-callables.js";
import * as concat from "../src/ir/core/string-callables.js";
import { JsTag } from "../src/runtime/contracts/js-value-tags.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import type { IrFunction, IrDeclaredSignature } from "../src/ir/core/nodes.js";
import { irVal, type IrType } from "../src/ir/core/types.js";
import type { IrGlobalBinding } from "../src/ir/core/value-references.js";
import { createIrBindingId, createDerivedIrUnitId } from "../src/shared/contracts/identity-values.js";
import { createIrSourceId, createIrUnitId, createIrClassId } from "../src/ir/identity.js";
import type { IrHostDateSnapshotGetter as AstDateGetter } from "../src/ir/ast-lowering-plans.js";

const sourceId = createIrSourceId({ kind: "source", order: 0, sourceKey: "contracts:😀.ts" });
const unitId = createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal: 0 });
const bindingId = createIrBindingId({ ownerId: unitId, domain: "global", role: "value" });
const f64 = irVal({ kind: "f64" });
const i32 = irVal({ kind: "i32" });

function semanticFunction(): IrFunction {
  const builder = new IrFunctionBuilder({ unitId, name: "identity" }, [f64]);
  const value = builder.addParam("value", f64);
  builder.openBlock();
  builder.terminate({ kind: "return", values: [value] });
  return builder.finish();
}

function constructorShape(): fnctor.IrFnctorShape {
  return {
    kind: "fnctor-shape",
    sourceId,
    constructorUnitId: unitId,
    constructorName: "Constructor",
    constructorTarget: { kind: "func", name: "Constructor", binding: { kind: "unit", unitId } },
    reservedLayout: {
      kind: "type",
      name: "layout",
      binding: { kind: "source", bindingId: createIrBindingId({ ownerId: unitId, domain: "type", role: "layout" }) },
    },
    fields: [{ name: "value", type: f64, ordinal: 0 }],
    captures: [
      { name: "first", type: f64, hasTdzFlag: true, ordinal: 0 },
      { name: "second", type: { kind: "string" }, hasTdzFlag: true, ordinal: 1 },
    ],
    userParamTypes: [i32],
    hiddenIdentity: true,
    constructorIdentity: { unitId, paramIndex: 5 },
  };
}

function constructorResolution(): fnctor.IrFnctorResolution {
  const shape = constructorShape();
  return {
    shape,
    structType: shape.reservedLayout,
    constructor: shape.constructorTarget,
    captureParamTypes: [f64, { kind: "string" }, i32, i32],
    userParamTypes: [i32],
    constructorIdentityParamIndex: 5,
    hiddenIdentity: true,
    resultIsExternref: false,
  };
}

const aliases: readonly [string, object, object, readonly string[]][] = [
  ["preparation errors", oldErrors, errors, []],
  ["global keys", oldGlobals, globals, ["requireString"]],
  ["declared types", oldDeclared, declared, []],
  ["fnctor ABI", oldFnctor, fnctor, []],
  ["neutral domain", oldTags, tags, []],
  ["JS domain", oldJsTags, jsTags, []],
  ["producer", oldProducer, producer, []],
  ["String semantics", oldStrings, strings, []],
  ["counted site grammar", oldSites, sites, []],
  ["surrogates", oldSurrogates, surrogates, []],
  ["runtime symbols", oldSymbols, symbols, []],
  ["Date callables", oldDates, dates, []],
];

describe("Phase A source validation contracts", () => {
  it.each(aliases)("keeps the original %s values identity-equal", (_name, legacy, canonical, internal) => {
    const entries = Object.entries(canonical).filter(([name]) => !internal.includes(name));
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, value] of entries) {
      expect(Object.hasOwn(legacy, name), name).toBe(true);
      expect(Reflect.get(legacy, name), name).toBe(value);
    }
  });

  it.each(["unsupported", "invariant"] as const)("preserves %s class identity and exact cause", (kind) => {
    const cause = { retained: true };
    const error =
      kind === "unsupported"
        ? new oldErrors.IrUnsupportedError("deferred-feature", "build", "unsupported", cause)
        : new errors.IrInvariantError("verifier-failure", "verify", "invariant", cause);
    expect(error).toBeInstanceOf(kind === "unsupported" ? errors.IrUnsupportedError : oldErrors.IrInvariantError);
    expect(error.name).toBe(kind === "unsupported" ? "IrUnsupportedError" : "IrInvariantError");
    expect(oldErrors.classifyIrFailure(error, "lower")).toEqual({
      kind,
      code: kind === "unsupported" ? "deferred-feature" : "verifier-failure",
      stage: kind === "unsupported" ? "build" : "verify",
      detail: kind,
      cause,
    });
    expect(errors.classifyIrFailure(error, "patch").cause).toBe(cause);
  });

  it("keeps typed demotion and omitted versus present cause", () => {
    let caught: unknown;
    try {
      oldErrors.demoteToLegacy("deferred-feature", "not yet lowered");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(errors.IrUnsupportedError);
    const classified = errors.classifyIrFailure(caught, "lower");
    expect(classified).toEqual({
      kind: "unsupported",
      code: "deferred-feature",
      stage: "build",
      detail: "not yet lowered",
    });
    expect(Object.hasOwn(classified, "cause")).toBe(false);
    expect(
      errors.classifyIrFailure(new errors.IrInvariantError("verifier-failure", "verify", "x", null), "lower").cause,
    ).toBeNull();
    const thrown = { toString: () => "unexpected payload" };
    expect(errors.classifyIrFailure(thrown, "patch")).toEqual({
      kind: "invariant",
      code: "unexpected-internal-throw",
      stage: "patch",
      detail: "unexpected payload",
      cause: thrown,
    });
  });

  it("retains capability-aware global identity independent of adapter names", () => {
    const first = oldGlobals.irSourceGlobalRef(bindingId, "first");
    const renamed = oldGlobals.irSourceGlobalRef(bindingId, "second");
    const dom = oldGlobals.irSourceGlobalRef(bindingId, "first", "dom");
    expect(globals.sameIrGlobalBinding(first.binding, renamed.binding)).toBe(true);
    expect(globals.sameIrGlobalBinding(first.binding, dom.binding)).toBe(false);
    expect(globals.irGlobalBindingKey(dom.binding)).toContain("|capability|3:dom");
    expect(() =>
      globals.irGlobalBindingKey({ ...first.binding, capability: "other" } as unknown as IrGlobalBinding),
    ).toThrow("source global capability must be dom when present");
  });

  it("shares import field validation while accepting the intentional empty string", () => {
    const ref = oldGlobals.irImportGlobalRef(sourceId, "env", "", "empty");
    expect(ref.binding.kind).toBe("import");
    expect(globals.irGlobalBindingKey(ref.binding)).toMatch(/\|3:env\|0:$/);
    expect(globals.requireString("", "field")).toBe("");
    expect(() => oldGlobals.irImportGlobalRef(sourceId, "env", 42 as unknown as string)).toThrow(
      "global import field must be a string",
    );
    expect(() =>
      globals.irGlobalBindingKey({ kind: "import", bindingId, module: "env", field: 42 } as unknown as IrGlobalBinding),
    ).toThrow("global import field must be a string");
    expect(() =>
      globals.irGlobalBindingKey({
        kind: "import",
        bindingId: "",
        module: "",
        field: 42,
      } as unknown as IrGlobalBinding),
    ).toThrow("global bindingId must be a non-empty string");
  });

  it("derives declared tables from actual semantic functions and retains explicit overrides", () => {
    const fn = semanticFunction();
    const key = declared.irBindingKey({ kind: "unit", unitId })!;
    const declaredGlobals = new Map([["support:global", f64]]);
    const derived = declared.irModuleDeclarations({ functions: [fn, { ...fn, params: [] }], declaredGlobals });
    expect(derived.declaredSignatures?.get(key)).toEqual({ params: [f64], result: f64 });
    expect(derived.declaredGlobals).toBe(declaredGlobals);
    const explicit: IrDeclaredSignature = { params: [], result: null };
    const overridden = oldDeclared.irModuleDeclarations({
      functions: [fn],
      declaredSignatures: new Map([[key, explicit]]),
    });
    expect(overridden.declaredSignatures?.get(key)).toBe(explicit);
    expect(declared.irModuleDeclarations({ functions: [] }).declaredSignatures?.size).toBe(0);
  });

  it.each(["async", "generator"] as const)("keeps the %s unknown result while declaring its true arity", (funcKind) => {
    const fn = { ...semanticFunction(), funcKind };
    const key = declared.irBindingKey({ kind: "unit", unitId })!;
    expect(declared.irModuleDeclarations({ functions: [fn] }).declaredSignatures?.get(key)).toEqual({
      params: [f64],
      result: null,
    });
  });

  it("keeps conservative unknown carriers and diagnostic ordering", () => {
    expect(declared.irBindingKey(null)).toBeNull();
    expect(declared.irBindingKey({ kind: "runtime" })).toBeNull();
    expect(declared.irBindingKey({ kind: "import", module: "env", field: "" })).toBe("import:env:");
    const signature = { params: [f64], result: f64 };
    expect(declared.declaredCallProblems("target", 0, "i32", signature, "f64")).toEqual([
      "call target passes 0 argument(s) but the module declares 1 parameter(s)",
      "call target resultType i32 contradicts the module-declared result f64",
    ]);
    expect(declared.declaredCallProblems("target", 1, null, signature, "f64")).toEqual([]);
    expect(declared.declaredCallProblems("target", 1, "i32", signature, null)).toEqual([]);
    expect(declared.declaredGlobalProblem("global.get", "g", "i32", null)).toBeNull();
    expect(declared.declaredGlobalProblem("global.set", "g", "i32", "f64")).toBe(
      "global.set g carrier i32 contradicts the module-declared f64",
    );
  });

  it("retains nominal fnctor targets and values-before-TDZ capture ordering", () => {
    const resolution = constructorResolution();
    expect(fnctor.validateIrFnctorResolution(resolution)).toBeNull();
    expect(
      fnctor.validateIrFnctorResolution({ ...resolution, captureParamTypes: [f64, i32, { kind: "string" }, i32] }),
    ).toBe("fnctor resolved capture parameter 1 differs from the shape");
    expect(fnctor.validateIrFnctorResolution({ ...resolution, constructorIdentityParamIndex: 4 })).toBe(
      "fnctor resolved identity parameter index differs from the shape",
    );
    expect(
      fnctor.irFnctorShapeEquals(resolution.shape, { ...resolution.shape, constructorName: "diagnostic only" }),
    ).toBe(true);
    const other = createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal: 1 });
    expect(
      fnctor.validateIrFnctorResolution({
        ...resolution,
        constructor: { ...resolution.constructor, binding: { kind: "unit", unitId: other } },
      }),
    ).toBe("fnctor resolved constructor does not preserve the nominal target");
  });

  it("retains fnctor duplicate, graph-cycle, and hidden identity checks", () => {
    const shape = constructorShape();
    expect(fnctor.validateIrFnctorShape({ ...shape, fields: [...shape.fields, shape.fields[0]!] })).toContain(
      "duplicate field",
    );
    expect(fnctor.validateIrFnctorShape({ ...shape, captures: [...shape.captures, shape.captures[0]!] })).toContain(
      "duplicate first",
    );
    const recursive = { ...shape, fields: [] as { name: string; type: IrType; ordinal: number }[] };
    recursive.fields.push({ name: "self", type: { kind: "fnctor", shape: recursive }, ordinal: 0 });
    expect(fnctor.validateIrFnctorShape(recursive)).toBe("fnctor shape contains a recursive shape graph");
    const resolution = constructorResolution();
    expect(
      fnctor.validateIrFnctorResolution({ ...resolution, hiddenIdentity: false, constructorIdentityParamIndex: null }),
    ).toBe("fnctor resolved hidden-identity mode differs from the shape");
  });

  it("keeps the single default JS domain and rejects foreign tag conversion", () => {
    expect(producer.defaultTagDomain()).toBe(jsTags.JS_TAG_DOMAIN);
    expect(oldProducer.tagDomainForProducer(producer.IR_DEFAULT_PRODUCER)).toBe(jsTags.JS_TAG_DOMAIN);
    expect(jsTags.JS_TAG_DOMAIN.tags).toEqual(Object.values(jsTags.JS_TAG_IDS));
    expect(jsTags.JS_TAG_DOMAIN.numericCoercionOf(jsTags.JS_TAG_IDS.Undefined)).toEqual({
      kind: "constant",
      value: NaN,
    });
    expect(jsTags.JS_TAG_DOMAIN.numericCoercionOf(jsTags.JS_TAG_IDS.Object)).toEqual({ kind: "user-observable" });
    expect(jsTags.JS_TAG_DOMAIN.classOf(jsTags.JS_TAG_IDS.NumberI32)).toBe("number");
    expect(jsTags.JS_TAG_DOMAIN.classOf(jsTags.JS_TAG_IDS.NumberF64)).toBe("number");
    expect(jsTags.jsTagOf(jsTags.tagIdOfJsTag(JsTag.String))).toBe(JsTag.String);
    expect(() => jsTags.jsTagOf(tags.asTagId(1001))).toThrow("not an ECMAScript partition");
    expect(() => jsTags.JS_TAG_DOMAIN.nameOf(tags.asTagId(1001))).toThrow("not an ECMAScript partition");
  });

  it("retains neutral helpers for an independent non-JS domain", () => {
    const small = tags.asTagId(1001),
      large = tags.asTagId(1002);
    const domain: tags.TagDomain = {
      id: "component-test-domain",
      tags: [small, large],
      nameOf: () => "foreign",
      classOf: () => "foreign",
      carrierKindOf: (tag) => (tag === small ? null : "ref"),
      truthinessOf: () => "not-coercible",
      numericCoercionOf: () => ({ kind: "throws" }),
      joinTags: () => large,
    };
    expect(tags.joinTagRefinement(domain, small, large)).toBe(large);
    expect(tags.joinTagRefinement(domain, small, undefined)).toBeUndefined();
    expect(tags.joinTagRefinement(domain, small, small)).toBe(small);
    expect(tags.isSingletonTag(domain, small)).toBe(true);
    expect(tags.isSingletonTag(domain, large)).toBe(false);
    expect(tags.formatTagRefinement(domain, undefined)).toBe("?");
    expect(tags.formatTagRefinement(domain, large)).toBe("foreign");
    expect(tags.tagIdValue(small)).toBe(1001);
  });

  it("retains immutable String specifications and prior concat authority", () => {
    expect(strings.irStringConcatManySymbol).toBe(concat.irStringConcatManySymbol);
    expect(Object.keys(strings.IR_STRING_RUNTIME)).toEqual([
      "constant",
      "concat",
      "repeat",
      "equals",
      "length",
      "char-at",
      "char-code-at",
      "iterator-char-at",
    ]);
    expect(Object.isFrozen(strings.IR_STRING_RUNTIME)).toBe(true);
    for (const specification of Object.values(strings.IR_STRING_RUNTIME)) {
      expect(Object.isFrozen(specification)).toBe(true);
      expect(Object.isFrozen(specification.operands)).toBe(true);
    }
    expect(strings.IR_STRING_RUNTIME["char-at"].index?.outOfBounds).toBe("empty-string");
    expect(strings.IR_STRING_RUNTIME["char-code-at"].index?.outOfBounds).toBe("nan");
  });

  it.each([
    [2, 0, true],
    [2, 536870912, true],
    [2, 536870913, false],
    [1, 1, false],
    [2.5, 0, false],
    [2147483647, 0, true],
    [2147483648, 0, false],
    [Infinity, 0, false],
    [2, -1, false],
  ] as const)("keeps native repeat bounds for %s × %s", (count, length, expected) => {
    expect(strings.irCountedStringRepeatFitsNativeKernel(count, length)).toBe(expected);
  });

  it.each([
    ["3", 3],
    ["003", 3],
    ["2", null],
    ["3.0", null],
    ["", null],
    ["9007199254740992", null],
  ] as const)("preserves concat suffix grammar %j", (suffix, expected) => {
    expect(strings.parseIrStringConcatManyArity(strings.IR_STRING_CONCAT_MANY_PREFIX + suffix)).toBe(expected);
  });

  it("keeps code-unit String semantics and repeat errors", () => {
    expect(strings.utf16CharAt("😀", 0)).toBe("\ud83d");
    expect(strings.utf16CharCodeAt("😀", 1)).toBe(0xde00);
    expect(strings.utf16CharAt("a", Infinity)).toBe("");
    expect(strings.utf16CharCodeAt("a", -1)).toBeNaN();
    expect(strings.utf16CharAt("abc", undefined)).toBe("a");
    expect(Object.is(strings.toIntegerOrInfinity(-0), -0)).toBe(true);
    expect(strings.repeatString("xy", 2.8)).toBe("xyxy");
    expect(strings.repeatString("xy", NaN)).toBe("");
    expect(() => strings.repeatString("", Infinity)).toThrow(RangeError);
    expect(() => strings.repeatString("x", -1)).toThrow("Invalid count value");
  });

  it("parses canonical real source, class-owner and nested-unit identities", () => {
    const classId = createIrClassId({ sourceId, lexicalOwnerId: unitId, declarationKind: "expression", ordinal: 0 });
    const method = createIrUnitId({ sourceId, lexicalOwnerId: classId, kind: "class-instance-method", ordinal: 0 });
    const identity = { sourceId, ownerUnitId: method, loopStart: 3, loopEnd: 19 };
    const siteId = oldSites.createIrCountedStringAppendSiteId(identity);
    const parsed = sites.parseIrCountedStringAppendSiteId(siteId);
    expect(parsed).toEqual(identity);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(sites.irCountedStringAppendSiteIdIsCurrent(siteId, identity)).toBe(true);
    expect(sites.irCountedStringAppendSiteIdIsCurrent(siteId, { ...identity, loopEnd: 20 })).toBe(false);
    expect(() => sites.assertUniqueCurrentIrCountedStringAppendSites([{ ...identity, siteId }])).not.toThrow();
    expect(() =>
      sites.assertUniqueCurrentIrCountedStringAppendSites([
        { ...identity, siteId },
        { ...identity, siteId },
      ]),
    ).toThrow("duplicate counted-string append site");
    expect(() => sites.assertUniqueCurrentIrCountedStringAppendSites([{ ...identity, siteId, loopEnd: 20 }])).toThrow(
      "malformed or detached",
    );
  });

  it("rejects cross-source, derived, and malformed counted-site identities", () => {
    const identity = { sourceId, ownerUnitId: unitId, loopStart: 3, loopEnd: 19 };
    const site = sites.createIrCountedStringAppendSiteId(identity);
    expect(sites.parseIrCountedStringAppendSiteId(site.replace("%3A", "%3a"))).toBeUndefined();
    expect(sites.parseIrCountedStringAppendSiteId(site.replace(":0000000000000003:", ":3:"))).toBeUndefined();
    expect(sites.parseIrCountedStringAppendSiteId(site.replace(":v1:", ":v2:"))).toBeUndefined();
    const otherSource = createIrSourceId({ kind: "source", order: 1, sourceKey: "other.ts" });
    expect(() => sites.createIrCountedStringAppendSiteId({ ...identity, sourceId: otherSource })).toThrow(
      "source-qualified non-derived identity",
    );
    const derived = createDerivedIrUnitId({ parentId: unitId, role: "lifted-closure", ordinal: 0 });
    expect(() => sites.createIrCountedStringAppendSiteId({ ...identity, ownerUnitId: derived })).toThrow(
      "source-qualified non-derived identity",
    );
    expect(() => sites.createIrCountedStringAppendSiteId({ ...identity, loopStart: -1, loopEnd: -2 })).toThrow(
      "loopStart must be a non-negative safe integer",
    );
    expect(() => sites.createIrCountedStringAppendSiteId({ ...identity, loopEnd: 3 })).toThrow(
      "loopEnd must be greater than loopStart",
    );
  });

  it.each([
    ["", false, ""],
    ["a", false, "0061"],
    ["😀", false, "d83dde00"],
    ["\ud800", true, "d800"],
    ["\udc00", true, "dc00"],
    ["\ud800a", true, "d8000061"],
  ] as const)("keeps surrogate identity for %j", (input, lone, hex) => {
    expect(surrogates.hasLoneSurrogate(input)).toBe(lone);
    expect(surrogates.hexCodeUnits(input)).toBe(hex);
  });

  it.each(["getDate", "getMonth", "getFullYear"] as const)(
    "keeps the Date callable union and symbol for %s",
    (getter: AstDateGetter) => {
      const symbol = dates.irDateSnapshotGetterSymbol(getter);
      expect(dates.parseIrDateSnapshotGetter(symbol)).toBe(getter);
      expect(dates.parseIrDateSnapshotGetter(symbol + " ")).toBeUndefined();
      expect(dates.parseIrDateSnapshotGetter("getDate")).toBeUndefined();
    },
  );
});
