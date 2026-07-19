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
  // Standalone lane: a numeric-typed callback param is NOT a #2939 dispatch
  // candidate, so `fn(x)` drops it — an isolated, deterministic stand-in for the
  // dropped-nested-callback class.
  const r = await runSyntheticTest262File(path, "built-ins", 20000, "standalone");
  return { status: r.status, vacuous: (r as { vacuous?: boolean }).vacuous ?? false };
}

describe("#3086 general (non-harness) vacuity gate", () => {
  it("non-harness dropped callback holding the only assertion → fail + vacuous", async () => {
    const { status, vacuous } = await score(
      "nonharness-dropped",
      `function apply(fn: any, x: any): void { fn(x); }
       apply(function(v: number) { assert.sameValue(1, 2, "SHOULD FAIL but callback dropped"); }, 5);`,
    );
    expect(status).toBe("fail");
    expect(vacuous).toBe(true);
  });

  it("validators-array (validators[i](v)) dropped closure → fail + vacuous", async () => {
    const { status, vacuous } = await score(
      "validators-dropped",
      `const validators: any[] = [function(v: number){ assert.sameValue(1, 2, "dropped"); }];
       for (let i = 0; i < validators.length; i++) { validators[i](7); }`,
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
