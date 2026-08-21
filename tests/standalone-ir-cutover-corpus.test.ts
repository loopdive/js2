import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computeIrCutoverCorpusManifestDigest,
  evaluateIrCutoverCorpusJsonl,
  IR_CUTOVER_AUDIT_SCHEMA,
  IR_CUTOVER_CORPUS_MANIFEST_SCHEMA,
  IR_CUTOVER_CORPUS_RECEIPT_SCHEMA,
} from "../scripts/check-standalone-ir-cutover.mjs";
import {
  computeManifestDigest,
  loadCorpusManifest,
  runCorpus,
  sha256,
} from "../scripts/run-standalone-ir-cutover-corpus.mjs";

const SOURCE_ID = "source:fixture";
const TERMINAL_ID = "unit:fixture:main";
const SUPPORT_ID = "unit:fixture:support";
const DERIVED_ID = "unit:fixture:derived";
const SOURCE_TEXT = "export function main(): number { return 1; }\n";

function cleanEnvelope() {
  return {
    schema: IR_CUTOVER_AUDIT_SCHEMA,
    success: true,
    audit: {
      route: "compile",
      target: "standalone",
      graph: "single",
      generator: "generateModule",
      sources: [{ id: SOURCE_ID, kind: "entry", order: 0, sourceKey: "fixture.ts" }],
      classes: [],
      sourceCount: 1,
      classCount: 0,
      allUnitCount: 2,
      terminalUnitCount: 1,
      ownedSupportUnitCount: 1,
      unownedSupportUnitCount: 0,
      legacyEntries: [
        {
          target: "standalone",
          entryPoint: "compileDeclarations",
          bodyName: "fixture.ts",
          file: "fixture.ts",
          line: 1,
          column: 1,
          sourceId: SOURCE_ID,
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
          disposition: "terminal-ir",
        },
        {
          sourceId: SOURCE_ID,
          unitId: SUPPORT_ID,
          unitKind: "synthetic-support",
          terminal: false,
          terminalOwnerId: TERMINAL_ID,
          disposition: "owned-support-ir-owner",
        },
      ],
      derivedUnits: [
        {
          id: DERIVED_ID,
          parentId: TERMINAL_ID,
          terminalOwnerId: TERMINAL_ID,
          sourceId: SOURCE_ID,
          role: "lifted-closure",
          ordinal: 0,
          disposition: "derived-ir-owner",
        },
      ],
      violations: [],
      structurallyComplete: true,
      unattributedLegacyEntryCount: 0,
    },
  };
}

function manifest(sourceSha256 = sha256(SOURCE_TEXT)) {
  const value = {
    schema: IR_CUTOVER_CORPUS_MANIFEST_SCHEMA,
    id: "fixture-corpus",
    digest: "",
    invocation: {
      route: "compile",
      target: "standalone",
      graph: "single",
      generator: "generateModule",
    },
    sources: [
      {
        id: "fixture",
        path: "fixture.ts",
        bytes: Buffer.byteLength(SOURCE_TEXT),
        sha256: sourceSha256,
      },
    ],
    cases: [
      {
        id: "compile/fixture",
        sourceId: "fixture",
        sourceKey: "fixture.ts",
        auditSourceId: SOURCE_ID,
        expected: {
          sourceCount: 1,
          classCount: 0,
          allUnitCount: 2,
          terminalUnitCount: 1,
          ownedSupportUnitCount: 1,
          unownedSupportUnitCount: 0,
          derivedUnitCount: 1,
        },
      },
    ],
    totals: {
      caseCount: 1,
      sourceCount: 1,
      sourceBytes: Buffer.byteLength(SOURCE_TEXT),
      classCount: 0,
      allUnitCount: 2,
      terminalUnitCount: 1,
      ownedSupportUnitCount: 1,
      unownedSupportUnitCount: 0,
      derivedUnitCount: 1,
    },
  };
  value.digest = computeManifestDigest(value);
  return value;
}

function successfulReceipts(corpusManifest = manifest(), envelope = cleanEnvelope(), runId = "run-a") {
  const base = {
    schema: IR_CUTOVER_CORPUS_RECEIPT_SCHEMA,
    runId,
    manifestDigest: corpusManifest.digest,
    caseId: "compile/fixture",
  };
  return [
    { ...base, kind: "attempt" },
    {
      ...base,
      kind: "completion",
      success: true,
      source: {
        bytes: corpusManifest.sources[0]!.bytes,
        sha256: corpusManifest.sources[0]!.sha256,
      },
      envelope,
    },
  ];
}

function jsonl(rows: unknown[]) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function codes(report: ReturnType<typeof evaluateIrCutoverCorpusJsonl>) {
  return report.errors.map((item) => item.code);
}

describe("standalone IR cutover pinned corpus", () => {
  it("pins the committed five-case manifest and its exact denominator", () => {
    const committed = loadCorpusManifest();
    expect(committed.digest).toBe("sha256:e25d80c90cdd5eb3c6a21672e6d9f3db754ddd4a068d54d5d37b5fee856eb0b7");
    expect(committed.totals).toEqual({
      caseCount: 5,
      sourceCount: 5,
      sourceBytes: 22_056,
      classCount: 2,
      allUnitCount: 47,
      terminalUnitCount: 38,
      ownedSupportUnitCount: 9,
      unownedSupportUnitCount: 0,
      derivedUnitCount: 19,
    });
    expect(computeIrCutoverCorpusManifestDigest(committed)).toBe(committed.digest);
  });

  it("accepts an exact receipt census and applies strict policy without changing the manifest", () => {
    const corpusManifest = manifest();
    const input = jsonl(successfulReceipts(corpusManifest));
    const structural = evaluateIrCutoverCorpusJsonl(input, corpusManifest);
    expect(structural.ok).toBe(true);
    expect(structural.counts).toMatchObject({ attempts: 1, completions: 1, sourceCount: 1, allUnitCount: 2 });

    const strict = evaluateIrCutoverCorpusJsonl(input, corpusManifest, { requireNoLegacy: true });
    expect(strict.ok).toBe(true);
    expect(strict.manifest.digest).toBe(structural.manifest.digest);
  });

  it("rejects missing, extra, duplicate, mixed, stale, failed, and drifted receipts", () => {
    const corpusManifest = manifest();
    const rows = successfulReceipts(corpusManifest);

    expect(codes(evaluateIrCutoverCorpusJsonl(jsonl(rows.slice(0, 1)), corpusManifest))).toEqual(
      expect.arrayContaining(["missing-corpus-completion", "corpus-total-mismatch"]),
    );
    expect(codes(evaluateIrCutoverCorpusJsonl(jsonl([...rows, rows[0]]), corpusManifest))).toContain(
      "duplicate-corpus-attempt",
    );
    expect(
      codes(evaluateIrCutoverCorpusJsonl(jsonl([...rows, { ...rows[0], caseId: "compile/extra" }]), corpusManifest)),
    ).toContain("extra-corpus-case");
    expect(
      codes(evaluateIrCutoverCorpusJsonl(jsonl([rows[0], { ...rows[1], runId: "run-b" }]), corpusManifest)),
    ).toContain("mixed-corpus-run");
    expect(
      codes(
        evaluateIrCutoverCorpusJsonl(
          jsonl([rows[0], { ...rows[1], manifestDigest: `sha256:${"0".repeat(64)}` }]),
          corpusManifest,
        ),
      ),
    ).toContain("stale-manifest-receipt");

    const failed = {
      ...rows[1],
      success: false,
      failure: { stage: "compile-threw", message: "pre-codegen failure" },
    };
    Reflect.deleteProperty(failed, "source");
    Reflect.deleteProperty(failed, "envelope");
    expect(codes(evaluateIrCutoverCorpusJsonl(jsonl([rows[0], failed]), corpusManifest))).toContain(
      "failed-corpus-case",
    );

    const driftedEnvelope = cleanEnvelope();
    driftedEnvelope.audit.allUnitCount = 3;
    driftedEnvelope.audit.ownedSupportUnitCount = 2;
    driftedEnvelope.audit.dispositions.push({
      ...driftedEnvelope.audit.dispositions[1]!,
      unitId: "unit:fixture:second-support",
    });
    expect(
      codes(evaluateIrCutoverCorpusJsonl(jsonl(successfulReceipts(corpusManifest, driftedEnvelope)), corpusManifest)),
    ).toContain("case-count-mismatch");

    const staleManifest = structuredClone(corpusManifest);
    staleManifest.totals.allUnitCount = 3;
    expect(codes(evaluateIrCutoverCorpusJsonl(jsonl(rows), staleManifest))).toContain("manifest-digest-mismatch");
  });

  it("writes an attempt before compilation and a correlated successful completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "js2-ir-cutover-corpus-"));
    const outputPath = join(directory, "receipts.jsonl");
    writeFileSync(join(directory, "fixture.ts"), SOURCE_TEXT);
    const compileCase = vi.fn(async () => ({
      success: true,
      errors: [],
      irBodyRouteAudit: cleanEnvelope().audit,
    }));
    try {
      const report = await runCorpus({
        manifest: manifest(),
        outputPath,
        repoRoot: directory,
        runId: "runner-success",
        compileCase,
      });
      expect(report).toMatchObject({ ok: true, attempts: 1, failed: 0 });
      expect(compileCase).toHaveBeenCalledOnce();
      const receipts = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(receipts.map((receipt) => receipt.kind)).toEqual(["attempt", "completion"]);
      expect(receipts[1]).toMatchObject({ runId: "runner-success", caseId: "compile/fixture", success: true });
      expect(evaluateIrCutoverCorpusJsonl(jsonl(receipts), manifest()).ok).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("turns source drift and pre-codegen throws into explicit failed completions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "js2-ir-cutover-corpus-failure-"));
    writeFileSync(join(directory, "fixture.ts"), SOURCE_TEXT);
    try {
      const thrownOutput = join(directory, "thrown.jsonl");
      const thrown = await runCorpus({
        manifest: manifest(),
        outputPath: thrownOutput,
        repoRoot: directory,
        runId: "runner-thrown",
        compileCase: async () => {
          throw new Error("before codegen");
        },
      });
      expect(thrown.ok).toBe(false);
      expect(readFileSync(thrownOutput, "utf8")).toContain('"stage":"compile-threw"');

      const driftOutput = join(directory, "drift.jsonl");
      const compileCase = vi.fn();
      const driftedManifest = manifest("0".repeat(64));
      const drifted = await runCorpus({
        manifest: driftedManifest,
        outputPath: driftOutput,
        repoRoot: directory,
        runId: "runner-drift",
        compileCase,
      });
      expect(drifted.ok).toBe(false);
      expect(compileCase).not.toHaveBeenCalled();
      expect(readFileSync(driftOutput, "utf8")).toContain('"stage":"source-drift"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
