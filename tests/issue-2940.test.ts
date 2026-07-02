// (#2940) Runner vacuity scorer: a test whose harness-wrapper callback never
// executes (the dead-callback / dispatch-drop class) is scored `fail` +
// `vacuous:true`, NOT `pass` — so host_free_pass / the standalone floor
// structurally exclude it. A genuinely-executing callback stays `pass`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.ts";

const SCRATCH = "/workspace/test262/test/zz-issue-2940";
mkdirSync(SCRATCH, { recursive: true });
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
  const r = await runTest262File(path, "built-ins", 20000, "standalone");
  return { status: r.status, vacuous: (r as { vacuous?: boolean }).vacuous ?? false };
}

describe("#2940 runner vacuity scorer", () => {
  it("dead harness callback (asserts inside, never runs) → fail + vacuous", async () => {
    // Under standalone WITHOUT the #2939 dispatch fix, this nested-scope callback
    // is dropped by the inline dynamic dispatch, so the assertion never runs and
    // the test would vacuously "pass". The scorer must catch it.
    const { status, vacuous } = await score(
      "dead-callback",
      `testWithTypedArrayConstructors(function(TA) {
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
