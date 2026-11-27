// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2005 / #2006 — template literal substitution spans must stringify per spec.
//
// Before the fix, `compileTemplateExpression` (and its native-strings sibling
// `compileNativeTemplateExpression`) sent every i32 span through
// `f64.convert_i32_s` + `number_toString` with no `isBooleanType` check, so a
// boolean span printed "1"/"0" instead of "true"/"false" (#2005). `undefined`
// lowers to a type-default scalar (i32 0) and printed "0" instead of
// "undefined" (#2005, the #1931 family). An externref `null` span was assumed
// to already be a string and was passed straight into `wasm:js-string concat`,
// where the `ref.null extern` tripped an "illegal cast" trap (#2006).
//
// The fix mirrors the binary `+` concat path (`emitBoolToString` for booleans,
// literal "null"/"undefined" constants for the nullish spans), in both the
// JS-host and native/standalone backends.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#2005/#2006 template literal span stringification (JS-host)", () => {
  async function run(body: string): Promise<string> {
    const exports = (await compileToWasm(`export function test(): string { ${body} }`)) as { test(): string };
    return exports.test();
  }

  it("${true} stringifies to 'true' (#2005)", async () => {
    expect(await run("const b = true; return `b=${b}`;")).toBe("b=true");
  });

  it("${false} stringifies to 'false' (#2005)", async () => {
    expect(await run("const b = false; return `b=${b}`;")).toBe("b=false");
  });

  it("${undefined} stringifies to 'undefined' (#2005)", async () => {
    expect(await run("const u = undefined; return `u=${u}`;")).toBe("u=undefined");
  });

  it("${null} stringifies to 'null' instead of trapping illegal cast (#2006)", async () => {
    expect(await run("const o = null; return `x${o}`;")).toBe("xnull");
  });

  it("numeric spans are unchanged", async () => {
    expect(await run("const n = 42; return `n=${n}`;")).toBe("n=42");
  });

  it("string spans are unchanged", async () => {
    expect(await run("const s = 'hi'; return `s=${s}`;")).toBe("s=hi");
  });

  it("mixed boolean + numeric spans", async () => {
    expect(await run("const b = true; const n = 3; return `${b}-${n}`;")).toBe("true-3");
  });
});

describe("#2005/#2006 template literal span stringification (standalone/native strings)", () => {
  // Standalone mode emits a pure-Wasm module with no JS-host imports; read the
  // resulting native string back char-by-char via the length / charCodeAt
  // exports (the pattern used by the #1470 standalone string suite).
  async function buildAndRead(builderExpr: string): Promise<string> {
    const src = `
      export function len(): number { const s = ${builderExpr}; return s.length; }
      export function code(i: number): number { const s = ${builderExpr}; return s.charCodeAt(i); }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const exports = instance.exports as { len(): number; code(i: number): number };
    const n = exports.len();
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(exports.code(i));
    return out;
  }

  it("${true} / ${false} → 'true' / 'false' (#2005)", async () => {
    expect(await buildAndRead("`b=${(true as boolean)}`")).toBe("b=true");
    expect(await buildAndRead("`b=${(false as boolean)}`")).toBe("b=false");
  });

  it("${undefined} → 'undefined' (#2005)", async () => {
    expect(await buildAndRead("`u=${(undefined as undefined)}`")).toBe("u=undefined");
  });

  it("${null} → 'null' (#2006)", async () => {
    expect(await buildAndRead("`x${(null as null)}`")).toBe("xnull");
  });

  it("numeric / string spans unchanged", async () => {
    expect(await buildAndRead("`n=${(42 as number)}`")).toBe("n=42");
    expect(await buildAndRead("`s=${('hi' as string)}`")).toBe("s=hi");
  });
});
