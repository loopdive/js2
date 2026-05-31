// #1677 — Native string helper func-index shift unification (Signature A of #1666).
//
// Under `--target wasi` (auto `nativeStrings`), the native-string runtime
// helpers (`__str_flatten` & co.) and their dependency helpers (`__box_number`,
// …) are emitted as DEFINED functions during the import-collection finalize
// phase. Imports added afterward shift every defined function's absolute Wasm
// index, but the helper bodies' baked sibling-call targets, the funcMap entries,
// and the export descriptors were left stale-low — producing modules that fail
// `WebAssembly.compile` validation (`call[k] expected <T>, found <U>`).
//
// `reconcileNativeStrFinalizeShift` repairs them with one uniform shift over all
// eagerly-emitted defined functions, hard-gated on a pinned helper base so it is
// provably inert on the default JS-host GC path (the #618 hazard).
//
// These shapes (inner-arrow closure capture across class boundaries, super
// calls, generator for-of) each exercised the stale-index path and previously
// emitted invalid Wasm. The default-GC `Math.abs` + string-concat case is the
// #618 regression guard: it must keep validating with the reconcile in place.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compilesValidWasm(source: string, target?: "wasi"): Promise<true> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  // Throws if the module fails Wasm validation — this is the assertion.
  await WebAssembly.compile(result.binary);
  return true;
}

describe("#1677 native string helper func-index shift (--target wasi)", () => {
  it("class with extends/super + string methods compiles to valid Wasm", async () => {
    const src = `
      class Animal {
        name: string;
        constructor(n: string) { this.name = n; }
        speak(): string { return this.name + " makes a sound"; }
      }
      class Dog extends Animal {
        constructor(n: string) { super(n); }
        speak(): string { return super.speak() + " (woof)"; }
      }
      const d = new Dog("Rex");
      const out = d.speak();
    `;
    expect(await compilesValidWasm(src, "wasi")).toBe(true);
  });

  it("captured-closure string concat compiles to valid Wasm", async () => {
    const src = `
      function make(prefix: string) { return (x: string) => prefix + x; }
      const f = make("hi-");
      const r = f("world");
    `;
    expect(await compilesValidWasm(src, "wasi")).toBe(true);
  });

  it("generator for-of accumulating strings compiles to valid Wasm", async () => {
    const src = `
      function* gen() { yield "a"; yield "b"; yield "c"; }
      let acc = "";
      for (const v of gen()) { acc = acc + v; }
    `;
    expect(await compilesValidWasm(src, "wasi")).toBe(true);
  });

  it("#618 guard: default GC-path Math.abs + string concat stays valid", async () => {
    // The pre-#618 naive `addImport` shift corrupted the Math.* host trampoline
    // on the default path. The reconcile is a hard no-op here (no native-string
    // helpers are emitted) and must not regress this.
    const src = `
      const a = Math.abs(-5);
      const b = "val=" + a;
      const c = Math.max(1, 2) + Math.min(3, 4);
    `;
    expect(await compilesValidWasm(src)).toBe(true);
  });
});
