// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// The source-text and SHA-256 receipts of the #3518 ownership move were retired by #7380 PR 2a (they broke on every
// edit of src/ir/program/data.ts); what remains checks the forwarded objects and their behaviour.
import { describe, expect, it } from "vitest";
import * as oldProgram from "../src/ir/program.js";
import * as oldInput from "../src/ir/program-input.js";
import * as data from "../src/ir/program/data.js";
import * as errors from "../src/ir/program/errors.js";
import * as admission from "../src/ir/program/input.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { IR_CLASS_SHAPE_CELL } from "../src/ir/core/types.js";
import { captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { sourcePacket, startupFiles, typedOptions } from "./helpers/typed-program-fixtures.js";
import { createTestIrClassId } from "./helpers/ir-identities.js";

const dataFunctions = [
  "preparedIrReadonlyMap",
  "preparedIrDataMismatch",
  "freezePreparedIrValue",
  "freezePreparedIrRuntimeValue",
] as const;

describe("#3518 program ownership implementation seam", () => {
  it.each(dataFunctions)("forwards the exact historical %s function object", (name) => {
    expect(oldProgram[name]).toBe(data[name]);
  });

  it("forwards both admission functions and the same invariant constructor", () => {
    expect(oldInput.ownTypedIrProgramInput).toBe(admission.ownTypedIrProgramInput);
    expect(oldInput.ownTypedIrProgramOptions).toBe(admission.ownTypedIrProgramOptions);
    expect(oldProgram.PreparedIrProgramInvariantError).toBe(errors.PreparedIrProgramInvariantError);
    const error = new errors.PreparedIrProgramInvariantError("invalid-prepared-data", "owned evidence");
    expect(error).toBeInstanceOf(oldProgram.PreparedIrProgramInvariantError);
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.code, error.message]).toEqual([
      "PreparedIrProgramInvariantError",
      "invalid-prepared-data",
      "owned evidence",
    ]);
    expect(Object.hasOwn(oldProgram, "invalidPreparedData")).toBe(false);
  });

  it("preserves FrozenMap construction, private state, getters, all iteration surfaces and callback receiver", () => {
    const first = { value: 1 },
      second = { value: 2 };
    const entries: [string, typeof first][] = [
      ["b", first],
      ["a", second],
    ];
    const map = data.preparedIrReadonlyMap(entries);
    const legacy = oldProgram.preparedIrReadonlyMap(entries);
    entries.reverse();
    expect(map.size).toBe(2);
    expect(map.has("b")).toBe(true);
    expect(map.has("missing")).toBe(false);
    expect(map.get("b")).toBe(first);
    expect(map.get("missing")).toBeUndefined();
    expect([...map.entries()]).toEqual([
      ["b", first],
      ["a", second],
    ]);
    expect([...map.keys()]).toEqual(["b", "a"]);
    expect([...map.values()]).toEqual([first, second]);
    expect([...map]).toEqual([...map.entries()]);
    const receiver = { calls: [] as string[] };
    map.forEach(function (this: typeof receiver, value, key, owner) {
      expect(this).toBe(receiver);
      expect(owner).toBe(map);
      expect(value).toBe(map.get(key));
      this.calls.push(key);
    }, receiver);
    expect(receiver.calls).toEqual(["b", "a"]);
    const prototype = Object.getPrototypeOf(map);
    expect(prototype).toBe(Object.getPrototypeOf(legacy));
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Object.isFrozen(prototype.constructor)).toBe(true);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.prototype.toString.call(map)).toBe("[object FrozenMap]");
    expect(Reflect.ownKeys(map)).toEqual([]);
    expect("set" in map).toBe(false);
    expect(() => Map.prototype.set.call(map, "x", first)).toThrow(TypeError);
  });

  it("preserves FrozenSet private state and every read surface without exposing mutation", () => {
    const set = data.freezePreparedIrValue(new Set(["b", "a", "b"])) as ReadonlySet<string>;
    const legacy = oldProgram.freezePreparedIrValue(new Set(["b", "a"])) as ReadonlySet<string>;
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(true);
    expect(set.has("missing")).toBe(false);
    expect([...set.entries()]).toEqual([
      ["b", "b"],
      ["a", "a"],
    ]);
    expect([...set.keys()]).toEqual(["b", "a"]);
    expect([...set.values()]).toEqual(["b", "a"]);
    expect([...set]).toEqual(["b", "a"]);
    const receiver = { calls: [] as string[] };
    set.forEach(function (this: typeof receiver, value, again, owner) {
      expect(this).toBe(receiver);
      expect(again).toBe(value);
      expect(owner).toBe(set);
      this.calls.push(value);
    }, receiver);
    expect(receiver.calls).toEqual(["b", "a"]);
    const prototype = Object.getPrototypeOf(set);
    expect(prototype).toBe(Object.getPrototypeOf(legacy));
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Object.isFrozen(prototype.constructor)).toBe(true);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Reflect.ownKeys(set)).toEqual([]);
    expect(Object.prototype.toString.call(set)).toBe("[object FrozenSet]");
    expect("add" in set).toBe(false);
    expect(() => Set.prototype.add.call(set, "x")).toThrow(TypeError);
  });

  it("retains immutable copying and exact data comparison including explicit undefined and ordered collections", () => {
    const value = {
      absent: undefined,
      values: [NaN, -0, 7n],
      map: new Map([
        ["b", 2],
        ["a", 1],
      ]),
      set: new Set([2, 1]),
    };
    Object.defineProperty(value, "hidden", { value: undefined, enumerable: false });
    const owned = data.freezePreparedIrValue(value) as typeof value;
    expect(owned).not.toBe(value);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.values)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(owned, "hidden")).toEqual({
      value: undefined,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(data.preparedIrDataMismatch(value, owned)).toBeUndefined();
    expect(data.preparedIrDataMismatch({ x: undefined }, {})).toBe("$root (field population)");
    expect(data.preparedIrDataMismatch(-0, 0)).toBe("$root");
    expect(data.preparedIrDataMismatch(NaN, NaN)).toBeUndefined();
    expect(
      data.preparedIrDataMismatch(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
        owned.map,
      ),
    ).toContain(".entries");
    expect(data.preparedIrDataMismatch(new Set([1, 2]), owned.set)).toContain(".values");
    expect(data.preparedIrDataMismatch([], {})).toBe("$root (array kind)");
    expect(data.preparedIrDataMismatch(new Date(0), {})).toBe("$root (non-data object)");
  });

  it("keeps recursive class cells and in-place runtime identity rather than creating a second authority", () => {
    const fields: { name: string; type: { kind: "class"; shape: object } }[] = [];
    const shape = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: createTestIrClassId("program-ownership-recursion", 0),
      className: "Node",
      fields,
      methods: [],
      constructorParams: [],
    };
    fields.push({ name: "next", type: { kind: "class", shape } });
    const copied = data.freezePreparedIrValue(shape) as typeof shape;
    expect(copied).not.toBe(shape);
    expect(copied.fields[0]!.type.shape).toBe(copied);
    expect(copied[IR_CLASS_SHAPE_CELL]).toBe(true);
    expect(data.preparedIrDataMismatch(shape, copied)).toBeUndefined();
    const shared = { absent: undefined };
    const attachment = {
      plan: shared,
      manifest: shared,
      layouts: [shape],
      providers: data.preparedIrReadonlyMap([["p", shared]]),
    };
    expect(data.freezePreparedIrRuntimeValue(attachment)).toBe(attachment);
    expect(attachment.plan).toBe(shared);
    expect(attachment.manifest).toBe(shared);
    expect(attachment.providers.get("p")).toBe(shared);
    expect(attachment.layouts[0]).toBe(shape);
    expect(shape.fields[0]!.type.shape).toBe(shape);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shape)).toBe(true);
    const cycle: { next?: object } = {};
    cycle.next = cycle;
    expect(() => data.freezePreparedIrValue(cycle)).toThrow(/acyclic outside exact IR class shapes/);
    expect(() => data.freezePreparedIrRuntimeValue(cycle)).toThrow(/acyclic outside exact IR class shapes/);
    expect(() => data.freezePreparedIrRuntimeValue({ map: new Map() })).toThrow(/mutable or executable context state/);
    expect(() => data.freezePreparedIrValue({ run() {} })).toThrow(errors.PreparedIrProgramInvariantError);
  });

  it("admits actual source/startup ownership and returns a detached transaction", () => {
    const { packet } = sourcePacket(startupFiles);
    expect(packet.inventory.sources).toHaveLength(2);
    expect(packet.inventory.terminalUnits).toHaveLength(3);
    expect(packet.globals).toHaveLength(2);
    const owned = admission.ownTypedIrProgramInput(packet);
    expect(owned.allocations).toBeInstanceOf(AllocSiteRegistry);
    expect(owned.input).not.toBe(packet);
    expect(owned.input.ir).not.toBe(packet.ir);
    expect(data.preparedIrDataMismatch(owned.input, packet)).toBeUndefined();
    const [global, ...rest] = packet.globals;
    if (!global) throw Error("missing source global");
    const reader = packet.ir.functions.find((fn) => fn.name === "read");
    if (!reader) throw Error("missing real non-startup owner control");
    expect(() =>
      admission.ownTypedIrProgramInput({
        ...packet,
        globals: [{ ...global, identity: { ...global.identity, storageOwnerUnitId: reader.unitId } }, ...rest],
      }),
    ).toThrow(/exact inventoried source storage owner/);
  });

  it("jointly preserves IR/site/metadata sharing, raw aliases, retirement, row order and next allocation id", () => {
    const { source } = sourcePacket();
    const fn = source.ir.functions.find((fn) => fn.params.length);
    if (!fn) throw Error("missing real source parameter");
    const type = fn.params[0]!.type;
    const ids = Array.from({ length: 5 }, () => source.allocations.fresh("object", type));
    const [first, second, target, retired, other] = ids;
    if (
      first === undefined ||
      second === undefined ||
      target === undefined ||
      retired === undefined ||
      other === undefined
    )
      throw Error("missing allocation controls");
    source.allocations.alias(first, second);
    source.allocations.alias(second, target);
    source.allocations.retire(retired);
    source.allocations.annotate(target, "future", { type, owner: fn, absent: undefined });
    source.allocations.annotate(target, "explicit-undefined", undefined);
    source.allocations.annotate(other, "second-row", undefined);
    const packet = captureTypedIrProgramInput(source);
    const ordered = {
      ...packet,
      allocations: { ...packet.allocations, metadata: [...packet.allocations.metadata].reverse() },
    };
    const owned = admission.ownTypedIrProgramInput(ordered);
    const ownedFn = owned.input.ir.functions.find((candidate) => candidate.unitId === fn.unitId)!;
    expect(owned.allocations.resolve(first)).toBe(owned.allocations.resolve(target));
    expect(owned.allocations.resolve(second)).toBe(owned.allocations.resolve(target));
    expect(owned.allocations.resolve(retired)).toBeNull();
    expect(owned.allocations.resolve(target)!.type).toBe(ownedFn.params[0]!.type);
    const metadata = owned.allocations.read<{ type: unknown; owner: unknown; absent: undefined }>(target, "future")!;
    expect(metadata.owner).toBe(ownedFn);
    expect(metadata.type).toBe(ownedFn.params[0]!.type);
    expect(Object.hasOwn(metadata, "absent")).toBe(true);
    expect(owned.allocations.captureSnapshot()).toEqual(ordered.allocations);
    expect(owned.allocations.captureSnapshot().metadata.map((row) => row.id)).toEqual(
      ordered.allocations.metadata.map((row) => row.id),
    );
    expect(owned.allocations.fresh("object", type)).toBe(packet.allocations.size);
    expect(source.allocations.size).toBe(packet.allocations.size);
    // Unknown namespaces are preserved by admission; parent retains the
    // separate final semantic-rejection controls. This is not allocation execution.
  });

  it("retains exact resolved controls and refuses missing controls or policy populations", () => {
    const owned = admission.ownTypedIrProgramOptions(typedOptions);
    expect(owned).not.toBe(typedOptions);
    expect(owned).toEqual(typedOptions);
    expect(() => admission.ownTypedIrProgramOptions({ ...typedOptions, controls: {} } as never)).toThrow(
      /missing or foreign fields/,
    );
    expect(() =>
      admission.ownTypedIrProgramOptions({
        ...typedOptions,
        controls: { ...typedOptions.controls, ownership: undefined },
      } as never),
    ).toThrow(/complete explicit controls/);
    expect(() => admission.ownTypedIrProgramOptions({ ...typedOptions, runtimePolicies: [] })).toThrow(
      /omit the source preparation policy/,
    );
    expect(() =>
      admission.ownTypedIrProgramOptions({
        ...typedOptions,
        runtimePolicies: [typedOptions.policy, typedOptions.policy],
      }),
    ).toThrow("runtime policies duplicate a backend/target pair or omit the source preparation policy");
  });
});
