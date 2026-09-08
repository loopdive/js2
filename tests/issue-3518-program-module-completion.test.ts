// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import { absoluteFuncIndex } from "../src/emit/resolve-layout.js";
import { STABLE_FUNC_BASE } from "../src/wasm/physical/function-handles.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedStartupAdapterIndex,
} from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { requireProgram, scalarFiles, sourceInput } from "./helpers/typed-program-fixtures.js";

// Real source fixtures. The lexical-TDZ refusal is covered separately; do not
// silently substitute this var fixture for that still-required population.
const liveStartupFiles = {
  "./base.ts": "export var digit: number = 1; digit = digit * 10 + 3;",
  "./entry.ts":
    'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function read(): number { return answer; }',
};

async function execute(
  program: PreparedIrProgram,
  exportName: string,
  deferred: boolean,
  expected: { units: number; startup: boolean },
) {
  const phases: string[] = [];
  const unsubscribe = subscribePreparedIrProgram((event) => {
    if (event.program === program) phases.push(event.phase);
  });
  try {
    const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
    expect(accepted.kind, JSON.stringify(accepted.kind === "accepted" ? {} : accepted)).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error(accepted.detail);
    const selectedUnits = accepted.runtime.prepared.functions.map((fn) => fn.unitId);
    expect(selectedUnits).toHaveLength(expected.units);
    const emitted = emitAcceptedIrProgram(accepted);
    const module = emitted.module;
    expect(emitted.emittedUnitIds).toEqual(selectedUnits);
    expect(module.imports).toEqual([]);
    expect(module.functions.length).toBeGreaterThan(0);
    expect(module.funcOrdinalToPosition).toHaveLength(module.functions.length);
    expect(new Set(module.funcOrdinalToPosition).size).toBe(module.functions.length);
    for (const [ordinal, position] of module.funcOrdinalToPosition.entries()) {
      expect(Number.isInteger(position)).toBe(true);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(module.functions.length);
      expect(absoluteFuncIndex(module, STABLE_FUNC_BASE + ordinal)).toBe(position);
    }
    const startup = emittedStartupAdapterIndex(emitted);
    if (expected.startup) expect(startup).toBeTypeOf("number");
    else {
      expect(startup).toBeUndefined();
      expect(module.startFuncIdx).toBeUndefined();
      expect(module.exports.some((entry) => entry.name === "__module_init")).toBe(false);
    }
    expect(module.functions.length).toBe(expected.units + (expected.startup ? 1 : 0));
    for (const exported of module.exports) {
      if (exported.desc.kind !== "func") continue;
      expect(exported.desc.index).toBeGreaterThanOrEqual(0);
      expect(exported.desc.index).toBeLessThan(module.functions.length);
      expect(exported.desc.index).toBeLessThan(STABLE_FUNC_BASE);
    }
    if (startup !== undefined) {
      expect(startup).toBe(module.functions.length - 1);
      if (deferred) {
        expect(module.startFuncIdx).toBeUndefined();
        expect(module.exports.find((entry) => entry.name === "__module_init")?.desc).toEqual({
          kind: "func",
          index: startup,
        });
      } else expect(module.startFuncIdx).toBe(startup);
    }
    const binary = emitBinary(module);
    expect(binary.byteLength).toBeGreaterThan(8);
    // Keep the exact bytes supplied to instantiation, not a later re-emission.
    const bytes = Buffer.from(binary).toString("base64");
    const { instance } = await WebAssembly.instantiate(binary);
    if (deferred && startup !== undefined) {
      const initialize = instance.exports.__module_init;
      if (typeof initialize !== "function") throw new Error("missing deferred startup export");
      initialize();
    }
    const callable = instance.exports[exportName];
    if (typeof callable !== "function") throw new Error(`missing source export ${exportName}`);
    expect(phases).toEqual(["accepted", "emission-started", "emitted"]);
    expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
    return { bytes, wat: emitWat(module), exports: module.exports, startup, values: [callable(), callable()] };
  } finally {
    unsubscribe();
  }
}

describe("whole-program physical completion uses real source owners and final publication indices", () => {
  for (const reverse of [false, true])
    for (const deferred of [false, true])
      for (const fixture of [
        { files: scalarFiles, exportName: "main", value: 42, units: 2, startup: false },
        { files: liveStartupFiles, exportName: "read", value: 132, units: 3, startup: true },
      ]) {
        it(`${fixture.exportName}: reverse=${reverse}, deferred=${deferred}`, async () => {
          const input = { ...sourceInput(fixture.files, reverse), deferTopLevelInit: deferred };
          const program = requireProgram(prepareWholeIrProgram(input));
          const wire = encodePreparedIrProgram(program);
          const decoded = decodePreparedIrProgram(wire);
          expect(encodePreparedIrProgram(decoded)).toBe(wire);
          const original = await execute(program, fixture.exportName, deferred, fixture);
          expect(original.values).toEqual([fixture.value, fixture.value]);
          expect(await execute(decoded, fixture.exportName, deferred, fixture)).toEqual(original);
        }, 30_000);
      }

  it("a listener failure after emission starts consumes acceptance without publishing completion", () => {
    const program = requireProgram(prepareWholeIrProgram(sourceInput(scalarFiles)));
    const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
    if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
    const phases: string[] = [];
    const sentinel = new Error("listener failure control");
    const unsubscribe = subscribePreparedIrProgram((event) => {
      if (event.program !== program) return;
      phases.push(event.phase);
      if (event.phase === "emission-started") throw sentinel;
    });
    try {
      let thrown: unknown;
      try {
        emitAcceptedIrProgram(accepted);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(sentinel);
      expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
      expect(phases).toEqual(["emission-started"]);
    } finally {
      unsubscribe();
    }
  });
});
