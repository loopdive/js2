// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { buildNativePrototypeType } from "../src/runtime/wasmgc/values/prototype-layouts.js";
import {
  declareNativePrototypeLayouts,
  reserveNativePrototypeLayouts,
  requireNativePrototypeLayouts,
  nativePrototypeLayoutReservationInventory,
} from "../src/backend/wasmgc/resources/native-prototype-layouts.js";

function fixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const requirements = { key: "prototype" },
    plan = declareNativePrototypeLayouts(requirements);
  const pack = reserveNativePrototypeLayouts(tx, requirements, plan);
  return { module, tx, requirements, plan, pack };
}
it("declares the exact six mutable donor fields with deeply frozen fresh recipes", () => {
  const f = fixture();
  expect(f.plan.declarations[0]).toMatchObject({ shape: buildNativePrototypeType() });
  expect(f.pack.prototype.object).toEqual(buildNativePrototypeType());
  expect(Object.isFrozen(f.plan)).toBe(true);
  expect(Object.isFrozen(f.plan.declarations[0])).toBe(true);
  const declaration = f.plan.declarations[0]!;
  if (declaration.space !== "type" || declaration.shape.kind !== "struct") throw new Error("expected struct");
  expect(Object.isFrozen(declaration.shape)).toBe(true);
  expect(Object.isFrozen(declaration.shape.fields)).toBe(true);
  for (const field of declaration.shape.fields) {
    expect(Object.isFrozen(field)).toBe(true);
    expect(Object.isFrozen(field.type)).toBe(true);
  }
  const next = declareNativePrototypeLayouts(f.requirements);
  expect(next).toEqual(f.plan);
  expect(next).not.toBe(f.plan);
  expect(nativePrototypeLayoutReservationInventory(f.tx, f.pack, f.plan, f.requirements)).toEqual([f.pack.prototype]);
});
it.each([false, true])("executes all six mutable fields with a real ledger type, prefix=%s", (prefix) => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (prefix) tx.reserveType("prefix", { kind: "struct", name: "prefix", fields: [] });
  const requirements = { key: "prototype" },
    plan = declareNativePrototypeLayouts(requirements);
  const pack = reserveNativePrototypeLayouts(tx, requirements, plan),
    typeIdx = pack.prototype.typeIndex;
  const fields: ValType[] = [
    { kind: "i32" },
    { kind: "i32" },
    ...Array.from({ length: 4 }, (): ValType => ({ kind: "externref" })),
  ];
  const make = tx.reserveFunction("make", "make", { params: fields, results: [{ kind: "externref" }] });
  const reads = fields.map((type, i) =>
    tx.reserveFunction("read" + i, "read" + i, { params: [{ kind: "externref" }], results: [type] }),
  );
  const writes = fields.map((type, i) =>
    tx.reserveFunction("write" + i, "write" + i, { params: [{ kind: "externref" }, type], results: [] }),
  );
  tx.freezeReservations();
  const receiver = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
  ];
  tx.fillFunction(make, {
    locals: [],
    body: [
      ...fields.map((_, index): Instr => ({ op: "local.get", index })),
      { op: "struct.new", typeIdx },
      { op: "extern.convert_any" },
    ],
  });
  fields.forEach((_, i) => {
    tx.fillFunction(reads[i]!, { locals: [], body: [...receiver(), { op: "struct.get", typeIdx, fieldIdx: i }] });
    tx.fillFunction(writes[i]!, {
      locals: [],
      body: [...receiver(), { op: "local.get", index: 1 }, { op: "struct.set", typeIdx, fieldIdx: i }],
    });
    tx.defineExport("read-export" + i, "read" + i, reads[i]!);
    tx.defineExport("write-export" + i, "write" + i, writes[i]!);
  });
  tx.defineExport("make-export", "make", make);
  requireNativePrototypeLayouts(tx, pack, plan, requirements);
  tx.seal();
  requireNativePrototypeLayouts(tx, pack, plan, requirements);
  const bytes = emitBinary(module);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const initial = [17, 1, { constructor: true }, null, "a,b", "Object"],
    changed = [29, 0, null, { parent: true }, undefined, "Changed"];
  const value = exports.make!(...initial);
  fields.forEach((_, i) => expect(exports["read" + i]!(value)).toBe(initial[i]));
  fields.forEach((_, i) => exports["write" + i]!(value, changed[i]));
  fields.forEach((_, i) => expect(exports["read" + i]!(value)).toBe(changed[i]));
});
it.each(["pack", "plan", "requirements", "ledger", "copied pack with foreign token"] as const)(
  "refuses substituted %s identity",
  (kind) => {
    const f = fixture(),
      other = fixture();
    expect(() =>
      requireNativePrototypeLayouts(
        kind === "ledger" ? other.tx : f.tx,
        kind === "pack"
          ? { ...f.pack }
          : kind === "copied pack with foreign token"
            ? { prototype: other.pack.prototype }
            : f.pack,
        kind === "plan" ? structuredClone(f.plan) : f.plan,
        kind === "requirements" ? { ...f.requirements } : f.requirements,
      ),
    ).toThrow(/foreign|substituted/);
  },
);
it("refuses stale requirements", () => {
  const f = fixture();
  f.requirements.key = "changed";
  expect(() => requireNativePrototypeLayouts(f.tx, f.pack, f.plan, f.requirements)).toThrow(/stale/);
});
it("refuses a changed source plan retained by identity", () => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module),
    requirements = { key: "prototype" };
  const plan = structuredClone(declareNativePrototypeLayouts(requirements));
  const pack = reserveNativePrototypeLayouts(tx, requirements, plan);
  Reflect.set(plan, "declarations", []);
  expect(() => requireNativePrototypeLayouts(tx, pack, plan, requirements)).toThrow();
});
it.each(["reserving", "filling", "sealed"] as const)("detects physical field drift while %s", (phase) => {
  const f = fixture();
  if (phase !== "reserving") f.tx.freezeReservations();
  if (phase === "sealed") f.tx.seal();
  const shape = f.pack.prototype.object;
  if (shape.kind !== "struct") throw new Error("expected genuine prototype struct");
  expect(Reflect.set(shape.fields[0]!, "mutable", false)).toBe(true);
  expect(() => requireNativePrototypeLayouts(f.tx, f.pack, f.plan, f.requirements)).toThrow();
});
it.each(["shape", "phase", "duplicate"] as const)("refuses %s before adding layout records", (kind) => {
  const f = fixture(),
    before = structuredClone(f.module),
    plan = structuredClone(f.plan);
  if (kind === "shape") {
    const declaration = plan.declarations[0]!;
    if (declaration.space !== "type" || declaration.shape.kind !== "struct") throw new Error("expected struct");
    expect(Reflect.set(declaration.shape.fields[0]!, "mutable", false)).toBe(true);
  }
  if (kind === "phase") f.tx.freezeReservations();
  expect(() => reserveNativePrototypeLayouts(f.tx, f.requirements, plan)).toThrow(
    kind === "shape" ? /substituted declaration plan/ : undefined,
  );
  expect(f.module).toEqual(before);
});
it("rejects an accessor resource key without invoking it", () => {
  let calls = 0;
  expect(() =>
    declareNativePrototypeLayouts({
      get key() {
        calls++;
        return "prototype";
      },
    }),
  ).toThrow(/non-data/);
  expect(calls).toBe(0);
});
