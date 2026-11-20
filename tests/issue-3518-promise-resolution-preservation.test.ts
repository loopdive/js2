// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseSettleClosureValue,
} from "../src/runtime/wasmgc/promise/resolution-bodies.js";
import {
  buildPromisePeelValue,
  buildPromiseThenableClassifier,
  type PromiseThenableInventory,
} from "../src/runtime/wasmgc/promise/thenable-bodies.js";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("Promise resolution bodies", () => {
  it("declares seven resolution locals", () => {
    expect(buildPromiseResolveValueLocals(1)).toHaveLength(7);
  });
  it("rejects missing or unfinished classification inventory", () => {
    expect(() => buildPromiseThenableClassifier({} as PromiseThenableInventory)).toThrow("not finalized");
    expect(() => buildPromisePeelValue(undefined as never)).toThrow("missing");
    expect(() => buildNativePromiseResolveValueBody({ thenable: null } as never)).toThrow("complete");
    expect(() =>
      buildNativePromiseResolveValueBody({
        thenable: {},
        selfResolutionStringInstrs: [{ op: "global.get", index: 1 }],
      } as never),
    ).toThrow("invalid thenable binding");
  });
  it("observes changed finalized inventories and rejects an accessor without its driver", () => {
    const inventory: PromiseThenableInventory = {
      finalized: true,
      peelFuncIdx: 1,
      methodTypeIdxs: [2],
      accessors: [{ typeIdx: 3, getGlobal: 4 }],
      callAccessorGetIdx: 5,
      fields: [{ typeIdx: 3, fieldIdx: 6 }],
      closureWrapperTypeIdxs: [7],
      openObject: null,
    };
    const original = plain(buildPromiseThenableClassifier(inventory));
    expect(plain(buildPromiseThenableClassifier({ ...inventory, closureWrapperTypeIdxs: [8] }))).not.toEqual(original);
    expect(
      plain(buildPromiseThenableClassifier({ ...inventory, accessors: [{ typeIdx: 3, getGlobal: 9 }] })),
    ).not.toEqual(original);
    expect(() => buildPromiseThenableClassifier({ ...inventory, callAccessorGetIdx: undefined })).toThrow(
      "getter binding",
    );
    expect(() => buildPromiseThenableClassifier({ ...inventory, fields: undefined } as never)).toThrow("not finalized");
    expect(() => buildPromiseThenableClassifier({ ...inventory, finalized: false } as never)).toThrow("not finalized");
  });
  it("settle closure metadata and bodies have independent instructions", () => {
    const resources = { capTypeIdx: 4, capMetaTypeIdx: 5, capPromiseFieldIdx: 5 };
    const first = buildPromiseSettleClosureValue(resources, 6, [{ op: "local.get", index: 2 }]);
    const second = buildPromiseSettleClosureValue(resources, 6, [{ op: "local.get", index: 2 }]);
    expect(plain(first)).toEqual(plain(second));
    expect(first[0]).not.toBe(second[0]);
  });
});
