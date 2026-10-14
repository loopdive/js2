// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeNumberUndefinedGc,
  fillNativeNumberUndefinedGc,
  requireCompletedNativeNumberUndefinedGc,
  emitNativeNumberUndefinedGc,
} from "../src/backend/wasmgc/resources/native-number-undefined.js";
import { emitBinary } from "../src/emit/binary.js";
import { irDynamic } from "../src/ir/core/types.js";
import { asValueId, type IrInstr } from "../src/ir/core/nodes.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";

const undefinedInstruction: Extract<IrInstr, { kind: "const" }> = {
  kind: "const",
  value: { kind: "undefined" },
  result: asValueId(0),
  resultType: irDynamic(JS_TAG_IDS.Undefined),
};

describe("genuine native Number/Undefined GC resource reservations", () => {
  it("GC uses the canonical five-field tag carrier and genuine singleton global", async () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const pack = reserveNativeNumberUndefinedGc(tx, "resource-probe");
    const probe = tx.reserveFunction("resource-probe:tag", "tag", { params: [], results: [{ kind: "i32" }] });
    expect(pack.carrier.object).toMatchObject({ kind: "struct", name: "AnyValue" });
    expect(pack.carrier.object.kind === "struct" && pack.carrier.object.fields.map((field) => field.name)).toEqual([
      "tag",
      "i32val",
      "f64val",
      "refval",
      "externval",
    ]);
    expect(module.types.some((type) => type.kind === "struct" && type.name === "__box_number_struct")).toBe(false);
    tx.freezeReservations();
    fillNativeNumberUndefinedGc(tx, pack);
    const value = emitNativeNumberUndefinedGc(tx, pack, undefinedInstruction, [], () => {
      throw Error("unexpected scratch");
    });
    tx.fillFunction(probe, {
      locals: [],
      body: [...value, { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 0 }],
    });
    tx.defineExport("resource-probe:export", "tag", probe);
    requireCompletedNativeNumberUndefinedGc(tx, pack);
    tx.seal();
    const binary = emitBinary(module);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(binary).buffer), {});
    expect((instance.exports.tag as () => number)()).toBe(Number(JS_TAG_IDS.Undefined));
    expect(pack.singleton.object.init).toMatchObject([
      { op: "i32.const", value: Number(JS_TAG_IDS.Undefined) },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: NaN },
      { op: "ref.null" },
      { op: "ref.null.extern" },
      { op: "struct.new" },
    ]);
  });

  it("GC refuses an unfilled singleton before any body emission", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const pack = reserveNativeNumberUndefinedGc(tx, "unfilled");
    tx.freezeReservations();
    expect(() => emitNativeNumberUndefinedGc(tx, pack, undefinedInstruction, [], () => 0)).toThrow(
      "missing global fill",
    );
  });

  it("GC refuses foreign reservation ownership", () => {
    const one = new PhysicalModuleReservations(createEmptyModule()),
      two = new PhysicalModuleReservations(createEmptyModule());
    const pack = reserveNativeNumberUndefinedGc(one, "foreign");
    one.freezeReservations();
    two.freezeReservations();
    expect(() => fillNativeNumberUndefinedGc(two, pack)).toThrow("foreign pack");
  });

  it("GC refuses an exact NumberI32 probe instead of aliasing it to NumberF64", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const pack = reserveNativeNumberUndefinedGc(tx, "exact-tag");
    tx.freezeReservations();
    fillNativeNumberUndefinedGc(tx, pack);
    expect(() =>
      emitNativeNumberUndefinedGc(
        tx,
        pack,
        {
          kind: "tag.test",
          value: asValueId(0),
          result: asValueId(1),
          tagId: JS_TAG_IDS.NumberI32,
          resultType: { kind: "val", val: { kind: "i32" } },
        },
        [[{ op: "global.get", index: tx.physicalIndex(pack.singleton) }]],
        () => 0,
      ),
    ).toThrow("unsupported tag probe");
  });

  it("GC detects mutation of the actual reserved carrier", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const pack = reserveNativeNumberUndefinedGc(tx, "changed");
    tx.freezeReservations();
    fillNativeNumberUndefinedGc(tx, pack);
    if (pack.carrier.object.kind !== "struct") throw Error("missing actual struct");
    pack.carrier.object.fields[0]!.name = "changed-tag";
    expect(() => requireCompletedNativeNumberUndefinedGc(tx, pack)).toThrow("altered type descriptor");
  });
});

async function linearFixture() {
  const { analyzeMultiSource } = await import("../src/checker/index.js");
  const { prepareWholeIrProgram } = await import("../src/ir/program-preparation.js");
  const memory = await import("../src/backend/linear/program/memory.js");
  const ast = analyzeMultiSource(
    { "./entry.ts": "export function run():number{const a=[2];const v=a[99];return v===undefined?1:0;}" },
    "./entry.ts",
  );
  const policy = { backend: "linear" as const, target: "standalone" as const };
  const prepared = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const options = {
    ...policy,
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "resource-test",
  };
  const result = memory.planPreparedLinearMemory({
    program: prepared.program,
    projection: prepared.program.runtime[0]!,
    options,
  });
  if (result.kind !== "supported") throw Error(JSON.stringify(result));
  return { memory, program: prepared.program, plan: result.plan };
}

describe("issued native Number/Undefined Linear resource pack", () => {
  it("joins actual box sites, singleton bytes and the empty aggregate prefix", async () => {
    const f = await linearFixture(),
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    expect(f.plan.numberUndefined?.boxes.length).toBeGreaterThan(0);
    const singleton = f.plan.numberUndefined!.singleton;
    expect(singleton.bytes).toHaveLength(16);
    expect(f.plan.heapPointer!.floor).toBe(singleton.offset + singleton.bytes.length);
    const data = new DataView(new Uint8Array(singleton.bytes).buffer);
    expect(data.getInt32(0, true)).toBe(Number(JS_TAG_IDS.Undefined));
    expect(Number.isNaN(data.getFloat64(8, true))).toBe(true);
    const pack = f.memory.reservePreparedLinearMemory(
      tx,
      f.plan,
      () => {},
      (token) => {
        expect(module.dataSegments).toHaveLength(token ? 1 : 0);
        if (token) expect(module.dataSegments[0]).toBe(token.object);
      },
    );
    tx.freezeReservations();
    const bindings = f.memory.preparedLinearMemoryBindings(tx, pack).numberUndefined!;
    f.memory.fillPreparedLinearMemory(tx, pack);
    bindings.assertCurrent();
    for (const box of f.plan.numberUndefined!.boxes)
      expect(bindings.requireBox(box.allocationId as Parameters<typeof bindings.requireBox>[0]).layoutId).toBe(
        "record:box:scalar:f64",
      );
    f.memory.requireCompletedPreparedLinearMemory(tx, pack);
    tx.seal();
  });

  it("refuses an unknown actual static prefix before reservations are bound", async () => {
    const f = await linearFixture(),
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    tx.reserveDataSegment("unexpected-prefix", { offset: 1024, bytes: new Uint8Array(32) });
    expect(() =>
      f.memory.reservePreparedLinearMemory(
        tx,
        f.plan,
        () => {},
        () => {
          if (module.dataSegments.length) throw Error("unknown actual prefix");
        },
      ),
    ).toThrow("unknown actual prefix");
    expect(module.memories).toEqual([]);
    expect(module.exports).toEqual([]);
  });

  it("requires the actual prefix audit and rejects a copied issued descriptor", async () => {
    const a = await linearFixture(),
      tx = new PhysicalModuleReservations(createEmptyModule());
    expect(() => a.memory.reservePreparedLinearMemory(tx, a.plan, () => {})).toThrow(
      "actual aggregate static-prefix audit",
    );
    const b = await linearFixture();
    expect(() =>
      b.memory.reservePreparedLinearMemory(
        new PhysicalModuleReservations(createEmptyModule()),
        { ...b.plan },
        () => {},
        () => {},
      ),
    ).toThrow("unknown or consumed issued plan");
  });

  it("revokes the numeric bindings with the original emission attempt", async () => {
    const f = await linearFixture(),
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    let active = true;
    const pack = f.memory.reservePreparedLinearMemory(
      tx,
      f.plan,
      () => {
        if (!active) throw Error("attempt revoked");
      },
      (token) => {
        if (module.dataSegments.length !== (token ? 1 : 0)) throw Error("prefix changed");
      },
    );
    tx.freezeReservations();
    const bindings = f.memory.preparedLinearMemoryBindings(tx, pack).numberUndefined!;
    f.memory.fillPreparedLinearMemory(tx, pack);
    active = false;
    expect(() => bindings.assertCurrent()).toThrow("attempt revoked");
    expect(module.exports).toHaveLength(1); // Only the already-planned memory export; no program body/export was published.
  });
});
