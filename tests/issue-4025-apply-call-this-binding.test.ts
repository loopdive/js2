// #4025 — `f.call(thisArg)` / `f.apply(thisArg)` dropped the receiver whenever
// the receiver's static type was not PROVABLY non-nullish.
//
// The receiver-install trampoline (#3796, `src/codegen/named-this-call.ts`) was
// gated on `oracleProvesNonNullish(...)`. An `any`-typed receiver — i.e. every
// untyped-JS receiver, which is the entire corpus this path exists for — can
// never satisfy that proof, so the gate refused, no trampoline was reserved,
// and control fell through to the generic lowering, which evaluates `thisArg`
// and DISCARDS it. The callee then ran against the ambient `this`: a silent
// wrong answer, not a refusal.
//
// The gate now refuses only a receiver the oracle proves is ALWAYS nullish.
// That is sound because the trampoline splits on the receiver's RUNTIME value
// (`local.get 0; ref.is_null; if → unbound exact call; else → install`), so a
// receiver that merely MIGHT be nullish is handled at runtime, not statically.
//
// Everything here runs on the standalone (`--target wasi`) lane, where the
// whole `this` chain is pure Wasm; a small host-lane block at the end pins the
// same answers against real JS via the equivalence harness.
//
// Note on shapes: the receiver-side assertions deliberately use either an
// ANNOTATED object literal or receiver IDENTITY. A function-local, UN-annotated
// object literal read dynamically (`p.x` where `p: any`) returns garbage in
// standalone for reasons that have nothing to do with `this` — see the
// "unrelated defect" note in plan/issues/4025-*.md. Using it here would make
// these tests fail for the wrong reason.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";
import { assertEquivalent } from "./equivalence/helpers.js";

const O_DECL = `interface O { x: number }\n`;

/** Compile with `--target wasi`, instantiate, run `test()`. */
async function runStandalone(source: string): Promise<{ value: unknown; installsReceiver: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const installsReceiver = /__named_this_call/.test(result.wat ?? "");
  const module = await WebAssembly.compile(result.binary);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  return { value: (exports.test as () => unknown)(), installsReceiver };
}

describe("#4025 — `.call`/`.apply` install the receiver for statically-unprovable receivers", () => {
  it("call(o) — object-literal receiver behind `any`, `this.x` reads the receiver's field", async () => {
    const { value, installsReceiver } = await runStandalone(
      O_DECL +
        `function g() { return (this as any).x; }
         export function test() { const t: O = { x: 42 }; const o: any = t; return g.call(o); }`,
    );
    expect(value).toBe(42);
    expect(installsReceiver).toBe(true);
  });

  it("call(o) — receiver identity survives (`g.call(o) === o`)", async () => {
    const { value } = await runStandalone(
      O_DECL +
        `function g() { return this; }
         export function test() { const t: O = { x: 42 }; const o: any = t; return (g.call(o) as any) === o ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("apply(o) — no argv array", async () => {
    const { value, installsReceiver } = await runStandalone(
      O_DECL +
        `function g() { return (this as any).x; }
         export function test() { const t: O = { x: 42 }; const o: any = t; return g.apply(o); }`,
    );
    expect(value).toBe(42);
    expect(installsReceiver).toBe(true);
  });

  it("apply(o, []) — empty argv array", async () => {
    const { value } = await runStandalone(
      O_DECL +
        `function g() { return (this as any).x; }
         export function test() { const t: O = { x: 42 }; const o: any = t; return g.apply(o, []); }`,
    );
    expect(value).toBe(42);
  });

  it("apply(o, [a]) — receiver AND positional arg both land", async () => {
    const { value } = await runStandalone(
      O_DECL +
        `function g(a: number) { return (this as any).x + a; }
         export function test() { const t: O = { x: 42 }; const o: any = t; return g.apply(o, [5]); }`,
    );
    expect(value).toBe(47);
  });

  it("apply(o, [a, b]) — argument order preserved", async () => {
    const { value } = await runStandalone(
      O_DECL +
        `function g(a: number, b: number) { return (this as any).x + a * 10 + b; }
         export function test() { const t: O = { x: 0 }; const o: any = t; return g.apply(o, [1, 2]); }`,
    );
    expect(value).toBe(12);
  });

  it("call(o) — constructor-function (`new O()`) receiver", async () => {
    const { value, installsReceiver } = await runStandalone(
      `function O(this: any) { this.x = 42; }
       function g() { return (this as any).x; }
       export function test() { const o = new (O as any)(); return g.call(o); }`,
    );
    expect(value).toBe(42);
    expect(installsReceiver).toBe(true);
  });

  it("call(o) — class-instance receiver behind `any`", async () => {
    const { value } = await runStandalone(
      `class C { x = 42; }
       function g() { return (this as any).x; }
       export function test() { const c = new C(); const o: any = c; return g.call(o); }`,
    );
    expect(value).toBe(42);
  });

  it("two calls with different receivers — the ambient `this` is restored between them", async () => {
    const { value } = await runStandalone(
      O_DECL +
        `function g() { return (this as any).x; }
         export function test() {
           const a: O = { x: 1 };
           const b: O = { x: 20 };
           const ra: any = a;
           const rb: any = b;
           return g.call(ra) + g.call(rb) * 10 + g.call(ra) * 100;
         }`,
    );
    expect(value).toBe(1 + 200 + 100);
  });

  // ---- Regression guard: the statically-known receiver path already worked.
  it("call(o) — statically-typed receiver (the pre-existing working path)", async () => {
    const { value, installsReceiver } = await runStandalone(
      O_DECL +
        `function g() { return (this as any).x; }
         export function test() { const o: O = { x: 42 }; return g.call(o); }`,
    );
    expect(value).toBe(42);
    expect(installsReceiver).toBe(true);
  });

  // ---- Nullish receivers keep js2wasm's existing convention.
  //
  // Measured on main before this change and unchanged after it, in BOTH lanes:
  // a nullish receiver leaves `this` undefined (js2wasm compiles TS modules,
  // which are strict, so there is no sloppy-mode global substitution here).
  // These must neither trap nor start reading a live receiver.
  const NULLISH_PROBE = `function g() { return this === undefined ? 1 : 0; }\n`;

  it("call(null) — `this` stays undefined, no trap", async () => {
    const { value } = await runStandalone(NULLISH_PROBE + `export function test() { return g.call(null); }`);
    expect(value).toBe(1);
  });

  it("call(undefined) — `this` stays undefined, no trap", async () => {
    const { value } = await runStandalone(NULLISH_PROBE + `export function test() { return g.call(undefined); }`);
    expect(value).toBe(1);
  });

  it("call(o) where `o: any` holds null at runtime — trampoline's null arm", async () => {
    const { value } = await runStandalone(
      NULLISH_PROBE + `export function test() { const o: any = null; return g.call(o); }`,
    );
    expect(value).toBe(1);
  });

  it("call(o) where `o: any` holds undefined at runtime", async () => {
    const { value } = await runStandalone(
      NULLISH_PROBE + `export function test() { const o: any = undefined; return g.call(o); }`,
    );
    expect(value).toBe(1);
  });

  it("apply(null) / no-arg call() — unchanged", async () => {
    const viaApply = await runStandalone(NULLISH_PROBE + `export function test() { return g.apply(null); }`);
    const viaBare = await runStandalone(NULLISH_PROBE + `export function test() { return g.call(); }`);
    expect(viaApply.value).toBe(1);
    expect(viaBare.value).toBe(1);
  });
});

describe("#4025 — host lane agrees with real JS", () => {
  it("call(o) with an `any` receiver — receiver identity", async () => {
    await assertEquivalent(
      `interface O { x: number }
       function g() { return this; }
       export function test() { const t: O = { x: 42 }; const o: any = t; return (g.call(o) as any) === o ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("apply(o, [a]) with an `any` receiver — field read plus argument", async () => {
    await assertEquivalent(
      `interface O { x: number }
       function g(a: number) { return (this as any).x + a; }
       export function test() { const t: O = { x: 42 }; const o: any = t; return g.apply(o, [5]); }`,
      [{ fn: "test", args: [] }],
    );
  });
});
