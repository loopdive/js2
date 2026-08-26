// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

describe("extern boundary routing", () => {
  it("keeps namespace Reflect.apply on its native-first boundary lowering", async () => {
    const result = await compile(
      `export function apply(target: any, thisArg: any, args: any): any {
        return Reflect.apply(target, thisArg, args);
      }`,
      {
        fileName: "reflect-apply-native-first.ts",
        semanticProviders: "native-first",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.imports.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining(["__js_array_new", "__js_array_push"]),
    );
  });

  it("preserves a WeakRef target's Wasm struct identity across the host", async () => {
    const wasm = await compileToWasm(`
      export function test(): number {
        const target = { x: 7 };
        const reference = new WeakRef(target);
        const result = reference.deref();
        return result ? result.x : -1;
      }
    `);

    expect(wasm.test()).toBe(7);
  });
});
