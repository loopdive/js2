// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6711 — with no runtime-eval provider linked (`runtimeEvalProvider: false`,
 * the zero-import npm-compat standalone lanes), a module that contains a
 * runtime-eval site (lodash's `Function('return this')()` realm idiom) left
 * `globalThis.Function` / `.TypeError` / `.Date` / `.RegExp` / `.String` /
 * `.Error` undefined: the realm-object constructor seed was gated off for every
 * "runtime-eval module", although without a provider the eval boundary builds
 * no carriers. lodash's `runInContext` then threw at
 * `var Function = context.Function; Function.prototype` during module init.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const LODASH_CONTEXT_IDIOM = `
var out = 0;
;(function() {
  var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;
  var freeSelf = typeof self == 'object' && self && self.Object === Object && self;
  var root = freeGlobal || freeSelf || Function('return this')();
  var runInContext = (function runInContext(context) {
    context = context == null ? root : context;
    var Array = context.Array, Date = context.Date, Error = context.Error,
        Function = context.Function, Object = context.Object, RegExp = context.RegExp,
        String = context.String, TypeError = context.TypeError;
    if (typeof Array == 'function') out += 1;
    if (typeof Object == 'function') out += 2;
    if (typeof Function == 'function') out += 4;
    if (typeof TypeError == 'function') out += 8;
    if (typeof Date == 'function') out += 16;
    if (typeof RegExp == 'function') out += 32;
    if (typeof String == 'function') out += 64;
    if (typeof Error == 'function') out += 128;
    try { var funcProto = Function.prototype; if (funcProto != null) out += 256; } catch (e) { out += 100000; }
    function lodash() {}
    return lodash;
  });
  var _ = runInContext();
}.call(this));
export function run() {
  return out;
}
`;

async function runStandalone(source: string, options: Record<string, unknown>): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "lodash-context.js",
    emitWat: false,
    ...options,
  } as Parameters<typeof compile>[1]);
  expect(result.success).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  return (instance.exports.run as () => number)();
}

describe("#6711 standalone realm constructors without a runtime-eval provider", () => {
  it("seeds Function/TypeError/Date/RegExp/String/Error on the realm object in a runtime-eval module", async () => {
    expect(await runStandalone(LODASH_CONTEXT_IDIOM, { runtimeEvalProvider: false })).toBe(511);
  });
});
