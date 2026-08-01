/**
 * #3947 — `sync-conformance-numbers.mjs` fought prettier over the generated
 * block, and its `--check` failure named a cause it had not established.
 *
 * Two defects, two guards:
 *
 *  1. The generated anchor block must be PRETTIER-STABLE. Before the fix the
 *     script emitted `<anchor>\n<body>\n<anchor>` while prettier's markdown
 *     formatter wants a blank line on either side, so `prettier --write` and
 *     `pnpm run sync:conformance` mutually undid each other. Measured cost of
 *     that loop: ~50 min of one agent, a wasted cycle for a second, and a
 *     third CI round-trip — all on a two-blank-line diff.
 *
 *  2. `--check` must name the ACTUAL difference. The old message was
 *     `DRIFT  CLAUDE.md`, which under a script called
 *     sync-conformance-NUMBERS reads as "the conformance number is stale".
 *     It was not; only whitespace differed. The new message classifies the
 *     two cases and prints the real block diff.
 *
 * The stale-number case is the POSITIVE CONTROL: a message rewrite that stops
 * detecting genuine drift would be worse than the bug it fixed, so this file
 * asserts that a really-stale number still fails AND that the message names
 * the number.
 *
 * The script is exercised as a real subprocess against a throwaway repo
 * skeleton in a temp dir (it resolves its ROOT from its own location), so no
 * production code needed a testability refactor and the CLI contract —
 * including exit codes and stderr wording — is what gets covered.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_REL = "scripts/sync-conformance-numbers.mjs";

const PASS = 30_530;
const TOTAL = 43_099;
const SA_PASS = 25_590;
const SA_TOTAL = 43_106;

const EXPECTED_LINE = `**test262 conformance**: 30,530 / 43,099 (70.8 %)`;

const START = "<!-- AUTO:conformance-start -->";
const END = "<!-- AUTO:conformance-end -->";
const SA_START = "<!-- AUTO:conformance-standalone-start -->";
const SA_END = "<!-- AUTO:conformance-standalone-end -->";

/** A target file body with the block in the pre-fix (blank-line-free) shape. */
function fixture(heading: string, standalone = false): string {
  const main = `${START}\n${EXPECTED_LINE}\n${END}`;
  const sa = standalone
    ? `\nSome prose between the two blocks.\n\n${SA_START}\n**standalone (host-free) test262 conformance**: 25,590 / 43,106 (59.4 %)\n${SA_END}\n`
    : "";
  return `# ${heading}\n\nIntro prose that prettier already agrees with.\n\n${main}\n${sa}\nTrailing prose.\n`;
}

let sandbox: string;

function scriptPath(): string {
  return join(sandbox, SCRIPT_REL);
}

function target(rel: string): string {
  return join(sandbox, rel);
}

/** Run the script; returns exit code plus combined output. */
function runScript(args: string[]): { code: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath(), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "issue-3947-"));
  mkdirSync(join(sandbox, "scripts"), { recursive: true });
  mkdirSync(join(sandbox, "benchmarks", "results"), { recursive: true });
  mkdirSync(join(sandbox, "plan", "goals"), { recursive: true });

  cpSync(join(REPO_ROOT, SCRIPT_REL), scriptPath());

  writeFileSync(
    join(sandbox, "benchmarks", "results", "test262-current.json"),
    JSON.stringify({ summary: { pass: PASS, total: TOTAL } }),
  );
  writeFileSync(
    join(sandbox, "benchmarks", "results", "test262-standalone-highwater.json"),
    JSON.stringify({ official_pass: SA_PASS, official_total: SA_TOTAL }),
  );

  writeFileSync(target("ROADMAP.md"), fixture("Roadmap"));
  writeFileSync(target("README.md"), fixture("Readme", true));
  writeFileSync(target("CLAUDE.md"), fixture("Claude"));
  writeFileSync(target("plan/goals/goal-graph.md"), fixture("Goals"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("#3947 — the generated conformance block is prettier-stable", () => {
  it("emits exactly the shape prettier's markdown formatter produces", async () => {
    expect(runScript([]).code).toBe(0);

    // The repo's own prettier options, so this is the same formatter that
    // rewrote CLAUDE.md in the original incident.
    const config = (await prettier.resolveConfig(join(REPO_ROOT, "CLAUDE.md"))) ?? {};

    for (const rel of ["ROADMAP.md", "README.md", "CLAUDE.md", "plan/goals/goal-graph.md"]) {
      const generated = readFileSync(target(rel), "utf8");
      const formatted = await prettier.format(generated, { ...config, parser: "markdown" });
      // If this fails, prettier and the sync script disagree again and every
      // `prettier --write` on a target file re-arms the #3947 loop.
      expect(formatted, `${rel}: sync output is not prettier-stable`).toBe(generated);
    }
  });

  // ^ THIS is what keeps the sync-vs-prettier agreement non-vacuous now that
  // every .md file is in .prettierignore. `prettier.format()` is the
  // programmatic API and does NOT consult .prettierignore, so ignoring the
  // real CLAUDE.md cannot silence it. It is also a better detector than the
  // manual `prettier --write CLAUDE.md` it replaces: that command is
  // confounded by unrelated prose drift elsewhere in the file (measured
  // 2026-08-01 — a merge brought in a list-continuation line prettier
  // de-indents), whereas this isolates the generated block.

  it("round-trips: sync -> prettier -> --check stays green", async () => {
    expect(runScript([]).code).toBe(0);

    const config = (await prettier.resolveConfig(join(REPO_ROOT, "CLAUDE.md"))) ?? {};
    for (const rel of ["ROADMAP.md", "README.md", "CLAUDE.md", "plan/goals/goal-graph.md"]) {
      const before = readFileSync(target(rel), "utf8");
      writeFileSync(target(rel), await prettier.format(before, { ...config, parser: "markdown" }));
    }

    expect(runScript(["--check"]).code).toBe(0);
  });
});

describe("#3947 — --check names the actual cause", () => {
  it("POSITIVE CONTROL: a genuinely stale number still fails, and the message names the number", () => {
    expect(runScript([]).code).toBe(0);

    const stale = readFileSync(target("CLAUDE.md"), "utf8").replace(
      EXPECTED_LINE,
      EXPECTED_LINE.replace("30,530", "29,999"),
    );
    writeFileSync(target("CLAUDE.md"), stale);

    const { code, out } = runScript(["--check"]);
    expect(code).toBe(1);
    expect(out).toContain("CLAUDE.md");
    expect(out).toMatch(/generated line CHANGED/);
    // Both values must appear, so triage never has to guess which moved.
    expect(out).toContain("29,999 / 43,099");
    expect(out).toContain("30,530 / 43,099");
    // ...and it must NOT be misfiled as a formatting difference.
    expect(out).not.toMatch(/WHITESPACE\/FORMATTING ONLY/);
  });

  it("a whitespace-only difference is reported as such, and does not implicate the number", () => {
    expect(runScript([]).code).toBe(0);

    // Strip the blank lines the way the pre-#3947 script did.
    const squashed = readFileSync(target("CLAUDE.md"), "utf8").replace(
      `${START}\n\n${EXPECTED_LINE}\n\n${END}`,
      `${START}\n${EXPECTED_LINE}\n${END}`,
    );
    writeFileSync(target("CLAUDE.md"), squashed);

    const { code, out } = runScript(["--check"]);
    expect(code).toBe(1);
    expect(out).toMatch(/WHITESPACE\/FORMATTING ONLY/);
    expect(out).toMatch(/nothing about the conformance figures has changed/);
    expect(out).not.toMatch(/generated line CHANGED/);
    // The blank-line diff must be visible, not rendered as empty strings.
    expect(out).toContain("+ (blank line)");
  });

  it("the prescribed remedy actually repairs both failure modes", () => {
    expect(runScript([]).code).toBe(0);
    const clean = readFileSync(target("CLAUDE.md"), "utf8");

    for (const broken of [
      clean.replace(EXPECTED_LINE, EXPECTED_LINE.replace("30,530", "29,999")),
      clean.replace(`${START}\n\n${EXPECTED_LINE}\n\n${END}`, `${START}\n${EXPECTED_LINE}\n${END}`),
    ]) {
      writeFileSync(target("CLAUDE.md"), broken);
      expect(runScript(["--check"]).code).toBe(1);
      // `pnpm run sync:conformance` is what the failure message prescribes.
      expect(runScript([]).code).toBe(0);
      expect(runScript(["--check"]).code).toBe(0);
      expect(readFileSync(target("CLAUDE.md"), "utf8")).toBe(clean);
    }
  });
});

describe("#3947 — .prettierignore covers every markdown file `format:check` does not check", () => {
  it("ignores the ungated docs, CLAUDE.md included", async () => {
    // Every one of these was measured being silently rewritten by
    // `prettier --write` on 2026-08-01, and three of them with real content
    // damage (code-span re-delimiting in docs/ci-policy.md, list-continuation
    // de-indent in CLAUDE.md). `format:check` covers zero markdown, so
    // prettier has no authority over any of them.
    //
    // Ignoring CLAUDE.md does NOT make the sync-vs-prettier agreement
    // vacuous: it is asserted above via `prettier.format()`, the programmatic
    // API, which does not consult .prettierignore.
    for (const rel of ["docs/ci-policy.md", "README.md", "ROADMAP.md", "CLAUDE.md", "plan/goals/goal-graph.md"]) {
      const info = await prettier.getFileInfo(join(REPO_ROOT, rel), {
        ignorePath: join(REPO_ROOT, ".prettierignore"),
      });
      expect(info.ignored, `${rel} should be prettier-ignored`).toBe(true);
    }
  });

  it("still checks the TypeScript that `format:check` does cover", async () => {
    // Guards against the ignore rule being widened past markdown. If this
    // ever flips, `pnpm run format:check` silently stops checking anything.
    for (const rel of ["src/index.ts", "tests/issue-3947.test.ts", "scripts/sync-conformance-numbers.mjs"]) {
      const info = await prettier.getFileInfo(join(REPO_ROOT, rel), {
        ignorePath: join(REPO_ROOT, ".prettierignore"),
      });
      expect(info.ignored, `${rel} must stay prettier-checked`).toBe(false);
    }
  });
});
