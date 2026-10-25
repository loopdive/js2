// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { emitBinary } from "../src/emit/binary.js";

// Authentication checks use the same realm producer as the public consumer.
import { realmFixture, fillRealmFixture } from "./helpers/native-realm-source-integration.js";
import {
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
  nativeRealmSourceClosureCallableBindings,
} from "../src/ir/program-native-invocation.js";
import { fillNativeStringValueResources } from "../src/backend/wasmgc/program/native-string-values.js";
import { fillNativeRealmResources } from "../src/backend/wasmgc/program/native-realm.js";
import {
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../src/backend/wasmgc/resources/native-invocation.js";

const source = `export function make(): (value: boolean) => boolean {
  return (value: boolean): boolean => value;
}
export function numeric(): (value: number) => number { return (value: number): number => value; }
export function empty(): string { return ""; }
export function text(): string { return "hello"; }`;
interface Runtime {
  make(): unknown;
  numeric(): unknown;
  empty(): unknown;
  text(): unknown;
  apply(callee: unknown, receiver: unknown, args: unknown): unknown;
  newVector(): unknown;
  push(vector: unknown, value: unknown): void;
  boxNumber(value: number): unknown;
  boxBoolean(value: number): unknown;
  unbox(value: unknown): number;
  undefinedValue(): unknown;
}
afterEach(() => vi.unstubAllEnvs());
describe("runtime source-slot association", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`calls an actual exported source factory without any static call site, decoded=${decoded}, utf8=${utf8Storage}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", "0");
        // Unsupported frontend Boolean boxing remains unchanged. Runtime result
        // conversion is selected from the actual lifted signature independently.
        const program = prepareGetterProgram(source, decoded);
        const requirements = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
        const selected = planNativeInvocationRequirements(requirements, { utf8Storage })!;
        expect(selected.uses).toEqual([]);
        expect(selected.getterUses).toEqual([]);
        expect(requirements.units).toHaveLength(2);
        const outcome = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome));
        const module = structuredClone(outcome.run.emitted.module);
        expect(module.imports).toEqual([]);
        const observers = {
          apply: "__apply_closure_arguments",
          newVector: "__objvec_new",
          push: "__objvec_push",
          boxNumber: "__box_number",
          boxBoolean: "__box_boolean",
          unbox: "__unbox_number",
          undefinedValue: "__closure_undefined",
        };
        for (const [name, actual] of Object.entries(observers)) {
          const matches = module.functions.flatMap((fn, index) => (fn.name === actual ? [index] : []));
          expect(matches, actual).toHaveLength(1);
          module.exports.push({ name, desc: { kind: "func", index: matches[0]! } });
        }
        const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
        const r = new WebAssembly.Instance(compiled).exports as unknown as Runtime;
        const callback = r.make();
        for (const expected of [0, 1, 0]) {
          const args = r.newVector();
          r.push(args, r.boxBoolean(expected));
          expect(r.apply(callback, null, args)).toBe(r.boxBoolean(expected));
        }
        // A typed i32 entry cannot preserve these JavaScript values. Until
        // generic source lowering exists, it must refuse instead of coercing.
        for (const value of [
          null,
          r.undefinedValue(),
          r.boxNumber(0),
          r.boxNumber(0.5),
          r.empty(),
          r.text(),
          callback,
          r.newVector(),
        ]) {
          const args = r.newVector();
          r.push(args, value);
          expect(() => r.apply(callback, null, args)).toThrow(WebAssembly.Exception);
        }
        expect(() => r.apply(callback, null, r.newVector())).toThrow(WebAssembly.Exception);
        const numberCallback = r.numeric();
        const numbers = r.newVector();
        r.push(numbers, r.boxNumber(0.5));
        expect(r.unbox(r.apply(numberCallback, null, numbers))).toBe(0.5);
        expect(() => r.apply(numberCallback, null, r.newVector())).toThrow(WebAssembly.Exception);
        const wrongNumber = r.newVector();
        r.push(wrongNumber, r.boxBoolean(1));
        expect(() => r.apply(numberCallback, null, wrongNumber)).toThrow(WebAssembly.Exception);
        const valid = r.newVector();
        r.push(valid, r.boxBoolean(1));
        expect(r.apply(callback, null, valid)).toBe(r.boxBoolean(1));
      }, 120000);
});

const booleanFactory = `export function make(): (value: boolean) => boolean { return (value: boolean): boolean => value; }`;
function associationFixture() {
  const f = realmFixture(prepareGetterProgram(booleanFactory));
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, f.source!, f.slots);
  fillNativeStringValueResources(f.tx, f.strings);
  fillNativeRealmResources(f.tx, f.realm);
  return {
    f,
    selected: nativeSourceClosureCallableBindings(f.tx, f.source!, f.input.invocationRequirements!),
    all: nativeRealmSourceClosureCallableBindings(f.tx, f.source!, f.requirements),
  };
}
it.each(["copied", "foreign"] as const)(
  "rejects a %s realm callable association before filling invocation bodies",
  (kind) => {
    const { f, selected, all } = associationFixture();
    expect(selected.entries).toEqual([]);
    expect(all.entries).toHaveLength(1);
    const bad = kind === "copied" ? { ...all } : associationFixture().all;
    const before = structuredClone(f.module.functions);
    expect(() => fillNativeInvocationResources(f.tx, f.invocation!, selected, f.kernel.exception, bad)).toThrow(
      /foreign|copied/,
    );
    expect(f.module.functions).toEqual(before);
    fillNativeInvocationResources(f.tx, f.invocation!, selected, f.kernel.exception, all);
  },
);
it("rechecks an unselected source slot when completing the invocation owner", () => {
  const f = realmFixture(prepareGetterProgram(booleanFactory));
  fillRealmFixture(f);
  const all = nativeRealmSourceClosureCallableBindings(f.tx, f.source!, f.requirements);
  expect(all.entries).toHaveLength(1);
  all.entries[0]!.slot.object.body.push({ op: "nop" });
  expect(() => requireCompletedNativeInvocation(f.tx, f.invocation!)).toThrow(/altered|canonical|changed/);
});
