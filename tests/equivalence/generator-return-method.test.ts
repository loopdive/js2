import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("generator .return() method", () => {
  it("return() sets done flag", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* g() { yield 1; yield 2; yield 3; }
        const it = g();
        it.next();
        const r: any = (it as any).return("done");
        return r.done ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("return() propagates the supplied value", async () => {
    await assertEquivalent(
      `export function test(): string {
        function* g() { yield 1; yield 2; }
        const it = g();
        it.next();
        const r: any = (it as any).return("done");
        return String(r.value);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("next() after return() reports done", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* g() { yield 1; yield 2; }
        const it = g();
        it.next();
        (it as any).return("x");
        const after = it.next();
        return after.done ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("return() on a fresh iterator closes it without yielding", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* g() { yield 1; yield 2; }
        const it = g();
        const r: any = (it as any).return(42);
        return (r.done ? 1 : 0) + (Number(r.value) === 42 ? 10 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
