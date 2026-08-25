// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4552 finding D1 / change C1 — the IR-dialect gate's R1 scope.
 *
 * `scripts/check-ir-dialect.mjs` claims `src/ir/nodes.ts` is the only file that
 * may import `src/ir/dialect/js.ts`. Its first cut walked `src/ir/` only, so the
 * claim was enforced inside the IR tree and merely true-by-luck outside it: the
 * Fable-lane review demonstrated live that adding
 * `import type { IrInstrAwait } from "../ir/dialect/js.js"` to
 * `src/codegen/peephole.ts` left the gate at exit 0.
 *
 * A gate that passes on the violation it exists to catch is worse than no gate,
 * because it is *reported* as coverage. So the load-bearing case here is the
 * NEGATIVE one — "out-of-IR import ⇒ exit 1" — and it is written against a
 * synthetic tree (via the script's `--src`) rather than by planting an import in
 * the real `src/`, which would be a compile error and could not be left behind.
 *
 * The synthetic tree also pins the two scope decisions that are easy to get
 * wrong and impossible to notice: `src/ir/nodes.ts` is the allow-set repo-wide
 * (not merely IR-wide), and matching is resolution-based, so an unrelated
 * directory that happens to be named `dialect/` is NOT gated.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-ir-dialect.mjs");

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the gate, capturing exit status instead of throwing on failure. */
function runGate(args: string[] = []): RunResult {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** The one dialect declaration the synthetic trees share. */
const DIALECT_JS = "export interface IrInstrAwait {\n  readonly kind: 'await';\n}\n";

/** `nodes.ts` in its compliant shape: the single importer, re-exporting the name. */
const COMPLIANT_NODES =
  'import type { IrInstrAwait } from "./dialect/js.js";\n' +
  'export type { IrInstrAwait } from "./dialect/js.js";\n' +
  "export type IrInstr = IrInstrAwait;\n";

describe("#4552 D1 — check-ir-dialect R1 scans all of src/, not just src/ir/", () => {
  let dir: string;
  let src: string;

  /** Write the synthetic `src/` tree, replacing any previous one. */
  function writeTree(files: Record<string, string>): void {
    rmSync(src, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      const full = join(src, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ir-dialect-gate-scope-"));
    src = join(dir, "src");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes on a compliant tree — only nodes.ts imports the dialect", () => {
    writeTree({
      "ir/dialect/js.ts": DIALECT_JS,
      "ir/nodes.ts": COMPLIANT_NODES,
      "ir/verify.ts": 'import type { IrInstr } from "./nodes.js";\nexport type V = IrInstr;\n',
      "codegen/peephole.ts": 'import type { IrInstr } from "../ir/nodes.js";\nexport type P = IrInstr;\n',
    });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("IR dialect gate: OK");
  });

  // THE regression test for D1. Before the scope widening this exited 0.
  it("FAILS when a file OUTSIDE src/ir/ imports the dialect (the demonstrated miss)", () => {
    writeTree({
      "ir/dialect/js.ts": DIALECT_JS,
      "ir/nodes.ts": COMPLIANT_NODES,
      "codegen/peephole.ts":
        'import type { IrInstrAwait } from "../ir/dialect/js.js";\nexport type P = IrInstrAwait;\n',
    });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("IR dialect gate: FAILED");
    expect(res.stderr).toContain("codegen/peephole.ts:1");
    expect(res.stderr).toContain("imports the JS dialect");
  });

  it("still FAILS on the in-IR case R1 always covered (widening did not lose it)", () => {
    writeTree({
      "ir/dialect/js.ts": DIALECT_JS,
      "ir/nodes.ts": COMPLIANT_NODES,
      "ir/verify.ts": 'import type { IrInstrAwait } from "./dialect/js.js";\nexport type V = IrInstrAwait;\n',
    });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("ir/verify.ts:1");
  });

  it("reaches arbitrarily deep out-of-IR files, not just src/*/ leaves", () => {
    writeTree({
      "ir/dialect/js.ts": DIALECT_JS,
      "ir/nodes.ts": COMPLIANT_NODES,
      "codegen-linear/lower/deep/emit.ts":
        'import type { IrInstrAwait } from "../../../ir/dialect/js.js";\nexport type E = IrInstrAwait;\n',
    });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("deep/emit.ts:1");
  });

  it("keeps nodes.ts as the allow-set — it is exempt repo-wide, not IR-wide", () => {
    // Same import, in the one file permitted to hold it. If the widening had
    // dropped the exemption, the compliant tree above would fail too.
    writeTree({ "ir/dialect/js.ts": DIALECT_JS, "ir/nodes.ts": COMPLIANT_NODES });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(0);
  });

  it("does NOT gate an unrelated directory named dialect/ — matching is resolution-based", () => {
    // A substring test on `dialect/` would flag this. Widening the walk to the
    // whole compiler tree is what makes that distinction start to matter.
    writeTree({
      "ir/dialect/js.ts": DIALECT_JS,
      "ir/nodes.ts": COMPLIANT_NODES,
      "wit/dialect/vocab.ts": "export const VOCAB = 1;\n",
      "wit/generator.ts": 'import { VOCAB } from "./dialect/vocab.js";\nexport const G = VOCAB;\n',
    });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(0);
  });

  it("still enforces R2 — a dialect name nodes.ts does not re-export", () => {
    writeTree({
      "ir/dialect/js.ts": `${DIALECT_JS}export interface IrInstrYield {\n  readonly kind: 'yield';\n}\n`,
      "ir/nodes.ts": COMPLIANT_NODES,
    });

    const res = runGate(["--src", src]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("does not re-export `IrInstrYield`");
  });
});

describe("#4552 D1 — the real repo", () => {
  it("is clean under the WIDENED scope, and says so", () => {
    // Pre-fix this passed while only src/ir/ was walked; the repo-wide claim was
    // unverified. Now the OK line is a statement about all of src/.
    const res = runGate();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("IR dialect gate: OK");
    expect(res.stdout).toContain("no other file under src/ imports the dialect");
  });
});
