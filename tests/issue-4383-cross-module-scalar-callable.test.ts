import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#4383 cross-module scalar callable dispatch", () => {
  it("bridges an any-typed import to its compiled numeric ABI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-uuid-scalar-callable-"));
    try {
      writeFileSync(
        join(dir, "normalize.js"),
        `function withDefault(value = 5) {
  return value;
}

function normalize(value) {
  if (value < 0) value = 0;
  return withDefault(value);
}

/** @type {(value: any) => any} */
const exported = normalize;
export default exported;
`,
      );
      writeFileSync(
        join(dir, "entry.ts"),
        `import normalize from "./normalize.js";

export function test(): number {
  return normalize(3);
}

export function testOmitted(): number {
  return normalize();
}
`,
      );

      const result = await compileProject(join(dir, "entry.ts"), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "gc",
        platform: "node",
        deferTopLevelInit: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

      const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      (instance.exports.__module_init as (() => void) | undefined)?.();
      expect((instance.exports.test as () => number)()).toBe(3);
      expect((instance.exports.testOmitted as () => number)()).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
