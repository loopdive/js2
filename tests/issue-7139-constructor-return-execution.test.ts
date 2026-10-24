// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { prepareClassConstructProgram } from "./helpers/prepared-class-construct.js";
import { inspectConstructCopy } from "./helpers/prepared-construct-inspector.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";

for (const decoded of [false, true])
  it(`executes distinct retained evaluations returned from the same factory family, decoded=${decoded}`, async () => {
    const fixture = prepareClassConstructProgram("retained", 2);
    expect(JSON.stringify(fixture.input.inventory)).toBe(fixture.originalInventory);
    expect(fixture.program.inventory.allUnits).toHaveLength(8);
    expect(fixture.program.inventory.terminalUnits).toHaveLength(7);
    expect(fixture.program.derivedUnits).toEqual([]);
    const encoded = encodePreparedIrProgram(fixture.program);
    const program = decoded ? decodePreparedIrProgram(encoded) : fixture.program;
    expect(encodePreparedIrProgram(program)).toBe(encoded);
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect(outcome.run.emitted.emittedUnitIds).toEqual(
      outcome.run.accepted.runtime.prepared.functions.map((fn) => fn.unitId),
    );
    const run = outcome.run.exports.run as Function,
      a = {},
      b = {},
      payload = {};
    // Null also takes the factory's real embedded early-return path.
    for (const marker of [a, null]) {
      expect(run(a, marker, b, payload, 0)).toBe(a);
      expect(run(null, marker, b, payload, 1)).toBe(marker);
      expect(run(null, marker, b, payload, 2)).toBe(b);
      expect(run(null, marker, b, payload, 3)).toBe(payload);
    }
    expect(Object.is(run(null, a, b, payload, 4), run(null, a, b, payload, 4))).toBe(false);
    const observedReceiver = run(null, a, b, payload, 4);
    const copy = await inspectConstructCopy(outcome.run.emitted.module);
    copy.reset();
    const selected = copy.run(observedReceiver, a, b, payload, 4);
    expect(Object.is(copy.value("firstClass"), copy.value("secondClass"))).toBe(false);
    expect(Object.is(selected, copy.value("firstClass"))).toBe(true);
    expect(Object.is(copy.value("firstEntryTarget"), copy.value("secondClass"))).toBe(true);
    expect(Object.is(copy.value("secondEntryTarget"), copy.value("firstClass"))).toBe(true);
    expect(copy.value("constructCalls")).toBe(3);
    expect(copy.value("internalEntries")).toBe(3);
    expect(copy.value("badFrames")).toBe(0);
    expect(copy.value("badEntries")).toBe(0);
  }, 180000);
