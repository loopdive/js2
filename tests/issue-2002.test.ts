import { describe, it, expect } from "vitest";
import { compileAndRunHost as compileAndRun } from "./helpers/compile.js";

// #2002/#2003/#2004 — string-method spec-conformance trio:
//   - startsWith/endsWith/includes must honour the position/endPosition arg
//   - charCodeAt out-of-range returns NaN (not a trap)
//   - codePointAt out-of-range observably yields undefined (so `?? x` fires)
describe("#2002 — startsWith/endsWith/includes honour the position argument", () => {
  it('"hello".startsWith("ll", 2) === true', async () => {
    const e = await compileAndRun(`export function test(): boolean { return "hello".startsWith("ll", 2); }`);
    expect(Boolean(e.test!())).toBe(true);
  });

  it('"hello".endsWith("ll", 4) === true', async () => {
    const e = await compileAndRun(`export function test(): boolean { return "hello".endsWith("ll", 4); }`);
    expect(Boolean(e.test!())).toBe(true);
  });

  it('"hello".includes("ll", 3) === false', async () => {
    const e = await compileAndRun(`export function test(): boolean { return "hello".includes("ll", 3); }`);
    expect(Boolean(e.test!())).toBe(false);
  });

  it("no-position calls are unchanged", async () => {
    const sw = await compileAndRun(`export function test(): boolean { return "hello".startsWith("he"); }`);
    expect(Boolean(sw.test!())).toBe(true);
    const ew = await compileAndRun(`export function test(): boolean { return "hello".endsWith("lo"); }`);
    expect(Boolean(ew.test!())).toBe(true);
    const inc = await compileAndRun(`export function test(): boolean { return "hello".includes("ell"); }`);
    expect(Boolean(inc.test!())).toBe(true);
  });

  it("pads the position argument through an optional receiver chain", async () => {
    const e = await compileAndRun(`
      export function test(): boolean {
        const root = globalThis;
        return root.navigator?.platform?.startsWith("Win") ?? false;
      }
    `);
    expect(Boolean(e.test!())).toBe(process.platform === "win32");
  });

  it("position-arg miss cases match Node", async () => {
    const sw = await compileAndRun(`export function test(): boolean { return "hello".startsWith("lo", 1); }`);
    expect(Boolean(sw.test!())).toBe(false);
    const ew = await compileAndRun(`export function test(): boolean { return "hello".endsWith("hello", 5); }`);
    expect(Boolean(ew.test!())).toBe(true);
    const inc = await compileAndRun(`export function test(): boolean { return "hello".includes("lo", 3); }`);
    expect(Boolean(inc.test!())).toBe(true);
  });
});

describe("#2003 — charCodeAt out-of-range returns NaN", () => {
  it('"abc".charCodeAt(99) is NaN', async () => {
    const e = await compileAndRun(`export function test(): number { return "abc".charCodeAt(99); }`);
    expect(Number.isNaN(e.test!() as number)).toBe(true);
  });

  it('"abc".charCodeAt(-1) is NaN', async () => {
    const e = await compileAndRun(`export function test(): number { return "abc".charCodeAt(-1); }`);
    expect(Number.isNaN(e.test!() as number)).toBe(true);
  });

  it("in-range charCodeAt is unchanged", async () => {
    const e0 = await compileAndRun(`export function test(): number { return "abc".charCodeAt(0); }`);
    expect(e0.test!()).toBe(97);
    const e1 = await compileAndRun(`export function test(): number { return "abc".charCodeAt(1); }`);
    expect(e1.test!()).toBe(98);
    const last = await compileAndRun(`export function test(): number { return "abc".charCodeAt(2); }`);
    expect(last.test!()).toBe(99);
    const noarg = await compileAndRun(`export function test(): number { return "abc".charCodeAt(); }`);
    expect(noarg.test!()).toBe(97);
  });

  it("charCodeAt stays usable inside an i32 hash loop", async () => {
    const e = await compileAndRun(`export function test(): number {
      let h = 0; const s = "abc";
      for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
      return h;
    }`);
    const expected = (("a".charCodeAt(0) * 31 + "b".charCodeAt(0)) * 31 + "c".charCodeAt(0)) | 0;
    expect(e.test!()).toBe(expected);
  });
});

describe("#2004 — codePointAt out-of-range is undefined-observable via ??", () => {
  it('"ab".codePointAt(5) ?? -1 === -1', async () => {
    const e = await compileAndRun(`export function test(): number { return "ab".codePointAt(5) ?? -1; }`);
    expect(e.test!()).toBe(-1);
  });

  it('"ab".codePointAt(-1) ?? -1 === -1', async () => {
    const e = await compileAndRun(`export function test(): number { return "ab".codePointAt(-1) ?? -1; }`);
    expect(e.test!()).toBe(-1);
  });

  it("in-range codePointAt ?? is unchanged", async () => {
    const e0 = await compileAndRun(`export function test(): number { return "ab".codePointAt(0) ?? -1; }`);
    expect(e0.test!()).toBe(97);
    const e1 = await compileAndRun(`export function test(): number { return "ab".codePointAt(1) ?? -1; }`);
    expect(e1.test!()).toBe(98);
  });

  it("surrogate-pair code point survives ??", async () => {
    const e = await compileAndRun(`export function test(): number { return "\u{1F600}".codePointAt(0) ?? -1; }`);
    expect(e.test!()).toBe(0x1f600);
  });
});
