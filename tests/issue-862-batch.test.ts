/**
 * Issue #862 — Batch test: verify multiple step-err test262 tests pass
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync, existsSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { buildImports } from "../src/runtime.ts";

async function runTest262File(path: string): Promise<{ pass: boolean; error?: string }> {
  const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
  const src = readFileSync(resolved, "utf-8");
  const meta = parseMeta(src);
  const { source } = wrapTest(src, meta);
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    return { pass: false, error: `CE: ${r.errors[0]?.message}` };
  }
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const ret = (instance.exports as any).test();
    return { pass: ret === 1, error: ret !== 1 ? `returned ${ret}` : undefined };
  } catch (e: any) {
    return { pass: false, error: e.message };
  }
}

const sampleTests = [
  // Arrow function destructuring
  "test262/test/language/expressions/arrow-function/dstr/ary-ptrn-elision-step-err.js",
  "test262/test/language/expressions/arrow-function/dstr/ary-ptrn-rest-id-iter-step-err.js",
  // Variable declarations
  "test262/test/language/statements/variable/dstr/ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/variable/dstr/ary-ptrn-rest-id-iter-step-err.js",
  // for-of with let/const/var
  "test262/test/language/statements/for-of/dstr/let-ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/for-of/dstr/var-ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/for-of/dstr/const-ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/for-of/dstr/let-ary-ptrn-rest-id-iter-step-err.js",
  "test262/test/language/statements/for-of/dstr/var-ary-ptrn-rest-id-iter-step-err.js",
  "test262/test/language/statements/for-of/dstr/const-ary-ptrn-rest-id-iter-step-err.js",
  // Let/const declarations
  "test262/test/language/statements/let/dstr/ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/const/dstr/ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/let/dstr/ary-ptrn-rest-id-iter-step-err.js",
  "test262/test/language/statements/const/dstr/ary-ptrn-rest-id-iter-step-err.js",
  // Class/generator method destructuring
  "test262/test/language/expressions/object/dstr/gen-meth-ary-ptrn-elision-step-err.js",
  "test262/test/language/statements/class/dstr/gen-meth-ary-ptrn-elision-step-err.js",
];

describe("Issue #862 batch", () => {
  for (const testFile of sampleTests) {
    const name = testFile.split("/").pop()!;
    const cat = testFile.split("/").slice(3, -2).join("/");
    it(`${cat}: ${name}`, async () => {
      const resolved = testFile.startsWith("/") ? testFile : `/workspace/${testFile}`;
      if (!existsSync(resolved)) {
        // Skip if file doesn't exist in our test262 copy
        return;
      }
      const result = await runTest262File(testFile);
      expect(result.pass, `error=${result.error}`).toBe(true);
    }, 15000);
  }
});
