// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { forEachInstrDeep, type IrType } from "../src/ir/core/nodes.js";
import { assertSourceBooleanAnyReturns } from "../src/frontend/boolean-return-boundary.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

function source(text: string) {
  const input = sourceInput({ "./entry.ts": text });
  const declaration = input.entrySource.statements.find(ts.isFunctionDeclaration)!;
  return { input, declaration, result: prepareIrProgramSources(input) };
}

describe("source Boolean return candidates require actual Boolean boxes", () => {
  it.each([
    ["parameter", "return value;"],
    ["local alias", "const alias = value; return alias;"],
    ["conditional value join", "return value ? true : false;"],
    ["two terminating branches", "if (value) return true; else return false;"],
    ["early CFG return", "if (value) return true; return false;"],
    ["nested early return", "for (let i = 0; i < 2; i++) { if (value) return true; } return false;"],
    ["nested numeric function is a separate owner", "function nested(): number { return 7; } return value;"],
    ["truthful assertion", "return value as boolean;"],
  ])("prepares %s without granting a physical provider", (_label, body) => {
    const { result } = source(`export function box(value: boolean): any { ${body} }`);
    if (result.kind !== "prepared") throw new Error(result.detail);
    const fn = result.ir.functions.find((row) => row.name === "box")!;
    expect(fn.resultTypes).toEqual([{ kind: "val", val: { kind: "externref" } }]);
    const boxes: unknown[] = [];
    for (const block of fn.blocks)
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (row) => {
          if (row.kind === "intrinsic" && row.id === "js.boolean.box") {
            expect(row.provider).toBeUndefined();
            boxes.push(row);
          }
        });
    expect(boxes.length).toBeGreaterThan(0);
  });

  it.each([
    ["implicit undefined arm", "if (value) return true;"],
    ["bare return", "if (value) return; return false;"],
    ["mixed numeric return", "if (value) return true; return 7;"],
    ["no outer return", "function nested(): boolean { return true; }"],
    ["nested return cannot certify outer number", "function nested(): boolean { return true; } return 7;"],
    ["nested any return cannot borrow outer certification", "function nested(): any { return value; } return value;"],
    ["numeric assertion", "return 1 as unknown as boolean;"],
    ["bitwise assertion", "return (3 & 1) as unknown as boolean;"],
    ["undefined assertion", "return undefined as unknown as boolean;"],
    ["asserted local type", "const alias: boolean = 1 as unknown as boolean; return alias;"],
    ["loop exit is not a return proof", "while (value) { return true; }"],
  ])("refuses %s with the original source owner", (_label, body) => {
    const { result } = source(`export function box(value: boolean): any { ${body} }`);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("non-Boolean return was admitted");
    expect(result.sourceFile).toBe("entry.ts");
    expect(result.unitId).toBeTruthy();
    expect(result.location.line).toBeGreaterThan(0);
  });

  it("preserves the unsupported any-parameter contract", () => {
    const { result } = source("export function box(value: any): any { return value as boolean; }");
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("any parameter was widened");
    expect(result.detail).toMatch(/unsupported type in Phase 1/);
  });

  it("retains legacy omission and refuses another declaration's return selection", () => {
    const { input, declaration } = source("export function box(value: boolean): any { return value; }");
    const other = source("export function other(value: boolean): any { return value; }").declaration;
    for (const booleanReturnBoundary of [undefined, other])
      expect(() =>
        lowerFunctionAstToIr(declaration, {
          checker: input.checker,
          booleanReturnBoundary,
          returnTypeOverride: { kind: "val", val: { kind: "externref" } },
        }),
      ).toThrow(/numeric i32.*any.*box helper/);
  });

  it.each(["i32", "i64"] as const)("keeps unbranded %s returns outside the Boolean arm", (kind) => {
    const { input, declaration } = source("export function box(value): any { return value; }");
    expect(() =>
      lowerFunctionAstToIr(declaration, {
        checker: input.checker,
        paramTypeOverrides: [{ kind: "val", val: { kind } } as IrType],
        returnTypeOverride: { kind: "val", val: { kind: "externref" } },
      }),
    ).toThrow(/numeric .*any.*box helper/);
  });

  it("audits actual empty and nested early-return operands after lowering", () => {
    const { input, declaration, result } = source("export function box(value: boolean): any { return value; }");
    if (result.kind !== "prepared") throw new Error(result.detail);
    const fn = result.ir.functions.find((row) => row.name === "box")!;
    const first = fn.blocks[0]!;
    expect(() =>
      assertSourceBooleanAnyReturns(input.checker, declaration, {
        ...fn,
        blocks: [{ ...first, terminator: { kind: "return", values: [] } }],
      }),
    ).toThrow(/actual canonical Boolean boxing/);
    expect(() =>
      assertSourceBooleanAnyReturns(input.checker, declaration, {
        ...fn,
        blocks: [
          {
            ...first,
            instrs: [
              ...first.instrs,
              {
                kind: "if.stmt",
                result: null,
                resultType: null,
                cond: fn.params[0]!.value,
                then: [{ kind: "early.return", result: null, resultType: null, value: null }],
                else: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(/actual canonical Boolean boxing/);
  });

  for (const backend of ["wasmgc", "linear"] as const)
    for (const box of ["native", "host", "unsupported"] as const)
      it(`retains provider policy and logical codec types, backend=${backend}, box=${box}`, () => {
        const policy = { backend, target: "host" as const, booleanBoundary: { box } };
        const result = prepareWholeIrProgram({
          ...sourceInput({ "./entry.ts": "export function box(value: boolean): any { return value; }" }),
          policy,
          runtimePolicies: [policy],
        });
        if (box === "unsupported" || (backend === "linear" && box === "native")) {
          expect(result.kind).toBe("unsupported");
          if (result.kind === "prepared") throw new Error("unavailable Boolean provider was admitted");
          expect(result.detail).toMatch(/boolean|provider|backend/i);
          return;
        }
        if (result.kind !== "prepared") throw new Error(result.detail);
        for (const program of [result.program, decodePreparedIrProgram(encodePreparedIrProgram(result.program))]) {
          const fn = program.ir.functions.find((row) => row.name === "box")!;
          expect(fn.params[0]!.type).toEqual({ kind: "val", val: { kind: "i32", boolean: true } });
          expect(fn.resultTypes).toEqual([{ kind: "val", val: { kind: "externref" } }]);
          expect(program.runtime[0]!.prepared.manifest.policy.booleanBoundary.box).toBe(box);
        }
      });
});
