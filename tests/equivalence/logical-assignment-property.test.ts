import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./helpers.js";

describe("logical assignment on property access (#415)", () => {
  it("obj.x ??= default when x is defined", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        obj.x ??= 99;
        return obj.x;  // 10
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x ||= default when x is falsy (0)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 0 };
        obj.x ||= 42;
        return obj.x;  // 42
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x ||= default when x is truthy", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        obj.x ||= 42;
        return obj.x;  // 5
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x &&= value when x is truthy", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        obj.x &&= 99;
        return obj.x;  // 99
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x &&= value when x is falsy (0)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 0 };
        obj.x &&= 99;
        return obj.x;  // 0
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("logical assignment returns result value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 0 };
        let result = (obj.x ||= 77);
        return result;  // 77
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained logical assignment on different properties", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { a: 0, b: 10 };
        obj.a ||= 1;
        obj.b &&= 20;
        return obj.a + obj.b;  // 1 + 20 = 21
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("logical assignment on function return value property", async () => {
    await assertEquivalent(
      `
      function makeObj() {
        return { value: 0 };
      }
      export function test(): number {
        let obj = makeObj();
        obj.value ||= 55;
        return obj.value;  // 55
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("logical assignment on accessor properties — GetValue once (#2052)", () => {
  // §13.15.2: a.x ||=/&&=/??= must call the getter exactly once on the
  // short-circuit (keep) path; the setter only fires on the assign path.
  const accessorClass = `
    let gets = 0; let sets = 0;
    class A {
      _x: number;
      constructor(v: number) { this._x = v; }
      get x(): number { gets++; return this._x; }
      set x(v: number) { sets++; this._x = v; }
    }
  `;

  it("a.x &&= v keep path (truthy=0 falsy): getter once, no set", async () => {
    await assertEquivalent(
      `${accessorClass}
      export function test(): number { gets = 0; sets = 0; const a = new A(0); a.x &&= 9; return gets * 100 + sets * 10 + a._x; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("a.x &&= v assign path (truthy): getter once, set once", async () => {
    await assertEquivalent(
      `${accessorClass}
      export function test(): number { gets = 0; sets = 0; const a = new A(3); a.x &&= 9; return gets * 100 + sets * 10 + a._x; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("a.x ||= v keep path (truthy): getter once, no set", async () => {
    await assertEquivalent(
      `${accessorClass}
      export function test(): number { gets = 0; sets = 0; const a = new A(5); a.x ||= 9; return gets * 100 + sets * 10 + a._x; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("a.x ||= v assign path (falsy=0): getter once, set once", async () => {
    await assertEquivalent(
      `${accessorClass}
      export function test(): number { gets = 0; sets = 0; const a = new A(0); a.x ||= 9; return gets * 100 + sets * 10 + a._x; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("a.x ??= v keep path (defined): getter once, no set", async () => {
    await assertEquivalent(
      `${accessorClass}
      export function test(): number { gets = 0; sets = 0; const a = new A(7); a.x ??= 9; return gets * 100 + sets * 10 + a._x; }`,
      [{ fn: "test", args: [] }],
    );
  });
});
