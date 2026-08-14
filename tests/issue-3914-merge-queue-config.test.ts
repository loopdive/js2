// #3914 — `scripts/set-merge-queue-config.sh` rewrites the LIVE `main` ruleset.
// A ruleset PUT is replace-style, so a bug in its jq transform does not fail
// loudly — it silently drops required status checks or bypass actors and the
// repo's gates quietly stop existing. These tests run the real script against a
// stubbed `gh` so the transform is exercised end to end without network.
//
// Two invariants are load-bearing:
//   1. PRESERVE — everything that is not a merge_queue parameter survives the
//      round trip byte-for-byte (required checks, bypass actors, conditions,
//      enforcement). This is what makes the script safe to interleave with
//      `enable-branch-protection.sh`, which does the mirror image.
//   2. REFUSE SPECULATION — `max_entries_to_build > 1` is the setting that was
//      tried and reverted (#1956 -> #2519/#2522), and the only one that makes a
//      queue change eject other PRs' in-flight runs. It must not be reachable by
//      accident.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/set-merge-queue-config.sh", import.meta.url));

// A ruleset shaped like the live one: a merge_queue rule to rewrite, plus
// required_status_checks / bypass_actors / conditions that must be preserved.
const FIXTURE_RULESET = {
  id: 16700772,
  name: "main protection",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  bypass_actors: [{ actor_id: 1, actor_type: "DeployKey", bypass_mode: "always" }],
  rules: [
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "quality" }, { context: "merge shard reports" }],
      },
    },
    {
      type: "merge_queue",
      parameters: {
        check_response_timeout_minutes: 60,
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: 1,
        max_entries_to_merge: 1,
        merge_method: "MERGE",
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 5,
      },
    },
  ],
};

let dir: string;
let env: NodeJS.ProcessEnv;

/** Run the script with a stubbed `gh` on PATH. Returns {status, stdout, stderr}. */
function run(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mq-config-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "ruleset.json"), JSON.stringify(FIXTURE_RULESET));

  // Stub `gh`: a bare `gh api <path>` (the read) prints the fixture; a
  // `gh api -X PUT ...` (the write) records its stdin payload instead of
  // touching the network. Anything else is a hard error so an unexpected call
  // surfaces as a test failure rather than a silent pass.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'for a in "$@"; do',
      '  if [ "$a" = "PUT" ]; then cat > "$MQ_TEST_DIR/put-payload.json"; exit 0; fi',
      "done",
      'cat "$MQ_TEST_DIR/ruleset.json"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);

  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MQ_TEST_DIR: dir,
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("#3914 set-merge-queue-config.sh", () => {
  it("--show prints the live merge_queue parameters and applies nothing", () => {
    const r = run(["--show"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LIVE merge_queue parameters");
    expect(r.stdout).toContain('"max_entries_to_merge": 1');
    // --show must never reach the write path.
    expect(r.stdout).not.toContain("Applying via gh api");
  });

  it("defaults to the canonical batch cap of 5 with speculation held at 1", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(execFileSync("cat", [join(dir, "put-payload.json")], { encoding: "utf8" }));
    const mq = payload.rules.find((x: { type: string }) => x.type === "merge_queue").parameters;
    expect(mq.max_entries_to_merge).toBe(5);
    // The floor stays 1: raising the cap is latency-free, raising the floor is not.
    expect(mq.min_entries_to_merge).toBe(1);
    // The setting that caused the 2026-06-20 wedge stays at 1.
    expect(mq.max_entries_to_build).toBe(1);
  });

  it("preserves merge_queue parameters it does not own", () => {
    run([]);
    const payload = JSON.parse(execFileSync("cat", [join(dir, "put-payload.json")], { encoding: "utf8" }));
    const mq = payload.rules.find((x: { type: string }) => x.type === "merge_queue").parameters;
    expect(mq.merge_method).toBe("MERGE");
    expect(mq.grouping_strategy).toBe("ALLGREEN");
    expect(mq.check_response_timeout_minutes).toBe(60);
    expect(mq.min_entries_to_merge_wait_minutes).toBe(5);
  });

  it("preserves required status checks, bypass actors and conditions verbatim", () => {
    run([]);
    const payload = JSON.parse(execFileSync("cat", [join(dir, "put-payload.json")], { encoding: "utf8" }));
    const checks = payload.rules.find((x: { type: string }) => x.type === "required_status_checks").parameters;
    expect(checks.required_status_checks).toEqual([{ context: "quality" }, { context: "merge shard reports" }]);
    expect(payload.bypass_actors).toEqual(FIXTURE_RULESET.bypass_actors);
    expect(payload.conditions).toEqual(FIXTURE_RULESET.conditions);
    expect(payload.enforcement).toBe("active");
    // Unrelated rules survive.
    expect(payload.rules.some((x: { type: string }) => x.type === "deletion")).toBe(true);
  });

  it("REFUSES to re-enable speculative building without the explicit override", () => {
    const r = run([], { MAX_ENTRIES_TO_BUILD: "5" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("REFUSED");
    expect(r.stderr).toContain("SPECULATIVE");
    // The refusal must point at the batching knob that actually helps.
    expect(r.stderr).toContain("MAX_ENTRIES_TO_MERGE");
  });

  it("refuses a quorum floor above the batch cap", () => {
    const r = run([], { MIN_ENTRIES_TO_MERGE: "6", MAX_ENTRIES_TO_MERGE: "5" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("REFUSED");
  });

  it("--check reports the diff without writing", () => {
    rmSync(join(dir, "put-payload.json"), { force: true });
    const r = run(["--check"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(() => execFileSync("cat", [join(dir, "put-payload.json")])).toThrow();
  });
});
