// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5213 — an instance accessor named `prototype` is a property of C.prototype;
// it is not the constructor's own C.prototype data property. The two generated
// Test262 rows below are the source-level pins. The focused controls keep the
// descriptor, declaration/expression, setter, static-name, and receiver
// invariants close to the implementation.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_ROWS = [
  "language/expressions/class/elements/syntax/valid/grammar-special-prototype-accessor-meth-valid.js",
  "language/statements/class/elements/syntax/valid/grammar-special-prototype-accessor-meth-valid.js",
] as const;

async function runStandalone(source: string, exportName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-5213-es2015-class-prototype-accessor.js",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "prototype accessor controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

function runHostMatrix(source: string): Record<string, () => unknown> {
  const hostSource = source.replace(/\bexport\s+/g, "");
  return new Function(`${hostSource}\nreturn { testDecl, testExpr, testReceiver };`)() as Record<string, () => unknown>;
}

describe("#5213 — class instance accessors named prototype", () => {
  for (const relativePath of EXACT_ROWS) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    it.skipIf(!existsSync(file))(`${relativePath} passes in host and standalone`, async () => {
      try {
        const host = await runTest262File(file, "issue-5213", 30_000);
        expect({ status: host.status, error: host.error }).toEqual({ status: "pass", error: undefined });

        const standalone = await runTest262File(file, "issue-5213", 30_000, "standalone");
        expect({ status: standalone.status, error: standalone.error }).toEqual({
          status: "pass",
          error: undefined,
        });
      } finally {
        restoreHostBuiltins();
      }
    });
  }

  it("keeps declaration and expression prototypes distinct from their constructors", async () => {
    const source = `
      let seen = 0;
      class Decl {
        get prototype() { return 13; }
        set prototype(value) { seen = value; }
        get adjacent() { return 11; }
        static get marker() { return 29; }
      }
      const Expr = class {
        get prototype() { return 17; }
        set prototype(value) { seen = value + 1; }
        get adjacent() { return 23; }
      };
      export function testDecl() {
        const descriptor = Object.getOwnPropertyDescriptor(Decl.prototype, "prototype");
        const ctor = Object.getOwnPropertyDescriptor(Decl, "prototype");
        const instance = new Decl();
        instance.prototype = 7;
        return (
          Decl.hasOwnProperty("prototype") &&
          Decl.prototype.prototype === 13 &&
          descriptor !== undefined &&
          descriptor.get !== undefined &&
          descriptor.set !== undefined &&
          descriptor.enumerable === false &&
          descriptor.configurable === true &&
          ctor !== undefined &&
          ctor.value === Decl.prototype &&
          ctor.writable === false &&
          instance.adjacent === 11 &&
          Decl.marker === 29 &&
          seen === 7
        ) ? 1 : 0;
      }
      export function testExpr() {
        return Expr.hasOwnProperty("prototype") &&
          Expr.prototype.prototype === 17 &&
          Expr.prototype.adjacent === 23 ? 1 : 0;
      }
      class Receiver {
        get prototype() { return this; }
      }
      export function testReceiver() {
        const instance = new Receiver();
        // This accessor reads its receiver. The class-prototype optimization
        // must not replace it with a fabricated $Receiver; the ordinary
        // instance path must return the exact instance instead.
        return instance.prototype === instance ? 1 : 0;
      }
    `;
    const host = runHostMatrix(source);
    expect(host.testDecl!()).toBe(1);
    expect(host.testExpr!()).toBe(1);
    expect(host.testReceiver!()).toBe(1);
    expect(await runStandalone(source, "testDecl")).toBe(1);
    expect(await runStandalone(source, "testExpr")).toBe(1);
    expect(await runStandalone(source, "testReceiver")).toBe(1);
  });
});
