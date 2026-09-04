// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 R3-7(a) — `Map.prototype[Symbol.iterator]` and
// `Set.prototype[Symbol.iterator]` are OWN properties of their prototypes
// (§24.1.3.12 / §24.2.3.11), whose values ARE `entries` / `values`.
//
// The VALUE already aliased the right closure; `hasOwnProperty` answered false
// because the own-props ladder only knows members listed in the glue CSV. The
// `@@<id>` sentinel is the symbol-cell spelling, so adding `"@@1"` to the two
// CSVs plus a `memberAliasOf` entry seeds the own property without leaking a
// `"@@1"` STRING key into `Object.getOwnPropertyNames`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    deferTopLevelInit: true,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return { value: (exports.test as () => number)(), hostImports };
}

describe("#5267 R3-7a — collection @@iterator is an own property of the prototype", () => {
  it("hasOwnProperty is true and the value is the entries/values function object", async () => {
    const { value, hostImports } = await runStandalone(
      `var score = 0;
       if (Object.prototype.hasOwnProperty.call(Map.prototype, Symbol.iterator)) score += 1;
       if (Object.prototype.hasOwnProperty.call(Set.prototype, Symbol.iterator)) score += 2;
       if (Map.prototype[Symbol.iterator] === Map.prototype.entries) score += 4;
       if (Set.prototype[Symbol.iterator] === Set.prototype.values) score += 8;
       if (Set.prototype.keys === Set.prototype.values) score += 16;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(31);
  });

  it('no "@@1" string key leaks into getOwnPropertyNames', async () => {
    const { value } = await runStandalone(
      `var leaked = 0;
       var names = Object.getOwnPropertyNames(Map.prototype).concat(Object.getOwnPropertyNames(Set.prototype));
       for (var i = 0; i < names.length; i++) { if (names[i].indexOf("@@") >= 0) leaked += 1; }
       export function test(): number { return leaked; }`,
    );
    expect(value).toBe(0);
  });
});
