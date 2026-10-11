// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { descriptorSource } from "./helpers/native-descriptor-fixture.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import type { IrInstr, IrInstrCall, IrValueId } from "../src/ir/core/nodes.js";
import { BUILTIN_BRAND_TABLE } from "../src/runtime/contracts/builtin-brands.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import {
  deriveNativePrototypeRequirements,
  assertNativePrototypeRequirementsCurrent,
} from "../src/ir/program/native-prototype-requirements.js";

function source(decoded = false) {
  const { program, projection } = descriptorSource(decoded);
  return deriveNativeObjectAccessRequirements(program, projection);
}
// Explicit semantic fixtures extend the real source-produced getter census.
// They exercise provenance, not frontend support or complete emitted prototypes.
function semanticFixture(end: "null" | "default" = "null") {
  const program = structuredClone(descriptorSource().program),
    projection = program.runtime[0]!;
  const buffers = [program.ir.functions, projection.prepared.functions].map((functions) => {
    const run = functions.find((fn) => fn.name === "run")!;
    return run.blocks.find((block) =>
      block.instrs.some((i) => i.kind === "call" && i.target.name === "js.object.create-default"),
    )!.instrs as IrInstr[];
  });
  for (const instructions of new Set(buffers)) {
    const at = instructions.findIndex((i) => i.kind === "call" && i.target.name === "js.object.create-default");
    const original = instructions[at] as IrInstrCall;
    const id = (10000 + Number(original.result)) as IrValueId;
    const root: IrInstrCall = {
      ...original,
      result: id,
      target: irIntrinsicFuncRef(`js.object.create-${end}`),
      args: [],
    };
    const other: IrInstrCall = { ...root, result: (Number(id) + 1) as IrValueId };
    instructions.splice(at, 1, root, other, {
      ...original,
      target: irIntrinsicFuncRef("js.object.create-with-prototype"),
      args: [id],
    });
  }
  return { program, projection, buffers, access: () => deriveNativeObjectAccessRequirements(program, projection) };
}
function callIndex(buffer: IrInstr[], name: string) {
  const index = buffer.findIndex((i) => i.kind === "call" && i.target.name === name);
  if (index < 0) throw Error("missing actual call " + name);
  return index;
}

describe("source-issued prototype provenance", () => {
  it.each([false, true])("retains exact source and decoded default-prototype witnesses: decoded=%s", (decoded) => {
    const access = source(decoded),
      pack = deriveNativePrototypeRequirements(access);
    assertNativePrototypeRequirementsCurrent(pack);
    expect(pack.access).toBe(access);
    expect(pack.uses).toHaveLength(access.uses.length);
    const creation = access.uses.find((use) => use.feature === "js.object.create-default")!;
    expect(pack.builtins).toEqual([
      { name: "Object", brand: BUILTIN_BRAND_TABLE.Object, creationOccurrences: [creation.occurrence] },
    ]);
    const get = pack.uses.find((use) => use.feature === "js.object.get")!;
    const instruction = access.demands.occurrences[get.occurrence]!.instruction as IrInstrCall;
    expect(get.target.creations).toEqual([creation.occurrence]);
    expect(get.receiver).toEqual({ value: instruction.args[2], chain: get.target });
    expect(pack.gaps).toEqual(expect.arrayContaining(access.gaps));
    expect(pack.gaps.some((gap) => gap.detail.includes("executable provider closure"))).toBe(true);
    expect(pack.completionScope).toBe("prototype-provenance");
  });
  it("deep-freezes the exposed plan", () => {
    const pack = deriveNativePrototypeRequirements(source());
    expect(() => (pack.uses as unknown[]).pop()).toThrow();
    expect(() => (pack.uses[0]!.target.creations as number[]).push(999)).toThrow();
    expect(() => (pack.builtins[0]!.creationOccurrences as number[]).pop()).toThrow();
    assertNativePrototypeRequirementsCurrent(pack);
  });
  it.each(["copy", "clone"] as const)("rejects %s requirements after a positive control", (kind) => {
    const pack = deriveNativePrototypeRequirements(source());
    assertNativePrototypeRequirementsCurrent(pack);
    const fake = kind === "copy" ? { ...pack } : structuredClone(pack);
    expect(() => assertNativePrototypeRequirementsCurrent(fake)).toThrow("unissued");
  });
  it("refuses caller-authored access records", () => {
    const access = source();
    deriveNativePrototypeRequirements(access);
    expect(() => deriveNativePrototypeRequirements({ ...access })).toThrow("unissued");
  });
  it.each(["null", "default"] as const)("preserves the full explicit chain ending in %s", (end) => {
    const f = semanticFixture(end),
      pack = deriveNativePrototypeRequirements(f.access());
    assertNativePrototypeRequirementsCurrent(pack);
    const get = pack.uses.find((use) => use.feature === "js.object.get")!;
    expect(get.target.creations).toHaveLength(2);
    expect(get.target.end.kind).toBe(end === "null" ? "null" : "builtin");
    expect(pack.builtins).toHaveLength(end === "null" ? 0 : 1);
    if (end === "default") expect(pack.builtins[0]!.creationOccurrences).toHaveLength(2);
  });
  it("retains a distinct original receiver rather than replacing it with the lookup cursor", () => {
    const f = semanticFixture();
    for (const buffer of new Set(f.buffers)) {
      const at = callIndex(buffer, "js.object.get"),
        get = buffer[at] as IrInstrCall;
      const root = buffer[callIndex(buffer, "js.object.create-null")] as IrInstrCall;
      buffer[at] = { ...get, args: [get.args[0]!, get.args[1]!, root.result!] };
    }
    const pack = deriveNativePrototypeRequirements(f.access()),
      get = pack.uses.find((use) => use.feature === "js.object.get")!;
    expect(get.target.creations).toHaveLength(2);
    expect(get.receiver!.chain.creations).toHaveLength(1);
    expect(get.receiver!.chain.creations[0]).toBe(get.target.creations[1]);
  });
  it("rejects reparenting to an equally typed, separately created object in projection", () => {
    const f = semanticFixture();
    deriveNativePrototypeRequirements(f.access());
    const buffer = f.buffers[1]!,
      at = callIndex(buffer, "js.object.create-with-prototype"),
      call = buffer[at] as IrInstrCall;
    const other = buffer[at - 1] as IrInstrCall;
    buffer[at] = { ...call, args: [other.result!] };
    expect(() => deriveNativePrototypeRequirements(f.access())).toThrow("chain changed across projection");
  });
  it("rejects projection substitution of the original Get receiver", () => {
    const f = semanticFixture();
    deriveNativePrototypeRequirements(f.access());
    const buffer = f.buffers[1]!,
      at = callIndex(buffer, "js.object.get"),
      call = buffer[at] as IrInstrCall;
    const root = buffer[callIndex(buffer, "js.object.create-null")] as IrInstrCall;
    buffer[at] = { ...call, args: [call.args[0]!, call.args[1]!, root.result!] };
    expect(() => deriveNativePrototypeRequirements(f.access())).toThrow("chain changed across projection");
  });
  it("follows a projected representation alias without substituting the original receiver", () => {
    const f = semanticFixture();
    const buffer = f.buffers[1]!,
      at = callIndex(buffer, "js.object.get"),
      get = buffer[at] as IrInstrCall;
    const value = 30000 as IrValueId;
    buffer.splice(
      at,
      1,
      { kind: "coerce.to_externref", result: value, resultType: get.resultType, value: get.args[0]! },
      { ...get, args: [value, get.args[1]!, get.args[2]!] },
    );
    const pack = deriveNativePrototypeRequirements(f.access()),
      read = pack.uses.find((use) => use.feature === "js.object.get")!;
    assertNativePrototypeRequirementsCurrent(pack);
    expect(read.target.creations).toHaveLength(2);
    expect(read.receiver!.value).toBe(get.args[2]);
    expect(read.receiver!.value).not.toBe(value);
    expect(read.receiver!.chain).toEqual(read.target);
  });
  it("refuses changed borrowed instructions after issuance", () => {
    const f = semanticFixture(),
      pack = deriveNativePrototypeRequirements(f.access());
    assertNativePrototypeRequirementsCurrent(pack);
    const buffer = f.buffers[1]!,
      at = callIndex(buffer, "js.object.create-with-prototype"),
      call = buffer[at] as IrInstrCall;
    buffer[at] = { ...call, args: [(Number(call.args[0]) + 1) as IrValueId] };
    expect(() => assertNativePrototypeRequirementsCurrent(pack)).toThrow();
  });
  it("does not certify unknown parent flows as an empty null chain", () => {
    const f = semanticFixture();
    for (const buffer of new Set(f.buffers)) {
      const at = callIndex(buffer, "js.object.create-with-prototype"),
        call = buffer[at] as IrInstrCall;
      buffer[at] = { ...call, args: [99999 as IrValueId] };
    }
    // Missing SSA is rejected by the access-call signature check before it can issue authority.
    expect(() => deriveNativePrototypeRequirements(f.access())).toThrow();
  });
  it("retains an actual undefined parent as a located gap, distinct from null", () => {
    const f = semanticFixture();
    for (const buffer of new Set(f.buffers)) {
      const at = callIndex(buffer, "js.object.create-with-prototype"),
        call = buffer[at] as IrInstrCall;
      const value = 20000 as IrValueId;
      buffer.splice(
        at,
        1,
        { kind: "const", result: value, resultType: call.resultType, value: { kind: "undefined" } },
        { ...call, args: [value] },
      );
    }
    const pack = deriveNativePrototypeRequirements(f.access());
    assertNativePrototypeRequirementsCurrent(pack);
    const get = pack.uses.find((use) => use.feature === "js.object.get")!;
    expect(get.target.end).toEqual({ kind: "unresolved", value: 20000 });
    expect(pack.builtins).toHaveLength(0);
    expect(pack.gaps).toContainEqual(
      expect.objectContaining({ occurrence: get.occurrence, detail: expect.stringContaining("carrier provenance") }),
    );
  });
  it("Has retains the target chain without requesting getter invocation", () => {
    const f = semanticFixture();
    for (const buffer of new Set(f.buffers)) {
      const at = callIndex(buffer, "js.object.get"),
        call = buffer[at] as IrInstrCall;
      buffer[at] = {
        ...call,
        target: irIntrinsicFuncRef("js.object.has"),
        args: call.args.slice(0, 2),
        resultType: { kind: "val", val: { kind: "i32", boolean: true } },
      };
    }
    const access = f.access(),
      pack = deriveNativePrototypeRequirements(access);
    expect(access.getters).toHaveLength(0);
    const has = pack.uses.find((use) => use.feature === "js.object.has")!;
    expect(has.target.creations).toHaveLength(2);
    expect(Object.hasOwn(has, "receiver")).toBe(false);
  });
});
