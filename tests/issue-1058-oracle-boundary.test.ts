// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { InHouseOracle } from "../src/checker/inhouse-oracle.js";
import { DifferentialOracle } from "../src/checker/oracle-backend.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { readsUninitialisedVariableSlot } from "../src/codegen/uninitialised-variable-undefined.js";
import { nativeTypeOfDeclaration } from "../src/codegen/native-type-annotations.js";

it("preserves exact declaration facts without querying the codegen checker", () => {
  const source = ts.createSourceFile(
    "facts.ts",
    `
    type f64 = number;
    interface i32 { value: number }
    let plain: string;
    let nullable: string | null;
    let optional: string | undefined;
    let opaque: unknown;
    let dynamic: any;
    let initialized: string = "ready";
    function native(value?: f64): void {}
    function ordinary(value?: number): void {}
    function nonNative(value?: i32): void {}
    function shadow(undefined: number): number { return undefined; }
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = { noLib: true, strictNullChecks: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === "facts.ts" ? source : undefined);
  const checker = ts.createProgram(["facts.ts"], options, host).getTypeChecker();
  const oracle = new TsCheckerOracle(checker);
  const context = {
    oracle,
    get checker(): never {
      throw new Error("raw checker read");
    },
  } as unknown as CodegenContext;
  const results: Record<string, boolean> = {};
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        results[declaration.name.getText()] = readsUninitialisedVariableSlot(
          context,
          declaration.name as ts.Identifier,
        );
      }
    }
    if (ts.isFunctionDeclaration(statement)) {
      expect(nativeTypeOfDeclaration(oracle, statement.parameters[0])).toEqual(
        nativeTypeOfDeclaration(checker, statement.parameters[0]),
      );
      if (statement.name?.text === "shadow") {
        const returned = statement.body!.statements[0] as ts.ReturnStatement;
        expect(oracle.typeFactOf(returned.expression!).kind).toBe("number");
      }
    }
  }
  expect(results).toEqual({
    plain: true,
    nullable: false,
    optional: true,
    opaque: false,
    dynamic: false,
    initialized: false,
  });
});

it("keeps selected overloads, receiver provenance and unknown index shapes distinct", () => {
  const source = ts.createSourceFile(
    "queries.ts",
    `
    interface Receiver { value: number }
    let receiver: Receiver | undefined;
    let indexed: { [key: string]: number };
    let mixed: { [key: string]: number } | { value: string };
    let closed: { value: number };
    let dynamic: any;
    let opaque: unknown;
    function select(value: number): number;
    function select<T>(value: T): T;
    function select(value: any): any { return value; }
    select(1); select("text");
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = { noLib: true, strictNullChecks: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === "queries.ts" ? source : undefined);
  const checker = ts.createProgram(["queries.ts"], options, host).getTypeChecker();
  const oracle = new TsCheckerOracle(checker);
  const inhouse = new InHouseOracle();
  const differential = new DifferentialOracle(oracle, inhouse);
  const indexes: Record<string, boolean | undefined> = {};
  const generics: boolean[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations[0]!;
      indexes[declaration.name.getText()] = oracle.hasIndexSignature(declaration.name);
      expect(differential.hasIndexSignature(declaration.name)).toBe(indexes[declaration.name.getText()]);
      expect(inhouse.hasIndexSignature(declaration.name)).toBeUndefined();
      if (declaration.name.getText() === "receiver") {
        expect(oracle.typeDeclarationsOf(declaration.name)).toEqual([source.statements[0]]);
        expect(differential.typeDeclarationsOf(declaration.name)).toEqual([source.statements[0]]);
        expect(inhouse.typeDeclarationsOf(declaration.name)).toEqual([]);
      }
    }
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const call = statement.expression;
      const selected = oracle.resolvedCallDeclarationOf(call);
      expect(selected).toBe(checker.getResolvedSignature(call)?.declaration);
      expect(differential.resolvedCallDeclarationOf(call)).toBe(selected);
      expect(inhouse.resolvedCallDeclarationOf(call)).toBeUndefined();
      generics.push((selected?.typeParameters?.length ?? 0) > 0);
    }
  }
  expect(indexes).toEqual({
    receiver: false,
    indexed: true,
    mixed: undefined,
    closed: false,
    dynamic: undefined,
    opaque: undefined,
  });
  expect(generics).toEqual([false, true]);
});

it("reports indexed record field facts without exposing checker types", () => {
  const source = ts.createSourceFile(
    "records.ts",
    `
    interface Array<T> { [index: number]: T; }
    interface Row { text?: string; nullable: string | null; count: number; opaque: unknown; }
    let rows: Row[];
    class RecordClass { value: number = 1; }
    let classes: RecordClass[];
    const getters = [{ get value(): number { return 1; } }];
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = { noLib: true, strictNullChecks: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === "records.ts" ? source : undefined);
  const checker = ts.createProgram(["records.ts"], options, host).getTypeChecker();
  const oracle = new TsCheckerOracle(checker);
  const rows = (source.statements[2] as ts.VariableStatement).declarationList.declarations[0]!.name;
  const shape = oracle.indexedElementShapeOf(rows);
  expect(shape?.props.map((property) => property.name)).toEqual(["text", "nullable", "count", "opaque"]);
  expect(shape?.props[0]).toMatchObject({ name: "text", optional: true });
  expect(shape?.props[1]?.fact).toMatchObject({ kind: "union", nullable: true });
  expect(shape?.props[2]?.fact).toEqual({ kind: "number" });
  expect(shape?.props[3]?.fact).toEqual({ kind: "unknown" });
  expect(oracle.indexedElementShapeOf(rows)).toBe(shape);
  const classes = (source.statements[4] as ts.VariableStatement).declarationList.declarations[0]!.name;
  expect(oracle.indexedElementShapeOf(classes)).toBeUndefined();
  const getters = (source.statements[5] as ts.VariableStatement).declarationList.declarations[0]!.name;
  expect(oracle.indexedElementShapeOf(getters)).toBeUndefined();
  const inhouse = new InHouseOracle();
  expect(inhouse.indexedElementShapeOf(rows)).toBeUndefined();
  expect(new DifferentialOracle(oracle, inhouse).indexedElementShapeOf(rows)).toEqual(shape);
});
