// #2039 — standalone invalid-Wasm residual: pending-late-import-batch over-shift
// corrupting native defined-function registration (`__obj_find` sub-bucket).
//
// Under `--target standalone`, the async-generator `.next()` plumbing requests
// host bridges via `ensureLateImport`, which DEFERS the index shift
// (ctx.pendingLateImportShift). When the first dynamic-object operation
// (`__extern_get_idx` on the Promise.all results array) arrives inside that
// same un-flushed batch, it routes to `ensureObjectRuntime`, whose
// `registerNative` bakes funcIdx values from the post-batch `numImportFuncs` —
// already final-correct. The deferred flush then added its delta on top,
// leaving every object-runtime internal sibling call and funcMap entry one
// regime too high: `__obj_find`'s `call $__obj_hash` resolved to
// `$__new_plain_object` (returns externref) → `i32.and[0] expected type i32,
// found call of type externref` at instantiate. 146 test262 binaries in the
// 2026-06-10 standalone baseline failed validation this way.
//
// Fix: `ensureObjectRuntime` and `addUnionImports` now end any pending batch
// (`flushLateImportShifts(ctx, null)`) before registering defined functions,
// so registration always happens in a settled index regime.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function compilesValidWasm(source: string, target?: "standalone"): Promise<true> {
  const result = await compile(source, { fileName: "test.ts", target, skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  // Throws if the module fails Wasm validation — this is the assertion.
  await WebAssembly.compile(result.binary);
  return true;
}

// Distilled from language/statements/class/elements/
// after-same-line-static-method-rs-static-async-generator-method-privatename-identifier.js.
// The async generator opens a deferred late-import batch (Promise_*,
// __array_from_iter); `results[0].value` inside the .then callback is the
// first dynamic-object get and initializes the object runtime mid-batch.
const ASYNC_GEN_PROMISE_ALL = `/*---
flags: [async]
features: [async-iteration]
---*/
async function* g(v) { yield * await v; }
Promise.all([g([1]).next()]).then(results => {
  assert.sameValue(results[0].value, 1);
}).then($DONE, $DONE);
`;

describe("#2039 pending-late-import-batch over-shift of native registrations", () => {
  it("standalone: object runtime initialized inside a deferred import batch stays valid", async () => {
    const meta = parseMeta(ASYNC_GEN_PROMISE_ALL);
    const { source: wrapped } = wrapTest(ASYNC_GEN_PROMISE_ALL, meta);
    expect(await compilesValidWasm(wrapped, "standalone")).toBe(true);
  });

  it("standalone: class with static async-gen private method + hasOwnProperty stays valid", async () => {
    const src = `/*---
flags: [async]
features: [async-iteration, class-static-methods-private]
---*/
class C {
  static m() { return 42; }
  static async * #g(value) { yield * await value; }
  static get $() { return this.#g; }
}
var c = new C();
assert.sameValue(C.m(), 42);
assert(!Object.prototype.hasOwnProperty.call(c, "m"), "msg");
Promise.all([C.$([1]).next()]).then(results => {
  assert.sameValue(results[0].value, 1);
}).then($DONE, $DONE);
`;
    const meta = parseMeta(src);
    const { source: wrapped } = wrapTest(src, meta);
    expect(await compilesValidWasm(wrapped, "standalone")).toBe(true);
  });

  it("host-mode guard: the same wrapped source stays valid on the default path", async () => {
    // The flush guards must be inert in JS-host mode (no native registration
    // is reachable from a pending batch there today; this pins that).
    const meta = parseMeta(ASYNC_GEN_PROMISE_ALL);
    const { source: wrapped } = wrapTest(ASYNC_GEN_PROMISE_ALL, meta);
    expect(await compilesValidWasm(wrapped)).toBe(true);
  });
});
