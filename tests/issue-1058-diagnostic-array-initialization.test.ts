// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["plain", "direct-return", "local-return"])(
  "initializes an unset diagnostic array through nested fields (%s)",
  async (shape) => {
    const result = await compile(
      `interface Node { kind: number; }
    interface Diagnostic { file: Source; start: number; }
    interface Source extends Node { bindDiagnostics: Diagnostic[]; }
    function base(): Node { ${shape === "local-return" ? "const node = {kind: 308}; return node;" : "return {kind: 308};"} }
    function factory(): Source {
      const node = ${shape !== "plain" ? "base() as Source" : "{kind: 308, bindDiagnostics: undefined!} as Source"};
      node.bindDiagnostics = undefined!;
      return node;
    }
    function parse(): Source {
      const file = factory();
      setFields(file);
      return file;
      function setFields(source: Source): void { source.bindDiagnostics = []; }
    }
    export function run(): number {
      const file = parse();
      if (file.kind !== 308) return -1;
      if (file.bindDiagnostics === undefined) return -2;
      file.bindDiagnostics.push({file, start: 4});
      if (file.bindDiagnostics.length !== 1) return -3;
      if (file.bindDiagnostics[0].file !== file) return -4;
      return file.bindDiagnostics[0].start;
    }`,
      { target: "standalone" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    expect((instance.exports.run as () => number)()).toBe(4);
  },
);

it.each([false, true])(
  "preserves a diagnostic vector through a base node's dynamic property store (overwrite=%s)",
  async (overwrite) => {
    const result = await compile(
      `interface Node { kind: number; }
    interface Diagnostic { start: number; }
    function base(): Node { return {kind: 308}; }
    export function run(): number {
      const node = base();
      const dynamic: any = node;
      const original: Diagnostic[] = [];
      ${overwrite ? 'dynamic.bindDiagnostics = undefined; dynamic.text = "input"; dynamic.fileName = "input.ts"; dynamic.parseDiagnostics = [];' : ""}
      dynamic.bindDiagnostics = original;
      const diagnostics: Diagnostic[] = dynamic.bindDiagnostics;
      if (diagnostics !== original) return -1;
      diagnostics.push({start: 4});
      if (original.length !== 1) return -2;
      return original[0].start;
    }`,
      { target: "standalone" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    expect((instance.exports.run as () => number)()).toBe(4);
  },
);
