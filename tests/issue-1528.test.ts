/**
 * #1528 — Non-constructor TypeError must be a real `TypeError` instance.
 *
 * Per spec §10.1.13 / §7.3.13 `Construct(F, …)` requires `IsConstructor(F)`
 * and throws `TypeError("<F> is not a constructor")` otherwise. test262 cases
 * use `assert.throws(TypeError, …)` which checks `e instanceof TypeError`.
 *
 * Previously the three non-constructor codegen sites emitted a bare-string
 * throw via `emitThrowString` — the thrown value was an externref string,
 * not a TypeError instance, so `e instanceof TypeError` was false.
 *
 * Fix in `src/codegen/expressions/new-super.ts`:
 *   - `new (() => {})()` — arrow functions are not constructors (#730 path).
 *   - `new X.prototype.Y()` — prototype methods are not constructors.
 *   - `new <call-only-callable>()` — TS knows call sigs but no construct sigs
 *     (e.g. `new Math.abs()`).
 *
 * All three now use `emitThrowTypeError`, which registers `__new_TypeError`
 * (an extern_class `new` import resolved to the real `TypeError` constructor
 * by `src/runtime.ts`). Standalone fallback still produces a throwable
 * externref so the trap is still observable.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1528 — non-constructor throws real TypeError instance", () => {
  it("`new Math.abs()` throws an instance of TypeError", async () => {
    // Pattern 2: TS knows `Math.abs` has call sigs but no construct sigs.
    const source = `
export function test(): number {
  try {
    // @ts-expect-error: Math.abs is not a constructor
    const r = new Math.abs(1);
    return -1;
  } catch (e: any) {
    if (e instanceof TypeError) return 1;
    return -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  it("`new Array.prototype.forEach()` throws an instance of TypeError", async () => {
    // Pattern 1: `new X.prototype.Y()` — prototype methods are never constructors.
    const source = `
export function test(): number {
  try {
    // @ts-expect-error: prototype methods are not constructors
    const r = new Array.prototype.forEach();
    return -1;
  } catch (e: any) {
    if (e instanceof TypeError) return 1;
    return -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  it("`new (() => 0)()` throws an instance of TypeError", async () => {
    // Arrow function detection (parenthesized arrow as the new target).
    const source = `
export function test(): number {
  try {
    // @ts-expect-error: arrow functions are not constructors
    const r = new (() => 0)();
    return -1;
  } catch (e: any) {
    if (e instanceof TypeError) return 1;
    return -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  it("error message contains 'is not a constructor'", async () => {
    // Sanity: the spec wording is preserved in the TypeError message.
    const source = `
export function test(): string {
  try {
    // @ts-expect-error
    const r = new Math.abs(1);
    return "no throw";
  } catch (e: any) {
    return String((e as Error).message);
  }
}
`;
    const exports = await compileToWasm(source);
    const msg = exports.test!() as string;
    expect(msg).toContain("is not a constructor");
  });

  // (#1528b) The static non-constructor guards must also fire when the target
  // is hidden behind an `as`/`!`/type-assertion wrapper, not just bare parens.
  // Before the unwrap fix, `new ((() => {}) as any)()` slipped past the
  // paren-only unwrap into the dynamic path and silently did NOT throw.
  it("`new ((() => {}) as any)()` throws an instance of TypeError", async () => {
    const source = `
export function test(): number {
  try {
    new ((() => {}) as any)();
    return -1;
  } catch (e: any) {
    return e instanceof TypeError ? 1 : -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  // (#1528b) Cast-wrapped prototype-method / call-only-callable targets must
  // resolve through the unwrap so the call-sig-only guard still sees the real
  // (pre-cast) type rather than the widened `any`.
  it("`new (Math.abs as any)()` throws an instance of TypeError", async () => {
    const source = `
export function test(): number {
  try {
    new (Math.abs as any)(1);
    return -1;
  } catch (e: any) {
    return e instanceof TypeError ? 1 : -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });
});

// #1528a — `new <arrow-function value>()` must throw a real TypeError.
// An arrow function has no [[Construct]] (§15.3.4), so `new (arrow)()` is a
// non-constructor TypeError (§7.3.15 Construct → §7.2.4 IsConstructor). Through
// a local of type `any` no static guard saw the arrow, so control reached the
// unknown-constructor path and wrongly did not throw. The fix marks an arrow
// initializer as a provably-non-constructable value in
// `resolvesToNonConstructableValue`, routing it through the existing `__construct`
// brand check (which throws a real TypeError instance), alongside the
// prototype-method / bound-function shapes (#1732 S1). This is the
// substrate-independent subset of the #1528a non-constructor cluster; dynamically
// CONSTRUCTING a runtime function value (vs. throwing) remains a closure-construct
// substrate follow-up (#1632b-2).
describe("issue #1528a — new on an arrow-function value throws real TypeError", () => {
  it("`const f = () => 1; new f()` throws an instance of TypeError", async () => {
    const source = `
export function test(): number {
  const f: any = () => 1;
  try {
    new f();
    return -1;
  } catch (e: any) {
    return e instanceof TypeError ? 1 : -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  it("`const f = (() => 1) as any; new f()` (cast-wrapped) throws TypeError", async () => {
    const source = `
export function test(): number {
  const f = (() => 1) as any;
  try {
    new f();
    return -1;
  } catch (e: any) {
    return e instanceof TypeError ? 1 : -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  it("arrow with params is still a non-constructor", async () => {
    const source = `
export function test(): number {
  const f: any = (a: number, b: number) => a + b;
  try {
    new f(1, 2);
    return -1;
  } catch (e: any) {
    return e instanceof TypeError ? 1 : -2;
  }
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(1);
  });

  // Regression guards — real constructors must STILL construct (not throw).
  it("a user class still constructs (no false TypeError)", async () => {
    const source = `
class Box { v = 7; }
export function test(): number {
  const o = new Box();
  return o.v;
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(7);
  });

  it("a function declaration still constructs (no false TypeError)", async () => {
    const source = `
function C(this: any) { (this as any).x = 3; }
export function test(): number {
  const o: any = new C();
  return o.x;
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe(3);
  });
});
