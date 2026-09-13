import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const hook = join(root, ".claude/hooks/block-github-issue-create.py");
const scratch = mkdtempSync(join(tmpdir(), "js2-6448-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function inspect(toolName: string, toolInput: unknown) {
  return spawnSync("python3", [hook], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, GH_REPO: "loopdive/js2" },
  });
}

describe("local-only issue creation policy", () => {
  it.each([
    "gh issue create --title regression",
    "gh issue create -R loopdive/js2 --title regression",
    "gh -Rloopdive/js2wasm issue create --title regression",
    "gh --repo='https://github.com/loopdive/js2' issue create",
    "gh issue create --repo LOOPDIVE/JS2",
    "env GH_REPO=loopdive/js2wasm command gh issue create",
    "gh issue view 5807; gh issue create -R loopdive/js2",
    "echo allowed && /opt/homebrew/bin/gh issue create -R loopdive/js2",
    "gh issue \\\ncreate --repo loopdive/js2",
    "bash -lc 'gh issue create --repo loopdive/js2'",
    "gh api -X POST repos/loopdive/js2/issues -f title=regression",
    "gh api repos/loopdive/js2wasm/issues --raw-field title=regression",
    "gh api --method=POST /repos/loopdive/js2/issues",
    "gh api /repos/loopdive/js2/issues --input payload.json",
    'gh api graphql -f \'query=mutation {createIssue(input:{repositoryId:"opaque",title:"regression"}){issue{id}}}\'',
    "curl -XPOST https://api.github.com/repos/loopdive/js2/issues",
    "curl --json @payload.json https://api.github.com/repos/loopdive/js2wasm/issues",
    'curl --data \'{"query":"mutation {createIssue(input:{repositoryId: \\"opaque\\"}){issue{id}}}"}\' https://api.github.com/graphql',
  ])("denies a real creation command: %s", (command) => {
    const result = inspect("Bash", { command });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(result.stderr).toContain("plan/issues/");
  });

  it.each([
    "gh pr create --repo loopdive/js2 --title regression --body-file pr.md",
    "gh issue view 5807 --repo loopdive/js2 --comments",
    "gh issue close 5807 --repo loopdive/js2 --reason 'not planned' --comment 'Tracking migrated.'",
    "gh issue list --repo loopdive/js2wasm",
    "gh api repos/loopdive/js2/issues",
    "gh api repos/loopdive/js2/issues -X GET -f state=open",
    "gh api repos/loopdive/js2/issues/5807 -X PATCH -f state=closed",
    "gh api repos/loopdive/js2/issues/5807/comments -f body=migrated",
    "gh api repos/loopdive/js2/pulls -f title=regression",
    "gh issue create --repo unrelated/project --title regression",
    "GH_REPO=unrelated/project gh issue create",
    "gh api repos/unrelated/project/issues -f title=regression",
    "curl --get --data state=open https://api.github.com/repos/loopdive/js2/issues",
    "curl --data '{}' https://example.invalid/repos/loopdive/js2/issues",
    "printf '%s\\n' 'gh issue create --repo loopdive/js2'",
    "echo ';' gh issue create --repo loopdive/js2",
    "git commit -m 'Document gh issue create; keep PR creation available'",
    "cat <<'DOC' > documentation.md\ngh issue create --repo loopdive/js2\nDOC\ngh issue view 5807",
    "# gh issue create\ngh issue view 5807",
    'gh api graphql -f \'query={repository(owner:"loopdive",name:"js2"){issues(first:1){totalCount}}}\'',
  ])("allows an unrelated action or quoted documentation: %s", (command) => {
    const result = inspect("Bash", { command });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("inspects unified exec's cmd field and shell nesting", () => {
    expect(inspect("exec_command", { cmd: "zsh -c 'gh issue create'" }).status).toBe(2);
    expect(inspect("exec_command", { cmd: "gh issue view 5807" }).status).toBe(0);
  });

  it("does not interpret Edit/Write documentation as an invocation", () => {
    expect(inspect("Write", { content: "gh issue create", file_path: "README.md" }).status).toBe(0);
  });

  it("checks structured connector and GitHub MCP creation routes", () => {
    for (const data of [
      { repository_full_name: "loopdive/js2" },
      { repo_full_name: "loopdive/js2wasm" },
      { owner: "loopdive", repo: "js2" },
    ]) {
      expect(inspect("mcp__codex_apps__github_create_issue", data).status).toBe(2);
    }
    expect(inspect("mcp__github__issue_write", { method: "create", owner: "loopdive", repo: "js2" }).status).toBe(2);
    expect(inspect("mcp__github__issue_write", { method: "update", owner: "loopdive", repo: "js2" }).status).toBe(0);
    expect(inspect("mcp__github__create_issue", { owner: "another", repo: "project" }).status).toBe(0);
    expect(inspect("mcp__github__create_pull_request", { owner: "loopdive", repo: "js2" }).status).toBe(0);
    expect(inspect("mcp__github__get_issue", { owner: "loopdive", repo: "js2" }).status).toBe(0);
  });

  it("fails closed on missing creation targets and malformed hook input", () => {
    expect(inspect("mcp__github__create_issue", { title: "unknown repository" }).status).toBe(2);
    expect(inspect("Bash", { command: "gh issue create 'unterminated" }).status).toBe(2);
    expect(inspect("Bash", { command: ["gh", "issue", "create"] }).status).toBe(2);
    expect(inspect("mcp__github__create_issue", { repository: { name: "uninspectable" } }).status).toBe(2);
    const malformed = spawnSync("python3", [hook], { input: "{", encoding: "utf8" });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("could not inspect");
  });

  it.each([".claude/settings.json", ".codex/hooks.json"])(
    "runs the registered %s hook before a local gh stub",
    (config) => {
      const entries = JSON.parse(readFileSync(join(root, config), "utf8")).hooks.PreToolUse;
      const guards = entries.filter((entry: { hooks: { command: string }[] }) =>
        entry.hooks.some((handler) => handler.command.includes("block-github-issue-create.py")),
      );
      expect(guards).toHaveLength(1);
      const entry = guards[0];
      expect(new RegExp(entry.matcher).test("Bash")).toBe(true);
      expect(new RegExp(entry.matcher).test("mcp__codex_apps__github_create_issue")).toBe(true);
      const marker = join(scratch, config.includes("codex") ? "codex-marker" : "claude-marker");
      const stub = join(scratch, "gh");
      writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GUARD_TEST_MARKER"\n', { mode: 0o700 });
      const env = {
        ...process.env,
        GH_REPO: "loopdive/js2",
        PATH: `${scratch}:${process.env.PATH}`,
        GUARD_TEST_MARKER: marker,
      };
      for (const [command, denied] of [
        ["gh issue create", true],
        ["gh pr create", false],
      ] as const) {
        const result = spawnSync("/bin/sh", ["-c", entry.hooks[0].command], {
          cwd: root,
          env,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
          encoding: "utf8",
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(denied ? 2 : 0);
        // This models the documented hook protocol, not a live desktop invocation.
        if (result.status === 0) expect(spawnSync("/bin/sh", ["-c", command], { env }).status).toBe(0);
        expect(existsSync(marker)).toBe(!denied);
      }
      expect(readFileSync(marker, "utf8")).toBe("pr create\n");
    },
  );
});
