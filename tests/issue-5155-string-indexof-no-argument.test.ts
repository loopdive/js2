import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #5155 — `String.prototype.indexOf()` with NO argument answered `-1` in the
//   gc (JS-host) lane where §22.1.3.9 requires `ToString(searchString)`: an
//   absent argument becomes the STRING "undefined", which sits at position 1 of
//   the probe "aundefinedb". Standalone was already correct.
//
//   Root cause (src/codegen/expressions/call-receiver-method.ts): the loop that
//   pads a host import's missing optional arguments keeps a `padsUndefined` set
//   of methods whose omitted externref slots must carry JS `undefined` (via
//   `__get_undefined`) rather than `ref.null.extern`. `lastIndexOf` was in that
//   set; `indexOf` was not — so the absent search slot reached the host as JS
//   `null` and the method searched for "null". That is precisely why
//   `"aundefinedb".lastIndexOf()` already answered 1 on the same probe while
//   `indexOf()` answered -1.
//
//   This is the ABSENT-argument spelling. #3763 fixed the *explicit*
//   undefined-VALUED spelling of the same method (a hoisted `var` read before
//   its declaration collapsing to `ref.null.extern`); its hook
//   `tryCompileIndexOfHoistedUndefinedSearch` only fires when `args[0]` exists,
//   so a zero-argument call never reached it.
//
//   NOT fixed here — the identical defect in three siblings that share this
//   list (measured on the same base, gc lane): `"aundefinedb".includes()` is
//   false, `"undefinedb".startsWith()` is false, and `"aundefinedb".search()`
//   is -1, all spec-wrong and all correct in standalone. They are recorded as a
//   follow-up in the issue file rather than widened into this change.
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
// "undefined" occurs at index 1; "null" does not occur at all, so the two
// wrong answers are distinguishable from each other and from a generic -1.
const HIT = 'const s="aundefinedb";';

describe("#5155 — String.prototype.indexOf with no argument", () => {
  it('searches for the string "undefined" in the gc lane', async () => {
    expect(await runGc(fn(HIT + " return s.indexOf();"))).toBe(1);
  });

  it('searches for the string "undefined" in the standalone lane', async () => {
    expect(await runStandalone(fn(HIT + " return s.indexOf();"))).toBe(1);
  });

  it('still answers -1 when "undefined" does not occur', async () => {
    // Guards against a fix that simply returns a fixed index: the receiver here
    // contains neither "undefined" nor "null".
    expect(await runGc(fn('const s="abc"; return s.indexOf();'))).toBe(-1);
    expect(await runStandalone(fn('const s="abc"; return s.indexOf();'))).toBe(-1);
  });

  it("applies to a literal receiver and to a dynamic one", async () => {
    expect(await runGc(fn('return "aundefinedb".indexOf();'))).toBe(1);
    expect(await runGc(fn('const a=["aundefinedb"]; return a[0]!.indexOf();'))).toBe(1);
  });

  it('was searching for "null", not merely failing — the null spelling is unchanged', async () => {
    // The defect made the host receive JS `null`. `indexOf(null)` genuinely
    // searches for "null" and must keep doing so; only the ABSENT argument
    // changed meaning.
    expect(await runGc(fn('const s="anullb"; return s.indexOf(null as any);'))).toBe(1);
    expect(await runGc(fn(HIT + " return s.indexOf(null as any);"))).toBe(-1);
  });

  it("compiles the zero-argument form byte-identically to indexOf(undefined)", async () => {
    // The #5121 pin pattern: the two spellings are one binary, so they cannot
    // drift apart later. (They were NOT identical before the fix.)
    const absent = await digestGc(fn(HIT + " return s.indexOf();"));
    const explicit = await digestGc(fn(HIT + " return s.indexOf(undefined);"));
    expect(absent).toBe(explicit);
  });

  it("leaves lastIndexOf — already correct — untouched in both spellings", async () => {
    expect(await runGc(fn(HIT + " return s.lastIndexOf();"))).toBe(1);
    expect(await runGc(fn(HIT + " return s.lastIndexOf(undefined);"))).toBe(1);
    const absent = await digestGc(fn(HIT + " return s.lastIndexOf();"));
    const explicit = await digestGc(fn(HIT + " return s.lastIndexOf(undefined);"));
    expect(absent).toBe(explicit);
  });

  it("leaves explicit-argument indexOf values unchanged", async () => {
    expect(await runGc(fn(HIT + ' return s.indexOf("b");'))).toBe(10);
    expect(await runGc(fn(HIT + ' return s.indexOf("undefined");'))).toBe(1);
    expect(await runGc(fn(HIT + ' return s.indexOf("n",5);'))).toBe(7);
    expect(await runGc(fn(HIT + " return s.indexOf(undefined);"))).toBe(1);
  });

  it("keeps the omitted fromIndex spec-equivalent for a dynamic needle", async () => {
    // The fix pads indexOf's omitted externref slots with `__get_undefined`,
    // which also covers the boxed fromIndex slot of a one-argument call. That
    // is spec-equivalent — ToIntegerOrInfinity of both `null` and `undefined`
    // is +0 (§22.1.3.9 step 4) — but it does move those bytes, so the VALUES
    // are pinned here. A dynamic needle avoids the static-needle fold.
    expect(await runGc(fn('const p=["b"]; ' + HIT + " return s.indexOf(p[0]!);"))).toBe(10);
    expect(await runGc(fn('const p=["b"]; ' + HIT + " return s.indexOf(p[0]!,0);"))).toBe(10);
    expect(await runGc(fn('const p=["n"]; ' + HIT + " return s.indexOf(p[0]!,5);"))).toBe(7);
    expect(await runGc(fn('const p=["zz"]; ' + HIT + " return s.indexOf(p[0]!);"))).toBe(-1);
  });

  it("does not touch the Array-side family fixed by #5095/#5121", async () => {
    expect(await runGc(fn("const a=[10,20,30]; return a.indexOf();"))).toBe(-1);
    expect(await runGc(fn("const a=[10,20,30]; return a.lastIndexOf();"))).toBe(-1);
    expect(await runGc(fn("const a=[10,20,30]; return a.indexOf(20);"))).toBe(1);
    expect(await runGc(fn("const a=[10,20,30]; return a.at();"))).toBe(10);
  });

  it("records the three siblings this change deliberately does NOT fix", async () => {
    // Same `padsUndefined` omission, same lane. Pinned as the OBSERVED wrong
    // values (with the spec answer named in the comment) so the follow-up that
    // fixes them is forced to update this test rather than silently diverge.
    // Spec: includes() → true, startsWith() → true, search() → 0.
    expect(await runGc(fn(HIT + " return s.includes()?1:0;"))).toBe(0);
    expect(await runGc(fn('const s="undefinedb"; return s.startsWith()?1:0;'))).toBe(0);
    expect(await runGc(fn(HIT + " return s.search();"))).toBe(-1);
    // …and that standalone already gets all three right, which is the evidence
    // they are the same host-padding defect and not a semantics gap.
    expect(await runStandalone(fn(HIT + " return s.includes()?1:0;"))).toBe(1);
    expect(await runStandalone(fn('const s="undefinedb"; return s.startsWith()?1:0;'))).toBe(1);
    expect(await runStandalone(fn(HIT + " return s.search();"))).toBe(0);
  });

  it("leaves endsWith/padStart/padEnd — the other padsUndefined members — correct", async () => {
    expect(await runGc(fn('const s="bundefined"; return s.endsWith()?1:0;'))).toBe(1);
    expect(await runGc(fn('const s="ab"; return s.padStart().length;'))).toBe(2);
    expect(await runGc(fn('const s="ab"; return s.padEnd(5).length;'))).toBe(5);
  });
});
