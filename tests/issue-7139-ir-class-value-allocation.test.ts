// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { classValueRuntime, reserveClassValueFixture, fillClassValueFixture } from "./helpers/native-class-values.js";
import {
  requireNativeClassValues,
  requireCompletedNativeClassValues,
  reserveNativeClassValues,
} from "../src/backend/wasmgc/resources/native-class-values.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { verifyAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { verifyIrBackendLegality } from "../src/ir/analysis/backend-legality.js";
import { directUses } from "../src/ir/core/nodes.js";

for (const displaced of [false, true])
  for (const decoded of [false, true]) {
    it(`allocates fresh values with genuine retained source closures, displaced=${displaced}, decoded=${decoded}`, () => {
      const f = classValueRuntime(displaced, decoded),
        r = f.exports;
      const realmPrototype = {},
        parentA = {},
        parentB = {},
        bagA = {},
        bagB = {};
      r.initialize(realmPrototype);
      const a = r.allocate(r.makeCaptured(1), parentA, bagA),
        b = r.allocate(r.makeCaptured(2), parentB, bagB);
      expect(Object.is(a, b)).toBe(false);
      expect(r.invokeConstruct(a, 20)).toBe(21);
      expect(r.invokeConstruct(b, 20)).toBe(22);
      expect(r.invokeConstruct(a, 20)).toBe(21);
      expect(r.prototype(r.classState(a))).toBe(parentA);
      expect(r.prototype(r.classState(b))).toBe(parentB);
      expect(r.bag(a)).toBe(bagA);
      expect(r.bag(b)).toBe(bagB);
      expect(r.arity(a)).toBe(1);
      // Allocation retains the distinct Call stub; this marker is not a class [[Call]] semantic claim.
      expect(r.call(a, 20)).toBe(-99);
      expect(r.call(b, 20)).toBe(-99);
      const oldRealm = r.realm(r.classState(a));
      const constructC = r.makeCaptured(3);
      r.initialize(null);
      const c = r.allocate(constructC, null, {});
      expect(r.prototype(r.classState(c))).toBeNull();
      expect(Object.is(r.realm(r.classState(c)), oldRealm)).toBe(false);
      expect(Object.is(r.realm(r.classState(a)), oldRealm)).toBe(true);
      expect(r.invokeConstruct(a, 20)).toBe(21);
      expect(WebAssembly.Module.imports(f.wasm)).toHaveLength(displaced ? 2 : 0);
      expect(verifyIrFunction(f.fn)).toEqual([]);
      expect(verifyAllocProvenance(f.fn, f.allocations)).toEqual([]);
      expect(verifyIrBackendLegality(f.fn, "wasmgc")).toEqual([]);
      expect(verifyIrBackendLegality(f.fn, "linear").length).toBeGreaterThan(0);
    }, 120000);
  }
describe("class allocation owner boundaries", () => {
  it("rejects copied and foreign associations", () => {
    const f = reserveClassValueFixture(),
      other = reserveClassValueFixture();
    expect(() => requireNativeClassValues(f.f.tx, { ...f.pack })).toThrow(/foreign or copied/);
    expect(() => requireNativeClassValues(other.f.tx, f.pack)).toThrow(/foreign or copied/);
  });
  it("rejects changed plans before consuming new slots", () => {
    const f = reserveClassValueFixture();
    const before = [f.f.module.types.length, f.f.module.functions.length];
    expect(() => reserveNativeClassValues(f.f.tx, "wrong", f.f.source.types, f.plan)).toThrow(
      /substituted declaration plan/,
    );
    expect([f.f.module.types.length, f.f.module.functions.length]).toEqual(before);
  });
  it("requires canonical fill and rejects later allocator body edits", () => {
    const f = reserveClassValueFixture();
    expect(() => requireCompletedNativeClassValues(f.f.tx, f.pack)).toThrow(/missing canonical fill/);
    fillClassValueFixture(f);
    f.pack.allocate.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeClassValues(f.f.tx, f.pack)).toThrow(
      /altered completed function class-values:allocate/,
    );
    expect(f.f.tx.state).toBe("failed");
  });
  it("checks signature and operands after copied IR edits", () => {
    const f = reserveClassValueFixture(),
      original = f.fn.blocks[0]!.instrs.find((row) => row.kind === "class.value.new")!;
    expect(directUses(original)).toEqual([f.fn.params[2]!.value, f.fn.params[0]!.value, f.fn.params[1]!.value]);
    const malformed = {
      ...f.fn,
      blocks: f.fn.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((row) => (row === original ? { ...original, construct: f.fn.params[1]!.value } : row)),
      })),
    };
    expect(verifyIrFunction(malformed).some((row) => row.message.includes("internal Construct closure"))).toBe(true);
  });
});

it("allows only one metadata owner for the exact source closure family before any mutation", () => {
  const fixture = reserveClassValueFixture();
  const before = structuredClone(fixture.f.module);
  expect(() => reserveNativeClassValues(fixture.f.tx, "alternate-class-family", fixture.f.source.types)).toThrow(
    /duplicate class metadata owner/,
  );
  expect(fixture.f.module).toEqual(before);
  expect(fixture.f.tx.state).toBe("reserving");
});
