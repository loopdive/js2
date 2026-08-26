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

  it("rejects Number arguments for branded ABIs and preserves host BigInt width", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-scalar-callable-brands-"));
    try {
      for (const [name, type] of [
        ["booleanValue", "boolean"],
        ["symbolValue", "symbol"],
        ["bigintValue", "bigint"],
      ] as const) {
        writeFileSync(
          join(dir, `${name}.js`),
          `/**
 * @param {${type}} value
 * @returns {${type}}
 */
function ${name}(value) {
  return value;
}

/** @type {(value: any) => any} */
const exported = ${name};
export default exported;
`,
        );
      }
      writeFileSync(
        join(dir, "entry.ts"),
        `import booleanValue from "./booleanValue.js";
import symbolValue from "./symbolValue.js";
import bigintValue from "./bigintValue.js";

export function testBoolean(): any {
  return booleanValue(1);
}

export function testSymbol(): any {
  return symbolValue(1);
}

export function testBigInt(): any {
  return bigintValue((1n << 100n) + 7n);
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
      expect(() => (instance.exports.testBoolean as () => unknown)()).toThrow();
      expect(() => (instance.exports.testSymbol as () => unknown)()).toThrow();
      expect((instance.exports.testBigInt as () => unknown)()).toBe((1n << 100n) + 7n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not admit an unproven any value into the numeric ABI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-scalar-callable-unproven-"));
    try {
      writeFileSync(
        join(dir, "normalize.js"),
        `function normalize(value) {
  return value < 0 ? 0 : value;
}

/** @type {(value: any) => any} */
const exported = normalize;
export default exported;
`,
      );
      writeFileSync(
        join(dir, "entry.ts"),
        `import normalize from "./normalize.js";

const value: any = 3;
export function test(): any {
  return normalize(value);
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
      expect(() => (instance.exports.test as () => unknown)()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not box a boolean-returning candidate as a Number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-scalar-callable-boolean-"));
    try {
      writeFileSync(
        join(dir, "predicate.js"),
        `function predicate(value) {
  return value > 0;
}

/** @type {(value: any) => any} */
const exported = predicate;
export default exported;
`,
      );
      writeFileSync(
        join(dir, "entry.ts"),
        `import predicate from "./predicate.js";

export function test(): any {
  return predicate(1);
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
      expect(() => (instance.exports.test as () => unknown)()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["standalone", "wasi"] as const)("does not enable host scalar bridges for %s", async (target) => {
    const dir = mkdtempSync(join(tmpdir(), `js2-scalar-callable-${target}-`));
    try {
      writeFileSync(
        join(dir, "normalize.js"),
        `function normalize(value) {
  return value < 0 ? 0 : value;
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
`,
      );

      const result = await compileProject(join(dir, "entry.ts"), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target,
        deferTopLevelInit: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
