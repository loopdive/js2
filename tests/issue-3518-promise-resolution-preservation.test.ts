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
  buildPromiseThenableLookup,
  type PromiseThenableInventory,
} from "../src/runtime/wasmgc/promise/thenable-bodies.js";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("Promise resolution bodies", () => {
  it("builds the thenable lookup with independent result pairs and its read order", () => {
    const actual = plain(
      buildPromiseThenableLookup({
        finalized: true,
        peelFuncIdx: 41,
        methodTypeIdxs: [8],
        accessors: [{ typeIdx: 9, getGlobal: 55 }],
        callAccessorGetIdx: 42,
        fields: [{ typeIdx: 9, fieldIdx: 2 }],
        closureWrapperTypeIdxs: [11],
        openObject: { typeIdx: 13, externGetFuncIdx: 43, thenStringInstrs: [{ op: "global.get", index: 60 }] },
      }),
    );
    const failure = [{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }, { op: "return" }];
    const callable = [{ op: "i32.const", value: 1 }, { op: "local.get", index: 4 }, { op: "return" }];
    const afterRead = [
      { op: "local.tee", index: 4 }, // preserve externref BEFORE any conversion
      { op: "any.convert_extern" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: 11 },
      { op: "if", blockType: { kind: "empty" }, then: callable },
      ...failure,
    ];
    expect(actual).toEqual({
      locals: [
        { name: "__peeled", type: { kind: "externref" } },
        { name: "__any", type: { kind: "anyref" } },
        { name: "__thenAny", type: { kind: "anyref" } },
        { name: "__capturedThen", type: { kind: "externref" } },
      ],
      body: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: 41 },
        { op: "local.set", index: 1 },
        { op: "local.get", index: 1 },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: failure },
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 2 },
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: 8 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 1 }, { op: "ref.null.extern" }, { op: "return" }],
        },
        // Same type9 has accessor AND field. The guarded accessor precedes field.
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: 9 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: 55 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "global.get", index: 55 },
                { op: "call", funcIdx: 42 },
                ...afterRead,
              ],
            },
            // No return here: a null getter falls through to the field arm.
          ],
        },
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: 9 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx: 9 },
            { op: "struct.get", typeIdx: 9, fieldIdx: 2 },
            ...afterRead,
          ],
        },
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: 13 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "global.get", index: 60 },
            { op: "call", funcIdx: 43 },
            ...afterRead,
          ],
        },
        { op: "i32.const", value: 0 },
        { op: "ref.null.extern" },
      ],
    });
    // Explicit denominators, independent of the shape equality assertion.
    const flat: any[] = [];
    function walk(body: any[]): void {
      for (const instruction of body) {
        flat.push(instruction);
        if (instruction.then) walk(instruction.then);
        if (instruction.else) walk(instruction.else);
      }
    }
    walk(actual.body);
    expect(flat.filter((i) => i.op === "call" && i.funcIdx === 42)).toHaveLength(1);
    expect(flat.filter((i) => i.op === "struct.get")).toEqual([{ op: "struct.get", typeIdx: 9, fieldIdx: 2 }]);
    expect(flat.filter((i) => i.op === "call" && i.funcIdx === 43)).toHaveLength(1);
    expect(flat.filter((i) => i.op === "local.tee" && i.index === 4)).toHaveLength(3);
  });
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
