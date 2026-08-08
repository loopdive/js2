// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4223 follow-up) A JS **boolean** that crosses the closure/externref ABI must
// come back as `true`/`false`, never as the number `1`/`0`.
//
// Two independent brand-losses conspired here, and either one alone reproduces:
//
//   1. `ensureStandaloneBuiltinStaticMethodClosure` typed six boolean builtin
//      statics (`Array.isArray`, `Object.is`, `Object.hasOwn`, `Reflect.has`,
//      `Reflect.set`, `Number.isNaN` & friends) as a PLAIN `i32` — no
//      `boolean: true` brand — so their reified function values boxed `false`
//      as the number `0`.
//   2. `tryEmitInlineDynamicCall` carried a private copy of the
//      closure-result→externref decision that tested only `ret.kind === "i32"`
//      and always emitted `f64.convert_i32_s` + `__box_number`.
//
// (1) is contagious, which is why it mattered far beyond those six names: the
// funcref-wrapper registry keys ONE wrapper per wasm signature — it must,
// because WasmGC type identity is structural, so two "different"
// `(externref, externref) -> i32` types are the same type at run time and a
// `ref.test` dispatch ladder cannot tell them apart. Whoever registers a
// signature first fixes the brand for every closure sharing it. Once #4223's
// wrapper-constructor carriers began minting `Object.is`/`Object.hasOwn` from
// inside `ensureObjectRuntime`, those unbranded statics won the race, and every
// USER boolean predicate with the same wasm signature started boxing as a
// number. That is what broke 105 standalone test262 descriptor tests:
// propertyHelper's `isConfigurable()` answered `0` instead of `false`, so
// `verifyProperty`'s `desc.configurable !== isConfigurable(obj, name)` compared
// `false !== 0` and reported "<p> descriptor should (not) be configurable".
//
// The user-predicate cases below are the ones with real reach; the builtin-value
// cases pin the brand at its source so the race cannot be re-lost.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<Record<string, number>> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(exports)) {
    if (typeof exports[name] === "function" && name.startsWith("t_")) out[name] = exports[name]!();
  }
  return out;
}

describe("#4223 — a boolean crossing the closure ABI stays a boolean", () => {
  it("a user predicate reached through the dynamic-call ladder answers false, not 0", async () => {
    // `Object.is` is read as a VALUE so the wrapper-constructor carriers mint
    // the builtin static closure first — the exact ordering that flipped the
    // shared `(externref, externref) -> i32` wrapper's brand.
    const out = await run(`
      const sameValue: any = Object.is;

      function bothOwn(o: any, k: any): boolean {
        return !!Object.prototype.hasOwnProperty.call(o, k);
      }

      export function t_false_is_false(): number {
        const p: any = bothOwn;
        const r: any = p({ a: 1 }, "zzz");
        return r === false ? 1 : 0;
      }
      export function t_false_is_not_zero(): number {
        const p: any = bothOwn;
        const r: any = p({ a: 1 }, "zzz");
        return r === 0 ? 1 : 0;
      }
      export function t_true_is_true(): number {
        const p: any = bothOwn;
        const r: any = p({ a: 1 }, "a");
        return r === true ? 1 : 0;
      }
      export function t_typeof_is_boolean(): number {
        const p: any = bothOwn;
        const r: any = p({ a: 1 }, "a");
        return typeof r === "boolean" ? 1 : 0;
      }
      export function t_value_read_kept(): number {
        return typeof sameValue === "function" ? 1 : 0;
      }
    `);
    expect(out).toEqual({
      t_false_is_false: 1,
      t_false_is_not_zero: 0,
      t_true_is_true: 1,
      t_typeof_is_boolean: 1,
      t_value_read_kept: 1,
    });
  }, 120_000);

  it("the boolean builtin statics reify as boolean-valued function values", async () => {
    const out = await run(`
      export function t_object_is_false(): number {
        const f: any = Object.is;
        return f(1, 2) === false ? 1 : 0;
      }
      export function t_object_is_true(): number {
        const f: any = Object.is;
        return f(1, 1) === true ? 1 : 0;
      }
      export function t_is_array_false(): number {
        const f: any = Array.isArray;
        return f({}) === false ? 1 : 0;
      }
      export function t_is_array_true(): number {
        const f: any = Array.isArray;
        return f([]) === true ? 1 : 0;
      }
      export function t_number_isnan_false(): number {
        const f: any = Number.isNaN;
        return f(1) === false ? 1 : 0;
      }
    `);
    expect(out).toEqual({
      t_object_is_false: 1,
      t_object_is_true: 1,
      t_is_array_false: 1,
      t_is_array_true: 1,
      t_number_isnan_false: 1,
    });
  }, 120_000);
});
