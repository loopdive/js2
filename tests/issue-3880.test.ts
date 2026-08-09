// #3880 — claim-issue.mjs must never report a failed operation as success, nor
// a successful one as failure.
//
// Every test here drives the REAL script against a hermetic fixture: two local
// bare repos (one standing in for `main`, one for the orphan
// `issue-assignments` ref) plus a working clone. Nothing touches the network.
//
// The assertions deliberately check the EFFECT — the bytes on the assignment
// ref — not just stdout/exit codes, because "trusting the exit code instead of
// reading the record back" is the bug under test.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { isHeldRecord } from "../scripts/lib/claim-record.mjs";

const SCRIPT = resolve(__dirname, "..", "scripts", "claim-issue.mjs");
const GIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

interface Fixture {
  root: string;
  mainGit: string;
  assignGit: string;
  work: string;
  cache: string;
}

// Git environment variables MUST be scrubbed from every subprocess here.
// The husky pre-commit hook runs the changed-root tests with GIT_DIR and
// GIT_INDEX_FILE exported, and with GIT_DIR set `git init --bare <path>` does
// not initialise <path> at all — it re-initialises $GIT_DIR and writes
// core.bare=true into it. Because this repo sets extensions.worktreeConfig,
// that lands in the SHARED config and breaks every worktree with
// "fatal: this operation must be run in a work tree". Observed for real while
// developing this suite; the fixture is worthless if it can reach outside
// itself.
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

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "claim3880-"));
  const mainGit = join(root, "main.git");
  const assignGit = join(root, "assign.git");
  const work = join(root, "work");
  const cache = join(root, "cache.git");
  const seed = join(root, "seed");

  g(["init", "--bare", "--quiet", "--initial-branch=main", mainGit]);
  g(["init", "--bare", "--quiet", "--initial-branch=main", assignGit]);

  g(["init", "--quiet", "--initial-branch=main", seed]);
  mkdirSync(join(seed, "plan", "issues"), { recursive: true });
  for (const [id, slug] of [
    ["3000", "alpha"],
    ["3001", "beta"],
  ]) {
    writeFileSync(join(seed, "plan", "issues", `${id}-${slug}.md`), `---\nid: ${id}\nstatus: ready\n---\n\n# ${id}\n`);
  }
  g(["add", "-A"], seed);
  g([...GIT_ID, "commit", "--quiet", "-m", "seed"], seed);
  g(["remote", "add", "origin", mainGit], seed);
  g(["push", "--quiet", "origin", "main"], seed);

  g(["clone", "--quiet", mainGit, work]);
  return { root, mainGit, assignGit, work, cache };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function envFor(fx: Fixture, extra: Record<string, string> = {}, assignRemote?: string) {
  return cleanEnv({
    CLAIM_ASSIGN_REMOTE: assignRemote ?? fx.assignGit,
    CLAIM_REMOTE: "origin",
    CLAIM_CACHE_DIR: fx.cache,
    // Keep the failure paths quick: the retry loops are about contention, and
    // this suite has no real network to wait on.
    CLAIM_NET_RETRIES: "2",
    CLAIM_NET_TIMEOUT_MS: "20000",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  });
}

// spawnSync, not execFileSync: execFileSync returns only stdout on success, and
// these assertions need stderr on the SUCCESS paths too (the `claim-issue: OK`
// marker and the pr_scan warning both go to stderr).
function run(fx: Fixture, args: string[], extra: Record<string, string> = {}, assignRemote?: string): RunResult {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fx.work,
    encoding: "utf8",
    env: envFor(fx, extra, assignRemote),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function runAsync(fx: Fixture, args: string[], extra: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { cwd: fx.work, encoding: "utf8", env: envFor(fx, extra) },
      (err: any, stdout: string, stderr: string) => res({ code: err ? (err.code ?? -1) : 0, stdout, stderr }),
    );
  });
}

/** Read an entry straight off the assignment ref — the source of truth. */
function readRecord(fx: Fixture, key: string): any | null {
  try {
    const raw = g(["cat-file", "-p", `refs/heads/issue-assignments:${key}.json`], fx.assignGit);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listRecords(fx: Fixture): string[] {
  try {
    return g(["ls-tree", "--name-only", "refs/heads/issue-assignments"], fx.assignGit)
      .split("\n")
      .filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

function lastLine(s: string): string {
  const lines = s.trim().split("\n");
  return lines[lines.length - 1] || "";
}

const UNREACHABLE = "/nonexistent-claim-remote-3880.git";

describe("#3880 claim-issue.mjs — a failed operation must never look like success", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("holds a claim that a broken --release must not silently drop", () => {
    const claim = run(fx, ["3000", "alice", "--branch", "b1"]);
    expect(claim.code).toBe(0);
    expect(readRecord(fx, "3000")).toMatchObject({ assignee: "alice", status: "in-progress", branch: "b1" });

    // THE BUG: with the ref unreadable, the old code printed
    // "not currently claimed — nothing to release" and exited 0, leaving the
    // lock in place (this is how #3661/#3685 were left falsely claimed).
    const rel = run(fx, ["--release", "3000", "alice"], {}, UNREACHABLE);
    expect(rel.code).not.toBe(0);
    expect(rel.stdout).not.toMatch(/nothing to release/i);
    expect(rel.stderr).toMatch(/cannot READ the assignment ref/);
    expect(lastLine(rel.stderr)).toMatch(/^claim-issue: FAILED —/);

    // The effect that matters: the claim is untouched, so nobody was misled.
    expect(readRecord(fx, "3000")).toMatchObject({ assignee: "alice", status: "in-progress" });

    // ...and a working release really does clear it.
    const ok = run(fx, ["--release", "3000", "alice"]);
    expect(ok.code).toBe(0);
    expect(readRecord(fx, "3000")).toMatchObject({ status: "released" });
  });

  it("never reports a held issue as UNASSIGNED when the read failed", () => {
    expect(run(fx, ["3001", "bob"]).code).toBe(0);

    // THE BUG, and the sharpest one: a failed read printing "is UNASSIGNED" and
    // exiting 0 is exactly how two agents get dispatched onto one issue — the
    // duplicate dispatch this lock exists to prevent.
    const check = run(fx, ["--check", "3001"], {}, UNREACHABLE);
    expect(check.code).not.toBe(0);
    expect(check.stdout).not.toMatch(/UNASSIGNED/);
    expect(lastLine(check.stderr)).toMatch(/^claim-issue: FAILED —/);

    // A working read still answers correctly in both directions.
    const held = run(fx, ["--check", "3001"]);
    expect(held.code).toBe(3);
    expect(held.stdout).toMatch(/is CLAIMED by bob/);
    const free = run(fx, ["--check", "3002"]);
    expect(free.code).toBe(0);
    expect(free.stdout).toMatch(/is UNASSIGNED/);
  });

  it("distinguishes an absent ref from an unreadable one", () => {
    // Genuinely empty ref -> "no assignments" is the TRUE answer, exit 0.
    const empty = run(fx, ["--list"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/No assignments yet/);

    // Unreadable ref -> must NOT collapse to the same answer.
    const broken = run(fx, ["--list"], {}, UNREACHABLE);
    expect(broken.code).not.toBe(0);
    expect(broken.stdout).not.toMatch(/No assignments yet/);
  });
});

describe("#3880 claim-issue.mjs — a successful operation must never look like failure", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("recovers when the push lands but git reports failure", () => {
    // Two ids were permanently burned on 2026-07-31 by re-allocating after an
    // "apparent" failure whose reservation had in fact been written.
    const r = run(fx, ["3000", "carol", "--branch", "b9"], { CLAIM_TEST_FAULT: "push-reports-failure" });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/reported failure .* but the record verifies as written/);
    expect(lastLine(r.stderr)).toMatch(/^claim-issue: OK —/);
    expect(readRecord(fx, "3000")).toMatchObject({ assignee: "carol", status: "in-progress", branch: "b9" });
    // Exactly one entry — the recovery must not have written a second time.
    expect(listRecords(fx)).toEqual(["3000.json"]);
  });

  it("reports UNKNOWN (exit 7) rather than guessing when the effect cannot be verified", () => {
    const r = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned"], {
      CLAIM_TEST_FAULT: "verify-unreachable",
    });
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/UNKNOWN OUTCOME/);
    expect(r.stderr).toMatch(/Do NOT blindly retry/);
    expect(lastLine(r.stderr)).toMatch(/^claim-issue: FAILED —/);
    // It is reported as unknown precisely because it DID land: the honest
    // answer is "re-read the record", not "it failed".
    expect(listRecords(fx)).toEqual(["3002.json"]);
  });
});

describe("#3880 claim-issue.mjs — concurrency", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("hands six concurrent allocators six distinct ids", async () => {
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () => runAsync(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned"])),
    );
    for (const r of results) {
      expect(r.code, `allocate failed: ${r.stderr}`).toBe(0);
    }
    const ids = results.map((r) => r.stdout.trim());
    expect(new Set(ids).size).toBe(N);
    // Assert on the REF, not on stdout: N reservations must actually exist.
    expect(listRecords(fx).sort()).toEqual(ids.map((i) => `${i}.json`).sort());
    for (const id of ids) expect(readRecord(fx, id)).toMatchObject({ status: "reserved" });
  }, 60000);
});

describe("#3880 claim-issue.mjs — an unscanned id is never handed out as clean", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("refuses to allocate when the MAIN id scan fails, rather than treating it as empty", () => {
    // The most dangerous silent-empty in the allocator: with main contributing
    // nothing, max+1 is computed from open PRs ∪ reservations alone and hands
    // out a long-taken id. A failed read is not an empty one.
    const r = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned"], { CLAIM_REMOTE: "no-such-remote" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/cannot READ .* to scan existing issue ids|found NONE/);
    expect(lastLine(r.stderr)).toMatch(/^claim-issue: FAILED —/);
    expect(r.stdout.trim()).toBe("");
    expect(listRecords(fx)).toEqual([]); // nothing burned
  });

  it("refuses --no-pr-scan before reserving, so no id is burned", () => {
    const r = run(fx, ["--allocate", "--no-pr-scan"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--allow-unscanned/);
    expect(lastLine(r.stderr)).toMatch(/^claim-issue: FAILED —/);
    // The critical half: refusing must cost nothing.
    expect(listRecords(fx)).toEqual([]);
    expect(r.stdout.trim()).toBe("");
  });

  it("still allows an explicit opt-in, and marks the record and the output", () => {
    const r = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned"]);
    expect(r.code).toBe(0);
    const id = r.stdout.trim();
    expect(readRecord(fx, id)).toMatchObject({ pr_scan: "off" });
    expect(r.stderr).toMatch(/WARNING: #\d+ was reserved with pr_scan="off"/);
  });

  it("previews with --dry-run without reserving or demanding the opt-in", () => {
    const r = run(fx, ["--allocate", "--dry-run", "--no-pr-scan"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("3002");
    expect(listRecords(fx)).toEqual([]);
  });
});

describe("#3880 claim-issue.mjs — reservations are attributable", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("never writes an anonymous reservation", () => {
    // Bare --allocate (the flow CLAUDE.md documents) previously wrote
    // assignee:"" and nothing else, so the ref could not attribute ownership.
    const r = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned"], { CLAIM_ASSIGNEE: "" });
    expect(r.code).toBe(0);
    const rec = readRecord(fx, r.stdout.trim());
    expect(rec.requested_by).toBeTruthy();
    expect(rec.requested_by).not.toBe("");
  });

  it("prefers an explicit --by, and records the assignee when there is one", () => {
    const a = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "ttraenkler/dev-x"]);
    expect(readRecord(fx, a.stdout.trim())).toMatchObject({ requested_by: "ttraenkler/dev-x", assignee: "" });

    const b = run(fx, ["--allocate", "ttraenkler/dev-y", "--no-pr-scan", "--allow-unscanned"]);
    expect(readRecord(fx, b.stdout.trim())).toMatchObject({
      requested_by: "ttraenkler/dev-y",
      assignee: "ttraenkler/dev-y",
      status: "in-progress",
    });
  });

  it("attributes a release to the ACTOR, not to the holder being cleared", () => {
    expect(run(fx, ["3000", "ttraenkler/departed-agent"]).code).toBe(0);
    // Clearing a departed agent's claim is the common case (two such records
    // were created in one stand-down on 2026-07-31). The positional argument
    // here is the EXPECTED HOLDER, so attributing the record to it would have
    // the dead agent releasing itself.
    const r = run(fx, ["--release", "3000", "ttraenkler/departed-agent", "--by", "ttraenkler/janitor"]);
    expect(r.code).toBe(0);
    expect(readRecord(fx, "3000")).toMatchObject({
      status: "released",
      assignee: "ttraenkler/departed-agent",
      requested_by: "ttraenkler/janitor",
    });
  });

  it("keeps --branch parsing intact alongside --by", () => {
    const r = run(fx, ["3000", "dave", "--by", "ttraenkler/lead", "--branch", "issue-3000-x"]);
    expect(r.code).toBe(0);
    expect(readRecord(fx, "3000")).toMatchObject({ assignee: "dave", branch: "issue-3000-x" });
  });
});

describe("#3880 claim-issue.mjs — preserved behaviour", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("still refuses a second claimant and still honours --force (#2168)", () => {
    expect(run(fx, ["3000", "alice"]).code).toBe(0);
    const clash = run(fx, ["3000", "bob"]);
    expect(clash.code).toBe(3);
    expect(lastLine(clash.stderr)).toMatch(/^claim-issue: REFUSED —/);
    expect(readRecord(fx, "3000")).toMatchObject({ assignee: "alice" });
    expect(run(fx, ["3000", "bob", "--force"]).code).toBe(0);
    expect(readRecord(fx, "3000")).toMatchObject({ assignee: "bob" });
  });

  it("still takes independent slice locks (#41)", () => {
    expect(run(fx, ["3000:glue1", "alice"]).code).toBe(0);
    expect(run(fx, ["3000:glue2", "bob"]).code).toBe(0);
    expect(readRecord(fx, "3000-glue1")).toMatchObject({ slice: "glue1", assignee: "alice" });
    expect(readRecord(fx, "3000-glue2")).toMatchObject({ slice: "glue2", assignee: "bob" });
    expect(run(fx, ["3000:glue1", "bob"]).code).toBe(3);
  });

  it("still refuses to claim an issue already done on main, before touching the ref", () => {
    // Flip 3001 to done on the fixture's main.
    const seed = join(fx.root, "seed");
    writeFileSync(join(seed, "plan", "issues", "3001-beta.md"), "---\nid: 3001\nstatus: done\n---\n");
    g(["add", "-A"], seed);
    g([...GIT_ID, "commit", "--quiet", "-m", "close 3001"], seed);
    g(["push", "--quiet", "origin", "main"], seed);
    g(["fetch", "--quiet", "origin"], fx.work);

    const r = run(fx, ["3001", "alice"]);
    expect(r.code).toBe(4);
    expect(lastLine(r.stderr)).toMatch(/^claim-issue: REFUSED —/);
    expect(listRecords(fx)).toEqual([]);
  });

  it("still short-circuits --dry-run on write modes without mutating the ref (#3011)", () => {
    const r = run(fx, ["--dry-run", "3000", "alice"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/\(dry-run\) would claim #3000/);
    expect(listRecords(fx)).toEqual([]);
  });

  it("a terminal record reads as free for BOTH readers, including the dispatch gate", () => {
    // scripts/pre-dispatch-gate.mjs had its own, worse copy of this predicate:
    // it tested `assignee` alone and ignored status, so every `done` AND every
    // `released` record read as a live blocker (403 of 1,080 on the live ref).
    // Both readers now import the one definition.
    expect(isHeldRecord({ assignee: "a", status: "in-progress" })).toBe(true);
    expect(isHeldRecord({ assignee: "a", status: "done" })).toBe(false);
    expect(isHeldRecord({ assignee: "a", status: "released" })).toBe(false);
    expect(isHeldRecord({ assignee: "", status: "reserved" })).toBe(false);
    expect(isHeldRecord(null)).toBe(false);
    // An UNRECOGNISED status must read as HELD. The two errors are not
    // symmetric: over-holding blocks work, under-holding puts two agents on one
    // issue — the duplicate dispatch this lock exists to prevent.
    expect(isHeldRecord({ assignee: "a", status: "some-future-state" })).toBe(true);
    expect(isHeldRecord({ assignee: "a" })).toBe(true);
  });

  it("--complete actually frees the lock for readers", () => {
    // This is the step CLAUDE.md prescribes after a merge to "clear the
    // cross-dev lock". It writes status:"done", and the old heldness predicate
    // was `status !== "released"` — so a completed issue stayed CLAIMED for
    // every reader, forever. On the live ref that was 294 of 654 reported
    // "active claims".
    expect(run(fx, ["3000", "alice"]).code).toBe(0);
    expect(run(fx, ["--complete", "3000", "alice"]).code).toBe(0);
    expect(readRecord(fx, "3000")).toMatchObject({ status: "done" });

    const check = run(fx, ["--check", "3000"]);
    expect(check.code).toBe(0);
    // (#4133/#4117) The wording changed and the assertion moved with it,
    // deliberately. This used to require `is UNASSIGNED`, which conflated two
    // different questions: the LOCK is free (what this test is about) but the
    // ID is still taken (what the sibling test below is about). `--check` now
    // answers both separately, so assert the property rather than the old
    // sentence — exit 0, no live claim, and the id still reported as taken.
    expect(check.stdout).toMatch(/NO ACTIVE CLAIM/);
    expect(check.stdout).toMatch(/id is TAKEN/);
    expect(check.stdout).not.toMatch(/is CLAIMED by/);
    expect(run(fx, ["--list"]).stdout).toMatch(/No active claims/);
    // ...and the next agent can take it.
    expect(run(fx, ["3000", "bob"]).code).toBe(0);
  });

  it("keeps a completed id RESERVED even though its lock is free", () => {
    // Freeing the lock must not recycle the number: idsFromAssignRef reads
    // every entry's id regardless of status.
    const a = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "x"]);
    const id = a.stdout.trim();
    expect(run(fx, ["--complete", id, "x"]).code).toBe(0);
    const b = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "x"]);
    expect(b.stdout.trim()).not.toBe(id);
    expect(Number(b.stdout.trim())).toBeGreaterThan(Number(id));
  });

  it("reports a genuine no-op release as success, on a verified read", () => {
    const r = run(fx, ["--release", "3000", "alice"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to release/);
    expect(lastLine(r.stderr)).toMatch(/^claim-issue: OK —/);
  });
});
