// #4133 / #4117 — `claim-issue.mjs` must reserve against ONE book, and that
// book must be the one everybody else reads.
//
// The defect: `CLAIM_ASSIGN_REMOTE` defaulted to `origin`, and in agent
// worktrees `origin` IS the fork. CI's collision gate, the Codex lane and every
// upstream-rooted checkout read UPSTREAM's `issue-assignments` ref, so the repo
// kept two disjoint reservation books and the "atomic reservation" of #2531 was
// atomic against whichever one the caller happened to be standing in.
//
// Measured twice, on the record:
//   * 2026-07-28  #3715 reserved 3750/3751/3752 on the fork book; #3723 took
//     3750/3751 via upstream and merged. #3715 renumbered twice.
//   * 2026-08-02  codex claimed 4113 on upstream at 21:10:58Z; `--allocate`
//     handed 4113 to a second lane at 21:35:13Z, wrote it to the fork's book,
//     exit 0, `pr_scan: "ok"`.
//
// EVERY test here drives the REAL script against hermetic local bare repos, and
// the "other lane" is simulated by writing DIRECTLY to the upstream book with
// plain git — never through the script. That matters: a control that creates
// the competing record with the same tool it is testing would pass even if the
// tool were still writing to the wrong book.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "scripts", "claim-issue.mjs");
const GIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

// Same scrubbing rationale as tests/issue-3880.test.ts: with GIT_DIR exported
// (husky runs hooks that way) `git init --bare <path>` re-initialises $GIT_DIR
// instead, writing core.bare=true into the SHARED config and breaking every
// worktree in the repo. A fixture that can reach outside itself is worthless.
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

interface Fixture {
  root: string;
  mainGit: string;
  upstreamBook: string;
  forkBook: string;
  work: string;
  cache: string;
}

/**
 * A working clone whose remotes mirror production topology:
 *   origin   -> the FORK      (its own issue-assignments book)
 *   upstream -> the UPSTREAM  (main + the authoritative book)
 * Both books live in the same bare repo as `main` for their side, exactly as
 * they do in the real repos.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "claim4045-"));
  const mainGit = join(root, "upstream.git");
  const forkGit = join(root, "fork.git");
  const work = join(root, "work");
  const cache = join(root, "cache.git");
  const seed = join(root, "seed");

  g(["init", "--bare", "--quiet", "--initial-branch=main", mainGit]);
  g(["init", "--bare", "--quiet", "--initial-branch=main", forkGit]);

  g(["init", "--quiet", "--initial-branch=main", seed]);
  mkdirSync(join(seed, "plan", "issues"), { recursive: true });
  for (const [id, slug] of [
    ["4000", "alpha"],
    ["4001", "beta"],
  ]) {
    writeFileSync(join(seed, "plan", "issues", `${id}-${slug}.md`), `---\nid: ${id}\nstatus: ready\n---\n\n# ${id}\n`);
  }
  g(["add", "-A"], seed);
  g([...GIT_ID, "commit", "--quiet", "-m", "seed"], seed);
  g(["remote", "add", "up", mainGit], seed);
  g(["push", "--quiet", "up", "main"], seed);

  g(["clone", "--quiet", forkGit, work]);
  // `origin` is the FORK — the whole point.
  g(["remote", "set-url", "origin", forkGit], work);
  g(["remote", "add", "upstream", mainGit], work);
  g(["fetch", "--quiet", "upstream", "main:refs/remotes/upstream/main"], work);

  return { root, mainGit, upstreamBook: mainGit, forkBook: forkGit, work, cache };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the script with NO `CLAIM_ASSIGN_REMOTE` — the default resolution is
 * exactly what is under test. `CLAIM_REMOTE` is likewise left unset so the main
 * scan resolves through the same `upstream`-preferring picker.
 */
function run(fx: Fixture, args: string[], extra: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fx.work,
    encoding: "utf8",
    env: cleanEnv({
      CLAIM_CACHE_DIR: fx.cache,
      CLAIM_NET_RETRIES: "2",
      CLAIM_NET_TIMEOUT_MS: "20000",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...extra,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Read a record straight off a book with plain git — the source of truth. */
function readRecord(bookGit: string, key: string): any | null {
  try {
    return JSON.parse(g(["cat-file", "-p", `refs/heads/issue-assignments:${key}.json`], bookGit));
  } catch {
    return null;
  }
}

/**
 * Write a record to a book WITHOUT the script — this is "another lane", and it
 * must not share any code path with the thing under test.
 */
function otherLaneWrites(bookGit: string, key: string, record: Record<string, unknown>) {
  const tmp = mkdtempSync(join(tmpdir(), "otherlane-"));
  // NOT `--initial-branch=issue-assignments`: git refuses to fetch into the
  // branch that is currently checked out, so the fetch below would throw, the
  // catch would swallow it, and we would build an ORPHAN commit whose push is
  // rejected non-fast-forward. Start on a scratch branch instead.
  g(["init", "--quiet", "--initial-branch=scratch", tmp]);
  // Preserve whatever is already on the book so successive writes accumulate.
  try {
    g(["fetch", "--quiet", bookGit, "+refs/heads/issue-assignments:refs/heads/issue-assignments"], tmp);
    g(["checkout", "--quiet", "issue-assignments"], tmp);
  } catch {
    /* first write to an empty book */
  }
  writeFileSync(join(tmp, `${key}.json`), JSON.stringify(record, null, 2) + "\n");
  g(["add", "-A"], tmp);
  g([...GIT_ID, "commit", "--quiet", "-m", `other lane: ${key}`], tmp);
  g(["push", "--quiet", bookGit, "HEAD:refs/heads/issue-assignments"], tmp);
  rmSync(tmp, { recursive: true, force: true });
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

describe("#4133/#4117 one assignment ledger", () => {
  it("writes reservations to UPSTREAM's book, not the fork's", () => {
    const r = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-a"]);
    expect(r.code, r.stderr).toBe(0);
    const id = r.stdout.trim();
    expect(id).toMatch(/^\d+$/);

    // THE assertion. Before the fix this landed on the fork and upstream was
    // empty, which is the entire defect in one line.
    expect(readRecord(fx.upstreamBook, id), "reservation must be on UPSTREAM's book").toMatchObject({
      id,
      requested_by: "lane-a",
    });
    expect(readRecord(fx.forkBook, id), "nothing may be written to the fork's book").toBeNull();
  });

  it("a reservation another lane made on upstream BLOCKS a second allocate of that id", () => {
    // Simulate the 2026-08-02 incident exactly: the other lane's record exists
    // only on upstream, written without this script.
    const r1 = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-a"]);
    const first = Number(r1.stdout.trim());
    // The other lane takes the id our next allocate would otherwise compute.
    otherLaneWrites(fx.upstreamBook, String(first + 1), {
      id: String(first + 1),
      assignee: "ttraenkler/other-lane",
      requested_by: "ttraenkler/other-lane",
      status: "in-progress",
      claimed_at: "2026-08-02T21:10:58Z",
    });

    const r2 = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-b"]);
    expect(r2.code, r2.stderr).toBe(0);
    expect(Number(r2.stdout.trim()), "must not hand out the id the other lane holds").toBeGreaterThan(first + 1);
  });

  it("a claim another lane made on upstream is VISIBLE to --check", () => {
    otherLaneWrites(fx.upstreamBook, "4000", {
      id: "4000",
      assignee: "ttraenkler/codex",
      requested_by: "ttraenkler/codex",
      status: "in-progress",
      branch: "codex/4000-x",
      claimed_at: "2026-08-02T21:10:58Z",
    });
    const c = run(fx, ["--check", "4000"]);
    // Exit 3 = claimed by someone else. Before the fix this was exit 0
    // "UNASSIGNED" — the same command, same id, opposite answer, from the other
    // book (measured on #4076 and #4113).
    expect(c.code).toBe(3);
    expect(c.stdout).toMatch(/CLAIMED by ttraenkler\/codex/);
  });

  it("--check names the book that answered", () => {
    const c = run(fx, ["--check", "4001"]);
    expect(c.code).toBe(0);
    // "the ledger says X" is unusable evidence without its ref (#4133).
    expect(c.stderr).toMatch(/read upstream\/issue-assignments/);
  });

  it("--check distinguishes RESERVED-but-unclaimed from UNASSIGNED", () => {
    const a = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-a"]);
    const id = a.stdout.trim();
    const c = run(fx, ["--check", id]);
    expect(c.code).toBe(0);
    // The tool that WRITES `reserved` records could not previously see what it
    // had just written: it answered "UNASSIGNED" for an id it had reserved
    // seconds earlier.
    expect(c.stdout).toMatch(/is RESERVED/);
    expect(c.stdout).toMatch(/id is TAKEN/);
    expect(c.stdout).not.toMatch(/is UNASSIGNED/);
  });

  describe("migration — the legacy book is read, never written, never a fallback", () => {
    it("unions a legacy-book reservation into the id universe", () => {
      const r1 = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-a"]);
      const first = Number(r1.stdout.trim());
      // A record that exists ONLY on the fork book — the state this repo was
      // actually in when the default flipped (4113/4116/4117 were all there).
      otherLaneWrites(fx.forkBook, String(first + 1), {
        id: String(first + 1),
        assignee: "",
        requested_by: "ttraenkler/legacy-lane",
        status: "reserved",
        reserved_at: "2026-08-02T22:17:14Z",
      });

      const r2 = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-b"], {
        CLAIM_ASSIGN_LEGACY_REMOTES: "origin",
      });
      expect(r2.code, r2.stderr).toBe(0);
      expect(Number(r2.stdout.trim()), "a legacy reservation still reserves the id").toBeGreaterThan(first + 1);
    });

    it("a claim held only on the legacy book still blocks a claim", () => {
      otherLaneWrites(fx.forkBook, "4000", {
        id: "4000",
        assignee: "ttraenkler/legacy-lane",
        requested_by: "ttraenkler/legacy-lane",
        status: "in-progress",
        claimed_at: "2026-08-02T23:09:20Z",
      });
      const c = run(fx, ["4000", "ttraenkler/newcomer"], { CLAIM_ASSIGN_LEGACY_REMOTES: "origin" });
      expect(c.code).toBe(3);
      expect(c.stderr + c.stdout).toMatch(/already claimed by ttraenkler\/legacy-lane/);
    });

    it("a write about a legacy record MIGRATES it to the authoritative book", () => {
      otherLaneWrites(fx.forkBook, "4000", {
        id: "4000",
        assignee: "ttraenkler/legacy-lane",
        requested_by: "ttraenkler/legacy-lane",
        status: "in-progress",
        claimed_at: "2026-08-02T23:09:20Z",
      });
      const c = run(fx, ["--release", "4000", "ttraenkler/legacy-lane"], { CLAIM_ASSIGN_LEGACY_REMOTES: "origin" });
      expect(c.code, c.stderr).toBe(0);
      // Drained forward: the new state is on upstream. The fork's stale copy is
      // left alone on purpose — this book is read-only, and rewriting another
      // repo's history to tidy it up is not this tool's business.
      expect(readRecord(fx.upstreamBook, "4000")).toMatchObject({ status: "released" });
      expect(readRecord(fx.forkBook, "4000")).toMatchObject({ status: "in-progress" });
    });

    it("REFUSES to allocate when a legacy book is unreadable — never silently skips it", () => {
      const unreadable = { CLAIM_ASSIGN_LEGACY_REMOTES: join(fx.root, "does-not-exist.git") };

      // Note the flags: the open-PR scan is disabled AND explicitly excused, so
      // the ONLY refusal reason left is the unreadable book. Without that the
      // assertion would pass for the wrong reason — `--no-pr-scan` alone
      // refuses anyway, which is how a control ends up green against the
      // unfixed script.
      const strict = run(fx, ["--allocate", "--no-pr-scan", "--allow-unscanned", "--by", "lane-a"], unreadable);
      expect(strict.code).toBe(6);
      expect(strict.stderr).toMatch(/cannot READ the legacy assignment book/);
      expect(strict.stdout.trim(), "nothing may be reserved").toBe("");

      // …and the specific consent lets it through. `--allow-unscanned` must NOT:
      // accepting "gh is offline" is not accepting "a whole book is invisible".
      const forced = run(
        fx,
        ["--allocate", "--no-pr-scan", "--allow-unscanned", "--allow-unmerged-books", "--by", "lane-a"],
        unreadable,
      );
      expect(forced.code, forced.stderr).toBe(0);
      expect(forced.stdout.trim()).toMatch(/^\d+$/);
    });
  });

  // PRESERVED-BEHAVIOUR guard, not a fix control: this also passes against the
  // unfixed script (which honoured CLAIM_ASSIGN_REMOTE the same way). It is here
  // because adding a legacy-book fallback is the obvious way to "improve"
  // resilience, and doing so would silently restore the split brain.
  it("REFUSES when the AUTHORITATIVE book is unreachable — never falls back to the fork", () => {
    // The fork book is perfectly readable and even holds a record; that must not
    // rescue the read. Falling back on an upstream outage would restore the
    // split brain at the exact moment it is most dangerous.
    otherLaneWrites(fx.forkBook, "4000", {
      id: "4000",
      assignee: "ttraenkler/legacy-lane",
      requested_by: "ttraenkler/legacy-lane",
      status: "in-progress",
    });
    const c = run(fx, ["--check", "4000"], {
      CLAIM_ASSIGN_REMOTE: join(fx.root, "unreachable.git"),
      CLAIM_ASSIGN_LEGACY_REMOTES: "origin",
    });
    expect(c.code, "an unreadable authoritative book is NOT an empty one").toBe(6);
    expect(c.stderr).toMatch(/cannot READ the assignment ref/);
    expect(c.stdout).not.toMatch(/UNASSIGNED/);
  });
});
