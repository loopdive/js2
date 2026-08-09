// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3429 — assert.throws' EXPECTED-constructor argument leaked the internal
// implementation name "wasmClosureDynamicBridge" instead of the real
// constructor identity when the argument crossed the JS-host boundary
// (`__extern_method_call`). Native builtins (TypeError, RangeError, ...) were
// unaffected — they're never wrapped by the closure bridge — so only
// USER-DEFINED constructors passed by identifier (the pervasive test262
// `function MyError(){}; assert.throws(MyError, fn)` idiom) hit the bug.
//
// Root cause (NOT the architect's original "receiver shift" hypothesis, which
// was empirically disproven — args cross unshifted, in the right order/count):
// `_wrapWasmClosureUnknownArity` (runtime.ts) wraps a compiled closure
// crossing to host in a JS function literally named `wasmClosureDynamicBridge`
// (its own declared function name). Reading `.name` on that bridge — which is
// exactly what test262/harness/assert.js's `assert.throws` does to build its
// failure message and (implicitly) compare constructor identity — returned
// the bridge's own name, not the wrapped closure's.
//
// Fix: `maybeStampCompiledFunctionArgName` (src/codegen/expressions/helpers.ts)
// stamps the REAL declared name onto a host-crossing argument via
// `__extern_set(val, "name", <staticName>)`, BEFORE the value crosses, when
// the argument expression is statically a bare Identifier bound to a named,
// user-compiled FunctionDeclaration/FunctionExpression/ClassDeclaration
// (never an ambient `declare`d builtin). `_wrapWasmClosureUnknownArity` then
// reads that stamp (`_wasmStructProps` sidecar) and surfaces the real name.
// Wired at the three JS-host call sites that marshal arguments across
// `__extern_method_call` (call-receiver-method.ts's #799 WI3 generic
// dispatch, calls.ts's fnctor-subclass dynamic dispatch, new-super.ts's
// super-extern-method dispatch).
//
// KNOWN LIMITATION (documented, not a regression target for THIS fix): a
// SEPARATE, pre-existing bug (#3486) means a caught custom-exception
// instance's `.constructor` resolves to a generic "Array"-named mirror
// rather than the real constructor — so `assert.throws(MyError, () => {
// throw new MyError() })` does not fully PASS yet even after this fix (it
// fails with a DIFFERENT, correctly-named message instead of the
// "wasmClosureDynamicBridge" one). This test file verifies exactly what
// THIS fix does: the bridge-name string is gone and the real name
// substitutes, plus the native-builtin control case stays green.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const tempRoot = mkdtempSync(join(tmpdir(), "js2wasm-3429-"));

function writeTest(name: string, body: string): string {
  const file = join(tempRoot, name);
  writeFileSync(file, body);
  return file;
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("#3429 assert.throws expected-constructor identity no longer leaks wasmClosureDynamicBridge", () => {
  it("control: assert.throws(TypeError, thrower) already passes (native builtins unaffected)", async () => {
    const file = writeTest(
      "native-ctor.js",
      `/*---
description: minimal assert.throws with a native builtin constructor
---*/
assert.throws(TypeError, function () { throw new TypeError(); });
`,
    );
    const result = await runTest262File(file, "issue-3429");
    expect(result.status).toBe("pass");
  }, 30_000);

  it("a user-defined constructor's real name substitutes for the bridge name in the failure message", async () => {
    // This specific test genuinely THROWS a TypeError, not a MyError, so
    // assert.throws' identity check correctly fails — but the message must
    // name the real EXPECTED constructor ("MyError"), never the internal
    // bridge implementation name.
    const file = writeTest(
      "user-ctor-name.js",
      `/*---
description: assert.throws' expected-constructor argument keeps its real name
---*/
function MyError(message) {
  this.message = message;
}
assert.throws(MyError, function () { throw new TypeError("wrong kind"); });
`,
    );
    const result = await runTest262File(file, "issue-3429");
    expect(result.status).toBe("fail"); // genuinely a different thrown type — correct to fail
    const message = result.error ?? "";
    expect(message).not.toContain("wasmClosureDynamicBridge");
    expect(message).toContain("Expected a MyError");
  }, 30_000);

  it("a harness-defined constructor (Test262Error) also keeps its real name", async () => {
    const file = writeTest(
      "test262error-name.js",
      `/*---
description: assert.throws(Test262Error, ...) keeps the real harness constructor name
---*/
assert.throws(Test262Error, function () { throw new TypeError("wrong kind"); });
`,
    );
    const result = await runTest262File(file, "issue-3429");
    expect(result.status).toBe("fail"); // genuinely a different thrown type — correct to fail
    const message = result.error ?? "";
    expect(message).not.toContain("wasmClosureDynamicBridge");
    expect(message).toContain("Expected a Test262Error");
  }, 30_000);

  it("no-throw case: the expected-constructor name is correct even when nothing is thrown", async () => {
    const file = writeTest(
      "user-ctor-nothrow.js",
      `/*---
description: assert.throws(MyError, ...) no-throw message names the real constructor
---*/
function MyError(message) {
  this.message = message;
}
assert.throws(MyError, function () { /* does not throw */ });
`,
    );
    const result = await runTest262File(file, "issue-3429");
    expect(result.status).toBe("fail");
    const message = result.error ?? "";
    expect(message).not.toContain("wasmClosureDynamicBridge");
    expect(message).toContain("Expected a MyError to be thrown but no exception was thrown at all");
  }, 30_000);
});
