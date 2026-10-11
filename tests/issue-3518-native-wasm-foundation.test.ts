// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Instr, LocalDef } from "../src/wasm/model/instructions.js";
import { STABLE_FUNC_BASE, inLiveShiftRange } from "../src/wasm/physical/function-handles.js";
import {
  STABLE_FUNC_BASE as compatibilityBase,
  inLiveShiftRange as compatibilityPredicate,
} from "../src/emit/resolve-layout.js";
import {
  buildGrowLocals,
  buildGrowBody,
  buildEnqueueBody,
  buildDrainLocals,
  buildDrainBody,
  type PreparedNativeMicrotaskReservations,
} from "../src/runtime/wasmgc/async/microtask-queue-bodies.js";

const resources: PreparedNativeMicrotaskReservations = {
  types: {
    functions: { kind: "type", index: 11 },
    arguments: { kind: "type", index: 12 },
    callback: { kind: "type", index: 13 },
  },
  globals: {
    head: { kind: "global", index: 21 },
    tail: { kind: "global", index: 22 },
    capacity: { kind: "global", index: 23 },
    functions: { kind: "global", index: 24 },
    captures: { kind: "global", index: 25 },
    arguments: { kind: "global", index: 26 },
  },
  grow: { kind: "function", index: 2097161 },
  initialCapacity: 8192,
};

// Explicit resource fixture: distinct type/global slots and a stable function
// handle pin every instruction, branch depth, local slot and queue transition.
// These literals are available in shallow CI; no historical git object is read.
const expectedGrowLocals: LocalDef[] = [
  { name: "$oldFuncs", type: { kind: "ref_null", typeIdx: 11 } },
  { name: "$oldCaps", type: { kind: "ref_null", typeIdx: 12 } },
  { name: "$oldArgs", type: { kind: "ref_null", typeIdx: 12 } },
  { name: "$oldHead", type: { kind: "i32" } },
  { name: "$oldTail", type: { kind: "i32" } },
  { name: "$i", type: { kind: "i32" } },
  { name: "$dst", type: { kind: "i32" } },
];

const expectedGrowBody: Instr[] = [
  { op: "global.get", index: 24 },
  { op: "local.set", index: 1 },
  { op: "global.get", index: 25 },
  { op: "local.set", index: 2 },
  { op: "global.get", index: 26 },
  { op: "local.set", index: 3 },
  { op: "global.get", index: 21 },
  { op: "local.set", index: 4 },
  { op: "global.get", index: 22 },
  { op: "local.set", index: 5 },
  { op: "ref.null.func" },
  { op: "local.get", index: 0 },
  { op: "array.new", typeIdx: 11 },
  { op: "global.set", index: 24 },
  { op: "ref.null.extern" },
  { op: "local.get", index: 0 },
  { op: "array.new", typeIdx: 12 },
  { op: "global.set", index: 25 },
  { op: "ref.null.extern" },
  { op: "local.get", index: 0 },
  { op: "array.new", typeIdx: 12 },
  { op: "global.set", index: 26 },
  { op: "local.get", index: 1 },
  { op: "ref.is_null" },
  {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 },
      { op: "global.set", index: 21 },
      { op: "i32.const", value: 0 },
      { op: "global.set", index: 22 },
      { op: "local.get", index: 0 },
      { op: "global.set", index: 23 },
      { op: "return" },
    ],
  },
  { op: "local.get", index: 4 },
  { op: "local.set", index: 6 },
  { op: "i32.const", value: 0 },
  { op: "local.set", index: 7 },
  {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 6 },
          { op: "local.get", index: 5 },
          { op: "i32.eq" },
          { op: "br_if", depth: 1 },
          { op: "global.get", index: 24 },
          { op: "local.get", index: 7 },
          { op: "local.get", index: 1 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 6 },
          { op: "array.get", typeIdx: 11 },
          { op: "array.set", typeIdx: 11 },
          { op: "global.get", index: 25 },
          { op: "local.get", index: 7 },
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 6 },
          { op: "array.get", typeIdx: 12 },
          { op: "array.set", typeIdx: 12 },
          { op: "global.get", index: 26 },
          { op: "local.get", index: 7 },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 6 },
          { op: "array.get", typeIdx: 12 },
          { op: "array.set", typeIdx: 12 },
          { op: "local.get", index: 6 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 6 },
          { op: "local.get", index: 7 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 7 },
          { op: "br", depth: 0 },
        ],
      },
    ],
  },
  { op: "i32.const", value: 0 },
  { op: "global.set", index: 21 },
  { op: "local.get", index: 7 },
  { op: "global.set", index: 22 },
  { op: "local.get", index: 0 },
  { op: "global.set", index: 23 },
];

const expectedEnqueueBody: Instr[] = [
  { op: "global.get", index: 24 },
  { op: "ref.is_null" },
  {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 8192 },
      { op: "call", funcIdx: 2097161 },
    ],
  },
  { op: "global.get", index: 22 },
  { op: "global.get", index: 23 },
  { op: "i32.eq" },
  {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "global.get", index: 23 },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "call", funcIdx: 2097161 },
    ],
  },
  { op: "global.get", index: 24 },
  { op: "ref.as_non_null" },
  { op: "global.get", index: 22 },
  { op: "local.get", index: 0 },
  { op: "array.set", typeIdx: 11 },
  { op: "global.get", index: 25 },
  { op: "ref.as_non_null" },
  { op: "global.get", index: 22 },
  { op: "local.get", index: 1 },
  { op: "array.set", typeIdx: 12 },
  { op: "global.get", index: 26 },
  { op: "ref.as_non_null" },
  { op: "global.get", index: 22 },
  { op: "local.get", index: 2 },
  { op: "array.set", typeIdx: 12 },
  { op: "global.get", index: 22 },
  { op: "i32.const", value: 1 },
  { op: "i32.add" },
  { op: "global.set", index: 22 },
];

const expectedDrainLocals: LocalDef[] = [
  { name: "$fn", type: { kind: "funcref" } },
  { name: "$caps", type: { kind: "externref" } },
  { name: "$arg", type: { kind: "externref" } },
];

const expectedDrainBody: Instr[] = [
  { op: "global.get", index: 24 },
  { op: "ref.is_null" },
  {
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "return" }],
  },
  {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "global.get", index: 21 },
          { op: "global.get", index: 22 },
          { op: "i32.eq" },
          { op: "br_if", depth: 1 },
          { op: "global.get", index: 24 },
          { op: "ref.as_non_null" },
          { op: "global.get", index: 21 },
          { op: "array.get", typeIdx: 11 },
          { op: "local.set", index: 0 },
          { op: "global.get", index: 25 },
          { op: "ref.as_non_null" },
          { op: "global.get", index: 21 },
          { op: "array.get", typeIdx: 12 },
          { op: "local.set", index: 1 },
          { op: "global.get", index: 26 },
          { op: "ref.as_non_null" },
          { op: "global.get", index: 21 },
          { op: "array.get", typeIdx: 12 },
          { op: "local.set", index: 2 },
          { op: "global.get", index: 21 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "global.set", index: 21 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: 13 },
          { op: "call_ref", typeIdx: 13 },
          { op: "drop" },
          { op: "br", depth: 0 },
        ],
      },
    ],
  },
];

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

// Include erased type edges: runtime import hooks alone cannot observe them.
function dependencies(text: string): string[] {
  const file = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      edges.push(node.moduleSpecifier.getText(file));
    } else if (ts.isImportTypeNode(node) || ts.isImportEqualsDeclaration(node)) {
      edges.push(node.getText(file));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      edges.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return edges;
}

function importedNames(path: string, module: string): string[] {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  return file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (statement.moduleSpecifier.text !== module) return [];
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
  });
}

describe("native Wasm foundation", () => {
  it("preserves both function handle regime boundaries and the compatibility objects", () => {
    expect(STABLE_FUNC_BASE).toBe(2097152);
    expect(compatibilityBase).toBe(STABLE_FUNC_BASE);
    expect(compatibilityPredicate).toBe(inLiveShiftRange);
    for (const [index, importsBefore, expected] of [
      [-1, 0, false],
      [0, 0, true],
      [6, 7, false],
      [7, 7, true],
      [8, 7, true],
      [2097151, 7, true],
      [2097152, 7, false],
      [2097153, 7, false],
      [2097151, 2097152, false],
      [2097152, 2097152, false],
      [Number.NaN, 0, false],
      [Number.POSITIVE_INFINITY, 0, false],
    ] as const) {
      expect(inLiveShiftRange(index, importsBefore), `${index} / ${importsBefore}`).toBe(expected);
      expect(compatibilityPredicate(index, importsBefore)).toBe(expected);
    }
  });

  it("returns the exact queue locals and instructions without changing the resource snapshot", () => {
    const before = structuredClone(resources);
    expect(buildGrowLocals(resources)).toEqual(expectedGrowLocals);
    expect(buildGrowBody(resources)).toEqual(expectedGrowBody);
    expect(buildEnqueueBody(resources)).toEqual(expectedEnqueueBody);
    expect(buildDrainLocals()).toEqual(expectedDrainLocals);
    expect(buildDrainBody(resources)).toEqual(expectedDrainBody);
    expect(resources).toEqual(before);
  });

  it("keeps the model import-free and physical handles and the native leaf canonical type-only", () => {
    expect(dependencies(source("src/wasm/model/instructions.ts"))).toEqual([]);
    const handles = source("src/wasm/physical/function-handles.ts");
    expect(dependencies(handles)).toEqual(['"../model/instructions.js"', '"../model/module-records.js"']);
    const handleImports = ts
      .createSourceFile("handles.ts", handles, ts.ScriptTarget.Latest, true)
      .statements.filter(ts.isImportDeclaration);
    expect(handleImports).toHaveLength(2);
    for (const entry of handleImports) expect(entry.importClause?.isTypeOnly).toBe(true);
    const leaf = source("src/runtime/wasmgc/async/microtask-queue-bodies.ts");
    expect(dependencies(leaf)).toEqual(['"../../../wasm/model/instructions.js"']);
    const file = ts.createSourceFile("leaf.ts", leaf, ts.ScriptTarget.Latest, true);
    const imports = file.statements.filter(ts.isImportDeclaration);
    expect(imports).toHaveLength(1);
    expect(imports[0].importClause?.isTypeOnly).toBe(true);
  });

  it("detects type-only, re-export, import-type and dynamic back edges", () => {
    for (const edge of [
      'import type { Instr } from "../../../ir/types.js";',
      'export type { Instr } from "../../../ir/types.js";',
      'type Hidden = import("../../../ir/types.js").Instr;',
      'const hidden = import("../../../codegen/async-scheduler.js");',
      'import hidden = require("../../../compiler.js");',
      'const hidden = require("../../../compiler.js");',
    ]) {
      expect(dependencies(edge), edge).toHaveLength(1);
    }
  });

  it("connects the real scheduler and function-space consumers to the new modules", () => {
    expect(
      importedNames("src/codegen/async-scheduler.ts", "../runtime/wasmgc/async/microtask-queue-bodies.js").sort(),
    ).toEqual([
      "PreparedNativeMicrotaskReservations",
      "buildDrainBody",
      "buildDrainLocals",
      "buildEnqueueBody",
      "buildGrowBody",
      "buildGrowLocals",
    ]);
    expect(importedNames("src/codegen/async-scheduler.ts", "./prepared-native-async-runtime.js")).toEqual([]);
    expect(importedNames("src/codegen/func-space.ts", "../wasm/physical/function-handles.js")).toEqual([
      "STABLE_FUNC_BASE",
      "mintDefinedFunc",
      "commitDefinedFuncOrdinal",
      "appendDefinedFunc",
    ]);
  });

  it("typechecks all canonical and compatibility declarations, including recursive instruction arms", () => {
    // Normal repository typecheck excludes tests, so compile this small virtual
    // consumer explicitly. Unused @ts-expect-error directives catch accidental
    // widening; source-only compatibility imports cannot hide behind transpilation.
    const path = resolve("src/wasm/model/__n1_compatibility_fixture__.ts");
    const text = `
      import type * as Canonical from "./instructions.js";
      import type * as Compatibility from "../../ir/types.js";
      import type * as Native from "../../runtime/wasmgc/async/microtask-queue-bodies.js";
      import type * as Adapter from "../../codegen/prepared-native-async-runtime.js";
      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
        (<T>() => T extends B ? 1 : 2) ? true : false;
      type Assert<T extends true> = T;
      ${[
        "FuncHandle",
        "GlobalHandle",
        "TypeHandle",
        "ValType",
        "LocalDef",
        "SourcePos",
        "Instr",
        "BlockType",
        "CatchClause",
        "TryTableCatch",
      ]
        .map((name) => "type Same" + name + " = Assert<Equal<Canonical." + name + ", Compatibility." + name + ">>;")
        .join("\n")}
      type NumericFunc = Assert<Equal<Canonical.FuncHandle, number>>;
      type NumericGlobal = Assert<Equal<Canonical.GlobalHandle, number>>;
      type NumericType = Assert<Equal<Canonical.TypeHandle, number>>;
      type Queue = Assert<Equal<Native.PreparedNativeMicrotaskReservations, Adapter.PreparedNativeMicrotaskReservations>>;
      type Handle = Assert<Equal<Native.PreparedNativeQueueHandle<"type">, Adapter.PreparedNativeQueueHandle<"type">>>;
      const values: Canonical.ValType[] = [
        { kind: "i32", boolean: true }, { kind: "i32", symbol: true },
        { kind: "i64", bigint: true }, { kind: "f64", undefSentinel: true },
        { kind: "ref_null", typeIdx: 12 },
      ];
      const instruction: Canonical.Instr = {
        op: "try", blockType: { kind: "val", type: values[0] },
        sourcePos: { file: "queue.ts", line: 3, column: 4 },
        body: [{
          op: "try_table", blockType: { kind: "type", typeIdx: 1 },
          body: [{ op: "call", funcIdx: 2097152 }, { op: "global.get", index: 2 }],
          catches: [{ kind: "catch_ref", tagIdx: 0, depth: 1 }],
        }],
        catches: [{ tagIdx: 0, body: [{ op: "ref.func", funcIdx: 2097153 }] }],
      };
      const old: Compatibility.Instr = instruction;
      const back: Canonical.Instr = old;
      // @ts-expect-error source positions still require a column
      const invalidPosition: Canonical.SourcePos = { file: "queue.ts", line: 3 };
      // @ts-expect-error instruction operands retain their types
      const invalidCall: Canonical.Instr = { op: "call", funcIdx: "wrong" };
      // @ts-expect-error optional inert brands are not widened
      const invalidBrand: Canonical.ValType = { kind: "i32", symbol: false };
      // @ts-expect-error resource kinds remain distinct
      const invalidHandle: Native.PreparedNativeQueueHandle<"type"> = { kind: "global", index: 1 };
    `;
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      name === path
        ? ts.createSourceFile(name, text, languageVersion, true)
        : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([path], options, host);
    expect(program.getSourceFile(path)).toBeDefined();
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  });
});
