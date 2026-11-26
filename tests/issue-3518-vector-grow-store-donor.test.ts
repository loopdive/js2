// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { describe, expect, it } from "vitest";
// Established bootstrap: the legacy registry graph needs the public entry first.
import "../src/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ensureVecElemSet, ensureVecNewSized, ensureHoleyArrayNew } from "../src/codegen/vec-elem-set.js";
import {
  getOrRegisterArrayType,
  getOrRegisterVecBaseType,
  getOrRegisterVecType,
  getOrRegisterHoleyArrayType,
} from "../src/codegen/registry/types.js";
import { HOLE_F64_BITS } from "../src/codegen/value-tags.js";
import {
  buildVectorGrowStoreBody,
  createVectorBackingArrayType,
  createVectorBaseType,
  createVectorCarrierType,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";

function context(standalone = true) {
  return createCodegenContext(createEmptyModule(), ts.createProgram([], {}).getTypeChecker(), { standalone });
}

describe("real legacy adapters retain dense and hole behavior", () => {
  it.each(["dense-externref", "dense-f64", "hole-global", "f64-hole"] as const)(
    "publishes the exact pure body and preserves cache hits: %s",
    (kind) => {
      const ctx = context();
      ctx.usesArrayHoles = kind === "hole-global" || kind === "f64-hole";
      const index =
        kind === "hole-global"
          ? getOrRegisterHoleyArrayType(ctx)
          : getOrRegisterVecType(ctx, kind === "dense-externref" ? "externref" : "f64");
      const carrier = ctx.mod.types[index]!;
      if (carrier.kind !== "struct") throw new Error("fixture carrier");
      const data = carrier.fields[1]!.type;
      if (data.kind !== "ref" && data.kind !== "ref_null") throw new Error("fixture backing array");
      const counts = { functions: ctx.mod.functions.length, globals: ctx.mod.globals.length };
      const id = ensureVecElemSet(ctx, index);
      expect(id).not.toBeNull();
      const fn = ctx.mod.functions.find((f) => f.name === "__vec_elem_set_" + index)!;
      expect(fn).toBeDefined();
      expect(ctx.mod.functions).toHaveLength(counts.functions + 1);
      const gapFill =
        kind === "hole-global"
          ? { kind: "hole-global" as const, globalIndex: ctx.holeGlobalIdx! }
          : kind === "f64-hole"
            ? { kind: "f64-hole" as const, bits: HOLE_F64_BITS }
            : { kind: "default" as const };
      expect({ body: fn.body, locals: fn.locals }).toEqual(
        buildVectorGrowStoreBody({
          carrierTypeIndex: kind === "hole-global" ? carrier.superTypeIdx! : index,
          arrayTypeIndex: data.typeIdx,
          exceptionTagIndex: ctx.exnTagIdx,
          gapFill,
        }),
      );
      expect(ctx.mod.globals.length - counts.globals).toBe(kind === "hole-global" ? 1 : 0);
      if (kind === "f64-hole") expect(ctx.f64HoleMarkerEmitted).toBe(true);
      const types = ctx.mod.types.length,
        tags = ctx.mod.tags.length,
        globals = ctx.mod.globals.length;
      expect(ensureVecElemSet(ctx, index)).toBe(id);
      expect(ctx.mod.types).toHaveLength(types);
      expect(ctx.mod.tags).toHaveLength(tags);
      expect(ctx.mod.globals).toHaveLength(globals);
      expect(ctx.mod.functions).toHaveLength(counts.functions + 1);
      expect(ctx.mod.functions.find((f) => f.name === fn.name)).toBe(fn);
    },
  );
  it("keeps hole allocation before tag/signature and publishes function before cache", () => {
    const ctx = context(),
      index = getOrRegisterHoleyArrayType(ctx),
      events: string[] = [];
    const typesPush = ctx.mod.types.push.bind(ctx.mod.types),
      globalsPush = ctx.mod.globals.push.bind(ctx.mod.globals);
    const tagsPush = ctx.mod.tags.push.bind(ctx.mod.tags),
      functionsPush = ctx.mod.functions.push.bind(ctx.mod.functions);
    const mapSet = ctx.funcMap.set.bind(ctx.funcMap);
    ctx.mod.types.push = (...items) => {
      events.push(...items.map((t) => "type:" + t.kind));
      return typesPush(...items);
    };
    ctx.mod.globals.push = (...items) => {
      events.push("hole-global");
      return globalsPush(...items);
    };
    ctx.mod.tags.push = (...items) => {
      events.push("tag");
      return tagsPush(...items);
    };
    ctx.mod.functions.push = (...items) => {
      events.push("function");
      return functionsPush(...items);
    };
    ctx.funcMap.set = (key, value) => {
      events.push("func-cache:" + key);
      return mapSet(key, value);
    };
    ensureVecElemSet(ctx, index);
    expect(events).toEqual([
      "type:struct",
      "hole-global",
      "type:func",
      "tag",
      "type:func",
      "function",
      "func-cache:__vec_elem_set_" + index,
    ]);
    events.length = 0;
    ensureVecElemSet(ctx, index);
    expect(events).toEqual([]);
  });
  it("preserves base/array/carrier descriptor and bookkeeping object ownership", () => {
    const ctx = context();
    const base = getOrRegisterVecBaseType(ctx);
    expect(ctx.mod.types[base]).toEqual(createVectorBaseType());
    for (const kind of ["f64", "externref", "i8_byte"] as const) {
      const element = kind === "i8_byte" ? { kind: "i8" as const } : { kind };
      const index = getOrRegisterVecType(ctx, kind, element),
        array = getOrRegisterArrayType(ctx, kind, element);
      expect(ctx.mod.types[array]).toEqual(createVectorBackingArrayType("__arr_" + kind, element));
      const expected = createVectorCarrierType({
        name: "__vec_" + kind,
        baseTypeIndex: base,
        arrayTypeIndex: array,
        ...(kind === "i8_byte" ? { final: true } : {}),
      });
      expect(ctx.mod.types[index]).toEqual(expected);
      expect(ctx.structMap.get(expected.name)).toBe(index);
      expect(ctx.typeIdxToStructName.get(index)).toBe(expected.name);
      expect(ctx.structFields.get(expected.name)).toEqual(expected.fields);
      const carrier = ctx.mod.types[index]!;
      if (carrier.kind !== "struct") throw new Error("fixture carrier");
      expect(ctx.structFields.get(expected.name)).not.toBe(carrier.fields);
    }
    expect(ctx.usesVecValue).toBe(true);
  });
  it("retains reference element normalization and distinct reference caches", () => {
    const ctx = context(),
      before = ctx.mod.types.length;
    const a = getOrRegisterArrayType(ctx, "ref", { kind: "ref", typeIdx: 901 });
    const b = getOrRegisterArrayType(ctx, "ref", { kind: "ref", typeIdx: 902 });
    expect(ctx.mod.types).toHaveLength(before + 2);
    expect(a).not.toBe(b);
    expect(ctx.mod.types[a]).toEqual(createVectorBackingArrayType("__arr_ref_901", { kind: "ref_null", typeIdx: 901 }));
    expect(getOrRegisterArrayType(ctx, "ref_null", { kind: "ref_null", typeIdx: 901 })).toBe(a);
  });
  it("retains invalid-carrier and packed-element refusals without allocation", () => {
    const ctx = context(),
      packed = getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
    const types = ctx.mod.types.length,
      funcs = ctx.mod.functions.length;
    expect(ensureVecElemSet(ctx, -1)).toBeNull();
    expect(ensureVecElemSet(ctx, packed)).toBeNull();
    expect(ctx.mod.types).toHaveLength(types);
    expect(ctx.mod.functions).toHaveLength(funcs);
  });
  it("retains both untouched sized allocators and their caches", () => {
    const ctx = context(),
      dense = getOrRegisterVecType(ctx, "f64");
    const first = ensureVecNewSized(ctx, dense),
      holey = ensureHoleyArrayNew(ctx);
    expect(first).not.toBeNull();
    expect(holey).not.toBe(first);
    const count = ctx.mod.functions.length;
    expect(ensureVecNewSized(ctx, dense)).toBe(first);
    expect(ensureHoleyArrayNew(ctx)).toBe(holey);
    expect(ctx.mod.functions).toHaveLength(count);
  });
});
