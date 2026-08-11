// #1031 / callback-frame regression: a user function name must not shadow a
// lexical callback capture. This is the reduced shape from lodash's
// `stringToPath` helper (`lodash.js:6835`): the outer function owns an array
// named `result`, while the module also contains a user function named
// `result`. The callback must capture the array and mutate it through the
// host callback bridge.

import assert from "node:assert/strict";

import { compile } from "../../src/index.ts";
import { buildImports } from "../../src/runtime.ts";

const source = `
function result() {}

export function test() {
  var result = [];
  "ab".replace(/./g, function (match) {
    result.push(match);
  });
  return result.join("|");
}
`;

function nativeTest() {
  var result = [];
  "ab".replace(/./g, function (match) {
    result.push(match);
  });
  return result.join("|");
}

const compiled = await compile(source, {
  fileName: "lodash-callback-frame-regression.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
});
if (!compiled.success) {
  throw new Error(compiled.errors.map((error) => error.message).join("\n"));
}

const module = await WebAssembly.compile(compiled.binary);
const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
const instance = await WebAssembly.instantiate(module, imports);
imports.setExports?.(instance.exports);

const native = nativeTest();
const wasm = instance.exports.test();
assert.equal(wasm, native);
console.log(JSON.stringify({ native, wasm }));
