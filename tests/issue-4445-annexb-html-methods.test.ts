// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4445 — the 13 Annex B §B.2.3 HTML string-wrapper methods through the
// VALUE-ERASED shape.
//
// #3069 already lowered the DIRECT `"x".anchor(v)` call natively, and
// tests/issue-3069-annexb-html-wrappers-standalone.test.ts pins that. What was
// missing is `String.prototype.anchor.call(thisArg, v)` (and the transferred
// `obj.anchor = String.prototype.anchor` form): `anchor`…`sup` were absent from
// the `String.prototype` glue's member set, so the reflective proto-closure
// path never resolved them and the call answered `undefined`. That is exactly
// the tail of every test262 `annexB/.../B.2.3.N.js` file — its first assertions
// (direct calls) passed while the `String.prototype.<m>.call(…)` ones did not —
// and the whole of every `this-val-tostring-err.js`, where the abrupt
// `ToString(this)` of CreateHTML step 2 must propagate.
//
// Deliberate choices:
//  1. Assertions are made INSIDE the module and reported as a number — a
//     `string` returned from an exported standalone function does not marshal
//     back across the JS boundary.
//  2. Both lanes run the SAME source: the standalone lane is the one this issue
//     fixes, the gc/JS-host lane is the no-regression control.
//  3. Every expectation is the value Node produces for the same source, so a
//     failure means a compiler defect rather than a wrong assertion.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + run `test()` on the host-free standalone lane (no imports at all). */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

/** Compile + run `test()` on the default JS-host (gc) lane. */
async function runHost(src: string): Promise<number> {
  const r = await compile(src);
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

/** Run the same source on both lanes and assert both answer `want`. */
async function bothLanes(src: string, want: number): Promise<void> {
  expect(await runStandalone(src), "standalone").toBe(want);
  expect(await runHost(src), "gc/JS-host").toBe(want);
}

describe("#4445 reflective String.prototype HTML wrappers (§B.2.3)", () => {
  it("returns the CreateHTML string through String.prototype.<m>.call", async () => {
    // One tag-only method (arity 0 — its closure has no argument slot) and one
    // attribute method (arity 1) per shape.
    await bothLanes(
      `export function test(): number {
         if (String.prototype.bold.call("x") !== "<b>x</b>") return 1;
         if (String.prototype.sup.call("x") !== "<sup>x</sup>") return 2;
         if (String.prototype.anchor.call("_", "b") !== '<a name="b">_</a>') return 3;
         if (String.prototype.link.call("_", "u") !== '<a href="u">_</a>') return 4;
         if (String.prototype.fontcolor.call("_", "red") !== '<font color="red">_</font>') return 5;
         if (String.prototype.fontsize.call("_", "3") !== '<font size="3">_</font>') return 6;
         return 0;
       }`,
      0,
    );
  });

  it("escapes each '\"' in the attribute value (CreateHTML step 4.b)", async () => {
    await bothLanes(
      `export function test(): number {
         return String.prototype.anchor.call("_", '"x"') === '<a name="&quot;x&quot;">_</a>' ? 0 : 1;
       }`,
      0,
    );
  });

  it('stringifies an absent/undefined attribute argument as "undefined"', async () => {
    // §B.2.3.2.1 step 4.b coerces the value even when it is `undefined` — unlike
    // `concat`'s step-3 skip, so the closure's null arg pad must NOT be dropped.
    await bothLanes(
      `export function test(): number {
         if ("".link(undefined as unknown as string) !== '<a href="undefined"></a>') return 1;
         if (String.prototype.anchor.call("_") !== '<a name="undefined">_</a>') return 2;
         return 0;
       }`,
      0,
    );
  });

  it("coerces a non-string receiver via ToString (CreateHTML step 2)", async () => {
    await bothLanes(
      `export function test(): number {
         return String.prototype.big.call(42 as unknown as string) === "<big>42</big>" ? 0 : 1;
       }`,
      0,
    );
  });

  it("propagates an abrupt ToString(this) from CreateHTML step 2", async () => {
    // The receiver coercion happens BEFORE the attribute coercion, so this
    // receiver's throw is what escapes even though an argument is supplied.
    await bothLanes(
      `export function test(): number {
         const thisVal = { toString: function(): string { throw new Error("boom"); } };
         try {
           String.prototype.anchor.call(thisVal as unknown as string, "b");
         } catch (e) {
           return 0;
         }
         return 1;
       }`,
      0,
    );
  });

  it("throws TypeError for a null or undefined receiver (RequireObjectCoercible)", async () => {
    await bothLanes(
      `export function test(): number {
         let threwUndefined = 0;
         let threwNull = 0;
         try { String.prototype.anchor.call(undefined as unknown as string); } catch (e) { threwUndefined = 1; }
         try { String.prototype.bold.call(null as unknown as string); } catch (e) { threwNull = 1; }
         return threwUndefined === 1 && threwNull === 1 ? 0 : 1;
       }`,
      0,
    );
  });
});

describe("#4445 reflective HTML wrappers stay host-free in standalone", () => {
  it("emits no env import", async () => {
    const r = await compile(`export function test(): string { return String.prototype.anchor.call("x", '"y"'); }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
    const envImports = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
    expect(envImports).toEqual([]);
  });
});
