import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2505 — standalone `any[]` / boxed-any element `Array.prototype.join` &
 * `toString`.
 *
 * A boxed-any element array (`any[]`) stores each element as a generic boxed
 * value (externref), NOT a `(ref null $NativeString)`. The native join's
 * string-element arm took a bare `ref.as_non_null`, which left the value typed
 * externref and could not `local.set` into the `(ref $AnyString)` fold result
 * local — producing **invalid Wasm** (`local.set[0] expected (ref null
 * $AnyString), found ...`). `number[]`/`string[]`/`boolean[]` were unaffected.
 *
 * Fix: route a boxed-any element through `__extern_toString` (the same ToString
 * path `String(any)` uses), with the §23.1.3.18 step-7d `null`/`undefined` →
 * empty-string guard.
 *
 * These assert: valid Wasm (the regression) + spec-correct joined value.
 */
async function joinResult(arrayLiteral: string, sep: string): Promise<string> {
  const src = `
const A: any[] = ${arrayLiteral};
const R = A.join(${JSON.stringify(sep)});
export function len(): number { return R.length; }
export function ch(i: number): number { return R.charCodeAt(i); }
`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { len: () => number; ch: (i: number) => number };
  let s = "";
  for (let i = 0; i < ex.len(); i++) s += String.fromCharCode(ex.ch(i));
  return s;
}

async function toStringResult(arrayLiteral: string): Promise<string> {
  const src = `
const A: any[] = ${arrayLiteral};
const R = A.toString();
export function len(): number { return R.length; }
export function ch(i: number): number { return R.charCodeAt(i); }
`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { len: () => number; ch: (i: number) => number };
  let s = "";
  for (let i = 0; i < ex.len(); i++) s += String.fromCharCode(ex.ch(i));
  return s;
}

describe("#2505 — standalone any[] join / toString (valid Wasm + spec value)", () => {
  it("mixed number/string/boolean elements join correctly", async () => {
    expect(await joinResult(`[1, "x", true]`, ",")).toBe("1,x,true");
  });

  it("all-numeric any[] elements stringify (not [object Object])", async () => {
    expect(await joinResult(`[1, 2, 3]`, ",")).toBe("1,2,3");
  });

  it("null / undefined elements join as empty string (§23.1.3.18 step 7d)", async () => {
    expect(await joinResult(`[1, null, undefined, 2]`, ",")).toBe("1,,,2");
  });

  it("object elements stringify as [object Object]", async () => {
    expect(await joinResult(`[1, {a:1}, "z"]`, ",")).toBe("1,[object Object],z");
  });

  it("honours an explicit multi-char separator", async () => {
    expect(await joinResult(`[1, "b", 3]`, " - ")).toBe("1 - b - 3");
  });

  it("toString() delegates to join(',') for any[]", async () => {
    expect(await toStringResult(`[1, "x", true]`)).toBe("1,x,true");
  });
});
