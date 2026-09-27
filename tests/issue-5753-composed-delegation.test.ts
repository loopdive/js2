// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";

it("preserves protocol return identity after an array delegate inside finally", async () => {
  const source = `
    export function run(): number {
      var closed = 0, calls = 0;
      var raw = { value: 8, done: false };
      var iterator = {
        next: function() { calls++; return { value: 3, done: calls > 1 }; },
        return: function(value) { return raw; }
      };
      var iterable = {};
      iterable[Symbol.iterator] = function() { return iterator; };
      function* mixed() {
        try { yield* [1]; yield* iterable; }
        finally { closed++; }
        return 0;
      }
      var gen = mixed();
      if (gen.next().value !== 1 || gen.next().value !== 3) return -1;
      var returned = gen.return(9);
      if (returned !== raw || returned.done !== false || closed !== 0) return -2;
      if (gen.next().done !== true || closed !== 1) return -3;
      return 1;
    }
  `;
  const native = { exports: {} as Record<string, () => number> };
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", js)(native.exports);
  expect(native.exports.run!()).toBe(1);
  const result = await compile(source, { target: "standalone" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect((new WebAssembly.Instance(module, {}).exports.run as () => number)()).toBe(1);
});
