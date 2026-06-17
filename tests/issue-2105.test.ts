// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #2105 — value-rep P2 boolean-brand rollout for `Array.prototype.join` /
 * `Array.prototype.toString`.
 *
 * A boolean array lowers to an i32 WasmGC element array, but the
 * `{ kind: "i32", boolean: true }` ValType brand is structural-only and does
 * not survive into `arrDef.element` (arrays dedupe by structure). The join
 * element-stringify path therefore rendered booleans numerically ("1"/"0")
 * instead of "true"/"false". The fix recovers boolean-ness from the receiver's
 * TS element type (`boolean[]` → number-index type is `boolean`) in both the
 * JS-host join path and the native-strings (standalone / WASI) join path.
 */

async function js(body: string): Promise<unknown> {
  const e = await compileToWasm(body);
  return (e as { test: () => unknown }).test();
}

describe("#2105 boolean-brand rollout — join (JS host)", () => {
  it("join of a boolean[] renders true/false, not 1/0", async () => {
    expect(
      await js(`export function test(): string { const arr: boolean[] = [true, false, true]; return arr.join(","); }`),
    ).toBe("true,false,true");
  });

  it("join of comparison-result booleans renders true/false", async () => {
    expect(await js(`export function test(): string { const arr = [1 < 2, 2 < 1]; return arr.join(","); }`)).toBe(
      "true,false",
    );
  });

  it("default separator (no arg) renders true/false", async () => {
    expect(
      await js(`export function test(): string { const arr: boolean[] = [false, true]; return arr.join(); }`),
    ).toBe("false,true");
  });

  it("Array.prototype.toString of a boolean[] delegates to join with true/false", async () => {
    expect(
      await js(`export function test(): string { const arr: boolean[] = [true, false]; return arr.toString(); }`),
    ).toBe("true,false");
  });

  it("does not regress number[] join (stays numeric)", async () => {
    expect(await js(`export function test(): string { const arr = [1, 0, 2]; return arr.join(","); }`)).toBe("1,0,2");
  });

  it("does not regress string[] join", async () => {
    expect(await js(`export function test(): string { const arr = ["a", "b"]; return arr.join(","); }`)).toBe("a,b");
  });
});

describe("#2105 boolean-brand rollout — join (standalone, no JS host)", () => {
  async function standaloneLen(body: string): Promise<number> {
    const r = await compile(body, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    for (const re of [/^env::__extern_toString$/, /^wasm:js-string::/]) {
      expect(
        labels.filter((l) => re.test(l)),
        `leaked ${re}`,
      ).toEqual([]);
    }
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  it("boolean[] join renders true/false (length proof: 'true,false,true' = 15)", async () => {
    expect(
      await standaloneLen(
        `export function test(): number { const arr: boolean[] = [true, false, true]; return arr.join(",").length; }`,
      ),
    ).toBe(15);
  });

  it("number[] join stays numeric in standalone (length proof: '1,0,1' = 5)", async () => {
    expect(
      await standaloneLen(`export function test(): number { const arr = [1, 0, 1]; return arr.join(",").length; }`),
    ).toBe(5);
  });
});
