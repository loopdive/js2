/**
 * #6795 — CLAUDE.md named a test file that does not exist, a CI workflow that
 * had been deleted, and a CLI flag `src/cli.ts` does not parse. The gate
 * (`scripts/check-claude-md-paths.mjs`, `pnpm run check:claude-md-paths`, a
 * step of CI's `quality` job) fails when CLAUDE.md names a repo path or a
 * "CLI Flags" flag that is not there.
 *
 * The positive controls reproduce the exact failure shapes from the review, so
 * a rewrite that stops catching them is caught here.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import {
  checkClaudeMd,
  checkTarget,
  cliParsesFlag,
  extractReferences,
  normalizePathToken,
} from "../scripts/check-claude-md-paths.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-claude-md-paths.mjs");

describe("normalizePathToken", () => {
  const p = (t: string) => normalizePathToken(t)?.path ?? null;

  it("keeps repo paths and strips line, symbol and anchor suffixes and trailing punctuation", () => {
    expect(p("src/index.ts")).toBe("src/index.ts");
    expect(p("./scripts/local-ci.sh")).toBe("scripts/local-ci.sh");
    expect(p("src/codegen/index.ts:2222-2247")).toBe("src/codegen/index.ts");
    expect(p("scripts/enqueue-green-prs.mjs:1276,")).toBe("scripts/enqueue-green-prs.mjs");
    expect(p("src/foo.ts::someFunction")).toBe("src/foo.ts");
    expect(p("docs/ci-policy.md#7")).toBe("docs/ci-policy.md");
    expect(p("(docs/adr/README.md).")).toBe("docs/adr/README.md");
    expect(p(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
  });

  it("ignores things that are not repo paths", () => {
    expect(p("/workspace/.claude/worktrees/x")).toBeNull();
    expect(p("~/.claude/tasks/x.json")).toBeNull();
    expect(p("https://example.com/src/x.ts")).toBeNull();
    expect(p(".tmp/new.ts")).toBeNull();
    expect(p("origin/main")).toBeNull();
    expect(p("--target")).toBeNull();
  });

  it("reads a bare workflow filename as `.github/workflows/<name>`, with a repo-root fallback", () => {
    expect(normalizePathToken("test262-sharded.yml")).toEqual({
      path: ".github/workflows/test262-sharded.yml",
      alt: "test262-sharded.yml",
    });
    expect(normalizePathToken("pnpm-lock.yaml")?.alt).toBe("pnpm-lock.yaml");
  });
});

describe("checkTarget", () => {
  it("checks a glob or placeholder up to its last literal directory", () => {
    expect(checkTarget("src/**")).toBe("src");
    expect(checkTarget("scripts/*-baseline.json")).toBe("scripts");
    expect(checkTarget("plan/issues/<id>-<slug>.md")).toBe("plan/issues");
    expect(checkTarget("plan/issues/sprints/{N}.md")).toBe("plan/issues/sprints");
    expect(checkTarget("src/...")).toBe("src");
    expect(checkTarget("src/codegen/")).toBe("src/codegen");
    expect(checkTarget("src/codegen/index.ts")).toBe("src/codegen/index.ts");
  });
});

describe("extractReferences", () => {
  it("finds paths in inline spans, fenced blocks and link targets, with their line numbers", () => {
    const md = [
      "Run `npm test -- tests/issue-277.test.ts` now.", // 1
      "```bash", // 2
      "cp src/foo.ts .tmp/new.ts", // 3
      "```", // 4
      "See [the doc](docs/ci-policy.md) and [web](https://x.dev/src/a.ts).", // 5
    ].join("\n");
    const { paths } = extractReferences(md);
    expect(paths.map((r: { line: number; path: string }) => [r.line, r.path])).toEqual([
      [1, "tests/issue-277.test.ts"],
      [3, "src/foo.ts"],
      [5, "docs/ci-policy.md"],
    ]);
  });

  it("does not read paths from plain prose outside backticks", () => {
    expect(extractReferences("The file src/missing.ts is not backticked.").paths).toEqual([]);
  });

  it("checks `--flag`s only inside the `## CLI Flags` section, and keeps their case", () => {
    const md = [
      "Use `git commit --no-verify` never.",
      "## CLI Flags",
      "- `--target wasi` and `--nativeStrings`",
      "## Next",
      "- `pnpm run foo --other`",
    ].join("\n");
    expect(extractReferences(md).flags.map((f: { flag: string }) => f.flag)).toEqual(["--target", "--nativeStrings"]);
  });

  it("skips a line marked historical and reports it", () => {
    const md =
      "The old `scripts/gone.mjs` was deleted. <!-- historical -->\nBut `scripts/also-gone.mjs` was not marked.";
    const { paths, skipped } = extractReferences(md);
    expect(paths.map((r: { path: string }) => r.path)).toEqual(["scripts/also-gone.mjs"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].line).toBe(1);
  });
});

describe("cliParsesFlag", () => {
  const cli = `if (arg === "--target" || arg.startsWith("--target=")) {} else if (arg === "--wit") {}\n// --help text mentions --nativeStrings only in prose`;
  it("requires the flag as a quoted string, the way the arg parser writes it", () => {
    expect(cliParsesFlag(cli, "--target")).toBe(true);
    expect(cliParsesFlag(cli, "--wit")).toBe(true);
    expect(cliParsesFlag(cli, "--nativeStrings")).toBe(false); // prose mention is not a parser
    expect(cliParsesFlag(cli, "--wi")).toBe(false); // a prefix of a real flag is not that flag
  });
});

describe("checkClaudeMd", () => {
  const exists = (p: string) =>
    new Set(["src", "src/cli.ts", "scripts", ".github/workflows", ".github/workflows/ci.yml"]).has(p);

  it("POSITIVE CONTROL: the 2026-09-30 failure shapes each fail, named", () => {
    const md = [
      "Run the suite with `tests/equivalence.test.ts`.", // missing file
      "Validated by `test262-baseline-validate.yml`.", // missing workflow
      "## CLI Flags",
      "- `--nativeStrings` — use i16 arrays", // flag cli.ts does not parse
    ].join("\n");
    const { problems } = checkClaudeMd({ markdown: md, exists, cliSource: `arg === "--target"` });
    expect(problems.map((p: { line: number; what: string }) => [p.line, p.what])).toEqual([
      [1, "tests/equivalence.test.ts"],
      [2, "test262-baseline-validate.yml"],
      [4, "--nativeStrings"],
    ]);
  });

  it("passes when everything exists", () => {
    const md =
      "See `src/cli.ts`, `.github/workflows/ci.yml`, `ci.yml` and `scripts/*-baseline.json`.\n## CLI Flags\n- `--target`";
    expect(checkClaudeMd({ markdown: md, exists, cliSource: `arg === "--target"` }).problems).toEqual([]);
  });

  it("a glob under a missing directory fails and names the directory", () => {
    const { problems } = checkClaudeMd({ markdown: "`nope/` and `plan/gone/*.md`", exists, cliSource: "" });
    expect(problems.map((p: { why: string }) => p.why)).toEqual(["directory plan/gone/ does not exist"]);
  });
});

describe("the CLI", () => {
  let sandbox: string | undefined;
  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  function run(claudeMd: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "issue-6795-claudemd-"));
    sandbox = dir;
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "src", "cli.ts"), `if (arg === "--target") {}`);
    writeFileSync(join(dir, "scripts", "real.mjs"), "");
    if (claudeMd !== null) writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("exits 0 with an OK verdict when every reference resolves", () => {
    const r = run("`scripts/real.mjs`\n## CLI Flags\n- `--target`\n");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").pop()).toMatch(
      /^check-claude-md-paths: OK — 1 path reference\(s\) and 1 CLI flag\(s\)/,
    );
  });

  it("exits 1, names file:line and the token, and ends on a FAILED verdict", () => {
    const r = run("fine\n`scripts/missing.mjs` is gone\n");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/CLAUDE\.md:2: `scripts\/missing\.mjs` does not exist/);
    expect(r.out.trim().split("\n").pop()).toMatch(/^check-claude-md-paths: FAILED — 1 dangling reference/);
  });

  it("<!-- historical --> silences exactly its own line, and the skip is printed", () => {
    const r = run("`scripts/gone.mjs` was deleted <!-- historical -->\n`scripts/real.mjs`\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped line 1");
    expect(r.out).toContain("1 line(s) skipped as historical");
  });

  it("exits 2 when CLAUDE.md cannot be read", () => {
    const r = run(null);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/check-claude-md-paths: FAILED/);
  });
});

describe("the real CLAUDE.md", () => {
  it("passes the gate", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).toMatch(/check-claude-md-paths: OK/);
    expect(r.status).toBe(0);
  });

  it("uses the skip marker sparingly", () => {
    const uses = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8")
      .split("\n")
      .filter((l) => l.includes("<!-- historical -->"));
    expect(uses.length).toBeLessThanOrEqual(3);
  });

  it("is wired into package.json and CI's quality job", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["check:claude-md-paths"]).toBe("node scripts/check-claude-md-paths.mjs");
    expect(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")).toContain(
      "run: pnpm run check:claude-md-paths",
    );
  });
});
