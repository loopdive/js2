import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #5160 — the three siblings #5155 left out: zero-argument `includes()`,
//   `startsWith()` and `search()` were wrong in the gc (JS-host) lane, from the
//   same one-cell omission in the `padsUndefined` set inside
//   `compileReceiverMethodCall` (src/codegen/expressions/call-receiver-method.ts).
//   The absent externref search slot was padded with `ref.null.extern`, so the
//   host received JS `null`:
//
//     "aundefinedb".includes()   false  (spec true  — ToString(undefined))
//     "undefinedb".startsWith()  false  (spec true  — ToString(undefined))
//     "aundefinedb".search()     -1     (spec 0     — RegExp(undefined))
//
//   `search` is NOT a ToString case and was verified separately before assuming
//   the one-entry fix would carry it: §22.1.3.19 routes an absent/undefined
//   argument through `RegExp(undefined)`, which is the EMPTY regexp `/(?:)/` and
//   matches at index 0 — not the string "undefined". Two measurements on the
//   pre-fix base established that passing `undefined` is nonetheless sufficient:
//   (a) `search()` and `search(null)` compiled to ONE binary, so `null` really
//   was what reached the host, and (b) `search(undefined)` in the gc lane
//   already answered 0, so the host arm handles `undefined` correctly. Both are
//   pinned below.
//
//   Standalone was already correct for all three, which is the evidence this is
//   host argument padding and not a semantics gap.
//
//   `skipSemanticDiagnostics` mirrors the test262 runner — TS types these
//   methods as requiring an argument, which is not a hard error there.

interface CompileResult {
  success: boolean;
  errors?: Array<{ message: string }>;
  binary: Uint8Array;
  importObject?: WebAssembly.Imports;
}

async function build(src: string, standalone: boolean): Promise<CompileResult> {
  const opts = standalone ? { target: "standalone", skipSemanticDiagnostics: true } : { skipSemanticDiagnostics: true };
  const r = (await compile(src, opts as never)) as never as CompileResult;
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  return r;
}

async function runGc(src: string): Promise<unknown> {
  const r = await build(src, false);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await build(src, true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function digestGc(src: string): Promise<string> {
  const r = await build(src, false);
  return createHash("sha256").update(r.binary).digest("hex");
}

const fn = (body: string) => `export function test(): number { ${body} }`;
// "undefined" occurs at index 1; "null" occurs nowhere, so a wrong answer that
// came from searching for "null" is distinguishable from a generic miss.
const HIT = 'const s="aundefinedb";';
const SW = 'const s="undefinedb";';

describe("#5160 — zero-argument includes/startsWith/search in the gc lane", () => {
  it('includes() searches for the string "undefined" in both lanes', async () => {
    expect(await runGc(fn(HIT + " return s.includes()?1:0;"))).toBe(1);
    expect(await runStandalone(fn(HIT + " return s.includes()?1:0;"))).toBe(1);
  });

  it('startsWith() searches for the string "undefined" in both lanes', async () => {
    expect(await runGc(fn(SW + " return s.startsWith()?1:0;"))).toBe(1);
    expect(await runStandalone(fn(SW + " return s.startsWith()?1:0;"))).toBe(1);
  });

  it("search() builds the EMPTY regexp and matches at 0 in both lanes", async () => {
    // §22.1.3.19: RegExp(undefined) is /(?:)/, so the answer is 0 for ANY
    // receiver — including one that contains neither "undefined" nor "null",
    // and including the empty string. That is what distinguishes search() from
    // the two ToString siblings above, and it is asserted rather than assumed.
    expect(await runGc(fn(HIT + " return s.search();"))).toBe(0);
    expect(await runStandalone(fn(HIT + " return s.search();"))).toBe(0);
    expect(await runGc(fn('const s="abc"; return s.search();'))).toBe(0);
    expect(await runGc(fn('const s=""; return s.search();'))).toBe(0);
  });

  it("keeps the no-match guards honest — the fix is not a fixed answer", async () => {
    // Receivers containing neither "undefined" nor "null". includes/startsWith
    // must still be false; only their SEARCH VALUE changed, not their result
    // shape. (These two rows moved bytes with no value change.)
    expect(await runGc(fn('const s="abc"; return s.includes()?1:0;'))).toBe(0);
    expect(await runStandalone(fn('const s="abc"; return s.includes()?1:0;'))).toBe(0);
    expect(await runGc(fn('const s="abc"; return s.startsWith()?1:0;'))).toBe(0);
    expect(await runStandalone(fn('const s="abc"; return s.startsWith()?1:0;'))).toBe(0);
  });

  it("applies to literal and dynamic receivers, not just a const binding", async () => {
    expect(await runGc(fn('return "aundefinedb".includes()?1:0;'))).toBe(1);
    expect(await runGc(fn('const a=["aundefinedb"]; return a[0]!.includes()?1:0;'))).toBe(1);
    expect(await runGc(fn('return "undefinedb".startsWith()?1:0;'))).toBe(1);
    expect(await runGc(fn('const a=["undefinedb"]; return a[0]!.startsWith()?1:0;'))).toBe(1);
    expect(await runGc(fn('return "aundefinedb".search();'))).toBe(0);
    expect(await runGc(fn('const a=["aundefinedb"]; return a[0]!.search();'))).toBe(0);
  });

  it('was searching for "null" — the explicit null spellings are unchanged', async () => {
    // The defect made the host receive JS `null`. Those spellings genuinely
    // mean "null" / RegExp(null) = /null/ and must keep doing so; only the
    // ABSENT argument changed meaning.
    expect(await runGc(fn('const s="anullb"; return s.includes(null as any)?1:0;'))).toBe(1);
    expect(await runGc(fn(HIT + " return s.includes(null as any)?1:0;"))).toBe(0);
    expect(await runGc(fn('const s="nullb"; return s.startsWith(null as any)?1:0;'))).toBe(1);
    expect(await runGc(fn(SW + " return s.startsWith(null as any)?1:0;"))).toBe(0);
    // search(null) === /null/ — absent from the probe, so still -1, and this is
    // the row that proves search() is no longer compiling to search(null).
    expect(await runGc(fn(HIT + " return s.search(null as any);"))).toBe(-1);
  });

  it("compiles each zero-argument form byte-identically to its undefined spelling", async () => {
    // The #5155/#5121 pin pattern: the two spellings become ONE binary, so they
    // cannot drift apart later. None of the three were identical before the fix.
    const pairs: Array<[string, string]> = [
      [HIT + " return s.includes()?1:0;", HIT + " return s.includes(undefined)?1:0;"],
      [SW + " return s.startsWith()?1:0;", SW + " return s.startsWith(undefined)?1:0;"],
      [HIT + " return s.search();", HIT + " return s.search(undefined as any);"],
    ];
    for (const [absent, explicit] of pairs) {
      expect(await digestGc(fn(absent))).toBe(await digestGc(fn(explicit)));
    }
  });

  it("leaves explicit-argument values unchanged for all three methods", async () => {
    expect(await runGc(fn(HIT + ' return s.includes("b")?1:0;'))).toBe(1);
    expect(await runGc(fn(HIT + ' return s.includes("b",0)?1:0;'))).toBe(1);
    expect(await runGc(fn(HIT + " return s.includes(undefined)?1:0;"))).toBe(1);
    expect(await runGc(fn(SW + ' return s.startsWith("u")?1:0;'))).toBe(1);
    expect(await runGc(fn(SW + ' return s.startsWith("n",1)?1:0;'))).toBe(1);
    expect(await runGc(fn(SW + " return s.startsWith(undefined)?1:0;"))).toBe(1);
    expect(await runGc(fn(HIT + " return s.search(/b/);"))).toBe(10);
    expect(await runGc(fn(HIT + " return s.search(/zz/);"))).toBe(-1);
  });

  it("keeps the omitted position slot on its #2002 NaN sentinel", async () => {
    // includes/startsWith carry their optional position as an f64, padded with
    // NaN so the host shim drops it and JS applies the spec default. That arm
    // is untouched by `padsUndefined` (which only rewrites externref slots), so
    // a one-argument call must be unaffected — asserted by value with a dynamic
    // needle, which avoids any static-needle fold.
    expect(await runGc(fn('const p=["b"]; ' + HIT + " return s.includes(p[0]!)?1:0;"))).toBe(1);
    expect(await runGc(fn('const p=["zz"]; ' + HIT + " return s.includes(p[0]!)?1:0;"))).toBe(0);
    expect(await runGc(fn('const p=["u"]; ' + SW + " return s.startsWith(p[0]!)?1:0;"))).toBe(1);
    expect(await runGc(fn('const p=["zz"]; ' + SW + " return s.startsWith(p[0]!)?1:0;"))).toBe(0);
  });

  it("leaves indexOf/lastIndexOf — the #5155 cells — untouched", async () => {
    expect(await runGc(fn(HIT + " return s.indexOf();"))).toBe(1);
    expect(await runGc(fn(HIT + " return s.lastIndexOf();"))).toBe(1);
    expect(await runGc(fn(HIT + ' return s.indexOf("b");'))).toBe(10);
    expect(await runGc(fn('const s="abc"; return s.indexOf();'))).toBe(-1);
  });

  it("leaves endsWith/padStart/padEnd — the other padsUndefined members — correct", async () => {
    expect(await runGc(fn('const s="bundefined"; return s.endsWith()?1:0;'))).toBe(1);
    expect(await runGc(fn(HIT + ' return s.endsWith("b")?1:0;'))).toBe(1);
    expect(await runGc(fn('const s="ab"; return s.padStart().length;'))).toBe(2);
    expect(await runGc(fn('const s="ab"; return s.padStart(5).length;'))).toBe(5);
    expect(await runGc(fn('const s="ab"; return s.padEnd(5).length;'))).toBe(5);
  });

  it("does not touch the Array-side family fixed by #5095/#5121", async () => {
    expect(await runGc(fn("const a=[10,20,30]; return a.includes()?1:0;"))).toBe(0);
    expect(await runGc(fn("const a=[10,20,30]; return a.indexOf();"))).toBe(-1);
    expect(await runGc(fn("const a=[10,20,30]; return a.lastIndexOf();"))).toBe(-1);
    expect(await runGc(fn("const a=[10,20,30]; return a.at();"))).toBe(10);
  });

  it("does not touch the other String.prototype omitted-argument shapes", async () => {
    expect(await runGc(fn(HIT + " return s.substring().length;"))).toBe(11);
    expect(await runGc(fn(HIT + " return s.slice().length;"))).toBe(11);
    expect(await runGc(fn(HIT + " return s.split().length;"))).toBe(1);
    expect(await runGc(fn(HIT + " return s.charAt().length;"))).toBe(1);
    expect(await runGc(fn(HIT + " return s.concat().length;"))).toBe(11);
    expect(await runGc(fn('const s="ab"; return s.repeat().length;'))).toBe(0);
    expect(await runGc(fn(HIT + " return (s.at() ?? '').length;"))).toBe(1);
    expect(await runGc(fn(HIT + " return s.codePointAt() ?? -1;"))).toBe(97);
  });
});
