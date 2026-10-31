// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7163 — `#x in o` with `o` typed `C | null` or `C | undefined` returned
// false for a nullish receiver instead of throwing TypeError (§13.10.1 step 1).
// The receiver lowers as a nullable struct ref, not externref, so the #7150
// non-object guard never ran. Each row is diffed against native JS on the
// standalone and wasi lanes, for every private kind (field, method, accessor,
// static), with positive and negative controls.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const PRELUDE = `
class C {
  #v = 1;
  #m() {}
  get #g() { return 1; }
  static #s = 1;
  static fn(o: C | null) { return #v in o; }
  static fu(o: C | undefined) { return #v in o; }
  static fnu(o: C | null | undefined) { return #v in o; }
  static mn(o: C | null) { return #m in o; }
  static mu(o: C | undefined) { return #m in o; }
  static gn(o: C | null) { return #g in o; }
  static gu(o: C | undefined) { return #g in o; }
  static sn(o: typeof C | null) { return #s in o; }
  static su(o: typeof C | undefined) { return #s in o; }
  static snu(o: typeof C | null | undefined) { return #s in o; }
  static plain(o: C) { return #v in o; }
}
class D extends C {}
class E { #v = 1; }
function t(f: () => boolean): number { try { return f() ? 1 : 0; } catch (e) { return e instanceof TypeError ? 2 : 3; } }
`;

const ROWS: [string, string][] = [];
for (const [label, fn, nullish] of [
  ["field, C | null", "C.fn", ["null"]],
  ["field, C | undefined", "C.fu", ["undefined"]],
  ["field, C | null | undefined", "C.fnu", ["null", "undefined"]],
  ["method, C | null", "C.mn", ["null"]],
  ["method, C | undefined", "C.mu", ["undefined"]],
  ["accessor, C | null", "C.gn", ["null"]],
  ["accessor, C | undefined", "C.gu", ["undefined"]],
] as const) {
  for (const v of [...nullish, "new C()", "new D()", "new E() as any"]) {
    ROWS.push([`${label}: ${fn}(${v})`, `return t(() => ${fn}(${v}));`]);
  }
}
for (const [label, fn, nullish] of [
  ["static, typeof C | null", "C.sn", ["null"]],
  ["static, typeof C | undefined", "C.su", ["undefined"]],
  ["static, typeof C | null | undefined", "C.snu", ["null", "undefined"]],
] as const) {
  for (const v of [...nullish, "C", "D", "new C() as any"]) {
    ROWS.push([`${label}: ${fn}(${v})`, `return t(() => ${fn}(${v}));`]);
  }
}
ROWS.push(
  ["positive control: #v in new C()", `return t(() => C.plain(new C()));`],
  ["negative control: another class's instance", `return t(() => C.plain(new E() as any));`],
  ["nullable local holding an instance", `let o: C | null = new C(); return t(() => C.fn(o));`],
  ["nullable local holding null", `let o: C | null = null; return t(() => C.fn(o));`],
);

async function expectSameOnHostFreeLanes(body: string): Promise<void> {
  const src = `${PRELUDE}function value(): number { ${body} }\nexport function test(): number { return value(); }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of ["standalone", "wasi"] as const) {
    const result = await compile(src, { fileName: "probe.ts", target });
    expect(result.success, `${target}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), target).toBe(expected);
  }
}

describe("#7163 `#x in o` with a typed nullable receiver", () => {
  for (const [name, body] of ROWS) {
    it(name, async () => {
      await expectSameOnHostFreeLanes(body);
    });
  }
});
