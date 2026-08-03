// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4123 — a prototype method invoked on a PARAMETER receiver silently returned
// `null`/`0` in `target: "standalone"`.
//
// Mechanism: the #2660 fnctor escape gate classifies each `new F()` site as
// `reconstruct` (lower to a `$Object` with a `$proto` link) or `keep-*` (lower
// to the bespoke `$__fnctor_F` struct, which has own fields but NO prototype
// chain). Its INLINE arm — the one used when the `new F()` is not bound to a
// variable — re-implemented a strict SUBSET of `classifyUse`'s ladder and
// dropped the call-ARGUMENT rule. So `f(new K())` was `keep-static` while the
// otherwise identical `var o = new K(); f(o)` was `dynamic` ⇒ `reconstruct`.
// The callee's dynamic `o.k()` then walked a prototype chain that did not
// exist, resolved `k` to `undefined`, and produced `null` — with no trap and no
// compile error. Every consumer downstream coerced that: `null` bare, `0` into
// a numeric local, `1` through `1 + o.k()`.
//
// The bare `return o.k();` row is the load-bearing one: it is the only shape
// where no numeric coercion hides the wrong value behind a plausible-looking
// number.
//
// These run STANDALONE on purpose. `assertEquivalent` compiles the JS-host
// lane, which cannot express `K.prototype.k = fn` dispatch at all yet — even
// with a locally-bound receiver — so it would fail here for an unrelated,
// pre-existing reason. The comparison against native JS is kept: each case is
// evaluated with `evaluateAsJs` and the two answers must agree.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs } from "./helpers.js";

/** Compile `source` standalone, run `main`, and assert it equals native JS. */
async function assertStandaloneEquivalent(source: string): Promise<void> {
  const result = await compile(source, {
    fileName: "issue-4123.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  const jsExports = evaluateAsJs(source);
  expect(exports.main!()).toBe(jsExports.main!());
}

const K = `function K() {} K.prototype.k = function () { return 3; };\n`;

describe("#4123 prototype method on a parameter receiver (standalone)", () => {
  it("returns the method result directly — `return o.k();`", async () => {
    await assertStandaloneEquivalent(
      K + `function f(o) { return o.k(); }\nexport function main() { return f(new K()); }`,
    );
  }, 120_000);

  it("binds the method result to a fresh local", async () => {
    await assertStandaloneEquivalent(
      K + `function f(o) { var n = o.k(); return n; }\nexport function main() { return f(new K()); }`,
    );
  }, 120_000);

  it("assigns the method result over an existing numeric local", async () => {
    await assertStandaloneEquivalent(
      K + `function f(o) { var n = 1; n = o.k(); return n; }\nexport function main() { return f(new K()); }`,
    );
  }, 120_000);

  it("accumulates the method result into a numeric local", async () => {
    await assertStandaloneEquivalent(
      K + `function f(o) { var n = 1; n = n + o.k(); return n; }\nexport function main() { return f(new K()); }`,
    );
  }, 120_000);

  it("uses the method result as an operand — `return 1 + o.k();`", async () => {
    await assertStandaloneEquivalent(
      K + `function f(o) { return 1 + o.k(); }\nexport function main() { return f(new K()); }`,
    );
  }, 120_000);

  it("control: the same call with a locally-`new`-bound receiver", async () => {
    // Never broken — this is what proved the defect was specific to the
    // receiver arriving as a parameter rather than to the method, the
    // prototype, or the export boundary.
    await assertStandaloneEquivalent(
      K +
        `function f() { var p = new K(); var n = 1; n = n + p.k(); return n; }\nexport function main() { return f(); }`,
    );
  }, 120_000);

  it("reads an inherited DATA property through a parameter receiver", async () => {
    // Same gate verdict, no call involved: `keep-static` also lost plain
    // prototype-chain reads (`o.k` was `undefined` where JS says 7).
    await assertStandaloneEquivalent(
      `function K2() {} K2.prototype.k = 7;\n` +
        `function f(o) { return o.k; }\nexport function main() { return f(new K2()); }`,
    );
  }, 120_000);

  it("passes the inline instance in a non-first argument position", async () => {
    await assertStandaloneEquivalent(
      K + `function f(a, o) { return a + o.k(); }\nexport function main() { return f(10, new K()); }`,
    );
  }, 120_000);

  it("still reaches the method through a second call hop", async () => {
    await assertStandaloneEquivalent(
      K +
        `function g(o) { return o.k(); }\nfunction f(o) { return g(o); }\n` +
        `export function main() { return f(new K()); }`,
    );
  }, 120_000);

  it("negative control: a typed own-field consumer keeps the fnctor struct", async () => {
    // Clause (B) of the gate is absolute — a site with a typed own-field read
    // must stay `keep-typed` so the read remains a `struct.get`. This pins that
    // the #4123 widening did not move such a site onto the reconstructed path.
    await assertStandaloneEquivalent(
      `function P() { this.x = 5; }\nfunction f(o) { return o.x; }\n` +
        `export function main() { var p = new P(); return p.x + f(p); }`,
    );
  }, 120_000);
});
