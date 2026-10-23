// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareClassCallErrorProgram, CLASS_CALL_ERROR_MESSAGE } from "./helpers/prepared-class-call-errors.js";
import { inspectPreparedErrorCopy, readInspectedErrorString } from "./helpers/prepared-error-inspector.js";
import { inspectPreparedClassCopy } from "./helpers/prepared-class-inspector.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan } from "../src/ir/program-consumer.js";

for (const mixed of [false, true])
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`executes retained class Call TypeError, mixed=${mixed}, decoded=${decoded}, utf8=${utf8Storage}`, async () => {
        const original = prepareClassCallErrorProgram(mixed),
          encoded = encodePreparedIrProgram(original);
        const program = decoded ? decodePreparedIrProgram(encoded) : original;
        expect(encodePreparedIrProgram(program)).toBe(encoded);
        const result = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (result.kind !== "ran") throw Error(result.failure.detail);
        const { run } = result;
        expect(run.emitted.module.imports).toEqual([]);
        expect((run.exports.run as Function)(3)).toBe(mixed ? 1703 : 203);
        expect((run.exports.run as Function)(-2)).toBe(mixed ? 1698 : 198);
        const make = run.exports.make as Function,
          invoke = run.exports.invoke as Function;
        expect(() => invoke(make(1), 9)).toThrow(WebAssembly.Exception);
        const plan = acceptedPhysicalSetupPlan(run.accepted);
        expect(plan.nativeStrings?.resources.errors?.map((row) => row.kind)).toEqual(
          mixed ? ["ReferenceError", "TypeError"] : ["TypeError"],
        );
        expect(run.emitted.emittedUnitIds).toEqual(run.accepted.runtime.prepared.functions.map((fn) => fn.unitId));
        {
          const copy = await inspectPreparedErrorCopy(run.emitted.module, "TypeError");
          expect((copy.run as Function)(3)).toBe(mixed ? 1703 : 203);
          expect(readInspectedErrorString(copy, "name")).toBe("TypeError");
          expect(readInspectedErrorString(copy, "message")).toBe(CLASS_CALL_ERROR_MESSAGE);
          expect((copy.errorTag as Function)()).toBe(-11);
          expect((copy.messageAbsent as Function)()).toBe(0);
          const caught = (copy.capturedError as Function)();
          (copy.run as Function)(4);
          expect(Object.is(caught, (copy.capturedError as Function)())).toBe(false);
          if (mixed) {
            const reference = await inspectPreparedErrorCopy(run.emitted.module, "ReferenceError");
            expect((reference.run as Function)(3)).toBe(1703);
            expect((reference.errorTag as Function)()).toBe(-16);
            expect((reference.messageAbsent as Function)()).toBe(1);
            if (!decoded && !utf8Storage) {
              const classes = await inspectPreparedClassCopy(run.emitted.module);
              const make = classes.make as Function,
                invoke = classes.invoke as Function;
              const first = make(1),
                second = make(2),
                construct = classes.inspectConstruct as Function;
              expect(invoke(construct(first), 9)).toBe(10);
              expect(invoke(construct(second), 9)).toBe(11);
              expect(() => invoke(first, 9)).toThrow(WebAssembly.Exception);
              expect(invoke(construct(first), 8)).toBe(9);
            }
          }
        }
      });

it("replays both error constructors and class Call in a guarded process without the frontend", () => {
  const program = prepareClassCallErrorProgram(true);
  const directory = mkdtempSync(join(process.cwd(), ".tmp/class-call-error-replay-"));
  const file = join(directory, "program.json"),
    oracle = join(directory, "oracle.json");
  writeFileSync(file, encodePreparedIrProgram(program));
  writeFileSync(
    oracle,
    JSON.stringify({
      targets: [{ backend: "wasmgc", target: "standalone" }],
      calls: [
        { export: "run", args: [3], expected: 1703 },
        { export: "run", args: [-2], expected: 1698 },
      ],
    }),
  );
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/ir-whole-program-replay.mjs", file, oracle], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }),
  );
  if (child.error) throw child.error;
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  expect(report.ok).toBe(true);
  expect(report.frontendModules).toEqual([]);
  expect(report.typescriptModules).toEqual([]);
  expect(report.reencodedIdentical).toBe(true);
});
