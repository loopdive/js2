// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B5b) The inline half of the `@@replace` pin suite —
 * see `issue-6651-regexp-replace-protocol-b5.test.ts` for the test262 rows and
 * for why the halves are separate files.
 *
 * Each case compiles a small standalone program and reads its `run()` string
 * back: GetSubstitution against captured strings (`$&`, `` $` ``, `$'`, `$n`,
 * `$nn`, an undefined capture, out-of-range and `$0` literals, `$$`, `$<name>`
 * with no groups, a trailing `$`), a functional replacer's arguments and
 * `this`, the global collect loop on a real RegExp, and the ungated spellings.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile standalone, assert no host import leaked, and return what the
 * source's `run(): string` answers (read back one code unit at a time, since a
 * standalone string is an opaque GC ref on the JS side).
 */
async function runStandalone(source: string, fileName: string): Promise<string> {
  const program = `${source}
let __out = "";
export function prepare(): number { __out = run(); return __out.length; }
export function unit(i: number): number { return __out.charCodeAt(i); }
`;
  const result = await compile(program, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { prepare: () => number; unit: (i: number) => number };
  const length = exports.prepare();
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(exports.unit(i));
  return text;
}

describe("#6651 B5 — RegExp.prototype[@@replace], generic, standalone (inline)", () => {
  it("GetSubstitution expands every pattern against captured strings", async () => {
    // One result: matched "b" at 1 in "abc", captures ["x", undefined].
    const source = `
function run(): string {
  const r: any = /./;
  r.exec = function (): any {
    return { length: 3, 0: "b", 1: "x", 2: undefined, index: 1 };
  };
  return r[Symbol.replace]("abc", "[$&|$\`|$'|$1|$01|$2|$3|$0|$$|$<n>|$]");
}
`;
    expect(await runStandalone(source, "b5-get-substitution.ts")).toBe("a[b|a|c|x|x||$3|$0|$|$<n>|$]c");
  }, 200_000);

  it("a functional replacer receives «matched, …captures, position, S» with this undefined", async () => {
    const source = `
function run(): string {
  const r: any = /./;
  r.exec = function (): any {
    return { length: 2, 0: "b", 1: "q", index: 1 };
  };
  let seen = "";
  const out = r[Symbol.replace]("abc", function (this: any, m: any, c1: any, pos: any, s: any): any {
    seen = String(this === undefined) + ":" + m + ":" + c1 + ":" + pos + ":" + s + ":" + arguments.length;
    return "<" + m + ">";
  });
  return seen + "|" + out;
}
`;
    expect(await runStandalone(source, "b5-functional-replacer.ts")).toBe("true:b:q:1:abc:4|a<b>c");
  }, 200_000);

  it("the global collect loop on a real RegExp advances empty matches", async () => {
    const source = `
function run(): string {
  const replace: any = (RegExp.prototype as any)[Symbol.replace];
  return replace.call(/(?:)/g, "ab", "-") + "|" + replace.call(/b/g, "abcb", "$&$&") + "|" + replace.call(/b/, "abcb", "X");
}
`;
    expect(await runStandalone(source, "b5-global-collect.ts")).toBe("-a-b-|abbcbb|aXcb");
  }, 200_000);

  it("control — the ungated direct and String spellings keep their answers", async () => {
    const source = `
function run(): string {
  const re = /b/g;
  return re[Symbol.replace]("abcb", "x") + "|" + "abc".replace(/b/, "x") + "|" + "a-b".replace(/-/, "$&$&");
}
`;
    expect(await runStandalone(source, "b5-replace-static-control.ts")).toBe("axcx|axc|a--b");
  }, 200_000);
});
