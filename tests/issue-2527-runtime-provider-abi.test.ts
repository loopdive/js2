// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { RUNTIME_RECGROUP_ABI_VERSION } from "../src/emit/canonical-recgroup.js";

const source = readFileSync(new URL("../scripts/build-runtime-provider.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile(
  "build-runtime-provider.mjs",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

function uniqueInitializer(name: string): ts.Expression {
  const declarations = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
  expect(declarations, `exactly one ${name} declaration`).toHaveLength(1);
  const initializer = declarations[0]!.initializer;
  expect(initializer, `${name} initializer`).toBeDefined();
  return initializer!;
}

const versionInitializer = uniqueInitializer("EXPECTED_RUNTIME_RECGROUP_ABI_VERSION");
expect(ts.isNumericLiteral(versionInitializer)).toBe(true);
const expectedVersion = Number(versionInitializer.getText(parsed));
const exportInitializer = uniqueInitializer("EXPORTS");
expect(ts.isArrayLiteralExpression(exportInitializer)).toBe(true);
const exports = (exportInitializer as ts.ArrayLiteralExpression).elements.map((element) => {
  expect(ts.isStringLiteral(element)).toBe(true);
  return (element as ts.StringLiteral).text;
});
const verifyDeclarations = parsed.statements.filter(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "verify",
);
expect(verifyDeclarations, "exactly one real verify declaration").toHaveLength(1);
expect(verifyDeclarations[0]!.body).toBeDefined();

function guard(imports: WebAssembly.ModuleImportDescriptor[] = [], names = exports) {
  const instantiate = vi.fn();
  const construct = vi.fn();
  class Module {
    constructor(binary: Uint8Array) {
      construct(binary);
    }
    static imports() {
      return imports;
    }
    static exports() {
      return names.map((name) => ({ name, kind: "function" }));
    }
  }
  class Instance {
    constructor(module: Module, bindings: object) {
      instantiate(module, bindings);
    }
  }
  // Evaluate only the exact AST declaration: the CLI's unconditional main
  // must never run, and the test must not substitute a retyped guard.
  const verify = runInNewContext(`${verifyDeclarations[0]!.getText(parsed)}; verify`, {
    WebAssembly: { Module, Instance },
    EXPORTS: exports,
    EXPECTED_RUNTIME_RECGROUP_ABI_VERSION: expectedVersion,
  }) as (binary: Uint8Array, fingerprint?: { abiVersion: number }) => void;
  return { verify, instantiate, construct };
}

describe("#2527 maintained runtime-provider ABI admission", () => {
  it("pins the builder expectation to the canonical producer", () => {
    expect(expectedVersion).toBe(RUNTIME_RECGROUP_ABI_VERSION);
    expect(exports).toEqual([
      "number_toString",
      "number_toString_radix",
      "number_toFixed",
      "number_toPrecision",
      "number_toExponential",
    ]);
  });

  it("admits the current fingerprint and executes one canary", () => {
    const { verify, instantiate, construct } = guard();
    const binary = new Uint8Array();
    verify(binary, { abiVersion: RUNTIME_RECGROUP_ABI_VERSION });
    expect(construct).toHaveBeenCalledExactlyOnceWith(binary);
    expect(instantiate).toHaveBeenCalledExactlyOnceWith(expect.anything(), {});
  });

  it.each([
    ["old ABI", { abiVersion: 2 }],
    ["missing metadata", undefined],
    ["missing ABI", {}],
    ["future ABI", { abiVersion: RUNTIME_RECGROUP_ABI_VERSION + 1 }],
  ])("rejects %s before instantiation", (_label, fingerprint) => {
    const { verify, instantiate } = guard();
    expect(() => verify(new Uint8Array(), fingerprint as { abiVersion: number } | undefined)).toThrow(
      `canonical rec-group ABI v${RUNTIME_RECGROUP_ABI_VERSION} metadata`,
    );
    expect(instantiate).not.toHaveBeenCalled();
  });

  it.each(exports)("still rejects the missing required export %s", (missing) => {
    const { verify, instantiate } = guard(
      [],
      exports.filter((name) => name !== missing),
    );
    expect(() => verify(new Uint8Array(), { abiVersion: expectedVersion })).toThrow(`export ${missing} is missing`);
    expect(instantiate).not.toHaveBeenCalled();
  });

  it("still rejects imported host services", () => {
    const { verify, instantiate } = guard([{ module: "host", name: "format", kind: "function" }]);
    expect(() => verify(new Uint8Array(), { abiVersion: expectedVersion })).toThrow(
      "must have zero imports, found host::format",
    );
    expect(instantiate).not.toHaveBeenCalled();
  });
});
