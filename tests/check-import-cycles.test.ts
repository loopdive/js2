// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6797 — tests for the import-cycle ratchet (`scripts/check-import-cycles.mjs`).
 *
 * A ratchet is only worth its CI minute if it FIRES. Against a synthetic
 * `src/` tree in a tmp dir this suite pins:
 *   - a 3-file value-import cycle across three directories is ONE SCC of 3;
 *   - a type-only import (`import type`, all-inline `type` specifiers,
 *     `export type … from`) is NOT an edge, so it cannot close a cycle;
 *   - every value syntax IS an edge: multi-line `import x, { y }`,
 *     `export … from`, and dynamic `import()`;
 *   - growth of any number fails, a decrease passes, and
 *     `--update-on-decrease` banks the decrease into the baseline.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-import-cycles.mjs");

interface Baseline {
  largestSccSize: number;
  sccCountOver1: number;
  twoWayDirEdges: Record<string, number>;
}

const root = mkdtempSync(join(tmpdir(), "import-cycles-gate-"));
const src = join(root, "src");
const baseline = join(root, "baseline.json");

function writeTree(files: Record<string, string>): void {
  rmSync(src, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    writeFileSync(join(src, rel), body);
  }
}

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--src", src, "--baseline", baseline, ...args], {
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

const readBaseline = (): Baseline => JSON.parse(readFileSync(baseline, "utf-8")) as Baseline;

/** a/x -> b/y -> c/z -> a/x: one 3-file cycle spanning three directories. */
const CYCLE = {
  "a/x.ts": 'import { y } from "../b/y.js";\nexport const x = () => y;\n',
  "b/y.ts": 'import { z } from "../c/z.js";\nexport const y = () => z;\n',
  "c/z.ts": 'import { x } from "../a/x.js";\nexport const z = () => x;\n',
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("#6797 — import-cycle ratchet", () => {
  beforeEach(() => rmSync(baseline, { force: true }));

  it("detects a 3-file cycle as one SCC of 3", () => {
    writeTree(CYCLE);
    expect(run("--update").status).toBe(0);
    expect(readBaseline()).toEqual({ largestSccSize: 3, sccCountOver1: 1, twoWayDirEdges: {} });
  });

  it("does NOT count type-only imports as edges", () => {
    writeTree({
      ...CYCLE,
      // k value-imports l1..l3; each l back-references k type-only. Any one
      // of them counted as a value edge would make a k <-> l cycle.
      "k/k.ts":
        'import { l1 } from "../l/l1.js";\nimport { l2 } from "../l/l2.js";\nimport "../l/l3.js";\n' +
        "export class K {}\nexport const k = [l1, l2];\n",
      "l/l1.ts": 'import type { K } from "../k/k.js";\nexport const l1 = (v: K) => v;\n',
      "l/l2.ts": 'import { type K, type k } from "../k/k.js";\nexport const l2 = (v: K): typeof k => [v];\n',
      "l/l3.ts": 'export type { K } from "../k/k.js";\n',
    });
    expect(run("--update").status).toBe(0);
    expect(readBaseline()).toEqual({ largestSccSize: 3, sccCountOver1: 1, twoWayDirEdges: {} });
  });

  it("counts multi-line default+named imports, re-exports and dynamic import() as value edges", () => {
    writeTree({
      ...CYCLE,
      "e/one.ts": 'import def, {\n  named,\n} from "../f/one.js";\nexport const one = [def, named];\n',
      "f/one.ts": 'export { one } from "../e/one.js";\nexport default 1;\nexport const named = 2;\n',
      "g/lazy.ts": 'export async function lazy() {\n  return (await import("../h/eager.js")).eager;\n}\n',
      "h/eager.ts": 'import { lazy } from "../g/lazy.js";\nexport const eager = lazy;\n',
    });
    expect(run("--update").status).toBe(0);
    expect(readBaseline()).toEqual({
      largestSccSize: 3,
      sccCountOver1: 3,
      twoWayDirEdges: { "e->f": 1, "f->e": 1, "g->h": 1, "h->g": 1 },
    });
  });

  it("FAILS when any number grows", () => {
    writeTree(CYCLE);
    expect(run("--update").status).toBe(0);
    expect(run().status).toBe(0);

    // A new two-file cycle: one more SCC and a new two-way directory pair.
    writeTree({
      ...CYCLE,
      "p/p.ts": 'import { q } from "../q/q.js";\nexport const p = () => q;\n',
      "q/q.ts": 'import { p } from "../p/p.js";\nexport const q = () => p;\n',
    });
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("import-cycles ratchet: FAIL");
    expect(res.stderr).toContain("sccCountOver1: 1 → 2");
    expect(res.stderr).toContain("twoWayDirEdges[p->q]: 0 → 1 (NEW two-way directory pair)");
  });

  it("passes on a decrease and banks it with --update-on-decrease", () => {
    writeTree({
      ...CYCLE,
      "p/p.ts": 'import { q } from "../q/q.js";\nexport const p = () => q;\n',
      "q/q.ts": 'import { p } from "../p/p.js";\nexport const q = () => p;\n',
    });
    expect(run("--update").status).toBe(0);
    expect(readBaseline().sccCountOver1).toBe(2);

    // Cut q -> p: the p <-> q cycle and its two-way pair disappear.
    writeTree({
      ...CYCLE,
      "p/p.ts": 'import { q } from "../q/q.js";\nexport const p = () => q;\n',
      "q/q.ts": "export const q = () => 1;\n",
    });
    const plain = run();
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("[improved — --update-on-decrease banks it]");
    expect(readBaseline().sccCountOver1).toBe(2); // a plain gate run never writes

    const bank = run("--update-on-decrease");
    expect(bank.status).toBe(0);
    expect(bank.stdout).toContain("banked");
    expect(readBaseline()).toEqual({ largestSccSize: 3, sccCountOver1: 1, twoWayDirEdges: {} });
  });

  it("refuses to gate without a baseline", () => {
    writeTree(CYCLE);
    const res = run();
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("seed it with --update");
  });
});
