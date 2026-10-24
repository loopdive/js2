// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { inspectConstructCopy } from "./helpers/prepared-construct-inspector.js";
import { expect, it } from "vitest";
import { prepareClassConstructProgram } from "./helpers/prepared-class-construct.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";

for (const decoded of [false, true])
  it(`dispatches retained private Construct closures and restores the surrounding receiver, decoded=${decoded}`, async () => {
    const fixture = prepareClassConstructProgram();
    expect(JSON.stringify(fixture.input.inventory)).toBe(fixture.originalInventory);
    expect(fixture.program.inventory.classes).toHaveLength(1);
    expect(fixture.program.inventory.allUnits).toHaveLength(6);
    expect(fixture.program.inventory.terminalUnits).toHaveLength(5);
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
    expect(outcome.run.emitted.module.functions.filter((fn) => fn.name === "__construct_class_value")).toHaveLength(1);
    const run = outcome.run.exports.run as Function;
    const a = { marker: "A" },
      b = { marker: "B" },
      payload = { marker: "payload" };
    for (const receiver of [null, undefined, a, b, payload]) {
      expect(run(receiver, a, b, payload, 0)).toBe(receiver);
      expect(run(receiver, a, b, payload, 1)).toBe(a);
      expect(run(receiver, a, b, payload, 2)).toBe(payload);
      expect(run(receiver, a, b, payload, 3)).toBe(payload);
    }
    const copy = await inspectConstructCopy(outcome.run.emitted.module);
    const observedReceiver = run(null, a, b, payload, 4);
    copy.reset();
    expect(copy.run(observedReceiver, a, b, payload, 0)).toBe(observedReceiver);
    expect(copy.value("constructCalls")).toBe(3);
    expect(copy.value("nonemptyFrames")).toBe(3);
    expect(copy.value("badFrames")).toBe(0);
    expect(copy.value("internalEntries")).toBe(copy.value("constructCalls"));
    expect(copy.value("internalEntries")).toBeGreaterThan(0);
    expect(copy.value("badEntries")).toBe(0);
    expect(prepareWholeIrProgram(fixture.source)).toMatchObject({
      kind: "unsupported",
      code: "class-definition-execution-unsupported",
    });
  }, 180000);

for (const probe of ["argument", "nested", "throw"] as const)
  it(`forwards actual argv and retains exact thrown values through Construct: ${probe}`, async () => {
    const fixture = prepareClassConstructProgram(probe);
    const outcome = await replayProgram(
      decodePreparedIrProgram(encodePreparedIrProgram(fixture.program)),
      replayOptions("wasmgc", "standalone"),
    );
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    const run = outcome.run.exports.run as Function;
    const a = { marker: "A" },
      b = { marker: "B" },
      payload = { marker: "payload" };
    for (const receiver of [a, null, undefined]) {
      expect(run(receiver, a, b, payload, 0)).toBe(receiver);
      expect(run(receiver, a, b, payload, 1)).toBe(probe === "throw" ? a : payload);
      expect(run(receiver, a, b, payload, 3)).toBe(payload);
    }
    const copy = await inspectConstructCopy(outcome.run.emitted.module);
    const observedReceiver = run(null, a, b, payload, 4);
    copy.reset();
    expect(copy.run(observedReceiver, a, b, payload, 0)).toBe(observedReceiver);
    expect(copy.value("constructCalls")).toBe(probe === "nested" ? 5 : 3);
    expect(copy.value("nonemptyFrames")).toBe(3);
    expect(copy.value("badFrames")).toBe(0);
    expect(copy.value("internalEntries")).toBe(copy.value("constructCalls"));
    expect(copy.value("internalEntries")).toBeGreaterThan(0);
    expect(copy.value("badEntries")).toBe(0);
  }, 180000);

for (const probe of ["newTarget", "arguments"] as const)
  it(`forwards the identical internal protocol reference: ${probe}`, async () => {
    const fixture = prepareClassConstructProgram(probe);
    const outcome = await replayProgram(
      decodePreparedIrProgram(encodePreparedIrProgram(fixture.program)),
      replayOptions("wasmgc", "standalone"),
    );
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    const run = outcome.run.exports.run as Function;
    const a = { marker: "A" },
      b = { marker: "B" },
      payload = { marker: "payload" };
    expect(run(a, a, b, payload, 0)).toBe(a);
    const copy = await inspectConstructCopy(outcome.run.emitted.module);
    for (const mode of [1, 3, 4, 5]) {
      copy.reset();
      const actual = copy.run(run(null, a, b, payload, 4), a, b, payload, mode);
      const expected =
        mode === 4
          ? copy.value("firstClass")
          : mode === 5 || probe === "arguments"
            ? copy.value("seenArguments")
            : copy.value(mode === 1 ? "secondClass" : "firstClass");
      expect(actual).toBe(expected);
      expect(copy.value("badFrames")).toBe(0);
      expect(copy.value("internalEntries")).toBe(copy.value("constructCalls"));
      expect(copy.value("internalEntries")).toBeGreaterThan(0);
      expect(copy.value("badEntries")).toBe(0);
      expect(copy.value("nonemptyFrames")).toBe(3);
    }
  }, 180000);
