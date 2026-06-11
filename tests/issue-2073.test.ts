// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2073 — standalone `==` between a string and a number/boolean leaked an
// `env::__host_loose_eq` import.
//
// `compileBinaryExpression`'s mixed-primitive loose-equality branch routed
// `"1" == 1`, `0 == ""`, `false == ""`, etc. through the JS-host
// `__host_loose_eq` import unconditionally. Under `--target standalone` (and
// WASI) there is no JS host, so the module carried an unsatisfiable
// `env::__host_loose_eq` import and failed `WebAssembly.instantiate` with no
// env object.
//
// Fix: in standalone / WASI, compile these comparisons to a pure-Wasm numeric
// compare per §7.2.15 IsLooselyEqual — ToNumber both sides (the native
// `__str_to_number` §7.1.4.1 scanner for the string, `f64.convert_i32_s` for
// the boolean) then `f64.eq` / `f64.ne`. JS-host mode is unchanged.
//
// (The any/any half of the original task — #2081 — is tracked separately; it
// depends on type-aware AnyValue boxing, #2072/#2080.)

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

// Compile `return <expr>;` under --target standalone, assert ZERO env imports
// (the leak this fixes), instantiate with no host object, and read the boolean.
async function standaloneEq(expr: string): Promise<boolean> {
  const r = await compile(`export function test(): boolean { return ${expr}; }`, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, `standalone leaked env imports: ${envImports.join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return Boolean((instance.exports as { test(): number }).test());
}

describe("#2073 standalone mixed-primitive == is pure Wasm (no __host_loose_eq)", () => {
  it("string == number coerces the string via ToNumber", async () => {
    expect(await standaloneEq(`("1" as string) == (1 as number)`)).toBe(true);
    expect(await standaloneEq(`(1 as number) == ("1" as string)`)).toBe(true);
    expect(await standaloneEq(`("1.5" as string) == (1.5 as number)`)).toBe(true);
    expect(await standaloneEq(`("-3" as string) == (-3 as number)`)).toBe(true);
  });

  it("StringToNumber semantics: empty/whitespace → 0, hex prefix, non-numeric → NaN", async () => {
    expect(await standaloneEq(`(0 as number) == ("" as string)`)).toBe(true); // Number("") === 0
    expect(await standaloneEq(`(5 as number) == ("  5  " as string)`)).toBe(true); // trimmed
    expect(await standaloneEq(`("0x10" as string) == (16 as number)`)).toBe(true); // hex
    expect(await standaloneEq(`("x" as string) == (1 as number)`)).toBe(false); // NaN != 1
    expect(await standaloneEq(`("NaN" as string) == (0 as number)`)).toBe(false);
  });

  it("string == boolean coerces both via ToNumber", async () => {
    expect(await standaloneEq(`(false as boolean) == ("" as string)`)).toBe(true); // 0 == 0
    expect(await standaloneEq(`("" as string) == (false as boolean)`)).toBe(true);
    expect(await standaloneEq(`("1" as string) == (true as boolean)`)).toBe(true); // 1 == 1
    expect(await standaloneEq(`("2" as string) == (true as boolean)`)).toBe(false); // 2 != 1
  });

  it("!= negates correctly", async () => {
    expect(await standaloneEq(`("1" as string) != (1 as number)`)).toBe(false);
    expect(await standaloneEq(`("abc" as string) != (1 as number)`)).toBe(true);
  });
});
