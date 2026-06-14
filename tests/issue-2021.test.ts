import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

/**
 * #2021 — an array literal whose first element is a *subclass* must still be
 * able to hold ancestor-class elements when the declared element type is the
 * ancestor. The element kind was taken from the first element's type (`Circle`),
 * so a later `new Shape()` could not satisfy `(ref $Circle)` and ended up null,
 * trapping "dereferencing a null pointer". The literal now prefers the
 * contextual `Array<T>` annotation's element type (the declared common
 * supertype) when the first element resolves to a struct ref.
 */
describe("#2021 array literal element type from annotation, not first element", () => {
  const decls = `
    class Shape { area(): number { return 1; } }
    class Circle extends Shape { r = 2; area(): number { return 3 * this.r * this.r; } }`;

  it("subclass-first + ancestor-later (the repro)", async () => {
    await assertEquivalent(
      `${decls}
       export function test(): number {
         const a: Shape[] = [new Circle(), new Shape()];
         return a.length;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("base-first ordering unchanged", async () => {
    await assertEquivalent(
      `${decls}
       export function test(): number {
         const a: Shape[] = [new Shape(), new Circle()];
         return a.length;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("polymorphic dispatch over the mixed array", async () => {
    await assertEquivalent(
      `${decls}
       export function test(): number {
         const a: Shape[] = [new Circle(), new Shape()];
         let s = 0;
         for (const x of a) s += x.area();
         return s;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("subclass-first, ancestor field read via base method", async () => {
    await assertEquivalent(
      `${decls}
       export function test(): number {
         const a: Shape[] = [new Circle(), new Shape(), new Circle()];
         return a[1]!.area() + a[2]!.area();
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("three-level hierarchy, subclass-first", async () => {
    await assertEquivalent(
      `class A { tag(): number { return 1; } }
       class B extends A { tag(): number { return 2; } }
       class C extends B { tag(): number { return 3; } }
       export function test(): number {
         const a: A[] = [new C(), new B(), new A()];
         let s = 0;
         for (const x of a) s = s * 10 + x.tag();
         return s;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("no annotation: sibling subclasses still work (unchanged)", async () => {
    await assertEquivalent(
      `class Base { v(): number { return 0; } }
       class L extends Base { v(): number { return 1; } }
       class R extends Base { v(): number { return 2; } }
       export function test(): number {
         const a = [new L(), new R()];
         return a.length;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("homogeneous annotated array unchanged", async () => {
    await assertEquivalent(
      `${decls}
       export function test(): number {
         const a: Circle[] = [new Circle(), new Circle()];
         return a[0]!.area();
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
