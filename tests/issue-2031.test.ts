import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2031/#2032 — destructuring spec-conformance pair:
//   - array destructuring with default + rest + a source shorter than the
//     fixed bindings must NOT trap (array.copy source offset clamped)
//   - computed-key object destructuring `{ [k]: v }` must bind the real value
//     when the key is a compile-time-constant string (struct fast path)
async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#2031 — array destructuring default + rest + short source", () => {
  it("const [p, q = 9, ...rest] = [1] binds p=1, q=9, rest=[]", async () => {
    const e = await compileAndRun(`export function test(): number {
      const [p, q = 9, ...rest] = [1];
      return p * 100 + q * 10 + rest.length;
    }`);
    expect(e.test!()).toBe(190);
  });

  it("default-only short source unchanged", async () => {
    const e = await compileAndRun(`export function test(): number {
      const [p, q = 9] = [1]; return p * 10 + q;
    }`);
    expect(e.test!()).toBe(19);
  });

  it("rest-only short source unchanged", async () => {
    const e = await compileAndRun(`export function test(): number {
      const [p, ...rest] = [1]; return p * 10 + rest.length;
    }`);
    expect(e.test!()).toBe(10);
  });

  it("longer source: rest captures the tail", async () => {
    const e = await compileAndRun(`export function test(): number {
      const [p, q = 9, ...rest] = [1, 2, 3, 4];
      return p * 1000 + q * 100 + rest.length;
    }`);
    expect(e.test!()).toBe(1202);
  });

  it("default fires when source supplies undefined past its length", async () => {
    const e = await compileAndRun(`export function test(): number {
      const [a, b = 7, c = 8, ...rest] = [1, 2];
      return a * 1000 + b * 100 + c * 10 + rest.length;
    }`);
    expect(e.test!()).toBe(1280);
  });
});

describe("#2032 — computed-key object destructuring binds the value", () => {
  it('const k = "dyn"; const { [k]: v } = { dyn: 6 } binds 6', async () => {
    const e = await compileAndRun(`export function test(): number {
      const k = "dyn"; const { [k]: v } = { dyn: 6 }; return v;
    }`);
    expect(e.test!()).toBe(6);
  });

  it("string-literal computed key binds", async () => {
    const e = await compileAndRun(`export function test(): number {
      const { ["dyn"]: v } = { dyn: 9 }; return v;
    }`);
    expect(e.test!()).toBe(9);
  });

  it("computed key alongside a static binding", async () => {
    const e = await compileAndRun(`export function test(): number {
      const k = "a"; const { [k]: aa, b } = { a: 3, b: 4 }; return aa * 10 + b;
    }`);
    expect(e.test!()).toBe(34);
  });

  it("static-key destructuring is unchanged", async () => {
    const e = await compileAndRun(`export function test(): number {
      const { dyn: v } = { dyn: 6 }; return v;
    }`);
    expect(e.test!()).toBe(6);
  });

  it("computed key in a function parameter pattern binds", async () => {
    const e = await compileAndRun(`
      function f({ ["dyn"]: v }: { dyn: number }): number { return v; }
      export function test(): number { return f({ dyn: 8 }); }
    `);
    expect(e.test!()).toBe(8);
  });
});

describe("#2032 — non-constant computed key does NOT hard-error", () => {
  it("a widened-string computed key compiles (no hard error)", async () => {
    const result = await compile(`export function test(): number {
      let k = "dyn"; k = k + "";
      const { [k]: v } = { dyn: 6, other: 9 }; return v;
    }`);
    // A non-constant computed key cannot be resolved by the struct fast path,
    // but it MUST NOT raise a compile error — that regressed 7 test262
    // `obj-ptrn-prop-eval-err` cases (for / for-await-of), which compile and
    // evaluate the key (and surface its abrupt completion) at runtime. The
    // struct fast path skips the static field map; the generic destructuring
    // path owns the dynamic key. (Binding the CORRECT value for a dynamic key
    // in the struct-backed fast path is a separate follow-up — the static path
    // currently leaves the local zero-initialised; surfacing the right value
    // needs the runtime key-lookup path, tracked as a #2032 residual.)
    expect(result.success).toBe(true);
    expect(result.errors.some((e) => /Computed property key/.test(e.message))).toBe(false);
  });
});
