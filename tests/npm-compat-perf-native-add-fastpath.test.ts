// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// npm-compat standalone perf regressions from the native-first addition lanes:
// `input.length + 1` over an untyped param inferred as a native string, and a
// concat chain with `seed % 7` / an i32 loop counter, were both routed through
// the generic ToPrimitive addition (react static ~35x, react dynamic ~3.6x,
// clsx dynamic ~1.35x slower).
import { expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { isPrimitiveConcatProducer } from "../src/codegen/native-addition.js";
// (#6768) These cases inspect the emitted body of a function that is dead in
// the test program (never called, or inlined away); the standalone reachability
// sweep would stub it to `unreachable`.
process.env.JS2WASM_FUNC_SWEEP = "0";

async function compileStandalone(source: string, fn: string) {
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
    emitWat: true,
    emitWatOnlyFunctions: [fn],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  // Only the requested function's body: the module header legitimately mentions externref.
  const wat = (result.wat ?? "").slice((result.wat ?? "").indexOf(`(func $${fn} `));
  expect(wat.startsWith(`(func $${fn} `)).toBe(true);
  return { wat, exports: instance.exports as Record<string, (...args: number[]) => number> };
}

it("numeric addition over an inferred native string length stays f64", async () => {
  const { wat, exports } = await compileStandalone(
    `const s = "hello"; const o = { a: 1 };
     function apply(input) { return Number(o ? input.length + 1 : input.length); }
     export function bench(n) { let c = 0; for (let i = 0; i < n; i++) c += apply(s); return c; }`,
    "apply",
  );
  expect(wat).toContain("f64.add");
  expect(wat).not.toContain("externref");
  expect(exports.bench(3)).toBe(18);
});

it("concat over numeric slots and `%` keeps native batching", async () => {
  const { wat, exports } = await compileStandalone(
    `const prefix = "hello";
     export function bench(iterations, seed) {
       let c = 0;
       for (let index = 0; index < iterations; index += 1) {
         const input = prefix + "-" + (seed % 7) + "-" + index;
         c += input.length;
       }
       return c;
     }`,
    "bench",
  );
  expect(wat).not.toContain("externref");
  let expected = 0;
  for (let index = 0; index < 12; index += 1) expected += `hello-${9 % 7}-${index}`.length;
  expect(exports.bench(12, 9)).toBe(expected);
});

it("object operands of `%` are converted at the operator, not by the concat", async () => {
  const { exports } = await compileStandalone(
    `export function run() {
       let trace = 0;
       const value = { valueOf() { trace = trace * 10 + 1; return 10; }, toString() { trace = trace * 10 + 9; return "x"; } };
       const text = "v" + (value % 7) + (trace = trace * 10 + 2);
       return text === "v312" && trace === 12 ? 1 : 0;
     }`,
    "run",
  );
  expect(exports.run()).toBe(1);
});

it.each([
  ["seed % 7", true],
  ["value * 2", true],
  ["value >>> other", true],
  ["+value", true],
  ["value - other", false],
  ["1n * value", false],
  ["-value", false],
  ["~value", false],
] as const)("primitive batching proof for %s is %s", (expression, admitted) => {
  const source = ts.createSourceFile("producer.ts", `const probe = (${expression});`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0] as ts.VariableStatement;
  expect(isPrimitiveConcatProducer(statement.declarationList.declarations[0]!.initializer!)).toBe(admitted);
});

it("JS-host arguments.length reads the vec length without a host array copy", async () => {
  const result = await compile(
    `function count() { var n = arguments.length; return n; }
     export function run(a, b) { return count(a, b, a) + count(); }`,
    { fileName: "args.mjs", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.name);
  expect(imports).not.toContain("__make_iterable");
  const importObject = (result.importObject ?? {}) as WebAssembly.Imports & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  expect((instance.exports.run as (a: number, b: number) => number)(1, 2)).toBe(3);
});
