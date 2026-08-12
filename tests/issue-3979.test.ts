// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3979 — callable values must survive heterogeneous container carriers.

import { describe, it } from "vitest";

import { assertEquivalent } from "./equivalence/helpers.js";

describe("#3979 callable values in heterogeneous containers", () => {
  it.fails("calls a function element in a mixed array literal", async () => {
    await assertEquivalent(
      `export function test(): number {
         const pair = [1, () => 7];
         return pair[1]();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it.fails("calls a function element in a nested value/callback tuple", async () => {
    await assertEquivalent(
      `export function test(): number {
         const pairs = [[1, () => 7]];
         return pairs[0][1]();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("calls closure properties after pushing heterogeneous records into an initially empty array", async () => {
    await assertEquivalent(
      `const tests: any[] = [];
       function register(name: string, body: (value: number) => number): void {
         tests.push({ name, body });
       }
       register("add", function (value) { return value + 1; });
       register("double", function (value) { return value * 2; });
       export function test(): number {
         let result = 0;
         for (let i = 0; i < tests.length; i++) result += tests[i].body(3);
         return result;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps homogeneous function arrays and object properties working", async () => {
    await assertEquivalent(
      `export function test(): number {
         const fns = [() => 5, () => 7];
         const object = { fn: () => 11 };
         return fns[0]() + fns[1]() + object.fn();
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
