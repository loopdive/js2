// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import * as frontend from "../src/ir/identity.js";
import * as data from "../src/ir/identity-values.js";

describe("source-free canonical identity factories", () => {
  it("retains identical public re-exports and canonical escaped output", () => {
    expect(frontend.createIrBindingId).toBe(data.createIrBindingId);
    expect(frontend.createDerivedIrUnitId).toBe(data.createDerivedIrUnitId);
    const parentId = "ir-unit:v1:opaque/source:☃" as frontend.IrUnitId;
    expect(data.createDerivedIrUnitId({ parentId, role: "ir-async-state", ordinal: 7 })).toBe(
      `ir-unit:v1:derived:${encodeURIComponent(parentId)}:ir-async-state:0000000000000007`,
    );
    expect(data.createIrBindingId({ ownerId: parentId, domain: "callable", role: "body/value" })).toBe(
      `ir-binding:v1:callable:${encodeURIComponent(parentId)}:body%2Fvalue:0000000000000000`,
    );
  });

  it("preserves invalid ordinal refusals", () => {
    const parentId = "ir-unit:v1:test" as frontend.IrUnitId;
    for (const ordinal of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => data.createDerivedIrUnitId({ parentId, role: "ir-async-state", ordinal })).toThrow(RangeError);
      expect(() => data.createIrBindingId({ ownerId: parentId, domain: "callable", role: "body", ordinal })).toThrow(
        RangeError,
      );
    }
  });
});
