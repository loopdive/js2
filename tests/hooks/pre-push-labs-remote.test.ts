// #3410 — the private-labs pre-push guard must recognize the destination
// across every remote-URL syntax and fail safe on anything it cannot confirm
// is the private mirror. These tests exercise the shared POSIX-sh helper
// (scripts/hooks/push-remote-classify.sh) directly — the same code `.husky/
// pre-push` sources — so classification and the labs/ scan are covered without
// touching a network remote or any real private file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "hooks", "push-remote-classify.sh");
const NULL_OID = "0000000000000000000000000000000000000000";

// Run a single helper function from the sourced library and return its stdout.
function runFn(fn: string, arg: string): string {
  return execFileSync("sh", ["-c", `. "$0"; ${fn} "$1"`, LIB, arg], {
    encoding: "utf8",
  }).trim();
}

// Drive run_labs_guard against a git repo (cwd), feeding pre-push ref lines on
// stdin. Returns the exit status (0 = allow, 1 = block) and combined output.
function runGuard(cwd: string, remote: string, url: string, refLines: string[]): { status: number; output: string } {
  try {
    const out = execFileSync("sh", ["-c", '. "$0"; run_labs_guard "$1" "$2"', LIB, remote, url], {
      cwd,
      input: refLines.join("\n") + "\n",
      encoding: "utf8",
    });
    return { status: 0, output: out };
  } catch (e: any) {
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("#3410 pre-push labs guard — remote classification", () => {
  // owner/repo normalization across HTTPS, SSH, SCP, proxied, tokened URLs.
  const normCases: Array<[string, string]> = [
    ["https://github.com/loopdive/js2wasm.git", "loopdive/js2wasm"],
    ["https://github.com/loopdive/js2wasm", "loopdive/js2wasm"],
    ["https://github.com/loopdive/js2wasm.git", "loopdive/js2wasm"],
    ["ssh://git@github.com/loopdive/js2wasm.git", "loopdive/js2wasm"],
    ["git@github.com:loopdive/js2wasm.git", "loopdive/js2wasm"],
    ["git@github.com:loopdive/js2wasm-labs.git", "loopdive/js2wasm-labs"],
    ["http://local_proxy@127.0.0.1:41729/git/loopdive/js2wasm", "loopdive/js2wasm"],
    ["https://x-access-token:TOKEN@github.com/loopdive/js2wasm.git", "loopdive/js2wasm"],
    ["https://GitHub.com/LoopDive/JS2WASM.git", "loopdive/js2wasm"], // case-insensitive
    ["garbage", ""], // no owner/repo recoverable
    ["", ""],
  ];
  it.each(normCases)("normalize_owner_repo(%s) -> %s", (url, expected) => {
    expect(runFn("normalize_owner_repo", url)).toBe(expected);
  });

  // Classification: only the labs mirror is private; canonical + legacy
  // upstream and forks are public; anything else is unknown (fail-safe).
  const classCases: Array<[string, string]> = [
    ["https://github.com/loopdive/js2wasm.git", "public"],
    ["https://github.com/loopdive/js2wasm", "public"],
    ["https://github.com/loopdive/js2wasm.git", "public"], // legacy alias
    ["https://github.com/loopdive/js2wasm", "public"],
    ["git@github.com:loopdive/js2wasm.git", "public"],
    ["ssh://git@github.com/loopdive/js2wasm.git", "public"],
    ["https://github.com/ttraenkler/js2.git", "public"], // public fork
    ["git@github.com:ttraenkler/js2wasm.git", "public"], // legacy-named fork
    ["http://local_proxy@127.0.0.1:41729/git/loopdive/js2wasm", "public"], // current origin
    ["https://github.com/loopdive/js2wasm-labs.git", "labs-remote"],
    ["git@github.com:loopdive/js2wasm-labs.git", "labs-remote"],
    ["/local/path/somerepo", "unknown"],
    ["garbage", "unknown"],
    ["", "unknown"],
  ];
  it.each(classCases)("classify_push_remote(%s) -> %s", (url, expected) => {
    expect(runFn("classify_push_remote", url)).toBe(expected);
  });

  it("the exact current origin URL classifies as public", () => {
    let originUrl = "";
    try {
      originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
    } catch {
      originUrl = "";
    }
    if (!originUrl) return; // no origin in this checkout — nothing to assert
    expect(runFn("classify_push_remote", originUrl)).toBe("public");
  });
});

describe("#3410 pre-push labs guard — end-to-end scan", () => {
  let repo: string;
  let baseOid = "";
  let labsCommitOid = "";
  let cleanCommitOid = "";

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "prepush-labs-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");

    // base commit: an ordinary public path only.
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    baseOid = git(repo, "rev-parse", "HEAD");

    // Simulate the remote-tracking ref the guard consults for new branches.
    git(repo, "update-ref", "refs/remotes/origin/main", baseOid);

    // commit introducing a private labs/ path (the fixture — synthetic, no real
    // private content).
    mkdirSync(join(repo, "labs"), { recursive: true });
    writeFileSync(join(repo, "labs", "example.txt"), "synthetic private fixture\n");
    writeFileSync(join(repo, "docs.md"), "public\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add labs fixture");
    labsCommitOid = git(repo, "rev-parse", "HEAD");

    // a further commit with no labs/ path.
    writeFileSync(join(repo, "src", "b.txt"), "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "public-only change");
    cleanCommitOid = git(repo, "rev-parse", "HEAD");
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const PUBLIC = "https://github.com/loopdive/js2wasm.git";
  const LEGACY = "https://github.com/loopdive/js2wasm.git";
  const FORK = "https://github.com/ttraenkler/js2.git";
  const LABS = "https://github.com/loopdive/js2wasm-labs.git";
  const UNKNOWN = "https://example.com/private/mirror.git";

  it("blocks labs/ on an update push to the canonical public remote", () => {
    const line = `refs/heads/topic ${labsCommitOid} refs/heads/topic ${baseOid}`;
    const r = runGuard(repo, "origin", PUBLIC, [line]);
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/labs\/example\.txt/);
  });

  it("blocks labs/ identically on the legacy loopdive/js2wasm origin", () => {
    const line = `refs/heads/topic ${labsCommitOid} refs/heads/topic ${baseOid}`;
    const r = runGuard(repo, "origin", LEGACY, [line]);
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/legacy|labs\/example\.txt/);
  });

  it("blocks labs/ on a public fork URL", () => {
    const line = `refs/heads/topic ${labsCommitOid} refs/heads/topic ${baseOid}`;
    expect(runGuard(repo, "fork", FORK, [line]).status).toBe(1);
  });

  it("blocks labs/ on a new-branch push (merge-base vs origin/main)", () => {
    const line = `refs/heads/topic ${labsCommitOid} refs/heads/topic ${NULL_OID}`;
    const r = runGuard(repo, "origin", PUBLIC, [line]);
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/labs\/example\.txt/);
  });

  it("fails safe: blocks labs/ on an unknown/unconfirmed remote", () => {
    const line = `refs/heads/topic ${labsCommitOid} refs/heads/topic ${baseOid}`;
    expect(runGuard(repo, "mirror", UNKNOWN, [line]).status).toBe(1);
  });

  it("allows the intentional labs remote to receive labs/ content", () => {
    const line = `refs/heads/topic ${labsCommitOid} refs/heads/topic ${baseOid}`;
    const r = runGuard(repo, "labs", LABS, [line]);
    expect(r.status).toBe(0);
  });

  it("allows a public push whose diff has no labs/ paths", () => {
    const line = `refs/heads/topic ${cleanCommitOid} refs/heads/topic ${labsCommitOid}`;
    expect(runGuard(repo, "origin", PUBLIC, [line]).status).toBe(0);
  });

  it("allows a delete ref (no diff to scan) to a public remote", () => {
    const line = `(delete) ${NULL_OID} refs/heads/topic ${labsCommitOid}`;
    expect(runGuard(repo, "origin", PUBLIC, [line]).status).toBe(0);
  });
});
