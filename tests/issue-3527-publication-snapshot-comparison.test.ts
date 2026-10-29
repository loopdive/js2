// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import type { Instr } from "../src/wasm/model/instructions.js";
function nan(word: number) {
  const d = new DataView(new ArrayBuffer(8));
  d.setUint32(0, word, true);
  d.setUint32(4, 0x7ff80000, true);
  return d.getFloat64(0, true);
}
function fixture(kind: string, audit: object) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  tx.reserveType("record", { kind: "struct", name: "record", fields: [] });
  const fn = tx.reserveFunction("fn", "fn", { params: [], results: [] });
  const global = tx.reserveGlobal("g", "g", { kind: "f64" }, false);
  const table = tx.reserveTable("table", { elementType: "funcref", min: 1 });
  const descriptor = Object.assign({ start: 0, end: 0, abiVersion: 2 }, kind === "recgroup" ? { audit } : {});
  tx.reserveCanonicalRuntimeRecGroup("rec", descriptor);
  tx.freezeReservations();
  tx.fillFunction(fn, { locals: [], body: [] });
  const init: Instr[] = [{ op: "f64.const", value: nan(1) }];
  if (kind === "global") Object.assign(init, { audit });
  tx.fillGlobal(global, init);
  const offset: Instr[] = [{ op: "i32.const", value: 0 }];
  if (kind === "element") Object.assign(offset, { audit });
  tx.defineElement("element", table, offset, [fn]);
  const exported = tx.defineExport("export", "f", fn);
  return { tx, fn, global, init, offset, exported };
}
for (const kind of ["global", "element", "recgroup"]) {
  it.each(["nan", "zero", "undefined", "nested", "hole", "order", "bytes"])(
    `${kind} rejects changed %s after repeated successful audits`,
    (change) => {
      const audit = {
        number: change === "zero" ? 0 : nan(1),
        nested: { value: 1 },
        array: Object.assign(new Array(2), { 1: 7 }),
        first: 1,
        second: 2,
        bytes: new Uint8Array([1, 2]),
      };
      const f = fixture(kind, audit);
      f.tx.assertCompletedReservation(f.fn);
      f.tx.assertCompletedReservation(f.fn);
      if (change === "nan") audit.number = nan(2);
      if (change === "zero") audit.number = -0;
      if (change === "undefined") Object.assign(audit, { present: undefined });
      if (change === "nested") audit.nested.value = 2;
      if (change === "hole") audit.array[0] = undefined;
      if (change === "order") {
        Reflect.deleteProperty(audit, "first");
        audit.first = 1;
      }
      if (change === "bytes") audit.bytes[0] = 2;
      expect(() => f.tx.assertCompletedReservation(f.fn)).toThrow(/altered/);
      expect(f.tx.state).toBe("failed");
    },
  );
  it(`${kind} visits later children even after an earlier mismatch`, () => {
    const events: string[] = [];
    const audit = { early: 1, later: { value: 1 }, tail: 3 };
    const f = fixture(kind, audit);
    f.tx.assertCompletedReservation(f.fn);
    audit.early = 2;
    Object.defineProperty(audit.later, "value", {
      enumerable: true,
      get() {
        events.push("child");
        throw Error("late sentinel");
      },
    });
    Object.defineProperty(audit, "tail", {
      enumerable: true,
      get() {
        events.push("tail");
        return 3;
      },
    });
    expect(() => f.tx.assertCompletedReservation(f.fn)).toThrow("late sentinel");
    expect(events).toEqual(["tail", "child"]);
  });
  it(`${kind} preserves cyclic child failure after an earlier mismatch`, () => {
    const audit: { early: number; child: unknown } = { early: 1, child: {} };
    const f = fixture(kind, audit);
    audit.early = 2;
    audit.child = audit;
    expect(() => f.tx.assertCompletedReservation(f.fn)).toThrow("cyclic physical descriptor");
  });
}
it("detects actual f64 global initializer NaN payload changes", () => {
  const f = fixture("global", {});
  f.tx.assertCompletedReservation(f.global);
  const instr = f.init[0]!;
  if (instr.op !== "f64.const") throw Error("wrong positive constant");
  instr.value = nan(2);
  expect(() => f.tx.assertCompletedReservation(f.global)).toThrow("altered completed global g");
});

it("detects a retained export descriptor change after repeated public audits", () => {
  const f = fixture("global", {});
  f.tx.assertCompletedReservation(f.fn);
  f.tx.assertCompletedReservation(f.fn);
  f.exported.desc.index++;
  expect(() => f.tx.assertCompletedReservation(f.fn)).toThrow("altered publication descriptor");
  expect(f.tx.state).toBe("failed");
});
