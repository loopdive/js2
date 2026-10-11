/**
 * #6795 — README/STATUS/ROADMAP printed conformance claims that contradicted
 * their own numbers ("standalone trails host" next to 85.9 % vs 81.3 %, a
 * 43,106 denominator beside 48,232, "~75 %" beside 81 %). The cure is that no
 * such figure or comparison is typed: `sync-conformance-numbers.mjs` generates
 * the standalone line, the denominator and a per-area table, and `--check`
 * (wired into CI's `quality` job) fails when a committed block drifts.
 *
 * The script runs as a real subprocess against a throwaway repo skeleton, as
 * in tests/issue-3947.test.ts, so the CLI contract (exit codes, stderr) is
 * what is covered.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_REL = "scripts/sync-conformance-numbers.mjs";

const block = (name: string, body = "stale") => `<!-- AUTO:${name}-start -->\n\n${body}\n\n<!-- AUTO:${name}-end -->`;

/** A report with the optional detail the scope/areas blocks read. */
function report(over: Record<string, unknown> = {}) {
  return {
    summary: {
      pass: 800,
      total: 1000,
      by_category: {
        standard: { total: 950 },
        annex_b: { total: 50 },
        proposal: { total: 20 },
      },
    },
    categories: [
      { name: "language/expressions", pass: 400, total: 450 },
      { name: "language/eval-code", pass: 30, total: 50 },
      { name: "built-ins/Array", pass: 300, total: 400 },
      { name: "built-ins/eval", pass: 8, total: 10 },
      { name: "built-ins/Proxy", pass: 60, total: 80 },
      { name: "annexB/language", pass: 28, total: 50 },
      { name: "harness", pass: 4, total: 10 },
      { name: "intl402/Foo", pass: 5, total: 20 },
    ],
    ...over,
  };
}

let sandbox: string;
const target = (rel: string) => join(sandbox, rel);

function run(args: string[] = []): { code: number; out: string } {
  // spawnSync (not execFileSync) so stderr is kept on a zero exit too: the
  // "category missing" warning is emitted on a successful run.
  const r = spawnSync(process.execPath, [target(SCRIPT_REL), ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeJson(rel: string, value: unknown) {
  writeFileSync(target(rel), JSON.stringify(value));
}

const full = (extra = "") =>
  `# T\n\n${block("conformance")}\n\n${block("conformance-standalone")}\n\n${block("conformance-scope")}\n\n${block("conformance-areas")}\n${extra}`;
const minimal = `# T\n\n${block("conformance")}\n`;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "issue-6795-"));
  mkdirSync(join(sandbox, "scripts"), { recursive: true });
  mkdirSync(join(sandbox, "benchmarks", "results"), { recursive: true });
  mkdirSync(join(sandbox, "plan", "goals"), { recursive: true });
  cpSync(join(REPO_ROOT, SCRIPT_REL), target(SCRIPT_REL));
  writeJson("benchmarks/results/test262-current.json", report());
  writeJson("benchmarks/results/test262-standalone-highwater.json", { official_pass: 900, official_total: 1000 });
  for (const rel of ["ROADMAP.md", "CLAUDE.md", "plan/goals/goal-graph.md"]) writeFileSync(target(rel), minimal);
  writeFileSync(target("README.md"), full());
  writeFileSync(target("STATUS.md"), full());
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("#6795 — generated standalone line, denominator and per-area table", () => {
  it("writes all four blocks into a file that carries the anchors", () => {
    expect(run().code).toBe(0);
    const readme = readFileSync(target("README.md"), "utf8");
    expect(readme).toContain("**test262 conformance**: 800 / 1,000 (80.0 %)");
    expect(readme).toContain("**standalone (host-free) test262 conformance**: 900 / 1,000 (90.0 %)");
    expect(readme).toContain(
      "Both figures are scored against the same **1,000** official tests (950 ECMAScript standard + 50 Annex B). " +
        "The 20 TC39 proposal-stage tests are excluded.",
    );
    // Area rows aggregate by top-level directory; unknown areas sort after the known ones.
    expect(readme).toMatch(/`language\/`\s*\|\s*430 \|\s*500 \|\s*86\.0 %/);
    expect(readme).toMatch(/`built-ins\/`\s*\|\s*368 \|\s*490 \|/);
    expect(readme.indexOf("`harness/`")).toBeLessThan(readme.indexOf("`intl402/`"));
    // The feature row sums its category paths (eval = built-ins/eval + language/eval-code).
    expect(readme).toMatch(/eval\s*\|\s*`built-ins\/eval` \+ `language\/eval-code`\s*\|\s*38 \|\s*60 \|/);
  });

  it("the caption states how the rows relate to the headline total, computed not typed", () => {
    run();
    // rows sum to 1,070 (the fixture's categories), the headline is 1,000
    expect(readFileSync(target("README.md"), "utf8")).toContain(
      "cover all 1,070 test files the runner scores — 70 more than the headline total",
    );
  });

  it("does not claim the two lanes share a denominator when they do not", () => {
    writeJson("benchmarks/results/test262-standalone-highwater.json", { official_pass: 900, official_total: 990 });
    run();
    const readme = readFileSync(target("README.md"), "utf8");
    expect(readme).toContain("The JS-host figure is scored against **1,000** official tests");
    expect(readme).toContain("the standalone figure against **990**");
    expect(readme).not.toContain("same **");
  });

  it("is idempotent and --check passes right after a sync", () => {
    expect(run().code).toBe(0);
    expect(run(["--check"]).code).toBe(0);
  });

  it("emits tables that prettier's markdown formatter leaves unchanged", async () => {
    run();
    const config = (await prettier.resolveConfig(join(REPO_ROOT, "README.md"))) ?? {};
    for (const rel of ["README.md", "STATUS.md"]) {
      const generated = readFileSync(target(rel), "utf8");
      const formatted = await prettier.format(generated, { ...config, parser: "markdown" });
      expect(formatted, `${rel}: generated tables are not prettier-stable`).toBe(generated);
    }
  });
});

describe("#6795 — --check catches drift in the new blocks", () => {
  it("POSITIVE CONTROL: a hand-edited denominator fails and names both values", () => {
    run();
    const readme = readFileSync(target("README.md"), "utf8").replace(
      "**1,000** official tests",
      "**43,106** official tests",
    );
    writeFileSync(target("README.md"), readme);
    const { code, out } = run(["--check"]);
    expect(code).toBe(1);
    expect(out).toContain("README.md (scope)");
    expect(out).toContain("43,106");
    expect(out).toContain("1,000");
  });

  it("a stale per-area row fails", () => {
    run();
    const status = readFileSync(target("STATUS.md"), "utf8").replace(/\b430\b/, "999");
    writeFileSync(target("STATUS.md"), status);
    const { code, out } = run(["--check"]);
    expect(code).toBe(1);
    expect(out).toContain("STATUS.md (areas)");
  });

  it("a stale standalone line in STATUS.md fails (it is now generated there too)", () => {
    run();
    const status = readFileSync(target("STATUS.md"), "utf8").replace("900 / 1,000", "100 / 1,000");
    writeFileSync(target("STATUS.md"), status);
    const { code, out } = run(["--check"]);
    expect(code).toBe(1);
    expect(out).toContain("STATUS.md (standalone)");
  });
});

describe("#6795 — the new blocks are opt-in and never break a minimal report", () => {
  it("files without the new anchors are untouched, even when the report has no detail", () => {
    writeJson("benchmarks/results/test262-current.json", { summary: { pass: 800, total: 1000 } });
    writeFileSync(target("README.md"), minimal);
    writeFileSync(target("STATUS.md"), minimal);
    expect(run().code).toBe(0);
    expect(readFileSync(target("README.md"), "utf8")).not.toContain("conformance-scope");
  });

  it("a file that asks for the areas table but the report lacks `categories` is an error, not a blank", () => {
    writeJson("benchmarks/results/test262-current.json", { summary: { pass: 800, total: 1000 } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toMatch(/no `categories` array/);
  });

  it("a feature category missing from the report skips its row with a warning instead of failing", () => {
    const r = report();
    r.categories = r.categories.filter((c: { name: string }) => c.name !== "built-ins/Proxy");
    writeJson("benchmarks/results/test262-current.json", r);
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toMatch(/"Proxy" missing from the report/);
    expect(readFileSync(target("README.md"), "utf8")).not.toContain("`built-ins/Proxy`");
  });
});

describe("#6795 — the committed docs carry no hand-typed lane comparison", () => {
  // Strip every generated region, then the remaining prose must not make a
  // claim that a number can falsify.
  const strip = (s: string) => s.replace(/<!-- AUTO:([\w-]+)-start -->[\s\S]*?<!-- AUTO:\1-end -->/g, "");
  const banned: Array<[RegExp, string]> = [
    [/\btrails?\b/i, "a hand-written 'trails' comparison"],
    [/meaningfully lower/i, "a hand-written 'meaningfully lower' comparison"],
    [/\bLower today\b/i, "a hand-written 'lower today' comparison"],
    [/\bcurrently ~\d+ ?%/i, "a typed 'currently ~N %' figure"],
    [/\b43,106\b/, "the stale 43,106 denominator"],
    [/import \{ compile \} from "js2wasm"/, "the wrong package name"],
  ];
  for (const rel of ["README.md", "STATUS.md", "ROADMAP.md"]) {
    it(`${rel} has none of the phrases #6795 removed`, () => {
      const prose = strip(readFileSync(join(REPO_ROOT, rel), "utf8"));
      for (const [re, what] of banned) {
        expect(prose, `${rel} contains ${what}`).not.toMatch(re);
      }
    });
  }
  it("README and STATUS carry the generated standalone, scope and (STATUS) areas blocks", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const status = readFileSync(join(REPO_ROOT, "STATUS.md"), "utf8");
    for (const name of ["conformance", "conformance-standalone", "conformance-scope"]) {
      expect(readme).toContain(`<!-- AUTO:${name}-start -->`);
      expect(status).toContain(`<!-- AUTO:${name}-start -->`);
    }
    expect(status).toContain("<!-- AUTO:conformance-areas-start -->");
  });
});

describe("#6795 — every workflow that regenerates the docs also commits every target", () => {
  // The sync runs in CI on every push to main and commits what it wrote. A
  // target the staging line forgets is rewritten in the job's working tree and
  // never committed, so main drifts from the JSON and `sync:conformance:check`
  // turns red on every open PR.
  const targets = [
    ...readFileSync(join(REPO_ROOT, SCRIPT_REL), "utf8")
      .match(/const TARGETS = \[([^\]]*)\]/)![1]
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);

  it("reads the target list out of the script", () => {
    expect(targets).toContain("STATUS.md");
    expect(targets.length).toBeGreaterThanOrEqual(5);
  });

  for (const wf of ["baseline-summary-sync.yml", "refresh-baseline.yml", "test262-sharded.yml"]) {
    it(`${wf} stages all of them`, () => {
      const lines = readFileSync(join(REPO_ROOT, ".github", "workflows", wf), "utf8")
        .split("\n")
        .filter((l) => /git add -f README\.md/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const t of targets) expect(line, `${wf} does not stage ${t}`).toContain(t);
      }
    });
  }
});
