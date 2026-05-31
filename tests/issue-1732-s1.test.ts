/**
 * #1732 S1 — runtime [[Construct]] brand check for `new f(...)` whose callee
 * is a LOCAL holding a builtin-method value.
 *
 * `var f = String.prototype.indexOf; new f` must throw TypeError per ECMA-262
 * §7.3.13 Construct → §10.2.2 [[Construct]] (a built-in method has no
 * [[Construct]]). The compile-time guards in new-super.ts only fire on the
 * DIRECT `new String.prototype.indexOf()` form; through a local the callee is a
 * bare identifier of type `any`, so control reached the unknown-ctor path which
 * never performed [[Construct]] and silently did not throw.
 *
 * S1 fix: when the local's declaration initializer is provably non-constructable
 * (a `<...>.prototype.<method>` member access, or a `.bind/.call/.apply`
 * result), the `new`-site routes the runtime value through the host
 * `__construct(callee, args)` helper, which throws a real TypeError when
 * IsConstructor(callee) is false. JS-host mode (S1); standalone parity is S4.
 *
 * These are the `test262/built-ins/String/prototype/<m>/S15.5.4.*_A7.js`
 * not-a-constructor cases (~14 in JS-host mode).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runExpectThrow(source: string): Promise<"TypeError" | "no-throw" | string> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) return `CE: ${r.errors[0]?.message ?? "?"}`;
  const io = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, io as any);
  (io as any).setExports?.(instance.exports);
  try {
    (instance.exports as any).test();
    return "no-throw";
  } catch (e) {
    return e instanceof TypeError ? "TypeError" : `${(e as any)?.constructor?.name ?? typeof e}`;
  }
}

async function runValue(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message ?? "?"}`);
  const io = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, io as any);
  (io as any).setExports?.(instance.exports);
  return (instance.exports as any).test();
}

describe("#1732 S1 — new on a local builtin-method value throws TypeError", () => {
  it("var f = String.prototype.indexOf; new f → TypeError (A7)", async () => {
    const src = `export function test(): number { var f: any = String.prototype.indexOf; var x = new f(); return 0; }`;
    expect(await runExpectThrow(src)).toBe("TypeError");
  });

  it("new f without parens (new f) also throws TypeError", async () => {
    const src = `export function test(): number { var f: any = String.prototype.charAt; var x = new f; return 0; }`;
    expect(await runExpectThrow(src)).toBe("TypeError");
  });

  it("new (f as any)() cast form throws TypeError", async () => {
    const src = `export function test(): number { var f = String.prototype.slice; var x = new (f as any)(); return 0; }`;
    expect(await runExpectThrow(src)).toBe("TypeError");
  });

  it("toUpperCase method value via local → TypeError", async () => {
    const src = `export function test(): number { var f: any = String.prototype.toUpperCase; var x = new f(); return 0; }`;
    expect(await runExpectThrow(src)).toBe("TypeError");
  });

  // ── Regression guards (#1632 bind, user constructors, call path) ──

  it("user-declared constructable function is NOT intercepted (new f works)", async () => {
    const src = `function Ctor(){} export function test(): number { var f = Ctor; var o = new (f as any)(); return 1; }`;
    expect(await runValue(src)).toBe(1);
  });

  it("the value is still CALLABLE — only [[Construct]] is gated", async () => {
    const src = `export function test(): number { var f = String.prototype.indexOf; return (f as any).call("ab","b"); }`;
    expect(await runValue(src)).toBe(1);
  });

  it("new on a .bind() of a constructable target still constructs (not a false TypeError)", async () => {
    // `function(){}` HAS [[Construct]]; its bound function is constructable, so
    // `new b()` must succeed — the brand check honours the target's brand.
    const src = `export function test(): number { var b: any = (function(){}).bind(null); var x = new b(); return 0; }`;
    expect(await runExpectThrow(src)).toBe("no-throw");
  });
});
