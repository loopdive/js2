// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
  requireCompletedNativeValues,
} from "../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
  requireCompletedNativeErrors,
} from "../src/backend/wasmgc/resources/native-errors.js";
import { planNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";
import { buildUndefinedInitializer } from "../src/runtime/wasmgc/values/primitive-layouts.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
const programs = new Map<boolean, ReturnType<typeof prepareGetterProgram>>();
function values(displaced: boolean, decoded: boolean) {
  let program = programs.get(decoded);
  if (!program) {
    program = prepareGetterProgram("export function main(value: number): number { return value; }", decoded);
    programs.set(decoded, program);
  }
  const plan = deriveNativeValueResourcePlan(program, program.runtime[0]!, "primitive-only");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (displaced) {
    tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
    tx.reserveGlobal("prefix:global", "prefix", { kind: "i32" }, false);
    tx.reserveFunction("prefix:function", "prefix", { params: [], results: [] });
  }
  const dependencies = { strings: { kind: "absent" as const } };
  const pack = reserveNativeValueResources(tx, plan, dependencies);
  return { module, tx, plan, dependencies, pack };
}
function errors(displaced: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (displaced) tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "leaf:strings",
    utf8Storage: displaced,
    literals: [{ value: "TypeError", encoding: "wtf16" }],
  });
  const requirements = { key: "leaf:errors" },
    dependencies = { strings, typeErrorTag: -11 };
  const pack = reserveNativeErrorResources(tx, requirements, dependencies);
  return { module, tx, strings, requirements, dependencies, pack };
}
for (const [displaced, decoded] of [
  [false, false],
  [true, true],
] as const)
  describe(`shared leaf completion displaced=${displaced} decoded=${decoded}`, () => {
    it("accepts genuine completed native primitive and TypeError definitions", () => {
      const v = values(displaced, decoded),
        e = errors(displaced);
      v.tx.freezeReservations();
      fillNativeValueResources(v.tx, v.pack, v.dependencies);
      expect(requireCompletedNativeValues(v.tx, v.pack, v.plan, v.dependencies)).toBe(v.pack);
      e.tx.freezeReservations();
      fillNativeStringLiteralResources(e.tx, e.strings);
      fillNativeErrorResources(e.tx, e.pack);
      expect(requireCompletedNativeErrors(e.tx, e.pack, e.requirements, e.dependencies)).toBe(e.pack);
    });
    for (const role of ["boxNumber", "unboxNumber", "isNumber"] as const)
      it(`refuses the receipt-valid substituted ${role} definition at its actual shared owner`, () => {
        const f = values(displaced, decoded),
          token = f.pack.functions[role];
        f.tx.freezeReservations();
        const fill = f.tx.fillFunction.bind(f.tx);
        vi.spyOn(f.tx, "fillFunction").mockImplementation((selected, definition) =>
          fill(
            selected,
            selected !== token
              ? definition
              : {
                  locals: [],
                  body:
                    role === "boxNumber"
                      ? [{ op: "ref.null.extern" }]
                      : role === "unboxNumber"
                        ? [{ op: "f64.const", value: 999 }]
                        : [{ op: "i32.const", value: 1 }],
                },
          ),
        );
        fillNativeValueResources(f.tx, f.pack, f.dependencies);
        f.tx.assertCompletedReservation(token);
        expect(() => requireCompletedNativeValues(f.tx, f.pack, f.plan, f.dependencies)).toThrow(
          /noncanonical function definition/,
        );
      });
    it("refuses a receipt-valid undefined global with the wrong internal tag", () => {
      const f = values(displaced, decoded);
      f.tx.freezeReservations();
      const fill = f.tx.fillGlobal.bind(f.tx);
      const alternate = buildUndefinedInitializer(f.pack.types.anyValue.typeIndex);
      alternate[0] = { op: "i32.const", value: 77 };
      vi.spyOn(f.tx, "fillGlobal").mockImplementation((token, init) =>
        fill(token, token !== f.pack.globals.undefined ? init : alternate),
      );
      fillNativeValueResources(f.tx, f.pack, f.dependencies);
      f.tx.assertCompletedReservation(f.pack.globals.undefined);
      expect(() => requireCompletedNativeValues(f.tx, f.pack, f.plan, f.dependencies)).toThrow(
        /noncanonical global initializer/,
      );
    });
    it("refuses an allocator-valid message-returning substitute for the TypeError constructor", () => {
      const f = errors(displaced);
      f.tx.freezeReservations();
      fillNativeStringLiteralResources(f.tx, f.strings);
      const fill = f.tx.fillFunction.bind(f.tx);
      vi.spyOn(f.tx, "fillFunction").mockImplementation((token, definition) =>
        fill(token, token === f.pack.newTypeError ? { locals: [], body: [{ op: "local.get", index: 0 }] } : definition),
      );
      fillNativeErrorResources(f.tx, f.pack);
      f.tx.assertCompletedReservation(f.pack.newTypeError);
      expect(() => requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
        /noncanonical function definition/,
      );
    });
    it("refuses a receipt-valid replacement of the actual TypeError name initializer", () => {
      const f = errors(displaced),
        name = requireNativeStringLiteral(f.tx, f.strings, "TypeError");
      if (name.kind !== "global") throw Error("actual short name initializer required");
      const alternate = planNativeStringLiteral(f.strings.layout, displaced, "RangeError", "wtf16");
      if (alternate.kind !== "global") throw Error("actual alternate short initializer required");
      f.tx.freezeReservations();
      const fill = f.tx.fillGlobal.bind(f.tx);
      vi.spyOn(f.tx, "fillGlobal").mockImplementation((token, init) =>
        fill(token, token === name.global ? alternate.init : init),
      );
      fillNativeStringLiteralResources(f.tx, f.strings);
      fillNativeErrorResources(f.tx, f.pack);
      f.tx.assertCompletedReservation(name.global);
      expect(() => requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
        /noncanonical global initializer/,
      );
    });
  });
