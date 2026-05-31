/**
 * #1526 — Mixed BigInt + Number arithmetic must throw spec TypeError.
 *
 * Per spec §6.1.6.2.1 / §13.15 ApplyStringOrNumericBinaryOperator, mixing
 * BigInt with Number in arithmetic (e.g. `1n + 1`, `1n * 2`) must throw a
 * `TypeError` instance — not a bare string, and not the host's native
 * "Cannot mix BigInt …" exception. test262 cases use
 * `assert.throws(TypeError, …)` which checks `e instanceof TypeError`.
 *
 * Special case: `+` with a string operand is *string concatenation*
 * (not numeric add) per §13.15.4 — `1n + ""` must produce `"1"`, NOT
 * throw, because once one operand is a string after ToPrimitive both
 * operands are coerced to strings.
 *
 * Fix in `src/codegen/binary-ops.ts`:
 *   - The mixed-BigInt arithmetic path used `emitThrowString` which only
 *     throws the bare message as an externref. Switched to
 *     `emitThrowTypeError` (registers `__new_TypeError` host import and
 *     throws the real `TypeError` instance).
 *   - Added a routing branch: when op is `+` and either side is a
 *     string, route to `compileStringBinaryOp` instead of throwing.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue #1526 — BigInt + Number TypeError, BigInt + String concat", () => {
  it("`1n + 1` throws an instance of TypeError (caught in catch)", async () => {
    // Use a freestanding catch to inspect the thrown value's tag. TS won't
    // accept literal `1n + 1`, so we route through a function-shaped capture
    // that the compiler still recognises as a statically mixed BigInt+Number
    // expression (the same shape as test262 cases).
    const source = `
let typeErrorCaught: number = 0;
function tryMix(): void {
  // @ts-expect-error: deliberately mixing BigInt and Number
  const r = 1n + 1;
  typeErrorCaught = -1;
}

export function test(): number {
  try {
    tryMix();
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

  it("`1n * 2` throws an instance of TypeError", async () => {
    const source = `
function tryMix(): void {
  // @ts-expect-error: deliberately mixing BigInt and Number
  const r = 1n * 2;
}

export function test(): number {
  try {
    tryMix();
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

  it('`1n + "x"` performs string concatenation (no throw)', async () => {
    // BigInt + string → string concat per §13.15.4 (after ToPrimitive,
    // either side string triggers ToString on both).
    const source = `
function mix(): string {
  // @ts-expect-error: deliberately mixing BigInt and String
  return 1n + "x";
}

export function test(): string {
  return mix();
}
`;
    const exports = await compileToWasm(source);
    expect(exports.test!()).toBe("1x");
  });

  it("compiles to valid wasm for repeated mixed-BigInt arithmetic", async () => {
    // Stack-balance regression check — emitThrowTypeError pushes/pops the
    // same way as emitThrowString; verify the module validates with
    // multiple mixed-bigint sites and try/catch around them.
    const result = await compile(`
let fail: number = 0;
function assert_throws(fn: () => void): void {
  try { fn(); } catch (e) { return; }
  fail = 1;
}
export function test(): number {
  assert_throws(function() { 1n + 1; });
  assert_throws(function() { 1 + 1n; });
  assert_throws(function() { 1n - 1; });
  assert_throws(function() { 1n * 1; });
  return fail === 0 ? 1 : 0;
}
`);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
