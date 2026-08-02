// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3036 — a callback handed to a REAL host Promise (via the DEFERRED
 * combinators `Promise.allSettled`/`Promise.any`, which have no native
 * lowering in `src/codegen/promise-combinators.ts`) fires on a genuine Node
 * microtask AFTER the synchronous `run()` window has already returned. At the
 * time #3036 was filed (2026-07-05, base 7f90320ea) that late invocation
 * null-dereferenced the WASM closure-bridge trampoline
 * (`wasmClosureBridge`, src/runtime.ts): the bridge resolves exports lazily
 * via a module-level `callbackState.getExports()`, so once a SECOND instance
 * had called `setExports`, the first instance's late microtask invoked the
 * wrong instance's `__call_fn_*` with a stale closure ref →
 * `RuntimeError: dereferencing a null pointer` inside `__closure_*`.
 *
 * The #3035 test (`tests/issue-3035.test.ts`) had to install
 * `process.on("uncaughtException", () => {})` to SWALLOW exactly this crash so
 * it would not look like a regression that PR introduced.
 *
 * This crash no longer reproduces on current `origin/main` — it was resolved
 * incidentally by the post-#3035 async-carrier / closure-lifetime hardening
 * line (#2978/#2980/#3035). This regression test locks the fix in: it drives
 * the exact original trigger (a late `Promise.allSettled(...).then` microtask,
 * including the multi-instance export-swap that made the bridge resolve the
 * WRONG instance's exports) and asserts the callback fires cleanly with NO
 * closure-bridge crash. It deliberately does NOT swallow uncaughtException —
 * a reintroduced null-deref surfaces as a captured error and fails the assert.
 *
 * No `JS2WASM_ASYNC_CARRIER_WIDEN` is needed (issue: "no widen needed").
 */

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

const SRC = `
  let out = 0;
  export function run(): void { Promise.allSettled([]).then(() => { out = 1; }); }
  export function getOut(): number { return out; }
`;

async function makeInstance(): Promise<{ run: () => void; getOut: () => number }> {
  const r = await compile(SRC, { fileName: "t.ts", target: "standalone" });
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // Point the module-level callback bridge at THIS instance's exports — the
  // very act that, before the fix, let a prior instance's late microtask
  // dispatch against the wrong instance's `__call_fn_*`.
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return instance.exports as unknown as { run: () => void; getOut: () => number };
}

/**
 * Run `body`, then drain microtasks + a real macrotask window, capturing any
 * late `uncaughtException` / `unhandledRejection` that fires OUTSIDE the
 * synchronous call — that is precisely where the #3036 crash landed.
 */
async function runCapturingLateErrors(body: () => Promise<void> | void): Promise<Error[]> {
  const captured: Error[] = [];
  const onUncaught = (e: Error) => captured.push(e);
  const onRejected = (e: unknown) => captured.push(e instanceof Error ? e : new Error(String(e)));
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejected);
  try {
    await body();
    // Late real-Promise microtask fires here (after the sync window). Give it
    // both a microtask flush and a generous macrotask window.
    await new Promise((res) => setTimeout(res, 200));
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejected);
  }
  return captured;
}

describe("#3036 — late allSettled().then microtask must not null-deref the closure bridge", () => {
  it("single instance: the late callback fires cleanly and sets the module global", async () => {
    let inst!: { run: () => void; getOut: () => number };
    const errors = await runCapturingLateErrors(async () => {
      inst = await makeInstance();
      inst.run();
    });
    expect(errors, `late microtask crashed the closure bridge: ${errors[0]?.message}`).toHaveLength(0);
    // The callback actually ran (out flipped 0 -> 1), i.e. it was invoked and
    // did not silently no-op.
    expect(inst.getOut()).toBe(1);
  });

  it("back-to-back instances: an earlier instance's late microtask survives a later instance's setExports swap", async () => {
    const instances: Array<{ run: () => void; getOut: () => number }> = [];
    const errors = await runCapturingLateErrors(async () => {
      // Create + run three instances in one process. Each `makeInstance`
      // re-points the global callback bridge at the newest instance, so the
      // earlier instances' still-pending `.then` microtasks would, under the
      // original bug, dispatch against the LAST instance's exports with a
      // stale closure ref.
      for (let i = 0; i < 3; i++) {
        const inst = await makeInstance();
        inst.run();
        instances.push(inst);
      }
    });
    expect(errors, `a detached late microtask crashed the closure bridge: ${errors[0]?.message}`).toHaveLength(0);
    // Every instance's own callback ran against its own module global.
    for (const inst of instances) expect(inst.getOut()).toBe(1);
  });
});
