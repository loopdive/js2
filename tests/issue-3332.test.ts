// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3332 — DIRECT linear path (`--target linear`, no JS2WASM_LINEAR_IR) mis-lowered
// `Array.prototype.push`:
//   (a) in expression position it returned f64.const 0 instead of the new length;
//   (b) multi-arg push dropped every argument past the first.
// Both are fixed in src/codegen-linear/index.ts compileArrayMethodCall: the
// receiver is evaluated once into a local, every argument is appended, and the
// new length is read back via __arr_len for the expression-position result.

// Force the direct path (overlay OFF) so this guards the direct lowering
// regardless of the selector default.
const FLAG = "JS2WASM_LINEAR_IR";

async function runLinearDirect(src: string): Promise<number> {
  const prev = process.env[FLAG];
  process.env[FLAG] = "0";
  try {
    const r = await compile(src, { target: "linear" });
    expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { test: () => number }).test();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// [label, source, expected]
const cases: [string, string, number][] = [
  [
    "single-arg push returns new length (expression position)",
    `export function test(): number { const a = [1]; return a.push(8); }`,
    2,
  ],
  [
    "multi-arg push appends all arguments",
    `export function test(): number { const a = [1]; a.push(2, 3); return a.length; }`,
    3,
  ],
  ["multi-arg push returns new length", `export function test(): number { const a = [1]; return a.push(2, 3, 4); }`, 4],
  [
    "multi-arg push appends the actual values in order",
    `export function test(): number { const a = [1]; a.push(2, 3); return a[0] + a[1] + a[2]; }`,
    6,
  ],
  [
    "push onto an initially-empty array",
    `export function test(): number { const a: number[] = []; a.push(5); a.push(6, 7); return a.length; }`,
    3,
  ],
  [
    "statement-position push still appends (result dropped)",
    `export function test(): number { const a = [1]; a.push(9); return a[1]; }`,
    9,
  ],
];

describe("#3332 direct linear-path Array.prototype.push (return value + multi-arg)", () => {
  for (const [label, src, expected] of cases) {
    it(label, async () => {
      expect(await runLinearDirect(src)).toBe(expected);
    });
  }
});
