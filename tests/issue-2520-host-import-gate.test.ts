import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #2520 — the lib-file ambient-`declare function` scan only registers a global
// as a host import when the user source genuinely references it (resolved to an
// ambient declaration, not a local variable or property of the same name). So
// touching one lib global (Uint8Array) no longer drags in the whole ambient
// global-function surface, and a local variable that shares a global's name
// doesn't pull that global in.
async function hostImportWarnings(src: string): Promise<string> {
  const r = await compile(src, { fileName: "g.ts", target: "wasi" });
  return (r.errors ?? []).map((e) => e.message).join("\n");
}

describe("#2520 — lib-scan ambient-global referenced-names gate", () => {
  it("does not register unreferenced ambient globals (no env.alert/fetch/scroll flood)", async () => {
    // Uses Uint8Array (triggers the lib scan) but references none of these.
    const warns = await hostImportWarnings(`export function f(): number { const a = new Uint8Array(4); return a[0]; }`);
    for (const g of ["env.alert", "env.fetch", "env.scroll", "env.matchMedia", "env.postMessage", "env.eval"]) {
      expect(warns).not.toContain(`"${g}"`);
    }
  });

  it("does not pull in a DOM global that only collides with a local variable name", async () => {
    // `let stop` is a local — must NOT register the DOM window.stop global.
    const warns = await hostImportWarnings(
      `export function f(): number { const a = new Uint8Array(2); let stop = 1; return a[stop]; }`,
    );
    expect(warns).not.toContain('"env.stop"');
  });

  it("does not register a builtin constructor object for plain `new`/type uses", async () => {
    // `new Uint8Array(...)` + a `Uint8Array` type annotation hit native fast
    // paths and need no host constructor object (global_Uint8Array).
    const warns = await hostImportWarnings(
      `export function f(buf: Uint8Array): number { const a = new Uint8Array(2); return a[0] + buf[0]; }`,
    );
    expect(warns).not.toContain('"env.global_Uint8Array"');
  });

  it("still registers the builtin constructor object for an identity/value use", async () => {
    // `x.constructor === Uint8Array` genuinely needs the reified constructor.
    const warns = await hostImportWarnings(
      `export function f(x: any): boolean { const a = new Uint8Array(1); return x.constructor === Uint8Array && a[0] === 0; }`,
    );
    expect(warns).toContain('"env.global_Uint8Array"');
  });

  it("registers the builtin constructor object for a property-access RECEIVER (regression)", async () => {
    // Regression: `Date.hasOwnProperty("prototype")` / `Date.parse` access a
    // NON-intercepted static prop on the bare ctor — the receiver `Date` must
    // resolve to the host constructor object (global_Date), so it MUST register.
    // The first cut of #2520 wrongly excluded property-access receivers, which
    // made `Date` resolve to ref.null.extern and broke
    // built-ins/Date/S15.9.4_A1..A5 (−4 test262). A typed array triggers the
    // lib scan so the gate is active.
    const warns = await hostImportWarnings(
      `export function f(): boolean { const a = new Uint8Array(1); return Date.hasOwnProperty("prototype") && a[0] === 0; }`,
    );
    expect(warns).toContain('"env.global_Date"');
  });

  it("does NOT register a global for a property NAME that merely collides (obj.Date)", async () => {
    // `obj.Date` is a property key, not a value reference to the global ctor —
    // it must not pull in global_Date.
    const warns = await hostImportWarnings(
      `export function f(obj: any): number { const a = new Uint8Array(1); return obj.Date + a[0]; }`,
    );
    expect(warns).not.toContain('"env.global_Date"');
  });
});

// #2520 / PR #1787 — the lib-file referenced-names gate is scoped to
// wasi/standalone. Under the default JS-host (gc) target it is a no-op: it must
// NOT reorder the import/type table, which previously exposed a latent
// late-import index-shift and produced an invalid binary ("not enough arguments
// on the stack for call") for `Array.prototype.join` over an array containing an
// `undefined`/`null` element (test262 −6: Array/TypedArray join, TypedArray
// HasProperty, Array reduce/reduceRight). These exercise the exact gc-lane
// patterns the −6 regressed; each must compile to a *valid* WebAssembly binary.
describe("#2520 / #1787 — gate must not break gc-lane codegen", () => {
  async function gcBinaryValid(src: string): Promise<boolean> {
    const r = await compile(src, { fileName: "g.ts", skipSemanticDiagnostics: true });
    return r.binary != null && WebAssembly.validate(r.binary);
  }

  it("join over an array with an undefined element compiles to a valid binary", async () => {
    // The minimal reduction of built-ins/Array/prototype/join/S15.4.4.5_A1.3_T1:
    // an array holding `undefined`, `.join()`, compared with `!==` to a string.
    const ok = await gcBinaryValid(
      `export function test(): number {
         let x: any[] = []; x[0] = undefined;
         return x.join() !== "" ? 0 : 1;
       }`,
    );
    expect(ok).toBe(true);
  });

  it("Array(...) called as a function plus join compiles to a valid binary", async () => {
    const ok = await gcBinaryValid(
      `export function test(): number {
         let x: any[] = Array(undefined, 1, null, 3);
         return x.join() === ",1,,3" ? 1 : 0;
       }`,
    );
    expect(ok).toBe(true);
  });

  it("reduce on an empty array throwing TypeError compiles to a valid binary", async () => {
    // built-ins/Array/prototype/reduce/15.4.4.21-8-b-iii-1-3 pattern.
    const ok = await gcBinaryValid(
      `export function test(): number {
         const a: any[] = [];
         try { a.reduce(function (p: any, c: any) { return p; }); return 0; }
         catch (e) { return 1; }
       }`,
    );
    expect(ok).toBe(true);
  });
});
