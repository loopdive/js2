// #3324 — module-init ordering cycle: entering the module graph via
// any-helpers.js (which pulls coercion-engine.ts BEFORE string-ops.ts, the
// same entry order as tests/issue-2949-s5-2-eq.test.ts) used to crash at
// IMPORT time with `ReferenceError: Cannot access 'boolToStringEmitter'
// before initialization`: string-ops.ts's top-level
// registerStringHelperEmitters(...) call ran while coercion-engine.ts was
// still mid-initialization and assigned its TDZ'd module-level `let` slots.
// The slots now live in the runtime-import-free string-emitter-registry leaf,
// which can never be partially initialized. The import ORDER below is the
// regression test — pre-fix, this file fails at collection, before any `it`.
import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
import { describe, expect, it } from "vitest";
import {
  getBoolToStringEmitter,
  getNativeStringRefFromExternrefEmitter,
} from "../src/codegen/string-emitter-registry.js";
import { compile } from "../src/index.ts";

describe("#3324 string-emitter registry survives coercion-engine-first module init", () => {
  it("the emitters are registered once the module graph is loaded", () => {
    // string-ops.ts is in this graph (pulled transitively via src/index.ts),
    // so its top-level registration must have completed without a TDZ crash.
    expect(typeof ensureAnyHelpers).toBe("function");
    expect(getBoolToStringEmitter()).toBeTypeOf("function");
    expect(getNativeStringRefFromExternrefEmitter()).toBeTypeOf("function");
  });

  it("bool-to-string coercion still works end-to-end standalone", async () => {
    // Return a number (a native-string struct would cross the boundary
    // opaquely): "true".length === 4 and content check in-wasm.
    const r = await compile(
      `export function test(): number {
         var b: any = true;
         var s = String(b);
         return s === "true" ? s.length : -1;
       }`,
      { target: "standalone" } as never,
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): unknown }).test()).toBe(4);
  });
});
