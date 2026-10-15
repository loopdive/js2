// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6983 — acorn on the native-first lane trapped with "illegal cast" on its
// SECOND `parse`: the `__extern_get` prototype-cache arm (populated by the first
// call) consults `__closure_bag_lookup` on every receiver, and the lookup's
// registry walk `ref.cast eq`-ed a HOST options object, which is not `eq`.
import { describe, expect, it } from "vitest";
import { compile, wrapCompiledExports } from "../src/index.js";

const OPTIONS_READER = `
var defaultOptions = { ecmaVersion: 2020, sourceType: "script", locations: false };
var hasOwn = function (obj, propName) { return Object.prototype.hasOwnProperty.call(obj, propName); };
function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions) {
    options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt];
  }
  return options;
}
function Parser(options) { this.options = getOptions(options); this.pos = 0; }
Parser.prototype.version = function () { return this.options.ecmaVersion; };
Parser.prototype.locations = function () { return this.options.locations; };
export function parse(opts) {
  var p = new Parser(opts);
  return p.version() + (p.locations() ? 1 : 0);
}
`;

async function instantiate(source: string, options: Record<string, unknown>) {
  const result = await compile(source, {
    fileName: "m.mjs",
    skipSemanticDiagnostics: true,
    ...options,
  } as never);
  expect(result.success, result.errors?.[0]?.message).toBe(true);
  const importObject = (result.importObject ?? {}) as WebAssembly.Imports & {
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  return { result, instance };
}

describe("#6983 closure-bag lookup on a host receiver", () => {
  it("native-first: repeated calls with a host options object read through the proto cache", async () => {
    const { result, instance } = await instantiate(OPTIONS_READER, {
      semanticProviders: "native-first",
    });
    const exp = wrapCompiledExports(result as never, instance) as {
      parse(o: object): number;
    };
    for (let i = 0; i < 3; i++) {
      expect(exp.parse({ ecmaVersion: 2022, sourceType: "module" })).toBe(2022);
      expect(exp.parse({ locations: true })).toBe(2021);
    }
  });

  it("standalone: the same reader over module-owned options still runs", async () => {
    const source = `${OPTIONS_READER}
export function run() {
  var total = 0;
  for (var i = 0; i < 3; i++) total += parse({ ecmaVersion: 2022, sourceType: "module" }) + parse({ locations: true });
  return total;
}`;
    const { instance } = await instantiate(source, { target: "standalone" });
    expect((instance.exports.run as () => number)()).toBe(3 * (2022 + 2021));
  });
});
