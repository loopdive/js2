// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REALM_CALL_SOURCE,
  realmFixture,
  realmFoundation,
  realmSource,
  fillRealmFixture,
} from "./helpers/native-realm-source-integration.js";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createEmptyModule } from "../src/ir/types.js";
import {
  reserveNativeRealmKernel,
  nativeRealmReservationInventory,
} from "../src/backend/wasmgc/program/native-realm.js";
import {
  bindNativeInvocationBuiltins,
  nativeInvocationFunctions,
  requireCompletedNativeInvocation,
  reserveNativeInvocationArgumentApply,
} from "../src/backend/wasmgc/resources/native-invocation.js";
import { buildArgumentVectorApplyAdapter } from "../src/runtime/wasmgc/values/argument-vector-call-adapters.js";

let encoded: string;
function program(decoded = true) {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  if (!decoded) return prepareGetterProgram(REALM_CALL_SOURCE);
  encoded ??= encodePreparedIrProgram(prepareGetterProgram(REALM_CALL_SOURCE));
  return decodePreparedIrProgram(encoded);
}
afterEach(() => vi.unstubAllEnvs());
function thrown(run: () => unknown, tag: WebAssembly.Tag) {
  let result: unknown;
  try {
    run();
  } catch (error) {
    result = error;
  }
  expect(result).toBeInstanceOf(WebAssembly.Exception);
  expect((result as WebAssembly.Exception).is(tag)).toBe(true);
}

describe("productive mixed invocation", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`executes the public consumer's actual dispatcher and shared tag, decoded=${decoded}, utf8=${utf8Storage}`, async () => {
        const outcome = await replayProgram(program(decoded), {
          ...replayOptions("wasmgc", "standalone"),
          utf8Storage,
        });
        if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome));
        expect((outcome.run.exports.run as () => number)()).toBe(94);
        // Observation-only exports on a clone of the fully emitted public module.
        // No function, global, tag, layout or body is supplied or replaced here.
        const module = structuredClone(outcome.run.emitted.module);
        expect(module.imports).toEqual([]);
        expect(module.tags.map((tag) => tag.name)).toEqual(["__exn"]);
        const selected = {
          method: "__call_fn_method_2",
          apply: "__apply_closure_arguments",
          prototype: ":function-prototype:getter",
          thrower: ":throw-type-error:getter",
          vector: "__objvec_new",
          undefinedValue: "__closure_undefined",
        };
        for (const [name, suffix] of Object.entries(selected)) {
          const matches = module.functions.flatMap((fn, index) => (fn.name.endsWith(suffix) ? [index] : []));
          expect(matches, suffix).toHaveLength(1);
          module.exports.push({ name: "observer_" + name, desc: { kind: "func", index: matches[0]! } });
        }
        module.exports.push({ name: "observer_exception", desc: { kind: "tag", index: 0 } });
        const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
        const r = new WebAssembly.Instance(compiled).exports as unknown as {
          observer_method(receiver: unknown, callee: unknown, a: unknown, b: unknown): unknown;
          observer_apply(callee: unknown, receiver: unknown, vector: unknown): unknown;
          observer_prototype(): unknown;
          observer_thrower(): unknown;
          observer_vector(): unknown;
          observer_undefinedValue(): unknown;
          observer_exception: WebAssembly.Tag;
          run(): number;
        };
        const native = r.observer_prototype(),
          vector = r.observer_vector(),
          receiver = { actual: true };
        expect(r.observer_method(receiver, native, 4, 7)).toBe(r.observer_undefinedValue());
        expect(r.observer_apply(native, receiver, vector)).toBe(r.observer_undefinedValue());
        thrown(() => r.observer_method(null, r.observer_thrower(), 4, 7), r.observer_exception);
        thrown(() => r.observer_apply(native, receiver, {}), r.observer_exception);
        const other = new WebAssembly.Instance(compiled).exports as unknown as typeof r;
        thrown(() => r.observer_apply(other.observer_prototype(), receiver, vector), r.observer_exception);
        expect(r.run()).toBe(94);
      }, 120000);

  it("executes null-as-empty typed vector adaptation against the actual joined owner", () => {
    const f = realmFixture(program(), true, true),
      input = f.foundation.vectorTypes.layouts.find((row) => row.element === "externref")!;
    const apply = reserveNativeInvocationArgumentApply(f.tx, f.invocation!);
    const adapter = f.tx.reserveFunction("nullable-apply-control", "nullableApply", {
      params: [{ kind: "externref" }, { kind: "externref" }, { kind: "ref_null", typeIdx: input.carrier.typeIndex }],
      results: [{ kind: "externref" }],
    });
    fillRealmFixture(f);
    f.tx.fillFunction(
      adapter,
      buildArgumentVectorApplyAdapter(
        {
          newVector: f.invocation!.arguments.newVector.handle,
          push: f.invocation!.arguments.push.handle,
          call: apply.handle,
        },
        { vectorTypeIdx: input.carrier.typeIndex, arrayTypeIdx: input.array.typeIndex },
      ),
    );
    f.tx.defineExport("test:nullable", "apply", adapter);
    f.tx.defineExport(
      "test:prototype",
      "prototype",
      f.kernel.entries.find((row) => row.id === "function-prototype")!.getter,
    );
    f.tx.defineExport("test:undefined", "undefinedValue", f.invocation!.undefinedValue);
    f.tx.seal();
    const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
    const r = new WebAssembly.Instance(compiled).exports as unknown as {
      apply(fn: unknown, receiver: unknown, vector: unknown): unknown;
      prototype(): unknown;
      undefinedValue(): unknown;
    };
    expect(r.apply(r.prototype(), { receiver: true }, null)).toBe(r.undefinedValue());
  });

  it("rejects copied and foreign builtin owners without adding a dispatcher", () => {
    const f = realmSource(realmFoundation(program())),
      kernel = reserveNativeRealmKernel(f.tx, f.realm, f.source!.types);
    const before = f.module.functions.length;
    expect(() => bindNativeInvocationBuiltins(f.tx, f.invocation!, { ...kernel })).toThrow(/foreign|copied/);
    const foreign = realmFixture(program());
    expect(() => bindNativeInvocationBuiltins(f.tx, f.invocation!, foreign.kernel)).toThrow(/foreign|copied/);
    expect(f.module.functions).toHaveLength(before);
    bindNativeInvocationBuiltins(f.tx, f.invocation!, kernel);
    expect(
      nativeInvocationFunctions(f.tx, f.invocation!).filter((fn) => fn.object.name === "__apply_closure_arguments"),
    ).toHaveLength(1);
    expect(() => bindNativeInvocationBuiltins(f.tx, f.invocation!, kernel)).toThrow(/duplicate/);
  });

  it.each(["foreign", "copied", "signature"] as const)(
    "rejects %s exception tags before any kernel mutation",
    (kind) => {
      const f = realmSource(realmFoundation(program()));
      const tagOwner = kind === "foreign" ? new PhysicalModuleReservations(createEmptyModule()) : f.tx;
      const tag = tagOwner.reserveTag(
        "candidate",
        { params: [{ kind: kind === "signature" ? "i32" : "externref" }], results: [] },
        { kind: "defined", name: "candidate" },
      );
      const before = [f.module.types.length, f.module.functions.length, f.module.globals.length, f.module.tags.length];
      expect(() =>
        reserveNativeRealmKernel(f.tx, f.realm, f.source!.types, kind === "copied" ? { ...tag } : tag),
      ).toThrow(/foreign|unowned|signature|token/);
      expect([f.module.types.length, f.module.functions.length, f.module.globals.length, f.module.tags.length]).toEqual(
        before,
      );
    },
  );
  it("borrows the physical tag without claiming or allocating another tag", () => {
    const f = realmSource(realmFoundation(program()));
    const shared = f.tx.reserveTag(
      "shared",
      { params: [{ kind: "externref" }], results: [] },
      { kind: "defined", name: "shared" },
    );
    const kernel = reserveNativeRealmKernel(f.tx, f.realm, f.source!.types, shared);
    expect(kernel.exception).toBe(shared);
    expect(nativeRealmReservationInventory(f.tx, f.realm).tags).toEqual([]);
    expect(f.module.tags).toHaveLength(1);
  });

  it("rechecks canonical builtin completion after source completion", () => {
    const f = realmFixture(program());
    fillRealmFixture(f);
    f.kernel.functions.match.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeInvocation(f.tx, f.invocation!)).toThrow(/altered|canonical|changed/);
  });
});
