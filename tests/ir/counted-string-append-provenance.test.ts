// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../../src/checker/index.js";
import { TsCheckerOracle } from "../../src/checker/oracle.js";
import { planCountedStringAppend } from "../../src/ir/analysis/counted-string-append.js";
import type { IrCountedStringAppendLoweringPlan } from "../../src/ir/ast-lowering-plans.js";
import { irIntrinsicFuncRef } from "../../src/ir/callable-bindings.js";
import {
  associateFinalIrCountedStringAppendSites,
  assertUniqueCurrentIrCountedStringAppendSites,
  collectFinalIrCountedStringAppendInstructions,
  createIrCountedStringAppendSiteId,
  irCountedStringAppendSiteIdIsCurrent,
  parseIrCountedStringAppendSiteId,
  type IrCountedStringAppendFinalArtifact,
  type IrCountedStringAppendSiteClaim,
  type IrCountedStringAppendSiteIdentity,
} from "../../src/ir/counted-string-append-provenance.js";
import {
  buildIrUnitInventory,
  createIrClassId,
  createDerivedIrUnitId,
  createIrSourceId,
  createIrUnitId,
  type IrSourceId,
  type IrUnitId,
} from "../../src/ir/identity.js";
import { asAllocSiteId, asValueId, type IrInstr } from "../../src/ir/nodes.js";
import {
  buildIrPlanningIdentityContext,
  requireIrPlanningOwnerUnitId,
  requireIrPlanningSourceId,
} from "../../src/ir/planning-identity.js";
import { IR_STRING_REPEAT_FN } from "../../src/ir/string-runtime.js";
import { ts } from "../../src/ts-api.js";

function fixture() {
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "entry:main.ts" });
  const otherSourceId = createIrSourceId({ kind: "source", order: 1, sourceKey: "dep%3Avalue.ts" });
  const ownerUnitId = createIrUnitId({
    sourceId,
    lexicalOwnerId: null,
    kind: "top-level-function",
    ordinal: 0,
  });
  const otherOwnerUnitId = createIrUnitId({
    sourceId,
    lexicalOwnerId: null,
    kind: "top-level-function",
    ordinal: 1,
  });
  const foreignOwnerUnitId = createIrUnitId({
    sourceId: otherSourceId,
    lexicalOwnerId: null,
    kind: "top-level-function",
    ordinal: 0,
  });
  const identity = Object.freeze({ sourceId, ownerUnitId, loopStart: 17, loopEnd: 43 });
  return { identity, sourceId, otherSourceId, ownerUnitId, otherOwnerUnitId, foreignOwnerUnitId };
}

function claim(identity: IrCountedStringAppendSiteIdentity): IrCountedStringAppendSiteClaim {
  return { ...identity, siteId: createIrCountedStringAppendSiteId(identity) };
}

function forgedSite(sourceId: string, ownerUnitId: string): string {
  return `ir-counted-string-append-site:v1:${encodeURIComponent(sourceId)}:${encodeURIComponent(
    ownerUnitId,
  )}:0000000000000017:0000000000000043`;
}

function forgedRootUnit(sourceId: string, kind = "top-level-function", ordinal = "0000000000000000"): string {
  return `ir-unit:v1:${encodeURIComponent(sourceId)}:root:${kind}:${ordinal}`;
}

function nestedBuffer(...instructions: readonly IrInstr[]): IrInstr {
  return {
    kind: "if.stmt",
    cond: asValueId(99),
    then: instructions,
    else: [],
    result: null,
    resultType: null,
  };
}

function associationFixture(
  fileName = "counted-provenance.ts",
  source = `
    export function first(): string {
      let value = "seed";
      for (let index = 0; index < 3; index++) value = value + "a";
      return value;
    }
    export function second(): string {
      let value = "seed";
      for (let index = 0; index < 4; index++) value = value + "b";
      return value;
    }
  `,
): {
  readonly plans: readonly IrCountedStringAppendLoweringPlan[];
  readonly repeat: (
    plan: IrCountedStringAppendLoweringPlan,
    site?: string | null,
  ) => Extract<IrInstr, { kind: "string.repeat" }>;
  readonly artifact: (
    plan: IrCountedStringAppendLoweringPlan,
    instructions: readonly IrInstr[],
  ) => IrCountedStringAppendFinalArtifact;
} {
  const { sourceFile, checker } = analyzeSource(source, fileName);
  const oracle = new TsCheckerOracle(checker);
  const identityContext = buildIrPlanningIdentityContext(
    buildIrUnitInventory([sourceFile], { entrySource: sourceFile }),
  );
  const loops: ts.ForStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isForStatement(node)) loops.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const plans = loops.map((loop): IrCountedStringAppendLoweringPlan => {
    const syntaxPlan = planCountedStringAppend({ checker, oracle }, loop);
    if (!syntaxPlan) throw new Error("association fixture lost its checker-certified counted plan");
    const ownerUnitId = requireIrPlanningOwnerUnitId(identityContext, loop);
    const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
    return Object.freeze({
      ownerUnitId,
      sourceId,
      siteId: createIrCountedStringAppendSiteId({
        sourceId,
        ownerUnitId,
        loopStart: loop.getStart(sourceFile),
        loopEnd: loop.getEnd(),
      }),
      sourceFile,
      syntaxPlan,
      provider: irIntrinsicFuncRef(IR_STRING_REPEAT_FN),
    });
  });
  const repeat = (
    plan: IrCountedStringAppendLoweringPlan,
    site: string | null = plan.siteId,
  ): Extract<IrInstr, { kind: "string.repeat" }> => ({
    kind: "string.repeat",
    value: asValueId(0),
    count: asValueId(1),
    encodingEvidence: "ascii",
    provider: plan.provider,
    ...(site === null ? {} : { countedStringAppendSite: site as typeof plan.siteId }),
    result: asValueId(2),
    resultType: { kind: "string" },
    alloc: asAllocSiteId(0),
  });
  const artifact = (
    plan: IrCountedStringAppendLoweringPlan,
    instructions: readonly IrInstr[],
  ): IrCountedStringAppendFinalArtifact => ({
    artifactUnitId: plan.ownerUnitId,
    terminalOwnerUnitId: plan.ownerUnitId,
    instructions,
  });
  return { plans: Object.freeze(plans), repeat, artifact };
}

describe("counted string-append site provenance", () => {
  it("round-trips one immutable canonical source/owner/span identity", () => {
    const { identity } = fixture();
    const siteId = createIrCountedStringAppendSiteId(identity);
    const parsed = parseIrCountedStringAppendSiteId(siteId);

    expect(parsed).toEqual(identity);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(irCountedStringAppendSiteIdIsCurrent(siteId, identity)).toBe(true);
    expect(createIrCountedStringAppendSiteId(identity)).toBe(siteId);
  });

  it("round-trips canonical nested-unit and class-member owners", () => {
    const { identity, sourceId, ownerUnitId } = fixture();
    const nestedOwnerUnitId = createIrUnitId({
      sourceId,
      lexicalOwnerId: ownerUnitId,
      kind: "nested-function",
      ordinal: 2,
    });
    const classId = createIrClassId({
      sourceId,
      lexicalOwnerId: null,
      declarationKind: "declaration",
      ordinal: 0,
    });
    const methodOwnerUnitId = createIrUnitId({
      sourceId,
      lexicalOwnerId: classId,
      kind: "class-instance-method",
      ordinal: 0,
    });

    for (const owner of [nestedOwnerUnitId, methodOwnerUnitId]) {
      const nestedIdentity = { ...identity, ownerUnitId: owner };
      const siteId = createIrCountedStringAppendSiteId(nestedIdentity);
      expect(parseIrCountedStringAppendSiteId(siteId)).toEqual(nestedIdentity);
      expect(irCountedStringAppendSiteIdIsCurrent(siteId, nestedIdentity)).toBe(true);
    }
  });

  it("keeps every tuple dimension collision-free", () => {
    const { identity, otherSourceId, otherOwnerUnitId, foreignOwnerUnitId } = fixture();
    const ids = [
      createIrCountedStringAppendSiteId(identity),
      createIrCountedStringAppendSiteId({ ...identity, sourceId: otherSourceId, ownerUnitId: foreignOwnerUnitId }),
      createIrCountedStringAppendSiteId({ ...identity, ownerUnitId: otherOwnerUnitId }),
      createIrCountedStringAppendSiteId({ ...identity, loopStart: identity.loopStart + 1 }),
      createIrCountedStringAppendSiteId({ ...identity, loopEnd: identity.loopEnd + 1 }),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects malformed and noncanonical encodings", () => {
    const { identity } = fixture();
    const canonical = createIrCountedStringAppendSiteId(identity);
    const malformed = [
      "",
      canonical.replace("ir-counted-string-append-site:v1", "ir-counted-string-append-site:v2"),
      canonical.replace("ir-source%3A", "source%3A"),
      canonical.replace("ir-unit%3A", "unit%3A"),
      canonical.replace("%3A", "%3a"),
      canonical.replace(":0000000000000017:", ":17:"),
      canonical.replace(":0000000000000043", ":0000000000000017"),
      canonical.replace(":0000000000000043", ":0000000000000016"),
      `${canonical}:extra`,
      "ir-counted-string-append-site:v1:%E0%A4%A:x:0000000000000001:0000000000000002",
      "ir-counted-string-append-site:v1:ir-source%3Av1%3Ax:ir-unit%3Av1%3Ax:9007199254740992:9007199254740993",
    ];

    for (const value of malformed) {
      expect(parseIrCountedStringAppendSiteId(value), value).toBeUndefined();
      expect(irCountedStringAppendSiteIdIsCurrent(value, identity), value).toBe(false);
    }
    expect(() => createIrCountedStringAppendSiteId({ ...identity, loopStart: -1 })).toThrow(/non-negative/);
    expect(() => createIrCountedStringAppendSiteId({ ...identity, loopStart: 43 })).toThrow(/greater than loopStart/);
  });

  it("rejects same-source and cross-source borrowed identities", () => {
    const { identity, otherSourceId, otherOwnerUnitId, foreignOwnerUnitId } = fixture();
    const siteId = createIrCountedStringAppendSiteId(identity);
    const sameSourceBorrow = { ...identity, ownerUnitId: otherOwnerUnitId };
    const crossSourceBorrow = { ...identity, sourceId: otherSourceId, ownerUnitId: foreignOwnerUnitId };

    expect(irCountedStringAppendSiteIdIsCurrent(siteId, sameSourceBorrow)).toBe(false);
    expect(irCountedStringAppendSiteIdIsCurrent(siteId, crossSourceBorrow)).toBe(false);
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([{ ...sameSourceBorrow, siteId }])).toThrow(
      /detached from its exact source\/owner\/span/,
    );
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([{ ...crossSourceBorrow, siteId }])).toThrow(
      /detached from its exact source\/owner\/span/,
    );
  });

  it("rejects an owner borrowed from a different source at every authority seam", () => {
    const { identity, sourceId, otherSourceId, foreignOwnerUnitId } = fixture();
    const inconsistent = { ...identity, sourceId, ownerUnitId: foreignOwnerUnitId };
    const foreignSiteId = createIrCountedStringAppendSiteId({
      ...identity,
      sourceId: otherSourceId,
      ownerUnitId: foreignOwnerUnitId,
    });
    const inconsistentEncoding = foreignSiteId.replace(encodeURIComponent(otherSourceId), encodeURIComponent(sourceId));

    expect(() => createIrCountedStringAppendSiteId(inconsistent)).toThrow(/source-qualified non-derived identity/);
    expect(parseIrCountedStringAppendSiteId(inconsistentEncoding)).toBeUndefined();
    expect(irCountedStringAppendSiteIdIsCurrent(foreignSiteId, inconsistent)).toBe(false);
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([{ ...inconsistent, siteId: foreignSiteId }])).toThrow(
      /detached from its exact source\/owner\/span/,
    );
  });

  it("rejects forged branded identity prefixes at the factory", () => {
    const { identity } = fixture();
    const derivedOwnerUnitId = createDerivedIrUnitId({
      parentId: identity.ownerUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });

    expect(() => createIrCountedStringAppendSiteId({ ...identity, sourceId: "forged-source" as IrSourceId })).toThrow(
      /sourceId is not a canonical/,
    );
    expect(() => createIrCountedStringAppendSiteId({ ...identity, ownerUnitId: "forged-unit" as IrUnitId })).toThrow(
      /ownerUnitId is not a canonical/,
    );
    expect(() => createIrCountedStringAppendSiteId({ ...identity, ownerUnitId: derivedOwnerUnitId })).toThrow(
      /source-qualified non-derived identity/,
    );
  });

  it("rejects prefixed but structurally noncanonical source and unit identities", () => {
    const { identity } = fixture();
    const sourceId = identity.sourceId as string;
    const ownerUnitId = identity.ownerUnitId as string;
    const shortSourceOrdinal = sourceId.replace(/:([0-9]{16}):/, ":000000000000000:");
    const unsafeSourceOrdinal = sourceId.replace(/:([0-9]{16}):/, ":9007199254740992:");
    const unknownSourceKind = sourceId.replace(":entry:", ":unknown-source:");
    const truncatedSource = sourceId.replace(/:[^:]+$/, "");
    const lowercaseEscapeSource = sourceId.replace("%3A", "%3a");
    const unnecessaryEscapeSource = sourceId.replace("main.ts", "%41main.ts");
    const noncanonicalDecodedUnitSource = ownerUnitId.replace("%3A", "%3a");
    const unnecessarilyEscapedDecodedUnitSource = ownerUnitId.replace("main.ts", "%41main.ts");
    const badNestedUnit = forgedRootUnit(sourceId, "unknown-unit");
    const badNestedClass = `ir-class:v1:${encodeURIComponent(sourceId)}:root:unknown-declaration:0000000000000000`;
    const derivedOwnerUnitId = createDerivedIrUnitId({
      parentId: identity.ownerUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    const mutations: readonly (readonly [string, string, string])[] = [
      ["truncated source", truncatedSource, forgedRootUnit(truncatedSource)],
      ["15-digit source ordinal", shortSourceOrdinal, forgedRootUnit(shortSourceOrdinal)],
      [">MAX_SAFE source ordinal", unsafeSourceOrdinal, forgedRootUnit(unsafeSourceOrdinal)],
      ["unknown source kind", unknownSourceKind, forgedRootUnit(unknownSourceKind)],
      ["lowercase source escape", lowercaseEscapeSource, forgedRootUnit(lowercaseEscapeSource)],
      ["unnecessary source escape", unnecessaryEscapeSource, forgedRootUnit(unnecessaryEscapeSource)],
      ["truncated unit", sourceId, ownerUnitId.replace(/:[^:]+$/, "")],
      ["15-digit unit ordinal", sourceId, ownerUnitId.replace(/:[0-9]{16}$/, ":000000000000000")],
      [">MAX_SAFE unit ordinal", sourceId, ownerUnitId.replace(/:[0-9]{16}$/, ":9007199254740992")],
      ["unknown unit kind", sourceId, ownerUnitId.replace(":top-level-function:", ":unknown-unit:")],
      ["noncanonical decoded unit source", sourceId, noncanonicalDecodedUnitSource],
      ["unnecessarily escaped decoded unit source", sourceId, unnecessarilyEscapedDecodedUnitSource],
      ["raw lexical owner", sourceId, ownerUnitId.replace(":root:", ":forged-owner:")],
      [
        "noncanonical nested unit owner",
        sourceId,
        ownerUnitId.replace(":root:", `:${encodeURIComponent(badNestedUnit)}:`),
      ],
      [
        "noncanonical nested class owner",
        sourceId,
        ownerUnitId.replace(":root:", `:${encodeURIComponent(badNestedClass)}:`),
      ],
      ["derived outer unit", sourceId, derivedOwnerUnitId],
    ];

    for (const [label, source, owner] of mutations) {
      const siteId = forgedSite(source, owner);
      expect(parseIrCountedStringAppendSiteId(siteId), label).toBeUndefined();
      expect(
        () =>
          createIrCountedStringAppendSiteId({
            sourceId: source as IrSourceId,
            ownerUnitId: owner as IrUnitId,
            loopStart: 17,
            loopEnd: 43,
          }),
        label,
      ).toThrow();
    }
  });

  it("rejects duplicate canonical sites before an expected-site index is built", () => {
    const { identity } = fixture();
    const exact = claim(identity);

    expect(() => assertUniqueCurrentIrCountedStringAppendSites([exact])).not.toThrow();
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([exact, { ...exact }])).toThrow(
      /duplicate counted-string append site/,
    );
    expect(() =>
      assertUniqueCurrentIrCountedStringAppendSites([{ ...exact, siteId: `${exact.siteId}:forged` }]),
    ).toThrow(/malformed or detached/);
  });
});

describe.each(["WasmGC-shaped", "linear-shaped"])("shared final association (%s)", (_backend) => {
  it("selects prepared async-runtime states over the semantic-plan fallback", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const foreign = associationFixture("foreign-async-runtime-provenance.ts");
    const foreignPlan = foreign.plans[0];
    if (!foreignPlan) throw new Error("fixture lost its foreign counted plan");

    const selectedRuntime = collectFinalIrCountedStringAppendInstructions({
      blocks: [],
      asyncPlan: { states: [{ body: [repeat(first, foreignPlan.siteId)] }] },
      asyncRuntime: { states: [{ body: [repeat(first)] }] },
    });
    expect(
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, selectedRuntime),
        artifact(second, [repeat(second)]),
      ]),
    ).toHaveLength(2);

    const runtimeOnlyUnknown = collectFinalIrCountedStringAppendInstructions({
      blocks: [],
      asyncPlan: { states: [{ body: [repeat(first)] }] },
      asyncRuntime: { states: [{ body: [repeat(first, foreignPlan.siteId)] }] },
    });
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, runtimeOnlyUnknown),
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/unknown site/);
  });

  it("ignores a generic repeat, joins reordered counted sites, and preserves retained-plan receipt order", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const generic = repeat(first, null);

    const receipts = associateFinalIrCountedStringAppendSites(plans, [
      artifact(second, [generic, repeat(second)]),
      artifact(first, [repeat(first)]),
    ]);

    expect(receipts.map((receipt) => receipt.siteId)).toEqual(plans.map((plan) => plan.siteId));
    expect(receipts.map((receipt) => receipt.plan)).toEqual(plans);
    expect(receipts.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(receipts)).toBe(true);
  });

  it("joins an expected site inside a nested instruction buffer", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");

    const receipts = associateFinalIrCountedStringAppendSites(plans, [
      artifact(first, [nestedBuffer(repeat(first))]),
      artifact(second, [repeat(second)]),
    ]);

    expect(receipts.map((receipt) => receipt.siteId)).toEqual(plans.map((plan) => plan.siteId));
  });

  it("rejects replacement, deletion, duplicate, malformed, and unknown final sites", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const foreign = associationFixture("foreign-counted-provenance.ts");
    const foreignPlan = foreign.plans[0];
    if (!foreignPlan) throw new Error("fixture lost its foreign counted plan");

    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, [repeat(first, null)]),
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/expected site .* is missing/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [artifact(first, []), artifact(second, [repeat(second)])]),
    ).toThrow(/expected site .* is missing/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, [repeat(first), repeat(first)]),
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/occurs more than once/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, [repeat(first, `${first.siteId}:forged`)]),
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/malformed site/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, [repeat(first, foreignPlan.siteId)]),
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/unknown site/);
  });

  it("scans a successful artifact with no retained counted sidecar", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const unrelated = associationFixture("unrelated-generic-repeat.ts");
    const unrelatedPlan = unrelated.plans[0];
    if (!unrelatedPlan) throw new Error("fixture lost its unrelated owner identity");
    const ordinaryArtifacts = [artifact(first, [repeat(first)]), artifact(second, [repeat(second)])] as const;

    expect(
      associateFinalIrCountedStringAppendSites(plans, [
        ...ordinaryArtifacts,
        unrelated.artifact(unrelatedPlan, [nestedBuffer(unrelated.repeat(unrelatedPlan, null))]),
      ]),
    ).toHaveLength(2);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        ...ordinaryArtifacts,
        unrelated.artifact(unrelatedPlan, [nestedBuffer(unrelated.repeat(unrelatedPlan))]),
      ]),
    ).toThrow(/unknown site/);
  });

  it("rejects same-source different-owner and cross-source site borrowing", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const foreign = associationFixture("foreign-counted-provenance.ts");
    const foreignPlan = foreign.plans[0];
    if (!foreignPlan) throw new Error("fixture lost its foreign counted plan");

    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, []),
        artifact(second, [repeat(second, first.siteId)]),
      ]),
    ).toThrow(/site .* is borrowed by final artifact/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        { ...artifact(first, [repeat(first)]), terminalOwnerUnitId: second.ownerUnitId },
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/site .* is borrowed by final artifact/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        { ...artifact(first, [repeat(first)]), artifactUnitId: second.ownerUnitId },
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/site .* is borrowed by final artifact/);
    expect(() =>
      associateFinalIrCountedStringAppendSites(
        [...plans, foreignPlan],
        [
          artifact(first, []),
          artifact(second, [repeat(second)]),
          foreign.artifact(foreignPlan, [foreign.repeat(foreignPlan, first.siteId)]),
        ],
      ),
    ).toThrow(/borrowed/);
  });

  it("rejects final-provider drift and equal-but-noncanonical plan/final providers", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const noncanonicalProvider = irIntrinsicFuncRef("__noncanonical_string_repeat");

    expect(() =>
      associateFinalIrCountedStringAppendSites(plans, [
        artifact(first, [{ ...repeat(first), provider: noncanonicalProvider }]),
        artifact(second, [repeat(second)]),
      ]),
    ).toThrow(/non-canonical final provider/);

    const equallyTamperedPlan = Object.freeze({ ...first, provider: noncanonicalProvider });
    expect(() =>
      associateFinalIrCountedStringAppendSites(
        [equallyTamperedPlan, second],
        [
          artifact(equallyTamperedPlan, [{ ...repeat(equallyTamperedPlan), provider: noncanonicalProvider }]),
          artifact(second, [repeat(second)]),
        ],
      ),
    ).toThrow(/non-canonical provider/);
  });

  it("publishes frozen zero/one-trip receipts without a repeat and rejects one if it appears", () => {
    const zeroOne = associationFixture(
      "zero-one-counted-provenance.ts",
      `
        export function zero(): string {
          let value = "seed";
          for (let index = 0; index < 0; index++) value = value + "a";
          return value;
        }
        export function one(): string {
          let value = "seed";
          for (let index = 0; index < 1; index++) value = value + "b";
          return value;
        }
      `,
    );
    const [zero, one] = zeroOne.plans;
    if (!zero || !one) throw new Error("fixture lost zero/one counted plans");

    const receipts = associateFinalIrCountedStringAppendSites(zeroOne.plans, [
      zeroOne.artifact(zero, []),
      zeroOne.artifact(one, []),
    ]);
    expect(receipts.map((receipt) => [receipt.siteId, receipt.plan.syntaxPlan.tripCount])).toEqual([
      [zero.siteId, 0],
      [one.siteId, 1],
    ]);
    expect(receipts.every(Object.isFrozen)).toBe(true);
    expect(() =>
      associateFinalIrCountedStringAppendSites(zeroOne.plans, [
        zeroOne.artifact(zero, [zeroOne.repeat(zero)]),
        zeroOne.artifact(one, []),
      ]),
    ).toThrow(/zero\/one-trip site .* unexpectedly emitted/);
  });

  it("fails a two-owner transaction before publishing an earlier successful receipt", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first] = plans;
    if (!first || plans.length !== 2) throw new Error("fixture lost its two counted owners");
    const published: unknown[] = [];

    expect(() => {
      published.push(...associateFinalIrCountedStringAppendSites(plans, [artifact(first, [repeat(first)])]));
    }).toThrow(/expected site .* is missing|no exact final terminal artifact/);
    expect(published).toEqual([]);
  });

  it("rejects mutable retained plan evidence before publishing any receipt", () => {
    const { plans, repeat, artifact } = associationFixture();
    const [first, second] = plans;
    if (!first || !second) throw new Error("fixture lost its two counted plans");
    const artifacts = [artifact(first, [repeat(first)]), artifact(second, [repeat(second)])] as const;

    for (const mutablePlan of [{ ...first }, Object.freeze({ ...first, syntaxPlan: { ...first.syntaxPlan } })]) {
      const published: unknown[] = [];
      expect(() => {
        published.push(...associateFinalIrCountedStringAppendSites([mutablePlan, second], artifacts));
      }).toThrow(/mutable retained plan evidence/);
      expect(published).toEqual([]);
    }
  });
});
