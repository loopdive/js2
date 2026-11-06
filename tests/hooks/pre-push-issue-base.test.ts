// Exercise the exact committed-issue selection and id check from the hook.
// Other pre-push phases are deliberately not executed by these Git/shell tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = readFileSync(resolve(__dirname, "../../.husky/pre-push"), "utf8");
const start = hook.indexOf("  # (5a)");
const end = hook.indexOf("  # (5b)", start);
if (start < 0 || end <= start) throw new Error("Cannot locate the real committed issue check");
const check = `issue_block=0\n${hook.slice(start, end)}\nprintf 'BASE=%s\\n' "$range_base"\nprintf '%s\\n' "$changed_issues" > "$SELECTED_FILE"\nexit "$issue_block"\n`;

function env(): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const key of Object.keys(result)) if (key.startsWith("GIT_")) delete result[key];
  return {
    ...result,
    GIT_AUTHOR_NAME: "Thomas Tränkler",
    GIT_AUTHOR_EMAIL: "git@thomas.traenkler.com",
    GIT_COMMITTER_NAME: "Thomas Tränkler",
    GIT_COMMITTER_EMAIL: "git@thomas.traenkler.com",
  };
}

describe("pre-push committed issue integrity base", () => {
  let repo: string;
  let origin: string;
  let canonical: string;
  const baseFiles = { "plan/issues/100-base.md": "id: 100\n" };
  const canonicalFiles = { ...baseFiles, "plan/issues/101-inherited.md": "id: 101\n" };

  function git(args: string[], input?: string): string {
    return execFileSync("git", args, { cwd: repo, env: env(), encoding: "utf8", input }).trim();
  }

  // Build synthetic commit objects without running or disabling product hooks.
  function commit(files: Record<string, string>, parent?: string): string {
    git(["read-tree", "--empty"]);
    for (const [path, text] of Object.entries(files)) {
      const blob = git(["hash-object", "-w", "--stdin"], text);
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = git(["write-tree"]);
    return git(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], "Synthetic issue-base control\n");
  }

  function ref(name: string, value: string): void {
    git(["update-ref", name, value]);
  }

  function run(head: string): { status: number | null; output: string; selected: string[] } {
    ref("refs/heads/codex/issue-base-control", head);
    const selected = join(repo, "selected");
    const result = spawnSync("/bin/sh", ["-c", check], {
      cwd: repo,
      env: { ...env(), SELECTED_FILE: selected },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      selected: readFileSync(selected, "utf8").split("\n").filter(Boolean),
    };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "prepush-issue-base-"));
    git(["init", "-q", "--initial-branch=codex/issue-base-control"]);
    origin = commit(baseFiles);
    canonical = commit(canonicalFiles, origin);
    ref("refs/remotes/origin/main", origin);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("prefers canonical upstream and does not rescan inherited fork-lag issues", () => {
    ref("refs/remotes/upstream/main", canonical);
    const head = commit(canonicalFiles, canonical);
    expect(git(["diff", "--name-only", `${origin}..${head}`, "--", "plan/issues/*.md"])).toBe(
      "plan/issues/101-inherited.md",
    );
    const result = run(head);
    expect(result.status).toBe(0);
    expect(result.selected).toEqual([]);
    expect(result.output).toContain(`BASE=${canonical}\n`);
  });

  it("uses origin when upstream is absent", () => {
    ref("refs/remotes/origin/main", canonical);
    const result = run(commit({ ...canonicalFiles, "plan/issues/102-authored.md": "id: 102\n" }, canonical));
    expect(result.status).toBe(0);
    expect(result.selected).toEqual(["plan/issues/102-authored.md"]);
    expect(result.output).toContain(`BASE=${canonical}\n`);
  });

  it("retains HEAD~5 selection when both base refs are absent", () => {
    git(["update-ref", "-d", "refs/remotes/origin/main"]);
    let head = canonical;
    for (let i = 0; i < 5; i++) head = commit({ ...canonicalFiles, "plan/issues/102-authored.md": "id: 102\n" }, head);
    const result = run(head);
    expect(result.status).toBe(0);
    expect(result.selected).toEqual(["plan/issues/102-authored.md"]);
    expect(result.output).toContain("BASE=\n");
  });

  it("still checks a genuine changed issue against canonical main", () => {
    ref("refs/remotes/upstream/main", canonical);
    const result = run(commit({ ...canonicalFiles, "plan/issues/102-authored.md": "id: 102\n" }, canonical));
    expect(result.status).toBe(0);
    expect(result.selected).toEqual(["plan/issues/102-authored.md"]);
  });

  it("rejects a committed id mismatch even when its working-tree id is corrected", () => {
    ref("refs/remotes/upstream/main", canonical);
    mkdirSync(join(repo, "plan/issues"), { recursive: true });
    writeFileSync(join(repo, "plan/issues/102-authored.md"), "id: 102\n");
    const result = run(commit({ ...canonicalFiles, "plan/issues/102-authored.md": "id: 999\n" }, canonical));
    expect(result.status).toBe(1);
    expect(result.selected).toEqual(["plan/issues/102-authored.md"]);
    expect(result.output).toContain("COMMITTED frontmatter id=999 != filename prefix=102");
  });

  it("falls back to origin when upstream has no common ancestor", () => {
    ref("refs/remotes/upstream/main", commit({ "README.md": "unrelated\n" }));
    ref("refs/remotes/origin/main", canonical);
    const result = run(commit({ ...canonicalFiles, "plan/issues/102-authored.md": "id: 102\n" }, canonical));
    expect(result.status).toBe(0);
    expect(result.selected).toEqual(["plan/issues/102-authored.md"]);
    expect(result.output).toContain(`BASE=${canonical}\n`);
  });

  it("retains deleted issue skipping", () => {
    ref("refs/remotes/upstream/main", canonical);
    const result = run(commit(baseFiles, canonical));
    expect(result.status).toBe(0);
    expect(result.selected).toEqual(["plan/issues/101-inherited.md"]);
    expect(result.output).not.toContain("PRE-PUSH BLOCKED");
  });
});
