// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3995 — ambient builtin aliases keep their source identity across modules.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

describe("#3995 lodash-es ambient builtin alias identity", () => {
  it("does not resolve a global parseInt alias to a package export named parseInt", async () => {
    const result = await compileMulti(
      {
        "./entry.js": `
          import parseInt from "./package-parse-int.js";
          import { parseBinary } from "./to-number.js";
          export function test() {
            return parseBinary() + (parseInt("1", 2, true) === 999 ? 0 : 100);
          }
        `,
        "./package-parse-int.js": `
          export default function parseInt(string, radix, guard) {
            return guard ? 999 : Number(string) + Number(radix);
          }
        `,
        "./to-number.js": `
          var freeParseInt = parseInt;
          export function parseBinary() { return freeParseInt("10", 2); }
        `,
      },
      "./entry.js",
      { allowJs: true, skipSemanticDiagnostics: true, platform: "node" },
    );

    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(2);
  });
});
