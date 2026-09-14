// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// 5399 is the local semantic-repair spec label, not ownership of a GitHub issue.
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { generateModule } from "../src/codegen/index.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "../src/codegen/program-abi-planning.js";
import { ProgramAbiCallableRegistry } from "../src/codegen/program-abi-callable-planning.js";
import { HOLE_F64_BITS, UNDEF_F64_BITS } from "../src/codegen/value-tags.js";
import {
  VEC_HOST_BRIDGE_ROLE,
  vecHostBridgeMaterializerOrdinal,
  vecHostBridgeWritebackOrdinal,
} from "../src/codegen/vec-access-exports.js";
import * as own from "../src/codegen/vec-own-index-export.js";
import { compile } from "../src/index.js";
import "../src/codegen/expressions.js";

const DEMAND = 'export function descriptor(a:any):any{return Object.getOwnPropertyDescriptor(a,"0")}';
const F64 = "export function raw():number[]{return [1,,undefined,NaN] as number[]}";

async function built(source: string, optimize: 0 | 2 = 0) {
  let context: CodegenContext | undefined;
  const emit = own.emitVecOwnIndexExport;
  // Observe the real emission; do not replace carriers, runtime or diagnostics.
  const spy = vi.spyOn(own, "emitVecOwnIndexExport").mockImplementation((ctx) => {
    context = ctx;
    return emit(ctx);
  });
  let result: Awaited<ReturnType<typeof compile>>;
  try {
    result = await compile(source, { fileName: "presence.ts", optimize, deferTopLevelInit: true });
  } finally {
    spy.mockRestore();
  }
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
  (result.importObject as any).__setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  const entry = context && own.vecOwnIndexExport(context);
  const check = entry && (instance.exports[entry.name] as ((raw: unknown, index: number) => number) | undefined);
  return { context, result, instance, entry, check };
}

function resultElement(ctx: CodegenContext, name: string): string {
  const fn = ctx.mod.functions.find((fn) => fn.name === name)!;
  const ft = ctx.mod.types[fn.typeIdx];
  expect(ft.kind).toBe("func");
  if (ft.kind !== "func") throw new Error("expected a function signature");
  const result = ft.results[0];
  if (result.kind !== "ref" && result.kind !== "ref_null") throw new Error("expected a raw vector return");
  const vec = ctx.mod.types[result.typeIdx];
  if (vec.kind !== "struct") throw new Error("expected vector struct");
  const data = vec.fields[1].type;
  if (data.kind !== "ref" && data.kind !== "ref_null") throw new Error("expected vector data ref");
  const array = ctx.mod.types[data.typeIdx];
  if (array.kind !== "array") throw new Error("expected vector data array");
  return array.element.kind;
}

for (const optimize of [0, 2] as const)
  describe(`A0 raw own-index presence, optimize=${optimize}`, () => {
    it("decodes f64 holes before boxing, retaining explicit undefined and ordinary NaN", async () => {
      const b = await built(F64 + DEMAND, optimize);
      expect(b.check).toBeTypeOf("function");
      expect(resultElement(b.context!, "raw")).toBe("f64");
      if (optimize === 0) {
        const producer = b.result.wat.split("  (func $raw ")[1].split("  (func ")[0];
        expect(producer).toContain(`i64.const ${HOLE_F64_BITS}`);
        expect(producer).toContain(`i64.const ${UNDEF_F64_BITS}`);
        expect(producer).toContain("f64.const NaN");
      }
      const raw = (b.instance.exports.raw as () => unknown)();
      expect([0, 1, 2, 3, 4, -1].map((i) => b.check!(raw, i))).toEqual([1, 0, 1, 1, 0, 0]);
    });
    it("distinguishes the private externref Hole from undefined, null, NaN and an empty struct", async () => {
      const b = await built("export function raw():any[]{return [undefined,,null,NaN,{}]}" + DEMAND, optimize);
      expect(resultElement(b.context!, "raw")).toBe("externref");
      const raw = (b.instance.exports.raw as () => unknown)();
      expect([0, 1, 2, 3, 4, 5].map((i) => b.check!(raw, i))).toEqual([1, 0, 1, 1, 1, 0]);
    });
    it("recognizes dense i32 storage, including zero/false", async () => {
      const b = await built("export function raw():boolean[]{return [false,true]}" + DEMAND, optimize);
      expect(resultElement(b.context!, "raw")).toBe("i32");
      const raw = (b.instance.exports.raw as () => unknown)();
      expect([0, 1, 2].map((i) => b.check!(raw, i))).toEqual([1, 1, 0]);
    });
    it("uses logical length, not spare capacity, and never reads beyond backing capacity", async () => {
      const b = await built(
        `
      export function shrunk():number[]{const a=[1];a.push(2);a.pop();return a;}
      export function grown():number[]{const a=[1];a.length=9;return a;}
      ${DEMAND}`,
        optimize,
      );
      const shrunk = (b.instance.exports.shrunk as () => unknown)();
      const grown = (b.instance.exports.grown as () => unknown)();
      expect([0, 1, 2, 8, 9, -1].map((i) => b.check!(shrunk, i))).toEqual([1, 0, 0, 0, 0, 0]);
      expect([0, 1, 8, 9].map((i) => b.check!(grown, i))).toEqual([1, 0, 0, 0]);
    });
    it("returns unavailable for non-vectors without inspecting a host getter or proxy", async () => {
      const b = await built(F64 + DEMAND + "export function object(){return {x:1}}", optimize);
      const trap = vi.fn(() => {
        throw new Error("must not inspect host properties");
      });
      const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap });
      for (const value of [null, undefined, 1, {}, [], proxy, (b.instance.exports.object as () => unknown)()]) {
        expect(b.check!(value, 0)).toBe(-1);
      }
      expect(trap).not.toHaveBeenCalled();
    });
    it("preserves same-labelled user exports and publishes a distinct allocator descriptor", async () => {
      const b = await built(
        F64 +
          DEMAND +
          `
      export function __vec_own_index():number{return 71}
      export function __vec_own_index$():number{return 72}`,
        optimize,
      );
      expect((b.instance.exports.__vec_own_index as () => number)()).toBe(71);
      expect((b.instance.exports.__vec_own_index$ as () => number)()).toBe(72);
      expect(b.entry!.name).toBe("__vec_own_index$$");
      expect(b.check!((b.instance.exports.raw as () => unknown)(), 1)).toBe(0);
      const handle = own.emitVecOwnIndexExport(b.context!);
      expect(definedFuncAt(b.context!, handle!)?.body.length).toBeGreaterThan(1);
      expect(own.vecOwnIndexExport(b.context!)).toBe(b.entry);
    });
  });

describe("A0 demand and Program ABI ownership", () => {
  it.each(["export function add(a:number,b:number){return a+b}", "export function raw():number[]{return [1,2]}"])(
    "does not export presence without host property-service demand: %s",
    async (source) => {
      const b = await built(source);
      expect(b.entry).toBeUndefined();
      expect(Object.keys(b.instance.exports)).not.toContain("__vec_own_index");
      expect(b.result.imports.some((entry) => entry.name.includes("own_index"))).toBe(false);
    },
  );
  it("keeps module allocation ownership separate, including colliding user names", async () => {
    const first = await built(F64 + DEMAND);
    const second = await built(F64 + DEMAND + "export function __vec_own_index(){return 99}");
    expect(first.entry).not.toBe(second.entry);
    expect(first.entry!.name).toBe("__vec_own_index");
    expect(second.entry!.name).toBe("__vec_own_index$");
    expect(first.check!((first.instance.exports.raw as () => unknown)(), 1)).toBe(0);
    expect(second.check!((second.instance.exports.raw as () => unknown)(), 2)).toBe(1);
    // No global "last compiled module" lookup chooses another helper.
    expect(own.vecOwnIndexExport(first.context!)).toBe(first.entry);
  });
  it("uses each supplying instance's own externref hole singleton", async () => {
    const source = "export function raw():any[]{return [undefined,,{}]}" + DEMAND;
    const first = await built(source);
    const second = await built(source);
    for (const b of [first, second]) {
      const raw = (b.instance.exports.raw as () => unknown)();
      expect([0, 1, 2].map((i) => b.check!(raw, i))).toEqual([1, 0, 1]);
    }
    expect(first.entry).not.toBe(second.entry);
  });
  it("pins the wrong-instance routing limitation for canonical-compatible externref vectors", async () => {
    const source = "export function raw():any[]{return [undefined,,{}]}" + DEMAND;
    const first = await built(source);
    const second = await built(source);
    for (const [supplier, wrongInstance] of [
      [first, second],
      [second, first],
    ]) {
      const raw = (supplier.instance.exports.raw as () => unknown)();
      const suppliedPresence = [0, 1, 2].map((i) => supplier.check!(raw, i));
      const wrongPresence = [0, 1, 2].map((i) => wrongInstance.check!(raw, i));
      expect(suppliedPresence).toEqual([1, 0, 1]);
      // Negative routing control, not valid presence semantics: canonical Wasm
      // shapes admit this foreign vector, but its hole singleton is different.
      // A1 must route to the supplying instance; shape matching is insufficient.
      expect(wrongPresence).toEqual([1, 1, 1]);
      expect(wrongPresence).not.toEqual(suppliedPresence);
    }
  });
  it("does not classify a foreign unregistered i32 carrier as absent", async () => {
    const local = await built(F64 + DEMAND);
    const foreign = await built("export function raw():boolean[]{return [false,true]}" + DEMAND);
    const raw = (foreign.instance.exports.raw as () => unknown)();
    expect(foreign.check!(raw, 0)).toBe(1);
    expect(local.check!(raw, 0)).toBe(-1);
  });
  it("queries module-initialized raw storage after normal instance binding", async () => {
    const b = await built(
      "const a:number[]=[1,,undefined] as number[];export function raw():number[]{return a}" + DEMAND,
    );
    expect(b.instance.exports.__module_init).toBeTypeOf("function");
    const raw = (b.instance.exports.raw as () => unknown)();
    expect([0, 1, 2].map((i) => b.check!(raw, i))).toEqual([1, 0, 1]);
    // This is post-init access, not A1's not-yet-implemented start publication.
  });
  it.each(["renamed", "replaced", "duplicated", "retargeted", "removed-function"])(
    "rejects corrupted allocator ownership: %s",
    async (damage) => {
      const b = await built(F64 + DEMAND);
      const ctx = b.context!;
      const entry = b.entry!;
      if (damage === "renamed") entry.name += "$";
      if (damage === "replaced") ctx.mod.exports[ctx.mod.exports.indexOf(entry)] = { ...entry };
      if (damage === "duplicated") ctx.mod.exports.push(entry);
      if (entry.desc.kind !== "func") throw new Error("expected function export");
      if (damage === "retargeted") entry.desc.index = ctx.mod.exports.find((e) => e.name === "raw")!.desc.index;
      if (damage === "removed-function") {
        const handle = own.emitVecOwnIndexExport(ctx)!;
        ctx.mod.functions.splice(ctx.mod.functions.indexOf(definedFuncAt(ctx, handle)!), 1);
      }
      expect(() => own.finalizeVecOwnIndexExport(ctx)).toThrow(/vec own-index export/);
    },
  );
  it("propagates ordinal-11 observation failure rather than publishing a fabricated helper", async () => {
    const original = ProgramAbiCallableRegistry.prototype.observeEntrySourceSupports;
    const spy = vi
      .spyOn(ProgramAbiCallableRegistry.prototype, "observeEntrySourceSupports")
      .mockImplementation(function (rows) {
        if (rows.some((row) => row.role === VEC_HOST_BRIDGE_ROLE && row.derivedOrdinal === 11))
          throw new Error("A0 observation failure");
        return original.call(this, rows);
      });
    try {
      const result = await compile(F64 + DEMAND, { fileName: "presence.ts", experimentalIR: true });
      expect(result.success).toBe(false);
      expect(result.binary.length).toBe(0);
      expect(JSON.stringify(result.errors)).toContain("A0 observation failure");
    } finally {
      spy.mockRestore();
    }
  });
  it("pins ordinal 11 and preserves all earlier subfamilies under unrelated growth", () => {
    const generate = (extra = "") =>
      generateModule(analyzeSource(F64 + DEMAND + extra, "presence.ts"), {
        experimentalIR: true,
        trackIrOutcomes: true,
      });
    const before = generate();
    const after = generate("export function unrelated(x:number){return x+1}");
    for (const result of [before, after]) expect(result.errors.filter((e) => e.severity !== "warning")).toEqual([]);
    const rows = (result: typeof before) =>
      result
        .programAbi!.abi.entries()
        .filter((entry) => entry.intent.kind === "callable" && String(entry.id).includes(`:${VEC_HOST_BRIDGE_ROLE}:`));
    const first = rows(before);
    const second = rows(after);
    const presence = first.find((row) => row.displayName === "__vec_own_index")!;
    expect(presence).toBeDefined();
    const ordinalOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
    expect(ordinalOf(presence.id)).toBe(11);
    expect(second.find((row) => row.displayName === "__vec_own_index")!.id).toBe(presence.id);
    for (const ordinal of [0, 1, 2, 3, 4, 5]) {
      const row = first.filter((row) => ordinalOf(row.id) === ordinal);
      expect(row).toHaveLength(1);
      expect(second.find((candidate) => candidate.displayName === row[0].displayName)!.id).toBe(row[0].id);
    }
    expect(before.module.functions.findIndex((fn) => fn.name === "__vec_own_index")).not.toBe(
      after.module.functions.findIndex((fn) => fn.name === "__vec_own_index"),
    );
    expect(vecHostBridgeMaterializerOrdinal("f64")).toBe(6);
    expect(vecHostBridgeMaterializerOrdinal("i32")).toBe(7);
    expect(vecHostBridgeMaterializerOrdinal("externref")).toBe(8);
    expect(vecHostBridgeWritebackOrdinal("setElem")).toBe(9);
    expect(vecHostBridgeWritebackOrdinal("setLen")).toBe(10);
    expect(own.vecHostBridgeOwnIndexOrdinal()).toBe(11);
    expect(PROGRAM_ABI_CALLABLE_ROLE.vecHostBridge).toBe(8);
  });
});
