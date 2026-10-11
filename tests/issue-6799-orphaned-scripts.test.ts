// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6799 — the orphaned-script ratchet. `findOrphans` is driven with an
 * in-memory file set so every matching rule is pinned, including the ones that
 * must NOT count (tests/, plan/issues/, a self-mention, a longer name that
 * merely contains the script's name).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findOrphans, referenceNames } from "../scripts/check-orphaned-scripts.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

function run(tree: Record<string, string>) {
  return findOrphans(Object.keys(tree), (p: string) => tree[p] ?? null).orphans;
}

describe("#6799 orphaned-script detection", () => {
  it("counts package.json, workflows, hooks, .claude, docs, plan/method, root docs and other scripts", () => {
    const orphans = run({
      "package.json": '{"scripts":{"a":"node scripts/a.mjs"}}',
      ".github/workflows/x.yml": "run: bash ./scripts/b.sh",
      ".husky/pre-push": ". scripts/c.sh",
      ".claude/skills/s/SKILL.md": "Run `node scripts/d.mjs`.",
      "docs/how.md": "see scripts/e.mjs.",
      "plan/method/m.md": "scripts/f.mjs",
      "CLAUDE.md": "`scripts/g.mjs`",
      "scripts/h.mjs": 'import "./lib/x.mjs"; import "./i.mjs";',
      "scripts/i.mjs": "",
      "scripts/a.mjs": "",
      "scripts/b.sh": "",
      "scripts/c.sh": "",
      "scripts/d.mjs": "",
      "scripts/e.mjs": "",
      "scripts/f.mjs": "",
      "scripts/g.mjs": "",
      "scripts/lib/x.mjs": "",
    });
    // h.mjs is referenced by nothing; every other top-level file is.
    expect(orphans).toEqual(["scripts/h.mjs"]);
  });

  it("does not count tests/, plan/issues/, website/ or a self-mention", () => {
    const orphans = run({
      "tests/t.test.ts": 'import "../scripts/a.mjs";',
      "plan/issues/1-x.md": "scripts/b.mjs",
      "website/page.html": "scripts/c.mjs",
      "scripts/a.mjs": "",
      "scripts/b.mjs": "",
      "scripts/c.mjs": "// usage: node scripts/c.mjs",
    });
    expect(orphans).toEqual(["scripts/a.mjs", "scripts/b.mjs", "scripts/c.mjs"]);
  });

  it("matches whole names only, and a .ts file by its emitted .js import", () => {
    const orphans = run({
      "scripts/user.mjs": 'import "./tool.js"; import "./run.test.mjs"; import "./prefix-run.mjs";',
      "scripts/tool.ts": "",
      "scripts/run.mjs": "",
      "scripts/run.test.mjs": "",
      "scripts/prefix-run.mjs": "",
    });
    // run.mjs is only a substring of run.test.mjs / prefix-run.mjs.
    expect(orphans).toEqual(["scripts/run.mjs", "scripts/user.mjs"]);
    expect(referenceNames("x.mts")).toEqual(["x.mts", "x.mjs"]);
  });

  it("never treats a scripts/ subdirectory file as a candidate", () => {
    expect(run({ "scripts/lib/only.mjs": "" })).toEqual([]);
  });

  it("does not let the baseline's own listing count as a reference (no vacuous pass)", () => {
    const orphans = run({
      "scripts/orphaned-scripts-baseline.json": '{"orphans":["scripts/dead.mjs"]}',
      "scripts/check-orphaned-scripts.mjs": "orphaned-scripts-baseline.json",
      "package.json": "scripts/check-orphaned-scripts.mjs",
      "scripts/dead.mjs": "",
    });
    expect(orphans).toEqual(["scripts/dead.mjs"]);
  });
});

describe("#6799 the repo itself", () => {
  it("has no orphaned script outside the committed baseline", () => {
    const baseline = JSON.parse(readFileSync(resolve(ROOT, "scripts/orphaned-scripts-baseline.json"), "utf8"));
    const { orphans } = findOrphans();
    expect(orphans.filter((o: string) => !baseline.orphans.includes(o))).toEqual([]);
    expect(baseline.count).toBe(baseline.orphans.length);
    // Vacuity guard: the detector still sees the known orphans.
    expect(orphans.length).toBeGreaterThan(0);
  });
});
