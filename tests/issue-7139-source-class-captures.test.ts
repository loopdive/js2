// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { prepareIrSourceDefinitionPopulation } from "../src/ir/program/source-class-definitions.js";
import { prepareSourceClosureEntry, requireSourceClosureEntry } from "../src/ir/source-closure-entry.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";

const external = { kind: "boxed", inner: { kind: "val", val: { kind: "externref" } } } as const;
const flag = { kind: "boxed", inner: { kind: "val", val: { kind: "i32" } } } as const;
const number = { kind: "boxed", inner: { kind: "val", val: { kind: "f64" } } } as const;

function fixture(inner = false, assignment = "") {
  const source = sourceInput({
    "./entry.ts": inner
      ? `class C { get read():number{${assignment}return C===null?100:200;} } export function run():number{return 0;}`
      : `function make(seed:number):number{class C{}class D{get read():number{${assignment}return(C===null?100:200)+seed;}}seed++;return seed;}export function run():number{return 0;}`,
  });
  const { identity } = prepareIrSourceDefinitionPopulation(source);
  const factory = inner ? undefined : (source.entrySource.statements[0] as ts.FunctionDeclaration);
  const declaration = (factory ? factory.body!.statements[0] : source.entrySource.statements[0]) as ts.ClassDeclaration;
  const owner = factory ? (factory.body!.statements[1] as ts.ClassDeclaration) : declaration;
  const member = owner.members[0] as ts.GetAccessorDeclaration;
  const captures = [
    { declaration, fieldType: external, initializedFieldType: flag },
    ...(factory ? [{ declaration: factory.parameters[0]!, fieldType: number }] : []),
  ];
  const input = { identity, checker: source.checker, declaration: member, captures };
  return { source, identity, declaration, member, input };
}

for (const inner of [false, true])
  it(`authenticates a class binding and its two retained fields, inner=${inner}`, () => {
    const f = fixture(inner),
      entry = prepareSourceClosureEntry(f.input);
    expect(entry.captures[0]).toEqual({ name: "C", lexical: { initializedFieldIndex: 1, mutable: !inner } });
    expect(entry.captureFieldTypes).toEqual(inner ? [external, flag] : [external, flag, number]);
    if (!inner) expect(entry.captures[1]).toEqual({ name: "seed", fieldIndex: 2 });
    const lowered = lowerFunctionAstToIr(f.member, {
      ownerUnitId: entry.unitId,
      funcName: "read",
      identityContext: f.identity,
      checker: f.source.checker,
      sourceClosureEntry: entry,
      numericThrow: "number-boundary",
      resolver: { jsHostExterns: () => false },
    });
    const rows: IrInstr[] = [];
    lowered.main.blocks.forEach((block) =>
      block.instrs.forEach((row) => forEachInstrDeep(row, (instruction) => rows.push(instruction))),
    );
    expect(rows.filter((row) => row.kind === "closure.cap").map((row) => row.index)).toEqual(
      inner ? [0, 1] : [0, 1, 2],
    );
    expect(rows.some((row) => row.kind === "call" && row.target.name === "__new_ReferenceError")).toBe(true);
    expect(requireSourceClosureEntry(entry, f.member, entry.unitId)).toBe(entry);
    expect(Object.isFrozen(entry.captures[0]!.lexical)).toBe(true);
  });

for (const invalid of ["missing", "wrong-flag", "unboxed-value"] as const)
  it(`rejects ${invalid} paired class binding storage`, () => {
    const f = fixture();
    const captures = f.input.captures.map((row, index) =>
      index
        ? row
        : {
            ...row,
            fieldType: invalid === "unboxed-value" ? external.inner : external,
            initializedFieldType: invalid === "missing" ? undefined : invalid === "wrong-flag" ? number : flag,
          },
    );
    expect(() => prepareSourceClosureEntry({ ...f.input, captures })).toThrow(/lexical capture requires/);
  });

it("revalidates the initialized-cell type after class entry issuance", () => {
  const f = fixture(),
    entry = prepareSourceClosureEntry(f.input);
  const changed = entry.captureFieldTypes[1]!;
  if (changed.kind !== "boxed" || changed.inner.kind !== "val") throw Error("missing issued flag cell");
  Object.assign(changed.inner.val, { kind: "f64" });
  expect(() => requireSourceClosureEntry(entry, f.member, entry.unitId)).toThrow(
    /changed lexical initialization capture/,
  );
});

for (const inner of [false, true])
  for (const [rhs, intrinsic] of [
    ["3", "js.number.box"],
    ["true", "js.boolean.box"],
  ])
    it(`boxes ${rhs} before lexical PutValue guards, inner=${inner}`, () => {
      const f = fixture(inner, `C=(${rhs} as any);`),
        entry = prepareSourceClosureEntry(f.input);
      const lowered = lowerFunctionAstToIr(f.member, {
        ownerUnitId: entry.unitId,
        funcName: "read",
        identityContext: f.identity,
        checker: f.source.checker,
        sourceClosureEntry: entry,
        numericThrow: "number-boundary",
        resolver: { jsHostExterns: () => false },
      });
      const rows: IrInstr[] = [];
      lowered.main.blocks.forEach((block) =>
        block.instrs.forEach((row) => forEachInstrDeep(row, (instruction) => rows.push(instruction))),
      );
      const box = rows.findIndex((row) => row.kind === "intrinsic" && row.id === intrinsic);
      const guard = rows.findIndex((row) => row.kind === "call" && row.target.name === "__new_ReferenceError");
      expect(box).toBeGreaterThanOrEqual(0);
      expect(guard).toBeGreaterThan(box);
      expect(
        rows.some(
          (row) =>
            row.kind === "coerce.to_externref" &&
            rows.some(
              (input) =>
                input.result === row.value &&
                input.kind === "const" &&
                (input.value.kind === "f64" || input.value.kind === "bool"),
            ),
        ),
      ).toBe(false);
    });
