import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("WeakRef basic operations", () => {
  it("WeakRef.deref returns the original object's field while alive", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { x: 7 };
        const ref = new WeakRef(obj);
        const r = ref.deref();
        return r ? r.x : -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("WeakRef.deref returns the same object identity on repeated calls", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { x: 5 };
        const ref = new WeakRef(obj);
        const a = ref.deref();
        const b = ref.deref();
        return a === b ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof WeakRef instance is 'object'", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj = { x: 1 };
        const ref = new WeakRef(obj);
        return typeof ref;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
