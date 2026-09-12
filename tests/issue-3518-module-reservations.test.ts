// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import ts from "typescript";
import type * as Historical from "../src/ir/types.js";
import type * as Canonical from "../src/wasm/model/module-records.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { createEmptyModule } from "../src/ir/types.js";
import {
  PhysicalModuleReservations,
  appendPhysicalImport,
  type FunctionReservation,
} from "../src/wasm/physical/module-reservations.js";
import {
  appendDefinedFunc,
  commitDefinedFuncOrdinal,
  mintDefinedFunc,
  STABLE_FUNC_BASE,
} from "../src/wasm/physical/function-handles.js";
import { funcTypeKey, internFunctionType, sameValTypes } from "../src/wasm/physical/function-types.js";
import { mintDefinedFunc as legacyMint, pushDefinedFunc as legacyPush } from "../src/codegen/func-space.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { addImport } from "../src/codegen/registry/physical-imports.js";
import { emitBinary } from "../src/emit/binary.js";
import { WasmEncoder } from "../src/emit/encoder.js";

const voidSignature = { params: [], results: [] };
const names = [
  "TypeDef",
  "FuncTypeDef",
  "StructTypeDef",
  "ArrayTypeDef",
  "RecGroupDef",
  "SubTypeDef",
  "FieldDef",
  "WasmFunction",
  "TagDef",
  "Import",
  "ImportDesc",
  "WasmExport",
  "Table",
  "Element",
  "GlobalDef",
];

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}
function declarations(text: string) {
  const file = ts.createSourceFile("records.ts", text, ts.ScriptTarget.Latest, true);
  return file.statements.filter(
    (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
  );
}
function receipt(text: string): string {
  const file = ts.createSourceFile("records.ts", text, ts.ScriptTarget.Latest, true);
  return createHash("sha256")
    .update(
      JSON.stringify(
        declarations(text).map((node) => [
          node.name.text,
          ts.SyntaxKind[node.kind],
          text.slice(node.getStart(file), node.end),
        ]),
      ),
    )
    .digest("hex");
}
function fixture() {
  const module = createEmptyModule();
  const transaction = new PhysicalModuleReservations(module);
  const fn = transaction.reserveFunction("unit:main", "main", voidSignature);
  return { module, transaction, fn };
}
function context() {
  return createCodegenContext(createEmptyModule(), ts.createProgram([], { noLib: true }).getTypeChecker(), {
    target: "gc",
  });
}

function nanPayload(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
}

describe("temporary explicit-rec grouping admission", () => {
  const forms = ["params", "results", "field", "array", "struct-super", "sub-super"] as const;
  function referencing(form: (typeof forms)[number], target: number): Canonical.TypeDef {
    const type: ValType = { kind: "ref_null", typeIdx: target };
    switch (form) {
      case "params":
        return { kind: "func", params: [type], results: [] };
      case "results":
        return { kind: "func", params: [], results: [type] };
      case "field":
        return { kind: "struct", name: "holder", fields: [{ name: "value", type, mutable: true }] };
      case "array":
        return { kind: "array", name: "holder", element: type, mutable: true };
      case "struct-super":
        return { kind: "struct", name: "holder", fields: [], superTypeIdx: target };
      case "sub-super":
        return {
          kind: "sub",
          name: "holder",
          superType: target,
          final: true,
          type: { kind: "struct", name: "inner", fields: [] },
        };
    }
  }

  for (const position of ["earlier", "at-first", "internal-forward", "trailing-forward"] as const) {
    for (const form of forms) {
      it(`rejects ${position} ${form} type-definition refs into/beyond the first explicit rec`, () => {
        const tx = new PhysicalModuleReservations(createEmptyModule());
        const prefix: Canonical.StructTypeDef = { kind: "struct", name: "prefix", fields: [], superTypeIdx: -1 };
        const target: Canonical.StructTypeDef = { kind: "struct", name: "target", fields: [], superTypeIdx: -1 };
        tx.reserveType("prefix", position === "earlier" ? referencing(form, 2) : prefix);
        tx.reserveType("group", {
          kind: "rec",
          types: [
            position === "at-first" || position === "internal-forward"
              ? referencing(form, position === "at-first" ? 1 : 2)
              : { kind: "struct", name: "member", fields: [] },
            target,
          ],
        });
        if (position === "trailing-forward") {
          tx.reserveType("trailing-holder", referencing(form, 4));
          tx.reserveType("trailing-target", { kind: "struct", name: "tail", fields: [], superTypeIdx: -1 });
        }
        const fn = tx.reserveFunction("fn", "fn", voidSignature);
        expect(() => tx.freezeReservations()).toThrow("unsupported explicit-rec type-definition grouping");
        expect(tx.state).toBe("failed");
        expect(() => tx.fillFunction(fn, { locals: [], body: [] })).toThrow("observed failed");
        expect(() => tx.seal()).toThrow("observed failed");
      });
    }
  }

  for (const form of forms) {
    it(`preserves ${form} refs solely into the preceding flat prefix and flattened body/local refs`, () => {
      const module = createEmptyModule();
      const tx = new PhysicalModuleReservations(module);
      tx.reserveType("prefix", { kind: "struct", name: "prefix", fields: [], superTypeIdx: -1 });
      tx.reserveType("group", {
        kind: "rec",
        types: [referencing(form, 0), { kind: "struct", name: "member", fields: [] }],
      });
      const fn = tx.reserveFunction("fn", "fn", voidSignature);
      expect(fn.object.typeIdx).toBe(3);
      tx.freezeReservations();
      tx.fillFunction(fn, {
        locals: [{ name: "member", type: { kind: "ref_null", typeIdx: 2 } }],
        body: [{ op: "ref.null", typeIdx: 2 }, { op: "drop" }],
      });
      expect(tx.seal().types).toBe(4);
      expect(WebAssembly.validate(emitBinary(module))).toBe(true);
    });
  }

  it("rejects High's no-prefix rec([A ref1, B]) plus function counterexample", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    tx.reserveType("group", {
      kind: "rec",
      types: [
        { kind: "struct", name: "A", fields: [{ name: "b", type: { kind: "ref_null", typeIdx: 1 }, mutable: true }] },
        { kind: "struct", name: "B", fields: [] },
      ],
    });
    tx.reserveFunction("fn", "fn", voidSignature);
    expect(() => tx.freezeReservations()).toThrow("target 1 is at/after first explicit rec member 0");
    expect(tx.state).toBe("failed");
  });
});

describe("review controls — exact emitter-affecting state", () => {
  for (const population of ["exports", "declaredFuncRefs"] as const) {
    for (const inherited of [false, true]) {
      it(`rejects a ${inherited ? "prototype-backed" : "sparse"} hole in ${population}`, () => {
        const { module, transaction: tx, fn } = fixture();
        tx.freezeReservations();
        tx.fillFunction(fn, { locals: [], body: [] });
        tx.defineExport("export", "main", fn);
        tx.declareFunctionReference(fn);
        const array = module[population];
        const entry = array[0];
        Reflect.deleteProperty(array, "0");
        if (inherited) Object.setPrototypeOf(array, Object.assign(Object.create(Array.prototype), { 0: entry }));
        expect(array.length).toBe(1);
        expect(Object.hasOwn(array, 0)).toBe(false);
        expect(() => tx.seal()).toThrow(`${population} population slot 0`);
        expect(tx.state).toBe("failed");
      });
    }
  }

  it("rejects changed NaN payload bits that the actual encoder distinguishes", () => {
    const before = nanPayload(0x7ff8000000000001n);
    const after = nanPayload(0x7ff8000000000002n);
    expect(Number.isNaN(before) && Number.isNaN(after)).toBe(true);
    const first = new WasmEncoder();
    const second = new WasmEncoder();
    first.f64(before);
    second.f64(after);
    expect(first.finish()).not.toEqual(second.finish());
    const { module, transaction: tx, fn } = fixture();
    tx.freezeReservations();
    const constant: Instr = { op: "f64.const", value: before };
    tx.fillFunction(fn, { locals: [], body: [constant, { op: "drop" }] });
    const bytes = emitBinary(module);
    constant.value = after;
    expect(emitBinary(module)).not.toEqual(bytes);
    expect(() => tx.seal()).toThrow("altered completed function");
  });

  it("accepts an unchanged payload-bearing NaN snapshot", () => {
    const { transaction: tx, fn } = fixture();
    tx.freezeReservations();
    tx.fillFunction(fn, {
      locals: [],
      body: [{ op: "f64.const", value: nanPayload(0x7ff8000000000001n) }, { op: "drop" }],
    });
    expect(tx.seal().completedFunctions).toBe(1);
  });

  it("indexes rec members and subsequent interned signatures in the emitted index space", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const struct: Canonical.StructTypeDef = { kind: "struct", name: "record", fields: [] };
    const array: Canonical.ArrayTypeDef = { kind: "array", name: "array", element: { kind: "i32" }, mutable: true };
    const rec: Canonical.RecGroupDef = { kind: "rec", types: [struct, array] };
    const group = tx.reserveType("group", rec);
    const fn = tx.reserveFunction("fn", "fn", { params: [{ kind: "f64" }], results: [] });
    expect(group.object).toBe(module.types[0]);
    expect(rec.types).toEqual([struct, array]);
    expect(group.typeIndex).toBe(0);
    expect(fn.object.typeIdx).toBe(2);
    expect(module.types).toHaveLength(2);
    expect(module.types[1]!.kind).toBe("func");
    tx.freezeReservations();
    expect(tx.internFunctionType([{ kind: "f64" }], [])).toBe(2);
    tx.fillFunction(fn, { locals: [{ name: "array", type: { kind: "ref_null", typeIdx: 1 } }], body: [] });
    expect(tx.seal().types).toBe(3);
    expect(WebAssembly.validate(emitBinary(module))).toBe(true);
  });

  it("counts sub as one and resolves its actual inner record rather than the wrapper", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const struct: Canonical.StructTypeDef = { kind: "struct", name: "inner", fields: [] };
    const sub: Canonical.SubTypeDef = { kind: "sub", name: "wrapped", final: true, superType: null, type: struct };
    const reserved = tx.reserveType("sub", sub);
    const fn = tx.reserveFunction("fn", "fn", voidSignature);
    expect(reserved.object).toBe(module.types[0]);
    expect(fn.object.typeIdx).toBe(1);
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [{ op: "struct.new", typeIdx: 0 }, { op: "drop" }] });
    expect(tx.seal().types).toBe(2);
    expect(WebAssembly.validate(emitBinary(module))).toBe(true);
  });

  it("does not alias two interned signatures after multi-member rec groups", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    tx.reserveType("group", {
      kind: "rec",
      types: [
        { kind: "struct", name: "a", fields: [] },
        { kind: "struct", name: "b", fields: [] },
      ],
    });
    const first = tx.reserveFunction("first", "first", { params: [{ kind: "i32", boolean: true }], results: [] });
    const second = tx.reserveFunction("second", "second", { params: [{ kind: "i32", symbol: true }], results: [] });
    expect([first.object.typeIdx, second.object.typeIdx]).toEqual([2, 3]);
    tx.freezeReservations();
    expect(tx.internFunctionType([{ kind: "i32", boolean: true }], [])).toBe(2);
    expect(tx.internFunctionType([{ kind: "i32", symbol: true }], [])).toBe(3);
    tx.fillFunction(first, { locals: [], body: [] });
    tx.fillFunction(second, { locals: [], body: [] });
    expect(tx.seal().types).toBe(4);
    expect(WebAssembly.validate(emitBinary(module))).toBe(true);
  });

  it("uses the flattened member kind for instruction validation", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    tx.reserveType("group", {
      kind: "rec",
      types: [
        { kind: "struct", name: "a", fields: [] },
        { kind: "array", name: "b", element: { kind: "i32" }, mutable: true },
      ],
    });
    const fn = tx.reserveFunction("fn", "fn", voidSignature);
    tx.freezeReservations();
    expect(() => tx.fillFunction(fn, { locals: [], body: [{ op: "struct.new", typeIdx: 1 }] })).toThrow(
      "wrong resource kind",
    );
  });

  it("reserves the exact canonical group descriptor before its future members and emits it", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const descriptor = { start: 0, end: 1, abiVersion: 2 };
    tx.reserveCanonicalRuntimeRecGroup("canonical", descriptor);
    tx.reserveType("a", { kind: "struct", name: "a", fields: [] });
    tx.reserveType("b", { kind: "struct", name: "b", fields: [] });
    const fn = tx.reserveFunction("fn", "fn", voidSignature);
    expect(module.canonicalRuntimeRecGroup).toBe(descriptor);
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [] });
    expect(tx.seal().types).toBe(3);
    expect(WebAssembly.validate(emitBinary(module))).toBe(true);
  });

  it("supports explicit rec wrappers after an independently retained flat canonical group", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    tx.reserveCanonicalRuntimeRecGroup("canonical", { start: 0, end: 1, abiVersion: 2 });
    tx.reserveType("a", { kind: "struct", name: "a", fields: [] });
    tx.reserveType("b", { kind: "struct", name: "b", fields: [] });
    tx.reserveType("explicit", {
      kind: "rec",
      types: [
        { kind: "struct", name: "c", fields: [] },
        { kind: "struct", name: "d", fields: [] },
      ],
    });
    const fn = tx.reserveFunction("fn", "fn", voidSignature);
    expect(fn.object.typeIdx).toBe(4);
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [] });
    expect(tx.seal().types).toBe(5);
    expect(WebAssembly.validate(emitBinary(module))).toBe(true);
  });

  it("reports the existing forced-group emitter coordinate limitation rather than certifying a different group", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    tx.reserveType("explicit", {
      kind: "rec",
      types: [
        { kind: "struct", name: "a", fields: [] },
        { kind: "struct", name: "b", fields: [] },
      ],
    });
    tx.reserveType("canonical-member", { kind: "struct", name: "c", fields: [] });
    tx.reserveCanonicalRuntimeRecGroup("canonical", { start: 2, end: 2, abiVersion: 2 });
    tx.reserveFunction("fn", "fn", voidSignature);
    expect(() => tx.freezeReservations()).toThrow("emitter outer/physical coordinates");
  });

  for (const phase of ["reserving", "filling"] as const) {
    for (const corruption of ["add-undefined", "delete-undefined", "substitute", "content"] as const) {
      it(`rejects ${phase} canonical group ${corruption}`, () => {
        const module = createEmptyModule();
        if (corruption === "delete-undefined") module.canonicalRuntimeRecGroup = undefined;
        const tx = new PhysicalModuleReservations(module);
        if (corruption === "substitute" || corruption === "content") {
          tx.reserveCanonicalRuntimeRecGroup("canonical", { start: 0, end: 0, abiVersion: 2 });
        }
        tx.reserveType("a", { kind: "struct", name: "a", fields: [] });
        if (phase === "filling") tx.freezeReservations();
        if (corruption === "add-undefined") module.canonicalRuntimeRecGroup = undefined;
        if (corruption === "delete-undefined") Reflect.deleteProperty(module, "canonicalRuntimeRecGroup");
        if (corruption === "substitute") module.canonicalRuntimeRecGroup = { ...module.canonicalRuntimeRecGroup! };
        if (corruption === "content") module.canonicalRuntimeRecGroup!.abiVersion++;
        expect(() => (phase === "reserving" ? tx.freezeReservations() : tx.seal())).toThrow(
          "canonical runtime rec-group",
        );
        expect(tx.state).toBe("failed");
      });
    }
  }

  for (const error of ["duplicate", "late", "missing-member", "adjacent-merge"] as const) {
    it(`rejects canonical group ${error}`, () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      tx.reserveCanonicalRuntimeRecGroup("canonical", {
        start: 0,
        end: error === "missing-member" ? 1 : 0,
        abiVersion: 2,
      });
      tx.reserveType("a", {
        kind: "struct",
        name: "a",
        fields:
          error === "adjacent-merge" ? [{ name: "next", type: { kind: "ref_null", typeIdx: 1 }, mutable: true }] : [],
      });
      if (error === "adjacent-merge") tx.reserveType("b", { kind: "struct", name: "b", fields: [] });
      if (error === "duplicate")
        expect(() => tx.reserveCanonicalRuntimeRecGroup("again", { start: 0, end: 0, abiVersion: 2 })).toThrow(
          "already reserved",
        );
      else if (error === "late") {
        tx.freezeReservations();
        expect(() => tx.reserveCanonicalRuntimeRecGroup("again", { start: 0, end: 0, abiVersion: 2 })).toThrow(
          "requires reserving",
        );
      } else expect(() => tx.freezeReservations()).toThrow(/canonical rec-group|canonical runtime rec-group/);
    });
  }

  for (const route of ["declarative", "element", "offset", "global", "export"] as const) {
    for (const imported of [false, true]) {
      it(`accepts a ${imported ? "imported" : "defined"} body ref.func via ${route} after fills`, () => {
        const module = createEmptyModule();
        const tx = new PhysicalModuleReservations(module);
        const external = imported ? tx.reserveFunctionImport("target", "env", "target", voidSignature) : undefined;
        const table =
          route === "element" || route === "offset"
            ? tx.reserveTable("table", { elementType: "funcref", min: 1 })
            : undefined;
        const global =
          route === "global" ? tx.reserveGlobal("global", "reference", { kind: "funcref" }, false) : undefined;
        const target = external ?? tx.reserveFunction("target", "target", voidSignature);
        const caller = tx.reserveFunction("caller", "caller", voidSignature);
        tx.freezeReservations();
        if (target.kind === "function") tx.fillFunction(target, { locals: [], body: [] });
        // Deliberately fill BEFORE publishing the declaration route.
        tx.fillFunction(caller, {
          locals: [],
          body: [
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [{ op: "ref.func", funcIdx: target.handle }, { op: "drop" }],
            },
          ],
        });
        if (route === "declarative") tx.declareFunctionReference(target);
        if (route === "element") tx.defineElement("element", table!, [{ op: "i32.const", value: 0 }], [target]);
        if (route === "offset")
          tx.defineElement(
            "element",
            table!,
            [{ op: "ref.func", funcIdx: target.handle }, { op: "drop" }, { op: "i32.const", value: 0 }],
            [],
          );
        if (route === "global") tx.fillGlobal(global!, [{ op: "ref.func", funcIdx: target.handle }]);
        if (route === "export") tx.defineExport("export", "target", target);
        expect(tx.seal().completedFunctions).toBe(imported ? 1 : 2);
        // The offset route is an emitter declaration route, but its extended
        // const-expression validity is not claimed by this resource ledger.
        if (route !== "offset") expect(WebAssembly.validate(emitBinary(module))).toBe(true);
      });
    }
  }

  const nestedRefs: { name: string; wrap: (ref: Instr[]) => Instr[] }[] = [
    { name: "body", wrap: (ref) => ref },
    { name: "block", wrap: (ref) => [{ op: "block", blockType: { kind: "empty" }, body: ref }] },
    { name: "loop", wrap: (ref) => [{ op: "loop", blockType: { kind: "empty" }, body: ref }] },
    {
      name: "then",
      wrap: (ref) => [
        { op: "i32.const", value: 1 },
        { op: "if", blockType: { kind: "empty" }, then: ref },
      ],
    },
    {
      name: "else",
      wrap: (ref) => [
        { op: "i32.const", value: 0 },
        { op: "if", blockType: { kind: "empty" }, then: [], else: ref },
      ],
    },
    {
      name: "catch",
      wrap: (ref) => [{ op: "try", blockType: { kind: "empty" }, body: [], catches: [{ tagIdx: 0, body: ref }] }],
    },
    {
      name: "catchAll",
      wrap: (ref) => [{ op: "try", blockType: { kind: "empty" }, body: [], catches: [], catchAll: ref }],
    },
    { name: "try_table", wrap: (ref) => [{ op: "try_table", blockType: { kind: "empty" }, body: ref, catches: [] }] },
  ];
  for (const nested of nestedRefs) {
    it(`rejects undeclared ref.func in ${nested.name}, even if target is startup`, () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      tx.reserveTag("tag", voidSignature, { kind: "defined", name: "tag" });
      const target = tx.reserveFunction("target", "target", voidSignature);
      const caller = tx.reserveFunction("caller", "caller", voidSignature);
      tx.freezeReservations();
      tx.fillFunction(target, { locals: [], body: [] });
      tx.fillFunction(caller, {
        locals: [],
        body: nested.wrap([{ op: "ref.func", funcIdx: target.handle }, { op: "drop" }]),
      });
      tx.defineStart(target);
      expect(() => tx.seal()).toThrow("undeclared ref.func target");
      expect(tx.state).toBe("failed");
    });
  }
});

describe("physical record relocation — fifteen complete declarations", () => {
  it("pins mandatory canonical declarations, order, members and documentation", () => {
    const text = source("src/wasm/model/module-records.ts");
    expect(declarations(text).map((node) => node.name.text)).toEqual(names);
    expect(receipt(text)).toBe("490bf9a75ee595ac2dcadba160a8b71149e38f195e7fae6abaeb86043eb0858e");
    const mutated = text.replace("presenceBit?: number;", "presenceBit?: string;");
    expect(receipt(mutated)).not.toBe(receipt(text));
    expect(receipt(text.replace("field's constructor initializer", "field's replacement initializer"))).not.toBe(
      receipt(text),
    );
  });

  it("requires exactly the explicit compatibility exports and no local replacement", () => {
    const text = source("src/ir/types.ts");
    const file = ts.createSourceFile("types.ts", text, ts.ScriptTarget.Latest, true);
    expect(declarations(text).filter((node) => names.includes(node.name.text))).toEqual([]);
    const links = file.statements
      .filter(ts.isExportDeclaration)
      .filter(
        (node) =>
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "../wasm/model/module-records.js",
      );
    expect(links).toHaveLength(1);
    expect(links[0]!.isTypeOnly).toBe(true);
    const clause = links[0]!.exportClause;
    expect(clause && ts.isNamedExports(clause)).toBe(true);
    if (!clause || !ts.isNamedExports(clause)) throw new Error("missing explicit exports");
    expect(clause.elements.map((element) => element.name.text)).toEqual(names);
    expect(clause.elements.every((element) => !element.propertyName)).toBe(true);
    expect(declarations(text).map((node) => node.name.text)).toContain("WasmModule");
    expect(file.statements.filter(ts.isFunctionDeclaration).map((node) => node.name?.text)).toContain(
      "createEmptyModule",
    );
  });

  it("retains all fifteen type identities", () => {
    expectTypeOf<Historical.TypeDef>().toEqualTypeOf<Canonical.TypeDef>();
    expectTypeOf<Historical.FuncTypeDef>().toEqualTypeOf<Canonical.FuncTypeDef>();
    expectTypeOf<Historical.StructTypeDef>().toEqualTypeOf<Canonical.StructTypeDef>();
    expectTypeOf<Historical.ArrayTypeDef>().toEqualTypeOf<Canonical.ArrayTypeDef>();
    expectTypeOf<Historical.RecGroupDef>().toEqualTypeOf<Canonical.RecGroupDef>();
    expectTypeOf<Historical.SubTypeDef>().toEqualTypeOf<Canonical.SubTypeDef>();
    expectTypeOf<Historical.FieldDef>().toEqualTypeOf<Canonical.FieldDef>();
    expectTypeOf<Historical.WasmFunction>().toEqualTypeOf<Canonical.WasmFunction>();
    expectTypeOf<Historical.TagDef>().toEqualTypeOf<Canonical.TagDef>();
    expectTypeOf<Historical.Import>().toEqualTypeOf<Canonical.Import>();
    expectTypeOf<Historical.ImportDesc>().toEqualTypeOf<Canonical.ImportDesc>();
    expectTypeOf<Historical.WasmExport>().toEqualTypeOf<Canonical.WasmExport>();
    expectTypeOf<Historical.Table>().toEqualTypeOf<Canonical.Table>();
    expectTypeOf<Historical.Element>().toEqualTypeOf<Canonical.Element>();
    expectTypeOf<Historical.GlobalDef>().toEqualTypeOf<Canonical.GlobalDef>();
  });

  it("keeps the new kernel's dependencies entirely inside canonical Wasm modules", () => {
    for (const path of [
      "src/wasm/model/module-records.ts",
      "src/wasm/physical/function-handles.ts",
      "src/wasm/physical/function-types.ts",
      "src/wasm/physical/module-reservations.ts",
    ]) {
      const text = source(path);
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const imports = file.statements.filter(ts.isImportDeclaration);
      expect(imports.length).toBeGreaterThan(0);
      for (const entry of imports) {
        expect(ts.isStringLiteral(entry.moduleSpecifier)).toBe(true);
        expect(entry.moduleSpecifier.getText(file)).not.toMatch(/ir\/|codegen\/|context|process|node:/);
      }
      expect(text).not.toMatch(/as CodegenContext|\bprocess\./);
    }
  });
});

describe("shared existing allocator authority", () => {
  it("resolves mint order independently of push order using the one ordinal array", () => {
    const module = createEmptyModule();
    const first = mintDefinedFunc(module);
    const second = mintDefinedFunc(module);
    expect(module.funcOrdinalToPosition.every(Number.isNaN)).toBe(true);
    const a: Canonical.WasmFunction = { name: "a", typeIdx: 0, locals: [], body: [], exported: false };
    const b = { ...a, name: "b" };
    commitDefinedFuncOrdinal(module, second);
    appendDefinedFunc(module, b);
    commitDefinedFuncOrdinal(module, first);
    appendDefinedFunc(module, a);
    expect([first, second]).toEqual([STABLE_FUNC_BASE, STABLE_FUNC_BASE + 1]);
    expect(module.funcOrdinalToPosition).toEqual([1, 0]);
    expect(module.functions[0]).toBe(b);
    expect(module.functions[1]).toBe(a);
    expect(() => commitDefinedFuncOrdinal(module, first)).toThrow("already pushed");
    expect(() => commitDefinedFuncOrdinal(module, STABLE_FUNC_BASE + 2)).toThrow("never minted");
    expect(() => commitDefinedFuncOrdinal(module, 0)).toThrow("not a stable-regime handle");
  });

  it("retains legacy trace failure ordering: ordinal commit, trace, then append", () => {
    const ctx = context();
    const handle = legacyMint(ctx);
    const slot: Canonical.WasmFunction = { name: "traced", typeIdx: 0, locals: [], body: [], exported: false };
    vi.stubEnv("JS2WASM_TRACE_SLOT", "0");
    const failure = new Error("trace sentinel");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      expect(ctx.mod.funcOrdinalToPosition).toEqual([0]);
      expect(ctx.mod.functions).toHaveLength(0);
      throw failure;
    });
    try {
      expect(() => legacyPush(ctx, handle, slot)).toThrow(failure);
      expect(write).toHaveBeenCalledOnce();
      expect(ctx.mod.functions).toHaveLength(0);
      expect(() => legacyPush(ctx, handle, slot)).toThrow("already pushed");
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("shares function-type key/interner, cache-hit naming and exact descriptor references", () => {
    const ctx = context();
    const params: ValType[] = [{ kind: "ref_null", typeIdx: 12 }];
    const results: ValType[] = [{ kind: "i32", boolean: true }];
    const index = addFuncType(ctx, params, results, "first");
    expect(internFunctionType(ctx.mod.types, ctx.funcTypeCache, params, results, "second")).toBe(index);
    expect(ctx.funcTypeCache.get(funcTypeKey(params, results))).toBe(index);
    const type = ctx.mod.types[index]!;
    expect(type.kind).toBe("func");
    if (type.kind !== "func") throw new Error("not a function");
    expect(type.name).toBe("first");
    expect(type.params).toBe(params);
    expect(type.results).toBe(results);
    expect(() => internFunctionType(ctx.mod.types, ctx.funcTypeCache, [], [], undefined, true)).toThrow("not reserved");
  });

  it("shares the exact import append while legacy policy/counters stay authoritative", () => {
    const ctx = context();
    const index = addFuncType(ctx, [], []);
    const direct = appendPhysicalImport(ctx.mod, "env", "tag", { kind: "tag", typeIdx: index });
    expect(ctx.mod.imports[0]).toBe(direct);
    const imported = addImport(ctx, "env", "call", { kind: "func", typeIdx: index });
    expect(imported).toBeDefined();
    expect(ctx.mod.imports[1]).toBe(imported);
    expect(ctx.numImportFuncs).toBe(1);
    expect(ctx.funcMap.get("call")).toBe(0);
    const global = addImport(ctx, "env", "g", { kind: "global", type: { kind: "i32" }, mutable: true });
    expect(ctx.mod.imports[2]).toBe(global);
    expect(ctx.numImportGlobals).toBe(1);
    ctx.indexSpaceFrozen = true;
    expect(() => addImport(ctx, "env", "late", { kind: "func", typeIdx: index })).toThrow("import space frozen");
    expect(ctx.mod.imports).toHaveLength(3);
  });
});

describe("module completion lifecycle and exact locators", () => {
  it("keeps tag/import/global/function/startup order and distinct instruction/ABI indices", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const tag = tx.reserveTag(
      "runtime:exn",
      { params: [{ kind: "externref" }], results: [] },
      { kind: "defined", name: "__exn" },
    );
    const imported = tx.reserveFunctionImport("binding:import", "env", "call", voidSignature);
    const globalImport = tx.reserveGlobalImport("binding:global-import", "env", "g", { kind: "i32" }, true);
    const global = tx.reserveGlobal("binding:global", "g", { kind: "i32" }, true);
    const first = tx.reserveFunction("unit:first", "first", voidSignature);
    const startup = tx.reserveFunction("startup:entry", "__module_init", voidSignature);
    expect(module.types.map((type) => (type.kind === "func" ? [type.params, type.results] : null))).toEqual([
      [[{ kind: "externref" }], []],
      [[], []],
    ]);
    expect(module.imports.map((entry) => entry.desc.kind)).toEqual(["func", "global"]);
    expect(module.functions.map((entry) => entry.name)).toEqual(["first", "__module_init"]);
    expect(first.object).toBe(module.functions[0]);
    expect(first.handle).toBe(STABLE_FUNC_BASE);
    expect(imported.handle).toBe(0);
    tx.freezeReservations();
    expect(tx.physicalIndex(tag)).toBe(0);
    expect(tx.physicalIndex(globalImport)).toBe(0);
    expect(tx.physicalIndex(global)).toBe(1);
    expect(tx.physicalIndex(first)).toBe(1);
    expect(tx.physicalIndex(startup)).toBe(2);
    tx.fillGlobal(global, [{ op: "i32.const", value: 0 }]);
    tx.fillFunction(first, { locals: [], body: [] });
    tx.fillFunction(startup, { locals: [], body: [{ op: "call", funcIdx: first.handle }] });
    expect(tx.defineStart(startup)).toBe(2);
    expect(module.startFuncIdx).toBe(2);
    expect(tx.defineExport("export:first", "first", first).desc).toEqual({ kind: "func", index: 1 });
    expect(first.object.exported).toBe(false);
    expect(tx.seal()).toEqual({
      types: 2,
      imports: 2,
      functions: 2,
      globals: 1,
      tags: 1,
      tables: 0,
      elements: 0,
      exports: 1,
      memories: 0,
      dataSegments: 0,
      strings: 0,
      declaredFuncRefs: 0,
      completedFunctions: 2,
      completedGlobals: 1,
    });
    expect(tx.state).toBe("sealed");
    expect(tx.physicalIndex(first)).toBe(1);
  });

  it("counts real table/element/memory/data/string/reference objects including passive data", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const tag = tx.reserveTag("tag", voidSignature, { kind: "import", module: "env", name: "__exn" });
    const tableObject = { elementType: "funcref", min: 1, max: 2 };
    const table = tx.reserveTable("table", tableObject);
    const memoryObject = { min: 1, max: 2 };
    const memory = tx.reserveMemory("memory", memoryObject);
    const active = { offset: 64, bytes: new Uint8Array([1, 2]) };
    const passive = { offset: -1, bytes: new Uint8Array([3]), passive: true };
    const activeToken = tx.reserveDataSegment("active", active);
    const passiveToken = tx.reserveDataSegment("passive", passive);
    const string = tx.reserveString("literal:message", "self-resolution");
    const fn = tx.reserveFunction("unit:callback", "callback", voidSignature);
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [] });
    const element = tx.defineElement("element", table, [{ op: "i32.const", value: 0 }], [fn]);
    tx.defineExport("table:export", "callbacks", table);
    tx.defineExport("memory:export", "memory", memory);
    tx.defineExport("tag:export", "__exn", tag);
    tx.declareFunctionReference(fn);
    expect([table.object, memory.object, activeToken.object, passiveToken.object]).toEqual([
      tableObject,
      memoryObject,
      active,
      passive,
    ]);
    expect(module.tables[0]).toBe(tableObject);
    expect(module.memories[0]).toBe(memoryObject);
    expect(module.dataSegments[1]).toBe(passive);
    expect(element).toBe(module.elements[0]);
    expect(element.funcIndices).toEqual([0]);
    expect(tx.physicalIndex(string)).toBe(0);
    expect(tx.seal()).toEqual({
      types: 1,
      imports: 1,
      functions: 1,
      globals: 0,
      tags: 0,
      tables: 1,
      elements: 1,
      exports: 3,
      memories: 1,
      dataSegments: 2,
      strings: 1,
      declaredFuncRefs: 1,
      completedFunctions: 1,
      completedGlobals: 0,
    });
  });

  it("fills exact objects in place and treats an explicitly completed empty void body as complete", () => {
    const { module, transaction: tx, fn } = fixture();
    tx.freezeReservations();
    const locals = [{ name: "local", type: { kind: "i32" as const } }];
    const body: Instr[] = [];
    tx.fillFunction(fn, { locals, body });
    expect(fn.object).toBe(module.functions[0]);
    expect(fn.object.locals).toBe(locals);
    expect(fn.object.body).toBe(body);
    expect(tx.seal().completedFunctions).toBe(1);
  });

  for (const body of [[], [{ op: "nop" }]] as Instr[][]) {
    it(`rejects an unfilled ${body.length === 0 ? "empty" : "valid-looking nonempty"} placeholder`, () => {
      const { transaction: tx, fn } = fixture();
      fn.object.body = body;
      tx.freezeReservations();
      expect(() => tx.seal()).toThrow("missing function fill");
      expect(tx.state).toBe("failed");
      expect(() => tx.fillFunction(fn, { locals: [], body: [] })).toThrow("observed failed");
    });
  }

  it("rejects a duplicate function fill", () => {
    const { transaction: tx, fn } = fixture();
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [] });
    expect(() => tx.fillFunction(fn, { locals: [], body: [] })).toThrow("duplicate function fill");
    expect(() => tx.seal()).toThrow("observed failed");
  });

  for (const mode of ["missing", "duplicate", "empty"] as const) {
    it(`rejects ${mode} global completion`, () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const global = tx.reserveGlobal("global", "g", { kind: "i32" }, true);
      tx.freezeReservations();
      if (mode === "missing") expect(() => tx.seal()).toThrow("missing global fill");
      else if (mode === "empty") expect(() => tx.fillGlobal(global, [])).toThrow("initializer is empty");
      else {
        tx.fillGlobal(global, [{ op: "i32.const", value: 1 }]);
        expect(() => tx.fillGlobal(global, [{ op: "i32.const", value: 2 }])).toThrow("duplicate global fill");
      }
      expect(tx.state).toBe("failed");
    });
  }

  for (const stage of ["reserving", "filling"] as const) {
    for (const corruption of ["substitute", "reorder", "append", "replace-array"] as const) {
      it(`rejects ${stage} function population ${corruption}`, () => {
        const { module, transaction: tx } = fixture();
        tx.reserveFunction("second", "second", voidSignature);
        if (stage === "filling") tx.freezeReservations();
        if (corruption === "substitute") module.functions[0] = { ...module.functions[0]! };
        if (corruption === "reorder") module.functions.reverse();
        if (corruption === "append") module.functions.push({ ...module.functions[0]! });
        if (corruption === "replace-array") module.functions = [...module.functions];
        expect(() => (stage === "reserving" ? tx.freezeReservations() : tx.seal())).toThrow("population");
        expect(tx.state).toBe("failed");
      });
    }
  }

  for (const corruption of [
    "ordinal",
    "type",
    "signature-brand",
    "export",
    "start",
    "completed-body",
    "completed-locals",
  ] as const) {
    it(`rejects post-freeze ${corruption} mutation`, () => {
      const { module, transaction: tx, fn } = fixture();
      tx.freezeReservations();
      tx.fillFunction(fn, { locals: [], body: [] });
      if (corruption === "ordinal") module.funcOrdinalToPosition[0] = Number.NaN;
      if (corruption === "type") module.types.push({ kind: "func", params: [], results: [] });
      if (corruption === "signature-brand") {
        const type = module.types[0]!;
        if (type.kind !== "func") throw new Error("expected signature");
        type.params.push({ kind: "i32", boolean: true });
      }
      if (corruption === "export") module.exports.push({ name: "unregistered", desc: { kind: "func", index: 0 } });
      if (corruption === "start") module.startFuncIdx = 0;
      if (corruption === "completed-body") fn.object.body.push({ op: "nop" });
      if (corruption === "completed-locals") fn.object.locals = [];
      expect(() => tx.seal()).toThrow(/population|altered|unregistered/);
    });
  }

  it("rejects a duplicate identity, not just a duplicate display name", () => {
    const { transaction: tx } = fixture();
    tx.reserveFunction("distinct-unit", "main", voidSignature);
    expect(() => tx.reserveGlobal("unit:main", "different-name", { kind: "i32" }, false)).toThrow(
      "duplicate resource key",
    );
  });

  it("rejects reserving the same physical object under two distinct identities", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const table = { elementType: "funcref", min: 1 };
    tx.reserveTable("first", table);
    expect(() => tx.reserveTable("second", table)).toThrow("same allocator object reserved twice");
    expect(tx.state).toBe("failed");
  });

  it("retains the optional start field's exact presence even before publication", () => {
    const { module, transaction: tx } = fixture();
    tx.freezeReservations();
    module.startFuncIdx = undefined;
    expect(() => tx.seal()).toThrow("altered start publication");
  });

  for (const [label, before, after] of [
    ["negative zero", -0, 0],
    ["non-finite", NaN, Infinity],
  ] as const) {
    it(`rejects ${label} mutation inside the exact completed instruction buffer`, () => {
      const { transaction: tx, fn } = fixture();
      tx.freezeReservations();
      const constant: Instr = { op: "f64.const", value: before };
      tx.fillFunction(fn, { locals: [], body: [constant, { op: "drop" }] });
      constant.value = after;
      expect(() => tx.seal()).toThrow("altered completed function");
      expect(tx.state).toBe("failed");
    });

    it(`accepts an unchanged ${label} instruction snapshot`, () => {
      const { transaction: tx, fn } = fixture();
      tx.freezeReservations();
      tx.fillFunction(fn, { locals: [], body: [{ op: "f64.const", value: before }, { op: "drop" }] });
      expect(tx.seal().completedFunctions).toBe(1);
    });
  }

  for (const change of ["delete", "add"] as const) {
    it(`rejects ${change} of a present-undefined optional descriptor field`, () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const descriptor: { min: number; max?: number } = change === "delete" ? { min: 1, max: undefined } : { min: 1 };
      tx.reserveMemory("memory", descriptor);
      tx.freezeReservations();
      if (change === "delete") Reflect.deleteProperty(descriptor, "max");
      else descriptor.max = undefined;
      expect(() => tx.seal()).toThrow("altered memory descriptor");
      expect(tx.state).toBe("failed");
    });
  }

  it("accepts unchanged present-undefined optional fields and distinguishes bigint instruction values", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    tx.reserveMemory("memory", { min: 1, max: undefined });
    const fn = tx.reserveFunction("fn", "fn", voidSignature);
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [{ op: "i64.const", value: 9007199254740993n }, { op: "drop" }] });
    expect(tx.seal().memories).toBe(1);
  });

  it("rejects physical index lookup before freeze", () => {
    const { transaction: tx, fn } = fixture();
    expect(() => tx.physicalIndex(fn)).toThrow("physical index requested in reserving");
  });

  it("rejects a foreign or cloned token despite equal names, keys and handles", () => {
    const a = fixture();
    const b = fixture();
    a.transaction.freezeReservations();
    b.transaction.freezeReservations();
    expect(a.fn.handle).toBe(b.fn.handle);
    expect(() => a.transaction.fillFunction(b.fn, { locals: [], body: [] })).toThrow("foreign or forged");
    expect(() => b.transaction.physicalIndex({ ...b.fn })).toThrow("foreign or forged");
  });

  it("rejects a wrong-kind owned token", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const global = tx.reserveGlobal("global", "g", { kind: "i32" }, false);
    tx.freezeReservations();
    expect(() => tx.fillFunction(global as never as FunctionReservation, { locals: [], body: [] })).toThrow(
      "defined-function token",
    );
  });

  it("rejects new imports after defined globals without changing their positional regime", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    tx.reserveGlobal("global", "g", { kind: "i32" }, true);
    expect(() => tx.reserveGlobalImport("import", "env", "g", { kind: "i32" }, true)).toThrow("imports must precede");
  });

  for (const operation of ["function", "global", "type", "tag", "table", "memory", "string", "data"] as const) {
    it(`rejects post-freeze ${operation} allocation`, () => {
      const { transaction: tx } = fixture();
      tx.freezeReservations();
      expect(() => {
        switch (operation) {
          case "function":
            return tx.reserveFunction("late", "late", voidSignature);
          case "global":
            return tx.reserveGlobal("late", "late", { kind: "i32" }, false);
          case "type":
            return tx.reserveType("late", { kind: "array", name: "a", element: { kind: "i32" }, mutable: true });
          case "tag":
            return tx.reserveTag("late", voidSignature, { kind: "defined", name: "late" });
          case "table":
            return tx.reserveTable("late", { elementType: "funcref", min: 1 });
          case "memory":
            return tx.reserveMemory("late", { min: 1 });
          case "string":
            return tx.reserveString("late", "late");
          case "data":
            return tx.reserveDataSegment("late", { offset: 0, bytes: new Uint8Array(), passive: true });
        }
      }).toThrow("requires reserving");
    });
  }

  it("permits only an already reserved exact signature after freeze", () => {
    const { module, transaction: tx } = fixture();
    const index = tx.internFunctionType([], [], "ignored-hit-name");
    tx.freezeReservations();
    expect(tx.internFunctionType([], [])).toBe(index);
    expect(module.types).toHaveLength(1);
    expect(() => tx.internFunctionType([{ kind: "i32" }], [])).toThrow("signature was not reserved");
    expect(module.types).toHaveLength(1);
    expect(tx.state).toBe("failed");
  });

  for (const pair of [
    [
      { kind: "ref", typeIdx: 0 },
      { kind: "ref", typeIdx: 1 },
    ],
    [
      { kind: "ref", typeIdx: 0 },
      { kind: "ref_null", typeIdx: 0 },
    ],
    [{ kind: "i32" }, { kind: "i32", boolean: true }],
    [{ kind: "i32" }, { kind: "i32", symbol: true }],
    [{ kind: "i64" }, { kind: "i64", bigint: true }],
    [{ kind: "f64" }, { kind: "f64", undefSentinel: true }],
  ] satisfies [ValType, ValType][]) {
    it(`distinguishes the complete signature ${JSON.stringify(pair)}`, () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      tx.reserveType("shape:0", { kind: "struct", name: "a", fields: [] });
      tx.reserveType("shape:1", { kind: "struct", name: "b", fields: [] });
      const first = tx.internFunctionType([pair[0]], [pair[0]]);
      const second = tx.internFunctionType([pair[1]], [pair[1]]);
      expect(first).not.toBe(second);
      expect(sameValTypes([pair[0]], [pair[1]])).toBe(false);
      tx.freezeReservations();
      expect(tx.internFunctionType([pair[0]], [pair[0]])).toBe(first);
      expect(tx.internFunctionType([pair[1]], [pair[1]])).toBe(second);
      expect(tx.seal().types).toBe(4);
    });
  }

  it("rejects a missing reference-type dependency at freeze", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    tx.reserveFunction("fn", "fn", { params: [{ kind: "ref_null", typeIdx: 9 }], results: [] });
    expect(() => tx.freezeReservations()).toThrow("unresolved type index 9");
  });

  for (const body of [
    [{ op: "call", funcIdx: STABLE_FUNC_BASE + 4 }],
    [{ op: "call", funcIdx: 9 }],
    [{ op: "global.get", index: 9 }],
    [{ op: "ref.cast", typeIdx: 9 }],
    [{ op: "struct.new", typeIdx: 0 }],
    [{ op: "call_indirect", typeIdx: 0, tableIdx: 9 }],
    [{ op: "throw", tagIdx: 9 }],
    [{ op: "memory.init", dataIdx: 9 }],
    [{ op: "if", blockType: { kind: "empty" }, then: [{ op: "global.get", index: 9 }] }],
  ] satisfies Instr[][]) {
    it(`rejects unresolved/wrong-kind body references ${JSON.stringify(body)}`, () => {
      const { transaction: tx, fn } = fixture();
      tx.freezeReservations();
      expect(() => tx.fillFunction(fn, { locals: [], body })).toThrow(/unresolved|wrong resource kind/);
      expect(tx.state).toBe("failed");
    });
  }

  it("rejects export collision without toggling the actual function exported bit", () => {
    const { transaction: tx, fn } = fixture();
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [] });
    tx.defineExport("export:1", "main", fn);
    expect(() => tx.defineExport("export:2", "main", fn)).toThrow("duplicate export name");
    expect(fn.object.exported).toBe(false);
  });

  it("rejects duplicate startup and incompatible startup signatures", () => {
    const a = fixture();
    a.transaction.freezeReservations();
    a.transaction.defineStart(a.fn);
    expect(() => a.transaction.defineStart(a.fn)).toThrow("already published");
    const b = new PhysicalModuleReservations(createEmptyModule());
    const fn = b.reserveFunction("fn", "fn", { params: [], results: [{ kind: "i32" }] });
    b.freezeReservations();
    expect(() => b.defineStart(fn)).toThrow("start function must have signature");
  });

  it("rejects an existing unregistered population at transaction creation", () => {
    const module = createEmptyModule();
    module.stringPool.push("hidden");
    expect(() => new PhysicalModuleReservations(module)).toThrow("requires empty physical storage");
  });
});
