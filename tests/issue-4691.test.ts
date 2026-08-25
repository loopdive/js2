import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function runStandalone(source: string): Promise<Record<string, any>> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-4691.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, any>;
}

const variants = [
  ["class expression instance method", "const C = class { method", "new C().method"],
  ["class expression static method", "const C = class { static method", "C.method"],
  ["class declaration instance method", "class C { method", "new C().method"],
  ["class declaration static method", "class C { static method", "C.method"],
] as const;

const exactRows = [
  "test262/test/language/expressions/class/dstr/meth-ary-ptrn-elem-id-init-skipped.js",
  "test262/test/language/expressions/class/dstr/meth-static-ary-ptrn-elem-id-init-skipped.js",
  "test262/test/language/statements/class/dstr/meth-ary-ptrn-elem-id-init-skipped.js",
  "test262/test/language/statements/class/dstr/meth-static-ary-ptrn-elem-id-init-skipped.js",
] as const;

const definePropertyRegressionRows = [
  "test262/test/built-ins/Object/defineProperty/15.2.3.6-4-205.js",
  "test262/test/built-ins/Object/defineProperty/15.2.3.6-4-242.js",
  "test262/test/built-ins/Object/defineProperty/15.2.3.6-4-531-6.js",
] as const;

describe("#4691 class-method array destructuring residual", () => {
  it("passes all four authoritative standalone Test262 rows", async () => {
    for (const file of exactRows) {
      const result = await runTest262File(file, "issue-4691-exact", 120_000, "standalone");
      expect(result.status, `${file}: ${result.error ?? ""}`).toBe("pass");
    }
  }, 120_000);

  it("does not widen unrelated array arguments in the standalone harness", async () => {
    for (const file of definePropertyRegressionRows) {
      const result = await runTest262File(file, "issue-4691-regression", 120_000, "standalone");
      expect(result.status, `${file}: ${result.error ?? ""}`).toBe("pass");
    }
  }, 120_000);

  it.each(variants)("preserves explicit null and skips defaults (%s)", async (_name, declaration, call) => {
    const exports = await runStandalone(`
      let initCount = 0;
      function counter() { initCount += 1; }
      ${declaration}([w = counter(), x = counter(), y = counter(), z = counter()]) {
        return w === null && x === 0 && y === false && z === '' && initCount === 0 ? 1 : 0;
      }}
      export function test(): number {
        return ${call}([null, 0, false, '']);
      }
    `);

    expect(exports.test()).toBe(1);
  });

  it("still applies a default to an absent array element", async () => {
    const exports = await runStandalone(`
      let initCount = 0;
      function counter() { initCount += 1; }
      class C {
        method([w = counter()]) {
          return w === undefined && initCount === 1 ? 1 : 0;
        }
      }
      export function test(): number {
        return new C().method([]);
      }
    `);

    expect(exports.test()).toBe(1);
  });
});
