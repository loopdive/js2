// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4529 — jest-get-type's failure family.
//
//  1. TS narrows an `unknown` parameter to the empty anonymous object type
//     `{}` behind nullish guards; `{}` admits every non-nullish value, so
//     `staticTypeofForType` folding it to "object" turned getType's whole
//     `typeof value === '…'` chain into constant-false compares.
//  2. `Object(value)` on an `any`/`unknown`-typed argument compiled as
//     identity, so `Object(value) !== value` (jest's isPrimitive) answered
//     false for every primitive. Host mode now routes through the
//     `__to_object` helper (real §7.1.18 ToObject), which also unwraps
//     Wasm-native boxed carriers before wrapping.
//  3. Host `__typeof` reported "object" for primitives boxed in Wasm-native
//     carriers ($Any number/boolean, native string/symbol structs).

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

const LIB = `
export const isPrimitive = (value: unknown): boolean => Object(value) !== value;
export function getType(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'symbol') return 'symbol';
  return 'unknown';
}
`;

describe("issue #4529: typeof/ToObject on narrowed unknown", () => {
  it("getType classifies primitives behind nullish guards", async () => {
    const result = await compileMulti(
      {
        "./lib.ts": LIB,
        "./main.ts": `
          import { getType } from './lib.ts';
          export function run(): string {
            return [getType(1), getType('oi'), getType(true), getType({}), getType([]), getType(null), getType(undefined)].join(',');
          }
        `,
      },
      "./main.ts",
      { skipSemanticDiagnostics: true },
    );
    expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (instance.exports as Record<string, Function>).__module_init?.();
    const wrapped = wrapExports(instance.exports as Record<string, Function>) as { run: () => string };
    expect(wrapped.run()).toBe("number,string,boolean,object,array,null,undefined");
  });

  it("isPrimitive distinguishes primitives from objects via ToObject identity", async () => {
    const result = await compileMulti(
      {
        "./lib.ts": LIB,
        "./main.ts": `
          import { isPrimitive } from './lib.ts';
          export function run(): string {
            const o = { a: 1 };
            return ['' + isPrimitive(100), '' + isPrimitive('hello'), '' + isPrimitive(true), '' + isPrimitive(null), '' + isPrimitive(undefined), '' + isPrimitive(o)].join(',');
          }
        `,
      },
      "./main.ts",
      { skipSemanticDiagnostics: true },
    );
    expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (instance.exports as Record<string, Function>).__module_init?.();
    const wrapped = wrapExports(instance.exports as Record<string, Function>) as { run: () => string };
    expect(wrapped.run()).toBe("true,true,true,true,true,false");
  });
});
