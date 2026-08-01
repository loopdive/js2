// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4016 — the standalone `String.prototype` search-value methods must take the
 * spec's plain-`ToString` path instead of refusing.
 *
 * `match`/`matchAll`/`search`/`replace`/`replaceAll`/`split` all start by asking
 * `GetMethod(searchValue, @@<protocol>)`. Only when that comes back `undefined`
 * do they fall through to their own string path — `ToString(searchValue)` for
 * `split`, `RegExpCreate(ToString(searchValue), …)` for `search`/`match`. The
 * standalone lane used to refuse the whole call whenever the argument was not a
 * statically-known backend RegExp, conflating "not a RegExp" with "needs a JS
 * host".
 *
 * Every expectation below was taken from Node BEFORE it was asserted here.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // The whole point of the standalone lane: no host to fall back on.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

describe("#4016 — String.prototype.search coerces its search value", () => {
  it.each([
    // `RegExpCreate(undefined)` is the EMPTY pattern, not the text "undefined".
    ["absent argument", `return "".search();`, 0],
    ["absent argument, non-empty subject", `return "--undefined--".search();`, 0],
    ["string argument", `return new String("test string").search("string") as number;`, 5],
    ["no match", `return "abc".search("z");`, -1],
    ["number argument", `return "this123is".search(123);`, 4],
    ["null argument", `return "gnulluna".search(null as any);`, 1],
  ])("%s", async (_label, body, want) => {
    expect(await runStandalone(`export function f(): number { ${body} }`)).toBe(want);
  });

  it("dispatches an overridden toString on an object search value", async () => {
    const src = `
      export function f(): number {
        const o = { toString() { return "AB"; } };
        return "ssABBABABAB".search(o as any);
      }`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("treats the coerced source as a PATTERN, not a literal substring", async () => {
    // The distinguishing case: `search` builds a RegExp, so metacharacters are
    // live. `"a.c".search("a.c")` matching at 0 proves nothing; this does.
    const src = `export function f(): number { return "xxabc".search("a.c"); }`;
    expect(await runStandalone(src)).toBe(2);
  });
});

describe("#4016 — String.prototype.match coerces its search value", () => {
  it("returns an exec-shaped result for a string argument", async () => {
    const src = `
      export function f(): string {
        const m = "ssABBABABAB".match("AB");
        if (m === null) return "null";
        return (m[0] as string) + "|" + String((m as any).index) + "|" + String(m.length);
      }`;
    expect(await runStandalone(src)).toBe("AB|2|1");
  });

  it("an absent argument builds the empty pattern", async () => {
    const src = `
      export function f(): string {
        const m = "".match();
        if (m === null) return "null";
        return "[" + (m[0] as string) + "]|" + String((m as any).index) + "|" + String(m.length);
      }`;
    expect(await runStandalone(src)).toBe("[]|0|1");
  });

  it("returns null when the coerced pattern does not match", async () => {
    const src = `export function f(): number { return "abc".match("z") === null ? 1 : 0; }`;
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4016 — String.prototype.split coerces its separator", () => {
  it("splits on a number separator", async () => {
    const src = `
      export function f(): string {
        const a = "this123is123a".split(123 as any);
        return String(a.length) + "|" + a[0] + "|" + a[2];
      }`;
    expect(await runStandalone(src)).toBe("3|this|a");
  });

  it("splits on ToString(null) === \"null\"", async () => {
    const src = `
      export function f(): string {
        const a = "gnulluna".split(null as any);
        return String(a.length) + "|" + a[0] + "|" + a[1];
      }`;
    expect(await runStandalone(src)).toBe("2|g|una");
  });

  it("honours an overridden toString separator and an overridden valueOf limit", async () => {
    const src = `
      export function f(): string {
        const sep = { toString() { return "BB"; } };
        const lim = { valueOf() { return true; } };
        const a = "ABBABABAB".split(sep as any, lim as any);
        return String(a.length) + "|" + a[0];
      }`;
    expect(await runStandalone(src)).toBe("1|A");
  });

  it("an UNDEFINED separator does not split — and is not ToString'd to \"undefined\"", async () => {
    // The silent-wrong-answer this change had to avoid: §22.1.3.23 step 2 exits
    // early for undefined, so the result is [S]. Splitting on the text
    // "undefined" would give ["", "-here"] here.
    const src = `
      export function f(): string {
        function nothing(): void {}
        const a = "undefined-here".split(nothing() as any);
        return String(a.length) + "|" + a[0];
      }`;
    expect(await runStandalone(src)).toBe("1|undefined-here");
  });

  it("still evaluates a side-effecting undefined separator expression", async () => {
    const src = `
      export function f(): number {
        let calls = 0;
        function bump(): void { calls = calls + 1; }
        const a = "abc".split(bump() as any);
        return calls * 10 + a.length;
      }`;
    expect(await runStandalone(src)).toBe(11);
  });
});

describe("#4016 — the refusal is NARROWED, not removed", () => {
  const refusal = /with a RegExp or symbol-protocol search value is not supported/;

  it("still refuses a search value that could carry @@split", async () => {
    // An `any`-typed value cannot be proven free of `[Symbol.split]`, so the
    // spec's protocol dispatch might apply. Refusing loudly beats guessing.
    const r = await compile(
      `export function f(): number { const sep: any = JSON.parse("1"); return "abc".split(sep).length; }`,
      { target: "standalone" },
    );
    expect(r.success && r.errors.every((e) => !refusal.test(e.message))).toBe(false);
  });

  it("still refuses an explicit @@split implementor", async () => {
    const r = await compile(
      `export function f(): number {
         const sep = { [Symbol.split](s: string) { return ["x"]; } };
         return "abc".split(sep as any).length;
       }`,
      { target: "standalone" },
    );
    expect(r.success && r.errors.every((e) => !refusal.test(e.message))).toBe(false);
  });

  it("a statically-known RegExp argument keeps its existing native lowering", async () => {
    const src = `export function f(): number { return "xxabc".search(/a.c/); }`;
    expect(await runStandalone(src)).toBe(2);
  });
});
