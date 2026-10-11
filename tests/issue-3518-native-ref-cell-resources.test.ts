// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { forEachInstrDeep, type IrInstrRefCellNew } from "../src/ir/core/nodes.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import {
  planNativeSourceClosureRequirements,
  assertNativeSourceClosureRequirementsCurrent,
} from "../src/ir/program/native-source-closure-requirements.js";
import {
  reserveNativeRefCells,
  requireNativeRefCells,
  resolveNativeRefCell,
} from "../src/backend/wasmgc/resources/native-ref-cells.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { ValType } from "../src/wasm/model/instructions.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { getOrRegisterRefCellType } from "../src/codegen/registry/types.js";
import * as bodies from "../src/runtime/wasmgc/values/ref-cell-layouts.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";

const source = `
function numberCell(seed: number): () => number {
  return function increment(): number { seed += 1; return seed; };
}
function booleanCell(seed: boolean): () => boolean {
  return function toggle(): boolean { seed = !seed; return seed; };
}
function twoCells(first: number, second: number): () => number {
  return function incrementBoth(): number { first += 1; second += 2; return first + second; };
}
export function run(seed: number): number {
  const number = numberCell(seed), other = numberCell(seed + 9), flag = booleanCell(false);
  const pair = twoCells(seed, seed + 3);
  return number() + (flag() ? 100 : 0) + number() + (flag() ? 1000 : 0) + other() + pair();
}`;
let original: PreparedIrProgram;
beforeAll(() => {
  original = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
function requirements(program = original) {
  const plan = planNativeSourceClosureRequirements(program, program.runtime[0]!);
  if (!plan) throw new Error("real mutable source requirements missing");
  assertNativeSourceClosureRequirementsCurrent(plan);
  return plan;
}
function fixture(program = original) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  return { module, tx, requirements: requirements(program) };
}
function editable() {
  const projection = {
    ...original.runtime[0]!,
    prepared: { ...original.runtime[0]!.prepared, functions: structuredClone(original.runtime[0]!.prepared.functions) },
  };
  const program = {
    ...original,
    allocations: structuredClone(original.allocations),
    ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
    runtime: [projection],
  };
  const positive = requirements(program);
  expect(positive.gaps).toEqual([]);
  return { program, projection, positive };
}
function actualCells(program: PreparedIrProgram) {
  const rows: { view: string; ownerUnitId: string; instruction: IrInstrRefCellNew }[] = [];
  for (const [ownerIndex, owner] of program.ir.functions.entries())
    for (const [view, fn] of [
      ["program", owner],
      ["projection", program.runtime[0]!.prepared.functions[ownerIndex]!],
    ] as const)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.kind === "refcell.new") rows.push({ view, ownerUnitId: fn.unitId, instruction });
          });
  return rows;
}
function noAllocation(f: ReturnType<typeof fixture>, action: () => unknown, message: string | RegExp) {
  const before = structuredClone(f.module),
    arrays = [f.module.types, f.module.globals, f.module.functions];
  expect(action).toThrow(message);
  expect(f.module).toStrictEqual(before);
  [f.module.types, f.module.globals, f.module.functions].forEach((array, index) => expect(array).toBe(arrays[index]));
}

describe("canonical legacy mutable-cell layout delegation", () => {
  it("inverts the adapter to the fixed authenticated donor function", () => {
    const donor = JSON.parse(
      readFileSync(new URL("./fixtures/issue-3518-ref-cell-donor.json", import.meta.url), "utf8"),
    );
    expect(donor.commit).toBe("fdaa94315aeeeab5dc85a3596f2b4997b388ac76");
    expect(donor.blob).toBe("accac33484a267a868145ba59b442bcb12cdd561");
    expect(donor.functionSha256).toBe("c0cdb135e5604f855c82574dfdf67fb229730215ead5f39f9fef40d1a26e6fee");
    expect(createHash("sha256").update(donor.function).digest("hex")).toBe(donor.functionSha256);
    const source = readFileSync(new URL("../src/codegen/registry/types.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("types.ts", source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(
      (row) => ts.isFunctionDeclaration(row) && row.name?.text === "getOrRegisterRefCellType",
    );
    if (!fn) throw new Error("production legacy adapter missing");
    const current = fn.getText(ast);
    expect(current.match(/refCellTypeKey\(valType\)/g)).toHaveLength(1);
    expect(current.match(/createRefCellType\(key, valType\)/g)).toHaveLength(1);
    const inverse = current
      .replace(
        "const key = refCellTypeKey(valType);",
        `const key =\n    valType.kind === "ref" || valType.kind === "ref_null"\n      ? \`\${valType.kind}_\${(valType as { typeIdx: number }).typeIdx}\`\n      : valType.kind;`,
      )
      .replace(
        "ctx.mod.types.push(createRefCellType(key, valType));",
        `ctx.mod.types.push({\n    kind: "struct",\n    name: \`__ref_cell_\${key}\`,\n    fields: [{ name: "value", type: valType, mutable: true }],\n  });`,
      );
    expect(inverse).toBe(donor.function);
  });
  it.each([
    [{ kind: "f64" }, "f64"],
    [{ kind: "i64" }, "i64"],
    [{ kind: "externref" }, "externref"],
    [{ kind: "ref", typeIdx: 7 }, "ref_7"],
    [{ kind: "ref_null", typeIdx: 7 }, "ref_null_7"],
  ] as const)("retains actual key, field identity and cache ordering for %j", (input, key) => {
    const value: ValType = { ...input };
    const keySpy = vi.spyOn(bodies, "refCellTypeKey"),
      bodySpy = vi.spyOn(bodies, "createRefCellType");
    const module = createEmptyModule();
    module.types.push({ kind: "struct", name: "prefix", fields: [] });
    const map = new Map<string, number>();
    const ctx = { mod: module, refCellTypeMap: map } as unknown as CodegenContext;
    expect(getOrRegisterRefCellType(ctx, value)).toBe(1);
    expect(map.get(key)).toBe(1);
    expect(module.types[1]).toStrictEqual({
      kind: "struct",
      name: `__ref_cell_${key}`,
      fields: [{ name: "value", type: value, mutable: true }],
    });
    const type = module.types[1]!;
    if (type.kind !== "struct") throw new Error("cell is not a struct");
    expect(type.fields[0]!.type).toBe(value);
    expect(getOrRegisterRefCellType(ctx, { ...value })).toBe(1);
    expect(module.types).toHaveLength(2);
    expect(keySpy).toHaveBeenCalledTimes(2);
    expect(bodySpy).toHaveBeenCalledTimes(1);
    expect(bodySpy).toHaveBeenCalledWith(key, value);
  });
});

describe("issued scalar mutable-cell ownership", () => {
  it.each([false, true])("retains every actual allocation and boxed capture, decoded=%s", (decoded) => {
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const plan = requirements(program),
      expected = actualCells(program);
    expect(expected.length).toBeGreaterThan(0);
    expect(plan.refCells.map((row) => row.inner.kind).sort()).toEqual(["f64", "i32"]);
    expect(plan.gaps).toEqual([]);
    expect(plan.refCellAllocations).toHaveLength(expected.length);
    plan.refCellAllocations.forEach((row, index) => {
      const occurrence = plan.demands.occurrences[row.occurrence]!,
        region = plan.demands.buffers[occurrence.bufferIndex]!;
      expect(occurrence.instruction).toBe(expected[index]!.instruction);
      expect(region.view).toBe(expected[index]!.view);
      expect(row.ownerUnitId).toBe(expected[index]!.ownerUnitId);
      expect(row.rawAllocationId).toBe(occurrence.instruction.alloc);
      expect(row.refCellId).not.toBeNull();
    });
  });

  it.each([false, true])("executes actual issued cell mutation/identity with rec prefix=%s", (recPrefix) => {
    const f = fixture(),
      { tx, module } = f;
    if (recPrefix)
      tx.reserveType("prefix", {
        kind: "rec",
        types: [
          { kind: "struct", name: "first", fields: [] },
          { kind: "struct", name: "second", fields: [] },
        ],
      });
    const pack = reserveNativeRefCells(tx, f.requirements);
    const cell = resolveNativeRefCell(tx, pack, { kind: "f64" });
    if (!cell) throw new Error("real source f64 cell not reserved");
    expect(cell.typeIdx).toBe(recPrefix ? 2 : 0);
    if (recPrefix) expect(module.types[1]).toBe(pack.types[0]!.type.object);
    const fn = tx.reserveFunction("mutate", "mutate", { params: [{ kind: "f64" }], results: [{ kind: "f64" }] });
    tx.freezeReservations();
    tx.fillFunction(fn, {
      locals: [
        { name: "cell", type: { kind: "ref_null", typeIdx: cell.typeIdx } },
        { name: "alias", type: { kind: "ref_null", typeIdx: cell.typeIdx } },
      ],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: cell.typeIdx },
        { op: "local.tee", index: 1 },
        { op: "local.set", index: 2 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 0 },
        { op: "f64.const", value: 7 },
        { op: "f64.add" },
        { op: "struct.set", typeIdx: cell.typeIdx, fieldIdx: 0 },
        { op: "local.get", index: 2 },
        { op: "struct.get", typeIdx: cell.typeIdx, fieldIdx: 0 },
      ],
    });
    tx.defineExport("export", "mutate", fn);
    expect(requireNativeRefCells(tx, pack, f.requirements)).toBe(pack);
    tx.seal();
    expect(requireNativeRefCells(tx, pack, f.requirements)).toBe(pack);
    const bytes = emitBinary(module);
    expect(WebAssembly.validate(bytes)).toBe(true);
    const mutate = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.mutate as (value: number) => number;
    expect(mutate(3)).toBe(10);
    expect(mutate(40)).toBe(47);
    expect(mutate(3)).toBe(10);
  });

  it.each(["copied-pack", "foreign-ledger", "other-issued-requirements", "copied-requirements"] as const)(
    "rejects %s",
    (mutation) => {
      const f = fixture(),
        pack = reserveNativeRefCells(f.tx, f.requirements);
      expect(requireNativeRefCells(f.tx, pack, f.requirements)).toBe(pack);
      const tx = mutation === "foreign-ledger" ? fixture().tx : f.tx;
      const plan =
        mutation === "other-issued-requirements"
          ? requirements()
          : mutation === "copied-requirements"
            ? { ...f.requirements }
            : f.requirements;
      expect(() => requireNativeRefCells(tx, mutation === "copied-pack" ? { ...pack } : pack, plan)).toThrow(
        "foreign, copied or substituted",
      );
    },
  );
  it.each(["name", "inner", "mutability", "field-population", "replacement"] as const)(
    "rejects changed cell %s",
    (mutation) => {
      const f = fixture(),
        pack = reserveNativeRefCells(f.tx, f.requirements),
        row = pack.types[0]!;
      expect(requireNativeRefCells(f.tx, pack, f.requirements)).toBe(pack);
      const type = row.type.object;
      if (type.kind !== "struct") throw new Error("actual cell struct missing");
      if (mutation === "name") type.name = "borrowed";
      if (mutation === "inner") type.fields[0]!.type = { kind: "externref" };
      if (mutation === "mutability") type.fields[0]!.mutable = false;
      if (mutation === "field-population") type.fields.push({ name: "extra", type: { kind: "i32" }, mutable: true });
      if (mutation === "replacement") f.module.types[row.type.typeIndex] = structuredClone(type);
      expect(() => requireNativeRefCells(f.tx, pack, f.requirements)).toThrow();
    },
  );
  it.each(["duplicate", "frozen", "sealed"] as const)("refuses %s reservation without allocation", (phase) => {
    const f = fixture();
    reserveNativeRefCells(f.tx, f.requirements);
    if (phase !== "duplicate") f.tx.freezeReservations();
    if (phase === "sealed") f.tx.seal();
    noAllocation(f, () => reserveNativeRefCells(f.tx, f.requirements), /key|reserving/);
  });
  it("preflights the actual late cell key before allocating its earlier type", () => {
    const f = fixture();
    expect(f.requirements.refCells).toHaveLength(2);
    const late = f.requirements.refCells[1]!;
    f.tx.reserveType(`${f.requirements.key}:ref-cell:${late.id}`, { kind: "struct", name: "existing", fields: [] });
    noAllocation(f, () => reserveNativeRefCells(f.tx, f.requirements), /key/);
  });
  it("refuses a stale exact source before any cell reservation", () => {
    const f = editable(),
      physical = fixture(f.program);
    const cell = actualCells(f.program)[0]!.instruction;
    Object.assign(cell, { value: cell.result });
    noAllocation(physical, () => reserveNativeRefCells(physical.tx, physical.requirements), /changed after selection/);
  });
  it("resolves only the actual scalar and allocation association", () => {
    const f = fixture(),
      pack = reserveNativeRefCells(f.tx, f.requirements);
    const row = f.requirements.refCellAllocations.find((row) => row.refCellId === "f64")!;
    expect(resolveNativeRefCell(f.tx, pack, { kind: "f64" }, row.rawAllocationId)).not.toBeNull();
    expect(resolveNativeRefCell(f.tx, pack, { kind: "ref", typeIdx: 0 })).toBeNull();
    const closure = f.requirements.allocations[0]!;
    expect(() => resolveNativeRefCell(f.tx, pack, { kind: "f64" }, closure.rawAllocationId)).toThrow(
      "source cell association",
    );
  });
});

describe("actual cell allocation consistency", () => {
  it.each(["missing-id", "wrong-kind", "wrong-registry-type", "duplicate-site", "borrowed-owner"] as const)(
    "rejects %s after the genuine population",
    (mutation) => {
      const f = editable(),
        cells = actualCells(f.program),
        first = cells[0]!.instruction;
      if (mutation === "missing-id") Object.assign(first, { alloc: undefined });
      if (mutation === "wrong-kind") Object.assign(first, { alloc: f.positive.allocations[0]!.rawAllocationId });
      if (mutation === "wrong-registry-type") {
        const row = f.program.allocations.entries[first.alloc!]!;
        if (row.state !== "live") throw new Error("actual live cell row missing");
        Object.assign(row.site, { type: { kind: "boxed", inner: { kind: "val", val: { kind: "externref" } } } });
      }
      if (mutation === "duplicate-site" || mutation === "borrowed-owner") {
        const owner = f.program.ir.functions.find((fn) => fn.name === "twoCells")!;
        const actual = cells.filter(
          (row) =>
            row.view === "program" &&
            row.ownerUnitId === owner.unitId &&
            row.instruction.resultType?.kind === "boxed" &&
            row.instruction.resultType.inner.kind === "val" &&
            row.instruction.resultType.inner.val.kind === "f64",
        );
        expect(actual).toHaveLength(2);
        expect(actual[0]!.instruction.result).not.toBe(actual[1]!.instruction.result);
        expect(actual[0]!.instruction.value).not.toBe(actual[1]!.instruction.value);
        expect(actual[0]!.instruction.alloc).not.toBe(actual[1]!.instruction.alloc);
        const foreignOwner = f.program.ir.functions.find((fn) => fn.name === "numberCell")!;
        const foreign = cells.filter((row) => row.view === "program" && row.ownerUnitId === foreignOwner.unitId);
        expect(foreign).toHaveLength(1);
        expect(foreignOwner.unitId).not.toBe(owner.unitId);
        expect(foreign[0]!.instruction.resultType).toEqual(actual[1]!.instruction.resultType);
        expect(foreign[0]!.instruction.alloc).not.toBe(actual[1]!.instruction.alloc);
        // Borrow only the allocation ID; preserve both actual sites' SSA definitions and operands.
        const borrowed = mutation === "duplicate-site" ? actual[0]!.instruction.alloc : foreign[0]!.instruction.alloc;
        Object.assign(actual[1]!.instruction, { alloc: borrowed });
      }
      expect(() => requirements(f.program)).toThrow(
        mutation === "duplicate-site"
          ? /distinct executable cell allocations/
          : mutation === "borrowed-owner"
            ? /borrowed by another owner/
            : /allocation/,
      );
    },
  );
  it("preserves an authentic allocation alias and both representation coordinates", () => {
    const f = editable(),
      cells = actualCells(f.program),
      first = cells[0]!.instruction;
    const registry = AllocSiteRegistry.fromSnapshot(f.program.allocations),
      canonical = first.alloc!;
    const alias = registry.fresh("refcell", first.resultType!);
    registry.alias(alias, canonical);
    Object.assign(f.program, { allocations: registry.captureSnapshot() });
    for (const row of cells) if (row.instruction.alloc === canonical) Object.assign(row.instruction, { alloc: alias });
    const plan = requirements(f.program);
    const aliased = plan.refCellAllocations.filter((row) => row.rawAllocationId === alias);
    expect(aliased).toHaveLength(2);
    expect(aliased.every((row) => row.allocationId === canonical)).toBe(true);
    expect(plan.gaps).toEqual([]);
  });
});
