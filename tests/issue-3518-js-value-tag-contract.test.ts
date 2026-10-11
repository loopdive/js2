// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { JsTag, jsTagUnboxKind, JS_NUMBER_F64_TAG, JS_BOOLEAN_TAG } from "../src/runtime/contracts/js-value-tags.js";
import { JsTag as LegacyJsTag, jsTagUnboxKind as legacyCarrier } from "../src/ir/js-tag.js";
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";

const partitions = [
  ["Null", 0, null],
  ["Undefined", 1, null],
  ["NumberI32", 2, "i32"],
  ["NumberF64", 3, "f64"],
  ["Boolean", 4, "i32"],
  ["String", 5, "ref"],
  ["Object", 6, "ref"],
  ["Function", 7, "ref"],
] as const;

describe("canonical JS boxed-value ABI remains compatible", () => {
  it.each(partitions)("preserves %s tag %i and carrier %s", (name, value, carrier) => {
    expect(JsTag[name]).toBe(value);
    expect(LegacyJsTag[name]).toBe(value);
    expect(JS_TAG_IDS[name]).toBe(value);
    expect(jsTagUnboxKind(JsTag[name])).toBe(carrier);
    expect(legacyCarrier(LegacyJsTag[name])).toBe(carrier);
  });
  it("retains identical enum and carrier function objects through the existing API", () => {
    expect(LegacyJsTag).toBe(JsTag);
    expect(legacyCarrier).toBe(jsTagUnboxKind);
    expect(JS_NUMBER_F64_TAG).toBe(JS_TAG_IDS.NumberF64);
    expect(JS_BOOLEAN_TAG).toBe(JS_TAG_IDS.Boolean);
  });
});
