// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import type { Instr } from "../src/wasm/model/instructions.js";
function observed(fn: () => void) {
  try {
    fn();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function fixture() {
  const tx = new PhysicalModuleReservations(createEmptyModule());
  const global = tx.reserveGlobal("g", "g", { kind: "i32" }, false);
  tx.freezeReservations();
  const init: Instr[] = [{ op: "i32.const", value: 1 }];
  return { tx, global, init };
}
it("preserves the textual audit's observation of map replacement by a live getter", () => {
  const f = fixture();
  let armed = false;
  const originalMap = Array.prototype.map;
  Object.defineProperty(f.init, "audit", {
    enumerable: true,
    get() {
      if (armed)
        Array.prototype.map = () => {
          throw Error("map replacement sentinel");
        };
      return 1;
    },
  });
  f.tx.fillGlobal(f.global, f.init);
  f.tx.assertCompletedReservation(f.global);
  armed = true;
  let result: string;
  try {
    result = observed(() => f.tx.assertCompletedReservation(f.global));
  } finally {
    Array.prototype.map = originalMap;
  }
  expect(result).toBe("physical module reservations: map replacement sentinel");
});
it("does not introduce a freeze call after a descriptor getter during capture", () => {
  const f = fixture();
  const originalFreeze = Object.freeze;
  Object.defineProperty(f.init, "audit", {
    enumerable: true,
    get() {
      Object.freeze = () => {
        throw Error("freeze replacement sentinel");
      };
      return 1;
    },
  });
  let result: string;
  try {
    result = observed(() => f.tx.fillGlobal(f.global, f.init));
  } finally {
    Object.freeze = originalFreeze;
  }
  expect(result).toBe("accepted");
});

it.each(["stringify", "toString", "padStart", "join"] as const)(
  "preserves live %s replacement in textual global audits",
  (name) => {
    const f = fixture();
    let armed = false;
    const target =
      name === "stringify"
        ? JSON
        : name === "toString"
          ? Number.prototype
          : name === "padStart"
            ? String.prototype
            : Array.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(target, name)!;
    Object.defineProperty(f.init, "audit", {
      enumerable: true,
      get() {
        if (armed)
          Object.defineProperty(target, name, {
            ...descriptor,
            value() {
              throw Error(`${name} replacement sentinel`);
            },
          });
        return 1;
      },
    });
    f.tx.fillGlobal(f.global, f.init);
    f.tx.assertCompletedReservation(f.global);
    armed = true;
    let result: string;
    try {
      result = observed(() => f.tx.assertCompletedReservation(f.global));
    } finally {
      Object.defineProperty(target, name, descriptor);
    }
    expect(result).toBe(`physical module reservations: ${name} replacement sentinel`);
  },
);
