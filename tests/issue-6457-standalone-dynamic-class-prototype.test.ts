// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6457 — `K.prototype` where `K` is a class OBJECT reached through an
// `any`-typed binding, under `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. The defect was found through the compiled
// `@js-temporal/polyfill` provider (#5383 S11): every row of
// `built-ins/Temporal/ZonedDateTime/prototype/*/{branding,prop-desc}.js` died
// with `TypeError: Cannot convert undefined or null to object`, which is
// `Object.getOwnPropertyDescriptor` receiving `undefined` from
// `Temporal.ZonedDateTime.prototype`. Across a link every `Temporal.X` is a
// dynamic receiver, so the read took the dynamic route always.
//
// It is NOT a link-boundary defect — that was the S10 hand-off's attribution
// and it was wrong. The identical read fails in ONE standalone module with no
// provider, no link and no `Temporal`, which is what this file compiles.
//
// Mechanism: `__extern_get` reaches a class object through
// `__class_proto_lookup`'s class-object arm, which answers the class's STATIC
// SIDECAR `$Object` (static methods and accessors). `prototype` is not on it,
// and nothing else in the dynamic ladder knew a class value has a prototype
// singleton at all, so the read fell to the native's miss.
//
// NOT covered here, on purpose: `new K(1) instanceof K` with a dynamic `K` is
// still `false`. It reads `K.prototype` per §13.10.2 but through a DIFFERENT
// route — `__closure_proto_of`, whose class arm deliberately does not vivify a
// lazy `__proto_<C>` and therefore answers `null`. That is a separate fix with
// its own risk surface (a wrong `instanceof` is worse than a missing one), so
// it is named in #6457 with this same reduction rather than widened into here.
// The last `it` PINS that residual, so the day someone fixes it the stale
// expectation fails loudly instead of rotting.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = {
  target: "standalone" as const,
  hostBridge: "off" as const,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `source` standalone, instantiate with an EMPTY import object (so a
 * leaked host import fails the test rather than being papered over), and run
 * the exported `run`.
 */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, STANDALONE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const binary = result.binary as Uint8Array;
  const module = await WebAssembly.compile(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return Number((instance.exports as { run: () => number }).run());
}

/** 1 undefined · 2 null · 3 object · 4 function · 5 string · 6 number. */
const CLASSIFY = `function __c(v){ if (v===undefined) return 1; if (v===null) return 2;
  const t=typeof v; return t==="object"?3:t==="function"?4:t==="string"?5:t==="number"?6:9; }`;

const CLASS = `class C { constructor(d) { this._d = d; } get day() { return this._d; }
  equals(o) { return true; } static mk(a) { return a + 1; } }`;

/** `body` runs with `K` bound to `C` through an `any`-typed parameter. */
const dynamic = (body: string) => `export function run() { ${CLASSIFY} ${CLASS}
  function f(K) { try { ${body} } catch (e) { return -9; } }
  return f(C); }`;

describe("#6457 — `prototype` on a dynamic class receiver, standalone", () => {
  it("answers the prototype OBJECT, not `undefined`", async () => {
    // The whole bug. On the base tree this answers 1 (`undefined`).
    expect(await runStandalone(dynamic(`return __c(K.prototype);`))).toBe(3);
  });

  it("answers the same object the STATIC read answers", async () => {
    // Identity, not merely objecthood: a second prototype singleton would be a
    // silently wrong answer that the classify probe above cannot see.
    expect(
      await runStandalone(`export function run() { ${CLASS}
        function f(K) { return K.prototype === C.prototype ? 1 : 0; }
        return f(C); }`),
    ).toBe(1);
  });

  it("lets `Object.getOwnPropertyDescriptor(K.prototype, …)` answer", async () => {
    // The shape of every `prototype/*/{branding,prop-desc}.js` row. On the base
    // tree this THROWS `Cannot convert undefined or null to object` (-9).
    expect(await runStandalone(dynamic(`return __c(Object.getOwnPropertyDescriptor(K.prototype, "day"));`))).toBe(3);
    expect(await runStandalone(dynamic(`return __c(Object.getOwnPropertyDescriptor(K.prototype, "equals"));`))).toBe(3);
  });

  it('answers through a computed key too (`K[k]`, k = "prototype")', async () => {
    expect(await runStandalone(dynamic(`const k = "proto" + "type"; return __c(K[k]);`))).toBe(3);
  });

  it("keeps an INSTANCE receiver at `undefined`", async () => {
    // A class object and its instances are the SAME wasm struct type, so the
    // identity compare against the class-object singleton is the only thing
    // separating them. If it is ever dropped, this is what catches it.
    expect(await runStandalone(dynamic(`const d = new K(1); return __c(d.prototype);`))).toBe(1);
    expect(await runStandalone(dynamic(`const d = new K(1); const k = "proto" + "type"; return __c(d[k]);`))).toBe(1);
  });

  it("leaves a non-class dynamic receiver alone", async () => {
    expect(await runStandalone(dynamic(`const o = { a: 1 }; return __c(o.prototype);`))).toBe(1);
  });

  it("does NOT yet fix `instanceof` with a dynamic RHS (pinned residual)", async () => {
    // Delete this expectation — do not flip it quietly — when the
    // `__closure_proto_of` class arm learns to build a lazy prototype.
    expect(await runStandalone(dynamic(`return (new K(1)) instanceof K ? 1 : 0;`))).toBe(0);
  });
});
