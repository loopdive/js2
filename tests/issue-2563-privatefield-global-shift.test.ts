import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #2563 — Private-field/getter brand-check read on a receiver that is a
// closed-over MODULE-LEVEL variable produced an INVALID Wasm module.
//
// Root cause: the brand-check read path in property-access.ts compiles the
// receiver first (e.g. `global.get $self`), then swaps the function body out
// to a fresh buffer to capture the failure/throw branch. emitThrowTypeError
// adds the "Cannot read private member …" string-constant import LATE, which
// runs fixupModuleGlobalIndices to bump every module-global index. That fixup
// walks fctx.savedBodies — but the swap used a raw `savedBody = fctx.body;
// fctx.body = []` that never registered the saved buffer on savedBodies. So
// the already-emitted `global.get $self` kept its pre-shift index and read the
// neighbouring (f64) global instead → `any.convert_extern[0] expected
// externref, found global.get of type f64` (test262
// privatefieldget-typeerror-5.js, privatefieldget-success-1.js,
// privatename-valid-no-earlyerr.js).
//
// Fix: use pushBody/popBody so the saved buffer is on savedBodies and the
// receiver's global.get shifts with the late import.
async function run(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  // Validate first so a desynced global index surfaces as a test failure
  // rather than a confusing instantiate error.
  if (!WebAssembly.validate(r.binary)) {
    try {
      await WebAssembly.compile(r.binary);
    } catch (e) {
      throw new Error("invalid wasm: " + String(e));
    }
  }
  const imports = buildImports(r.imports, undefined, (r as any).stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("#2563 private-field read on closed-over module global emits valid wasm", () => {
  it("private-field read on a captured module global with a WRONG brand compiles to valid wasm and throws TypeError", async () => {
    // The wrong-brand throw path is what adds the late "Cannot read private
    // member …" string-constant import, triggering the global-index shift that
    // must also move the receiver's `global.get $holder`. Two unrelated
    // classes C and D each declare `#x`; reading `holder.#x` (C's private name)
    // when `holder` is a D instance lacks C's brand → TypeError. Before the
    // fix, `global.get $holder` kept its pre-shift index and read an f64 global
    // → invalid wasm; now the module validates and the brand check throws.
    const ret = await run(`
      let holder: any;
      class C {
        #x: f64 = 42;
        read(): f64 { return holder.#x; }
      }
      class D {
        #y: f64 = 7;
      }
      export function test(): f64 {
        holder = new D();
        const c = new C();
        try {
          c.read();
          return 0;
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("private-field read on a captured module global with a MATCHING brand returns the value (success path stays valid)", async () => {
    // Mirrors privatefieldget-success-1: same shape but `self` carries the
    // right brand, so the read succeeds. Exercises the success arm of the same
    // body-swap that was mis-shifted.
    const ret = await run(`
      let holder: any;
      class C {
        #x: f64 = 99;
        capture(): void { holder = this; }
        read(): f64 { return holder.#x; }
      }
      export function test(): f64 {
        const c = new C();
        c.capture();
        return c.read();
      }
    `);
    expect(ret).toBe(99);
  });
});
