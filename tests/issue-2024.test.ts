import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

/**
 * #2024 — a class whose OWN accessor is get-only must shadow an inherited
 * setter (§10.1.5.3 OrdinarySetWithOwnDescriptor): a strict-mode write throws
 * TypeError and the parent's setter must NOT run. The compiler tracks "this
 * class declares an accessor for this prop" with a single set used for both
 * getters and setters, so a get-only override entered the accessor-write block,
 * found no `<type>_set_<field>` function, fell through to the struct-field path,
 * and silently dropped the write. The write now throws TypeError.
 *
 * The get-only writes use `// @ts-ignore` because TS rejects assigning to a
 * read-only accessor — but the assignment is valid (throwing) JavaScript, which
 * is exactly what test262 exercises.
 */
describe("#2024 get-only accessor override shadows inherited setter", () => {
  it("subclass get-only override: write throws, parent setter does not run", async () => {
    await assertEquivalent(
      `class A { _v = 1; get v(): number { return this._v; } set v(x: number) { this._v = x * 2; } }
       class B extends A { get v(): number { return this._v + 100; } }
       export function test(): number {
         const b = new B();
         try {
           // @ts-ignore — assigning to a read-only accessor is valid (throwing) JS
           b.v = 7;
         } catch (e) {
           return -1;
         }
         return b._v;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("single-class get-only accessor: write throws", async () => {
    await assertEquivalent(
      `class A { _v = 5; get v(): number { return this._v; } }
       export function test(): number {
         const a = new A();
         try {
           // @ts-ignore
           a.v = 7;
         } catch (e) {
           return -1;
         }
         return a._v;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("get-only override: the parent setter side effect never fires", async () => {
    // If the parent setter wrongly ran, `_v` would become 14 (7*2); the write
    // must throw and leave `_v` at its constructed value.
    await assertEquivalent(
      `class A { _v = 3; get v(): number { return this._v; } set v(x: number) { this._v = x * 2; } }
       class B extends A { get v(): number { return this._v; } }
       export function test(): number {
         const b = new B();
         let threw = 0;
         try {
           // @ts-ignore
           b.v = 7;
         } catch (e) {
           threw = 1;
         }
         return threw * 1000 + b._v;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("full accessor pair override still writes (unchanged)", async () => {
    await assertEquivalent(
      `class A { _v = 1; get v(): number { return this._v; } set v(x: number) { this._v = x * 2; } }
       class B extends A { get v(): number { return this._v + 100; } set v(x: number) { this._v = x + 5; } }
       export function test(): number {
         const b = new B();
         b.v = 7;
         return b._v;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("inherited setter (subclass adds no accessor) still writes (unchanged)", async () => {
    await assertEquivalent(
      `class A { _v = 1; get v(): number { return this._v; } set v(x: number) { this._v = x * 3; } }
       class B extends A {}
       export function test(): number {
         const b = new B();
         b.v = 7;
         return b._v;
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
