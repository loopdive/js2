// #3969 — reconcile-tasklist.mjs must not manufacture findings.
//
// A full audit of one 26-row run found 0 true positives: 13 phantom rows and 13
// real-but-misattributed. Two independent causes, tested independently here so
// the kill-switch attribution can show they are genuinely separate defects:
//
//   A. it read the LOCAL checkout, which rots behind main in a worktree fleet;
//   B. it treated any `#N` in a merged PR title as proof `#N` is done.
//
// Hermetic: two local bare repos and a stubbed `gh` on PATH. No network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "scripts", "reconcile-tasklist.mjs");
const GIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

// See tests/issue-3880.test.ts: with GIT_DIR set, `git init --bare <path>`
// re-initialises $GIT_DIR and, with extensions.worktreeConfig, breaks every
// worktree in the repo. The fixture is worthless if it can reach outside itself.
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

interface IssueSpec {
  id: string;
  status?: string;
  title?: string;
  checked?: number;
  unchecked?: number;
}

function issueMd(i: IssueSpec) {
  const boxes = [
    ...Array.from({ length: i.checked ?? 0 }, (_, n) => `- [x] criterion ${n + 1}`),
    ...Array.from({ length: i.unchecked ?? 0 }, (_, n) => `- [ ] open criterion ${n + 1}`),
  ];
  return [
    "---",
    `id: ${i.id}`,
    `title: "${i.title ?? `Issue ${i.id}`}"`,
    `status: ${i.status ?? "ready"}`,
    "---",
    "",
    `# ${i.id}`,
    "",
    ...(boxes.length ? ["## Acceptance criteria", "", ...boxes] : []),
    "",
  ].join("\n");
}

interface Fixture {
  root: string;
  originGit: string;
  work: string;
  home: string;
  bin: string;
}

/** Stub `gh` so `gh pr list --state merged --json number,title` is deterministic. */
function writeGhStub(bin: string, prs: Array<{ number: number; title: string }>) {
  mkdirSync(bin, { recursive: true });
  const payload = JSON.stringify(prs).replace(/'/g, "'\\''");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s' '${payload}'\n`, { mode: 0o755 });
  chmodSync(join(bin, "gh"), 0o755);
}

function makeFixture(issues: IssueSpec[], prs: Array<{ number: number; title: string }>): Fixture {
  const root = mkdtempSync(join(tmpdir(), "recon3969-"));
  const originGit = join(root, "origin.git");
  const work = join(root, "work");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const seed = join(root, "seed");

  g(["init", "--bare", "--quiet", "--initial-branch=main", originGit]);
  g(["init", "--quiet", "--initial-branch=main", seed]);
  mkdirSync(join(seed, "plan", "issues"), { recursive: true });
  for (const i of issues) writeFileSync(join(seed, "plan", "issues", `${i.id}-slug.md`), issueMd(i));
  g(["add", "-A"], seed);
  g([...GIT_ID, "commit", "--quiet", "-m", "seed"], seed);
  g(["remote", "add", "origin", originGit], seed);
  g(["push", "--quiet", "origin", "main"], seed);
  g(["clone", "--quiet", originGit, work]);

  // A task store must exist or the script short-circuits with "no task store".
  mkdirSync(join(home, "tasks", "js2wasm"), { recursive: true });
  writeFileSync(
    join(home, "tasks", "js2wasm", "1.json"),
    JSON.stringify({ id: "1", subject: "fix(#9999): unrelated placeholder task", status: "in_progress" }),
  );

  writeGhStub(bin, prs);
  return { root, originGit, work, home, bin };
}

/** Advance origin/main WITHOUT updating the clone — the stale-checkout defect. */
function advanceOriginOnly(fx: Fixture, issues: IssueSpec[]) {
  const bump = join(fx.root, "bump");
  rmSync(bump, { recursive: true, force: true });
  g(["clone", "--quiet", fx.originGit, bump]);
  for (const i of issues) writeFileSync(join(bump, "plan", "issues", `${i.id}-slug.md`), issueMd(i));
  g(["add", "-A"], bump);
  g([...GIT_ID, "commit", "--quiet", "-m", "advance"], bump);
  g(["push", "--quiet", "origin", "main"], bump);
  rmSync(bump, { recursive: true, force: true });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
function run(fx: Fixture, args: string[] = [], extra: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fx.work,
    encoding: "utf8",
    env: cleanEnv({
      PATH: `${fx.bin}:${process.env.PATH}`,
      CLAUDE_HOME: fx.home,
      REPO_ROOT: fx.work,
      ...extra,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function runJson(fx: Fixture, args: string[] = [], extra: Record<string, string> = {}): any {
  const r = run(fx, ["--json", ...args], extra);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`non-JSON output (code ${r.code}):\n${r.stdout}\n${r.stderr}`);
  }
}

describe("#3969 Defect A — a stale local checkout must not become a finding", () => {
  let fx: Fixture;
  afterEach(() => fx && rmSync(fx.root, { recursive: true, force: true }));

  it("reads issue status from remote main, not from the rotted clone", () => {
    fx = makeFixture([{ id: "9001", status: "ready", checked: 2 }], [{ number: 800, title: "fix(#9001): land it" }]);
    // The fix merges and main is updated — but the clone is never touched, which
    // is the normal state of a shared checkout in a worktree fleet.
    advanceOriginOnly(fx, [{ id: "9001", status: "done", checked: 2 }]);

    const local = g(["rev-parse", "origin/main"], fx.work).trim();
    const remote = g(["ls-remote", fx.originGit, "refs/heads/main"]).split("\t")[0].trim();
    expect(local).not.toBe(remote); // the fixture really is stale

    const j = runJson(fx);
    expect(j.issue_source.verified).toBe(true);
    expect(j.issue_source.mode).toBe("tree");
    expect(j.issue_source.note).toMatch(/STALE/); // it noticed, and said so
    // #9001 is done on main, so it must NOT be reported as an open issue.
    const flagged = [...j.mergedPrDone, ...j.mergedPrUnknown, ...j.mergedPrRejected].map((r: any) => r.id);
    expect(flagged).not.toContain("9001");
  });

  it("refuses, loudly, when currency cannot be established at all", () => {
    fx = makeFixture([{ id: "9001", status: "ready", checked: 2 }], [{ number: 800, title: "fix(#9001): land it" }]);
    // Point origin at nothing: the tool can neither confirm nor refresh.
    g(["remote", "set-url", "origin", join(fx.root, "does-not-exist.git")], fx.work);

    const j = runJson(fx);
    expect(j.issue_source.verified).toBe(false);
    expect(j.issue_source.unreliable).toBe(true);

    const human = run(fx);
    expect(human.stdout).toMatch(/UNVERIFIED/);
    expect(human.stdout).toMatch(/REFUSING to treat the merged-PR verdicts as reliable/);
    // The hook line is where this matters most — it is the line anyone reads.
    expect(run(fx, ["--quiet"]).stdout).toMatch(/^STALE-TREE/);
  });

  it("--allow-stale-tree is an explicit opt-out, not a silent one", () => {
    fx = makeFixture([{ id: "9001", status: "ready", checked: 2 }], [{ number: 800, title: "fix(#9001): land it" }]);
    g(["remote", "set-url", "origin", join(fx.root, "does-not-exist.git")], fx.work);
    const j = runJson(fx, ["--allow-stale-tree"]);
    expect(j.issue_source.verified).toBe(false); // still reported as unverified
    expect(j.issue_source.unreliable).toBe(false); // but the caller accepted it
    expect(run(fx, ["--quiet", "--allow-stale-tree"]).stdout).not.toMatch(/^STALE-TREE/);
  });
});

describe("#3969 Defect B — a `#N` in a merged PR title is not proof #N is done", () => {
  let fx: Fixture;
  afterEach(() => fx && rmSync(fx.root, { recursive: true, force: true }));

  // POSITIVE CONTROL. Without this every assertion below is satisfiable by a
  // tool that reports nothing at all.
  it("still reports a genuinely-done issue", () => {
    fx = makeFixture(
      [{ id: "9001", status: "ready", checked: 3, unchecked: 0 }],
      [{ number: 800, title: "fix(#9001): the actual fix" }],
    );
    const j = runJson(fx);
    expect(j.mergedPrDone.map((r: any) => r.id)).toEqual(["9001"]);
    expect(j.mergedPrDone[0].reason).toMatch(/all 3 acceptance criteria checked/);
    expect(run(fx).stdout).toMatch(/DONE — merged and every acceptance criterion checked/);
  });

  it("bug 1 — a slice PR does not close its epic; two claimants means UNKNOWN", () => {
    fx = makeFixture(
      [{ id: "9002", status: "ready", checked: 2 }],
      [
        { number: 801, title: "feat(ir): slice one (#9002)" },
        { number: 802, title: "feat(ir): slice two (#9002)" },
      ],
    );
    const j = runJson(fx);
    expect(j.mergedPrDone).toEqual([]); // NOT done
    expect(j.mergedPrUnknown.map((r: any) => r.id)).toEqual(["9002"]);
    expect(j.mergedPrUnknown[0].reason).toMatch(/claimed by 2 merged PRs .*slice-of-epic/);
  });

  it("bug 2 — an incidental mention is not a claim", () => {
    // One PR whose subject is #9003 but which also names #9004 and #9005 in the
    // summary. The old code attributed all three to it.
    fx = makeFixture(
      [
        { id: "9003", status: "ready", checked: 1 },
        { id: "9004", status: "ready", checked: 1 },
        { id: "9005", status: "ready", checked: 1 },
      ],
      [{ number: 803, title: "feat(#9003): page restyle; supersedes the #9004 and #9005 analyses" }],
    );
    const j = runJson(fx);
    expect(j.mergedPrDone.map((r: any) => r.id)).toEqual(["9003"]);
    const all = [...j.mergedPrDone, ...j.mergedPrUnknown, ...j.mergedPrRejected].map((r: any) => r.id);
    expect(all).not.toContain("9004");
    expect(all).not.toContain("9005");
    // Floored, not invisible: the report says how many it declined to flag.
    expect(run(fx).stdout).toMatch(/2 open issue\(s\) were MENTIONED .* but never claimed/);
  });

  it("bug 3 — filed-by is not fixed-by", () => {
    fx = makeFixture(
      [{ id: "9006", status: "ready", checked: 1 }],
      [{ number: 804, title: "fix(#3898): re-derive the ratios; this run also filed #9006" }],
    );
    const j = runJson(fx);
    const all = [...j.mergedPrDone, ...j.mergedPrUnknown, ...j.mergedPrRejected].map((r: any) => r.id);
    expect(all).not.toContain("9006");
  });

  it("bug 4 — a PR correcting an issue's root-cause claim is not a fix for it", () => {
    fx = makeFixture(
      [{ id: "9007", status: "ready", checked: 1 }],
      [
        { number: 805, title: "fix(#3898): retract the substring claim made in #9007" },
        { number: 806, title: "docs(#9007): correct the root-cause note" },
      ],
    );
    const j = runJson(fx);
    const all = [...j.mergedPrDone, ...j.mergedPrUnknown, ...j.mergedPrRejected].map((r: any) => r.id);
    expect(all).not.toContain("9007"); // docs PR excluded, mention excluded
  });

  it("`(unblocks #N)` is a mention — the parens must hold nothing but the ref", () => {
    fx = makeFixture(
      [{ id: "9008", status: "ready", checked: 1 }],
      [{ number: 807, title: "fix(benchmarks): accept failed-strategy rows (unblocks #9008)" }],
    );
    const j = runJson(fx);
    const all = [...j.mergedPrDone, ...j.mergedPrUnknown, ...j.mergedPrRejected].map((r: any) => r.id);
    expect(all).not.toContain("9008");
  });

  it("a trailing `(#N)` IS a claim — verified against 200 real merged PRs", () => {
    fx = makeFixture(
      [{ id: "9009", status: "ready", checked: 2 }],
      [{ number: 808, title: "feat(ir): adopt function-local var declarations (#9009)" }],
    );
    expect(runJson(fx).mergedPrDone.map((r: any) => r.id)).toEqual(["9009"]);
  });

  it("unchecked acceptance criteria REJECT; absent ones give UNKNOWN, never done", () => {
    fx = makeFixture(
      [
        { id: "9010", status: "ready", checked: 1, unchecked: 3 },
        { id: "9011", status: "ready", checked: 0, unchecked: 0 },
      ],
      [
        { number: 809, title: "fix(#9010): partial" },
        { number: 810, title: "fix(#9011): no criteria in the issue" },
      ],
    );
    const j = runJson(fx);
    expect(j.mergedPrDone).toEqual([]);
    expect(j.mergedPrRejected.map((r: any) => r.id)).toEqual(["9010"]);
    expect(j.mergedPrRejected[0].reason).toMatch(/3 acceptance criterion/);
    expect(j.mergedPrUnknown.map((r: any) => r.id)).toEqual(["9011"]);
    expect(j.mergedPrUnknown[0].reason).toMatch(/no acceptance checkboxes/);
  });

  // KNOWN LIMITATION, pinned deliberately so nobody mistakes it for covered.
  //
  // Every signal here is derived from the PR TITLE, and a title is mutable
  // metadata — it can be edited after the merge, at which point it no longer
  // describes what landed. This is not hypothetical: while fixing #3969 I
  // retitled the already-merged PR #3950 to `fix(#3965, #3969): …` at 09:24:09Z
  // for a merge that happened at 08:20:54Z. `main` then carried a merged PR
  // claiming #3969 in SCOPE position whose merge commit contained none of that
  // work — and this tool would have called #3969 done. The fix's own headline
  // case, reproduced by the fix's own PR.
  //
  // The checkbox gate does not save you: I had written #3969's acceptance boxes
  // as checked, so the row would have passed every gate here.
  //
  // The real remedy is CONTENT evidence — does the merge commit actually touch
  // `plan/issues/<id>-…`? — which titles cannot provide. See the issue's
  // follow-ups. Until then this test states the exposure rather than hiding it.
  it("KNOWN LIMITATION: a title edited after merge still drives the verdict", () => {
    fx = makeFixture(
      [{ id: "9015", status: "ready", checked: 2 }],
      // Stands in for a PR retitled post-merge to claim work it never carried.
      [{ number: 814, title: "fix(#9015): a claim added to the title after the merge" }],
    );
    const j = runJson(fx);
    // Reported DONE on title evidence alone. If a future change adds a
    // content-evidence cross-check, THIS assertion is the one that must flip.
    expect(j.mergedPrDone.map((r: any) => r.id)).toEqual(["9015"]);
  });

  it("reports the three-way split so no row is silently dropped", () => {
    fx = makeFixture(
      [
        { id: "9012", status: "ready", checked: 2 },
        { id: "9013", status: "ready", unchecked: 1 },
        { id: "9014", status: "ready" },
      ],
      [
        { number: 811, title: "fix(#9012): done" },
        { number: 812, title: "fix(#9013): partial" },
        { number: 813, title: "fix(#9014): no criteria" },
      ],
    );
    expect(run(fx).stdout).toMatch(/3 open issue\(s\) CLAIMED by a merged code PR → 1 done, 1 unknown, 1 rejected/);
  });
});
