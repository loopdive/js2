// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { makeIrQualifiedExternConstructorResolver } from "../src/ir/qualified-extern-constructor.js";
import { usedExternClassMetadata } from "../src/codegen/extern-class-metadata.js";

async function instantiate(source: string, deps: Record<string, any>, names = ["run"]) {
  const result = await compile(source, { skipSemanticDiagnostics: true, trackIrOutcomes: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irBodyRouteAudit?.target).toBe("gc");
  for (const name of names) {
    expect(result.irOutcomes?.find((row) => row.displayName === name)).toMatchObject({
      kind: "emitted",
      directBodyEmissions: 0,
      irBodyEmissions: 1,
      legacyBodyEmitted: false,
    });
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === name)).toEqual([]);
  }
  const imports = buildCompiledImports(result, deps);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return wrapCompiledExports(result, instance) as Record<string, any>;
}

describe("#6979 declared namespace constructors use prepared IR", () => {
  it("deduplicates aliases but refuses ambiguous provider prefixes", () => {
    const first = {
      className: "Date",
      namespacePath: ["left"],
      importPrefix: "shared_Date",
      constructorParams: [],
      methods: new Map(),
      properties: new Map(),
    };
    const imports = [{ module: "env", name: "shared_Date_new", desc: { kind: "func" as const, typeIdx: 0 } }];
    expect(
      usedExternClassMetadata(
        new Map([
          ["Date", first],
          ["left.Date", first],
        ]),
        imports,
      ),
    ).toHaveLength(1);
    const other = { ...first, namespacePath: ["right"] };
    expect(() =>
      usedExternClassMetadata(
        new Map([
          ["left.Date", first],
          ["right.Date", other],
        ]),
        imports,
      ),
    ).toThrow("Ambiguous external class import prefix");
  });
  for (const name of ["Number", "Function", "Date", "Map"]) {
    it(`keeps api.${name} separate from the intrinsic, without an AST body`, async () => {
      const ex = await instantiate(
        `
        declare namespace api { class ${name} { constructor(value: number); value: number; } }
        export function run(n: number): number { var value = new api.${name}(n); return value.value; }
      `,
        {
          api: {
            [name]: class {
              constructor(readonly value: number) {}
            },
          },
        },
      );
      expect(ex.run(42)).toBe(42);
      expect(ex.run(7)).toBe(7);
    });
  }

  it("keeps distinct providers for namespaces with identical class leaf names", async () => {
    const ex = await instantiate(
      `
      declare namespace left { class Date { constructor(value: number); value: number; } }
      declare namespace right { class Date { constructor(value: number); value: number; } }
      export function run(n: number): number { var a = new left.Date(n); var b = new right.Date(n); return a.value + b.value; }
    `,
      {
        left: {
          Date: class {
            value: number;
            constructor(n: number) {
              this.value = n;
            }
          },
        },
        right: {
          Date: class {
            value: number;
            constructor(n: number) {
              this.value = n * 2;
            }
          },
        },
      },
    );
    expect(ex.run(14)).toBe(42);
    expect(ex.run(7)).toBe(21);
  });

  it("retains constructor result identity and original thrown values at the boundary", async () => {
    let made: object | undefined;
    const token = {};
    const ex = await instantiate(
      `
      declare namespace api { class Date { constructor(value: number); } }
      export function make(n: number): any { return new api.Date(n); }
    `,
      {
        api: {
          Date: class {
            constructor(n: number) {
              if (n < 0) throw token;
              made = this;
            }
          },
        },
      },
      ["make"],
    );
    expect(ex.make(42)).toBe(made);
    expect(ex.make(7)).toBe(made);
    let thrown: unknown;
    try {
      ex.make(-1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(token);
  });

  it("admits exact nested ambient namespace identity", () => {
    const ast = analyzeSource(
      "declare namespace api { namespace nested { class Date {} } } function run() { return new api.nested.Date(); }",
    );
    const resolve = makeIrQualifiedExternConstructorResolver(ast.checker);
    let proof: unknown;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) proof = resolve(node);
      ts.forEachChild(node, visit);
    };
    visit(ast.sourceFile);
    expect(proof).toEqual({ className: "Date", registryKey: "api.nested.Date", namespacePath: ["api", "nested"] });
  });

  for (const [name, source] of [
    [
      "parameter shadow",
      "declare namespace api { class Date {} } declare const mirror: typeof api; function run(api: typeof mirror) { return new api.Date(); }",
    ],
    [
      "namespace alias",
      "declare namespace api { class Date {} } const alias = api; function run() { return new alias.Date(); }",
    ],
    ["computed callee", "declare namespace api { class Date {} } function run() { return new api['Date'](); }"],
    ["runtime object", "const api = { Date: class Date {} }; function run() { return new api.Date(); }"],
    [
      "merged runtime root",
      "declare namespace api { class Date {} } function api() {} function run() { return new api.Date(); }",
    ],
  ]) {
    it(`refuses ${name} rather than certifying a same-spelled path`, () => {
      const ast = analyzeSource(source!);
      const resolve = makeIrQualifiedExternConstructorResolver(ast.checker);
      const proofs: unknown[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node)) proofs.push(resolve(node));
        ts.forEachChild(node, visit);
      };
      visit(ast.sourceFile);
      expect(proofs).toEqual([undefined]);
    });
  }
});
