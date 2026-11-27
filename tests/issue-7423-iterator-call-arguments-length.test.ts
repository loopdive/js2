// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7423 — the iterator protocol calls a class iterator's `next()` / `return()` with NO arguments. The `__call_next` /
// `__call_return` dispatchers pad the declared formals, so a method reading `arguments` saw `arguments.length === 1`.
// They now publish the real count (0) in `__argc`. Each probe encodes `arguments.length * 10 + kind(arguments[0])`,
// kind = 1 for undefined; node's answer is 1 in every row.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.js", allowJs: true });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  const imports =
    target === "gc"
      ? buildImports(result.imports, undefined, result.stringPool)
      : target === "wasi"
        ? { wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) }
        : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.main as () => unknown)();
}

const ITERATOR = `
function kind(v) { return v === undefined ? 1 : v === null ? 2 : 3; }
class It {
  constructor() { this.i = 0; this.nl = 9; this.rl = 9; }
  [Symbol.iterator]() { return this; }
  next(x) { this.nl = arguments.length * 10 + kind(x); this.i++; return { value: this.i, done: this.i > 2 }; }
  return(x) { this.rl = arguments.length * 10 + kind(x); return { value: undefined, done: true }; }
}
`;

const cases: [string, string][] = [
  ["for-of next()", "export function main() { const it = new It(); for (const v of it) {} return it.nl; }"],
  ["spread next()", "export function main() { const it = new It(); const a = [...it]; return it.nl; }"],
  ["Array.from next()", "export function main() { const it = new It(); Array.from(it); return it.nl; }"],
  [
    "for-of break return()",
    "export function main() { const it = new It(); for (const v of it) { break; } return it.rl; }",
  ],
];

const node = (source: string): unknown => new Function(`${source.replace(/export /g, "")}; return main();`)();

describe("#7423 arguments.length in protocol calls to a class iterator", () => {
  it.each(cases)("%s", async (_, body) => {
    const source = ITERATOR + body;
    const expected = node(source);
    expect(expected).toBe(1);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});

// Review RV7465: a `next()` that reads `arguments` and returns externref. The dispatcher boxes the call's result right
// after the call, so nothing may follow the call (an `__argc` reset there made the module invalid on all targets).
const EXTERNREF_NEXT = `
var log = [];
class S {
  constructor() { this.i = 0; }
  [Symbol.iterator]() { return this; }
  next(x) {
    log.push(arguments.length);
    this.i++;
    return this.i > 2 ? JSON.parse('{"done":true}') : JSON.parse('{"value":1,"done":false}');
  }
}
export function main() { for (const v of new S()) {} return Number("9" + log.join("")); }
`;

describe("#7423 a protocol method returning externref", () => {
  it("for-of over next() that reads arguments", async () => {
    const expected = node(EXTERNREF_NEXT);
    expect(expected).toBe(9000);
    for (const target of TARGETS) expect(await run(EXTERNREF_NEXT, target), target).toBe(expected);
  });
});
