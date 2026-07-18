// (#2940) Runner vacuity scorer: a test whose harness-wrapper callback never
// executes (the dead-callback / dispatch-drop class) is scored `fail` +
// `vacuous:true`, NOT `pass` — so host_free_pass / the standalone floor
// structurally exclude it. A genuinely-executing callback stays `pass`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSyntheticTest262File } from "./test262-runner.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "js2-issue-2940-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const META = `/*---
description: vacuity scorer fixture
includes: [testTypedArray.js]
features: [TypedArray]
---*/
`;

async function score(name: string, body: string): Promise<{ status: string; vacuous: boolean }> {
  const path = `${SCRATCH}/${name}.js`;
  writeFileSync(path, META + body);
  const r = await runSyntheticTest262File(path, "built-ins", 20000, "standalone");
  return { status: r.status, vacuous: (r as { vacuous?: boolean }).vacuous ?? false };
}

describe("#2940 runner vacuity scorer", () => {
  it("dead harness callback (asserts inside, never runs) → fail + vacuous", async () => {
    // The nested-scope harness-wrapper callback is dropped by the inline dynamic
    // dispatch, so the assertion never runs and the test would vacuously "pass".
    // The scorer must catch it.
    //
    // NOTE (post-#2939): the #2939 dispatch fix now rescues all-externref-param
    // callbacks (e.g. `function(TA)` → any/externref), so that shape EXECUTES and
    // is no longer a dead callback. To keep exercising a genuinely-dropped
    // callback, this fixture uses a numeric-typed param — a shape #2939 does NOT
    // register as a dispatch candidate (its restriction is all-externref params +
    // externref/void return). It stays dropped → vacuous, so the scorer is still
    // validated. Verified 2026-07-02: `function(TA: number)` → fail + vacuous on
    // the merged tree, while `function(TA)` → genuine pass (executes).
    const { status, vacuous } = await score(
      "dead-callback",
      `testWithTypedArrayConstructors(function(TA: number) {
         assert.sameValue(1, 1, "this assert never runs when the callback is dropped");
       });`,
    );
    expect(status).toBe("fail");
    expect(vacuous).toBe(true);
  });

  it("a test with NO harness wrapper is never flagged vacuous", async () => {
    const { status, vacuous } = await score("no-harness", `assert.sameValue(2 + 2, 4, "plain assertion");`);
    expect(vacuous).toBe(false);
    expect(status).toBe("pass");
  });
});
