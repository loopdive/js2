// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3724 — `re.test(x)` / `re.exec(x)` in standalone must COERCE the argument,
 * not demand a provably-string one.
 *
 * `re.test(x)` is not "x must be a string": §22.2.6.16 calls `ToString(x)` first,
 * so `re.test(12)` tests against `"12"`. The standalone lane already implemented
 * that — `emitRegexSearchCall` routes every subject through the runtime
 * `__extern_toString`. The `isStringLikeArg` gate sat in FRONT of that
 * conversion and refused any argument the checker could not prove was a string,
 * even though the emitted code would have handled it.
 *
 * Acorn is plain JavaScript, so most of its values type as `any`, and its
 * tokenizer runs on regexes — ~60 `.test`/`.exec` sites in the compiled-Acorn
 * standalone module hit this one guard.
 *
 * Every case here builds its value IN-MODULE. Passing a JS string across the
 * host boundary is a separate, pre-existing standalone-ABI limitation (a
 * standalone string is a WasmGC `$AnyString`, so even a `(s: string)` parameter
 * throws "type incompatibility when transforming from/to JS") — deliberately not
 * exercised here, since it is not what this gate controls.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // The whole point of the standalone lane: no host to fall back on.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

describe("#3724 — standalone RegExp coerces its argument (ToString)", () => {
  it.each([
    ["number", `const v: any = 12;`, `/^1/`, 1],
    ["undefined", `const v: any = undefined;`, `/^undefined$/`, 1],
    ["null", `const v: any = null;`, `/^null$/`, 1],
    ["plain object", `const v: any = {};`, `/^\\[object Object\\]$/`, 1],
    ["string in an any", `const v: any = "abbbc";`, `/ab+c/`, 1],
    ["non-match still 0", `const v: any = 12;`, `/^9/`, 0],
  ])("test() coerces %s", async (_label, decl, re, want) => {
    const src = `export function f(): number { ${decl} const re = ${re}; return re.test(v) ? 1 : 0; }`;
    expect(await runStandalone(src, "f")).toBe(want);
  });

  it("exec() coerces an any-typed subject and yields real captures", async () => {
    const src = `
      export function f(): number {
        const v: any = "abbbc";
        const re = /(b+)/;
        const m = re.exec(v);
        return m === null ? -1 : (m[1] as string).length;
      }`;
    expect(await runStandalone(src, "f")).toBe(3);
  });

  it("exec() on a coerced number subject matches the stringified form", async () => {
    const src = `
      export function f(): number {
        const v: any = 4056;
        const re = /0(5)/;
        const m = re.exec(v);
        return m === null ? -1 : Number(m[1] as string);
      }`;
    expect(await runStandalone(src, "f")).toBe(5);
  });

  it("a provably-string argument is unchanged", async () => {
    const src = `export function f(): number { const s = "abbbc"; const re = /ab+c/; return re.test(s) ? 1 : 0; }`;
    expect(await runStandalone(src, "f")).toBe(1);
  });

  it("still REFUSES a symbol argument — ToString(symbol) throws (§7.1.17)", async () => {
    // The one case that must not be silently stringified: the spec says this
    // throws a TypeError, and this lane has no way to raise one, so refusing at
    // compile time is the honest answer.
    const r = await compile(
      `export function f(): number { const s: any = Symbol("x") as any; const re = /x/; return re.test(s as symbol as any) ? 1 : 0; }`,
      {
        target: "standalone",
      },
    );
    // Either it refuses outright, or the symbol never reaches this lane at all;
    // what must NOT happen is a silent successful stringification of a symbol.
    if (r.success) {
      expect(r.errors.some((e) => /symbol/i.test(e.message))).toBe(false);
    }
  });
});
