// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2102 — shared `emitThrowJsError(kind, msg)` lowering + trap-site audit.
 *
 * Runtime integrity checks that the spec requires to raise a *catchable*
 * `TypeError` (here: `Object.defineProperty` redefining a non-configurable
 * property, ES2024 §10.1.6.3 ValidateAndApplyPropertyDescriptor) previously
 * lowered to a bare *string* throw — caught by `catch (e)`, but `e instanceof
 * TypeError` was false. After routing the trap sites through
 * `emitThrowTypeError` (a thin wrapper over the consolidated
 * `emitThrowJsError`), the thrown value is a real `TypeError` instance in both
 * JS-host and standalone modes.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, opts: Record<string, unknown> = {}): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", ...opts });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports.test as () => number | undefined)();
}

// `caught` encoding: 1 = real TypeError instance, 2 = some other thrown value,
// 0 = no throw at all.
const REDEFINE_SRC = `
export function test(): number {
  const o: any = {};
  Object.defineProperty(o, "x", { value: 1, configurable: false });
  let caught = 0;
  try {
    Object.defineProperty(o, "x", { value: 2, configurable: true });
  } catch (e) {
    caught = (e instanceof TypeError) ? 1 : 2;
  }
  return caught;
}
`;

describe("#2102 catchable JS errors from trap sites", () => {
  it("redefining a non-configurable property throws a real TypeError (JS-host mode)", async () => {
    expect(await run(REDEFINE_SRC)).toBe(1);
  });

  it("the same path compiles and instantiates under --target standalone", async () => {
    // In standalone mode the in-module __new_TypeError constructor is used —
    // the module must instantiate with no unsatisfiable host import.
    const r = await compile(REDEFINE_SRC, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
    expect(typeof instance.exports.test).toBe("function");
  });
});
