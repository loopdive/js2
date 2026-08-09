// #3409 — the pre-push prettier gate's watchdog must be PORTABLE: on a host
// with no GNU `timeout`/`gtimeout` (stock macOS) it must run `format:check`
// directly and return the command's REAL exit code, never a spurious 127 that
// the hook would mislabel as a format failure. These tests exercise the sourced
// POSIX-sh helper (scripts/hooks/format-gate.sh) directly — the same code
// `.husky/pre-push` sources — mirroring tests/hooks/pre-push-labs-remote.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "hooks", "format-gate.sh");

// Run `. LIB; <script>` under /bin/sh with a chosen PATH. Returns exit status +
// combined output. `pathEnv` overrides the child PATH (empty dir = no watchdog).
function runSh(script: string, args: string[], pathEnv?: string): { status: number; output: string } {
  try {
    const out = execFileSync("/bin/sh", ["-c", `. "$0"; ${script}`, LIB, ...args], {
      encoding: "utf8",
      env: pathEnv === undefined ? process.env : { ...process.env, PATH: pathEnv },
    });
    return { status: 0, output: out };
  } catch (e: any) {
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("#3409 pre-push format-gate watchdog", () => {
  let dir: string;
  let emptyPath: string;
  let OK: string;
  let FAIL: string;
  let HANG: string;

  // Is a real watchdog available in the ambient env? The watchdog-present cases
  // (which need GNU `timeout`) are skipped on hosts without one (e.g. macOS),
  // where the whole point is that the no-watchdog path takes over.
  const ambientWatchdog = runSh("find_watchdog", []).output.trim();
  const HAS_WATCHDOG = ambientWatchdog.length > 0;

  const stub = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fmt-gate-"));
    emptyPath = join(dir, "emptybin");
    mkdirSync(emptyPath, { recursive: true });
    OK = join(dir, "ok.sh");
    FAIL = join(dir, "fail.sh");
    HANG = join(dir, "hang.sh");
    stub(OK, 'echo "all good"; exit 0');
    stub(FAIL, 'echo "[warn] src/x.ts"; exit 1');
    stub(HANG, "sleep 5; exit 0");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("find_watchdog names timeout/gtimeout when present, nothing when PATH is bare", () => {
    if (HAS_WATCHDOG) {
      expect(["timeout", "gtimeout"]).toContain(runSh("find_watchdog", []).output.trim());
    }
    // With an empty PATH, neither binary resolves → empty.
    expect(runSh("find_watchdog", [], emptyPath).output.trim()).toBe("");
  });

  it.skipIf(!HAS_WATCHDOG)("watchdog present: success passes through (rc 0, output captured)", () => {
    const r = runSh('run_format_watchdog 90 "$1"', [OK]);
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/all good/);
  });

  it.skipIf(!HAS_WATCHDOG)("watchdog present: a genuine format failure blocks (rc 1)", () => {
    const r = runSh('run_format_watchdog 90 "$1"', [FAIL]);
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/\[warn\] src\/x\.ts/);
  });

  it.skipIf(!HAS_WATCHDOG)("watchdog present: a hung check yields the 124 timeout code, not a format failure", () => {
    const r = runSh('run_format_watchdog 1 "$1"', [HANG]);
    expect(r.status).toBe(124);
  });

  // The load-bearing regression: no `timeout`/`gtimeout` on PATH.
  it("no watchdog on PATH: success returns 0, NOT a spurious 127", () => {
    const r = runSh('run_format_watchdog 90 "$1"', [OK], emptyPath);
    expect(r.status).toBe(0);
    expect(r.status).not.toBe(127);
    expect(r.output).toMatch(/all good/);
  });

  it("no watchdog on PATH: a real format failure is still reported (rc 1)", () => {
    const r = runSh('run_format_watchdog 90 "$1"', [FAIL], emptyPath);
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/\[warn\] src\/x\.ts/);
  });

  it("no watchdog on PATH: emits the 'running without a watchdog' notice to stderr", () => {
    // Merge stderr so the success-path notice (helper writes it to fd 2) is
    // visible to execFileSync, which otherwise returns only stdout on exit 0.
    const r = runSh('run_format_watchdog 90 "$1" 2>&1', [OK], emptyPath);
    expect(r.output).toMatch(/without a local .*watchdog/);
  });
});
