import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #344: Wrapper constructors (new Number, new String, new Boolean)", () => {
  it("new Number(42).valueOf() returns 42", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(42);
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("new Number() with no args defaults to 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number();
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("new Number(3.14).valueOf() returns 3.14", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(3.14);
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBeCloseTo(3.14, 10);
  });

  it("new Boolean(true).valueOf() returns true", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean(true);
        return b.valueOf();
      }
    `);
    expect(exports.test()).toBe(1); // i32 truthy
  });

  it("new Boolean(false).valueOf() returns false", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean(false);
        return b.valueOf();
      }
    `);
    expect(exports.test()).toBe(0); // i32 falsy
  });

  it("new Boolean() with no args defaults to false", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean();
        return b.valueOf();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("new Number wrapper auto-unboxes in arithmetic", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(10);
        return n.valueOf() + 5;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("new Number with expression argument", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a = 3;
        const b = 4;
        const n = new Number(a + b);
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("typeof new Number() returns 'object'", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const n = new Number(42);
        return typeof n === "object";
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof new Boolean() returns 'object'", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean(true);
        return typeof b === "object";
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("wrapper Number in arithmetic coercion via valueOf", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(7);
        const result: number = n.valueOf() * 2;
        return result;
      }
    `);
    expect(exports.test()).toBe(14);
  });

  it("multiple wrapper constructors in same function", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(10);
        const b = new Boolean(true);
        return n.valueOf() + (b.valueOf() ? 1 : 0);
      }
    `);
    expect(exports.test()).toBe(11);
  });
});
