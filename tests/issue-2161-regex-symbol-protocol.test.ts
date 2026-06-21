// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `re[Symbol.match/matchAll/search](str)` protocol calls.
 *
 * The explicit well-known-symbol READ protocol forms (§22.2.6) are the
 * operand-swapped duals of `String.prototype.match/matchAll/search`: the RegExp
 * is the **receiver** and the string is the **argument**. They were blanket-
 * refused in `--target standalone` (calls.ts) even though the native engine is
 * operand-order agnostic. This slice routes the static / backend-created RegExp
 * forms to the exact same native cores that back the String.prototype methods —
 * NO JS host import (`__regex_symbol_call` must not leak).
 *
 * `@@replace` / `@@split` (which carry a second replacement / limit operand)
 * reuse the same operand-explicit native cores as `String.prototype.replace`/
 * `split` with the operands swapped — also NO host import.
 *
 * Deferred (still narrowed — refused, not silently wrong):
 *   - dynamic-flag / `any`-typed receivers (fall through to the host path);
 *   - string-coercion arguments (`re[Symbol.match](42)`);
 *   - `@@replace` with a non-string (function) replacer stays a refusal.
 */
async function standaloneExports(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS-host string / regex protocol import may leak in standalone.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  for (const re of [
    /^env::__extern_toString$/,
    /^wasm:js-string::/,
    /^env::__regex_symbol_call$/,
    /^env::__extern_get$/,
  ]) {
    expect(
      labels.filter((l) => re.test(l)),
      `leaked ${re}`,
    ).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...a: unknown[]) => number>;
}

describe("#2161 — standalone re[Symbol.search](str)", () => {
  it("returns the match index", async () => {
    const ex = await standaloneExports(`
      export function idx(): number { return /abc/[Symbol.search]("xyabc"); }
    `);
    expect(ex.idx()).toBe(2);
  });

  it("returns -1 on no match", async () => {
    const ex = await standaloneExports(`
      export function miss(): number { return /zzz/[Symbol.search]("xyabc"); }
    `);
    expect(ex.miss()).toBe(-1);
  });
});

describe("#2161 — standalone re[Symbol.match](str)", () => {
  it("non-global: exposes capture group m[1]", async () => {
    const ex = await standaloneExports(`
      export function cap(): number {
        let m = /a(b)c/[Symbol.match]("xabc");
        return m ? m[1].length : -9;
      }
    `);
    expect(ex.cap()).toBe(1); // "b".length
  });

  it("non-global: exposes .index", async () => {
    const ex = await standaloneExports(`
      export function where(): number {
        let m = /a(b)c/[Symbol.match]("xabc");
        return m ? (m.index as number) : -9;
      }
    `);
    expect(ex.where()).toBe(1);
  });

  it("non-global: null on no match (not a stray ref)", async () => {
    const ex = await standaloneExports(`
      export function none(): number {
        let m = /zzz/[Symbol.match]("xabc");
        return m ? 1 : 0;
      }
    `);
    expect(ex.none()).toBe(0);
  });

  it("global: collects every [0] substring (length)", async () => {
    const ex = await standaloneExports(`
      export function count(): number {
        let m = /X/g[Symbol.match]("aXbXcX");
        return m ? m.length : -9;
      }
    `);
    expect(ex.count()).toBe(3);
  });
});

describe("#2161 — standalone re[Symbol.matchAll](str)", () => {
  it("iterates every match, exposing capture groups", async () => {
    const ex = await standaloneExports(`
      export function sumDigits(): number {
        let sum = 0;
        for (const m of /(\\d)/g[Symbol.matchAll]("a1b2c3")) { sum = sum + Number(m[1]); }
        return sum;
      }
    `);
    expect(ex.sumDigits()).toBe(6); // 1 + 2 + 3
  });

  it("yields one iterator entry per match", async () => {
    const ex = await standaloneExports(`
      export function count(): number {
        let c = 0;
        for (const m of /X/g[Symbol.matchAll]("aXbX")) { c = c + 1; }
        return c;
      }
    `);
    expect(ex.count()).toBe(2);
  });
});

describe("#2161 — standalone re[Symbol.replace](str, repl)", () => {
  it("non-global: replaces the first match (length + content)", async () => {
    const ex = await standaloneExports(`
      const r: string = /a/[Symbol.replace]("banana", "Z");
      export function len(): number { return r.length; }
      export function at(i: number): number { return r.charCodeAt(i); }
    `);
    // "bZnana"
    expect(ex.len()).toBe(6);
    expect(String.fromCharCode(...[0, 1, 2, 3, 4, 5].map((i) => ex.at(i)))).toBe("bZnana");
  });

  it("global: replaces every match", async () => {
    const ex = await standaloneExports(`
      const r: string = /a/g[Symbol.replace]("banana", "Z");
      export function len(): number { return r.length; }
      export function at(i: number): number { return r.charCodeAt(i); }
    `);
    // "bZnZnZ"
    expect(String.fromCharCode(...Array.from({ length: ex.len() }, (_, i) => ex.at(i)))).toBe("bZnZnZ");
  });

  it("$-substitution expands at runtime (whole match $&)", async () => {
    const ex = await standaloneExports(`
      const r: string = /\\d+/[Symbol.replace]("a12b", "[$&]");
      export function len(): number { return r.length; }
      export function at(i: number): number { return r.charCodeAt(i); }
    `);
    // "a[12]b"
    expect(String.fromCharCode(...Array.from({ length: ex.len() }, (_, i) => ex.at(i)))).toBe("a[12]b");
  });
});

describe("#2161 — standalone re[Symbol.split](str)", () => {
  it("splits on the separator (piece count)", async () => {
    const ex = await standaloneExports(`
      export function n(): number { return /,/[Symbol.split]("a,b,c").length; }
    `);
    expect(ex.n()).toBe(3);
  });

  it("piece content is correct", async () => {
    const ex = await standaloneExports(`
      const parts = /,/[Symbol.split]("a,bb,ccc");
      export function len0(): number { return (parts[0] as string).length; }
      export function len1(): number { return (parts[1] as string).length; }
      export function len2(): number { return (parts[2] as string).length; }
    `);
    expect(ex.len0()).toBe(1);
    expect(ex.len1()).toBe(2);
    expect(ex.len2()).toBe(3);
  });

  it("honors a numeric limit", async () => {
    const ex = await standaloneExports(`
      export function n(): number { return /,/[Symbol.split]("a,b,c,d", 2).length; }
    `);
    expect(ex.n()).toBe(2);
  });
});
