// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6704 — a callable property whose value is callable but is NOT a
// funcref-wrapper struct (`--target standalone`). `ns.words(x)` guarded-cast it
// to the wrapper root, got null, passed the nullish check (the raw value is not
// nullish) and trapped on `struct.get` ("dereferencing a null pointer"). The
// lodash-es standalone-dynamic checksum hit this with `words` read back through
// the runtime-eval module scope (the graph contains `Function(params, body)`);
// a bound function is the same shape with a much lighter compile. It is now
// applied through `__apply_closure`.

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

describe("#6704 — callable property holding a non-wrapper callable (standalone)", () => {
  it("a bound function (not a wrapper struct) is applied instead of trapping", async () => {
    const lib = `
/**
 * @param {string} [string=''] The string to split.
 * @returns {Array}
 */
function words(string) { return (string + '').split(' '); }
export default words;
`;
    const main = `
import words from "./lib.js";
const ns = { words: words.bind(null) };
export function run() {
  return ns.words("ab cd ef").length * 10 + words("x y").length;
}`;
    expect(await runStandalone(lib, main)).toBe(32);
  });
});
