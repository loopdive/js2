// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../src/wasm/physical/module-reservations.js";

function setup() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const fn = tx.reserveFunction("complete:fn", "completeFn", { params: [], results: [] });
  const global = tx.reserveGlobal("complete:global", "completeGlobal", { kind: "i32" }, false);
  return { module, tx, fn, global };
}
function filled() {
  const value = setup();
  value.tx.freezeReservations();
  value.tx.fillFunction(value.fn, { locals: [], body: [] });
  value.tx.fillGlobal(value.global, [{ op: "i32.const", value: 7 }]);
  return value;
}

it("checks actual fills before and after seal without allocating or publishing", () => {
  const { module, tx, fn, global } = filled();
  for (const phase of ["filling", "sealed"] as const) {
    if (phase === "sealed") tx.seal();
    const before = structuredClone(module),
      bodies = fn.object.body,
      locals = fn.object.locals,
      init = global.object.init;
    expect(tx.assertCompletedReservation(fn)).toBeUndefined();
    expect(tx.assertCompletedReservation(global)).toBeUndefined();
    expect(tx.state).toBe(phase);
    expect(module).toStrictEqual(before);
    expect(fn.object.body).toBe(bodies);
    expect(fn.object.locals).toBe(locals);
    expect(global.object.init).toBe(init);
  }
});

it("does not demand completion of an unrelated reserved function", () => {
  const { tx, fn, global } = setup();
  const pending = tx.reserveFunction("pending", "pending", { params: [], results: [] });
  tx.freezeReservations();
  tx.fillFunction(fn, { locals: [], body: [] });
  tx.fillGlobal(global, [{ op: "i32.const", value: 7 }]);
  expect(() => tx.assertCompletedReservation(fn)).not.toThrow();
  expect(() => tx.assertCompletedReservation(global)).not.toThrow();
  expect(tx.physicalIndex(pending)).toBeGreaterThanOrEqual(0);
  expect(() => tx.assertCompletedReservation(pending)).toThrow("missing function fill pending");
});

it.each(["function", "global"] as const)("index existence is not %s completion", (kind) => {
  const positive = filled();
  expect(() =>
    positive.tx.assertCompletedReservation(kind === "function" ? positive.fn : positive.global),
  ).not.toThrow();
  const { tx, fn, global } = setup();
  tx.freezeReservations();
  const token = kind === "function" ? fn : global;
  expect(tx.physicalIndex(token)).toBeGreaterThanOrEqual(0);
  expect(() => tx.assertCompletedReservation(token)).toThrow(`missing ${kind} fill ${token.key}`);
  expect(tx.state).toBe("failed");
});

it.each(["function", "global"] as const)("rejects %s completion while reserving", (kind) => {
  const { tx, fn, global } = setup();
  expect(() => tx.assertCompletedReservation(kind === "function" ? fn : global)).toThrow(
    "completion requested in reserving",
  );
});

for (const kind of ["function", "global"] as const)
  for (const mutation of ["copied", "foreign"] as const) {
    it(`rejects ${mutation} ${kind} tokens after genuine completion`, () => {
      const a = filled(),
        token = kind === "function" ? a.fn : a.global;
      expect(() => a.tx.assertCompletedReservation(token)).not.toThrow();
      const b = filled(),
        other = kind === "function" ? b.fn : b.global;
      expect(() => a.tx.assertCompletedReservation(mutation === "copied" ? { ...token } : other)).toThrow(
        "foreign or forged reservation token",
      );
    });
  }

it("rejects a genuine owned token of the wrong resource kind", () => {
  const { tx, fn, global } = setup();
  const type = tx.reserveType("not-a-fill", { kind: "struct", name: "NotAFill", fields: [] });
  tx.freezeReservations();
  tx.fillFunction(fn, { locals: [], body: [] });
  tx.fillGlobal(global, [{ op: "i32.const", value: 7 }]);
  expect(() => tx.assertCompletedReservation(fn)).not.toThrow();
  expect(() => tx.assertCompletedReservation(type as unknown as FunctionReservation)).toThrow(
    "completion requires a defined function or global",
  );
});

it.each(["body", "locals", "initializer", "descriptor"] as const)("rejects altered completed %s", (mutation) => {
  const { tx, fn, global } = filled();
  tx.assertCompletedReservation(fn);
  tx.assertCompletedReservation(global);
  if (mutation === "body") fn.object.body = [...fn.object.body];
  if (mutation === "locals") fn.object.locals = [...fn.object.locals];
  if (mutation === "initializer") global.object.init = [...global.object.init];
  if (mutation === "descriptor") global.object.mutable = true;
  expect(() =>
    tx.assertCompletedReservation(mutation === "initializer" || mutation === "descriptor" ? global : fn),
  ).toThrow(/altered/);
});
