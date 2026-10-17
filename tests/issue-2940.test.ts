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
    // The scorer flags a harness-wrapper callback that is invoked but runs ZERO
    // assertions (__harness_cb_dead === __harness_cb_expected). Historically the
    // fixture produced that state with a compiler bug: `function(TA: number)`
    // was not a #2939 dispatch candidate, so the callback was silently dropped.
    // That bug is fixed — re-measured 2026-10-17 on upstream main 0727e2985b,
    // the numeric-param callback now RUNS and its assert executes (genuine
    // pass), so the old fixture no longer exercised the scorer (#7014 wave 15).
    // The fixture now makes the callback's only assertion unreachable in plain
    // JS (every TA is a function), which is the exact runtime state the scorer
    // must catch regardless of WHY the assertions never ran. The top-level
    // assert runs, so the general (#3086) gate stays silent and this exercises
    // the harness (partial-vacuity) gate specifically.
    const { status, vacuous } = await score(
      "dead-callback",
      `assert.sameValue(1, 1, "setup assertion that does run");
       testWithTypedArrayConstructors(function(TA) {
         if (typeof TA !== "function") {
           assert.sameValue(1, 1, "this assert never runs");
         }
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
