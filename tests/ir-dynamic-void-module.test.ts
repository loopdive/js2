// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

// Focused lowering/runtime controls through the compatibility driver's IR
// overlay, not whole-program IR-only Test262 qualification.

for (const strict of [false, true]) {
  for (const initialization of ["var value; value = void bump();", "var value; value = true; value = (void bump());"]) {
    it(`preserves dynamic void identity (${strict ? "strict" : "sloppy"}, ${initialization})`, async () => {
      const result = await compile(
        `${strict ? '"use strict";' : ""}var effects = 0; function bump() { effects = effects + 1; return 7; } ${initialization}
if (effects !== 1) throw "operand effects lost or repeated";
if (value !== undefined) throw "undefined identity lost";
if (value === null) throw "undefined became null";`,
        {
          fileName: "dynamic-void.js",
          allowJs: true,
          target: "standalone",
          trackIrOutcomes: true,
          deferTopLevelInit: true,
        },
      );
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const init = result.irOutcomes?.find((o) => o.displayName === "<module-init>");
      expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      expect(instance.exports.__module_init).toBeTypeOf("function");
      (instance.exports.__module_init as () => void)();
    });
  }
}
