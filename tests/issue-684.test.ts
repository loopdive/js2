// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #684 — Usage-based type inference for `any`-typed local variables.
//
// When TypeScript infers `any` (pervasive in untyped JS), a local is lowered to
// a boxed carrier (externref / $AnyValue) and every arithmetic read pays a
// `__box_number`/`__unbox_number` round-trip. `src/checker/usage-inference.ts`
// narrows such a local to an unboxed `f64` slot when — and only when — every use
// is ToNumber-invariant (strictly-numeric operators), which `__unbox_number ===
// Number()` makes observationally sound.
//
// These tests pin BOTH:
//   1. Representation — the narrowed case emits an `f64` local with no box/unbox.
//   2. Semantics — narrowed results, and (critically) that non-ToNumber-invariant
//      uses (`+` string-concat, truthiness, escape, closure capture, bigint) BAIL
//      and keep their exact JS-observable behaviour.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileOk(src: string, opts: Record<string, unknown> = {}) {
  const r = await compile(src, opts);
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return r;
}

/** Compile `export function f(): <ret> { <body> }`, instantiate, call f(). */
async function runF(body: string, ret = "number", opts: Record<string, unknown> = {}): Promise<unknown> {
  const src = `export function f(): ${ret} { ${body} }`;
  const r = await compileOk(src, opts);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if ((imports as { setExports?: (e: unknown) => void }).setExports) {
    (imports as { setExports: (e: unknown) => void }).setExports(exports);
  }
  return exports.f();
}

async function watOf(body: string, ret = "number", opts: Record<string, unknown> = {}): Promise<string> {
  const src = `export function f(): ${ret} { ${body} }`;
  const r = await compileOk(src, opts);
  return r.wat ?? "";
}

/** The `$f` function body region of the WAT (up to the next top-level func). */
function fBody(wat: string): string {
  const start = wat.indexOf("(func $f ");
  if (start < 0) return "";
  const rest = wat.slice(start + 1);
  const next = rest.indexOf("\n  (func ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("#684 usage-based any-local inference — representation", () => {
  it("narrows a purely-arithmetic any local to an f64 slot with no box/unbox", async () => {
    // The canonical Implementation-Plan example: x is `any`, used only in `x * 2`.
    const wat = fBody(await watOf("let x: any = 5; return x * 2 + 1;"));
    expect(wat).toMatch(/\(local \$x f64\)/);
    expect(wat).not.toMatch(/call \d+ *;;.*box/);
  });

  it("narrows an uninitialized hoisted `var` (NaN-seeded at entry)", async () => {
    // `var x;` reads as undefined before assignment (`ToNumber(undefined) === NaN`);
    // the narrowed slot is NaN-seeded at entry, not left at the wasm default 0.
    const wat = fBody(await watOf("var x; x = 5; return x * 2 + 1;"));
    expect(wat).toMatch(/\(local \$x f64\)/);
    expect(wat).toMatch(/f64\.const nan/i);
  });

  it("narrows a hoisted `var` any local", async () => {
    const wat = fBody(await watOf("var y; y = 3; return y * 4;"));
    expect(wat).toMatch(/\(local \$y f64\)/);
    expect(wat).not.toMatch(/__unbox_number/);
  });

  it("keeps a `const` seeded from an unknown source boxed until conversion", async () => {
    const src = `declare function h(): any;
      export function f(): number { const z = h(); return z * 0 + 2; }`;
    const r = await compileOk(src);
    // h() can return an object with observable/throwing valueOf. Numeric uses
    // do not justify invoking that conversion when assigning z.
    expect(fBody(r.wat ?? "")).toMatch(/\(local \$z externref\)/);
  });

  it("does NOT narrow when the flag is off (legacy boxed carrier retained)", async () => {
    const wat = fBody(await watOf("let x: any = 5; return x * 2 + 1;", "number", { useUsageInfer: false }));
    expect(wat).not.toMatch(/\(local \$x f64\)/);
    // Legacy path keeps the boxed carrier (externref in host mode).
    expect(wat).toMatch(/\(local \$x externref\)/);
  });

  it("leaves a string-concat any local boxed (no f64 slot)", async () => {
    const wat = fBody(await watOf(`let s: any = "a"; return (s + "b").length;`));
    expect(wat).not.toMatch(/\(local \$s f64\)/);
  });
});

describe("#684 usage-based any-local inference — semantics (narrowed cases)", () => {
  const cases: Array<[string, string, number]> = [
    ["multiply", "let x: any = 5; return x * 2 + 1;", 11],
    ["var-no-init-assigned", "var x; x = 5; return x * 2 + 1;", 11],
    ["subtract", `let x: any = "8"; return x - 3;`, 5], // "8" - 3 = 5 (ToNumber sound)
    ["divide", "let x: any = 15; return x / 4;", 3.75],
    ["modulo", "let x: any = 17; return x % 5;", 2],
    ["exponent", "let x: any = 3; return x ** 2 * 1;", 9],
    ["bitwise-or ToInt32", "let x: any = 6.9; return x | 0;", 6],
    ["bitwise-and", "let x: any = 6; return x & 3;", 2],
    ["shift-left", "let x: any = 1; return x << 4;", 16],
    ["unary-minus", "let x: any = 4; return -x * 1;", -4],
    ["prefix-increment", "let x: any = 4; ++x; return x * 1;", 5],
    ["postfix-decrement", "let x: any = 4; x--; return x * 1;", 3],
    ["compound-mul", "let x: any = 3; x *= 4; return x * 1;", 12],
    ["string-ToNumber", `let x: any = "8"; return x * 2;`, 16],
    ["undefined-is-NaN-safe", "let x; return x * 2;", NaN],
  ];
  for (const [name, body, expected] of cases) {
    it(name, async () => {
      const got = await runF(body);
      if (Number.isNaN(expected)) expect(Number.isNaN(got as number)).toBe(true);
      else expect(got).toBe(expected);
    });
  }
});

describe("#684 usage-based any-local inference — soundness bails", () => {
  it("`+` with a numeric literal stays STRING concatenation for a string value", async () => {
    // JS: "5" + 3 === "53". Narrowing to f64 would wrongly yield 8.
    const got = await runF(`let x: any = "5"; return x + 3;`, "any");
    expect(got).toBe("53");
  });

  it("truthiness distinguishes 0 from '0' (must not narrow to f64)", async () => {
    // JS: "0" is truthy, 0 is falsy.
    const got = await runF(`let x: any = "0"; let acc = 0; while (false) { acc = x * 1; } if (x) return 1; return 0;`);
    expect(got).toBe(1);
  });

  it("escape via a call argument keeps the original value", async () => {
    const got = await runF(`function sink(a: any) {} let x: any = "9"; sink(x); return x;`, "any");
    expect(got).toBe("9");
  });

  it("closure capture bails (still correct, boxed)", async () => {
    const got = await runF(`let x: any = 3; const g = () => x * 2; return g();`);
    expect(got).toBe(6);
  });

  it("bigint arithmetic is not narrowed to f64 (would trap / mis-compute)", async () => {
    // A bigint operand (`x * 2n`) makes the op bigint arithmetic, which an f64
    // slot cannot represent — the local must stay boxed.
    const wat = fBody(await watOf(`let x: any = 5n; return x * 2n;`, "any"));
    expect(wat).not.toMatch(/\(local \$x f64\)/);
  });

  it("return of the raw any value bails (escape)", async () => {
    const got = await runF(`let x: any = "7"; return x;`, "any");
    expect(got).toBe("7");
  });

  it("relational-only use (no arithmetic evidence) is left boxed but correct", async () => {
    const got = await runF(`let x: any = 5; return x < 10;`, "boolean");
    expect(got).toBe(1); // wasm boolean marshalling
  });
});

describe("#684 inference == boxed baseline across a battery (differential)", () => {
  // Every result MUST equal the legacy boxed representation — enabling the
  // optimization can never change observable behaviour.
  const bodies = [
    `let x; x = 5; return x * 2 + 1;`,
    `let x: any = "8"; return x - 3;`,
    `let x: any = 6.9; return x | 0;`,
    `let x: any = "5"; return x + 3;`,
    `let x: any = "0"; if (x) return 1; return 0;`,
    `let x: any = 3; x *= 4; return x;`,
    `let x: any = 10; let y: any = 3; return x % y;`, // y is any → x%y still numeric (% ToNumbers)
    `let n; n = 7; let r = 1; while (n > 1) { r = r * n; n = n - 1; } return r * 1;`, // factorial 5040
  ];
  for (const [i, body] of bodies.entries()) {
    it(`case ${i}`, async () => {
      const retTypes = ["number", "any"];
      // Pick a permissive return type; `any` marshals both string and number.
      const ret = body.includes(`+ 3`) || body.includes(`return x;`) ? "any" : "number";
      void retTypes;
      const on = await runF(body, ret);
      const off = await runF(body, ret, { useUsageInfer: false });
      if (typeof on === "number" && Number.isNaN(on)) expect(Number.isNaN(off as number)).toBe(true);
      else expect(on).toStrictEqual(off);
    });
  }
});
