import { describe, expect, it } from "vitest";
import {
  IR_CUTOVER_AUDIT_SCHEMA,
  evaluateIrCutoverAuditJsonl,
  formatIrCutoverAuditReport,
} from "../scripts/check-standalone-ir-cutover.mjs";

const SOURCE_ID = "source:fixture";
const TERMINAL_ID = "unit:fixture:main";
const SUPPORT_ID = "unit:fixture:support";
const DERIVED_ID = "unit:fixture:derived";

function source() {
  return {
    id: SOURCE_ID,
    kind: "entry",
    order: 0,
    sourceKey: "fixture.ts",
  };
}

function declarationEntry(target = "standalone") {
  return {
    target,
    entryPoint: "compileDeclarations",
    bodyName: "fixture.ts",
    file: "fixture.ts",
    line: 1,
    column: 1,
    sourceId: SOURCE_ID,
    count: 1,
  };
}

function legacyEnvelope() {
  return {
    schema: IR_CUTOVER_AUDIT_SCHEMA,
    success: true,
    audit: {
      route: "compile",
      target: "standalone",
      graph: "single",
      generator: "generateModule",
      sources: [source()],
      classes: [],
      sourceCount: 1,
      classCount: 0,
      allUnitCount: 1,
      terminalUnitCount: 1,
      ownedSupportUnitCount: 0,
      unownedSupportUnitCount: 0,
      legacyEntries: [
        declarationEntry(),
        {
          target: "standalone",
          entryPoint: "compileFunctionBody",
          bodyName: "main",
          file: "fixture.ts",
          line: 1,
          column: 1,
          sourceId: SOURCE_ID,
          unitId: TERMINAL_ID,
          unitKind: "top-level-function",
          terminalOwnerId: TERMINAL_ID,
          count: 1,
        },
      ],
      dispositions: [
        {
          sourceId: SOURCE_ID,
          unitId: TERMINAL_ID,
          unitKind: "top-level-function",
          terminal: true,
          terminalOwnerId: TERMINAL_ID,
          disposition: "legacy-ast-entry",
        },
      ],
      derivedUnits: [],
      violations: [],
      structurallyComplete: true,
      unattributedLegacyEntryCount: 0,
    },
  };
}

function cleanIrEnvelope() {
  const envelope = legacyEnvelope();
  envelope.audit.allUnitCount = 2;
  envelope.audit.ownedSupportUnitCount = 1;
  envelope.audit.legacyEntries = [declarationEntry()];
  envelope.audit.dispositions = [
    { ...envelope.audit.dispositions[0]!, disposition: "terminal-ir" },
    {
      sourceId: SOURCE_ID,
      unitId: SUPPORT_ID,
      unitKind: "synthetic-support",
      terminal: false,
      terminalOwnerId: TERMINAL_ID,
      disposition: "owned-support-ir-owner",
    },
  ];
  envelope.audit.derivedUnits = [
    {
      id: DERIVED_ID,
      parentId: TERMINAL_ID,
      terminalOwnerId: TERMINAL_ID,
      sourceId: SOURCE_ID,
      role: "lifted-closure",
      ordinal: 0,
      disposition: "derived-ir-owner",
    },
  ];
  return envelope;
}

function failedIncompleteEnvelope() {
  const envelope = legacyEnvelope();
  envelope.success = false;
  envelope.audit.legacyEntries = [declarationEntry()];
  envelope.audit.dispositions[0]!.disposition = "unresolved-terminal";
  envelope.audit.violations = [
    {
      code: "missing-terminal-evidence",
      detail: `terminal ${TERMINAL_ID} has no body evidence`,
      unitId: TERMINAL_ID,
    },
  ];
  envelope.audit.structurallyComplete = false;
  return envelope;
}

function jsonl(...envelopes: unknown[]) {
  return `${envelopes.map((envelope) => JSON.stringify(envelope)).join("\n")}\n`;
}

function codes(report: ReturnType<typeof evaluateIrCutoverAuditJsonl>) {
  return report.errors.map((item) => item.code);
}

const STRICT_FLOORS = { requireNoLegacy: true, expectSuccessful: 1, minSources: 1, minUnits: 1 };

describe("standalone IR cutover JSONL collector", () => {
  it("accepts observational legacy evidence by default but rejects it in strict mode", () => {
    const input = jsonl(legacyEnvelope());
    expect(evaluateIrCutoverAuditJsonl(input).ok).toBe(true);

    const strict = evaluateIrCutoverAuditJsonl(input, STRICT_FLOORS);
    expect(strict.ok).toBe(false);
    expect(codes(strict)).toEqual(expect.arrayContaining(["legacy-entry", "legacy-disposition"]));
  });

  it("accepts complete IR ownership in strict mode with explicit denominators", () => {
    const report = evaluateIrCutoverAuditJsonl(jsonl(cleanIrEnvelope()), {
      ...STRICT_FLOORS,
      requiredRoutes: ["compile"],
    });
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({
      successfulStandalone: 1,
      successfulSources: 1,
      successfulUnits: 2,
    });
  });

  it("requires explicit record, source, and unit floors for a strict cutover claim", () => {
    const report = evaluateIrCutoverAuditJsonl(jsonl(cleanIrEnvelope()), { requireNoLegacy: true });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("strict-denominator-required");
  });

  it("rejects zero-census and undersized streams instead of passing vacuously", () => {
    const empty = cleanIrEnvelope();
    empty.audit.sources = [];
    empty.audit.sourceCount = 0;
    empty.audit.dispositions = [];
    empty.audit.allUnitCount = 0;
    empty.audit.terminalUnitCount = 0;
    empty.audit.ownedSupportUnitCount = 0;
    empty.audit.derivedUnits = [];
    empty.audit.legacyEntries = [];
    const vacuous = evaluateIrCutoverAuditJsonl(jsonl(empty));
    expect(vacuous.ok).toBe(false);
    expect(codes(vacuous)).toContain("empty-source-census");

    const undersized = evaluateIrCutoverAuditJsonl(jsonl(cleanIrEnvelope()), {
      requireNoLegacy: true,
      expectSuccessful: 2,
      minSources: 2,
      minUnits: 3,
    });
    expect(codes(undersized)).toEqual(
      expect.arrayContaining(["successful-count-mismatch", "source-floor-miss", "unit-floor-miss"]),
    );
  });

  it("rejects malformed records deterministically, including in strict mode", () => {
    const malformed = JSON.stringify({
      schema: IR_CUTOVER_AUDIT_SCHEMA,
      success: true,
      audit: { route: "compile", target: "standalone", graph: "single", generator: "generateModule" },
    });
    expect(() => evaluateIrCutoverAuditJsonl(`${malformed}\n`, STRICT_FLOORS)).not.toThrow();
    const report = evaluateIrCutoverAuditJsonl(`${malformed}\n`, STRICT_FLOORS);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("malformed-record");

    const invalidJson = evaluateIrCutoverAuditJsonl("{not json}\n");
    expect(codes(invalidJson)).toContain("invalid-json");

    const missingSource = legacyEnvelope();
    Reflect.deleteProperty(missingSource.audit.legacyEntries[1]!, "sourceId");
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(missingSource)))).toContain("missing-entry-source");

    const unknownTarget = cleanIrEnvelope();
    unknownTarget.audit.target = "standlaone";
    for (const entry of unknownTarget.audit.legacyEntries) entry.target = "standlaone";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(unknownTarget)))).toContain("unknown-target");

    const spoofedDeclaration = cleanIrEnvelope();
    spoofedDeclaration.audit.legacyEntries[0]!.unitKind = "module-init";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(spoofedDeclaration), STRICT_FLOORS))).toEqual(
      expect.arrayContaining(["declaration-entry-shape", "unit-metadata-without-id"]),
    );
  });

  it("rejects duplicate identities, route mismatches, and nonreconciled counts", () => {
    const duplicate = cleanIrEnvelope();
    duplicate.audit.dispositions.push({ ...duplicate.audit.dispositions[0]! });
    duplicate.audit.allUnitCount = 3;
    duplicate.audit.terminalUnitCount = 2;
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(duplicate)))).toContain("duplicate-unit-id");

    const mismatchedRoute = cleanIrEnvelope();
    mismatchedRoute.audit.graph = "multi";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(mismatchedRoute)))).toContain("route-mismatch");

    const mismatchedCount = cleanIrEnvelope();
    mismatchedCount.audit.sourceCount = 2;
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(mismatchedCount)))).toContain("count-mismatch");
  });

  it("joins support owners and source kinds to the exact inventory", () => {
    const missingOwner = cleanIrEnvelope();
    missingOwner.audit.dispositions[1]!.terminalOwnerId = "unit:missing";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(missingOwner), STRICT_FLOORS))).toContain("unknown-support-owner");

    const wrongOwnerRoute = cleanIrEnvelope();
    wrongOwnerRoute.audit.dispositions[1]!.disposition = "owned-support-legacy-owner";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(wrongOwnerRoute)))).toContain("support-owner-disposition-mismatch");

    const wrongKind = cleanIrEnvelope();
    wrongKind.audit.sources[0]!.kind = "user";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(wrongKind)))).toContain("unknown-source-kind");

    const noncanonicalSource = cleanIrEnvelope();
    noncanonicalSource.audit.sources[0]!.sourceKey = "C:fixture.ts";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(noncanonicalSource)))).toContain("noncanonical-source-key");
  });

  it("accepts support direct-entry overrides only with matching physical evidence", () => {
    const envelope = cleanIrEnvelope();
    envelope.audit.dispositions[1]!.disposition = "legacy-ast-entry";
    envelope.audit.legacyEntries.push({
      target: "standalone",
      entryPoint: "compileArrowAsClosure",
      bodyName: "support",
      file: "fixture.ts",
      line: 1,
      column: 1,
      sourceId: SOURCE_ID,
      unitId: SUPPORT_ID,
      unitKind: "synthetic-support",
      terminalOwnerId: TERMINAL_ID,
      count: 1,
    });
    expect(evaluateIrCutoverAuditJsonl(jsonl(envelope)).ok).toBe(true);

    envelope.audit.legacyEntries.pop();
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(envelope)))).toContain("legacy-entry-disposition-mismatch");
  });

  it("rejects cross-wired legacy unit provenance in a valid two-source inventory", () => {
    const envelope = legacyEnvelope();
    envelope.audit.sources.push({ ...source(), id: "source:other", order: 1, sourceKey: "other.ts" });
    envelope.audit.sourceCount = 2;
    const functionEntry = envelope.audit.legacyEntries[1]!;
    functionEntry.sourceId = "source:other";
    functionEntry.file = "other.ts";
    functionEntry.unitKind = "arrow-function";
    const report = evaluateIrCutoverAuditJsonl(jsonl(envelope));
    expect(codes(report)).toEqual(expect.arrayContaining(["entry-unit-source-mismatch", "entry-unit-kind-mismatch"]));
  });

  it("rejects cross-wired unit and class provenance in an unresolved failed record", () => {
    const envelope = legacyEnvelope();
    envelope.success = false;
    envelope.audit.sources.push({ ...source(), id: "source:other", order: 1, sourceKey: "other.ts" });
    envelope.audit.sourceCount = 2;
    envelope.audit.classes.push({
      id: "class:other:Box",
      sourceId: "source:other",
      lexicalOwnerId: null,
      declarationKind: "declaration",
      ordinal: 0,
      displayName: "Box",
      line: 1,
      column: 1,
      declarationStart: 0,
      declarationEnd: 12,
    });
    envelope.audit.classCount = 1;
    const functionEntry = envelope.audit.legacyEntries[1]!;
    Reflect.deleteProperty(functionEntry, "sourceId");
    functionEntry.classId = "class:other:Box";
    envelope.audit.violations = [
      {
        code: "unresolved-legacy-entry",
        detail: "compileFunctionBody main has no exact source identity",
        unitId: TERMINAL_ID,
      },
    ];
    envelope.audit.structurallyComplete = false;

    const report = evaluateIrCutoverAuditJsonl(jsonl(envelope, cleanIrEnvelope()));
    expect(codes(report)).toContain("entry-unit-class-source-mismatch");
    expect(codes(report)).not.toContain("missing-unresolved-entry-violation");
  });

  it("joins derived units to the exact parent and terminal-owner chain", () => {
    const envelope = cleanIrEnvelope();
    envelope.audit.dispositions.push({
      sourceId: SOURCE_ID,
      unitId: "unit:fixture:other-terminal",
      unitKind: "top-level-function",
      terminal: true,
      terminalOwnerId: "unit:fixture:other-terminal",
      disposition: "terminal-ir",
    });
    envelope.audit.allUnitCount = 3;
    envelope.audit.terminalUnitCount = 2;
    envelope.audit.derivedUnits[0]!.terminalOwnerId = "unit:fixture:other-terminal";
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(envelope)))).toContain("derived-parent-owner-mismatch");

    const cycle = cleanIrEnvelope();
    cycle.audit.derivedUnits[0]!.parentId = DERIVED_ID;
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(cycle)))).toContain("derived-parent-cycle");
  });

  it("validates class identity uniqueness, source ownership, and legacy joins", () => {
    const envelope = legacyEnvelope();
    envelope.audit.classes = [
      {
        id: "class:fixture:Box",
        sourceId: SOURCE_ID,
        lexicalOwnerId: "unit:missing-owner",
        declarationKind: "declaration",
        ordinal: 0,
        displayName: "Box",
        line: 1,
        column: 1,
        declarationStart: 0,
        declarationEnd: 12,
      },
    ];
    envelope.audit.classCount = 1;
    envelope.audit.legacyEntries.push({
      target: "standalone",
      entryPoint: "compileClassBodies",
      bodyName: "Box",
      file: "fixture.ts",
      line: 1,
      column: 1,
      sourceId: SOURCE_ID,
      classId: "class:fixture:missing",
      count: 1,
    });
    const report = evaluateIrCutoverAuditJsonl(jsonl(envelope));
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(expect.arrayContaining(["unknown-class-id", "unknown-class-owner"]));
  });

  it("requires a real successful standalone record", () => {
    const nonStandalone = cleanIrEnvelope();
    nonStandalone.audit.target = "gc";
    for (const entry of nonStandalone.audit.legacyEntries) entry.target = "gc";
    const report = evaluateIrCutoverAuditJsonl(jsonl(nonStandalone));
    expect(report.ok).toBe(false);
    expect(report.counts.ignoredNonStandalone).toBe(1);
    expect(codes(report)).toContain("no-successful-standalone-record");
  });

  it("counts failed incomplete records without treating their missing body evidence as a default failure", () => {
    const input = jsonl(failedIncompleteEnvelope(), legacyEnvelope());
    const report = evaluateIrCutoverAuditJsonl(input);
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ successfulStandalone: 1, failedStandalone: 1 });
    expect(formatIrCutoverAuditReport(report)).toContain("failed=1");

    const strict = evaluateIrCutoverAuditJsonl(input, STRICT_FLOORS);
    expect(strict.ok).toBe(false);
    expect(codes(strict)).toContain("strict-failed-record");

    const unattributedFailure = failedIncompleteEnvelope();
    Reflect.deleteProperty(unattributedFailure.audit.legacyEntries[0]!, "sourceId");
    unattributedFailure.audit.violations.push({
      code: "unresolved-legacy-entry",
      detail: "compileDeclarations fixture.ts has no exact source identity",
    });
    expect(evaluateIrCutoverAuditJsonl(jsonl(unattributedFailure, legacyEnvelope())).ok).toBe(true);
  });

  it("requires a distinct unresolved violation for every missing-source entry", () => {
    const failure = failedIncompleteEnvelope();
    Reflect.deleteProperty(failure.audit.legacyEntries[0]!, "sourceId");
    const secondEntry = {
      ...declarationEntry(),
      bodyName: "other.ts",
      file: "other.ts",
    };
    Reflect.deleteProperty(secondEntry, "sourceId");
    failure.audit.legacyEntries.push(secondEntry);
    failure.audit.violations.push({
      code: "unresolved-legacy-entry",
      detail: "compileDeclarations fixture.ts has no exact source identity",
    });
    const report = evaluateIrCutoverAuditJsonl(jsonl(failure, legacyEnvelope()));
    expect(codes(report)).toContain("missing-unresolved-entry-violation");

    failure.audit.violations.push({
      code: "unresolved-legacy-entry",
      detail: "compileDeclarations other.ts has no exact source identity",
    });
    expect(evaluateIrCutoverAuditJsonl(jsonl(failure, legacyEnvelope())).ok).toBe(true);

    const mismatchedUnit = legacyEnvelope();
    mismatchedUnit.success = false;
    Reflect.deleteProperty(mismatchedUnit.audit.legacyEntries[1]!, "sourceId");
    mismatchedUnit.audit.violations = [
      {
        code: "unresolved-legacy-entry",
        detail: "an unrelated unit has no exact source identity",
        unitId: "unit:unrelated",
      },
    ];
    mismatchedUnit.audit.structurallyComplete = false;
    expect(codes(evaluateIrCutoverAuditJsonl(jsonl(mismatchedUnit, legacyEnvelope())))).toContain(
      "missing-unresolved-entry-violation",
    );
  });

  it("enforces repeatable successful-route requirements", () => {
    const input = jsonl(cleanIrEnvelope());
    expect(evaluateIrCutoverAuditJsonl(input, { requiredRoutes: ["compile"] }).ok).toBe(true);
    const missing = evaluateIrCutoverAuditJsonl(input, { requiredRoutes: ["compile", "compileFiles"] });
    expect(missing.ok).toBe(false);
    expect(codes(missing)).toContain("missing-required-route");
  });

  it("fails a successful record whose structural evidence is incomplete", () => {
    const envelope = failedIncompleteEnvelope();
    envelope.success = true;
    const report = evaluateIrCutoverAuditJsonl(jsonl(envelope));
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(expect.arrayContaining(["incomplete-success", "successful-record-violations"]));

    const forged = cleanIrEnvelope();
    forged.audit.dispositions[0]!.disposition = "terminal-legacy";
    forged.audit.dispositions[1]!.disposition = "owned-support-legacy-owner";
    forged.audit.derivedUnits[0]!.disposition = "derived-legacy-owner";
    const forgedReport = evaluateIrCutoverAuditJsonl(jsonl(forged));
    expect(forgedReport.ok).toBe(false);
    expect(codes(forgedReport)).toContain("incomplete-success-disposition");
  });
});
