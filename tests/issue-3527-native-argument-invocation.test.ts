// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import {
  throwingGetterSubstrateRuntime,
  sourceSubstrateFixture,
  sourceSubstrateRuntime,
  SUBSTRATE_SOURCE,
} from "./helpers/native-invocation-substrate.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";

import {
  nativeInvocationFunctions,
  reserveNativeInvocationArgumentApply,
} from "../src/backend/wasmgc/resources/native-invocation.js";

import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";

afterEach(() => vi.unstubAllEnvs());
describe("native runtime ArgumentVector through the source invocation owner", () => {
  for (const borrowed of [false, true])
    for (const replay of [false, true])
      it(`executes actual source captures and preserves invocation state, borrowed=${borrowed}, replay=${replay}`, () => {
        vi.stubEnv("JS2WASM_IR_GVN", "0");
        const original = prepareGetterProgram(SUBSTRATE_SOURCE);
        const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
        const fixture = sourceSubstrateFixture(program, borrowed, true, true);
        const runtime = sourceSubstrateRuntime(fixture);
        const receiver = { caller: true };
        runtime.currentThis.value = receiver;
        runtime.argc.value = 73;
        const empty = runtime.newVector();
        runtime.extras.value = empty;
        const fn = runtime.makeCall(13);
        const vector = runtime.newVector();
        for (let i = 0; i < 12; i++) runtime.push(vector, runtime.boxNumber(i + 4));
        expect(runtime.capacity(vector)).toBe(16);
        expect(runtime.unboxNumber(runtime.applyArguments(fn, null, vector))).toBe(58);
        expect(runtime.unboxNumber(runtime.applyArguments(runtime.makeCall(27), null, vector))).toBe(72);
        expect(runtime.unboxNumber(runtime.applyArguments(runtime.makeGetter(9), receiver, empty))).toBe(13);
        expect(runtime.unboxNumber(runtime.applyArguments(fn, receiver, empty))).toBeNaN();
        for (const invalid of [null, undefined, {}, runtime.boxNumber(3), fn]) {
          let caught: WebAssembly.Exception | undefined;
          try {
            runtime.applyArguments(fn, null, invalid);
          } catch (error) {
            caught = error as WebAssembly.Exception;
          }
          expect(caught).toBeInstanceOf(WebAssembly.Exception);
          expect(caught!.is(runtime.exception)).toBe(true);
          expect(runtime.errorTag(caught!.getArg(runtime.exception, 0))).toBe(-11);
        }
        for (const invalid of [null, undefined, {}, runtime.boxNumber(3)]) {
          let caught: WebAssembly.Exception | undefined;
          try {
            runtime.applyArguments(invalid, null, vector);
          } catch (error) {
            caught = error as WebAssembly.Exception;
          }
          expect(caught).toBeInstanceOf(WebAssembly.Exception);
          expect(caught!.is(runtime.exception)).toBe(true);
          expect(runtime.errorTag(caught!.getArg(runtime.exception, 0))).toBe(-11);
        }
        expect(runtime.currentThis.value).toBe(receiver);
        expect(runtime.argc.value).toBe(73);
        expect(runtime.extras.value).toBe(empty);
        expect(fixture.module.imports).toEqual([]);
      });
  it("joins the public source consumer to one shared runtime entry", async () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = prepareGetterProgram(`export function run(): number {
      const captured = 13;
      const fn = function(a: number, b: number): number { return captured + a * 10 + b; };
      return fn.call(null, 2, 3) + fn.apply(null, [4, 5]);
    }`);
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect((outcome.run.exports.run as () => number)()).toBe(94);
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect(outcome.run.emitted.module.functions.filter((fn) => fn.name === "__apply_closure_arguments")).toHaveLength(
      1,
    );
  });
  it("allocates once on consumer request and refuses foreign owners or late requests", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = prepareGetterProgram(SUBSTRATE_SOURCE);
    const fixture = sourceSubstrateFixture(program);
    const other = sourceSubstrateFixture(program);
    const before = nativeInvocationFunctions(fixture.tx, fixture.pack);
    expect(before.some((fn) => fn.object.name === "__apply_closure_arguments")).toBe(false);
    expect(() => reserveNativeInvocationArgumentApply(fixture.tx, { ...fixture.pack })).toThrow(
      "foreign or copied invocation owner",
    );
    expect(() => reserveNativeInvocationArgumentApply(other.tx, fixture.pack)).toThrow(
      "foreign or copied invocation owner",
    );
    const entry = reserveNativeInvocationArgumentApply(fixture.tx, fixture.pack);
    expect(reserveNativeInvocationArgumentApply(fixture.tx, fixture.pack)).toBe(entry);
    expect(nativeInvocationFunctions(fixture.tx, fixture.pack)).toEqual([...before, entry]);
    fixture.tx.freezeReservations();
    expect(() => reserveNativeInvocationArgumentApply(fixture.tx, fixture.pack)).toThrow("reservation phase");
  });
  it("restores invocation state and preserves an exception from the actual source body", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = prepareGetterProgram(`export function run(message: string): number {
      const object = { get value(): number { throw message; } };
      return object.value;
    }`);
    const fixture = sourceSubstrateFixture(program, true, false, true);
    const runtime = throwingGetterSubstrateRuntime(fixture);
    const message = runtime.typeErrorName();
    const previousThis = { before: true };
    const previousExtras = runtime.newVector();
    runtime.push(previousExtras, message);
    runtime.currentThis.value = previousThis;
    runtime.argc.value = 41;
    runtime.extras.value = previousExtras;
    let caught: WebAssembly.Exception | undefined;
    try {
      runtime.applyArguments(runtime.make(message), null, runtime.newVector());
    } catch (error) {
      caught = error as WebAssembly.Exception;
    }
    expect(caught).toBeInstanceOf(WebAssembly.Exception);
    expect(caught!.is(runtime.exception)).toBe(true);
    expect(caught!.getArg(runtime.exception, 0)).toBe(message);
    expect(runtime.currentThis.value).toBe(previousThis);
    expect(runtime.argc.value).toBe(41);
    expect(runtime.extras.value).toBe(previousExtras);
    expect(runtime.at(previousExtras, 0)).toBe(message);
    expect(fixture.module.imports).toEqual([]);
  });
});
