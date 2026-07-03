import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseYaml, parseFrontmatter, updateFrontmatterScalar } from "../packages/symphony/lib/yaml.mjs";
import {
  loadWorkflow,
  loadMarkdownIssues,
  MarkdownTracker,
  compareIssues,
  renderTemplate,
} from "../packages/symphony/lib/workflow.mjs";
import {
  loadDispatchClaims,
  setDispatchClaim,
  activeDispatchClaim,
  releaseDispatchClaim,
  appendDispatchMessage,
  readMessagesSince,
  receiptOffsetFile,
} from "../packages/symphony/lib/dispatch-state.mjs";

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "symphony-test-"));
}

function writeIssue(dir: string, name: string, frontmatter: Record<string, string>, title = "Untitled") {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(path.join(dir, name), `---\n${fm}\n---\n# ${title}\n`);
}

describe("yaml.mjs", () => {
  it("parses nested maps, inline arrays, and scalars", () => {
    const parsed = parseYaml(
      [
        "tracker:",
        "  kind: markdown",
        "  active_states: [ready, in-progress]",
        "agent:",
        "  max_concurrent_agents: 8",
        "  paused: false",
      ].join("\n"),
    );
    expect(parsed.tracker.kind).toBe("markdown");
    expect(parsed.tracker.active_states).toEqual(["ready", "in-progress"]);
    expect(parsed.agent.max_concurrent_agents).toBe(8);
    expect(parsed.agent.paused).toBe(false);
  });

  it("parses a list of maps", () => {
    const parsed = parseYaml(
      ["lanes:", "  - name: a", "    kind: codex", "  - name: b", "    kind: generic"].join("\n"),
    );
    expect(parsed.lanes).toEqual([
      { name: "a", kind: "codex" },
      { name: "b", kind: "generic" },
    ]);
  });

  it("parses a block scalar", () => {
    const parsed = parseYaml(["hooks:", "  after_create: |", "    echo one", "    echo two"].join("\n"));
    expect(parsed.hooks.after_create).toBe("echo one\necho two");
  });

  it("round-trips frontmatter scalar updates without touching the body", () => {
    const text = "---\nid: 42\nstatus: ready\n---\n# Title\n\nBody text.\n";
    const updated = updateFrontmatterScalar(text, { status: "in-progress", claimed_by: "codex-lead" });
    const parsed = parseFrontmatter(updated);
    expect(parsed.data.status).toBe("in-progress");
    expect(parsed.data.claimed_by).toBe("codex-lead");
    expect(parsed.data.id).toBe(42);
    expect(parsed.body).toBe("# Title\n\nBody text.\n");
  });
});

describe("workflow.mjs: loadWorkflow", () => {
  it("splits front matter config from the prompt template body", () => {
    const root = tempRoot();
    const file = path.join(root, "WORKFLOW.md");
    writeFileSync(
      file,
      ["---", "tracker:", "  kind: markdown", "  issues_dir: plan/issues", "---", "", "Hello {{ issue.title }}"].join(
        "\n",
      ),
    );
    const workflow = loadWorkflow(file);
    expect(workflow.config.tracker.kind).toBe("markdown");
    expect(workflow.promptTemplate).toBe("Hello {{ issue.title }}");
  });
});

describe("workflow.mjs: loadMarkdownIssues + MarkdownTracker", () => {
  function setup() {
    const root = tempRoot();
    const issuesDir = path.join(root, "plan", "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeIssue(issuesDir, "1-ready.md", { id: "1", status: "ready", sprint: "5", priority: "high" }, "Ready one");
    writeIssue(
      issuesDir,
      "2-blocked.md",
      { id: "2", status: "ready", sprint: "5", priority: "high", depends_on: "1" },
      "Blocked on 1",
    );
    writeIssue(issuesDir, "3-done.md", { id: "3", status: "done", sprint: "5" }, "Already done");
    writeIssue(issuesDir, "4-otherSprint.md", { id: "4", status: "ready", sprint: "3" }, "Different sprint");
    const config = { tracker: { kind: "markdown", issues_dir: "plan/issues", sprint: "latest" } };
    return { root, config };
  }

  it("loads issues from frontmatter", () => {
    const { root, config } = setup();
    const issues = loadMarkdownIssues(config, root);
    expect(issues).toHaveLength(4);
    const one = issues.find((i) => i.id === "1");
    expect(one?.title).toBe("Ready one");
    expect(one?.state).toBe("ready");
  });

  it("fetchCandidateIssues filters to the latest non-terminal sprint, excludes blocked/done, and skips active claims", () => {
    const { root, config } = setup();
    const tracker = new MarkdownTracker(config, {}, root);
    const candidates = tracker.fetchCandidateIssues();
    // Sprint 5 has non-terminal issues (1, 2 ready), so it's picked over 6.
    expect(candidates.map((i) => i.id)).toEqual(["1"]);
  });

  it("fetchCandidateIssues excludes issues an external claim tracker reports as active", () => {
    const { root, config } = setup();
    const tracker = new MarkdownTracker(config, {}, root);
    const candidates = tracker.fetchCandidateIssues((id) => id === "1");
    expect(candidates).toHaveLength(0);
  });

  it("claimIssue flips status in the issue file and updates in-memory state", () => {
    const { root, config } = setup();
    const tracker = new MarkdownTracker(config, {}, root);
    const [issue] = tracker.fetchCandidateIssues();
    const result = tracker.claimIssue(issue, { name: "codex-developer" });
    expect(result?.changed).toBe(true);
    expect(issue.state).toBe("in-progress");
    const onDisk = parseFrontmatter(readFileSync(issue.file, "utf8")).data;
    expect(onDisk.status).toBe("in-progress");
    expect(onDisk.claimed_by).toBe("codex-developer");
  });
});

describe("workflow.mjs: compareIssues + renderTemplate", () => {
  it("sorts by priority rank, then created_at, then id", () => {
    const a = { priority: 2, created_at: "2026-01-01", identifier: "10" };
    const b = { priority: 1, created_at: "2026-01-02", identifier: "5" };
    const c = { priority: 2, created_at: "2026-01-01", identifier: "2" };
    expect([a, b, c].sort(compareIssues).map((i) => i.identifier)).toEqual(["5", "2", "10"]);
  });

  it("substitutes known variables and throws on unknown ones", () => {
    expect(renderTemplate("Issue {{ issue.id }}", { issue: { id: "7" } })).toBe("Issue 7");
    expect(() => renderTemplate("{{ nope }}", {})).toThrow(/unknown variable/);
  });
});

describe("dispatch-state.mjs", () => {
  it("round-trips a claim through set/load/active/release", () => {
    const root = tempRoot();
    expect(activeDispatchClaim(root, "9")).toBeNull();
    setDispatchClaim(root, "9", { owner: "claude-lead", status: "claimed" });
    expect(activeDispatchClaim(root, "9")?.owner).toBe("claude-lead");
    releaseDispatchClaim(root, "9", "handed off");
    expect(activeDispatchClaim(root, "9")).toBeNull();
    expect(loadDispatchClaims(root)["9"].status).toBe("released");
  });

  it("readMessagesSince returns only new messages and advances the offset when asked", () => {
    const root = tempRoot();
    appendDispatchMessage(root, { to: "claude-lead", body: "first" });
    const offsetFile = receiptOffsetFile(root, "claude-lead");
    const first = readMessagesSince(root, offsetFile, { advance: true, filter: (m) => m.to === "claude-lead" });
    expect(first).toHaveLength(1);
    expect(first[0].body).toBe("first");

    // Nothing new yet — offset already advanced past the one message.
    expect(readMessagesSince(root, offsetFile, { filter: (m) => m.to === "claude-lead" })).toHaveLength(0);

    appendDispatchMessage(root, { to: "claude-lead", body: "second" });
    appendDispatchMessage(root, { to: "someone-else", body: "not for us" });
    const second = readMessagesSince(root, offsetFile, { filter: (m) => m.to === "claude-lead" });
    expect(second).toHaveLength(1);
    expect(second[0].body).toBe("second");
  });
});
