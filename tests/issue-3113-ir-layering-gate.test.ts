// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3113 S1 — tests for the IR→codegen layering ratchet
 * (`scripts/check-ir-layering.mjs`).
 *
 * A ratchet is only worth its CI minute if it actually FIRES. This suite
 * proves both halves of that:
 *
 *   1. Against a synthetic tree (a tmp `src/ir` + `src/codegen` pair), the
 *      script fails when a file grows a codegen import, fails when a NEW file
 *      acquires one, and passes when the tree matches its baseline.
 *   2. Against the REAL repo, the committed baseline equals the script's live
 *      measurement — so `scripts/ir-layering-baseline.json` cannot drift out
 *      of sync with `src/` without a test noticing.
 *
 * The synthetic tree also pins the two counting decisions that are easy to get
 * wrong and impossible to notice: `import type` COUNTS (it is a real edge in
 * the dependency graph), and `src/codegen-linear/` does NOT (it is a sibling
 * backend, and a naive `from "../codegen` grep over-counts it).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-ir-layering.mjs");
const COMMITTED_BASELINE = join(REPO_ROOT, "scripts", "ir-layering-baseline.json");

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the gate, capturing exit status instead of throwing on failure. */
function runGate(args: string[]): RunResult {
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

describe("#3113 — IR→codegen layering ratchet", () => {
  describe("synthetic tree", () => {
    let dir: string;
    let src: string;
    let baseline: string;

    /** Overwrite the synthetic `src/ir/*.ts` files, replacing any previous set. */
    function writeIr(files: Record<string, string>): void {
      rmSync(join(src, "ir"), { recursive: true, force: true });
      mkdirSync(join(src, "ir"), { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(src, "ir", name), body);
      }
    }

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ir-layering-gate-"));
      src = join(dir, "src");
      // The codegen + codegen-linear leaves the synthetic IR files import from.
      mkdirSync(join(src, "codegen"), { recursive: true });
      mkdirSync(join(src, "codegen-linear"), { recursive: true });
      writeFileSync(join(src, "codegen", "vocab.ts"), "export const VOCAB = 1;\n");
      writeFileSync(join(src, "codegen", "other.ts"), "export const OTHER = 2;\n");
      writeFileSync(join(src, "codegen-linear", "layout.ts"), "export const LAYOUT = 3;\n");
      baseline = join(dir, "baseline.json");
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("seeds a baseline from the tree it is pointed at", () => {
      writeIr({
        "a.ts": 'import { VOCAB } from "../codegen/vocab.js";\nexport const a = VOCAB;\n',
        "b.ts": "export const b = 1;\n",
      });

      const seeded = runGate(["--src", src, "--baseline", baseline]);
      expect(seeded.status).toBe(0);
      expect(seeded.stdout).toContain("baseline seeded");

      const parsed = JSON.parse(readFileSync(baseline, "utf-8")) as {
        total: number;
        files: Record<string, number>;
      };
      expect(parsed.total).toBe(1);
      expect(parsed.files).toEqual({ "ir/a.ts": 1 });
    });

    it("passes when the tree is unchanged", () => {
      const res = runGate(["--src", src, "--baseline", baseline]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("ir-layering ratchet: OK");
    });

    it("FAILS when an existing file grows a codegen import", () => {
      writeIr({
        "a.ts":
          'import { VOCAB } from "../codegen/vocab.js";\n' +
          'import { OTHER } from "../codegen/other.js";\n' +
          "export const a = VOCAB + OTHER;\n",
        "b.ts": "export const b = 1;\n",
      });

      const res = runGate(["--src", src, "--baseline", baseline]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("ir-layering ratchet: FAIL");
      expect(res.stderr).toContain("ir/a.ts: codegen imports INCREASED 1 → 2");
    });

    it("FAILS when a NEW file acquires a codegen import", () => {
      writeIr({
        "a.ts": 'import { VOCAB } from "../codegen/vocab.js";\nexport const a = VOCAB;\n',
        "b.ts": 'import { OTHER } from "../codegen/other.js";\nexport const b = OTHER;\n',
      });

      const res = runGate(["--src", src, "--baseline", baseline]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("NEW file with codegen imports: ir/b.ts");
    });

    it("counts `import type` — a type-only edge is still an edge in the graph", () => {
      writeIr({
        "a.ts":
          'import { VOCAB } from "../codegen/vocab.js";\n' +
          'import type { Other } from "../codegen/other.js";\n' +
          "export const a: Other = VOCAB;\n",
        "b.ts": "export const b = 1;\n",
      });

      const res = runGate(["--src", src, "--baseline", baseline]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("ir/a.ts: codegen imports INCREASED 1 → 2");
    });

    it("does NOT count src/codegen-linear/ — a sibling backend, not the codegen layer", () => {
      writeIr({
        "a.ts":
          'import { VOCAB } from "../codegen/vocab.js";\n' +
          'import { LAYOUT } from "../codegen-linear/layout.js";\n' +
          "export const a = VOCAB + LAYOUT;\n",
        "b.ts": "export const b = 1;\n",
      });

      // A naive `from "../codegen` prefix match would count the second import
      // and fail here. Resolution-based matching keeps it at 1.
      const res = runGate(["--src", src, "--baseline", baseline]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("codegen-linear/ import lines are NOT gated");
    });

    it("passes on a DECREASE and says the improvement can be banked", () => {
      writeIr({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });

      const res = runGate(["--src", src, "--baseline", baseline]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("[improved — run with --update to bank it]");
    });
  });

  describe("committed baseline", () => {
    it("matches the live measurement of src/ir/ (no silent drift)", () => {
      const res = runGate(["--json"]);
      expect(res.status).toBe(0);

      const live = (JSON.parse(res.stdout) as { current: { total: number; files: Record<string, number> } }).current;
      const committed = JSON.parse(readFileSync(COMMITTED_BASELINE, "utf-8")) as {
        total: number;
        files: Record<string, number>;
      };

      expect(live.files).toEqual(committed.files);
      expect(live.total).toBe(committed.total);
    });
  });
});
