import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { setupTypescriptRuntime } from "./setup-typescript-runtime.mjs";
import { transformTypescriptTest } from "./typescript-upstream-suite.mjs";
import { UPSTREAM_TEST_SHIM } from "./upstream-suite-runner.mjs";

it("checks exact booleans for original TypeScript assertions", () => {
  const assert = new Function(`${UPSTREAM_TEST_SHIM}\nreturn __qunitAssert;`)();
  expect(() => assert.isTrue(true)).not.toThrow();
  expect(() => assert.isFalse(false)).not.toThrow();
  for (const value of [false, 1, "true", null, undefined]) {
    expect(() => assert.isTrue(value)).toThrow();
  }
  for (const value of [true, 0, "", null, undefined]) {
    expect(() => assert.isFalse(value)).toThrow();
  }
});

it("matches native Buffer using the pinned package and its isolated dependencies", () => {
  const runtime = setupTypescriptRuntime();
  const polyfill = createRequire(import.meta.url)(runtime.entry).Buffer;
  for (const input of ["", "hé", "日本語", "🐱", "\0\x01", "ΠΣ ٵپ औठ ⺐⺠", "hello", "\t\n\r"]) {
    expect(polyfill.from(input, "utf8").toString("base64")).toBe(Buffer.from(input, "utf8").toString("base64"));
  }
  expect(setupTypescriptRuntime().entry).toBe(runtime.entry);
});

it("rejects a deliberately broken TypeScript encoder against an independent oracle", () => {
  const source = transformTypescriptTest(
    `import * as ts from "../_namespaces/ts.js";
    return ts.convertToBase64("hé") === ts.sys.base64encode("hé");`,
    "./projection.js",
    "./buffer.js",
  );
  // Only erase the adapter's static imports. Bind the projected implementation
  // independently of Buffer so sharing the implementation cannot pass this control.
  const body = source.replace(/^import .*;\n/gm, "");
  const check = new Function(
    "Buffer",
    "base64decode",
    "base64encode",
    "convertToBase64",
    "getLeadingCommentRanges",
    "parsePseudoBigInt",
    "SyntaxKind",
    body,
  );
  expect(check(Buffer, undefined, undefined, () => "wrong", undefined, undefined, {})).toBe(false);
  expect(check(Buffer, undefined, undefined, () => "aMOp", undefined, undefined, {})).toBe(true);
});
