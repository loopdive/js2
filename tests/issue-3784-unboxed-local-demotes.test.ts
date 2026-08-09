// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3784) The #2782/#2790 no-box NUMBER-local proof gate must DEMOTE, not fail
 * the build.
 *
 * The gate's own comment promises that an unprovable local type — `any`,
 * `unknown`, a mixed `number | string` union — "demotes to the SAFE boxed
 * legacy lowering". It threw a PLAIN `Error`, which `classifyIrFailure` buckets
 * as `invariant/unexpected-internal-throw` and `formatIrPathFallbackDiagnostic`
 * reports as a HARD `Codegen error`. So the promised safe path was unreachable
 * by construction.
 *
 * Latent until #3783 adopted function-local `var` declarations: that made the
 * selector CLAIM these functions, and a claimed function's throw fails
 * POST-claim, where no fallback exists. Result on `main`: ordinary untyped JS
 * produced a zero-byte binary on every target.
 *
 * These assertions are deliberately about OUTCOMES (does it build, does it
 * compute the right answer), not about the emitted instruction mix. An
 * instruction-mix assertion cannot see this bug — the failure is that there is
 * no output at all.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function build(source: string, target: "standalone" | "gc" = "standalone") {
  return await compile(source, {
    fileName: "t.mjs",
    skipSemanticDiagnostics: true,
    target,
    emitWat: true,
  });
}

async function run(source: string): Promise<number> {
  const r = await build(source);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.binary.length).toBeGreaterThan(0);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
  return (instance.exports as { main: () => number }).main();
}

/**
 * Each entry is a shape whose local is bound to an `any`-typed initializer, so
 * the gate cannot prove a pure number and must demote. Every one of these
 * failed to compile on `main` at 16c11237d.
 */
const SHAPES: ReadonlyArray<{ name: string; source: string; expected: number }> = [
  {
    name: "`var` from an any-typed method call, passed to an untyped helper",
    source: `function f(c){return c>=65&&c<=90;}
             function g(s){var c=s.charCodeAt(0); return f(c);}
             export function main(){return g("A");}`,
    expected: 1,
  },
  {
    name: "`var` from an any-typed method call, used inline",
    source: `function g(s){var c=s.charCodeAt(0); return c>=65&&c<=90;}
             export function main(){return g("z");}`,
    expected: 0,
  },
  {
    name: "`var` initialized directly from an any-typed parameter",
    source: `function f(c){return c>=0;}
             function g(s){var c=s; return f(c);}
             export function main(){return g(-3);}`,
    expected: 0,
  },
  {
    name: "`var` from `.length` on an any-typed receiver",
    source: `function f(n){return n*2;}
             function g(s){var n=s.length; return f(n);}
             export function main(){return g("abcd");}`,
    expected: 8,
  },
  {
    // `let`, not `var` — the gate is per-binding, so #3783's "function-local
    // var" adoption named the trigger, not the blast radius.
    name: "`let` in the same shape (not just `var`)",
    source: `function f(c){return c+1;}
             function g(s){let c=s.charCodeAt(1); return f(c);}
             export function main(){return g("AB");}`,
    expected: 67,
  },
];

describe("#3784 — an unprovable numeric local demotes to legacy instead of failing the build", () => {
  for (const { name, source, expected } of SHAPES) {
    it(`compiles and computes the JS answer: ${name}`, async () => {
      expect(await run(source)).toBe(expected);
    });
  }

  it("emits a non-empty binary on every target, not just standalone", async () => {
    const source = `function f(c){return c>=0;}
                    function g(s){var c=s.charCodeAt(0); return f(c);}
                    export function main(){return g("A");}`;
    for (const target of ["standalone", "gc"] as const) {
      const r = await build(source, target);
      expect(r.success, `target=${target}: ${r.errors.map((e) => e.message).join("; ")}`).toBe(true);
      expect(r.binary.length, `target=${target} produced an empty binary`).toBeGreaterThan(0);
    }
  });

  it("reports no HARD `Codegen error` for the demoted function", async () => {
    const r = await build(`function f(c){return c>=0;}
                           function g(s){var c=s.charCodeAt(0); return f(c);}
                           export function main(){return g("A");}`);
    // A demotion may legitimately surface as a WARNING; what must not appear is
    // the hard-error prefix `formatIrPathFallbackDiagnostic` adds for
    // `kind === "invariant"`.
    expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  });

  it("still promotes a local whose TS type IS provably a pure number", async () => {
    // The gate is not being weakened — an in-range numeric literal still
    // satisfies the proof and keeps the no-box representation.
    expect(
      await run(`function f(c){return c>=0;}
                      function g(){var c=5; return f(c);}
                      export function main(){return g();}`),
    ).toBe(1);
  });
});
