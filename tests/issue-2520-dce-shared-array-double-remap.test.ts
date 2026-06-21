// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2520 (regression) — dead-import elimination must remap a SHARED instruction
 * object exactly once.
 *
 * Root cause of the −84 standalone floor breach (#2097) that #1787's lib-scan
 * host-import gating exposed: `eliminateDeadImports` (src/codegen/dead-elimination.ts)
 * removes a dead func import and chains every `call`/`struct.new`/… funcIdx down
 * via `remapFuncIdxInBody` / `remapTypeIdxInBody`, which drive `walkInstructions`.
 * That walker visits an instruction once PER OCCURRENCE in the body tree, so when
 * the SAME `Instr` object is aliased into more than one position, a mutate-in-place
 * remapper applied the chained remap to it TWICE (e.g. 53→52 then 52→51).
 *
 * The native DataView setter's §24.2.1 bounds-RangeError template (`rangeThrow` in
 * emitDataViewAccessor) is the trigger: the SAME array is spliced into both the
 * ToIndex `if.then` (step 4) and the bounds `if.then` (step 8). When DCE then
 * dropped a dead import, the shared template's `call __new_RangeError` (an
 * externref-returning ctor) got shifted down twice, landing on `__to_bigint`
 * (i64-returning) → invalid Wasm `throw[0] expected type externref, found call of
 * type i64` on ~132 built-ins/DataView tests under --target standalone.
 *
 * Fix: the DCE remappers dedupe shared instruction objects (a `WeakSet<Instr>`),
 * so an aliased template is remapped exactly once regardless of how many times the
 * walker reaches it — closing the documented #1302 shared-array double-shift
 * hazard at the sink rather than per-producer.
 *
 * This reproduces the exact shape: a standalone module with (a) a user
 * constructor `new T262Error()` whose host ctor import is dead-eliminated (forcing
 * the funcIdx remap) and (b) a DataView setter whose poisoned value throws inside
 * a callback — the same `assert.throws(fn)` closure shape as the failing test262
 * cluster. The assertion is module VALIDITY (V8 rejects the double-remapped call).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile in standalone mode and assert the binary passes V8 validation. */
async function expectValidStandalone(src: string): Promise<void> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // WebAssembly.validate runs full function-body validation — it is what caught
  // the double-remapped `throw (call ...i64)` that `eliminateDeadImports`
  // produced. A symbolic disassembly looks fine; only V8's index-resolved
  // validation rejects it.
  expect(WebAssembly.validate(r.binary), "compiled standalone module must validate").toBe(true);
}

describe("#2520 DCE shared-array double-remap (standalone DataView bounds throw)", () => {
  it("DataView setter with a poisoned value in a throwing closure validates", async () => {
    // Mirrors built-ins/DataView/prototype/setInt16/range-check-after-value-conversion.js:
    // the poisoned valueOf throws inside the assert callback, and the setter's
    // shared RangeError bounds-throw template must survive the dead-import remap.
    await expectValidStandalone(`
      class T262Error {}
      function runner(fn: () => void): number { try { fn(); } catch (e) { return 1; } return 0; }
      const poisoned = { valueOf: function () { throw new T262Error(); } };
      export function test(): number {
        return runner(function () {
          const dv = new DataView(new ArrayBuffer(8), 0);
          dv.setInt16(100, poisoned as unknown as number);
        });
      }
    `);
  });

  it("DataView getter bounds throw validates with a dead-eliminated user ctor import", async () => {
    await expectValidStandalone(`
      class T262Error {}
      function runner(fn: () => void): number { try { fn(); } catch (e) { return 1; } return 0; }
      export function test(): number {
        let n = 0;
        n += runner(function () { const dv = new DataView(new ArrayBuffer(8)); dv.getInt32(-1); });
        n += runner(function () { const dv = new DataView(new ArrayBuffer(8)); dv.getFloat64(100); });
        // Force a user-class host ctor (dead-eliminated standalone) into the module.
        n += runner(function () { throw new T262Error(); });
        return n;
      }
    `);
  });

  it("DataView setter index-throw AND bounds-throw (both share the template) validate", async () => {
    await expectValidStandalone(`
      class T262Error {}
      function runner(fn: () => void): number { try { fn(); } catch (e) { return 1; } return 0; }
      const poisoned = { valueOf: function () { throw new T262Error(); } };
      export function test(): number {
        let n = 0;
        // index throw (NaN/negative, step 4) — uses the shared rangeThrow
        n += runner(function () { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(-1, 5); });
        // bounds throw (step 8, after ToNumber) — uses the SAME rangeThrow object
        n += runner(function () { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(100, poisoned as unknown as number); });
        return n;
      }
    `);
  });
});
