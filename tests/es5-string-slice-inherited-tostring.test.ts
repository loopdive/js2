import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));

async function instantiateStandalone(
  source: string,
  fileName: string,
): Promise<Record<string, WebAssembly.ExportValue>> {
  const result = await compile(source, {
    target: "standalone",
    fileName,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports, "standalone output leaked host imports").toEqual([]);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  return instance.exports as Record<string, WebAssembly.ExportValue>;
}

async function runStandalone(source: string, fileName: string): Promise<unknown> {
  const exports = await instantiateStandalone(source, fileName);
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.test as () => unknown)();
}

describe("ES5 String.prototype.slice inherited receiver coercion (standalone)", () => {
  it("passes the authoritative borrowed-slice test262 row", async () => {
    const row = resolve(HERE, "../test262/test/built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js");
    const body = readFileSync(row, "utf8");
    const assembly = assembleOriginalHarness(body, parseMeta(body));
    const exports = await instantiateStandalone(assembly.primary.source, "test262-borrowed-string-slice.js");
    expect(exports.__module_init).toBeTypeOf("function");
    expect(() => (exports.__module_init as () => void)()).not.toThrow();
  });

  it("coerces through an inherited override for borrowed String methods", async () => {
    expect(
      await runStandalone(
        `Factory.prototype.toString = function() { return this.value + ""; };
         var instance = new Factory(void 0);
         export function test() {
           return (instance.slice(0, 100) === "undefined" ? 1 : 0) +
             (instance.substring(0, 100) === "undefined" ? 10 : 0) +
             (instance.charAt(0) === "u" ? 100 : 0);
         }
         function Factory(value) {
           this.value = value,
             this.slice = String.prototype.slice,
             this.substring = String.prototype.substring,
             this.charAt = String.prototype.charAt;
         }`,
        "es5-string-borrowed-methods.js",
      ),
    ).toBe(111);
  });

  it("walks multiple prototype links for a borrowed String method", async () => {
    expect(
      await runStandalone(
        `var base = { toString: function() { return "abcdef"; } };
         var middle = Object.create(base);
         Factory.prototype = Object.create(middle);
         var instance = new Factory();
         export function test() { return instance.slice(1, 4) === "bcd" ? 1 : 0; }
         function Factory() { this.slice = String.prototype.slice; }`,
        "es5-string-prototype-chain.js",
      ),
    ).toBe(1);
  });

  it("preserves typed own fields alongside the borrowed method", async () => {
    expect(
      await runStandalone(
        `Factory.prototype.toString = function() { return "abcdef"; };
         var instance = new Factory();
         export function test() {
           return (instance.value === 17 ? 10 : 0) +
             (instance.slice(1, 4) === "bcd" ? 1 : 0);
         }
         function Factory() {
           this.value = 17,
             this.slice = String.prototype.slice;
         }`,
        "es5-string-borrowed-method-typed-field.js",
      ),
    ).toBe(11);
  });
});
