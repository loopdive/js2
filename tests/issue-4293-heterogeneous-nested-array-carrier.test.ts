// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, it } from "vitest";

import { assertEquivalent } from "./equivalence/helpers.js";

describe("#4293 heterogeneous nested-array carrier", () => {
  it("preserves undefined after a numeric inner array", async () => {
    await assertEquivalent(
      `const rows = [[0], [undefined]];
       export function test(): number { return rows[1]![0] === undefined ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("preserves boolean tags after a numeric inner array", async () => {
    await assertEquivalent(
      `const rows = [[0], [true]];
       export function test(): number { return typeof rows[1]![0] === "boolean" ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("preserves strings after a numeric inner array", async () => {
    await assertEquivalent(
      `const rows = [[0], ["cat"]];
       export function test(): number { return rows[1]![0] === "cat" ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("preserves null after a numeric inner array", async () => {
    await assertEquivalent(
      `const rows = [[0], [null]];
       export function test(): number { return rows[1]![0] === null ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("preserves object identity and fields after a numeric inner array", async () => {
    await assertEquivalent(
      `const value = { answer: 42 };
       const rows = [[0], [value]];
       export function test(): number {
         return rows[1]![0] === value && (rows[1]![0] as typeof value).answer === 42 ? 1 : 0;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("selects a common carrier for separately bound inner arrays", async () => {
    await assertEquivalent(
      `const numbers = [0];
       const missing = [undefined];
       const rows = [numbers, missing];
       export function test(): number { return rows[1]![0] === undefined ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps homogeneous numeric matrices runnable", async () => {
    await assertEquivalent(
      `const rows = [[1], [2, 3]];
       export function test(): number { return rows[0]![0]! * 100 + rows[1]![0]! * 10 + rows[1]![1]!; }`,
      [{ fn: "test", args: [] }],
    );
  });
});
