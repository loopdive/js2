// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #2576 (extends #2187) — string methods / `.length` on an `any`-typed receiver whose runtime
 * value is a native `$AnyString` take the generic externref path and return 0
 * in standalone mode.
 *
 * Root cause: `.length` / string-method dispatch gates on `isStringType(<TS
 * static type>)`. For an `any`/unknown receiver that predicate is false, so the
 * read fell to the host/dynamic path (null ⇒ 0 standalone), even though the
 * value IS a real native string (`String(o.v)`-style concat already works
 * because it keys off the operand ValType, not the TS type). The fix routes
 * `.length` and the native string methods through a runtime `ref.test
 * $AnyString` guard at the `any`-receiver dispatch sites (a string hit reads the
 * native path; a miss keeps the prior generic behaviour), generalizing the
 * #2077/#2192 caught-Error precedent. Native-string mode (standalone/WASI) only;
 * host/gc mode is untouched.
 */

const BANNED_HOST_GET: ReadonlyArray<RegExp> = [
  /^env::__extern_get$/,
  /^env::__extern_get_idx$/,
  /^env::__extern_length$/,
];

function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_HOST_GET) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must validate").toBe(true);
  assertNoHostObjectImports(r.imports);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).test();
}

describe("#2576 (extends #2187) — string method / .length on an any-typed native-string receiver (standalone)", () => {
  it("object string-value: o.v.length and o.v.charCodeAt(0)", async () => {
    expect(await runStandalone(`export function test(): number { const o:any={v:"hi"}; return o.v.length; }`)).toBe(2);
    expect(
      await runStandalone(`export function test(): number { const o:any={v:"hi"}; return o.v.charCodeAt(0); }`),
    ).toBe(104);
  });

  it("single-yield string generator loop var (.length / charCodeAt via the value-rep path)", async () => {
    // The single-yield generator loop var is the #2187 origin (sd-3's
    // receiverIsNativeStringValType covers the typed-local case). Re-asserted
    // here as a value-rep read. The two-yield variant is the #2040 generator
    // value-binding residual (out of scope — see the issue's Out of scope note).
    expect(
      await runStandalone(
        `function* g(){ yield "ab"; }
         export function test(): number { let n = 0; for (const v of g()) n += v.length; return n; }`,
      ),
    ).toBe(2);
    expect(
      await runStandalone(
        `function* g(){ yield "ab"; }
         export function test(): number { let r = 0; for (const v of g()) r = v.charCodeAt(0); return r; }`,
      ),
    ).toBe(97);
  });

  it("caught-error any binding: e.message.length and e.message.charCodeAt(0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { throw new Error("oops"); } catch(e:any){ return e.message.length; } }`,
      ),
    ).toBe(4);
    expect(
      await runStandalone(
        `export function test(): number { try { throw new Error("oops"); } catch(e:any){ return e.message.charCodeAt(0); } }`,
      ),
    ).toBe(111);
  });

  it("nested any read: o.a.b.length", async () => {
    expect(
      await runStandalone(`export function test(): number { const o:any={a:{b:"hi"}}; return o.a.b.length; }`),
    ).toBe(2);
  });

  it("indexed element read-back: Object.values / Object.entries string elements", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o:any={a:"xx",b:"yy"}; return (Object.values(o)[0] as any).length; }`,
      ),
    ).toBe(2);
    expect(
      await runStandalone(
        `export function test(): number { const o:any={k:"hi"}; return (Object.entries(o)[0][1] as any).length; }`,
      ),
    ).toBe(2);
  });

  it("native string methods on an any receiver (slice/indexOf round-trip)", async () => {
    expect(
      await runStandalone(`export function test(): number { const o:any={v:"hello"}; return o.v.slice(1).length; }`),
    ).toBe(4);
    expect(
      await runStandalone(`export function test(): number { const o:any={v:"hello"}; return o.v.indexOf("l"); }`),
    ).toBe(2);
  });

  // ── Non-regression guards ────────────────────────────────────────────────

  it("numeric any sibling still reads numeric", async () => {
    expect(await runStandalone(`export function test(): number { const o:any={n:7}; return o.n; }`)).toBe(7);
  });

  it("Object.values(o).length (vec length) is unaffected by the string guard", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o:any={a:"xx",b:"yy"}; return Object.values(o).length; }`,
      ),
    ).toBe(2);
  });

  it("String wrapper .length keeps its own path", async () => {
    expect(await runStandalone(`export function test(): number { return new String("hi").length; }`)).toBe(2);
  });

  it("an any holding a number does not produce a spurious string length", async () => {
    // A number value is not a native string → ref.test $AnyString misses → 0,
    // not a wrong positive length.
    expect(
      await runStandalone(`export function test(): number { const o:any={n:5}; const x:any=o.n; return x.length; }`),
    ).toBe(0);
  });

  it("statically string-typed receivers are unchanged", async () => {
    expect(await runStandalone(`export function test(): number { const s="hello"; return s.length; }`)).toBe(5);
    expect(await runStandalone(`export function test(): number { const s="hi"; return s.charCodeAt(0); }`)).toBe(104);
    expect(await runStandalone(`export function test(): number { const s="hello"; return s.slice(1).length; }`)).toBe(
      4,
    );
  });

  it("host/gc mode: the same any string-value read still returns the length (path untouched)", async () => {
    const exports = await compileToWasm(`export function test(): number { const o:any={v:"hi"}; return o.v.length; }`);
    expect((exports as Record<string, () => number>).test()).toBe(2);
  });
});
