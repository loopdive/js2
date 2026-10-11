// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import {
  acceptPreparedIrProgram,
  acceptedPhysicalSetupPlan,
  emitAcceptedIrProgram,
  emittedProgramBindingIndex,
  emittedStartupAdapterIndex,
} from "../src/ir/program-consumer.js";
import { indexPhysicalTypes } from "../src/wasm/physical/type-layout.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { EXTERNREF_TO_F64_INTRINSIC_SIGNATURE } from "../src/ir/core/intrinsics.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import type { RuntimeManifestPolicy } from "../src/ir/runtime-manifest.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { requireProgram, sourceInput } from "./helpers/typed-program-fixtures.js";

// These are source programs, not reservation probes. No helper bodies, imports,
// acceptance tokens, or modules are manufactured by this test.
const cases = [
  { name: "required-42", text: " 42 ", expected: 42 },
  { name: "empty", text: "", expected: 0 },
  { name: "negative-zero", text: "-0", expected: -0 },
  { name: "exponent", text: "1e+2", expected: 100 },
  { name: "missing-exponent", text: "1e", expected: NaN },
  { name: "missing-positive-exponent", text: "1e+", expected: NaN },
  { name: "missing-negative-exponent", text: "1e-", expected: NaN },
  { name: "oversized-ascii", text: `${" ".repeat(20_001)}42`, expected: 42 },
  { name: "utf8-byte-overflow", text: "é".repeat(5_001), expected: NaN },
  { name: "oversized-utf16", text: "€".repeat(20_001), expected: NaN },
  { name: "lone-surrogate", text: "\ud800", expected: NaN },
] as const;

const policy: RuntimeManifestPolicy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
};

afterEach(() => vi.unstubAllEnvs());

function prepare(files: Record<string, string>, deferred: boolean, gvn: boolean, reverse = false) {
  vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
  return requireProgram(
    prepareWholeIrProgram({
      ...sourceInput(files, reverse),
      deferTopLevelInit: deferred,
      policy,
      runtimePolicies: [policy],
      nativeStringValueProjection: "standalone-native",
    }),
  );
}

async function execute(
  program: PreparedIrProgram,
  utf8Storage: boolean,
  expected: number,
  startup: boolean,
  deferred: boolean,
  alias: boolean,
  literalText?: string,
) {
  const phases: string[] = [];
  const unsubscribe = subscribePreparedIrProgram((event) => {
    if (event.program === program) phases.push(event.phase);
  });
  try {
    const accepted = acceptPreparedIrProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
    const demands = collectNativeStringValueDemands(program, accepted.runtime);
    const unboxes = demands.intrinsics.filter(
      (entry) =>
        entry.instruction.id === "js.number.unbox" &&
        demands.buffers[demands.occurrences[entry.occurrence]!.bufferIndex]!.view === "projection",
    );
    expect(unboxes.length).toBeGreaterThan(0);
    for (const entry of unboxes)
      expect(entry.instruction.provider).toEqual({
        kind: "callable",
        target: irRuntimeFuncRef("__unbox_number"),
      });
    const expectedProvider = {
      id: "native.js.number.unbox",
      feature: "js.number.unbox",
      signature: EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
      dependencies: [],
      hostCapabilities: [],
      supportedTargets: ["host", "standalone", "strict-no-host", "wasi"],
      supportedBackends: ["linear", "wasmgc"],
      implementation: { kind: "runtime-callable", symbol: "__unbox_number" },
    };
    const providerRows = accepted.runtime.prepared.manifest.providers.filter(
      (row) => row.feature === "js.number.unbox" || row.id === "native.js.number.unbox",
    );
    expect(providerRows).toEqual([expectedProvider]);
    expect(accepted.runtime.prepared.providers.get("js.number.unbox")).toEqual(expectedProvider);
    const emitted = emitAcceptedIrProgram(accepted);
    expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((fn) => fn.unitId));
    expect(emitted.module.imports).toEqual([]);
    for (const { plan } of program.abi.entries) {
      const observed = emittedProgramBindingIndex(emitted, plan.id);
      if (plan.slotPolicy === "none") expect(observed).toBeUndefined();
      if (observed) {
        expect(Object.isFrozen(observed)).toBe(true);
        expect(emittedProgramBindingIndex(emitted, plan.id)).toBe(observed);
        expect(emittedProgramBindingIndex({ ...emitted }, plan.id)).toBeUndefined();
        expect(emittedProgramBindingIndex({ module: emitted.module, emittedUnitIds: [] }, plan.id)).toBeUndefined();
        expect(
          emittedProgramBindingIndex(emitted, `${plan.id}:unknown-execution-control` as typeof plan.id),
        ).toBeUndefined();
      }
      if (plan.slotPolicy === "alias") {
        expect(observed).toBeDefined();
        expect(observed).toEqual(emittedProgramBindingIndex(emitted, plan.aliasOf));
      }
    }
    if (literalText !== undefined) {
      const native = acceptedPhysicalSetupPlan(accepted).nativeStrings;
      if (!native) throw new Error("missing accepted native string declarations");
      const declarations = native.resources.declarations;
      const physicalTypes = indexPhysicalTypes(emitted.module.types);
      const indexFor = (key: string) => {
        const bindings = native.bindings.filter((row) => row.resourceKey === key);
        expect(bindings.length).toBeGreaterThan(0);
        const indices = bindings.map((row) => emittedProgramBindingIndex(emitted, row.entry.id));
        const first = indices[0];
        if (!first) throw new Error(`missing emitted binding for ${key}`);
        for (const index of indices) expect(index).toEqual(first);
        return first;
      };
      const literalGlobal = (text: string, utf8: boolean) => {
        const rows = declarations.filter(
          (row) => row.role[0] === "literal-global" && row.role[1] === `${utf8 ? "u8" : "u16"}:${text}`,
        );
        expect(rows).toHaveLength(1);
        const declaration = rows[0]!;
        if (declaration.space !== "global") throw new Error("literal is not a global declaration");
        const final = indexFor(declaration.key);
        expect(final.space).toBe("global");
        const global = emitted.module.globals[final.index];
        if (!global) throw new Error("missing actual literal global");
        expect(global.name).toBe(declaration.name);
        expect(global.mutable).toBe(false);
        const arrays = global.init.filter((instruction) => instruction.op === "array.new_fixed");
        expect(arrays).toHaveLength(1);
        const array = arrays[0]!;
        const definition = physicalTypes.entries[array.typeIdx]!.definition;
        expect(definition.kind).toBe("array");
        if (definition.kind !== "array") throw new Error("literal initializer has no physical array type");
        expect(definition.element).toEqual({ kind: utf8 ? "i8" : "i16" });
        expect(array.length).toBe(text.length);
        const headerLength = utf8 ? 3 : 2;
        expect(global.init.slice(headerLength, headerLength + text.length)).toEqual(
          Array.from({ length: text.length }, (_, index) => ({ op: "i32.const", value: text.charCodeAt(index) })),
        );
        return final.index;
      };
      if (literalText.length > 10_000) {
        const rows = declarations.filter(
          (row) => row.role[0] === "literal-materializer" && row.role[1] === `__strlit_materialize:u16:${literalText}`,
        );
        expect(rows).toHaveLength(1);
        const final = indexFor(rows[0]!.key);
        expect(final.space).toBe("function");
        const materializer = emitted.module.functions[final.index];
        if (!materializer) throw new Error("missing actual consumer materializer");
        const chunkIndices: number[] = [];
        for (let offset = 0; offset < literalText.length; offset += 10_000)
          chunkIndices.push(literalGlobal(literalText.slice(offset, offset + 10_000), false));
        expect(
          materializer.body
            .filter((instruction) => instruction.op === "global.get")
            .map((instruction) => instruction.index),
        ).toEqual(chunkIndices);
        expect(materializer.body.filter((instruction) => instruction.op === "struct.new")).toHaveLength(
          chunkIndices.length - 1,
        );
      } else {
        const ascii = Array.from(literalText).every((character) => character.charCodeAt(0) <= 0x7f);
        const index = literalGlobal(literalText, utf8Storage && ascii);
        expect(declarations.filter((row) => row.role[0] === "literal-materializer")).toHaveLength(0);
        if (utf8Storage && literalText === "") expect(index).not.toBe(literalGlobal("", false));
      }
    }
    const startupIndex = emittedStartupAdapterIndex(emitted);
    if (startup) {
      expect(startupIndex).toBeTypeOf("number");
      if (deferred) {
        expect(emitted.module.startFuncIdx).toBeUndefined();
        expect(emitted.module.exports.find((entry) => entry.name === "__module_init")?.desc).toEqual({
          kind: "func",
          index: startupIndex,
        });
      } else expect(emitted.module.startFuncIdx).toBe(startupIndex);
    } else {
      expect(startupIndex).toBeUndefined();
      expect(emitted.module.startFuncIdx).toBeUndefined();
      expect(emitted.module.exports.some((entry) => entry.name === "__module_init")).toBe(false);
    }
    expect(emittedStartupAdapterIndex({ ...emitted })).toBeUndefined();
    if (alias) {
      const run = emitted.module.exports.find((entry) => entry.name === "run");
      expect(run).toBeDefined();
      expect(emitted.module.exports.find((entry) => entry.name === "again")?.desc).toEqual(run!.desc);
    }
    const binary = emitBinary(emitted.module);
    const values: number[] = [];
    for (let fresh = 0; fresh < 2; fresh++) {
      const { instance } = await WebAssembly.instantiate(binary);
      if (startup && deferred) {
        const initialize = instance.exports.__module_init;
        if (typeof initialize !== "function") throw new Error("missing actual startup export");
        initialize();
      }
      for (const name of alias ? ["run", "again"] : ["run"]) {
        const run = instance.exports[name];
        if (typeof run !== "function") throw new Error(`missing actual source export ${name}`);
        for (let repeat = 0; repeat < 2; repeat++) {
          const value = run();
          expect(Object.is(value, expected)).toBe(true);
          values.push(value);
        }
      }
    }
    expect(phases).toEqual(["accepted", "emission-started", "emitted"]);
    expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
    return {
      bytes: Buffer.from(binary).toString("base64"),
      wat: emitWat(emitted.module),
      exports: emitted.module.exports,
      order: emitted.module.funcOrdinalToPosition,
      startupIndex,
      values,
    };
  } finally {
    unsubscribe();
  }
}

async function originalAndDecoded(
  program: PreparedIrProgram,
  utf8: boolean,
  expected: number,
  startup = false,
  deferred = false,
  alias = false,
  literalText?: string,
) {
  const wire = encodePreparedIrProgram(program);
  const decoded = decodePreparedIrProgram(wire);
  expect(decoded).not.toBe(program);
  expect(encodePreparedIrProgram(decoded)).toBe(wire);
  const original = await execute(program, utf8, expected, startup, deferred, alias, literalText);
  expect(await execute(decoded, utf8, expected, startup, deferred, alias, literalText)).toEqual(original);
}

describe("actual prepared-program native string numeric consumer execution", () => {
  for (const gvn of [false, true])
    for (const utf8 of [false, true]) {
      for (const fixture of cases) {
        it(`${fixture.name}: GVN=${gvn}, UTF8=${utf8}, original/decoded`, async () => {
          const files = {
            "./entry.ts": `function parse(s: string): number { return +s; } export function run(): number { return parse(${JSON.stringify(fixture.text)}); }`,
          };
          await originalAndDecoded(
            prepare(files, false, gvn),
            utf8,
            fixture.expected,
            false,
            false,
            false,
            fixture.text,
          );
        }, 60_000);
      }
      for (const deferred of [false, true]) {
        it(`source startup and aliases: GVN=${gvn}, UTF8=${utf8}, deferred=${deferred}`, async () => {
          const files = {
            "./parse.ts": "export function parse(s: string): number { return +s; }",
            "./entry.ts":
              'import { parse } from "./parse"; var answer: number = parse(" 42 "); export function run(): number { return answer; } export { run as again };',
          };
          await originalAndDecoded(prepare(files, deferred, gvn), utf8, 42, true, deferred, true);
        }, 60_000);
        for (const reverse of [false, true]) {
          it(`dependency initialization order: GVN=${gvn}, UTF8=${utf8}, deferred=${deferred}, reverse=${reverse}`, async () => {
            const files = {
              "./base.ts":
                'function parse(s: string): number { return +s; } export var digit: number = parse("1"); digit = digit * 10 + parse("3");',
              "./entry.ts":
                'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function run(): number { return answer; } export { run as again };',
            };
            await originalAndDecoded(prepare(files, deferred, gvn, reverse), utf8, 132, true, deferred, true);
          }, 60_000);
        }
      }
    }
});
