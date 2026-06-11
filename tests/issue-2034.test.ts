import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2034: Number.isNaN / isInteger / isFinite / isSafeInteger must NOT coerce
// their argument (ES §21.1.2.x). A non-Number value is `false` without ToNumber
// — `Number.isNaN("foo")` is `false`, not `true`. The *global* `isNaN` /
// `isFinite` DO coerce (`isNaN("foo") === true`) and must keep doing so.

async function evalBool(body: string): Promise<boolean> {
  const exports = await compileToWasm(body);
  return !!(exports as { test: () => unknown }).test();
}

describe("#2034 Number.is* predicates do not coerce", () => {
  it("Number.isNaN of a non-number is false", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isNaN("foo" as any); }`)).toBe(false);
    expect(await evalBool(`export function test(): boolean { const x: any = {}; return Number.isNaN(x); }`)).toBe(
      false,
    );
    expect(await evalBool(`export function test(): boolean { const x: any = true; return Number.isNaN(x); }`)).toBe(
      false,
    );
  });

  it("Number.isNaN of a real NaN is true (number arg unaffected)", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isNaN(NaN); }`)).toBe(true);
    expect(await evalBool(`export function test(): boolean { const x: any = NaN; return Number.isNaN(x); }`)).toBe(
      true,
    );
    expect(await evalBool(`export function test(): boolean { return Number.isNaN(1); }`)).toBe(false);
  });

  it("Number.isInteger of a non-number is false", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isInteger("5" as any); }`)).toBe(false);
    expect(
      await evalBool(`export function test(): boolean { const x: any = undefined; return Number.isInteger(x); }`),
    ).toBe(false);
  });

  it("Number.isInteger of a number is correct", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isInteger(5); }`)).toBe(true);
    expect(await evalBool(`export function test(): boolean { return Number.isInteger(5.5); }`)).toBe(false);
    expect(await evalBool(`export function test(): boolean { const x: any = 5; return Number.isInteger(x); }`)).toBe(
      true,
    );
  });

  it("Number.isFinite of a non-number is false", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isFinite("1" as any); }`)).toBe(false);
    expect(await evalBool(`export function test(): boolean { const x: any = null; return Number.isFinite(x); }`)).toBe(
      false,
    );
  });

  it("Number.isFinite of a number is correct", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isFinite(1); }`)).toBe(true);
    expect(await evalBool(`export function test(): boolean { return Number.isFinite(Infinity); }`)).toBe(false);
  });

  it("Number.isSafeInteger of a non-number is false", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isSafeInteger("5" as any); }`)).toBe(false);
  });

  it("Number.isSafeInteger of a number is correct", async () => {
    expect(await evalBool(`export function test(): boolean { return Number.isSafeInteger(5); }`)).toBe(true);
    expect(await evalBool(`export function test(): boolean { return Number.isSafeInteger(2 ** 53); }`)).toBe(false);
  });

  it("the GLOBAL isNaN / isFinite still coerce (must not regress)", async () => {
    expect(await evalBool(`export function test(): boolean { return isNaN("foo" as any); }`)).toBe(true);
    expect(await evalBool(`export function test(): boolean { return isFinite("1" as any); }`)).toBe(true);
  });
});
