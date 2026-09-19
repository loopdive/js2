import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([
  ["foo", "arr"],
  ["toString", "arr"],
  ["foo", "identity(arr)"],
  ["toString", "identity(arr)"],
])("forwards %s method arguments through apply on %s", async (method, receiver) => {
  const result = await compile(
    `
    function slow(encoding, start, end) {
      if (start !== undefined || end !== undefined) return -2;
      return encoding === 'base64' && this[0] === 104 ? 42 : 0;
    }
    function identity(value) { return value; }
    function Holder() {}
    Holder.prototype.${method} = function ${method}() {
      if (this.length === 0) return -3;
      if (arguments.length === 0) return -1;
      return slow.apply(this, arguments);
    };
    export function run() {
      var arr = new Uint8Array(1); arr[0] = 104;
      Object.setPrototypeOf(arr, Holder.prototype);
      return ${receiver}.${method}('base64') === 42 ? 1 : 0;
    }
  `,
    { target: "standalone", fileName: "prototype-arguments-apply.js", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});

it.each([
  [
    "builtin fallback",
    `
    var arr = new Uint8Array(2); arr[0] = 4; arr[1] = 7;
    return arr.toString() === '4,7' ? 1 : 0;
  `,
  ],
  [
    "getter before arguments",
    `
    var events = 0;
    var arr = new Uint8Array(1); arr[0] = 5;
    var proto = { get toString() {
      events = events * 10 + 1;
      return function (value) { return String(this[0] + value); };
    } };
    Object.setPrototypeOf(arr, proto);
    var value = arr.toString((events = events * 10 + 2, 3));
    return events === 12 && value === '8' ? 1 : 0;
  `,
  ],
  [
    "receiver reassignment in argument",
    `
    var arr = new Uint8Array(1); arr[0] = 5;
    var other = new Uint8Array(1); other[0] = 9;
    Object.setPrototypeOf(arr, { toString: function (value) { return String(this[0] + value); } });
    var value = arr.toString((arr = other, 3));
    return value === '8' && arr[0] === 9 ? 1 : 0;
  `,
  ],
])("keeps %s", async (_name, body) => {
  const result = await compile(`export function run() { ${body} }`, {
    target: "standalone",
    fileName: "prototype-toString-order.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as Function)()).toBe(1);
});
