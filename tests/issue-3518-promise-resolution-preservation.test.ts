// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildTargetTaggedTry } from "../src/wasm/physical/exception-control.js";
import {
  buildPromiseResolveValueBody as buildResolutionBody,
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseThenableJob,
  buildPromiseSettleClosureValue,
  buildPromiseSettleClosureBody,
} from "../src/runtime/wasmgc/promise/resolution-bodies.js";
import {
  buildPromisePeelValue,
  buildPromiseThenableClassifier,
  buildPromiseThenableLookup,
  type PromiseThenableInventory,
} from "../src/runtime/wasmgc/promise/thenable-bodies.js";
import {
  asyncPath,
  closedPath,
  current,
  donorText,
  authenticateDonors,
  oldAsync,
  oldClosed,
  newAsync,
  newClosed,
  newLookupAdapter,
  plain,
  evaluate,
  originalSettleBody,
  mutatedSettleBuilder,
  resolutionFixture,
  classifierFixture,
  jobFixture,
  replaceOnce,
  changeLookupSignature,
  verifyLookupReservation,
  verifyActualLookupFill,
  verifyIndependentLookupBody,
  expectedCaptureDelta,
  expectedLookupReservation,
  assertMovedResolutionReceipt,
  declaration,
  sha256,
} from "./helpers/promise-resolution-receipts.js";

describe("Promise lookup independent instruction contract", () => {
  it("detects removal or alteration of the explicit settle capture-layout refusal", () => {
    const name = "buildPromiseSettleClosureInstrs";
    const digest = sha256(declaration(oldAsync, name).replace(/^function /, "export function "));
    assertMovedResolutionReceipt(name, digest);
    const source = current("src/runtime/wasmgc/promise/resolution-bodies.ts");
    for (const condition of ["false", "closures.capPromiseFieldIdx !== 17"]) {
      const mutated = replaceOnce(source, "closures.capPromiseFieldIdx !== 5", condition);
      const builder = evaluate(mutated, ["buildPromiseSettleClosureValue"], {}).buildPromiseSettleClosureValue;
      expect(() => assertMovedResolutionReceipt(name, digest, newAsync, builder)).toThrow();
    }
  });
  it("checks independent result pairs and read ordering before four live builder mutants", () => {
    verifyIndependentLookupBody(buildPromiseThenableLookup);
    const source = current("src/runtime/wasmgc/promise/thenable-bodies.ts");
    const mutations = [
      replaceOnce(source, '{ op: "local.tee", index: capturedThenLocalIdx }', '{ op: "nop" }'),
      replaceOnce(source, '{ op: "local.get", index: capturedThenLocalIdx }', '{ op: "ref.null.extern" }'),
      replaceOnce(source, "funcIdx: callAccessorGetIdx", "funcIdx: callAccessorGetIdx + 1"),
      replaceOnce(source, "fieldIdx: fe.fieldIdx", "fieldIdx: fe.fieldIdx + 1"),
    ];
    for (const mutated of mutations) {
      const builder = evaluate(mutated, ["buildThenableLookup", "buildPromiseThenableLookup"], {})
        .buildPromiseThenableLookup as typeof buildPromiseThenableLookup;
      expect(() => verifyIndependentLookupBody(builder)).toThrow();
    }
  });
});

describe("Promise lookup reservation and actual-object finalization", () => {
  it("checks parameter/result order and type wiring before live signature mutations", () => {
    verifyLookupReservation(newLookupAdapter);
    for (const mutated of [
      changeLookupSignature(newLookupAdapter, 1, [{ kind: "i32" }]),
      changeLookupSignature(newLookupAdapter, 2, [{ kind: "i32" }]),
      changeLookupSignature(newLookupAdapter, 2, [{ kind: "externref" }, { kind: "i32" }]),
      replaceOnce(newLookupAdapter, "typeIdx: lookupTypeIdx,", "typeIdx: peelTypeIdx,"),
    ])
      expect(() => verifyLookupReservation(mutated)).toThrow();
  });
  it("fills the registered lookup object before live omitted/wrong-fill mutations", () => {
    verifyActualLookupFill(newLookupAdapter);
    for (const mutated of [
      replaceOnce(newLookupAdapter, "if (lookupFn) {", "if (false && lookupFn) {"),
      replaceOnce(
        newLookupAdapter,
        "const lookup = buildPromiseThenableLookup(inventory);",
        "const lookup = buildPromiseThenableClassifier(inventory);",
      ),
      replaceOnce(newLookupAdapter, "lookupFn.body = lookup.body;", 'lookupFn.body = [{ op: "unreachable" }];'),
      replaceOnce(newLookupAdapter, "lookupFn.body = lookup.body;", "predFn.body = lookup.body;"),
      replaceOnce(newLookupAdapter, "lookupFn.locals = lookup.locals;", "void lookup.locals;"),
    ])
      expect(() => verifyActualLookupFill(mutated)).toThrow();
  });
});

describe("Promise resolution exact-base body preservation", () => {
  it("authenticates the self-contained receipt before rejecting altered donor text", () => {
    expect([...authenticateDonors(donorText).keys()]).toEqual([asyncPath, closedPath]);
    expect(() => authenticateDonors(donorText.replace('"schemaVersion": 1', '"schemaVersion": 2'))).toThrow(
      "digest mismatch",
    );
    expect(() => authenticateDonors(donorText + " ")).toThrow("digest mismatch");
  });
  for (const native of [false, true])
    for (const ownThen of [false, true])
      for (const callable of ["predicate", "root", "none"] as const)
        it("resolution resources " + JSON.stringify({ native, ownThen, callable }), () => {
          expect(resolutionFixture(newAsync, native, ownThen, callable)).toEqual(
            expectedCaptureDelta(resolutionFixture(oldAsync, native, ownThen, callable), native),
          );
        });
  it("preserves all seven resolution locals", () => {
    const old = evaluate(oldAsync, ["buildPromiseResolveValueLocals"], {});
    const result = buildPromiseResolveValueLocals(1);
    expect(result).toHaveLength(7);
    expect(plain(result)).toEqual(plain(old.buildPromiseResolveValueLocals(1)));
  });
  for (const variant of ["full", "empty", "no-any", "unreserved"] as const)
    it("classifier finalization " + variant, () => {
      expect(classifierFixture(newClosed, variant)).toEqual(classifierFixture(oldClosed, variant));
    });
  for (const native of [false, true])
    for (const apply of [false, true])
      it("job reservations, cache, bodies and locals " + JSON.stringify({ native, apply }), () => {
        expect(jobFixture(newAsync, native, apply)).toEqual(
          expectedLookupReservation(jobFixture(oldAsync, native, apply), native),
        );
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
    const old = evaluate(oldAsync, ["buildPromiseSettleClosureInstrs"], {
      closureBagInitInstr: () => ({ op: "ref.null.extern" }),
    });
    expect(plain(first)).toEqual(
      plain(old.buildPromiseSettleClosureInstrs(resources, 6, [{ op: "local.get", index: 2 }])),
    );
  });
  for (const capTypeIdx of [4, 37])
    for (const capPromiseFieldIdx of [1, 5, 17])
      for (const resolveFuncIdx of [6, 101])
        for (const rejectFuncIdx of [7, 203])
          it(
            "complete settle bodies and live operand controls " +
              JSON.stringify({ capTypeIdx, capPromiseFieldIdx, resolveFuncIdx, rejectFuncIdx }),
            () => {
              const resources = { capTypeIdx, capPromiseFieldIdx, capMetaTypeIdx: 91 };
              const wrongField = mutatedSettleBuilder(
                "fieldIdx: capPromiseFieldIdx",
                "fieldIdx: capPromiseFieldIdx + 1",
              );
              const wrongTarget = mutatedSettleBuilder("funcIdx: settleFuncIdx", "funcIdx: settleFuncIdx + 1");
              for (const target of [resolveFuncIdx, rejectFuncIdx]) {
                const expected = originalSettleBody(capTypeIdx, capPromiseFieldIdx, target);
                expect(expected).toHaveLength(6); // positive denominator before negative controls
                const verify = (builder: typeof buildPromiseSettleClosureBody) =>
                  expect(plain(builder(resources, target))).toEqual(expected);
                verify(buildPromiseSettleClosureBody);
                expect(() => verify(wrongField)).toThrow();
                expect(() => verify(wrongTarget)).toThrow();
              }
            },
          );
});
