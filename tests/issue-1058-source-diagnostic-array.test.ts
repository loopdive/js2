// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([false, true])("pushes a diagnostic onto a source node (constructor=%s)", async (useConstructor) => {
  const result = await compile(
    `interface Node { kind: number; }
    interface Diagnostic { start: number | undefined; messageText: string | { messageText: string }; }
    interface LocatedDiagnostic extends Diagnostic { start: number; file: Source; }
    interface Source extends Node { bindDiagnostics: LocatedDiagnostic[]; }
    function Node(this: Node, kind: number): void { this.kind = kind; }
    function createSource(): Source {
      const source: Source = ${useConstructor ? "new (Node as any)(308) as Source" : "{ kind: 308, bindDiagnostics: [] }"};
      source.bindDiagnostics = [];
      return source;
    }
    function createDiagnostic(file: Source): LocatedDiagnostic {
      return { file, start: 4, messageText: "duplicate x" };
    }
    export function run(): number {
      const source = createSource();
      if (source.kind !== 308) return -4;
      source.bindDiagnostics.push(createDiagnostic(source));
      if (source.bindDiagnostics.length !== 1) return -1;
      if (source.bindDiagnostics[0].file !== source) return -2;
      if (source.bindDiagnostics[0].messageText !== "duplicate x") return -3;
      return source.bindDiagnostics[0].start;
    }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(4);
});
