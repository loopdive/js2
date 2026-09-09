import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([
  [
    "null prototype and later replacement",
    `
    const arr = new Uint8Array(1);
    Object.setPrototypeOf(arr, null);
    if (Object.getPrototypeOf(arr) !== null) return 0;
    const proto = { marker: 9 };
    Object.setPrototypeOf(arr, proto);
    return Object.getPrototypeOf(arr) === proto && arr.marker === 9 ? 1 : 0;
  `,
  ],
  [
    "independent array identities",
    `
    const a = new Uint8Array(1), b = new Uint8Array(1);
    const p = { marker: 7 }, q = { marker: 9 };
    Object.setPrototypeOf(a, p); Object.setPrototypeOf(b, q);
    return a.marker === 7 && b.marker === 9 && Object.getPrototypeOf(a) === p ? 1 : 0;
  `,
  ],
  [
    "own properties shadow inherited properties",
    `
    const arr = new Uint8Array(1);
    arr.marker = 11;
    Object.setPrototypeOf(arr, { marker: 9 });
    return arr.marker === 11 ? 1 : 0;
  `,
  ],
])("preserves %s", async (_name, body) => {
  const result = await compile(`export function run() { ${body} }`, {
    target: "standalone",
    fileName: "vec-prototype.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});

it("refuses cycles and changes to nonextensible arrays", async () => {
  const result = await compile(
    `
    const arr = new Uint8Array(1), p = {}, q = {};
    export function setup() { Object.setPrototypeOf(arr, p); Object.preventExtensions(arr); }
    export function same() { Object.setPrototypeOf(arr, p); return 1; }
    export function change() { Object.setPrototypeOf(arr, q); }
    export function unchanged() { return Object.getPrototypeOf(arr) === p ? 1 : 0; }
    export function cycle() { const a = new Uint8Array(1); Object.setPrototypeOf(a, a); }
  `,
    { target: "standalone", fileName: "vec-prototype-refusal.js", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const run = instance.exports as Record<string, Function>;
  expect(() => run.cycle()).toThrow();
  run.setup();
  expect(run.unchanged(), "after setup").toBe(1);
  expect(run.same()).toBe(1);
  expect(run.unchanged(), "after same prototype").toBe(1);
  expect(() => run.change()).toThrow();
  expect(run.unchanged()).toBe(1);
});
