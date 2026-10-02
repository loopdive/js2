// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildRawExternrefStorageCopyBody } from "../src/runtime/wasmgc/values/vector-storage-copy-body.js";
import type { Instr } from "../src/wasm/model/instructions.js";

function flatten(body: readonly Instr[]): Instr[] {
  return body.flatMap((instr) => [
    instr,
    ...(instr.op === "if" ? [...flatten(instr.then), ...flatten(instr.else ?? [])] : []),
    ...(instr.op === "block" || instr.op === "loop" ? flatten(instr.body) : []),
  ]);
}

describe("dormant raw externref storage copy structure", () => {
  const resources = Object.freeze({ arrayTypeIndex: 11, holeTypeIndex: 23 });

  it("declares the exact seven-parameter ABI and two private locals", () => {
    const result = buildRawExternrefStorageCopyBody(resources);
    expect(result.params).toEqual([
      { kind: "ref", typeIdx: 11 },
      { kind: "ref", typeIdx: 11 },
      { kind: "ref", typeIdx: 23 },
      { kind: "ref", typeIdx: 23 },
      { kind: "i32" },
      { kind: "i32" },
      { kind: "i32" },
    ]);
    expect(result.results).toEqual([]);
    expect(result.locals).toEqual([
      { name: "$cursor", type: { kind: "i32" } },
      { name: "$slot", type: { kind: "externref" } },
    ]);
  });

  it("checks both ranges without overflow before alias validation and either write branch", () => {
    const { body } = buildRawExternrefStorageCopyBody(resources);
    expect(body.slice(0, 24).filter((i) => i.op === "local.get")).toEqual(
      [4, 0, 6, 0, 4, 5, 1, 6, 1, 5].map((index) => ({ op: "local.get", index })),
    );
    const preflight = flatten(body.slice(0, 33));
    expect(preflight.filter((i) => i.op === "unreachable")).toHaveLength(5);
    expect(preflight.filter((i) => i.op === "i32.gt_u")).toHaveLength(4);
    expect(preflight.filter((i) => i.op === "i32.sub")).toHaveLength(2);
    expect(preflight.some((i) => ["array.set", "array.copy", "i32.add"].includes(i.op))).toBe(false);
    expect(body.slice(24, 32)).toEqual([
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "ref.eq" },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "ref.eq" },
      { op: "i32.eqz" },
      { op: "i32.and" },
    ]);
  });

  it("uses equal TOKEN identity for the memmove arm, with exact array.copy operands", () => {
    const { body } = buildRawExternrefStorageCopyBody(resources);
    expect(body.slice(33, 36)).toEqual([
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "ref.eq" },
    ]);
    const dispatch = body[36];
    if (dispatch?.op !== "if") throw new Error("missing copy dispatch");
    expect(dispatch.then).toEqual([
      { op: "local.get", index: 1 },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 4 },
      { op: "local.get", index: 6 },
      { op: "array.copy", dstTypeIdx: 11, srcTypeIdx: 11 },
    ]);
  });

  it("guards the cast but decides absence by source-token identity, preserving all other slots", () => {
    const ops = flatten(buildRawExternrefStorageCopyBody(resources).body);
    const comparisons = ops.filter((i) => i.op === "if" && i.blockType.kind === "val");
    expect(comparisons).toHaveLength(2);
    const identity = comparisons[0];
    if (identity?.op !== "if") throw new Error("missing slot identity comparison");
    expect(identity.then).toEqual([
      { op: "local.get", index: 8 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: 23 },
      { op: "local.get", index: 2 },
      { op: "ref.eq" },
    ]);
    expect(identity.else).toEqual([{ op: "i32.const", value: 0 }]);
    const selection = comparisons[1];
    if (selection?.op !== "if") throw new Error("missing slot selection");
    expect(selection.then).toEqual([{ op: "local.get", index: 3 }, { op: "extern.convert_any" }]);
    expect(selection.else).toEqual([{ op: "local.get", index: 8 }]);
    expect(ops.filter((i) => i.op === "array.set")).toEqual([{ op: "array.set", typeIdx: 11 }]);
    expect(ops.some((i) => /^(call|global\.|struct\.new|array\.new)/.test(i.op))).toBe(false);
  });

  it("returns independent descriptors without mutating frozen resources", () => {
    const first = buildRawExternrefStorageCopyBody(resources);
    const second = buildRawExternrefStorageCopyBody(resources);
    expect(first).toEqual(second);
    const firstObjects = new Set<object>();
    const collect = (value: unknown, visit: (obj: object) => void): void => {
      if (value === null || typeof value !== "object") return;
      visit(value);
      for (const child of Object.values(value)) collect(child, visit);
    };
    collect(first, (obj) => firstObjects.add(obj));
    collect(second, (obj) => expect(firstObjects.has(obj)).toBe(false));
    expect(resources).toEqual({ arrayTypeIndex: 11, holeTypeIndex: 23 });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid indices %s", (index) => {
    expect(() => buildRawExternrefStorageCopyBody({ ...resources, arrayTypeIndex: index })).toThrow(
      "invalid type index",
    );
    expect(() => buildRawExternrefStorageCopyBody({ ...resources, holeTypeIndex: index })).toThrow(
      "invalid type index",
    );
  });

  it("accepts index zero and rejects an array/Hole resource collision", () => {
    expect(buildRawExternrefStorageCopyBody({ arrayTypeIndex: 0, holeTypeIndex: 1 }).params[0]).toEqual({
      kind: "ref",
      typeIdx: 0,
    });
    expect(() => buildRawExternrefStorageCopyBody({ arrayTypeIndex: 1, holeTypeIndex: 1 })).toThrow("must differ");
  });
});
