// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  prepareGetterProgram,
  getterRequirements,
  getterInvocationFixture,
} from "./helpers/native-getter-invocation-fixture.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, acceptedPhysicalSetupPlan } from "../src/ir/program-consumer.js";
import { assertNativeInvocationRequirementsCurrent } from "../src/ir/program/native-invocation-requirements.js";
import { reserveNativeInvocationResources } from "../src/backend/wasmgc/resources/native-invocation.js";
import type { IrInstr } from "../src/ir/core/nodes.js";

const SOURCE = `export function run(): number {
  const captured = 1;
  const compare = function(value: number): boolean { return captured + value > 10; };
  const first = compare.call(null, 2);
  const second = compare.apply(undefined, [12]);
  return (first ? 100 : 0) + (second ? 1 : 0);
}`;
const BRANCH = `export function run(): number {
  const compare = function(value: number): boolean {
    if (value < 0) return false;
    return value > 10;
  };
  return (compare.call(undefined, -1) ? 100 : 0) + (compare.apply(null, [11]) ? 1 : 0);
}`;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await setImmediate();
});
function prepare(text = SOURCE, decoded = false, boxing = true) {
  return prepareGetterProgram(text, decoded, "./entry.ts", boxing);
}
function requirements(program: ReturnType<typeof prepare>) {
  const r = getterRequirements(program);
  if (!r.invocation) throw Error("lost actual source invocation owner");
  return { ...r, invocation: r.invocation };
}

describe("actual public source call/apply Boolean result admission", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`preserves Boolean result identity through source calls, decoded=${decoded} utf8=${utf8Storage}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", "0");
        const captured = utf8Storage ? (decoded ? 101 : -200) : 1;
        const program = prepare(SOURCE.replace("captured = 1", `captured = ${captured}`), decoded),
          r = requirements(program);
        expect(r.invocation.gaps).toEqual([]);
        expect(r.invocation.booleanResults).toHaveLength(2);
        expect(r.invocation.objectResults!.uses).toEqual([]);
        expect(r.invocation.getterUses).toEqual([]);
        const outcome = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
        expect(outcome.run.emitted.module.imports).toEqual([]);
        expect(acceptedPhysicalSetupPlan(outcome.run.accepted).nativeInvocation!.completionScope).toBe(
          "selected-source-invocation",
        );
        for (let count = 0; count < 3; count++)
          expect((outcome.run.exports.run as () => number)()).toBe(
            (captured + 2 > 10 ? 100 : 0) + (captured + 12 > 10 ? 1 : 0),
          );
        expect(outcome.run.emitted.module.functions.some((row) => row.name === "__box_boolean")).toBe(true);
      }, 120000);
  for (const gvn of [false, true])
    it(`preserves every real branch return, GVN=${gvn}`, async () => {
      vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
      const program = prepare(BRANCH, true);
      expect(requirements(program).invocation.gaps).toEqual([]);
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      expect((outcome.run.exports.run as () => number)()).toBe(1);
    }, 120000);
  it("retains explicit native Boolean boxing policy", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const result = acceptPreparedIrProgram(prepare(SOURCE, true, false), replayOptions("wasmgc", "standalone"));
    expect(result.kind).not.toBe("accepted");
    expect(JSON.stringify(result)).toMatch(/Boolean.*boxing policy/);
  });
  it("retains coercion refusal for unknown exported numeric values", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    expect(() =>
      prepare(SOURCE.replace("run()", "run(seed: number)").replace("captured = 1", "captured = seed")),
    ).toThrow(/unproven binary coercion/);
  });
  it("rejects copied and stale actual result requirements", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const r = requirements(prepare());
    expect(() => assertNativeInvocationRequirementsCurrent(r.invocation)).not.toThrow();
    expect(() => assertNativeInvocationRequirementsCurrent({ ...r.invocation })).toThrow(/copied|unissued/);
  });
  for (const mutation of ["raw extraction", "non-Boolean return", "projection extraction removed"] as const)
    it(`refuses ${mutation} instead of trusting a Boolean annotation`, () => {
      vi.stubEnv("JS2WASM_IR_GVN", "0");
      const program = structuredClone(prepare()),
        positive = requirements(program);
      expect(positive.invocation.gaps).toEqual([]);
      let changed = 0;
      const populations =
        mutation === "projection extraction removed"
          ? [program.runtime[0]!.prepared.functions]
          : [program.ir.functions, program.runtime[0]!.prepared.functions];
      for (const functions of populations)
        for (const fn of functions)
          for (const block of fn.blocks) {
            if (mutation === "projection extraction removed") {
              const index = block.instrs.findIndex((row) => row.kind === "intrinsic" && row.id === "js.boolean.unbox");
              if (index >= 0) {
                (block.instrs as IrInstr[]).splice(index, 1);
                changed++;
              }
            } else if (mutation === "raw extraction") {
              const call = block.instrs.find(
                (row) =>
                  row.kind === "call" &&
                  row.target.binding.kind === "intrinsic" &&
                  row.target.binding.symbol.startsWith("js.closure.call:"),
              );
              if (call?.kind === "call")
                for (const row of block.instrs)
                  if (row.kind === "intrinsic" && row.id === "js.boolean.unbox") {
                    Object.assign(row, { args: [call.args[0]!] });
                    changed++;
                  }
            } else if (fn.closureSubtype && block.terminator.kind === "return") {
              const numeric = block.instrs.find(
                (row) => row.resultType?.kind === "val" && row.resultType.val.kind === "f64" && row.result !== null,
              );
              if (numeric) {
                Object.assign(block.terminator, { values: [numeric.result] });
                changed++;
              }
            }
          }
      expect(changed).toBeGreaterThan(0);
      expect(() => assertNativeInvocationRequirementsCurrent(positive.invocation)).toThrow();
      let fresh: ReturnType<typeof requirements> | undefined;
      try {
        fresh = requirements(program);
      } catch (error) {
        expect(String(error)).toMatch(/source|closure|Boolean|invocation|projection|program|invalid|allocation/i);
        return;
      }
      expect(fresh.invocation.gaps.length).toBeGreaterThan(0);
    });
  for (const kind of ["missing", "copied"] as const)
    it(`requires the ${kind === "missing" ? "present" : "original"} native Boolean owner for call results`, () => {
      vi.stubEnv("JS2WASM_IR_GVN", "0");
      const f = getterInvocationFixture(prepare());
      const d = {
        ...f.dependencies,
        booleanBoxes: kind === "missing" ? undefined : { ...f.dependencies.booleanBoxes! },
      };
      const before = structuredClone(f.module);
      expect(() => reserveNativeInvocationResources(f.tx, f.invocation, d)).toThrow(/Boolean|boxing|foreign|copied/);
      expect(f.module).toStrictEqual(before);
    });
});
