// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4121, first slice) The unboxing-candidate gate keys on the REPRESENTATION
 * codegen is about to emit, not on the checker's declared type.
 *
 * `let i = 0` is declared `number` by TypeScript while a later
 * `i = s.foo()` (unresolvable receiver) widens the slot to `externref`. The
 * declared type and the emitted representation then disagree — and the pass
 * whose entire job is to reconcile them (`usageInferredLocalType`, the single
 * codegen entry point for #684's use-site proof and #3765's definition-site
 * proof) never saw the binding, because its admission gate asked the checker.
 *
 * This slice admits such a binding. It adds NO proof logic: both routes run
 * unchanged and still have to earn the f64 slot, so every "must still decline"
 * case in the issue stays boxed. Kill switch `JS2WASM_NUMERIC_ADMISSION=0`.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function build(source: string, env?: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await compile(source, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The `(func $fn …)` body, paren-balanced. */
function bodyOf(wat: string, fn: string): string {
  const start = wat.indexOf(`(func $${fn}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    if (wat[i] === "(") depth++;
    else if (wat[i] === ")" && --depth === 0) return wat.slice(start, i + 1);
  }
  return wat.slice(start);
}

function localType(body: string, name: string): string {
  return body.match(new RegExp(`\\(local \\$${name} ([^)]*)\\)`))?.[1] ?? "";
}

async function run(source: string, env?: Record<string, string>): Promise<unknown> {
  const { binary } = await build(source, env);
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
  return (exports as { main: () => unknown }).main();
}

/**
 * The shape the slice exists for. `acc` is DECLARED `number` (initializer `0`),
 * so the old gate never collected it. `s.next()` is genuinely cross-domain —
 * string from one receiver, number from the other — so the mixed-assignment
 * carrier widens the slot to `externref` and the #3765 definition-site fixpoint
 * cannot ground it either. Every USE of `acc` is ToNumber-invariant, so route 1
 * (#684) proves the f64 slot — once admission lets it look.
 */
const WIDENED_ACCUMULATOR = `
function A(){} A.prototype.next = function(){ return "7"; };
function B(){} B.prototype.next = function(){ return 3; };
function f(s){
  let acc = 0;
  let i = 0;
  while (i < 10) { acc = s.next(); acc = acc * 3; i = i + 1; }
  return acc - 1;
}
export function main(){ return f(new A()) * 1000 + f(new B()); }
`;

describe("#4121 — admission keys on the emitted representation, not the declared type", () => {
  it("unboxes a declared-`number` binding whose slot codegen widens", async () => {
    const { wat } = await build(WIDENED_ACCUMULATOR);
    expect(localType(bodyOf(wat!, "f"), "acc")).toBe("f64");
  });

  it("is off under the kill switch, restoring the boxed carrier exactly", async () => {
    const { wat } = await build(WIDENED_ACCUMULATOR, { JS2WASM_NUMERIC_ADMISSION: "0" });
    expect(localType(bodyOf(wat!, "f"), "acc")).toBe("externref");
  });

  it("computes what JS computes, either way", async () => {
    // node: f(new A()) === Number("7") * 3 - 1 === 20; f(new B()) === 8.
    expect(await run(WIDENED_ACCUMULATOR)).toBe(20008);
    expect(await run(WIDENED_ACCUMULATOR, { JS2WASM_NUMERIC_ADMISSION: "0" })).toBe(20008);
  });

  // The f64 slot stores `Number(source)` on every write. Route 1's soundness
  // argument is that no use can observe the pre-coercion value, so every value
  // assigned into the newly-unboxed slot must read back exactly what the boxed
  // carrier read back. This is the A/B against the kill-switch control; the
  // expected values are the JavaScript results, including NaN for undefined.
  it.each([
    ['"12"', 35],
    ['"zz"', Number.NaN],
    ["null", -1],
    ["undefined", Number.NaN],
  ])("reads back identically across the kill switch when %s is assigned", async (value, expected) => {
    const source = `
      function mk(){ return { foo: function(){ return ${value}; } }; }
      function f(s){ let acc = 0; acc = s.foo(); return acc * 3 - 1; }
      export function main(){ return f(mk()); }
    `;
    expect(await run(source)).toBe(expected);
    expect(await run(source, { JS2WASM_NUMERIC_ADMISSION: "0" })).toBe(expected);
  });

  // --- "What must still decline" (#4121). Admission is not proof. -----------

  it.each([
    [
      "booleans — an f64 boolean carrier prints 1 where JS prints true",
      `function f(o){ let b = 0; b = o.flag(); return \`\${b}\`; }`,
      "b",
    ],
    [
      "capture — a captured binding lives in a ref cell, not a wasm local",
      `function f(s){ let i = 0; i = s.foo(); const g = () => i * 2; return g(); }`,
      "i",
    ],
    [
      "read before definition — an f64 slot reads 0/NaN where JS says undefined",
      `function f(s, c){ if (c) { return typeof v; } var v = 0; v = s.foo(); return v * 2; }`,
      "v",
    ],
    [
      "bigint — bigint arithmetic is not f64 arithmetic",
      `function f(s){ let i = 0n; i = s.foo(); return i * 2n; }`,
      "i",
    ],
    ["a use that observes the un-coerced value", `function f(s){ let x = 0; x = s.foo(); return x.length; }`, "x"],
  ])("still boxes: %s", async (_label, fn, name) => {
    const { wat } = await build(`${fn}\nexport function main(){ return 0; }`);
    expect(localType(bodyOf(wat!, "f"), name)).toBe("externref");
  });

  it("still boxes a genuinely cross-domain binding (#3961's hazard is untouched)", async () => {
    const { wat } = await build(`
      function f(){ let n = 1; n = "s"; return typeof n; }
      export function main(){ return 0; }
    `);
    expect(localType(bodyOf(wat!, "f"), "n")).toBe("externref");
  });

  it("leaves the greatest-vs-least fixpoint shape boxed (no numeric evidence anywhere)", async () => {
    const { wat } = await build(`
      function f(s){ var a = 0; var b = 0; a = b; b = a; a = s.foo(); return a * 2; }
      export function main(){ return 0; }
    `);
    expect(localType(bodyOf(wat!, "f"), "a")).toBe("externref");
  });
});
