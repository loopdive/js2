import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEDGER_END,
  LEDGER_START,
  checkLedgerFile,
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

describe("#3792 IR optimization retirement ledger gate", () => {
  it("accepts the committed ledger and reports a non-empty measured inventory", () => {
    const summary = checkLedgerFile("plan/log/ir-optimization-retirement-ledger.md");
    expect(summary.rows).toBe(11);
    expect(summary.complete).toBeGreaterThan(0);
    expect(summary.retirementReady).toBe(0);
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
    expect(result.stderr).toContain("11/11 rows are not ready");
    expect(result.stderr).toContain("IR-OPT-NUMERIC-SWITCH-PROOF");
  });
});
