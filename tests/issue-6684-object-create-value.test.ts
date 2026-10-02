// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6684 — `Object.create` read as a VALUE under `--target standalone`
// (lodash-es `_baseCreate`: `var objectCreate = Object.create; …
// objectCreate(proto)`). The value used to be the generic two-slot refusal
// closure; the one-argument call site failed its closure cast and threw
// "Cannot access property on null or undefined" at lodash-es module init.
//
// Every observable is compared against Node running the same source.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

const SRC = `
function Base() {}
Base.prototype.a = 3;
var objectCreate = Object.create;
var baseCreate = (function () {
  function object() {}
  return function (proto) {
    if (proto == null) return {};
    if (objectCreate) {
      return objectCreate(proto);
    }
    object.prototype = proto;
    var result = new object();
    object.prototype = undefined;
    return result;
  };
}());
function kind(f) { try { f(); return 0; } catch (e) { return e instanceof TypeError ? 7 : 9; } }
export function run() {
  var r = 0;
  var o = baseCreate(Base.prototype);
  r = r * 10 + (o.a === 3 ? 1 : 0);
  r = r * 10 + (Object.getPrototypeOf(o) === Base.prototype ? 1 : 0);
  r = r * 10 + (Object.getPrototypeOf(objectCreate(null)) === null ? 1 : 0);
  r = r * 10 + kind(function () { objectCreate(5); });
  r = r * 10 + kind(function () { objectCreate(undefined); });
  return r;
}
`;

describe("#6684 — Object.create as a value (standalone)", () => {
  it("creates from a prototype object and null, and throws TypeError for a primitive", async () => {
    const expected = (
      new Function(SRC.replace("export function run", "return function run")) as () => () => number
    )()();
    expect(expected).toBe(11_177);
    const result = await compileMulti({ "./main.js": SRC }, "./main.js", {
      target: "standalone",
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    expect((instance.exports.run as () => number)()).toBe(expected);
  });
});
