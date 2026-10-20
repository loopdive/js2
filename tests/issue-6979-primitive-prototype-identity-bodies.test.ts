// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES,
  type NativePrimitivePrototypeKind,
} from "../src/runtime/contracts/native-primitive-prototype-identities.js";
import {
  primitivePrototypeIdentityDeclaration,
  buildPrimitivePrototypeIdentityInitializer,
  buildPrimitivePrototypeIdentityRead,
  type PrimitivePrototypeIdentityOperands,
} from "../src/runtime/wasmgc/values/primitive-prototype-identity-bodies.js";
import type { Instr } from "../src/wasm/model/instructions.js";

// These are structural builder checks, NOT native bootstrap/runtime acceptance.
const operands = (): PrimitivePrototypeIdentityOperands => ({
  capsuleType: 17,
  capsuleGlobal: 21,
  realmGlobal: 22,
  objectPrototypeGlobal: 23,
  classify: 31,
  booleanAllocation: 32,
  numberAllocation: 33,
  stringCreate: 34,
  ordinaryAllocation: 35,
  emptyString: [{ op: "global.get", index: 24 }],
});

describe("primitive prototype identity builder checkpoint", () => {
  it("fixes exactly five identity/payload roles, without claiming a member catalog", () => {
    expect(NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map(({ kind, payload }) => [kind, payload])).toEqual([
      ["Boolean", "false"],
      ["Number", "+0"],
      ["String", "empty-string"],
      ["Symbol", "absent"],
      ["BigInt", "absent"],
    ]);
    expect(Object.isFrozen(NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)).toBe(true);
    expect(NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.every(Object.isFrozen)).toBe(true);
  });

  it("stores immutable role references with the two real generation identities", () => {
    const declaration = primitivePrototypeIdentityDeclaration("realm", "object-prototype");
    expect(declaration.kind).toBe("struct");
    if (declaration.kind !== "struct") throw Error("expected capsule struct");
    expect(declaration.fields).toHaveLength(7);
    expect(declaration.fields.slice(0, 2).map((field) => field.type)).toEqual([
      { kind: "ref", typeKey: "realm" },
      { kind: "ref", typeKey: "object-prototype" },
    ]);
    expect(declaration.fields.every((field) => field.mutable === false)).toBe(true);
    expect(declaration.fields.slice(2).map((field) => field.name)).toEqual(
      NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => row.intrinsic),
    );
  });

  it("allocates all payloads before the sole capsule publication", () => {
    const d = operands(),
      definition = buildPrimitivePrototypeIdentityInitializer(d),
      body = definition.body;
    expect(definition.locals.map((local) => local.type)).toEqual(Array(5).fill({ kind: "externref" }));
    expect(body.filter((instr) => instr.op === "call").map((instr) => instr.funcIdx)).toEqual([
      d.classify,
      d.booleanAllocation,
      d.numberAllocation,
      d.stringCreate,
      d.ordinaryAllocation,
      d.ordinaryAllocation,
    ]);
    expect(body.filter((instr) => instr.op === "global.set")).toEqual([{ op: "global.set", index: d.capsuleGlobal }]);
    expect(body.slice(-2)).toEqual([
      { op: "struct.new", typeIdx: d.capsuleType },
      { op: "global.set", index: d.capsuleGlobal },
    ]);
    const numberCall = body.findIndex((instr) => instr.op === "call" && instr.funcIdx === d.numberAllocation);
    expect(body[numberCall - 1]).toEqual({ op: "f64.const", value: 0 });
    expect(Object.is((body[numberCall - 1] as { value: number }).value, -0)).toBe(false);
    const booleanCall = body.findIndex((instr) => instr.op === "call" && instr.funcIdx === d.booleanAllocation);
    expect(body[booleanCall - 1]).toEqual({ op: "i32.const", value: 0 });
    const stringCall = body.findIndex((instr) => instr.op === "call" && instr.funcIdx === d.stringCreate);
    expect(body[stringCall - 1]).toEqual(d.emptyString[0]);
    expect(body[stringCall - 1]).not.toBe(d.emptyString[0]);
  });

  it("returns early only for a non-null capsule matching both generation identities", () => {
    const d = operands(),
      body = buildPrimitivePrototypeIdentityInitializer(d).body;
    const check = body.find((instr) => instr.op === "if" && instr.then.some((child) => child.op === "struct.get"));
    expect(check?.op).toBe("if");
    if (check?.op !== "if") throw Error("missing generation check");
    expect(check.then.filter((instr) => instr.op === "struct.get").map((instr) => instr.fieldIdx)).toEqual([0, 1]);
    expect(check.then.filter((instr) => instr.op === "ref.eq")).toHaveLength(2);
    expect(check.then.at(-1)).toEqual({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "return" }],
    });
  });

  it.each(NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)("reads only the fixed $kind identity after guards", (row) => {
    const d = operands(),
      definition = buildPrimitivePrototypeIdentityRead(d, row.kind),
      body = definition.body;
    expect(definition.locals).toEqual([]);
    expect(body.filter((instr) => instr.op === "call")).toEqual([{ op: "call", funcIdx: d.classify }]);
    expect(body.filter((instr) => instr.op === "struct.get").map((instr) => instr.fieldIdx)).toEqual([
      0,
      1,
      NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.indexOf(row) + 2,
    ]);
    expect(body.filter((instr) => instr.op === "global.set")).toHaveLength(0);
    expect(body.filter((instr) => instr.op === "if")).toHaveLength(5);
  });

  it("rejects a role outside the fixed contract", () => {
    expect(() => buildPrimitivePrototypeIdentityRead(operands(), "Object" as NativePrimitivePrototypeKind)).toThrow(
      /invalid fixed role/,
    );
  });

  it("does not share mutable instruction objects between generated definitions", () => {
    const d = operands(),
      first = buildPrimitivePrototypeIdentityInitializer(d),
      second = buildPrimitivePrototypeIdentityInitializer(d),
      before = structuredClone(second);
    (first.body as Instr[]).splice(0, first.body.length, { op: "unreachable" });
    (d.emptyString as Instr[]).push({ op: "drop" });
    expect(second).toEqual(before);
  });
});
