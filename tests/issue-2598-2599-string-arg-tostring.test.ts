import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2598 — Standalone String search-method (indexOf/lastIndexOf/includes/
//   startsWith/endsWith/localeCompare) argument ToString (§7.1.17) + IsRegExp
//   throw guard (§22.1.3.{6,7,21}) for a statically-typed string receiver.
// #2599 — Standalone String.prototype.concat variadic + non-string-argument
//   ToString (§22.1.3.4).
//
// Root cause (both): a non-string argument was fed straight to the native
// `__str_flatten` / `__str_concat` helper without ToString, null-deref-trapping.
// The fix routes each argument through the existing native-string coercion
// engine (`compileNativeConcatOperand`, the same path `+`-concat uses) — no new
// #2108 coercion site. Receiver is a typed string ⇒ substrate-independent; the
// `any`/dynamic-RECEIVER forms are deferred to #2580 M2.
//
// `skipSemanticDiagnostics` mirrors the test262 runner — a JS test passing a
// non-string to a `(searchString: string)` method is not a hard TS error there.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function runGc(src: string): Promise<unknown> {
  const r = await compile(src, { skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2598 standalone String search-method argument ToString", () => {
  it("indexOf(null) → ToString('null'), found at 1", async () => {
    expect(await runStandalone(`export function test(): number { return "gnulluna".indexOf(null); }`)).toBe(1);
  });

  it("indexOf(undefined) → ToString('undefined')", async () => {
    expect(
      await runStandalone(`export function test(): number { return String("undefined").indexOf(undefined); }`),
    ).toBe(0);
  });

  it("lastIndexOf(null) → ToString('null')", async () => {
    expect(await runStandalone(`export function test(): number { return "nullnull".lastIndexOf(null); }`)).toBe(4);
  });

  it("includes(number) → ToString('1'), no null-deref", async () => {
    expect(await runStandalone(`export function test(): number { return "a1b".includes(1) ? 1 : 0; }`)).toBe(1);
  });

  it("startsWith(boolean) → ToString('true')", async () => {
    expect(await runStandalone(`export function test(): number { return "trueX".startsWith(true) ? 1 : 0; }`)).toBe(1);
  });

  it("endsWith(number) → ToString('2')", async () => {
    expect(await runStandalone(`export function test(): number { return "x2".endsWith(2) ? 1 : 0; }`)).toBe(1);
  });

  it("localeCompare(number) → ToString('1'), equal to '1'", async () => {
    expect(await runStandalone(`export function test(): number { return "1".localeCompare(1); }`)).toBe(0);
  });

  // §22.1.3.{6,7,21} IsRegExp-throw arms (includes/startsWith/endsWith only).
  it("includes(/regexp/) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { "x".includes(/./); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("startsWith(/regexp/) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { "x".startsWith(/./); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("endsWith(/regexp/) throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { "x".endsWith(/./); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("new RegExp(...) literal also throws for includes", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { "x".includes(new RegExp("a")); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  // indexOf/lastIndexOf/localeCompare do NOT throw on a RegExp — they ToString it
  // to its source form ("/./"), then search.
  it("indexOf(/regexp/) does NOT throw — ToString to source '/./'", async () => {
    expect(await runStandalone(`export function test(): number { return "a/./b".indexOf(/./); }`)).toBe(1);
  });

  // Regression guards — ordinary string args unchanged.
  it("indexOf('ll') unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "hello".indexOf("ll"); }`)).toBe(2);
  });

  it("includes('ell') unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "hello".includes("ell") ? 1 : 0; }`)).toBe(1);
  });
});

describe("#2599 standalone String.prototype.concat argument ToString + variadic", () => {
  it("variadic string args fold correctly", async () => {
    expect(await runStandalone(`export function test(): number { return "a".concat("b","c","d").length; }`)).toBe(4);
  });

  it("concat(number) → ToString('1'), no null-deref", async () => {
    // "a1" → charCodeAt(1) === '1' (49)
    expect(await runStandalone(`export function test(): number { return "a".concat(1).charCodeAt(1); }`)).toBe(49);
  });

  it("concat(boolean) → ToString('true')", async () => {
    // "atrue" → charCodeAt(1) === 't' (116)
    expect(await runStandalone(`export function test(): number { return "a".concat(true).charCodeAt(1); }`)).toBe(116);
  });

  it("concat(null) → ToString('null')", async () => {
    // "anull" → charCodeAt(1) === 'n' (110)
    expect(await runStandalone(`export function test(): number { return "a".concat(null).charCodeAt(1); }`)).toBe(110);
  });

  it("concat(undefined) → ToString('undefined')", async () => {
    // "aundefined" → charCodeAt(1) === 'u' (117)
    expect(await runStandalone(`export function test(): number { return "a".concat(undefined).charCodeAt(1); }`)).toBe(
      117,
    );
  });

  it("mixed variadic preserves left-to-right fold order", async () => {
    // "a" + "b" + 2 + "c" → "ab2c", length 4
    expect(await runStandalone(`export function test(): number { return "a".concat("b",2,"c").length; }`)).toBe(4);
  });

  it("concat() with no args returns the receiver", async () => {
    expect(await runStandalone(`export function test(): number { return "abc".concat().length; }`)).toBe(3);
  });

  // Regression — ordinary string concat unchanged.
  it("concat('yz') unchanged", async () => {
    expect(await runStandalone(`export function test(): number { return "x".concat("yz").length; }`)).toBe(3);
  });
});

describe("#2598/#2599 gc-mode (host path) is unchanged", () => {
  it("gc concat string", async () => {
    expect(await runGc(`export function test(): number { return "x".concat("yz").length; }`)).toBe(3);
  });

  it("gc indexOf string", async () => {
    expect(await runGc(`export function test(): number { return "hello".indexOf("ll"); }`)).toBe(2);
  });

  it("gc includes string", async () => {
    expect(await runGc(`export function test(): number { return "hello".includes("ell") ? 1 : 0; }`)).toBe(1);
  });
});
