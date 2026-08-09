// #3965 — `budget-status.mjs --pick` must not steer agents into work they
// cannot take, and must never drop a row silently.
//
// Every test drives the REAL scripts against a hermetic fixture: a local bare
// repo standing in for the orphan `issue-assignments` ref, plus a fixture repo
// whose `plan/issues/` holds synthetic issues. Nothing touches the network.
//
// The positive control runs in BOTH directions — a known-claimed issue must
// disappear WITH a printed reason, and must REAPPEAR once the claim is
// released. One direction alone does not prove a filter: a picker that returns
// nothing also "excludes" the claimed issue.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const BUDGET = resolve(__dirname, "..", "scripts", "budget-status.mjs");
const CLAIM = resolve(__dirname, "..", "scripts", "claim-issue.mjs");
const GIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

// Git environment variables MUST be scrubbed from every subprocess (see
// tests/issue-3880.test.ts): with GIT_DIR set, `git init --bare <path>`
// re-initialises $GIT_DIR instead, and with extensions.worktreeConfig that
// writes core.bare=true into the SHARED config and breaks every worktree.
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
];
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of LEAKY_GIT_ENV) delete env[k];
  return env;
}

function g(args: string[], cwd?: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
}

interface Issue {
  id: string;
  title?: string;
  priority?: string;
  horizon?: string;
  task_type?: string;
  model?: string;
  status?: string;
  sprint?: string;
}

interface Fixture {
  root: string;
  repo: string;
  assignGit: string;
  cache: string;
  home: string;
}

const ISSUES: Issue[] = [
  // Plain developer work, no lane pin — the control that must ALWAYS survive.
  { id: "9001", title: "Plain bugfix nobody has claimed", task_type: "bugfix" },
  // Claimed in the positive control.
  { id: "9002", title: "Second plain bugfix", task_type: "bugfix" },
  // Out of a developer's scope by task_type.
  { id: "9003", title: "Layered module map", task_type: "architecture" },
  // Pinned to the other lane.
  { id: "9004", title: "Standalone Symbol carrier", task_type: "feature", model: "fable" },
  // Out of scope by title role-tag.
  { id: "9005", title: "[EPIC][ARCH] Value-rep substrate", task_type: "feature" },
];

function writeIssue(dir: string, i: Issue) {
  const fm = [
    "---",
    `id: ${i.id}`,
    `title: "${i.title ?? `Issue ${i.id}`}"`,
    `status: ${i.status ?? "ready"}`,
    `sprint: ${i.sprint ?? "current"}`,
    `priority: ${i.priority ?? "high"}`,
    `horizon: ${i.horizon ?? "xl"}`,
    ...(i.task_type ? [`task_type: ${i.task_type}`] : []),
    ...(i.model ? [`model: ${i.model}`] : []),
    "---",
    "",
    `# ${i.id}`,
    "",
  ].join("\n");
  writeFileSync(join(dir, `${i.id}-slug.md`), fm);
}

function makeFixture(issues: Issue[] = ISSUES): Fixture {
  const root = mkdtempSync(join(tmpdir(), "budget3965-"));
  const repo = join(root, "repo");
  const assignGit = join(root, "assign.git");
  const cache = join(root, "cache.git");
  const home = join(root, "home");

  g(["init", "--bare", "--quiet", "--initial-branch=main", assignGit]);
  mkdirSync(join(home, "tasks"), { recursive: true });

  const issuesDir = join(repo, "plan", "issues");
  mkdirSync(issuesDir, { recursive: true });
  for (const i of issues) writeIssue(issuesDir, i);

  // claim-issue.mjs probes the working repo for a main remote at load time.
  g(["init", "--quiet", "--initial-branch=main", repo]);
  g(["add", "-A"], repo);
  g([...GIT_ID, "commit", "--quiet", "-m", "seed"], repo);

  return { root, repo, assignGit, cache, home };
}

function envFor(fx: Fixture, extra: Record<string, string> = {}, assignRemote?: string) {
  return cleanEnv({
    CLAIM_ASSIGN_REMOTE: assignRemote ?? fx.assignGit,
    CLAIM_CACHE_DIR: fx.cache,
    CLAIM_NET_RETRIES: "1",
    CLAIM_NET_TIMEOUT_MS: "20000",
    // Deterministic budget: a fresh window with one agent admits every horizon,
    // so horizon never confounds a claim/scope assertion.
    JS2WASM_BUDGET_REMAINING_PCT: "100",
    JS2WASM_PARALLELISM: "1",
    CLAUDE_HOME: fx.home,
    REPO_ROOT: fx.repo,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  all: string;
}

function runBudget(fx: Fixture, args: string[], extra: Record<string, string> = {}, assignRemote?: string): RunResult {
  const r = spawnSync(process.execPath, [BUDGET, ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    env: envFor(fx, extra, assignRemote),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  return { code: r.status ?? -1, stdout, stderr, all: stdout + stderr };
}

function runClaim(fx: Fixture, args: string[]): RunResult {
  const r = spawnSync(process.execPath, [CLAIM, ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    env: envFor(fx),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  return { code: r.status ?? -1, stdout, stderr, all: stdout + stderr };
}

/**
 * Ids in the "best-fit claimable tasks" block — the actual recommendation.
 *
 * The parser must fail LOUDLY rather than return `[]`, for exactly the reason
 * the script under test must not `catch { return [] }`: a formatting change to
 * the pick line would otherwise turn every `not.toContain(...)` assertion —
 * and the `[UNVERIFIED]` loop, which iterates the same shape — green and empty
 * instead of red. The revert-sabotage below exercises the FILTERS, not this
 * parser, so nothing else would catch it.
 */
function pickedIds(out: string): string[] {
  const start = out.indexOf("best-fit claimable tasks");
  if (start < 0) throw new Error(`pickedIds: no "best-fit claimable tasks" block in output:\n${out}`);
  const block = out.slice(start);
  const ids = [...block.matchAll(/^ {4}#(\d+[a-z]?)\s/gim)].map((m) => m[1]);
  // An empty result is only legitimate when the script SAID it returned none.
  if (!ids.length && !/\(none returned/.test(block)) {
    throw new Error(`pickedIds: matched no rows and no "(none returned" line — the output shape changed:\n${block}`);
  }
  return ids;
}

/** Pick rows, as raw lines — same shape guarantee as pickedIds. */
function pickLines(out: string): string[] {
  const lines = out.split("\n").filter((l) => /^ {4}#\d/.test(l));
  if (!lines.length) throw new Error(`pickLines: no pick rows matched — the output shape changed:\n${out}`);
  return lines;
}

const DEV = ["--pick", "--role", "developer", "--model", "opus"];

describe("#3965 budget-status --pick must not recommend unclaimable work", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  // ── positive control, BOTH directions ───────────────────────────────────
  it("excludes a claimed issue, prints the reason, and restores it when released", () => {
    // Direction 0 — baseline. Without this the exclusion below proves nothing:
    // a picker that returns nothing at all would also "exclude" #9002.
    const before = runBudget(fx, DEV);
    expect(before.code).toBe(0);
    expect(pickedIds(before.stdout)).toEqual(expect.arrayContaining(["9001", "9002"]));
    expect(before.stdout).not.toMatch(/skipped #9002/);

    // Direction 1 — claimed ⇒ excluded, WITH a printed reason naming the holder.
    const claim = runClaim(fx, ["9002", "ttraenkler/dev-x", "--branch", "issue-9002-x"]);
    expect(claim.code).toBe(0);

    const held = runBudget(fx, DEV);
    expect(held.code).toBe(0);
    expect(pickedIds(held.stdout)).not.toContain("9002");
    // Not merely absent — explained. A silent drop is the defect under test.
    expect(held.stdout).toMatch(/skipped #9002: claimed by ttraenkler\/dev-x since \d{4}-\d{2}-\d{2}T/);
    expect(held.stdout).toContain("issue-9002-x");
    // The unclaimed control is untouched, so the filter is selective, not blanket.
    expect(pickedIds(held.stdout)).toContain("9001");

    // Direction 2 — released ⇒ it comes back, and stops being reported skipped.
    const rel = runClaim(fx, ["--release", "9002", "ttraenkler/dev-x"]);
    expect(rel.code).toBe(0);

    const after = runBudget(fx, DEV);
    expect(after.code).toBe(0);
    expect(pickedIds(after.stdout)).toContain("9002");
    expect(after.stdout).not.toMatch(/skipped #9002/);
  });

  it("does not treat the requesting agent's OWN claim as a blocker", () => {
    expect(runClaim(fx, ["9002", "ttraenkler/dev-me", "--branch", "b"]).code).toBe(0);

    const other = runBudget(fx, [...DEV, "--as", "ttraenkler/dev-other"]);
    expect(pickedIds(other.stdout)).not.toContain("9002");

    const mine = runBudget(fx, [...DEV, "--as", "ttraenkler/dev-me"]);
    expect(pickedIds(mine.stdout)).toContain("9002");
    expect(mine.stdout).toMatch(/your own claim/);
  });

  // ── an unreadable ref is NOT an empty one ───────────────────────────────
  it("refuses to present picks as filtered when the claim ref cannot be read", () => {
    const r = runBudget(fx, DEV, {}, "/nonexistent-claim-remote-3965.git");

    // Loud: non-zero exit, so a scripted caller cannot mistake this for a
    // filtered list. This is the defect relocated one layer up if it passes.
    expect(r.code).toBe(6);
    expect(r.stdout).toMatch(/claim ref\s*:\s*UNREADABLE/);
    expect(r.stderr).toMatch(/budget-status: FAILED/);
    expect(r.stderr).toMatch(/UNFILTERED/);
    // Rows still print (an agent may need them) but each is stamped. pickLines
    // throws rather than yielding an empty loop, so this cannot pass vacuously.
    const rows = pickLines(r.stdout);
    expect(rows.length).toBeGreaterThan(0);
    for (const line of rows) expect(line).toContain("[UNVERIFIED]");
    // And the machine shape says so too — a consumer reading `picks` without
    // provenance would be back to trusting an unverified list.
    const j = runBudget(fx, ["--json", "--role", "developer"], {}, "/nonexistent-claim-remote-3965.git");
    expect(j.code).toBe(6);
    const parsed = JSON.parse(j.stdout);
    expect(parsed.claim_ref.state).toBe("unreadable");
    expect(parsed.filters_applied.claim).toBe(false);
    expect(parsed.picks_unverified).toBe(true);
  });

  it("--no-claim-check is an explicit, recorded opt-out rather than a silent one", () => {
    const r = runBudget(fx, [...DEV, "--no-claim-check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/claim ref\s*:\s*NOT READ \(--no-claim-check\)/);
    expect(r.stderr).toMatch(/UNVERIFIED/);
  });

  // ── scope / lane, each with its own printed reason ──────────────────────
  it("prints a distinct reason for task_type, lane and title-tag exclusions", () => {
    const r = runBudget(fx, DEV);
    expect(r.stdout).toMatch(/skipped #9003: task_type: architecture — not claimable by role developer/);
    expect(r.stdout).toMatch(/skipped #9004: model: fable — pinned to another lane \(you are opus\)/);
    expect(r.stdout).toMatch(/skipped #9005: title carries \[ARCH\] — out of scope for role developer/);
    expect(pickedIds(r.stdout)).toEqual(expect.arrayContaining(["9001", "9002"]));
    expect(pickedIds(r.stdout)).not.toContain("9003");
    expect(pickedIds(r.stdout)).not.toContain("9004");
    expect(pickedIds(r.stdout)).not.toContain("9005");
  });

  it("announces that the lane filter is OFF when no --model is given, and keeps the row", () => {
    const r = runBudget(fx, ["--pick", "--role", "developer"]);
    expect(r.stdout).toMatch(/model=OFF/);
    expect(pickedIds(r.stdout)).toContain("9004"); // not dropped by a filter that was not applied
    expect(r.stdout).not.toMatch(/skipped #9004: model:/);
  });

  it("keeps a fable-pinned issue for a fable agent and drops the opus-only view of it", () => {
    const fable = runBudget(fx, ["--pick", "--role", "developer", "--model", "fable"]);
    expect(pickedIds(fable.stdout)).toContain("9004");
    // Unpinned work stays claimable by either lane (exact-match-OR-UNSET).
    expect(pickedIds(fable.stdout)).toContain("9001");
  });

  it("normalises a self-reported model name like 'Opus 5' to the frontmatter vocabulary", () => {
    const r = runBudget(fx, ["--pick", "--role", "developer", "--model", "Opus 5"]);
    expect(r.stdout).toMatch(/model=opus/);
    expect(r.stdout).toMatch(/skipped #9004: model: fable/);
  });

  // ── floor the count ─────────────────────────────────────────────────────
  it("distinguishes zero-returned from zero-considered", () => {
    // Zero returned, non-zero considered: everything is claimed or out of lane.
    for (const id of ["9001", "9002"]) {
      expect(runClaim(fx, [id, "ttraenkler/dev-x", "--branch", `b-${id}`]).code).toBe(0);
    }
    const none = runBudget(fx, DEV);
    expect(pickedIds(none.stdout)).toEqual([]);
    expect(none.stdout).toMatch(/considered 5/);
    expect(none.stdout).toMatch(/The queue is NOT empty/);
    expect(none.stdout).not.toMatch(/The queue itself is EMPTY/);

    // Zero considered: the queue really is empty. Same "no picks", different cause.
    const empty = makeFixture([{ id: "9100", title: "Backlogged", sprint: "Backlog" }]);
    try {
      const r = runBudget(empty, DEV);
      expect(pickedIds(r.stdout)).toEqual([]);
      expect(r.stdout).toMatch(/considered 0/);
      expect(r.stdout).toMatch(/The queue itself is EMPTY/);
    } finally {
      rmSync(empty.root, { recursive: true, force: true });
    }
  });

  it("reports the full funnel and discloses truncation", () => {
    const r = runBudget(fx, [...DEV, "--limit", "1"]);
    expect(r.stdout).toMatch(
      /funnel\s*:\s*scanned 5 issue files → considered 5 .* → horizon-fit 5 → after claim 5 → after scope 2 → returned 1/,
    );
    expect(r.stdout).toMatch(/\+1 more not shown/);
    expect(pickedIds(r.stdout)).toHaveLength(1);
  });

  it("carries funnel, skip reasons and claim provenance in --json", () => {
    expect(runClaim(fx, ["9002", "ttraenkler/dev-x", "--branch", "b"]).code).toBe(0);
    const r = runBudget(fx, ["--json", "--role", "developer", "--model", "opus"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.claim_ref.state).toBe("ok");
    expect(j.claim_ref.held_count).toBe(1);
    expect(j.filters_applied).toMatchObject({ claim: true, role: "developer", model: "opus" });
    expect(j.picks_unverified).toBe(false);
    expect(j.funnel).toMatchObject({ considered: 5, horizon_fit: 5, after_claim_filter: 4, after_scope_filter: 1 });
    expect(j.skipped.map((s: any) => s.id).sort()).toEqual(["9002", "9003", "9004", "9005"]);
    expect(j.skipped.find((s: any) => s.id === "9002")).toMatchObject({ stage: "claim" });
    expect(j.skipped.find((s: any) => s.id === "9004")).toMatchObject({ stage: "lane" });
    expect(j.picks.map((p: any) => p.id)).toEqual(["9001"]);
  });

  it("announces that role was ASSUMED when --role is not given", () => {
    // --model absent is self-announcing; --role has a default, so its absence
    // would otherwise apply developer scope silently to (say) an architect that
    // passed only --as, with exclusions printed against a role it never claimed.
    const assumed = runBudget(fx, ["--pick", "--as", "ttraenkler/arch-1"]);
    expect(assumed.stdout).toMatch(/role=developer \(DEFAULT — no --role/);
    const asked = runBudget(fx, ["--pick", "--role", "developer"]);
    expect(asked.stdout).toMatch(/role=developer(?!\s*\(DEFAULT)/);

    const j = JSON.parse(runBudget(fx, ["--json"]).stdout);
    expect(j.filters_applied.role_defaulted).toBe(true);
    const j2 = JSON.parse(runBudget(fx, ["--json", "--role", "architect"]).stdout);
    expect(j2.filters_applied).toMatchObject({ role: "architect", role_defaulted: false });
  });

  it("a non-developer role sees the work a developer is filtered out of", () => {
    const arch = runBudget(fx, ["--pick", "--role", "architect", "--model", "opus"]);
    // #9003 (task_type: architecture) and #9005 ([ARCH] title) are the
    // developer's exclusions; for an architect they are the job.
    expect(pickedIds(arch.stdout)).toEqual(expect.arrayContaining(["9003", "9005"]));
    expect(arch.stdout).not.toMatch(/skipped #9003/);
  });

  it("leaves the no-pick invocations alone (no claim read, exit 0)", () => {
    // The statusline calls --quiet on every render; it must not pay for, or fail
    // on, a network read it never asked for.
    const q = runBudget(fx, ["--quiet"], {}, "/nonexistent-claim-remote-3965.git");
    expect(q.code).toBe(0);
    expect(q.stdout).toMatch(/pull ≤ XL/);
  });
});

describe("#3965 claim-issue.mjs --list --json", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("reports an absent ref as absent, not as an error and not as claims", () => {
    const r = runClaim(fx, ["--list", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ref_read).toBe("absent");
    expect(j.held).toEqual([]);
  });

  it("emits held records with the fields the picker needs", () => {
    expect(runClaim(fx, ["9002", "ttraenkler/dev-x", "--branch", "bx"]).code).toBe(0);
    const r = runClaim(fx, ["--list", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ref_read).toBe("ok");
    expect(j.held_count).toBe(1);
    expect(j.held[0]).toMatchObject({
      id: "9002",
      assignee: "ttraenkler/dev-x",
      status: "in-progress",
      branch: "bx",
    });
    expect(j.held[0].claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("exits non-zero rather than reporting an unreadable ref as zero claims", () => {
    const r = spawnSync(process.execPath, [CLAIM, "--list", "--json"], {
      cwd: fx.repo,
      encoding: "utf8",
      env: envFor(fx, {}, "/nonexistent-claim-remote-3965.git"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout || "").not.toMatch(/"held_count": 0/);
  });
});
