// (#3086) GENERAL (non-harness) vacuity gate + PARTIAL harness vacuity.
//
// The #2463 scorer only flagged a would-be pass as vacuous when a
// testWith*Constructors HARNESS wrapper was invoked with zero counted asserts.
// #3086 adds a GENERAL gate: a would-be pass whose body HAS executable
// assertions (any `assert.*`/bare `assert(` → `assert_*` helper) but executed
// ZERO of them (__assert_count stayed at 1) asserted nothing — every assertion
// sat inside a callback/body that never ran (the dropped-nested-callback class).
// It must NOT flag a test whose callback genuinely runs (its assert bumps the
// counter), nor a throw-based test with no assert_* calls.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSyntheticTest262File } from "./test262-runner.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "js2-issue-3086-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const META = `/*---\ndescription: #3086 general vacuity fixture\n---*/\n`;

async function score(name: string, body: string): Promise<{ status: string; vacuous: boolean }> {
  const path = `${SCRATCH}/${name}.js`;
  writeFileSync(path, META + body);
  // Standalone lane. The vacuous fixtures below make their assertions
  // unreachable in plain JS — a deterministic stand-in for the
  // dropped-nested-callback class (the scorer sees the same runtime state).
  const r = await runSyntheticTest262File(path, "built-ins", 20000, "standalone");
  return { status: r.status, vacuous: (r as { vacuous?: boolean }).vacuous ?? false };
}

describe("#3086 general (non-harness) vacuity gate", () => {
  it("non-harness dropped callback holding the only assertion → fail + vacuous", async () => {
    const { status, vacuous } = await score(
      "nonharness-dropped",
      // (#7014 wave 15) The fixture used to rely on the compiler DROPPING a
      // numeric-param callback (`fn(x)` with `v: number` was not a #2939
      // dispatch candidate). That bug is fixed — re-measured 2026-10-17 on
      // upstream main 0727e2985b the callback runs and its false assert is a
      // genuine fail — so the callback is now never invoked in plain JS instead.
      `function apply(fn: any, x: any): void { if (x > 10) fn(x); }
       apply(function(v: number) { assert.sameValue(1, 2, "never runs"); }, 5);`,
    );
    expect(status).toBe("fail");
    expect(vacuous).toBe(true);
  });

  it("validators-array (validators[i](v)) dropped closure → fail + vacuous", async () => {
    const { status, vacuous } = await score(
      "validators-dropped",
      // (#7014 wave 15) As above: the closure is no longer dropped by the
      // compiler, so the loop bound now skips it in plain JS.
      `const validators: any[] = [function(v: number){ assert.sameValue(1, 2, "never runs"); }];
       for (let i = 0; i < validators.length - 1; i++) { validators[i](7); }`,
    );
    expect(status).toBe("fail");
    expect(vacuous).toBe(true);
  });

  it("genuine top-level assertion → pass (never flagged)", async () => {
    const { status, vacuous } = await score("genuine-pass", `assert.sameValue(2 + 2, 4, "genuine");`);
    expect(status).toBe("pass");
    expect(vacuous).toBe(false);
  });

  it("callback that genuinely RUNS its assert → pass (not flagged)", async () => {
    const { status, vacuous } = await score(
      "callback-runs",
      `function apply(fn: any, x: any): void { fn(x); }
       apply(function(v) { assert.sameValue(1, 1, "runs"); }, 5);`,
    );
    expect(status).toBe("pass");
    expect(vacuous).toBe(false);
  });

  it("a running callback with a FALSE assert is a GENUINE fail, not vacuous", async () => {
    // Proves the general gate does not over-fire: the callback DID run (its
    // assert bumped the counter and genuinely failed), so it is a real fail.
    const { status, vacuous } = await score(
      "callback-runs-false",
      `function apply(fn: any, x: any): void { fn(x); }
       apply(function(v) { assert.sameValue(1, 2, "runs-and-fails"); }, 5);`,
    );
    expect(status).toBe("fail");
    expect(vacuous).toBe(false);
  });

  it("throw-based test with no assert_* calls → pass (general gate not emitted)", async () => {
    const { status, vacuous } = await score("throw-based", `if (2 + 2 !== 4) { throw new Test262Error("nope"); }`);
    expect(status).toBe("pass");
    expect(vacuous).toBe(false);
  });
});
