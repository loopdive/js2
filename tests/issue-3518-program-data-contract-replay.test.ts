// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { resolveIrPreparationControlsFromEnv } from "../src/ir/program-middleend.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram, TypedIrProgramInput, TypedIrProgramOptions } from "../src/ir/program/index.js";
import {
  sourceInput,
  sourcePacket,
  scalarFiles,
  requireProgram,
  typedOptions,
} from "./helpers/typed-program-fixtures.js";
import { decodeTypedPacket, encodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";

afterEach(() => vi.unstubAllEnvs());
const cases = [
  { name: "callable alias", files: scalarFiles, exportName: "main", expected: 42, units: 2, globals: 0 },
  {
    name: "ordered live global startup",
    files: {
      "./base.ts": "export var digit: number = 1; digit = digit * 10 + 3;",
      "./entry.ts":
        'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function read(): number { return answer; }',
    },
    exportName: "read",
    expected: 132,
    units: 3,
    globals: 2,
  },
];

async function execution(program: PreparedIrProgram, exportName: string) {
  const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
  expect(outcome.kind, JSON.stringify(outcome.kind === "not-accepted" ? outcome.failure : {})).toBe("ran");
  if (outcome.kind !== "ran") throw new Error(outcome.failure.detail);
  const fn = outcome.run.exports[exportName];
  expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("missing executable export " + exportName);
  const module = outcome.run.emitted.module;
  const bytes = emitBinary(module);
  expect(bytes.byteLength).toBeGreaterThan(8);
  expect(module.imports).toEqual([]);
  return {
    bytes: Buffer.from(bytes).toString("base64"),
    wat: emitWat(module),
    imports: module.imports,
    emittedUnits: outcome.run.emitted.emittedUnitIds,
    values: [fn(), fn()],
  };
}

describe("canonical contract consumers preserve actual standalone preparation and replay", () => {
  for (const fixture of cases)
    for (const mode of ["off", "on"] as const)
      for (const reverse of [false, true]) {
        it(`${fixture.name}: GVN ${mode}, reversed sources ${reverse}`, async () => {
          vi.stubEnv("JS2WASM_IR_GVN", mode);
          // Resolve the same complete controls as the historical wrapper, rather
          // than assuming unrelated analysis environment flags are absent.
          const options: TypedIrProgramOptions = { ...typedOptions, controls: resolveIrPreparationControlsFromEnv() };
          const packet: TypedIrProgramInput = sourcePacket(fixture.files, reverse).packet;
          expect(packet.inventory.sources).toHaveLength(2);
          expect(packet.inventory.terminalUnits).toHaveLength(fixture.units);
          expect(packet.globals).toHaveLength(fixture.globals);
          expect(packet).toEqual(sourcePacket(fixture.files, !reverse).packet);
          if (fixture.name === "callable alias")
            expect(packet.callables.some((x) => x.kind === "import-alias")).toBe(true);
          const wire = encodeTypedPacket({ packet, options });
          const restored = decodeTypedPacket(wire);
          expect(encodeTypedPacket(restored)).toBe(wire);
          expect(restored.packet).toEqual(packet);
          const prepared = requireProgram(prepareTypedIrProgram(restored.packet, restored.options));
          const wrapped = requireProgram(prepareWholeIrProgram(sourceInput(fixture.files, reverse)));
          const encoded = encodePreparedIrProgram(prepared);
          expect(encodePreparedIrProgram(wrapped)).toBe(encoded);
          const decoded = decodePreparedIrProgram(encoded);
          expect(encodePreparedIrProgram(decoded)).toBe(encoded);
          expect(prepared.startup).toEqual(wrapped.startup);
          expect(prepared.allocations).toEqual(wrapped.allocations);
          const original = await execution(wrapped, fixture.exportName);
          expect(original.values).toEqual([fixture.expected, fixture.expected]);
          expect(await execution(prepared, fixture.exportName)).toEqual(original);
          expect(await execution(decoded, fixture.exportName)).toEqual(original);
        }, 30_000);
      }
});
