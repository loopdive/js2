import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEDGER_END,
  LEDGER_START,
  SOURCE_INVENTORY_ANCHOR,
  SOURCE_INVENTORY_MARKER,
  checkLedgerFile,
  collectDirectOptimizationAnchors,
  validateLedgerText,
} from "../scripts/check-ir-optimization-retirement.mjs";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "IR-OPT-TEST",
    family: "test-family",
    directOwner: { source: "src/codegen/index.ts", symbol: "emitDirectOptimization" },
    irOwnership: {
      owner: { source: "src/ir/from-ast.ts", symbol: "lowerOptimization" },
      status: "lowering",
      complete: true,
    },
    evidence: {
      semantic: { status: "verified", reference: "tests/issue-3792-example.test.ts#semantic" },
      outputShape: { status: "verified", reference: "tests/issue-3792-example.test.ts#wat" },
      performance: { status: "not-applicable", reference: "Not a performance optimization." },
    },
    retirementReady: true,
    ...overrides,
  };
}

function ledger(...rows: unknown[]) {
  return `# Fixture
${LEDGER_START}
\`\`\`jsonl
${rows.map((entry) => JSON.stringify(entry)).join("\n")}
\`\`\`
${LEDGER_END}`;
}

function sourceInventoryLedger(...rows: unknown[]) {
  return `${SOURCE_INVENTORY_MARKER}\n${ledger(...rows)}`;
}

function inventoryRow(id: string, symbol: string) {
  return row({
    id,
    directOwner: {
      source: "src/codegen/synthetic.ts",
      symbol,
      anchor: SOURCE_INVENTORY_ANCHOR,
    },
  });
}

function inventoryFixture(source: string, rows: unknown[], options: { marker?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "js2-ir-source-inventory-"));
  mkdirSync(join(dir, "src/codegen"), { recursive: true });
  mkdirSync(join(dir, "src/ir"), { recursive: true });
  mkdirSync(join(dir, "plan/log"), { recursive: true });
  writeFileSync(join(dir, "src/codegen/synthetic.ts"), source);
  writeFileSync(join(dir, "src/codegen/index.ts"), "export {};\n");
  writeFileSync(join(dir, "src/ir/from-ast.ts"), "export {};\n");
  const path = join(dir, "plan/log/ir-optimization-retirement-ledger.md");
  writeFileSync(path, options.marker === false ? ledger(...rows) : sourceInventoryLedger(...rows));
  return { dir, path };
}

describe("#3792 IR optimization retirement ledger gate", () => {
  it("accepts the committed ledger and reports a non-empty measured inventory", () => {
    const summary = checkLedgerFile("plan/log/ir-optimization-retirement-ledger.md");
    expect(summary.rows).toBe(46);
    expect(summary.complete).toBe(32);
    expect(summary.retirementReady).toBe(3);
    expect(summary.sourceAnchors).toBe(2);
    expect(summary.sourceInventoryVersion).toBe("v1");

    const inventory = collectDirectOptimizationAnchors();
    expect(inventory.errors).toEqual([]);
    expect(inventory.anchors).toEqual([
      {
        id: "IR-OPT-DENSE-VECTOR-PRESIZE",
        source: "src/codegen/literals.ts",
        symbol: "detectCountedFillLoopBound",
        line: expect.any(Number),
      },
      {
        id: "IR-OPT-COUNTED-VECTOR-PUSH-PRESIZE",
        source: "src/codegen/literals.ts",
        symbol: "detectCountedPushLoop",
        line: expect.any(Number),
      },
    ]);
  });

  it("rejects an annotated direct owner omitted from the ledger", () => {
    const fixture = inventoryFixture(
      `/** @irOptimizationOwner IR-OPT-TRACKED */
function trackedOptimization() {}
/** @irOptimizationOwner IR-OPT-OMITTED */
function omittedOptimization() {}
`,
      [inventoryRow("IR-OPT-TRACKED", "trackedOptimization")],
    );
    try {
      expect(() => checkLedgerFile(fixture.path, { repoRoot: fixture.dir })).toThrow(
        "src/codegen/synthetic.ts::omittedOptimization references IR-OPT-OMITTED, which is omitted from the ledger",
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects a dangling ledger anchor after its source annotation is removed", () => {
    const fixture = inventoryFixture("function trackedOptimization() {}\n", [
      inventoryRow("IR-OPT-TRACKED", "trackedOptimization"),
    ]);
    try {
      expect(() => checkLedgerFile(fixture.path, { repoRoot: fixture.dir })).toThrow(
        "IR-OPT-TRACKED ledger owner src/codegen/synthetic.ts::trackedOptimization has a dangling source-annotation-v1 claim",
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects mismatched and duplicate parsed source identities", () => {
    const mismatch = inventoryFixture(
      `/** @irOptimizationOwner IR-OPT-TRACKED */
function actualOptimization() {}
`,
      [inventoryRow("IR-OPT-TRACKED", "renamedOptimization")],
    );
    try {
      expect(() => checkLedgerFile(mismatch.path, { repoRoot: mismatch.dir })).toThrow(
        "IR-OPT-TRACKED source identity mismatch: annotation is src/codegen/synthetic.ts::actualOptimization, ledger is src/codegen/synthetic.ts::renamedOptimization",
      );
    } finally {
      rmSync(mismatch.dir, { recursive: true, force: true });
    }

    const duplicate = inventoryFixture(
      `/**
 * @irOptimizationOwner IR-OPT-FIRST
 * @irOptimizationOwner IR-OPT-SECOND
 */
function sharedOptimization() {}
`,
      [inventoryRow("IR-OPT-FIRST", "sharedOptimization"), inventoryRow("IR-OPT-SECOND", "sharedOptimization")],
    );
    try {
      expect(() => checkLedgerFile(duplicate.path, { repoRoot: duplicate.dir })).toThrow(
        "duplicate source inventory identity src/codegen/synthetic.ts::sharedOptimization",
      );
    } finally {
      rmSync(duplicate.dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate source IDs and a zero-owner v1 denominator", () => {
    const duplicate = inventoryFixture(
      `/** @irOptimizationOwner IR-OPT-TRACKED */
function firstOptimization() {}
/** @irOptimizationOwner IR-OPT-TRACKED */
function secondOptimization() {}
`,
      [inventoryRow("IR-OPT-TRACKED", "firstOptimization")],
    );
    try {
      expect(() => checkLedgerFile(duplicate.path, { repoRoot: duplicate.dir })).toThrow(
        "duplicate source inventory id IR-OPT-TRACKED",
      );
    } finally {
      rmSync(duplicate.dir, { recursive: true, force: true });
    }

    const zero = inventoryFixture("export {};\n", [row()]);
    try {
      expect(() => checkLedgerFile(zero.path, { repoRoot: zero.dir })).toThrow(
        "source inventory v1 denominator must contain at least one annotated direct-codegen owner",
      );
    } finally {
      rmSync(zero.dir, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicate, and unknown source-inventory markers", () => {
    const missingMarker = inventoryFixture(
      `/** @irOptimizationOwner IR-OPT-TRACKED */
function trackedOptimization() {}
`,
      [inventoryRow("IR-OPT-TRACKED", "trackedOptimization")],
      { marker: false },
    );
    try {
      expect(() => checkLedgerFile(missingMarker.path, { repoRoot: missingMarker.dir })).toThrow(
        `source inventory requires exactly one ${SOURCE_INVENTORY_MARKER} marker`,
      );
    } finally {
      rmSync(missingMarker.dir, { recursive: true, force: true });
    }

    const duplicateMarker = inventoryFixture(
      `/** @irOptimizationOwner IR-OPT-TRACKED */
function trackedOptimization() {}
`,
      [inventoryRow("IR-OPT-TRACKED", "trackedOptimization")],
    );
    writeFileSync(
      duplicateMarker.path,
      `${SOURCE_INVENTORY_MARKER}\n${sourceInventoryLedger(inventoryRow("IR-OPT-TRACKED", "trackedOptimization"))}`,
    );
    try {
      expect(() => checkLedgerFile(duplicateMarker.path, { repoRoot: duplicateMarker.dir })).toThrow(
        "source inventory marker must appear exactly once with version v1",
      );
    } finally {
      rmSync(duplicateMarker.dir, { recursive: true, force: true });
    }

    const unknownMarker = inventoryFixture(
      `/** @irOptimizationOwner IR-OPT-TRACKED */
function trackedOptimization() {}
`,
      [inventoryRow("IR-OPT-TRACKED", "trackedOptimization")],
    );
    writeFileSync(
      unknownMarker.path,
      `<!-- ir-optimization-source-inventory:v2 -->\n${ledger(inventoryRow("IR-OPT-TRACKED", "trackedOptimization"))}`,
    );
    try {
      expect(() => checkLedgerFile(unknownMarker.path, { repoRoot: unknownMarker.dir })).toThrow(
        "source inventory marker must appear exactly once with version v1",
      );
    } finally {
      rmSync(unknownMarker.dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed source annotations", () => {
    const malformed = inventoryFixture(
      `/** @irOptimizationOwner not-a-stable-id */
function malformedOptimization() {}
`,
      [row()],
    );
    try {
      expect(() => checkLedgerFile(malformed.path, { repoRoot: malformed.dir })).toThrow(
        "@irOptimizationOwner must name exactly one IR-OPT-<STABLE-UPPERCASE-ID>",
      );
    } finally {
      rmSync(malformed.dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON rows", () => {
    const result = validateLedgerText(`${LEDGER_START}\n{not json}\n${LEDGER_END}`);
    expect(result.errors.join("\n")).toContain("invalid JSON");
  });

  it("rejects duplicate stable IDs", () => {
    const result = validateLedgerText(ledger(row(), row()));
    expect(result.errors.join("\n")).toContain("duplicate id IR-OPT-TEST");
  });

  it("rejects missing direct and IR owners", () => {
    const result = validateLedgerText(
      ledger(row({ directOwner: {}, irOwnership: { status: "lowering", complete: true } })),
    );
    expect(result.errors.join("\n")).toContain("directOwner.source");
    expect(result.errors.join("\n")).toContain("irOwnership.owner");
  });

  it("rejects owner paths that do not exist", () => {
    const result = validateLedgerText(
      ledger(row({ directOwner: { source: "src/codegen/not-a-real-owner.ts", symbol: "missing" } })),
    );
    expect(result.errors.join("\n")).toContain("directOwner.source does not exist");
  });

  it("rejects missing evidence and invalid evidence statuses", () => {
    const result = validateLedgerText(
      ledger(
        row({
          evidence: {
            semantic: { status: "unknown", reference: "" },
            outputShape: { status: "verified", reference: "test#shape" },
          },
        }),
      ),
    );
    expect(result.errors.join("\n")).toContain("evidence.semantic.status");
    expect(result.errors.join("\n")).toContain("evidence.semantic.reference");
    expect(result.errors.join("\n")).toContain("evidence.performance");
  });

  it("rejects typed Unsupported marked as complete", () => {
    const result = validateLedgerText(
      ledger(
        row({
          irOwnership: {
            owner: { source: "plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md", symbol: "R0" },
            status: "typed-unsupported",
            complete: true,
          },
          retirementReady: false,
        }),
      ),
    );
    expect(result.errors.join("\n")).toContain("cannot mark typed-unsupported IR ownership complete");
  });

  it("rejects retirement readiness without complete ownership and accepted evidence", () => {
    const result = validateLedgerText(
      ledger(
        row({
          irOwnership: {
            owner: { source: "src/ir/from-ast.ts", symbol: "lowerOptimization" },
            status: "runtime-intent",
            complete: false,
          },
          evidence: {
            semantic: { status: "pending", reference: "plan/issues/3792-example.md" },
            outputShape: { status: "verified", reference: "tests/example.test.ts#wat" },
            performance: { status: "pending", reference: "benchmarks/example.mjs" },
          },
        }),
      ),
    );
    const errors = result.errors.join("\n");
    expect(errors).toContain("without complete executable IR ownership");
    expect(errors).toContain("without accepted semantic evidence");
    expect(errors).toContain("without accepted performance evidence");
  });

  it("accepts --require-ready when every row is retirement-ready", () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-ir-retirement-ready-"));
    const path = join(dir, "ledger.md");
    writeFileSync(path, ledger(row()));
    try {
      const output = execFileSync(
        process.execPath,
        ["scripts/check-ir-optimization-retirement.mjs", "--require-ready", path],
        {
          encoding: "utf8",
        },
      );
      expect(output).toContain("1 retirement-ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects --require-ready while any row is not retirement-ready", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/check-ir-optimization-retirement.mjs",
        "--",
        "--require-ready",
        "plan/log/ir-optimization-retirement-ledger.md",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("43/46 rows are not ready");
    expect(result.stderr).toContain("IR-OPT-NUMERIC-SWITCH-PROOF");
  });
});
