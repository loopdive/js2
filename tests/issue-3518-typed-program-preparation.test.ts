// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import * as typed from "../src/ir/program-prepare-ir.js";
import * as middleend from "../src/ir/program-middleend-ir.js";
import * as legacy from "../src/ir/passes/gvn.js";
import { createGvnCounters } from "../src/ir/passes/gvn-core.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { ownTypedIrProgramInput } from "../src/ir/program-input.js";
import { captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { forEachInstrDeep, irVal } from "../src/ir/nodes.js";
import * as verification from "../src/ir/verify.js";
import * as allocationVerification from "../src/ir/verify-alloc.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import {
  requireProgram,
  scalarFiles,
  sourceInput,
  sourcePacket,
  startupFiles,
  typedOptions,
} from "./helpers/typed-program-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function execute(program: ReturnType<typeof requireProgram>, name: string, args: number[] = []) {
  const run = await replayProgram(program, replayOptions("wasmgc", "standalone"));
  expect(run.kind, JSON.stringify(run.kind === "ran" ? {} : run.failure)).toBe("ran");
  if (run.kind !== "ran") throw new Error(run.failure.detail);
  expect(run.run.emitted.module.imports).toHaveLength(0);
  expect(run.run.bytes).toBeGreaterThan(8);
  const fn = run.run.exports[name];
  if (typeof fn !== "function") throw new Error(`missing export ${name}`);
  return [fn(...args), fn(...args)];
}

describe("source-free typed program preparation, standalone WasmGC", () => {
  it("prepares complete real source populations, matches the compatibility entry, and executes replay", async () => {
    const { packet } = sourcePacket();
    expect(packet.inventory.sources).toHaveLength(2);
    expect(packet.inventory.terminalUnits).toHaveLength(2);
    expect(packet.ir.functions).toHaveLength(2);
    expect(packet.callables.some((binding) => binding.kind === "import-alias")).toBe(true);
    const direct = requireProgram(typed.prepareTypedIrProgram(packet, typedOptions));
    const wrapped = requireProgram(prepareWholeIrProgram(sourceInput()));
    const encoded = encodePreparedIrProgram(direct);
    expect(encodePreparedIrProgram(wrapped)).toBe(encoded);
    const replay = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(replay)).toBe(encoded);
    expect(await execute(direct, "main")).toEqual([42, 42]);
    expect(await execute(replay, "main")).toEqual([42, 42]);
    expect(encoded).not.toContain('"counters"');
    expect(encoded).not.toContain('"controls"');
  });

  it("keeps lexical globals/startup order and retains the located native TDZ materialization refusal", async () => {
    const { packet, source } = sourcePacket(startupFiles);
    const reversed = sourcePacket(startupFiles, true).packet;
    expect(packet.inventory.terminalUnits).toHaveLength(3);
    expect(packet.globals).toHaveLength(2);
    expect(source.globals.every((global) => Object.hasOwn(global.identity, "declaration"))).toBe(true);
    expect(packet.globals.every((global) => !Object.hasOwn(global.identity, "declaration"))).toBe(true);
    expect(reversed).toEqual(packet);
    const normal = requireProgram(typed.prepareTypedIrProgram(packet, typedOptions));
    const reverse = requireProgram(typed.prepareTypedIrProgram(reversed, typedOptions));
    expect(encodePreparedIrProgram(reverse)).toBe(encodePreparedIrProgram(normal));
    const refused = await replayProgram(normal, replayOptions("wasmgc", "standalone"));
    expect(refused.kind).toBe("not-accepted");
    if (refused.kind !== "not-accepted") throw new Error("unimplemented native TDZ materialization was accepted");
    expect(refused.failure.kind).toBe("unsupported");
    expect(refused.failure.code).toBe("body-shape-rejected");
    expect(refused.failure.stage).toBe("build");
    expect(refused.failure.sourceFile).toBe("base.ts");
    expect(refused.failure.unitId).toBe(packet.startup[0]!.unitId);
    expect(refused.failure.detail).toBe(
      "wasmgc:standalone physical setup cannot be materialized (2 gaps): runtime callable __new_ReferenceError needs runtime function materialization; body <module-init> references runtime callable __new_ReferenceError that the plan cannot reserve",
    );
  });

  it("executes live var storage and noncommutative startup in both source orders without TDZ demands", async () => {
    const files = {
      "./base.ts": "export var digit: number = 1; digit = digit * 10 + 3;",
      "./entry.ts":
        'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function read(): number { return answer; }',
    };
    const normalPacket = sourcePacket(files).packet,
      reversePacket = sourcePacket(files, true).packet;
    expect(normalPacket.inventory.terminalUnits).toHaveLength(3);
    expect(normalPacket.globals).toHaveLength(2);
    expect(normalPacket.globals.every((global) => global.binding.tdzGlobalRef === null)).toBe(true);
    expect(reversePacket).toEqual(normalPacket);
    const normal = requireProgram(typed.prepareTypedIrProgram(normalPacket, typedOptions));
    const reversed = requireProgram(typed.prepareTypedIrProgram(reversePacket, typedOptions));
    expect(encodePreparedIrProgram(reversed)).toBe(encodePreparedIrProgram(normal));
    expect(await execute(normal, "read")).toEqual([132, 132]);
    expect(await execute(decodePreparedIrProgram(encodePreparedIrProgram(reversed)), "read")).toEqual([132, 132]);
  });

  it("preserves standalone source TDZ guards for calls made during startup in the detached packet", () => {
    const { packet } = sourcePacket({
      "./entry.ts":
        "export function read(): number { return value; } let before: number = read(); let value: number = 2;",
    });
    expect(packet.inventory.terminalUnits).toHaveLength(2);
    expect(packet.globals).toHaveLength(2);
    expect(packet.globals.every((global) => global.binding.tdzGlobalRef !== null)).toBe(true);
    const read = packet.ir.functions.find((fn) => fn.name === "read")!;
    let guards = 0;
    for (const block of read.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (
            instruction.kind === "call" &&
            instruction.target.binding.kind === "runtime" &&
            instruction.target.binding.symbol === "__new_ReferenceError"
          )
            guards++;
        });
    expect(guards).toBe(1);
    expect(packet.startup[0]!.executable).toBe(true);
  });

  it("ignores contradictory ambient controls, including final verification, and publishes no observation", () => {
    const { packet } = sourcePacket();
    const before = encodePreparedIrProgram(requireProgram(typed.prepareTypedIrProgram(packet, typedOptions)));
    for (const flag of [
      "JS2WASM_IR_OWNERSHIP",
      "JS2WASM_IR_ESCAPE",
      "IR_VERIFY_ALLOC",
      "JS2WASM_IR_VERIFY_DOMINANCE_NAIVE",
      "JS2WASM_IR_GVN_DEBUG",
    ])
      vi.stubEnv(flag, "1");
    vi.stubEnv("JS2WASM_IR_GVN", "poison");
    const observed = vi.fn(),
      record = vi.spyOn(legacy, "recordLegacyGvnCountersOnce");
    const unsubscribe = subscribePreparedIrProgram(observed);
    try {
      const counters = createGvnCounters();
      const actual = requireProgram(typed.prepareTypedIrProgram(packet, typedOptions, counters));
      expect(encodePreparedIrProgram(actual)).toBe(before);
      expect(counters).toEqual({ functions: 0, merged: 0, poisoned: 0 });
      expect(observed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("exercises real GVN merges and poison with separately owned counters and executed values", async () => {
    const { packet } = sourcePacket({
      "./entry.ts": "export function main(x: number): number { const a = x + 1; const b = x + 1; return a + b; }",
    });
    for (const mode of ["off", "on", "poison"] as const) {
      const counters = createGvnCounters();
      const program = requireProgram(
        typed.prepareTypedIrProgram(
          packet,
          {
            ...typedOptions,
            controls: { ...typedOptions.controls, gvnMode: mode },
          },
          counters,
        ),
      );
      const values = await execute(program, "main", [20]);
      if (mode === "poison") {
        expect(counters.poisoned).toBeGreaterThan(0);
        expect(values[0]).not.toBe(42);
      } else expect(values).toEqual([42, 42]);
      if (mode === "on") expect(counters.merged).toBeGreaterThan(0);
      if (mode === "off") expect(counters.functions).toBe(0);
    }
  });

  it("threads explicit false through every verifier, including final validation, with an omitted-option control", () => {
    const { packet } = sourcePacket();
    vi.stubEnv("JS2WASM_IR_VERIFY_DOMINANCE_NAIVE", "1");
    const actual = verification.verifyIrFunction;
    const omitted = new Error("omitted explicit verification options");
    const verify = vi
      .spyOn(verification, "verifyIrFunction")
      .mockImplementation((fn, domain, declarations, options) => {
        if (options === undefined) throw omitted;
        return actual(fn, domain, declarations, options);
      });
    const program = requireProgram(typed.prepareTypedIrProgram(packet, typedOptions));
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(program.ir.functions.length);
    expect(verify.mock.calls.every((call) => call[3]?.verifyDominanceNaive === false)).toBe(true);
    let caught: unknown;
    try {
      assertPreparedIrProgram(program);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(omitted);
  });

  it("gates intermediate allocation checks explicitly while retaining nonempty unconditional final checks", () => {
    const { packet } = sourcePacket();
    vi.stubEnv("IR_VERIFY_ALLOC", "1");
    const verify = vi.spyOn(allocationVerification, "assertFinalAllocProvenance");
    requireProgram(typed.prepareTypedIrProgram(packet, typedOptions));
    const finalOnly = verify.mock.calls.length;
    expect(finalOnly).toBeGreaterThan(0);
    verify.mockClear();
    requireProgram(
      typed.prepareTypedIrProgram(packet, {
        ...typedOptions,
        controls: { ...typedOptions.controls, verifyIntermediateAllocations: true },
      }),
    );
    expect(verify.mock.calls.length).toBeGreaterThan(finalOnly);
  });

  it("keeps unknown allocation metadata until unconditional final semantic rejection", () => {
    const { source } = sourcePacket();
    const site = source.allocations.fresh("object", irVal({ kind: "f64" }));
    source.allocations.annotate(site, "future", undefined);
    const packet = captureTypedIrProgramInput(source);
    expect(ownTypedIrProgramInput(packet).allocations.captureSnapshot().metadata).toEqual(packet.allocations.metadata);
    expect(() => typed.prepareTypedIrProgram(packet, typedOptions)).toThrow(/metadata|namespace/);
  });

  it("detaches caller state and refuses frontend carriers, missing populations and diagnostic authority", () => {
    const { packet, source } = sourcePacket(startupFiles);
    const restored = ownTypedIrProgramInput(packet);
    expect(restored.input).toEqual(packet);
    expect(restored.input.ir).not.toBe(packet.ir);
    expect(() => ownTypedIrProgramInput(source as never)).toThrow();
    expect(() => ownTypedIrProgramInput({ ...packet, counters: createGvnCounters() } as never)).toThrow();
    expect(() => typed.prepareTypedIrProgram({ ...packet, ir: { functions: [] } }, typedOptions)).toThrow();
    let invoked = false;
    const accessor = Object.defineProperty({ ...packet }, "ir", {
      get() {
        invoked = true;
        return packet.ir;
      },
    });
    expect(() => ownTypedIrProgramInput(accessor)).toThrow(/accessor/);
    expect(invoked).toBe(false);
    expect(() => typed.prepareTypedIrProgram(packet, typedOptions, { functions: 0, merged: 0, poisoned: 0 })).toThrow(
      /counters/,
    );
  });

  it.each([
    "foreign owner",
    "cross-source owner",
    "same-source function owner",
    "cross-source identity",
    "mismatched TDZ pair",
    "missing TDZ",
    "foreign value pair",
    "duplicate storage",
  ])("rejects a real packet with %s instead of trusting string-shaped identities", (mutation) => {
    const { packet } = sourcePacket({
      "./base.ts": startupFiles["./base.ts"],
      "./entry.ts":
        'import { digit } from "./base"; let answer: number = digit * 10 + 2; let spare: number = 7; export function read(): number { return answer; }',
    });
    expect(packet.inventory.sources).toHaveLength(2);
    expect(packet.inventory.terminalUnits).toHaveLength(3);
    expect(packet.globals).toHaveLength(3);
    expect(ownTypedIrProgramInput(packet).input).toEqual(packet);
    const [base, answer, spare] = packet.globals;
    expect(answer!.identity.sourceId).toBe(spare!.identity.sourceId);
    expect(base!.identity.sourceId).not.toBe(answer!.identity.sourceId);
    const globals: unknown[] = [...packet.globals];
    switch (mutation) {
      case "foreign owner":
        globals[1] = { ...answer, identity: { ...answer!.identity, storageOwnerUnitId: "ir-unit:foreign" } };
        break;
      case "cross-source owner":
        globals[1] = {
          ...answer,
          identity: { ...answer!.identity, storageOwnerUnitId: base!.identity.storageOwnerUnitId },
        };
        break;
      case "same-source function owner":
        globals[1] = {
          ...answer,
          identity: {
            ...answer!.identity,
            storageOwnerUnitId: packet.ir.functions.find((fn) => fn.name === "read")!.unitId,
          },
        };
        break;
      case "cross-source identity":
        globals[1] = { ...answer, identity: { ...base!.identity } };
        break;
      case "mismatched TDZ pair":
        globals[1] = { ...answer, binding: { ...answer!.binding, tdzGlobalRef: spare!.binding.tdzGlobalRef } };
        break;
      case "missing TDZ":
        globals[1] = { ...answer, binding: { ...answer!.binding, tdzGlobalRef: null } };
        break;
      case "foreign value pair":
        globals[1] = { ...answer, binding: { ...answer!.binding, globalRef: base!.binding.globalRef } };
        break;
      case "duplicate storage":
        globals.push(answer);
        break;
      default:
        throw new Error(`missing mutation ${mutation}`);
    }
    // Intentionally malformed data, not a cast of source/AST into semantic input.
    expect(() => ownTypedIrProgramInput({ ...packet, globals } as never)).toThrow(/typed global/);
  });

  it.each([
    "ir",
    "globals",
    "global slot",
    "binding",
    "binding.type",
    "identity.sourceId",
    "identity.storageOwnerUnitId",
  ])("rejects selected source %s accessors before invoking them", (field) => {
    const { source } = sourcePacket(startupFiles);
    let getterCalls = 0;
    const first = source.globals[0]!;
    const binding = { ...first.binding },
      identity = { ...first.identity };
    const entry = { binding, identity };
    const globals = [entry, ...source.globals.slice(1)];
    const carrier = { ...source, globals };
    const poison = (object: object, key: PropertyKey, value: unknown) => {
      Object.defineProperty(object, key, {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls++;
          return value;
        },
      });
    };
    switch (field) {
      case "ir":
        poison(carrier, "ir", source.ir);
        break;
      case "globals":
        poison(carrier, "globals", globals);
        break;
      case "global slot":
        poison(globals, 0, entry);
        break;
      case "binding":
        poison(entry, "binding", binding);
        break;
      case "binding.type":
        poison(binding, "type", first.binding.type);
        break;
      case "identity.sourceId":
        poison(identity, "sourceId", first.identity.sourceId);
        break;
      case "identity.storageOwnerUnitId":
        poison(identity, "storageOwnerUnitId", first.identity.storageOwnerUnitId);
        break;
      default:
        throw new Error(`missing accessor ${field}`);
    }
    expect(() => captureTypedIrProgramInput(carrier)).toThrow(/source capture requires own data field/);
    expect(getterCalls).toBe(0);
  });

  it("does not traverse unselected AST declarations while descriptor-projecting real source data", () => {
    const { source, packet } = sourcePacket(startupFiles);
    let declarationReads = 0;
    const first = source.globals[0]!;
    const identity = Object.defineProperty({ ...first.identity }, "declaration", {
      get() {
        declarationReads++;
        throw new Error("AST declaration crossed the projection");
      },
    });
    const carrier = { ...source, globals: [{ ...first, identity }, ...source.globals.slice(1)] };
    expect(captureTypedIrProgramInput(carrier)).toEqual(packet);
    expect(declarationReads).toBe(0);
  });
});

describe("compatibility transaction diagnostics and observation order", () => {
  it("records success once before observation, and uses distinct nested/sequential accumulators", () => {
    const record = vi.spyOn(legacy, "recordLegacyGvnCountersOnce");
    let events = 0;
    const unsubscribe = subscribePreparedIrProgram(() => {
      events++;
      expect(record).toHaveBeenCalledTimes(events);
      if (events === 1) requireProgram(prepareWholeIrProgram(sourceInput(scalarFiles)));
    });
    try {
      requireProgram(prepareWholeIrProgram(sourceInput()));
      requireProgram(prepareWholeIrProgram(sourceInput()));
      expect(events).toBe(3);
      expect(record).toHaveBeenCalledTimes(3);
      expect(new Set(record.mock.calls.map(([counters]) => counters)).size).toBe(3);
    } finally {
      unsubscribe();
    }
  });

  it("records a returned native-resource refusal once with its original owner and no prepared observation", () => {
    const record = vi.spyOn(legacy, "recordLegacyGvnCountersOnce");
    const observed = vi.fn(),
      unsubscribe = subscribePreparedIrProgram(observed);
    try {
      const result = prepareWholeIrProgram(
        sourceInput({ "./entry.ts": "export async function main(): Promise<number> { return 3; }" }),
      );
      expect(result.kind).toBe("unsupported");
      if (result.kind === "prepared") throw new Error("native resource refusal lost");
      expect(result.sourceFile).toBe("entry.ts");
      expect(result.unitId).toContain("top-level-function");
      expect(record).toHaveBeenCalledTimes(1);
      expect(observed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("records partial real counters once when an original middle-end exception escapes", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "1");
    const original = middleend.optimizePreparedIrProgramIr;
    const sentinel = new Error("post-optimization sentinel");
    vi.spyOn(middleend, "optimizePreparedIrProgramIr").mockImplementation((...args) => {
      original(...args);
      expect(args[3].functions).toBeGreaterThan(0);
      throw sentinel;
    });
    const record = vi.spyOn(legacy, "recordLegacyGvnCountersOnce");
    let caught: unknown;
    try {
      prepareWholeIrProgram(sourceInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0].functions).toBeGreaterThan(0);
  });

  it("accounts for counts before an observer's unchanged exception escapes", () => {
    const sentinel = new Error("observer sentinel");
    const record = vi.spyOn(legacy, "recordLegacyGvnCountersOnce");
    const unsubscribe = subscribePreparedIrProgram(() => {
      expect(record).toHaveBeenCalledTimes(1);
      throw sentinel;
    });
    let caught: unknown;
    try {
      prepareWholeIrProgram(sourceInput());
    } catch (error) {
      caught = error;
    } finally {
      unsubscribe();
    }
    expect(caught).toBe(sentinel);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
