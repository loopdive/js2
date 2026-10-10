// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// An untyped JS parameter whose call sites are all numeric gets an f64 local.
// When the function ALSO escapes as a value (stored in an array, aliased,
// passed around), its `a + b` used to stay on the generic any-add lane: both
// f64 operands were boxed (AnyValue structs / externrefs), ToPrimitive'd and
// dispatched on every call — 443 ns vs 1 ns per call in the npm-realworld
// micro-kernels. An operand that already lives in an f64/i32 local is a
// number, so `+` must lower to f64.add — while operands that really are
// dynamic keep string-concat semantics.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function disassemble(binary: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "numeric-any-add-"));
  try {
    const file = join(dir, "probe.wasm");
    writeFileSync(file, binary);
    const wasmDis = createRequire(import.meta.url).resolve("binaryen/bin/wasm-dis");
    return execFileSync(process.execPath, [wasmDis, file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function functionBody(text: string, name: string): string {
  const start = text.indexOf(`(func $${name} `);
  if (start < 0) return "";
  const next = text.indexOf("\n (func ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

/**
 * The code the hot loop actually runs: `name`'s own body plus the bodies of
 * the functions it calls directly. (The JS-level `add` may be inlined, called,
 * or emitted as a renamed IR copy, so asserting on `$add` alone is unreliable.)
 */
function hotPath(binary: Uint8Array, name: string): string {
  const text = disassemble(binary);
  const body = functionBody(text, name);
  expect(body, `function $${name} in the emitted binary`).not.toBe("");
  const callees = [...new Set([...body.matchAll(/\(call \$([\w.]+)/g)].map((m) => m[1]!))];
  return [body, ...callees.map((callee) => functionBody(text, callee))].join("\n");
}

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "probe.mjs",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
    optimize: 0,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(module, {});
  return {
    exports: exports as Record<string, (...args: number[]) => number>,
    hot: () => hotPath(result.binary, "direct"),
  };
}

const GENERIC_ADD = /__any_add|__box_number|__to_primitive|__any_to_string|__str_concat|struct\.new/;

describe("numeric locals skip the generic any-add lane", () => {
  it("lowers `a + b` to f64.add when the function also escapes as a value", async () => {
    const { exports, hot } = await compileStandalone(`
      function add(a, b) { return a + b; }
      var add_alias = add;
      /** @param {number} n @returns {number} */
      export function direct(n) { let s = 0; for (let i = 0; i < n; i++) s = add(s, i & 7); return s; }
      /** @param {number} n @returns {number} */
      export function escapes(n) { const fs = [add, (a, b) => a - b]; return fs.length + n; }
      /** @param {number} n @returns {number} */
      export function aliased(n) { return typeof add_alias === "function" ? n : -1; }
    `);
    expect(exports.direct(10)).toBe(29);
    expect(exports.escapes(1)).toBe(3);
    expect(exports.aliased(5)).toBe(5);
    const code = hot();
    expect(code).toMatch(/f64\.add/);
    expect(code).not.toMatch(GENERIC_ADD);
  });

  it("lowers `a + b` to f64.add for a function passed as a callback", async () => {
    const { exports, hot } = await compileStandalone(`
      function add(a, b) { return a + b; }
      function apply(f, x, y) { return f(x, y); }
      /** @param {number} n @returns {number} */
      export function direct(n) { let s = 0; for (let i = 0; i < n; i++) s = add(s, i & 7); return s; }
      /** @returns {number} */
      export function callback() { return apply(add, 3, 4); }
    `);
    expect(exports.direct(10)).toBe(29);
    expect(exports.callback()).toBe(7);
    const code = hot();
    expect(code).toMatch(/f64\.add/);
    expect(code).not.toMatch(GENERIC_ADD);
  });

  it("keeps concatenation when an operand is really dynamic", async () => {
    const { exports } = await compileStandalone(`
      function add(a, b) { return a + b; }
      /** @returns {number} */
      export function mixed() {
        const r = add("a", 1);
        const n = add(2, 3);
        return (typeof r === "string" && r === "a1" ? 1 : 0) + (n === 5 ? 10 : 0);
      }
      /** @param {number} x @returns {number} */
      export function oneNumericLocal(x) { const d = /** @type {any} */ ("7"); const r = x + d; return r === "17" ? 1 : 0; }
    `);
    expect(exports.mixed()).toBe(11);
    expect(exports.oneNumericLocal(1)).toBe(1);
  });
});
