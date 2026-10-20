// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
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
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
  requireCompletedNativeStringFlatten,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
  requireCompletedNativeStringNumber,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import { buildUndefinedInitializer } from "../src/runtime/wasmgc/values/primitive-layouts.js";
import { buildDecimalPowerArrayInitializer } from "../src/runtime/wasmgc/values/decimal-scale-bodies.js";
import { planNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
const programs = new Map<boolean, ReturnType<typeof prepareGetterProgram>>();
function fixture(utf8: boolean) {
  let program = programs.get(utf8);
  if (!program) {
    program = prepareGetterProgram("export function main(value: number): number { return value; }", utf8);
    programs.set(utf8, program);
  }
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = utf8 ? tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] }) : undefined;
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "conversion:strings",
    utf8Storage: utf8,
    literals: [
      { value: "", encoding: "wtf16" },
      { value: "43", encoding: "ascii" },
      { value: "-0", encoding: "wtf16" },
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "conversion:flatten", strings);
  const plan = deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string");
  const scanner = reserveNativeStringNumberResources(tx, plan, flatten);
  const dependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, plan, dependencies);
  const texts = ["", "43", "-0"].map((text) => requireNativeStringLiteral(tx, strings, text));
  return { module, tx, prefix, strings, flatten, plan, scanner, dependencies, values, texts };
}
function fillStrings(f: ReturnType<typeof fixture>) {
  f.tx.freezeReservations();
  fillNativeStringLiteralResources(f.tx, f.strings);
}
function fillConversions(f: ReturnType<typeof fixture>) {
  fillStrings(f);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringNumberResources(f.tx, f.scanner);
}
for (const utf8 of [false, true])
  describe(`native-string completion utf8/displaced/decoded=${utf8}`, () => {
    it("executes genuine original native string conversions and preserves negative zero without host imports", () => {
      const f = fixture(utf8);
      fillConversions(f);
      fillNativeValueResources(f.tx, f.values, f.dependencies);
      expect(requireCompletedNativeValues(f.tx, f.values, f.plan, f.dependencies)).toBe(f.values);
      f.tx.defineExport("conversion:unbox", "unbox", f.values.functions.unboxNumber);
      for (const [i, text] of f.texts.entries()) {
        if (text.kind !== "global") throw Error("actual short input required");
        f.tx.defineExport("conversion:text:" + i, "text" + i, text.global);
      }
      f.tx.seal();
      const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
      expect(WebAssembly.Module.imports(wasm)).toEqual([]);
      const api = new WebAssembly.Instance(wasm).exports as Record<string, any>;
      expect(api.unbox(api.text0.value)).toBe(0);
      expect(api.unbox(api.text1.value)).toBe(43);
      expect(Object.is(api.unbox(api.text2.value), -0)).toBe(true);
      expect(requireCompletedNativeValues(f.tx, f.values, f.plan, f.dependencies)).toBe(f.values);
    });
    for (const role of ["boxNumber", "unboxNumber", "isNumber", "undefined"] as const)
      it(`rejects receipt-valid native-string ${role} substitution`, () => {
        const f = fixture(utf8);
        fillConversions(f);
        const fill = f.tx.fillFunction.bind(f.tx),
          global = f.tx.fillGlobal.bind(f.tx);
        vi.spyOn(f.tx, "fillFunction").mockImplementation((token, definition) =>
          fill(
            token,
            role === "undefined" || token !== f.values.functions[role]
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
        const alternate = buildUndefinedInitializer(f.values.types.anyValue.typeIndex);
        alternate[0] = { op: "i32.const", value: 77 };
        vi.spyOn(f.tx, "fillGlobal").mockImplementation((token, init) =>
          global(token, role === "undefined" && token === f.values.globals.undefined ? alternate : init),
        );
        fillNativeValueResources(f.tx, f.values, f.dependencies);
        f.tx.assertCompletedReservation(role === "undefined" ? f.values.globals.undefined : f.values.functions[role]);
        expect(() => requireCompletedNativeValues(f.tx, f.values, f.plan, f.dependencies)).toThrow(
          role === "undefined" ? /noncanonical global initializer/ : /noncanonical function definition/,
        );
      });
    for (const role of ["copyTree", "flatten", ...(utf8 ? ["utf8Decoder" as const] : [])] as const)
      it(`rejects receipt-valid ${role} body at its actual flatten owner`, () => {
        const f = fixture(utf8);
        fillStrings(f);
        const target = f.flatten[role];
        if (!target) throw Error("actual decoder required");
        const fill = f.tx.fillFunction.bind(f.tx);
        vi.spyOn(f.tx, "fillFunction").mockImplementation((token, definition) =>
          fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition),
        );
        fillNativeStringFlattenResources(f.tx, f.flatten);
        f.tx.assertCompletedReservation(target);
        expect(() => requireCompletedNativeStringFlatten(f.tx, f.flatten, f.strings)).toThrow(
          /noncanonical function definition/,
        );
      });
    it("rejects a receipt-valid nonempty replacement for the actual UTF16 empty literal", () => {
      const f = fixture(utf8),
        alternate = planNativeStringLiteral(f.strings.layout, utf8, "x", "wtf16");
      if (alternate.kind !== "global") throw Error("actual short alternate required");
      f.tx.freezeReservations();
      const fill = f.tx.fillGlobal.bind(f.tx);
      vi.spyOn(f.tx, "fillGlobal").mockImplementation((token, init) =>
        fill(token, token === f.flatten.emptyLiteral ? alternate.init : init),
      );
      fillNativeStringLiteralResources(f.tx, f.strings);
      fillNativeStringFlattenResources(f.tx, f.flatten);
      f.tx.assertCompletedReservation(f.flatten.emptyLiteral);
      expect(() => requireCompletedNativeStringFlatten(f.tx, f.flatten, f.strings)).toThrow(
        /noncanonical global initializer/,
      );
    });
    for (const caller of ["scanner", "downstream value filler"] as const)
      it(`rejects a receipt-valid scanner replacement at the ${caller}`, () => {
        const f = fixture(utf8);
        fillStrings(f);
        fillNativeStringFlattenResources(f.tx, f.flatten);
        const fill = f.tx.fillFunction.bind(f.tx);
        vi.spyOn(f.tx, "fillFunction").mockImplementation((token, definition) =>
          fill(
            token,
            token === f.scanner.toNumber ? { locals: [], body: [{ op: "f64.const", value: 999 }] } : definition,
          ),
        );
        fillNativeStringNumberResources(f.tx, f.scanner);
        f.tx.assertCompletedReservation(f.scanner.toNumber);
        expect(() =>
          caller === "scanner"
            ? requireCompletedNativeStringNumber(f.tx, f.scanner, f.plan, f.strings)
            : fillNativeValueResources(f.tx, f.values, f.dependencies),
        ).toThrow(/noncanonical function definition/);
      });
    it("rejects a receipt-valid power table with a wrong scale instead of certifying the scanner", () => {
      const f = fixture(utf8);
      fillStrings(f);
      fillNativeStringFlattenResources(f.tx, f.flatten);
      const alternate = buildDecimalPowerArrayInitializer(f.scanner.powerArray.typeIndex);
      alternate[1] = { op: "f64.const", value: 999 };
      const fill = f.tx.fillGlobal.bind(f.tx);
      vi.spyOn(f.tx, "fillGlobal").mockImplementation((token, init) =>
        fill(token, token === f.scanner.powerGlobal ? alternate : init),
      );
      fillNativeStringNumberResources(f.tx, f.scanner);
      f.tx.assertCompletedReservation(f.scanner.powerGlobal);
      expect(() => requireCompletedNativeStringNumber(f.tx, f.scanner, f.plan, f.strings)).toThrow(
        /noncanonical global initializer/,
      );
    });
  });
