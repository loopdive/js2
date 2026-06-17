import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "scripts", "reconcile-tasklist.mjs");

interface Fixture {
  dir: string;
  issuesDir: string;
  binDir: string;
}

function issue(id: string, status: string, title: string): string {
  return `---\nid: ${id}\ntitle: "${title}"\nstatus: ${status}\nsprint: 63\n---\n\n# #${id}\n`;
}

/** Write a fake `gh` on PATH that returns the given merged-PR JSON for `pr list`. */
function fakeGh(binDir: string, prTitles: string[]): void {
  const json = JSON.stringify(prTitles.map((t) => ({ title: t })));
  const script = `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
if (a.includes("pr list")) { process.stdout.write(${JSON.stringify(json)}); process.exit(0); }
process.exit(0);
`;
  writeFileSync(join(binDir, "gh"), script);
  chmodSync(join(binDir, "gh"), 0o755);
}

interface ReconcileJson {
  mergedPrCheckSkipped: boolean | string;
  mergedPrFixed: Array<{ id: string; issueStatus: string; prTitle: string; title: string }>;
  stale: unknown[];
}

function run(fx: Fixture): { stdout: string; json: ReconcileJson } {
  // --no-merged-prs is NOT passed; we want the gh-backed path. The team task
  // store is unlikely to exist in CI, but the merged-PR section runs regardless.
  const stdout = execFileSync("node", [SCRIPT, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      REPO_ROOT: fx.dir,
      PATH: `${fx.binDir}:${process.env.PATH}`,
      // Point the task store somewhere empty so the task section is a no-op.
      CLAUDE_HOME: join(fx.dir, "empty-claude-home"),
    },
  });
  // --json prints one JSON object; if no task store, the early-exit prints a
  // different shape, so guard.
  return { stdout, json: JSON.parse(stdout) };
}

describe("#2147 reconcile-tasklist flags ready issues fixed by a merged PR", () => {
  let fx: Fixture | undefined;

  afterEach(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
    fx = undefined;
  });

  function setup(issues: string[][], prTitles: string[]): Fixture {
    const dir = mkdtempSync(join(tmpdir(), "issue-2147-"));
    const issuesDir = join(dir, "plan", "issues");
    mkdirSync(issuesDir, { recursive: true });
    // Seed a non-empty task store so the script reaches the merged-PR section
    // (it early-exits when zero tasks are found).
    const taskDir = join(dir, "empty-claude-home", "tasks", "js2wasm");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "1.json"), JSON.stringify({ id: "1", status: "completed", subject: "noop" }));
    for (const [id, status, title] of issues) {
      writeFileSync(join(issuesDir, `${id}-slug.md`), issue(id, status, title));
    }
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    fakeGh(binDir, prTitles);
    fx = { dir, issuesDir, binDir };
    return fx;
  }

  it("flags a ready issue cited by a merged code PR", () => {
    const f = setup([["2002", "ready", "some bug"]], ["fix(#2002): correct the thing", "feat(#9999): unrelated"]);
    const { json } = run(f);
    expect(json.mergedPrCheckSkipped).toBe(false);
    expect(json.mergedPrFixed.map((x) => x.id)).toContain("2002");
  });

  it("does NOT flag an issue only mentioned by a plan/docs PR", () => {
    const f = setup(
      [["2003", "ready", "another bug"]],
      ["plan(s63): triage #2003 into the sprint", "docs: note #2003 in the changelog"],
    );
    const { json } = run(f);
    expect(json.mergedPrFixed.map((x) => x.id)).not.toContain("2003");
  });

  it("does NOT flag an issue already marked done", () => {
    const f = setup([["2004", "done", "fixed bug"]], ["fix(#2004): correct the other thing"]);
    const { json } = run(f);
    expect(json.mergedPrFixed.map((x) => x.id)).not.toContain("2004");
  });

  it("flags in-progress issues too, and reports skipped when --no-merged-prs", () => {
    const f = setup([["2005", "in-progress", "wip bug"]], ["fix(#2005): land it"]);
    const { json } = run(f);
    expect(json.mergedPrFixed.map((x) => x.id)).toContain("2005");

    // --no-merged-prs path
    const stdout = execFileSync("node", [SCRIPT, "--json", "--no-merged-prs"], {
      encoding: "utf8",
      env: { ...process.env, REPO_ROOT: f.dir, CLAUDE_HOME: join(f.dir, "empty-claude-home") },
    });
    const parsed = JSON.parse(stdout) as ReconcileJson;
    expect(parsed.mergedPrCheckSkipped).toBe("--no-merged-prs");
    expect(parsed.mergedPrFixed).toEqual([]);
  });
});
