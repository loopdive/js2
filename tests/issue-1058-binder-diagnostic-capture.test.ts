// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([false, true])("keeps the binder's file cell through diagnostic callbacks (nested=%s)", async (nested) => {
  const result = await compile(
    `interface Source { kind: number; bindDiagnostics: Diagnostic[]; }
    interface Diagnostic { file: Source; start: number; messageText: string; }
    function forEach<T, U>(array: readonly T[] | undefined, callback: (value: T, index: number) => U): U | undefined {
      if (array) for (let i = 0; i < array.length; i++) {
        const result = callback(array[i], i);
        if (result) return result;
      }
    }
    function createDiagnostic(file: Source, start: number): Diagnostic {
      return {file, start, messageText: "duplicate"};
    }
    function createBinder() {
      var file: Source;
      return bind;
      function diagnostic(start: number): Diagnostic { return createDiagnostic(file, start); }
      function declareSymbol(): void {
        forEach([4], start => {
          const diag = diagnostic(start);
          file.bindDiagnostics.push(diag);
        });
        const diag = diagnostic(9);
        file.bindDiagnostics.push(diag);
      }
      function bind(source: Source): void {
        file = source;
        ${nested ? "forEach([1], () => declareSymbol());" : "declareSymbol();"}
        file = undefined!;
      }
    }
    const bind = createBinder();
    export function run(): number {
      const first: Source = {kind: 308, bindDiagnostics: []};
      const second: Source = {kind: 309, bindDiagnostics: []};
      bind(first);
      bind(second);
      if (first.bindDiagnostics.length !== 2 || second.bindDiagnostics.length !== 2) return -1;
      if (first.bindDiagnostics[0].file !== first || second.bindDiagnostics[1].file !== second) return -2;
      if (first.bindDiagnostics[0].start !== 4 || second.bindDiagnostics[1].start !== 9) return -3;
      return 1;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
