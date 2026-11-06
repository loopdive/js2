// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6976 — in a JS file the checker types `var e = 0` as `number` from its
// initializer and keeps that type after `e = obj`, while the slot typer widens
// `e`'s local to externref. Two folds trusted the checker over the slot:
// `e.f` was folded to `undefined` (#4483's absent-primitive-property arm) and
// `typeof e` to "number" (Octane box2d `b2Island.Solve`'s `e.m_force.x` threw).
// The allocated slot is now the authority; a numeric slot keeps both folds.
//
// Each probe returns a bit mask (bit i = row i matched node), so one number
// reports every row. `typeof x + ""` spells the plain `typeof` expression;
// `typeof x === "…"` spells the separate comparison lowering.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string): Promise<Uint8Array> {
  const r = await compile(src, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    runtimeEvalProvider: false,
  } as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.binary;
}

async function runStandalone(src: string): Promise<unknown> {
  const mod = new WebAssembly.Module(await compileStandalone(src));
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = new WebAssembly.Instance(mod, {});
  return (exports as { main: () => unknown }).main();
}

const PRELUDE = `function mask(a) { var m = 0; for (var i = 0; i < a.length; i++) if (a[i]) m += 1 << i; return m; }
  function B() { this.f = { x: 1 }; }
  var arr = [new B()];
  function get() { return arr; }`;

describe("#6976 a primitive fold defers to a widened slot (standalone)", () => {
  it("widened local (the box2d shape): property read and typeof see the object", async () => {
    const src = `${PRELUDE}
      export function main() {
        var e = 0;
        e = get()[0];
        return mask([typeof e + "" === "object", typeof e.f + "" === "object", typeof e["f"] + "" === "object",
          typeof e === "object", e.f.x === 1]);
      }`;
    expect(await runStandalone(src)).toBe(31);
  });

  it("widened boolean local and widened module global", async () => {
    const src = `${PRELUDE}
      var g = 0;
      g = arr[0];
      export function main() {
        var b = false;
        b = arr[0];
        return mask([typeof g + "" === "object", typeof g.f + "" === "object", typeof b + "" === "object",
          typeof b.f + "" === "object", typeof b !== "boolean"]);
      }`;
    expect(await runStandalone(src)).toBe(31);
  });

  it("widened var read from a closure that captures it", async () => {
    const src = `${PRELUDE}
      export function main() {
        var e = 0;
        var read = function () { return mask([typeof e + "" === "object", typeof e.f + "" === "object"]); };
        e = arr[0];
        return read();
      }`;
    expect(await runStandalone(src)).toBe(3);
  });

  it("parameter with a numeric default that is later assigned an object", async () => {
    const src = `${PRELUDE}
      function k(e = 0) {
        e = get()[0];
        return mask([typeof e + "" === "object", typeof e.f + "" === "object", typeof e === "object"]);
      }
      export function main() { return k(); }`;
    expect(await runStandalone(src)).toBe(7);
  });

  it("control: an unwidened numeric var keeps the fold", async () => {
    const numeric = `${PRELUDE}
      export function main() {
        var n = 0, t = true;
        for (var i = 0; i < 3; i++) n += i;
        return mask([typeof n + "" === "number", typeof n.f + "" === "undefined", typeof t + "" === "boolean",
          typeof t.f + "" === "undefined", typeof n === "number", n === 3]);
      }`;
    expect(await runStandalone(numeric)).toBe(63);
    // Spelling each folded operand as a literal must not change the binary; a
    // runtime `typeof` read of `n` / `t` would.
    const literal = numeric
      .replace('typeof n + "" === "number"', 'typeof 0 + "" === "number"')
      .replace('typeof t + "" === "boolean"', 'typeof true + "" === "boolean"')
      .replace('typeof n === "number"', 'typeof 0 === "number"');
    expect(literal).not.toBe(numeric);
    expect(Buffer.from(await compileStandalone(literal)).equals(Buffer.from(await compileStandalone(numeric)))).toBe(
      true,
    );
  });
});
