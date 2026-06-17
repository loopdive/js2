import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "scripts", "check-issue-spec-coverage.mjs");

function issueFile(fm: Record<string, string>, body = "body"): string {
  const lines = Object.entries(fm).map(([k, v]) => (k === "title" ? `${k}: "${v}"` : `${k}: ${v}`));
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

interface RunResult {
  code: number;
  json: { scope: string; failures: any[]; warnings: any[] };
}

describe("#2093 issue→probe coverage gate", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Build a fixture repo and run the gate in --all mode (diff-independent).
  function run(issues: Record<string, string>[], tests: string[] = []): RunResult {
    dir = mkdtempSync(join(tmpdir(), "issue-2093-"));
    const issuesDir = join(dir, "plan", "issues");
    const testsDir = join(dir, "tests");
    mkdirSync(issuesDir, { recursive: true });
    mkdirSync(testsDir, { recursive: true });
    for (const fm of issues) {
      writeFileSync(join(issuesDir, `${fm.id}-slug.md`), issueFile(fm));
    }
    for (const t of tests) writeFileSync(join(testsDir, t), "test\n");

    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [SCRIPT, "--all", "--json"], {
        encoding: "utf8",
        env: { ...process.env, REPO_ROOT: dir },
      });
    } catch (e: any) {
      code = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    return { code, json: JSON.parse(stdout) };
  }

  it("HARD FAILs a post-cutoff bug flipped to done with no probe", () => {
    const r = run([{ id: "3001", title: "bug", status: "done", created: "2026-06-16", task_type: "bug" }]);
    expect(r.code).toBe(1);
    expect(r.json.failures.map((f) => f.id)).toContain("3001");
  });

  it("passes a done bug that has a tests/issue-<id>.test.ts file", () => {
    const r = run(
      [{ id: "3002", title: "bug", status: "done", created: "2026-06-16", task_type: "bug" }],
      ["issue-3002.test.ts"],
    );
    expect(r.code).toBe(0);
    expect(r.json.failures).toEqual([]);
  });

  it("passes a done issue whose body cites a test262 repro path", () => {
    dir = mkdtempSync(join(tmpdir(), "issue-2093-"));
    const issuesDir = join(dir, "plan", "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      join(issuesDir, "3006-conf.md"),
      issueFile(
        { id: "3006", title: "conf", status: "done", created: "2026-06-16", task_type: "conformance" },
        "Repro: test262/test/built-ins/Foo/bar.js",
      ),
    );
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [SCRIPT, "--all", "--json"], {
        encoding: "utf8",
        env: { ...process.env, REPO_ROOT: dir },
      });
    } catch (e: any) {
      code = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    expect(code).toBe(0);
    expect(JSON.parse(stdout).failures).toEqual([]);
  });

  it("grandfathers pre-cutoff issues (no fail, no warn)", () => {
    const r = run([{ id: "3003", title: "old", status: "done", created: "2026-06-01", task_type: "bug" }]);
    expect(r.code).toBe(0);
    expect(r.json.failures).toEqual([]);
    expect(r.json.warnings).toEqual([]);
  });

  it("WARNs (does not fail) a ready issue with no probe", () => {
    const r = run([{ id: "3004", title: "ready", status: "ready", created: "2026-06-16", task_type: "bug" }]);
    expect(r.code).toBe(0);
    expect(r.json.warnings.map((w) => w.id)).toContain("3004");
    expect(r.json.failures).toEqual([]);
  });

  it("exempts non-behavioural task types (infra) even when done without a probe", () => {
    const r = run([{ id: "3005", title: "infra", status: "done", created: "2026-06-16", task_type: "infrastructure" }]);
    expect(r.code).toBe(0);
    expect(r.json.failures).toEqual([]);
  });
});
