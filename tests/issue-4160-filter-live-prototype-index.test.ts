// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4160 follow-up — typed Array#filter must route each live indexed read through
 * the same standalone Has/Get MOP used by the dynamic lane when a module can
 * mutate builtin prototype indices. In particular, deleting an own element
 * exposes an inherited element; the vec-overlay tombstone must not terminate
 * prototype lookup.
 */
import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

function outcome(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((candidate) => candidate.displayName === name);
}

describe("#4160 live prototype indices in typed filter", () => {
  it("shares the standalone indexed MOP across a hybrid prepared-IR module", async () => {
    const result = await compile(
      `
        export function filterDeletedOwn(): number {
          (Array.prototype as any)[1] = 1;
          const arr = [0, 111, 2];
          Object.defineProperty(arr, "0", {
            get: function () { delete arr[1]; return 0; },
            configurable: true,
          });
          const filtered = arr.filter(function (value) { return value < 3; });
          return filtered.length * 100 + filtered[1] * 10 + filtered[2];
        }

        export function filterRepeatedDeletes(): number {
          (Array.prototype as any)[4] = 5;
          const source = [1, 2, 3, 4, 5];
          const filtered = source.filter(function (value) {
            delete source[2];
            delete source[4];
            return value > 0;
          });
          return filtered.length * 100 + filtered[0] * 10 + filtered[3];
        }

        export function prepared(value: number): number { return value + 1; }
      `,
      {
        fileName: "issue-4160-filter-live-prototype-index.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);

    // The filter bodies still use the legacy body producer, while a prepared
    // IR body coexists in the same module. Both see the one module-level pair
    // of canonical indexed MOP helpers; no parallel IR-only runtime is minted.
    for (const name of ["filterDeletedOwn", "filterRepeatedDeletes"]) {
      expect(outcome(result, name)).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    expect(outcome(result, "prepared")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.wat.match(/\(func \$__extern_has_idx\b/g)).toHaveLength(1);
    expect(result.wat.match(/\(func \$__extern_get_idx\b/g)).toHaveLength(1);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as {
      filterDeletedOwn: () => number;
      filterRepeatedDeletes: () => number;
      prepared: (value: number) => number;
    };
    expect(exports.filterDeletedOwn()).toBe(312); // [0, inherited 1, 2]
    expect(exports.filterRepeatedDeletes()).toBe(415); // [1, 2, 4, inherited 5]
    expect(exports.prepared(9)).toBe(10);
  });
});
