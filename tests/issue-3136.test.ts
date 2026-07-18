// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.ts";

// #3136 — object read back through a boxed-capture cell must keep `===` identity
// with the outer variable in `--target standalone`.
//
// When an `any`-typed `var` is promoted to a ref-cell capture and a closure
// reads it back, `closureRead() === outerRead` previously answered FALSE for the
// SAME object on the standalone lane (the cell-read result and the outer local
// went through different boxing/conversions, landing in the tag-5 host-only
// strict-eq arm — same family as reference_2583_any_strict_eq_tag5_host_only).
// This guards the fixed behavior on BOTH lanes.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function runHost(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

// [label, source]  — every case returns 1 on success.
const cases: [string, string][] = [
  [
    "minimal repro: write-after-capture cell read keeps identity",
    `export function test(): number {
      var p2: any;
      var f = function () { return p2; };
      p2 = { a: 1 };
      if (f() !== p2) return 8;
      return 1;
    }`,
  ],
  [
    "arrow closure variant",
    `export function test(): number {
      var p2: any;
      var f = () => p2;
      p2 = { a: 2 };
      if (f() !== p2) return 8;
      return 1;
    }`,
  ],
  [
    "control: value still flows through the cell",
    `export function test(): number {
      var p2: any;
      var f = function () { return p2; };
      p2 = { a: 1 };
      return f().a === 1 ? 1 : 8;
    }`,
  ],
  [
    "control: no write after capture keeps identity",
    `export function test(): number {
      var p2: any = { a: 1 };
      var f = () => p2;
      return f() === p2 ? 1 : 8;
    }`,
  ],
  [
    "control: direct aliasing keeps identity",
    `export function test(): number {
      var p2: any;
      p2 = { a: 1 };
      var q: any = p2;
      return q === p2 ? 1 : 8;
    }`,
  ],
  [
    "mutate through cell then identity + value both hold",
    `export function test(): number {
      var p2: any;
      var f = () => p2;
      p2 = { a: 1 };
      p2.a = 5;
      if (f() !== p2) return 8;
      return f().a === 5 ? 1 : 8;
    }`,
  ],
];

describe("#3136 boxed-capture cell-read object identity", () => {
  describe("standalone (no JS host)", () => {
    for (const [label, src] of cases) {
      it(label, async () => {
        expect(await runStandalone(src)).toBe(1);
      });
    }
  });

  describe("js-host parity", () => {
    for (const [label, src] of cases) {
      it(label, async () => {
        expect(await runHost(src)).toBe(1);
      });
    }
  });
});
