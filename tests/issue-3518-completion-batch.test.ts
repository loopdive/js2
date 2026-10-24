// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../src/wasm/physical/module-reservations.js";

function fixture(fill = true) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const fn = tx.reserveFunction("fn", "fn", { params: [], results: [] });
  const global = tx.reserveGlobal("global", "global", { kind: "i32" }, false);
  const type = tx.reserveType("type", { kind: "struct", name: "Type", fields: [] });
  tx.freezeReservations();
  if (fill) {
    tx.fillFunction(fn, { locals: [], body: [] });
    tx.fillGlobal(global, [{ op: "i32.const", value: 7 }]);
  }
  return { module, tx, fn, global, type };
}

it("authenticates mixed completion in filling and sealed phases without publication", () => {
  const { module, tx, fn, global } = fixture();
  const before = structuredClone(module);
  for (const phase of ["filling", "sealed"] as const) {
    if (phase === "sealed") tx.seal();
    tx.assertCompletedReservations([global, fn, global]);
    tx.assertCompletedReservations([]);
    expect(tx.state).toBe(phase);
    expect(module).toEqual(before);
  }
});

it.each(["copied", "foreign", "type", "unfilled-function", "unfilled-global"] as const)("rejects a late %s", (kind) => {
  const a = fixture(!kind.startsWith("unfilled"));
  const invalid =
    kind === "copied"
      ? { ...a.fn }
      : kind === "foreign"
        ? fixture().fn
        : kind === "type"
          ? a.type
          : kind === "unfilled-global"
            ? a.global
            : a.fn;
  expect(() => a.tx.assertCompletedReservations([invalid as FunctionReservation])).toThrow(
    kind === "type"
      ? /defined function or global/
      : kind.startsWith("unfilled")
        ? /missing .* fill/
        : /foreign or forged/,
  );
  expect(a.tx.state).toBe("failed");
});

it.each(["sparse", "accessor"] as const)("rejects %s entries without calling getters", (kind) => {
  const { tx, fn } = fixture(),
    rows = [fn, fn];
  let reads = 0;
  if (kind === "sparse") Reflect.deleteProperty(rows, 1);
  else
    Object.defineProperty(rows, 1, {
      get() {
        reads++;
        return fn;
      },
    });
  expect(() => tx.assertCompletedReservations(rows)).toThrow(/dense own-data/);
  expect(reads).toBe(0);
});

it("captures entries without consulting getters or iteration", () => {
  const { tx, fn } = fixture();
  let reads = 0;
  tx.assertCompletedReservations(
    new Proxy([fn], {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  expect(reads).toBe(0);
});

it.each(["layout", "phase"] as const)("rejects %s changes during capture", (kind) => {
  const { tx, fn } = fixture();
  const rows = new Proxy([fn], {
    getOwnPropertyDescriptor(target, key) {
      if (key === "0") {
        if (kind === "layout") fn.object.name = "changed";
        else {
          try {
            tx.freezeReservations();
          } catch {
            /* Conceal the nested rejection. */
          }
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  expect(() => tx.assertCompletedReservations(rows)).toThrow(
    kind === "layout" ? /altered/ : /completion requested in failed/,
  );
  expect(tx.state).toBe("failed");
});

it("rejects a ledger poisoned during the audit", () => {
  const { tx, fn } = fixture();
  let poisoned = false;
  Object.defineProperty(fn.object, "name", {
    enumerable: true,
    get() {
      if (!poisoned) {
        poisoned = true;
        try {
          tx.freezeReservations();
        } catch {
          /* Preserve the name while concealing failure. */
        }
      }
      return "fn";
    },
  });
  expect(() => tx.assertCompletedReservations([fn])).toThrow("completion requested in failed");
  expect(poisoned).toBe(true);
});

it.each(["body", "initializer"] as const)("does not reuse success after a completed %s changes", (kind) => {
  const { tx, fn, global } = fixture();
  tx.assertCompletedReservations([fn, global]);
  if (kind === "body") fn.object.body.push({ op: "nop" });
  else global.object.init.push({ op: "nop" });
  expect(() => tx.assertCompletedReservations([fn, global])).toThrow(/altered completed/);
});

it("does not mistake an inherited descriptor value for an own data entry", () => {
  const { tx, fn } = fixture(),
    rows = [fn];
  let reads = 0,
    failure: unknown;
  Object.defineProperty(rows, 0, {
    get() {
      reads++;
      return fn;
    },
  });
  Object.defineProperty(Object.prototype, "value", {
    configurable: true,
    get() {
      reads++;
      return fn;
    },
  });
  try {
    tx.assertCompletedReservations(rows);
  } catch (error) {
    failure = error;
  } finally {
    Reflect.deleteProperty(Object.prototype, "value");
  }
  expect(String(failure)).toMatch(/dense own-data/);
  expect(reads).toBe(0);
  expect(tx.state).toBe("failed");
});
