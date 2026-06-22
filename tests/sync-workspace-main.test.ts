import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Task #75 — `scripts/sync-workspace-main.sh` disposable-divergence auto-reset.
//
// /workspace main keeps DIVERGING (not just lagging) from origin/main when a
// superseded merge-queue baseline commit or a worktree branch-rename leaves it
// on a non-ancestor commit. The ff-only sync then fails and leaves it stale.
// The fix: when ff-only fails because of divergence, reset --hard to origin/main
// ONLY when every divergent commit is provably DISPOSABLE — already-landed
// upstream by content (`git cherry` patch-id match) OR touching only
// baseline/benchmark-result JSON / run logs / live team-memory. Real work in any
// divergent commit → refuse (never discard).

const SCRIPT = join(__dirname, "..", "scripts", "sync-workspace-main.sh");

let root: string;
let origin: string;
let ws: string;

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.co",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.co",
    },
  }).trim();
}

function commit(cwd: string, msg: string): void {
  git(cwd, "add -A");
  git(cwd, `commit -q -m ${JSON.stringify(msg)}`);
}

/** Run the sync script against the workspace clone; return its stdout. */
function runSync(): string {
  return execSync(`sh ${JSON.stringify(SCRIPT)} ${JSON.stringify(ws)}`, { encoding: "utf8" }).trim();
}

function shortHead(cwd: string): string {
  return git(cwd, "rev-parse --short HEAD");
}

/** Force origin/main to a fresh "superseding" commit on top of `base`, so the
 *  workspace's current main becomes a non-ancestor (diverged) of origin/main. */
function supersedeOrigin(baseRef: string, file: string, content: string, msg: string): void {
  git(ws, `checkout -q -b __sup ${baseRef}`);
  writeFileSync(join(ws, file), content);
  commit(ws, msg);
  git(ws, "push -qf origin HEAD:main");
  git(ws, "checkout -q main");
  git(ws, "branch -qD __sup");
  git(ws, "fetch -q origin");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-ws-"));
  origin = join(root, "origin.git");
  ws = join(root, "ws");
  git(root, `init -q --bare ${JSON.stringify(origin)}`);
  git(root, `clone -q ${JSON.stringify(origin)} ${JSON.stringify(ws)}`);
  mkdirSync(join(ws, "benchmarks", "results"), { recursive: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "benchmarks/results/test262-current.json"), '{"pass":1}\n');
  writeFileSync(join(ws, "src/a.ts"), "export const a = 1;\n");
  commit(ws, "base");
  git(ws, "branch -M main");
  git(ws, "push -q origin main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sync-workspace-main.sh", () => {
  it("fast-forwards a clean checkout that is merely BEHIND origin/main", () => {
    // origin advances; local stays behind.
    writeFileSync(join(ws, "src/b.ts"), "export const b = 2;\n");
    commit(ws, "origin real work");
    git(ws, "push -q origin main");
    git(ws, "reset -q --hard HEAD~1");
    const out = runSync();
    expect(out).toMatch(/fast-forwarded/);
    expect(shortHead(ws)).toBe(git(ws, "rev-parse --short origin/main"));
  });

  it("auto-resets a DISPOSABLE (baseline-only) divergence", () => {
    git(ws, "reset -q --hard origin/main");
    writeFileSync(join(ws, "benchmarks/results/test262-current.json"), '{"pass":2}\n');
    commit(ws, "local baseline refresh");
    supersedeOrigin("origin/main~0", "src/z.ts", "export const z = 3;\n", "origin superseding work");
    // local main now has a baseline-only commit origin/main lacks.
    expect(git(ws, "rev-list origin/main..HEAD").length).toBeGreaterThan(0);
    const out = runSync();
    expect(out).toMatch(/disposable commit/);
    expect(out).toMatch(/reset/);
    expect(shortHead(ws)).toBe(git(ws, "rev-parse --short origin/main"));
  });

  it("auto-resets an ALREADY-LANDED divergence (patch-id match), even in src/", () => {
    git(ws, "reset -q --hard origin/main");
    writeFileSync(join(ws, "src/dup.ts"), "export const dup = 5;\n");
    commit(ws, "shared change");
    // origin gets the same content under a different SHA (squash/rebase-merge).
    supersedeOrigin("origin/main~0", "src/dup.ts", "export const dup = 5;\n", "shared change (squashed)");
    // `git cherry` should mark the local commit as already-landed ('-').
    expect(git(ws, "cherry origin/main HEAD")).toMatch(/^- /);
    const out = runSync();
    expect(out).toMatch(/disposable commit/);
    expect(shortHead(ws)).toBe(git(ws, "rev-parse --short origin/main"));
  });

  it("REFUSES (no reset) a real-work divergence — preserves local work", () => {
    git(ws, "reset -q --hard origin/main");
    writeFileSync(join(ws, "src/realwork.ts"), "export const real = 99;\n");
    commit(ws, "local REAL work");
    const localReal = shortHead(ws);
    supersedeOrigin("origin/main~0", "src/other.ts", "export const o = 4;\n", "origin other work");
    const out = runSync();
    expect(out).toMatch(/REAL work/);
    expect(out).not.toMatch(/reset \w+ ->/);
    expect(shortHead(ws)).toBe(localReal); // local commit preserved
  });

  it("REFUSES a MIXED divergence (baseline + real work) — not ALL disposable", () => {
    git(ws, "reset -q --hard origin/main");
    writeFileSync(join(ws, "benchmarks/results/test262-current.json"), '{"pass":3}\n');
    commit(ws, "baseline only");
    writeFileSync(join(ws, "src/mixed.ts"), "export const m = 7;\n");
    commit(ws, "real work in mix");
    const localMix = shortHead(ws);
    supersedeOrigin("origin/main~0", "src/o2.ts", "export const o = 8;\n", "origin other");
    const out = runSync();
    expect(out).toMatch(/REAL work/);
    expect(shortHead(ws)).toBe(localMix);
  });

  it("REFUSES when the tree is dirty with a tracked-file change", () => {
    git(ws, "reset -q --hard origin/main");
    // Make origin advance so a sync would otherwise be needed.
    supersedeOrigin("origin/main~0", "src/c.ts", "export const c = 9;\n", "origin advance");
    git(ws, "reset -q --hard HEAD"); // ensure local diverged from origin
    writeFileSync(join(ws, "src/a.ts"), "export const a = 999; // dirty\n");
    const out = runSync();
    expect(out).toMatch(/uncommitted changes/);
    // dirty edit untouched.
    expect(git(ws, "status --porcelain")).toMatch(/src\/a\.ts/);
  });
});
