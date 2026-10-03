// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { PRIMITIVE_WRAPPER_KINDS as kinds } from "../src/runtime/wasmgc/values/primitive-wrapper-layouts.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
  requireNativePrimitiveWrapperLayouts,
} from "../src/backend/wasmgc/resources/native-primitive-wrapper-layouts.js";
import { realmWrapperFixture, realmWrapperRuntime } from "./helpers/native-realm-wrapper-storage.js";
import { realmLayoutFixture } from "./helpers/native-realm-object-layouts.js";

afterEach(async () => {
  await setImmediate();
});
for (const displaced of [false, true])
  describe("stateful wrapper storage, displaced=" + displaced, () => {
    let r: ReturnType<typeof realmWrapperRuntime>;
    beforeAll(() => {
      r = realmWrapperRuntime(displaced);
    });
    it("composes real zero-import owners while retaining each narrow completion scope", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.r.state.completionScope).toBe("realm-carrier-state-only");
      expect(r.r.wrappers.completionScope).toBe("primitive-wrapper-storage");
      expect(r.r.create.completionScope).toBe("string-create-own-length");
      expect(r.api.isUtf8(r.api.payload.value)).toBe(Number(displaced));
    });
    it.each(kinds)("keeps %s payload at six and real prototype state at seven", (kind) => {
      const prototype = { control: "explicit prototype operand" };
      r.api.initialize(prototype);
      const values = {
        Boolean: 1,
        Number: -0,
        String: r.api.payload.value,
        Symbol: r.api.symbol(9),
        BigInt: r.api.wideBigInt(),
      };
      const value = values[kind],
        first = r.api["new" + kind](prototype, value),
        second = r.api["new" + kind](prototype, value);
      expect(Object.is(first, second)).toBe(false);
      expect(Object.is(r.api["read" + kind](first), value)).toBe(true);
      const state = r.api["state" + kind](first),
        other = r.api["state" + kind](second);
      expect(Object.is(state, other)).toBe(false);
      expect(Object.is(r.api.prototype(state), prototype)).toBe(true);
      expect(Object.is(r.api.realm(state), r.api.realm(other))).toBe(true);
      expect(r.api.prefix(first)).toBe(1);
      expect(r.api.ownCount(first)).toBe(0);
      const type = r.r.layouts.types[kind].object;
      if (type.kind !== "struct") throw new Error("missing concrete wrapper");
      expect(type.fields).toHaveLength(8);
      expect(type.fields[6]!.name).toBe("[[" + kind + "Data]]");
      expect(type.fields[7]).toMatchObject({
        name: "[[ObjectState]]",
        mutable: false,
        type: { kind: "ref", typeIdx: r.r.state.types.state.typeIndex },
      });
    });
    it("preserves canonical StringCreate length and virtual indices with actual selected String encoding", () => {
      r.api.initialize({ control: "source prototype operand" });
      const object = r.api.stringCreate(null, r.api.payload.value),
        state = r.api.stateString(object);
      expect(r.api.prototype(state)).toBeNull();
      expect(r.api.prefix(object)).toBe(1);
      expect(Object.is(r.api.readString(object), r.api.payload.value)).toBe(true);
      expect(r.api.unbox(r.api.ownValue(object, r.api.keylength.value))).toBe(r.text.length);
      expect(r.api.ownFlags(object, r.api.keylength.value)).toBe(0);
      expect(r.api.ownSequence(object, r.api.keylength.value)).toBe(0);
      expect(r.api.nextSequence(object)).toBe(1);
      expect(r.api.ownCount(object)).toBe(1);
      for (let index = 0; index < r.text.length; index++) {
        const character = r.api.ownValue(object, r.api["key" + index].value);
        expect(r.api.length(character)).toBe(1);
        expect(r.api.codeUnit(character, 0)).toBe(r.text.charCodeAt(index));
        expect(r.api.ownFlags(object, r.api["key" + index].value)).toBe(2);
      }
      expect(r.api.ownCount(object)).toBe(1);
    });
    it("retains Number edge payloads exactly with a fresh immutable state reference", () => {
      const prototype = { control: "Number wrapper prototype" };
      r.api.initialize(prototype);
      for (const value of [NaN, Infinity, -Infinity, -0, 0, 1.5]) {
        const wrapped = r.api.newNumber(prototype, value);
        expect(Object.is(r.api.readNumber(wrapped), value)).toBe(true);
        expect(Object.is(r.api.prototype(r.api.stateNumber(wrapped)), prototype)).toBe(true);
      }
    });
  });

describe("stateful wrapper dependency authentication", () => {
  it.each(["undefined", "null", "accessor", "hidden", "copied", "foreign"])(
    "rejects %s optional state before allocation",
    (kind) => {
      const r = realmWrapperFixture(),
        input = { ...r.layoutDependencies };
      let reads = 0;
      if (kind === "undefined") input.realmState = undefined as never;
      if (kind === "null") input.realmState = null as never;
      if (kind === "copied") input.realmState = { ...r.state };
      if (kind === "foreign") input.realmState = realmLayoutFixture().pack;
      if (kind === "accessor")
        Object.defineProperty(input, "realmState", {
          get() {
            reads++;
            return r.state;
          },
          enumerable: true,
        });
      if (kind === "hidden") Object.defineProperty(input, "realmState", { value: r.state, enumerable: false });
      const before = structuredClone(r.f.module);
      expect(() => reserveNativePrimitiveWrapperLayouts(r.f.tx, "stateful:wrappers", r.layoutPlan, input)).toThrow(
        /realm state|foreign or copied/,
      );
      expect(reads).toBe(0);
      expect(r.f.module).toEqual(before);
    },
  );
  it("rejects removal of a retained state role", () => {
    const r = realmWrapperFixture();
    expect(requireNativePrimitiveWrapperLayouts(r.f.tx, r.layouts, r.layoutPlan, r.layoutDependencies)).toBe(r.layouts);
    Reflect.deleteProperty(r.layoutDependencies, "realmState");
    expect(() => requireNativePrimitiveWrapperLayouts(r.f.tx, r.layouts, r.layoutPlan, r.layoutDependencies)).toThrow(
      /changed realm state identity/,
    );
  });
  it("does not admit a state tail from descriptive declaration data alone", () => {
    const r = realmWrapperFixture(),
      keys = {
        object: r.f.objects.object.key,
        propMap: r.f.objects.propMap.key,
        anyString: "strings:any",
        symbol: r.f.symbols.types.symbol.key,
      };
    const plan = declareNativePrimitiveWrapperLayouts("unowned-tail", keys, r.state.types.state.key);
    const before = structuredClone(r.f.module);
    expect(() => reserveNativePrimitiveWrapperLayouts(r.f.tx, "unowned-tail", plan, r.f.layoutDependencies)).toThrow(
      /substituted declaration/,
    );
    expect(r.f.module).toEqual(before);
  });
});
