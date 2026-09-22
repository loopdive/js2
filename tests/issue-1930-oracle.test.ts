// (#1930 Slice 1) TypeOracle — the one type-query boundary. Guards:
//   1. The oracle is constructible from a checker alone (no CodegenContext,
//      no WasmModule) and answers are registry-free TypeFacts — the
//      Constraint-A/B contract agreed with #2134/#2135 (see the issue file).
//   2. Fact classification parity for the primitive lanes (number/boolean/
//      string/symbol/bigint), unions with nullability, arrays, builtins.
//   3. typeKeyOf interning: same checker type object → same token (the
//      Slice-5 replacement contract for ts.Type-keyed maps).
//   4. The Slice-1 pilot (unary.ts Symbol→number throw) still compiles and
//      throws per §7.1.4 through the oracle.

import { describe, it, expect } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { InHouseOracle } from "../src/checker/inhouse-oracle.js";
import { createTypeOracle, DifferentialOracle, DivergenceLedger } from "../src/checker/oracle-backend.js";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function oracleFor(source: string) {
  const { sourceFile, checker } = analyzeSource(source, "oracle-probe.ts");
  return { oracle: new TsCheckerOracle(checker), sourceFile, checker };
}

/** First initializer expression of the var statement declaring `name`. */
function initializerOf(sf: ts.SourceFile, name: string): ts.Expression {
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
      }
    }
  }
  throw new Error(`no initializer for ${name}`);
}

describe("#1930 TypeOracle Slice 1", () => {
  it("distinguishes common iterator members from existential union membership", () => {
    const { oracle, sourceFile, checker } = oracleFor(`
      function probe(
        iterator: IterableIterator<number>,
        iterable: Iterable<number>,
        partial: IterableIterator<number> | { next(): IteratorResult<number> },
        both: IterableIterator<number> | IterableIterator<string>,
        anyValue: any,
        unknownValue: unknown,
      ) {}
    `);
    const declaration = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const parameters = declaration.parameters;
    expect(parameters).toHaveLength(6);
    expect(parameters.map((parameter) => oracle.commonIteratorMembersOf(parameter.name))).toEqual([
      true,
      false,
      false,
      true,
      undefined,
      undefined,
    ]);
    expect(oracle.wellKnownSymbolMemberOf(parameters[2]!.name, "iterator")).toBe(true);
    for (const backend of ["checker", "inhouse", "differential"] as const) {
      const selected = createTypeOracle(checker, backend);
      expect(parameters.map((parameter) => selected.commonIteratorMembersOf(parameter.name))).toEqual([
        true,
        false,
        false,
        true,
        undefined,
        undefined,
      ]);
    }
    const pureInhouse = new InHouseOracle();
    expect(pureInhouse.commonIteratorMembersOf(parameters[0]!.name)).toBeUndefined();
    const ledger = new DivergenceLedger();
    const differential = new DifferentialOracle(oracle, pureInhouse, ledger);
    expect(differential.commonIteratorMembersOf(parameters[0]!.name)).toBe(true);
    expect(ledger.byQuery.get("commonIteratorMembersOf")?.weakened).toBe(1);
  });

  it("classifies primitive lanes without any codegen context", () => {
    const { oracle, sourceFile } = oracleFor(`
      const n = 1 + 2;
      const s = "x";
      const b = 1 < 2;
      const g = 10n;
      const sym = Symbol("k");
      const arr = [1, 2, 3];
      const d = new Date(0);
    `);
    expect(oracle.typeFactOf(initializerOf(sourceFile, "n")).kind).toBe("number");
    expect(oracle.typeFactOf(initializerOf(sourceFile, "s")).kind).toBe("string");
    expect(oracle.typeFactOf(initializerOf(sourceFile, "b")).kind).toBe("boolean");
    expect(oracle.typeFactOf(initializerOf(sourceFile, "g")).kind).toBe("bigint");
    expect(oracle.staticJsTypeOf(initializerOf(sourceFile, "sym"))).toBe("symbol");
    const arrFact = oracle.typeFactOf(initializerOf(sourceFile, "arr"));
    expect(arrFact.kind).toBe("array");
    if (arrFact.kind === "array") expect(arrFact.element.kind).toBe("number");
    expect(oracle.builtinReceiverOf(initializerOf(sourceFile, "d"))).toBe("Date");
    expect(oracle.isBooleanProducing(initializerOf(sourceFile, "b"))).toBe(true);
    expect(oracle.isBooleanProducing(initializerOf(sourceFile, "n"))).toBe(false);
  });

  it("reports union nullability as a single rich fact (assign-then-multi-use shape)", () => {
    const { oracle, sourceFile } = oracleFor(`
      declare const x: number | null;
      declare const y: string | undefined;
      const nx = x;
      const ny = y;
    `);
    const nxNode = initializerOf(sourceFile, "nx");
    expect(oracle.nullabilityOf(nxNode)).toEqual({ nullable: true, undefinable: false });
    const parts = oracle.unionPartsOf(nxNode);
    expect(parts?.length).toBe(1);
    expect(parts?.[0]?.kind).toBe("number");
    expect(oracle.nullabilityOf(initializerOf(sourceFile, "ny"))).toEqual({ nullable: false, undefinable: true });
  });

  it("interns typeKeyOf per checker type identity (the Slice-5 map-key contract)", () => {
    const { oracle, sourceFile } = oracleFor(`
      const a = "one";
      const b = "two" as string;
      const n = 5 + 1;
    `);
    const aInit = initializerOf(sourceFile, "a");
    // Same node → same token, deterministically.
    expect(oracle.typeKeyOf(aInit)).toBe(oracle.typeKeyOf(aInit));
    // Different lanes → different tokens.
    expect(oracle.typeKeyOf(aInit)).not.toBe(oracle.typeKeyOf(initializerOf(sourceFile, "n")));
  });

  it("pilot: unary Symbol→number throw still fires through the oracle (§7.1.4)", async () => {
    const result = await compile(
      `// @ts-nocheck
export function test() {
  var s = Symbol("k");
  try {
    var n = -s;
    return "no-throw:" + n;
  } catch (e) {
    return "threw:" + (e && e.message ? e.message : e);
  }
}
`,
      { fileName: "t.ts" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const v = (instance.exports as Record<string, () => unknown>).test();
    expect(v).toBe("threw:Cannot convert a Symbol value to a number");
  });
});
