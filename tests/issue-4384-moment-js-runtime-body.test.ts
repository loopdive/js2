// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TMP = resolve(dirname(fileURLToPath(import.meta.url)), "../.tmp/issue-4384-moment-js-runtime-body");

async function instantiate(binary: Uint8Array, imports: unknown): Promise<WebAssembly.Instance> {
  const { instance } = await WebAssembly.instantiate(binary, imports as WebAssembly.Imports);
  (imports as { setInstance?: (instance: WebAssembly.Instance) => void }).setInstance?.(instance);
  return instance;
}

describe("#4384 — explicit JavaScript runtime bodies beside declarations", () => {
  it("executes the explicitly imported .js body instead of its adjacent .d.ts", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "implementation.js"), `module.exports = function implementation() { return 42; };\n`);
    writeFileSync(
      join(TMP, "implementation.d.ts"),
      `declare function declaredOnly(): number; export = declaredOnly;\n`,
    );
    const entry = join(TMP, "entry.ts");
    writeFileSync(
      entry,
      `import implementation from "./implementation.js";\nexport function test(): number { return implementation(); }\n`,
    );

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("keeps __extras_argv valid when an overflow argument adds a late string import", async () => {
    const result = await compile(
      `function count(first: unknown): number { return arguments.length; }\n` +
        `export function test(): number { return count(1, "late import", "third"); }\n`,
      { fileName: "late-extras.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  it("dispatches a captured multi-file callback through apply at its declared arity", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, "apply-factory.js"),
      `module.exports = (function () {
  var callback;
  function hooks() { return callback.apply(null, arguments); }
  function setHook(next) { callback = next; }
  function implementation(a, b, c, d) { return a === undefined ? 42 : 0; }
  setHook(implementation);
  return hooks;
}());\n`,
    );
    writeFileSync(join(TMP, "apply-factory.d.ts"), `declare function hooks(): number; export = hooks;\n`);
    const entry = join(TMP, "apply-entry.ts");
    writeFileSync(
      entry,
      `import moment from "./apply-factory.js";\nexport function test(): number { const value = moment(); return value; }\n`,
    );

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("forwards overflow arguments from a zero-formal wrapper through apply", async () => {
    const result = await compile(
      `const factory = (function () {
  var callback: any;
  function hooks(): number { return callback.apply(null, arguments); }
  function implementation(a: number, b: number, c: number): number {
    return a === 7 && b === 8 && c === 9 && arguments.length === 3 ? 42 : 0;
  }
  callback = implementation;
  return hooks;
}());
export function test(): number { return factory(7, 8, 9); }
`,
      { fileName: "zero-formal-apply-overflow.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("preserves overflow arguments on a zero-formal returned closure", async () => {
    const result = await compile(
      `const factory = (function () {
  function hooks(): number { return arguments.length; }
  return hooks;
}());
export function test(): number { return factory(7, 8, 9); }
`,
      { fileName: "zero-formal-overflow-length.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  it("returns undefined for an out-of-bounds dynamic native-array read", async () => {
    const result = await compile(
      `function read(values: any, index: number): any { return values[index]; }
export function test(): number { return read([1], 3) === undefined ? 42 : 0; }
`,
      { fileName: "dynamic-array-oob.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("invokes a four-argument callback selected through a runtime object key", async () => {
    const result = await compile(
      `var callbacks = {};
function register(key, callback) { callbacks[key] = callback; }
function invoke(key, a, b, c, d) { return callbacks[key](a, b, c, d); }
register("token", function (a, b, c, d) { return a + b + c + d; });
function driver() {
  var callbacks = ["shadow"];
  return invoke("token", 10, 11, 12, 9);
}
export function test() { return driver(); }
`,
      { fileName: "runtime-key-four-argument-callback.js", allowJs: true, skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("hoists forward sibling declarations inside a function expression", async () => {
    const result = await compile(
      `const factory = function (): number {
  const answer = 42;
  function first(): number { return second(); }
  function second(): number { return third(); }
  function third(): number { return answer; }
  return first();
};
export function test() { return factory(); }
`,
      { fileName: "forward-sibling-in-closure.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("materializes a hoisted sibling before another closure captures its value", async () => {
    const result = await compile(
      `const factory = (function () {
  const offset = 1;
  function helper(value: number): number { return value + offset; }
  function wrapper(): number {
    const selected = helper;
    return selected(41);
  }
  return wrapper;
}());
export function test(): number { return factory(); }
`,
      { fileName: "captured-hoisted-function-value.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("lets an any-typed local callable shadow a capturing sibling name", async () => {
    const result = await compile(
      `const factory = function (): number {
  const captured = 41;
  function format(): number { return captured; }
  function invoke(callback: any): number {
    var format = callback;
    return format();
  }
  return invoke(function (): number { return 42; });
};
export function test(): number { return factory(); }
`,
      { fileName: "local-callable-shadow.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("captures an outer local even when a sibling function has the same name", async () => {
    const result = await compile(
      `const factory = function (): number {
  function locale(): number { return 1; }
  function invoke(locale: any): number {
    function inner(): number { return locale(); }
    return inner();
  }
  return invoke(function (): number { return 42; });
};
export function test(): number { return factory(); }
`,
      { fileName: "captured-local-shadows-function.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("keeps an eagerly boxed callable initializer's cell type stable", async () => {
    const result = await compile(
      `const factory = function (): number {
  var callback = function (_value: number): number { return 1; };
  function setCallback(next: any): void { callback = next; }
  function invoke(): number { return callback(0); }
  setCallback(function (_value: number): number { return 42; });
  return invoke();
};
export function test(): number { return factory(); }
`,
      { fileName: "boxed-callable-initializer.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("keeps aliased function-constructor prototype methods in host mode", async () => {
    const result = await compile(
      `const factory = (function () {
  function Thing() { if (!this.isValid()) throw new Error("isValid is not a function"); }
  function isValid() { return true; }
  var proto = Thing.prototype;
  proto.isValid = isValid;
  return function () { return new Thing().isValid() ? 42 : 0; };
}());
export function test() { return factory(); }
`,
      { fileName: "aliased-fnctor-prototype.js", allowJs: true, skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("fills multi-source fnctor drivers before constructor-time prototype calls", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, "locale.js"),
      `function Locale(config) { if (config != null) this.set(config); }
function set(config) { this._config = config; this._week = config.week; }
var proto = Locale.prototype;
proto.set = set;
const value = new Locale({ week: { dow: 7 } });
export function readDow() { return value._week.dow; }
`,
    );
    const entry = join(TMP, "locale-entry.ts");
    writeFileSync(
      entry,
      `import { readDow } from "./locale.js";\nexport function test(): number { return readDow(); }\n`,
    );

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.test as () => number)()).toBe(7);
  });

  it("recognizes both native and host-owned Date instances in an any-typed parameter", async () => {
    const result = await compile(
      `function isDate(value: any): number { return value instanceof Date ? 1 : 0; }\n` +
        `export function nativeDate(): number { return isDate(new Date()); }\n` +
        `export function externalDate(value: any): number { return isDate(value); }\n`,
      { fileName: "date-brand.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect((instance.exports.nativeDate as () => number)()).toBe(1);
    expect((instance.exports.externalDate as (value: unknown) => number)(new Date())).toBe(1);
    expect((instance.exports.externalDate as (value: unknown) => number)({})).toBe(0);
  });

  it("keeps a Date.now function expression callable through an object property", async () => {
    const result = await compile(
      `const factory = (function () {
  const hooks: any = function () {};
  const now = function (): number { return Date.now ? Date.now() : +new Date(); };
  hooks.now = now;
  return function (): number { return new Date(hooks.now()).getTime(); };
}());
export function test(): number { return factory(); }
export function direct(): number { return Date.now(); }
export function conditional(): number { return Date.now ? Date.now() : +new Date(); }
`,
      { fileName: "date-now-property-closure.ts", target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = await instantiate(result.binary, imports);
    expect(Number.isFinite((instance.exports.direct as () => number)())).toBe(true);
    expect(Number.isFinite((instance.exports.conditional as () => number)())).toBe(true);
    expect(Number.isFinite((instance.exports.test as () => number)())).toBe(true);
  });
});
