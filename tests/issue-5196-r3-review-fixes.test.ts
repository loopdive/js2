// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5196 round-3 adversarial-review fixes — one control per finding.
 *
 * Every control below was verified to FAIL on the reviewed lane HEAD
 * (`d84b8f14fc`, this file's fixes reverted with a file-copy A/B) and to pass
 * with the fixes in. F1 and F3 are regressions of BASE behaviour, so each also
 * passes on the r3 merge-base `4fa179f8` — pure regression pins. F2's and F4's
 * base answers are themselves wrong (a stable `undefined`, a "not yet
 * implemented" TypeError), so those two pin the CORRECT answer, which base does
 * not produce either; what makes them regression pins is that lane HEAD turned
 * base's stable wrong answer into a THROW (F2) and into a wasm TRAP (F4).
 *
 * F1 — `var P = Proxy; P = K; new P(5, 6)` constructed a proxy from a binding
 *      that no longer held `Proxy` (`undefined false object` where node and
 *      base both say `5 true object`).
 * F2 — the unconditional positive-object-brand guard on `Reflect.get`/
 *      `Reflect.has` threw a TypeError for 13 of 14 ordinary target kinds.
 * F3 — `var r = Proxy.revocable(t,h).revoke; r = K; new r()` threw statically
 *      off the DECLARATION initializer, ignoring the later assignment.
 * F4 — `var R = Proxy.revocable; R(t, {get(){…}})` TRAPPED (`illegal cast`)
 *      when the handler was an inline object literal.
 *
 * F2 and F4 reproduce only under the REVIEW harness's compile options
 * (`nativeStrings` + `hostBridge: "always"` + `deferTopLevelInit`, top-level
 * program text) — the same options `.tmp/probe.mts` uses. Wrapping the same
 * source in an exported function made both findings disappear, so these two
 * controls run the program text as-is and read the standalone stdout buffer,
 * exactly as the review probes do.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const TIMEOUT_MS = 240_000;

/** The review harness's standalone lane: compile, assert zero imports, run. */
async function runStandaloneProgram(source: string, label: string): Promise<string[]> {
  const result = await compile(source, {
    allowJs: true,
    fileName: `issue-5196-r3-review-${label}.ts`,
    skipSemanticDiagnostics: true,
    target: "standalone" as const,
    nativeStrings: true,
    hostBridge: "always" as const,
    deferTopLevelInit: true,
  });
  expect(
    result.success,
    `${label} compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return [];
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, `${label} must emit zero imports`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exp = instance.exports as Record<string, unknown>;
  // A TRAP here is the finding: it propagates as a WebAssembly.RuntimeError and
  // fails the test, which is exactly what the F4 control asserts against.
  if (typeof exp.__module_init === "function") (exp.__module_init as () => void)();
  if (typeof exp.main === "function") (exp.main as () => void)();
  const lines: string[] = [];
  if (typeof exp.__stdout_prepare === "function" && typeof exp.__stdout_char === "function") {
    const len = (exp.__stdout_prepare as () => number)() | 0;
    let sink = "";
    for (let i = 0; i < len; i++) sink += String.fromCharCode((exp.__stdout_char as (i: number) => number)(i) & 0xffff);
    for (const line of sink.split("\n")) if (line.length > 0) lines.push(line);
  }
  return lines;
}

/** The exported-function lane, for the two controls that reproduce in it. */
async function runStandaloneTest(source: string, label: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: `issue-5196-r3-review-${label}.ts`,
    skipSemanticDiagnostics: true,
    target: "standalone" as const,
  });
  expect(
    result.success,
    `${label} compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return -1;
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  expect(imports, `${label} must emit zero imports`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5196 round-3 review fixes", () => {
  it("F1: a REASSIGNED alias of the Proxy constructor is not claimed", { timeout: TIMEOUT_MS }, async () => {
    // Also passes on the merge-base: this is a pure regression pin.
    expect(
      await runStandaloneTest(
        `
        class K { v: number; constructor(a: number) { this.v = a; } }
        export function test(): number {
          let P: any = Proxy;
          P = K;
          const o: any = new P(5, 6);
          if (o.v !== 5) return 1;
          if (!(o instanceof K)) return 2;
          // A binding that is NEVER written still takes the Proxy path.
          const Q: any = Proxy;
          const p: any = new Q({ a: 1 }, { get(_t: any, k: any): any { return k === "zz" ? 42 : 1; } });
          if (p.zz !== 42) return 3;
          return 0;
        }
      `,
        "f1",
      ),
    ).toBe(0);
  });

  it("F2: Reflect.get/has admit ordinary objects and still reject primitives", { timeout: TIMEOUT_MS }, async () => {
    // The review's own 14-target sweep (`p/r32/01-get-has-targets-a.js`),
    // reduced to two counters. Lane HEAD: `threw=13 wins=3`. Base:
    // `threw=0 wins=0`. Node and the fixed lane: `threw=0 wins=3` — no ordinary
    // object throws (never worse than base) and the primitive rejections are
    // node parity (better than base).
    expect(
      await runStandaloneProgram(
        `
        class C { constructor() { this.k = 1; } }
        function fn() {} fn.k = 2;
        var m = new Map(); var s = new Set(); var d = new Date(0); var re = /x/;
        var er = new Error("e"); er.k = 3;
        var vals = [[1, 2], new C(), fn, () => 1, fn.bind(null), m, s, d, re, er,
                    new Number(1), new String("ab"), new Boolean(true), { k: 4 }];
        var threw = 0;
        for (var i = 0; i < vals.length; i++) {
          try { Reflect.get(vals[i], "k"); Reflect.has(vals[i], "k"); } catch (e) { threw++; }
        }
        var wins = 0;
        try { Reflect.get(1, "x"); } catch (e) { if (e instanceof TypeError) wins++; }
        try { Reflect.has(1, "x"); } catch (e) { if (e instanceof TypeError) wins++; }
        try { Reflect.get("ab", "length"); } catch (e) { if (e instanceof TypeError) wins++; }
        console.log("threw=" + threw + " wins=" + wins);
      `,
        "f2",
      ),
    ).toEqual(["threw=0 wins=3"]);
  });

  it("F3: a REASSIGNED revoker binding is not statically non-constructable", { timeout: TIMEOUT_MS }, async () => {
    // Also passes on the merge-base: a pure regression pin.
    expect(
      await runStandaloneTest(
        `
        class K { v: number; constructor() { this.v = 7; } }
        export function test(): number {
          let r: any = Proxy.revocable({}, {}).revoke;
          r = K;
          const o: any = new r();
          if (o.v !== 7) return 1;

          // A binding that is never written keeps the §13.3.5.1 throw.
          const fixed: any = Proxy.revocable({}, {}).revoke;
          try {
            const bad: any = new fixed();
            if (bad !== null) return 2;
            return 3;
          } catch (e) {
            if (!(e instanceof TypeError)) return 4;
          }
          return 0;
        }
      `,
        "f3",
      ),
    ).toBe(0);
  });

  it("F4: Proxy.revocable as a VALUE with an inline trap handler does not trap", { timeout: TIMEOUT_MS }, async () => {
    // Lane HEAD: wasm TRAP `illegal cast` — which surfaces here as a
    // WebAssembly.RuntimeError out of `__module_init`. Base: a catchable
    // "Proxy.revocable is not yet implemented in --target standalone".
    // Node and the fixed lane produce the three lines below.
    //
    // The values are read through `String(...)`, not passed to `console.log`
    // directly, because `console.log(<proxy get result>)` prints NOTHING on
    // standalone for a revocable proxy — measured on BASE with the direct
    // `Proxy.revocable(t, h)` spelling (`p/f4b/04`), so it is a pre-existing
    // stringification gap, not this change.
    expect(
      await runStandaloneProgram(
        `
        var R = Proxy.revocable;
        var pr = R({ a: 1 }, { get(t, k) { return 7; } });
        console.log("v=" + String(pr.proxy.a) + " rt=" + typeof pr.revoke);
        pr.revoke();
        try { pr.proxy.a; console.log("no-throw"); } catch (e) { console.log("T:" + e.constructor.name); }
        var plain = R({ b: 2 }, {});
        console.log("plain=" + String(plain.proxy.b));
      `,
        "f4",
      ),
    ).toEqual(["v=7 rt=function", "T:TypeError", "plain=2"]);
  });
});
