import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

/**
 * #1994 — reduce/reduceRight on string[] trapped "illegal cast" because the
 * accumulator local was hard-coded to the numeric kind (i32/f64). String
 * (and any externref) accumulators were forced through a numeric unbox that
 * trapped or produced NaN. The accumulator local now derives its ValType from
 * the callback's resolved return type, so non-numeric accumulators use an
 * externref local. Numeric reduce/reduceRight are unchanged.
 */
describe("#1994 reduce/reduceRight string accumulator", () => {
  it("reduce on string[] without initial value", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = ["a", "b", "c"];
        return a.reduce((x: string, y: string) => x + y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reduce on string[] with initial value", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = ["a", "b", "c"];
        return a.reduce((x: string, y: string) => x + y, "z");
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reduceRight on string[] without initial value", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = ["a", "b", "c"];
        return a.reduceRight((x: string, y: string) => x + y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reduceRight on string[] with initial value", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = ["a", "b", "c"];
        return a.reduceRight((x: string, y: string) => x + y, "z");
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reduce on string[] with 5+ entries (separator)", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = ["x", "y", "z", "p", "q"];
        return a.reduce((acc: string, cur: string) => acc + "-" + cur);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("string[] reduces to a numeric accumulator (sum of lengths)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = ["ab", "cde", "f"];
        return a.reduce((acc: number, s: string) => acc + s.length, 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("reduce on string[] using the index parameter", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = ["a", "b"];
        return a.reduce((acc: string, v: string, i: number) => acc + v + i, "");
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric reduce is unchanged (no initial value)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [1, 2, 3, 4];
        return a.reduce((x: number, y: number) => x + y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric reduce is unchanged (with initial value)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [1, 2, 3, 4];
        return a.reduce((x: number, y: number) => x + y, 100);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric reduceRight is unchanged", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [10, 20, 30];
        return a.reduceRight((x: number, y: number) => x - y);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
