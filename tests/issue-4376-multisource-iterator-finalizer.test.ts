// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4376 — compileMulti must finalize the native iterator's late carrier arms.
 *
 * `Reflect.ownKeys` returns the object runtime's `$ObjVec`, while the native
 * GetIterator runtime is initially emitted with only its canonical `$Vec` arm.
 * The finalizer normally installs the `$ObjVec` normalization arm after all
 * types are registered. This graph routes the result through a captured static
 * function value across a source boundary, matching Deno primordials' use of
 * `ReflectOwnKeys` before a `for...of` loop.
 */
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("#4376 — compileMulti native iterator finalizer", () => {
  it("iterates a captured Reflect.ownKeys result returned from another source", async () => {
    const result = await compileMulti(
      {
        "./reflect.ts": `
          export function ownKeys(value: any): any {
            const ReflectOwnKeys: any = Reflect.ownKeys;
            return ReflectOwnKeys(value);
          }
        `,
        "./entry.ts": `
          import { ownKeys } from "./reflect.ts";

          export function test(): number {
            const source: any = { first: 1, second: 2 };
            let count = 0;
            for (const key of ownKeys(source)) {
              if (key === "first" || key === "second") count += 1;
            }
            return count;
          }
        `,
      },
      "./entry.ts",
      { target: "standalone", nativeStrings: true, skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(2);
  });
});
