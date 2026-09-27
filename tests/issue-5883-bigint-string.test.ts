// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
const cases: [string, string][] = [
  ["wide positive literal", 'return String(18446744073709551617n) === "18446744073709551617" ? 1 : -1;'],
  ["wide negative literal", 'return String(-18446744073709551617n) === "-18446744073709551617" ? 1 : -1;'],
  ["wide unsigned64 edge", 'return String(18446744073709551615n) === "18446744073709551615" ? 1 : -1;'],
  ["wide constant expression", 'return String(18446744073709551616n + 3n) === "18446744073709551619" ? 1 : -1;'],
  ["narrow bigint", 'return String(7n) === "7" && String(-7n) === "-7" && String(0n) === "0" ? 1 : -1;'],
  ["exact signed64 edge", 'return String(9223372036854775807n) === "9223372036854775807" ? 1 : -1;'],
  ["number controls", 'return String(1.5) === "1.5" && String(-0) === "0" && String(NaN) === "NaN" ? 1 : -1;'],
  ["symbol control", 'return String(Symbol("x")) === "Symbol(x)" ? 1 : -1;'],
  [
    "boolean nullish and string controls",
    'return String(true) === "true" && String(false) === "false" && String(null) === "null" && String(undefined) === "undefined" && String("ok") === "ok" ? 1 : -1;',
  ],
  [
    "string hint and single evaluation",
    'let evaluations=0;let reads=0;let hint;function source(){evaluations++;return {[Symbol.toPrimitive]:function(h){reads++;hint=h;return 7n;}};}const result=String(source());return result==="7" && evaluations===1 && reads===1 && hint==="string" ? 1 : -1;',
  ],
  [
    "throwing conversion preserved",
    "const reason={};const source={[Symbol.toPrimitive]:function(){throw reason;}};try{String(source);return -1;}catch(e){return e===reason?1:-2;}",
  ],
  [
    "argument side effect once",
    'let count=0;const result=String((count++,18446744073709551617n));return count===1 && result==="18446744073709551617" ? 1 : -1;',
  ],
  [
    "ordinary conversion preference",
    'let trace=0;const source={toString:function(){trace=trace*10+1;return "ok";},valueOf:function(){trace=trace*10+2;return 7n;}};return String(source)==="ok" && trace===1 ? 1 : -1;',
  ],
];
for (const [name, body] of cases) {
  it(name, async () => {
    const source = `export function test() { ${body} }`;
    const sha256 = createHash("sha256").update(source).digest("hex");
    const native = runInNewContext(`(function () { ${body} })()`, {}, { timeout: 5000 });
    const result = await compile(source, {
      fileName: "5883-bigint-string.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      nativeStrings: true,
    });
    console.log(JSON.stringify({ name, source, sha256, native, success: result.success, errors: result.errors }));
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    const imports = WebAssembly.Module.imports(module);
    expect(imports).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const actual = (instance.exports.test as () => number)();
    console.log(JSON.stringify({ name, source, sha256, native, actual, imports }));
    expect(native).toBe(1);
    expect(actual).toBe(1);
  });
}
