import { expect, it, vi } from "vitest";
import * as nativeValues from "../src/backend/wasmgc/resources/native-values.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
  requireCompletedNativeStringValues,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeValueResources } from "../src/ir/program-physical-plan.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
  reserveNativeStringLiteralTypes,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
  requireCompletedNativeValues,
} from "../src/backend/wasmgc/resources/native-values.js";

for (const replay of [false, true])
  for (const utf8Storage of [false, true]) {
    it(`aggregate consumes the completed value producer, replay=${replay}, UTF8=${utf8Storage}`, async () => {
      const policy = {
        backend: "wasmgc",
        target: "standalone",
        stringConst: { storage: "native" },
        stringConcat: { concat: "native" },
        numberBoundary: { box: "unsupported", unbox: "native" },
      } as const;
      const original = requireProgram(
        prepareWholeIrProgram({
          ...sourceInput({
            "./entry.ts":
              'export function parse(s: string): number { return +s; } export function literal(): string { return "42"; }',
          }),
          policy,
          nativeStringValueProjection: "standalone-native",
        }),
      );
      const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const projection = program.runtime[0]!,
        demands = collectNativeStringValueDemands(program, projection);
      const planned = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage });
      if (planned.kind !== "planned") throw new Error(JSON.stringify(planned));
      const valueRequirements = deriveNativeValueResourcePlan(program, projection, "native-string");
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const types = reserveNativeStringLiteralTypes(tx, planned.plan.key, utf8Storage);
      const pack = reserveNativeStringValueResources(tx, { demands, plan: planned.plan, valueRequirements }, types);
      if (!pack.number) throw new Error("genuine unbox source must select numeric resources");
      const probe = tx.reserveFunction("completion:probe", "completionProbe", {
        params: [],
        results: [{ kind: "f64" }],
      });
      tx.freezeReservations();
      fillNativeStringValueResources(tx, pack);
      expect(requireCompletedNativeStringValues(tx, pack)).toBe(pack);
      const sentinel = new Error("value producer completion omitted");
      const spy = vi.spyOn(nativeValues, "requireCompletedNativeValues").mockImplementation(() => {
        throw sentinel;
      });
      try {
        let caught: unknown;
        try {
          requireCompletedNativeStringValues(tx, pack);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sentinel);
        expect(spy).toHaveBeenCalledTimes(1);
        const [actualTx, actualPack, actualRequirements, actualDependencies] = spy.mock.calls[0]!;
        expect(actualTx).toBe(tx);
        expect(actualPack).toBe(pack.number.values);
        expect(actualRequirements).toBe(valueRequirements);
        expect(actualDependencies.strings.kind).toBe("native-string");
        if (actualDependencies.strings.kind !== "native-string") throw new Error("expected real scanner dependency");
        expect(actualDependencies.strings.stringPack).toBe(pack.strings);
        expect(actualDependencies.strings.scanner).toBe(pack.number.scanner);
      } finally {
        spy.mockRestore();
      }
      expect(requireCompletedNativeStringValues(tx, pack)).toBe(pack);
      const demand = planned.plan.literalRequirements.literals.find((row) => row.value === "42");
      if (!demand) throw new Error("source literal must survive preparation");
      const literal = requireNativeStringLiteral(tx, pack.strings, "42", demand.encoding);
      if (literal.kind !== "global") throw new Error("short source literal uses a real global");
      tx.fillFunction(probe, {
        locals: [],
        body: [
          { op: "global.get", index: tx.physicalIndex(literal.global) },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: pack.number.values.functions.unboxNumber.handle },
        ],
      });
      tx.defineExport("completion:export", "probe", probe);
      tx.seal();
      expect(requireCompletedNativeStringValues(tx, pack)).toBe(pack);
      const { instance } = await WebAssembly.instantiate(emitBinary(module) as BufferSource, {});
      expect((instance.exports.probe as () => number)()).toBe(42);
    });
  }

it.each(["other-issued-plan", "cloned-plan", "other-string-pack", "cloned-scanner"] as const)(
  "rejects %s before native-value allocations after a genuine positive",
  (mutation) => {
    const { packet } = sourcePacket({ "./entry.ts": "export function main(): number { return 42; }" });
    const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
    const derive = () =>
      planNativeValueResources(
        program,
        { backend: "wasmgc", target: "standalone" },
        program.runtime[0]!,
        "native-string",
      );
    const plan = derive();
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const strings = (key: string) =>
      reserveNativeStringLiteralResources(tx, {
        key,
        utf8Storage: false,
        literals: [{ value: "", encoding: "wtf16" }],
      });
    const stringPack = strings("positive");
    const otherStringPack = strings("other");
    const flatten = reserveNativeStringFlattenResources(tx, "flatten", stringPack);
    const scanner = reserveNativeStringNumberResources(tx, plan, flatten);
    const deps = { strings: { kind: "native-string", stringPack, scanner } } as const;
    reserveNativeValueResources(tx, plan, deps);
    const otherPlan = derive();
    expect(otherPlan).toEqual(plan);
    expect(otherPlan).not.toBe(plan);
    const selectedPlan = mutation === "other-issued-plan" ? otherPlan : mutation === "cloned-plan" ? { ...plan } : plan;
    const selectedDeps = {
      strings: {
        ...deps.strings,
        stringPack: mutation === "other-string-pack" ? otherStringPack : stringPack,
        scanner: mutation === "cloned-scanner" ? { ...scanner } : scanner,
      },
    };
    const before = {
      types: [...module.types],
      functions: [...module.functions],
      globals: [...module.globals],
      ordinals: [...module.funcOrdinalToPosition],
    };
    expect(() => reserveNativeValueResources(tx, selectedPlan, selectedDeps)).toThrow(/foreign|fabricated|unissued/);
    expect({
      types: [...module.types],
      functions: [...module.functions],
      globals: [...module.globals],
      ordinals: [...module.funcOrdinalToPosition],
    }).toEqual(before);
  },
);

it("refuses an unfilled scanner and permits the same value reservation after canonical completion", () => {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(): number { return 42; }" });
  const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
  const plan = planNativeValueResources(
    program,
    { backend: "wasmgc", target: "standalone" },
    program.runtime[0]!,
    "native-string",
  );
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const stringPack = reserveNativeStringLiteralResources(tx, {
    key: "completion:strings",
    utf8Storage: false,
    literals: [{ value: "", encoding: "wtf16" }],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "completion:flatten", stringPack);
  const scanner = reserveNativeStringNumberResources(tx, plan, flatten);
  const deps = { strings: { kind: "native-string", stringPack, scanner } } as const;
  const values = reserveNativeValueResources(tx, plan, deps);
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, stringPack);
  fillNativeStringFlattenResources(tx, flatten);
  const before = structuredClone({ functions: module.functions, globals: module.globals });
  expect(() => fillNativeValueResources(tx, values, deps)).toThrow(/scanner canonical fill is incomplete/);
  expect({ functions: module.functions, globals: module.globals }).toEqual(before);
  fillNativeStringNumberResources(tx, scanner);
  fillNativeValueResources(tx, values, deps);
  expect(requireCompletedNativeValues(tx, values, plan, deps)).toBe(values);
  tx.seal();
  expect(requireCompletedNativeValues(tx, values, plan, deps)).toBe(values);
  const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  expect(() => new WebAssembly.Instance(compiled, {})).not.toThrow();
});

it.each([false, true])("executes real literal, flatten, scanner and unbox producers (UTF8=%s)", (utf8Storage) => {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(): number { return 42; }" });
  const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
  const plan = planNativeValueResources(
    program,
    { backend: "wasmgc", target: "standalone" },
    program.runtime[0]!,
    "native-string",
  );
  const cases: [string, number][] = [
    ["", 0],
    ["3e9", 3e9],
    ["-0", -0],
    ["garbage", NaN],
    ["Infinity", Infinity],
    [" 42 ", 42],
    ["0xff", 255],
    ["-0xff", NaN],
    ["1e309", Infinity],
    ["1e", NaN],
    ["1e+", NaN],
    ["1e-", NaN],
    ["1E", NaN],
    ["1E+", NaN],
    ["1E-", NaN],
    [" 1e+ ", NaN],
    ["1.", 1],
    ["1.e0", 1],
    ["1e0", 1],
    ["1e+0", 1],
    ["1e-0", 1],
    ["1e00", 1],
    ["-0e0", -0],
    ["0x1e", 30],
  ];
  const encoding = (value: string) => (utf8Storage && value !== "" ? ("utf8-guaranteed" as const) : ("wtf16" as const));
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const stringPack = reserveNativeStringLiteralResources(tx, {
    key: "chain:strings",
    utf8Storage,
    literals: cases.map(([value]) => ({ value, encoding: encoding(value) })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "chain:flatten", stringPack);
  const scanner = reserveNativeStringNumberResources(tx, plan, flatten);
  const deps = { strings: { kind: "native-string", stringPack, scanner } } as const;
  const values = reserveNativeValueResources(tx, plan, deps);
  const probes = cases.map((_, i) =>
    tx.reserveFunction(`probe:${i}`, `probe${i}`, { params: [], results: [{ kind: "f64" }] }),
  );
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, stringPack);
  fillNativeStringFlattenResources(tx, flatten);
  fillNativeStringNumberResources(tx, scanner);
  fillNativeValueResources(tx, values, deps);
  const completed = requireCompletedNativeValues(tx, values, plan, deps);
  expect(completed).toBe(values);
  probes.forEach((probe, i) => {
    const literal = requireNativeStringLiteral(tx, stringPack, cases[i]![0], encoding(cases[i]![0]));
    if (literal.kind !== "global") throw Error("expected real short literal global");
    tx.fillFunction(probe, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(literal.global) },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: completed.functions.unboxNumber.handle },
      ],
    });
    tx.defineExport(`export:${i}`, `probe${i}`, probe);
  });
  tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  for (let instance = 0; instance < 2; instance++) {
    const exports = new WebAssembly.Instance(compiled, {}).exports;
    cases.forEach(([input, expected], i) =>
      expect(
        (exports[`probe${i}`] as () => number)(),
        `UTF8=${utf8Storage}, instance=${instance}, input=${JSON.stringify(input)}`,
      ).toBe(expected),
    );
  }
});
