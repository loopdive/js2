// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  requireNativeBigIntReservations,
  fillNativeBigIntResources,
  requireCompletedNativeBigInt,
  nativeBigIntReservationInventory,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import {
  bigintOperandValues,
  bigintComparisonCases,
  fillBigIntOperands,
  reserveBigIntOperands,
  type BigIntOperand,
} from "./helpers/native-bigint-carrier-fixture.js";

function fixture(offset = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) {
    tx.reserveType("prefix", { kind: "struct", name: "Prefix", fields: [] });
    const prefix = tx.reserveFunction("prefix-function", "prefix", { params: [], results: [] });
    prefixFunctions.set(tx, prefix);
  }
  const plan = declareNativeBigIntResources("bigint"),
    pack = reserveNativeBigIntResources(tx, "bigint", plan);
  return { module, tx, plan, pack };
}
const prefixFunctions = new WeakMap<
  PhysicalModuleReservations,
  ReturnType<PhysicalModuleReservations["reserveFunction"]>
>();
function complete() {
  const f = fixture();
  f.tx.freezeReservations();
  fillNativeBigIntResources(f.tx, f.pack);
  return f;
}
describe("issued canonical narrow and wide BigInt carriers", () => {
  it("declares, reserves and completes all seven resources without publication", () => {
    const f = fixture(true),
      inventory = nativeBigIntReservationInventory(f.tx, f.pack, f.plan);
    expect(inventory.plan.declarations).toHaveLength(7);
    expect(inventory.types).toHaveLength(3);
    expect(inventory.functions).toHaveLength(4);
    expect(f.pack.type.typeIndex).toBeGreaterThan(0);
    expect(f.pack.limbs.typeIndex).toBe(f.pack.type.typeIndex + 1);
    expect(f.pack.wide.typeIndex).toBe(f.pack.type.typeIndex + 2);
    expect(f.pack.type.object).toHaveProperty("superTypeIdx", -1);
    expect(f.pack.wide.object).toHaveProperty("superTypeIdx", f.pack.type.typeIndex);
    expect(Object.is(requireNativeBigIntReservations(f.tx, f.pack, f.plan), f.pack)).toBe(true);
    f.tx.freezeReservations();
    fillNativeBigIntResources(f.tx, f.pack);
    expect(Object.is(requireCompletedNativeBigInt(f.tx, f.pack, f.plan), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
  });
  it.each(["pack", "plan", "ledger"] as const)("rejects copied/foreign %s after a positive reservation", (role) => {
    const f = fixture();
    requireNativeBigIntReservations(f.tx, f.pack, f.plan);
    expect(() =>
      requireNativeBigIntReservations(
        role === "ledger" ? fixture().tx : f.tx,
        role === "pack" ? { ...f.pack } : f.pack,
        role === "plan" ? structuredClone(f.plan) : f.plan,
      ),
    ).toThrow();
  });
  it("preflights a late key collision before any type or function allocation", () => {
    const f = fixture();
    f.tx.reserveFunction("next:equal", "collision", { params: [], results: [] });
    const before = structuredClone(f.module);
    expect(() => reserveNativeBigIntResources(f.tx, "next", declareNativeBigIntResources("next"))).toThrow();
    expect(f.module).toStrictEqual(before);
  });
  it("rejects a changed carrier after a positive reservation", () => {
    const f = fixture();
    requireNativeBigIntReservations(f.tx, f.pack, f.plan);
    if (f.pack.type.object.kind !== "struct") throw Error("missing actual BigInt carrier");
    f.pack.type.object.fields[0]!.mutable = true;
    expect(() => requireNativeBigIntReservations(f.tx, f.pack, f.plan)).toThrow("altered carrier layout");
  });
  it.each(["limbs", "wide"] as const)("rejects changed %s layout after a positive reservation", (role) => {
    const f = fixture();
    requireNativeBigIntReservations(f.tx, f.pack, f.plan);
    const layout = f.pack[role].object;
    if (layout.kind === "array") layout.mutable = false;
    else if (layout.kind === "struct") layout.superTypeIdx = -1;
    else throw Error("missing actual carrier layout");
    expect(() => requireNativeBigIntReservations(f.tx, f.pack, f.plan)).toThrow("altered carrier layout");
  });
  it("does not complete an external matching fill", () => {
    const f = fixture();
    f.tx.freezeReservations();
    f.tx.fillFunction(f.pack.box, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: f.pack.type.typeIndex },
        { op: "extern.convert_any" },
      ],
    });
    expect(() => requireCompletedNativeBigInt(f.tx, f.pack, f.plan)).toThrow("missing canonical fill");
    expect(() => fillNativeBigIntResources(f.tx, f.pack)).toThrow("duplicate function fill");
  });
  it("rejects canonical body mutation after successful completion", () => {
    const f = complete();
    requireCompletedNativeBigInt(f.tx, f.pack, f.plan);
    f.pack.read.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeBigInt(f.tx, f.pack, f.plan)).toThrow("altered completed function");
  });
  it("rejects a repeated canonical fill", () => {
    const f = complete();
    expect(() => fillNativeBigIntResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
  });
});
function runtime() {
  const f = fixture(true);
  const operands = reserveBigIntOperands(f.tx);
  const equal = f.tx.reserveFunction("observer:equal", "equal", {
    params: [{ kind: "externref" }, { kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  f.tx.freezeReservations();
  fillNativeBigIntResources(f.tx, f.pack);
  f.tx.fillFunction(prefixFunctions.get(f.tx)!, { locals: [], body: [] });
  fillBigIntOperands(f.tx, f.pack, operands);
  f.tx.fillFunction(equal, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "call", funcIdx: f.pack.equal.handle },
    ],
  });
  requireCompletedNativeBigInt(f.tx, f.pack, f.plan);
  for (const role of ["box", "read", "isBigInt"] as const) f.tx.defineExport("export:" + role, role, f.pack[role]);
  for (const [name, token] of Object.entries({ equal, ...operands })) f.tx.defineExport("export:" + name, name, token);
  expect(f.tx.seal().completedFunctions).toBe(4 + 1 + 1 + Object.keys(operands).length);
  const module = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return new WebAssembly.Instance(module).exports as unknown as {
    box(value: bigint): object;
    read(value: unknown): bigint;
    isBigInt(value: unknown): number;
    equal(a: unknown, b: unknown): number;
  } & Record<BigIntOperand, () => object>;
}
let cached: ReturnType<typeof runtime> | undefined;
const actual = () => (cached ??= runtime());
describe("issued BigInt body execution", () => {
  it.each(bigintComparisonCases)("compares complete carrier values %s and %s", (a, b) => {
    const r = actual(),
      first = r[a](),
      second = r[b]();
    expect(Object.is(first, second)).toBe(false);
    expect(r.isBigInt(first)).toBe(1);
    expect(r.isBigInt(second)).toBe(1);
    expect(r.equal(first, second)).toBe(Number(bigintOperandValues[a] === bigintOperandValues[b]));
  });
  it("labels low-i64 reads as truncating while equality retains the high limbs", () => {
    const r = actual();
    expect(r.read(r.wide64())).toBe(0n);
    expect(r.equal(r.wide64(), r.zero())).toBe(0);
  });
  it.each([-(1n << 63n), -1n, 0n, 1n, (1n << 63n) - 1n])("round-trips signed payload %s", (value) => {
    const r = actual(),
      boxed = r.box(value);
    expect(r.isBigInt(boxed)).toBe(1);
    expect(r.read(boxed)).toBe(value);
  });
  it.each([null, undefined, {}, 0, true, "1", 1n])("never converts foreign %s to a fabricated payload", (value) => {
    const r = actual();
    expect(r.isBigInt(value)).toBe(0);
    expect(() => r.read(value)).toThrow(WebAssembly.RuntimeError);
  });
});
