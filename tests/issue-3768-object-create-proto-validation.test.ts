// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3768 — ES5 Object.create prototype-argument validation in standalone mode.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as { test(): number }).test();
}

describe("#3768 Object.create prototype validation", () => {
  it("throws TypeError for a numeric prototype after evaluating it", async () => {
    expect(
      await run(`export function test(): number {
        let evaluated = 0;
        try {
          Object.create((evaluated++, 1));
          return 10;
        } catch (error) {
          if (!(error instanceof TypeError)) return 11;
          return evaluated === 1 ? 1 : 12;
        }
      }`),
    ).toBe(1);
  });

  it("rejects other statically known primitive prototypes", async () => {
    expect(
      await run(`export function test(): number {
        const values: any[] = [true, "proto", undefined];
        for (let i = 0; i < values.length; i++) {
          try {
            if (i === 0) Object.create(true);
            else if (i === 1) Object.create("proto");
            else Object.create(undefined);
            return 20 + i;
          } catch (error) {
            if (!(error instanceof TypeError)) return 30 + i;
          }
        }
        return 1;
      }`),
    ).toBe(1);
  });

  it("continues to accept null as a prototype", async () => {
    expect(
      await run(`export function test(): number {
        const value: any = Object.create(null);
        return Object.getPrototypeOf(value) === null ? 1 : 40;
      }`),
    ).toBe(1);
  });
});
