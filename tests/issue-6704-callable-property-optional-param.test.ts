// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6704 — `ns.f(x)` must reach the callee's real funcref when a JSDoc
// optional-with-default parameter lowers to `externref` in the compiled body
// (`--target standalone`). The property's TypeScript signature gives the call
// site a native-string argument; the dispatch ladder had no ref → externref
// crossing on the no-host lanes, so the callee's funcref was never admitted
// and the call threw (lodash-es `__pkgNs.words(input)` → null → trap).
// The other #6704 mechanisms: issue-6704-callable-property-apply-fallback.test.ts
// (`Function`-typed field) and issue-6704-callable-property-non-wrapper-value.test.ts.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

async function runStandalone(lib: string, main: string): Promise<number> {
  const result = await compileMulti({ "./lib.js": lib, "./main.js": main }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

const WORDS = `
var re = /[a-z]+/gi;
/**
 * @param {string} [string=''] The string to inspect.
 * @param {RegExp|string} [pattern]
 * @param- {Object} [guard]
 * @returns {Array}
 */
function words(string, pattern, guard) {
  string = string + '';
  pattern = guard ? undefined : pattern;
  if (pattern === undefined) return string.match(re) || [];
  return string.match(pattern) || [];
}
export default words;
`;

const LEN = `
/**
 * @param {string} [s=''] The string.
 * @returns {number}
 */
function len(s) {
  s = s + '';
  return s.length;
}
export default len;
`;

describe("#6704 — callable property reaches an externref-param callee (standalone)", () => {
  it("ns.words(x) answers the lodash-shaped words count", async () => {
    const main = `
import words from "./lib.js";
const ns = { words };
export function run() {
  try {
    var a = ns.words("a b c").length;
    var b = ns.words().length;
    var d = ns.words("ab cd", /c/g).length;
    var e = ns.words("x y", "y", 1).length;
    return a * 1000 + b * 100 + d * 10 + e;
  } catch (e) { return -1; }
}`;
    // Node: 3, 1 ("undefined"), 1, 2.
    expect(await runStandalone(WORDS, main)).toBe(3112);
  });

  it("a padded optional string argument reaches the callee as undefined, not null", async () => {
    const main = `
import len from "./lib.js";
const ns = { len };
export function run() {
  try { return ns.len("abc") * 100 + ns.len(); } catch (e) { return -1; }
}`;
    // "undefined".length === 9 ("null" would be 4).
    expect(await runStandalone(LEN, main)).toBe(309);
  });
});
