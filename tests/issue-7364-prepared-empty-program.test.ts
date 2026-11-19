// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7364 — a script with no executable top-level code is a valid program: it compiles through the strict Prepared
// entry and runs. An empty script (no terminal unit) presents as a module without functions; a script of bare
// declarations (`var x;`) owns a module-init unit that its startup never invokes.
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

describe("#7364 — Prepared programs without executable top-level code", () => {
  it.each([
    ["an empty file", ""],
    ["a comment only", "/* c */\n// d"],
    ["a directive only", '"use strict";'],
    ["an empty statement", ";"],
    ["a bare var", "var x;"],
    ["a bare var list", "var x, y;"],
    ["a function declaration only", "function f() { return 1; }"],
  ])("compiles and runs %s", async (_label, source) => {
    const result = await compile(source, options());
    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(requiredPreparedEmission(result)).toBeDefined();
    const { instance } = instantiatePreparedArtifact(result);
    expect(() => (instance.exports.__module_init as (() => void) | undefined)?.()).not.toThrow();
  });

  // The program's own check runs with node's answer (returns) and with a wrong one (throws).
  it.each([
    ["x !== undefined", "returned"],
    ["x === undefined", "threw"],
  ])("still runs the code beside a bare var: if (%s) throw 1", async (test, outcome) => {
    const result = await compile(`var x;\nif (${test}) throw 1;`, options());
    expect(result.errors.map((error) => error.message)).toEqual([]);
    let ran = "returned";
    try {
      const { instance } = instantiatePreparedArtifact(result);
      (instance.exports.__module_init as (() => void) | undefined)?.();
    } catch {
      ran = "threw";
    }
    expect(ran).toBe(outcome);
  });
});
