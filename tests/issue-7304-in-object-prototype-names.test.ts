// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7304 — `key in receiver` at a prototype-walk miss whose terminal is the
// implicit %Object.prototype%: the native `__extern_has` answers that
// prototype's own names (`"toString" in {}` is true) for a receiver with a
// known `$Object` root or a builtin carrier (function, Error, …), on standalone
// and WASI. A null-prototype receiver stays false. Each case is checked against node, with a literal key (through
// the IR's native `in`) and a dynamic key.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
];
const wasiStub = new Proxy({}, { get: () => () => 0 });

const RECEIVERS: Record<string, string> = {
  "an empty object": "({})",
  "a Number wrapper": "Object(1)",
  "a String wrapper": "Object('s')",
  "a Boolean wrapper": "Object(true)",
  "a function": "(function () {})",
  "an arrow": "(() => 1)",
  "an Error": "new Error('m')",
  // The two receivers whose null prototype the terminal must see (RV7142).
  "an object after setPrototypeOf(null)":
    "(function () { var q = { x: 1 }; Object.setPrototypeOf(q, null); return q; })()",
  "an instance of a constructor whose prototype is Object.create(null)":
    "(function () { function G() { this.x = 1; } G.prototype = Object.create(null); return new G(); })()",
  "Object.create(null)": "Object.create(null)",
};
// WASI's constructor instances carry no `$Object` root yet, so they keep the
// base answer there (documented in the PR); standalone answers the names.
const STANDALONE_ONLY: Record<string, string> = {
  "a constructor instance": "(function () { function F() { this.x = 1; } return new F(); })()",
};
const KEYS = ["toString", "hasOwnProperty", "valueOf", "constructor", "x"];

function program(receiver: string, key: string, literal: boolean): string {
  const test = literal ? `${JSON.stringify(key)} in p` : "k in p";
  return `function h(p, k) { return ${test}; }
export function test() { return h(${receiver}, ${JSON.stringify(key)}) ? 1 : 0; }
`;
}

async function run(source: string, options: CompileOptions): Promise<number> {
  const result = await compile(source, { fileName: "issue-7304.js", ...options });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = options.target === "wasi" ? { wasi_snapshot_preview1: wasiStub } : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  return exports.test!();
}

describe("#7304 `in` sees the implicit Object.prototype terminal's names", () => {
  for (const lane of LANES)
    for (const [label, receiver] of Object.entries({
      ...RECEIVERS,
      ...(lane.options.target === "standalone" ? STANDALONE_ONLY : {}),
    }))
      for (const literal of [true, false])
        it(`${label}, ${literal ? "literal" : "dynamic"} key (${lane.name})`, async () => {
          for (const key of KEYS) {
            const source = program(receiver, key, literal);
            const node = new Function(`${source.replace("export function", "function")}return test();`)();
            expect(await run(source, lane.options), key).toBe(node);
          }
        });
});

describe("#7304 a deleted Object.prototype member is not answered", () => {
  for (const removal of ["delete Object.prototype.toString;", "Reflect.deleteProperty(Object.prototype, 'toString');"])
    it(`${removal} (standalone)`, async () => {
      const source = `${removal}
function h(p, k) { return k in p; }
export function test() { return (h({}, "toString") ? 1 : 0) * 10 + (h({}, "valueOf") ? 1 : 0); }
`;
      const node = new Function(`${source.replace("export function", "function")}return test();`)();
      expect(await run(source, { target: "standalone" })).toBe(node);
    });
});
