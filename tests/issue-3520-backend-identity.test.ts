// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { PORFFOR_KIND_NAMES, type PorfforNode } from "../src/ir/backend/porffor/compat.js";
import { IrFunctionBuilder, irUnitFuncRef, irVal, type IrFunction } from "../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const F64 = irVal({ kind: "f64" });

function duplicateLabelFunctions(): {
  readonly provider: IrFunction;
  readonly caller: IrFunction;
} {
  const identities = createTestIrFunctionIdentityFactory("issue-3520-backend-identity");
  const providerIdentity = identities.next("same");
  const provider = new IrFunctionBuilder(providerIdentity, [F64]);
  provider.openBlock();
  const seven = provider.emitConst({ kind: "f64", value: 7 }, F64);
  provider.terminate({ kind: "return", values: [seven] });

  const caller = new IrFunctionBuilder(identities.next("same"), [F64]);
  caller.openBlock();
  const result = caller.emitCall(irUnitFuncRef(providerIdentity), [], F64);
  if (result === null) throw new Error("duplicate-label fixture call unexpectedly returned void");
  caller.terminate({ kind: "return", values: [result] });
  return { provider: provider.finish(), caller: caller.finish() };
}

function collectNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectNodes(node[3], out);
    collectNodes(node[4], out);
    collectNodes(node[5], out);
    return out;
  }
  for (const item of value) collectNodes(item, out);
  return out;
}

describe("#3520 backend structural function identity", () => {
  it("lowers duplicate Porffor display labels by unit identity without last-write-wins calls", () => {
    const { provider, caller } = duplicateLabelFunctions();
    const forward = lowerIrModuleToPorffor({ functions: [provider, caller] }, { entryUnitId: caller.unitId });
    const reversed = lowerIrModuleToPorffor({ functions: [caller, provider] }, { entryUnitId: caller.unitId });

    expect(reversed).toStrictEqual(forward);
    const names = forward.funcs.map((func) => func?.name);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name?.startsWith("same__ir_"))).toBe(true);
    expect(forward.entry).toBe(names[1]);

    const calls = forward.funcs.flatMap((func) =>
      collectNodes(func?.body ?? []).filter((node) => PORFFOR_KIND_NAMES[node[0]] === "Call"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![3]).toBe(names[0]);

    expect(() => lowerIrModuleToPorffor({ functions: [provider, caller] }, { entry: "same" })).toThrow(
      "porffor assembler: entry label 'same' matches 2 IR function units",
    );
  });

  it("rejects duplicate Porffor unit IDs even when display labels differ", () => {
    const { provider } = duplicateLabelFunctions();
    const duplicateId = { ...provider, name: "different" };

    expect(() => lowerIrModuleToPorffor({ functions: [provider, duplicateId] })).toThrow(
      `porffor assembler: duplicate IR function unit '${provider.unitId}'`,
    );
  });
});
