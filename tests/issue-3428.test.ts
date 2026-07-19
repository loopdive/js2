// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3428 — the test262 host lane never observed the async completion marker.
//
// The literal harness signals async completion via
//   $DONE()  →  __consolePrintHandle__(marker)  →  print(marker)  →  console.log(marker)
// and the worker captures `console.log` through an injected proxy so it can poll
// `harnessOutput` for `Test262:AsyncTestComplete`. Two independent gaps broke
// this on ~4.8k async tests:
//
//   A (4,617 "async completion marker not observed"). Two sub-causes:
//     A1. `resolveImport`'s `console_log` arm hard-coded the GLOBAL console and
//         ignored `deps.console`, so the capture proxy never saw the marker
//         (src/runtime.ts).
//     A2. The runtime shim's `var print = function (v) { console.log(v); }` is a
//         module-level closure. `registerModuleGlobal` skipped it whenever the
//         module ALSO referenced another host builtin (e.g. `String` inside
//         `$DONE`), because the whitelisted `print` host global occupied
//         `funcMap` first — so `print` never got a `$__mod_print` global,
//         `compileClosureCall` bailed, and `__consolePrintHandle__ → print`
//         emitted NOTHING. Fixed by only treating a *defined* function
//         (funcIdx >= numImportFuncs) as a shadowing user function
//         (src/codegen/declarations.ts).
//
//   B (225 "asyncTest called without async flag"). `asyncTest` guards on
//     `Object.prototype.hasOwnProperty.call(globalThis, "$DONE")`. A JS engine
//     running the harness as a SCRIPT exposes the top-level `function $DONE` as a
//     globalThis own-property; our compiled MODULE keeps it module-local, so the
//     guard threw. Fixed by exposing a stub `$DONE` own-property on the harness
//     sandbox globalThis (tests/test262-runner.ts + scripts/test262-worker.mjs).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const tempRoot = mkdtempSync(join(tmpdir(), "js2wasm-3428-"));

function writeTest(name: string, body: string): string {
  const file = join(tempRoot, name);
  writeFileSync(file, body);
  return file;
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("#3428 async completion marker observed in the host lane", () => {
  it("A: a synchronous $DONE() flips from 'not observed' to pass", async () => {
    const file = writeTest(
      "sync-done.js",
      `/*---
description: synchronous $DONE() must be observed as async completion
flags: [async]
---*/
$DONE();
`,
    );
    const result = await runTest262File(file, "issue-3428");
    expect(result.status).toBe("pass");
  }, 30_000);

  it("A: a deferred (real-async) $DONE() is observed as async completion", async () => {
    const file = writeTest(
      "async-done.js",
      `/*---
description: an async $DONE() must be observed as async completion
flags: [async]
---*/
Promise.resolve().then(function () { $DONE(); });
`,
    );
    const result = await runTest262File(file, "issue-3428");
    expect(result.status).toBe("pass");
  }, 30_000);

  it("A: a $DONE(error) failure is still surfaced as a real failure (not silently dropped)", async () => {
    const file = writeTest(
      "async-fail.js",
      `/*---
description: a $DONE(error) must surface as a failure, proving the marker chain runs
flags: [async]
---*/
$DONE(new Test262Error("intentional async failure"));
`,
    );
    const result = await runTest262File(file, "issue-3428");
    expect(result.status).toBe("fail");
    expect(result.error ?? "").toContain("intentional async failure");
  }, 30_000);

  it("B: asyncTest no longer throws 'asyncTest called without async flag'", async () => {
    const file = writeTest(
      "async-test.js",
      `/*---
description: asyncTest must run without the spurious no-async-flag guard throw
flags: [async]
includes: [asyncHelpers.js]
---*/
asyncTest(function () {
  return Promise.resolve(1).then(function (v) {
    assert.sameValue(v, 1);
  });
});
`,
    );
    const result = await runTest262File(file, "issue-3428");
    expect(result.status).toBe("pass");
    expect(result.error ?? "").not.toContain("asyncTest called without async flag");
  }, 30_000);
});
