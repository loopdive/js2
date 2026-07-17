// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3332 — DIRECT linear path (`--target linear`, no JS2WASM_LINEAR_IR)
// mis-lowered Array.prototype.push two ways:
//   (a) expression-position push yielded `f64.const 0`, not the new length;
//   (b) multi-arg push (`a.push(x, y, …)`) dropped every argument after the
//       first.
// Per spec §23.1.3.23 push appends ALL arguments and returns the new length.
// Fix: `src/codegen-linear/index.ts` compileArrayMethodCall — loop over every
// argument and read `__arr_len` for the expression value.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runLinear(src: string, fn: string): Promise<number> {
  const r = await compile(src, { target: "linear", fileName: "t.ts" } as Parameters<typeof compile>[1]);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary!), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as Record<string, () => number>)[fn]!();
}

describe("#3332 direct linear-path Array.prototype.push", () => {
  it("single-arg push returns the new length in expression position", async () => {
    expect(await runLinear(`export function pushRet(): number { const a = [1]; return a.push(8); }`, "pushRet")).toBe(
      2,
    );
  });

  it("multi-arg push appends every argument (length reflects all)", async () => {
    expect(
      await runLinear(
        `export function multiPush(): number { const a = [1]; a.push(2, 3); return a.length; }`,
        "multiPush",
      ),
    ).toBe(3);
  });

  it("multi-arg push returns the new length", async () => {
    expect(
      await runLinear(`export function multiRet(): number { const a = [1]; return a.push(2, 3, 4); }`, "multiRet"),
    ).toBe(4);
  });

  it("no-arg push returns the unchanged length", async () => {
    expect(
      await runLinear(`export function emptyPush(): number { const a = [1, 2]; return a.push(); }`, "emptyPush"),
    ).toBe(2);
  });

  it("all pushed values land in order", async () => {
    expect(
      await runLinear(
        `export function values(): number { const a: number[] = []; a.push(5, 6, 7); return a[0] * 100 + a[1] * 10 + a[2]; }`,
        "values",
      ),
    ).toBe(567);
  });

  it("multi-arg push of reference (string) elements returns the new length", async () => {
    expect(
      await runLinear(
        `export function strPush(): number { const a: string[] = ["x"]; return a.push("y", "z"); }`,
        "strPush",
      ),
    ).toBe(3);
  });
});
