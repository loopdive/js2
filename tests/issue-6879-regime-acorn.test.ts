// #6879 — the acorn npm-compat row on the native regime
// (`semanticProviders: "native-first"` in a JavaScript environment).
//
// (1) `hasOwn(opts, k)` answered false for every JS object the export
// boundary admitted; (2) `export { parse }` carried no boundary signature, so
// its options object and input string crossed raw; (3) a string over 32K code
// units overflowed the one-page string bridge; (4) a fnctor instance's expando
// (`node.body = []`) was invisible through the JS view of a returned object.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Exports = Record<string, (...args: unknown[]) => any>;

async function regime(source: string): Promise<Exports> {
  const result = await compile(source, {
    fileName: "main.mjs",
    skipSemanticDiagnostics: true,
    semanticProviders: "native-first",
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapCompiledExports(result, instance) as Exports;
}

async function standalone(source: string): Promise<Exports> {
  const result = await compile(source, { fileName: "main.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Exports;
}

const GET_OPTIONS = `
var hasOwn = Object.hasOwn || (function (obj, propName) { return Object.prototype.hasOwnProperty.call(obj, propName); });
var defaults = { a: 1, b: 2 };
export function get(opts) {
  var o = {};
  for (var k in defaults) o[k] = opts && hasOwn(opts, k) ? opts[k] : defaults[k];
  return o.a * 10 + o.b;
}
export function own(opts, k) { return (hasOwn(opts, k) ? 1 : 0) + (Object.prototype.hasOwnProperty.call(opts, k) ? 10 : 0); }
export function probe() { return get({ a: 5 }) * 100 + get(undefined); }
`;

const EXPORT_LIST = `
var Node = function Node(pos) { this.type = ""; this.start = pos; };
function finish(node, type) { node.type = type; return node; }
function parse(input, options) {
  var node = new Node(0);
  node.body = [];
  node.body.push(finish(new Node(1), "Stmt"));
  node.sourceType = options.sourceType;
  node.size = input.length;
  return finish(node, "Program");
}
export { parse };
`;

describe("#6879 acorn on the native regime", () => {
  it("answers own-presence for an admitted JS object (acorn getOptions)", async () => {
    const ex = await regime(GET_OPTIONS);
    expect(ex.get({ a: 5 })).toBe(52);
    expect(ex.get(undefined)).toBe(12);
    expect(ex.own({ a: 1 }, "a")).toBe(11);
    // own, not inherited: `toString` lives on Object.prototype
    expect(ex.own({ a: 1 }, "toString")).toBe(0);
    expect(ex.own({ a: 1 }, "b")).toBe(0);
  });

  it("keeps the standalone answer for the same source", async () => {
    expect((await standalone(GET_OPTIONS)).probe()).toBe(5212);
  });

  it("marshals an `export { name }` function and exposes a returned fnctor's expandos", async () => {
    const ex = await regime(EXPORT_LIST);
    const program = ex.parse("let x = 1;", { ecmaVersion: 2022, sourceType: "module" });
    expect(program.type).toBe("Program");
    expect(program.body.length).toBe(1);
    expect(program.body[0].type).toBe("Stmt");
    expect(program.sourceType).toBe("module");
    expect(program.size).toBe(10);
    expect(program.missing).toBeUndefined();
    expect(Object.keys(program)).toEqual(["type", "start", "body", "sourceType", "size"]);
  });

  it("carries a string longer than the one-page bridge across the boundary", async () => {
    const ex = await regime(EXPORT_LIST);
    const input = "x".repeat(100_000);
    expect(ex.parse(input, { sourceType: "script" }).size).toBe(100_000);
  });
});
