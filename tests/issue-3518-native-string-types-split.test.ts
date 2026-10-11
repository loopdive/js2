// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralTypes,
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireCompletedNativeStringLiterals,
  requireNativeStringLiteral,
  nativeStringLiteralReservationInventory,
  type NativeStringLiteralRequirements,
} from "../src/backend/wasmgc/resources/native-string-literals.js";

function fixture() {
  const module = createEmptyModule();
  return { module, tx: new PhysicalModuleReservations(module) };
}
function demands(utf8Storage: boolean) {
  return {
    key: "strings",
    utf8Storage,
    literals: [
      { value: "then" },
      { value: "then" },
      { value: "", encoding: "utf8-guaranteed" as const },
      { value: "", encoding: "wtf16" as const },
      { value: "x".repeat(9999) + "😀end" },
    ],
  };
}
function probe(tx: PhysicalModuleReservations) {
  const type = tx.reserveType("probe:type", { kind: "struct", name: "probe", fields: [] });
  const fn = tx.reserveFunction("probe:fn", "probe", { params: [], results: [] });
  return { index: type.typeIndex, handle: fn.handle, signature: fn.object.typeIdx };
}

describe("native string types-only core split", () => {
  for (const empty of [false, true])
    it(`consumes the type pack exactly once, empty=${empty}`, () => {
      const { tx, module } = fixture();
      const types = reserveNativeStringLiteralTypes(tx, "strings", false);
      const req = { ...demands(false), literals: empty ? [] : [{ value: "then" }] };
      const pack = reserveNativeStringLiteralResources(tx, req, types);
      expect(nativeStringLiteralReservationInventory(tx, pack).typePack).toBe(types);
      const before = structuredClone(module);
      expect(() => reserveNativeStringLiteralResources(tx, req, types)).toThrow("already consumed");
      expect(module).toStrictEqual(before);
    });

  for (const bad of ["value", "encoding", "hole", "surrogate"] as const)
    it(`preflights every late ${bad} demand and permits supplied-pack retry`, () => {
      const { tx, module } = fixture();
      const types = reserveNativeStringLiteralTypes(tx, "strings", true);
      const rows: unknown[] = [{ value: "valid" }, { value: "later" }];
      if (bad === "value") rows[1] = { value: 7 };
      if (bad === "encoding") rows[1] = { value: "later", encoding: "unknown" };
      if (bad === "hole") {
        Reflect.deleteProperty(rows, 1);
        expect(Object.hasOwn(rows, 1)).toBe(false);
      }
      if (bad === "surrogate") rows[1] = { value: "\ud800", encoding: "utf8-guaranteed" };
      const req = { key: "strings", utf8Storage: true, literals: rows } as NativeStringLiteralRequirements;
      const before = structuredClone(module);
      expect(() => reserveNativeStringLiteralResources(tx, req, types)).toThrow(
        bad === "surrogate" ? /surrogate/ : /invalid literal/,
      );
      expect(module).toStrictEqual(before);
      const pack = reserveNativeStringLiteralResources(tx, { ...req, literals: [{ value: "valid" }] }, types);
      expect(requireNativeStringLiteral(tx, pack, "valid")).toBe(pack.literals[0]);
      if (bad !== "surrogate") {
        const combined = fixture();
        expect(() => reserveNativeStringLiteralResources(combined.tx, req)).toThrow(/invalid literal/);
        expect(combined.module.types).toHaveLength(0);
      }
    });

  it("consumes on allocation failure without promising rollback", () => {
    const { tx } = fixture();
    const types = reserveNativeStringLiteralTypes(tx, "strings", false);
    const allocation = vi.spyOn(tx, "reserveGlobal").mockImplementationOnce(() => {
      throw new Error("injected allocation failure");
    });
    expect(() => reserveNativeStringLiteralResources(tx, demands(false), types)).toThrow("injected allocation failure");
    allocation.mockRestore();
    expect(() => reserveNativeStringLiteralResources(tx, { ...demands(false), literals: [] }, types)).toThrow(
      /consumed/,
    );
  });

  it("enumerates all private chunks in allocation order, retaining repeated tokens", () => {
    const { tx, module } = fixture();
    const value = "x".repeat(20001);
    const pack = reserveNativeStringLiteralResources(tx, {
      key: "strings",
      utf8Storage: false,
      literals: [{ value }, { value }],
    });
    const census = nativeStringLiteralReservationInventory(tx, pack);
    expect(census.requests).toHaveLength(2);
    expect(census.requests[0]!.binding).toBe(census.requests[1]!.binding);
    expect(census.requests[0]!.cacheKey).toBe(`__strlit_materialize:u16:${value}`);
    expect(census.globals.map((row) => row.cacheKey)).toStrictEqual([`u16:${"x".repeat(10000)}`, "u16:x"]);
    expect(census.globals.map((row) => row.global.object)).toStrictEqual(module.globals);
    expect(census.functions).toHaveLength(1);
    expect(census.functions[0]!.function.object).toBe(module.functions[0]);
    expect(census.functions[0]!.chunkGlobals).toStrictEqual([
      census.globals[0]!.global,
      census.globals[0]!.global,
      census.globals[1]!.global,
    ]);
    expect(census.functions[0]!.chunkGlobals[0]).toBe(census.functions[0]!.chunkGlobals[1]);
    for (const container of [
      census,
      census.requests,
      ...census.requests,
      census.globals,
      ...census.globals,
      census.functions,
      ...census.functions,
      census.functions[0]!.chunkGlobals,
    ])
      expect(Object.isFrozen(container)).toBe(true);
    expect(() => requireCompletedNativeStringLiterals(tx, pack)).toThrow(/incomplete/);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
  });

  for (const phase of ["reserve", "lookup", "inventory", "fill", "completion"] as const)
    it(`reauthenticates actual descriptor contents at ${phase}`, () => {
      const positive = fixture();
      const good = reserveNativeStringLiteralResources(positive.tx, demands(false));
      expect(requireNativeStringLiteral(positive.tx, good, "then")).toBe(good.literals[0]);
      expect(nativeStringLiteralReservationInventory(positive.tx, good).requests).toHaveLength(5);
      positive.tx.freezeReservations();
      fillNativeStringLiteralResources(positive.tx, good);
      expect(requireCompletedNativeStringLiterals(positive.tx, good)).toBe(good);
      const { tx, module } = fixture();
      const types = reserveNativeStringLiteralTypes(tx, "strings", false);
      const pack = phase === "reserve" ? undefined : reserveNativeStringLiteralResources(tx, demands(false), types);
      if (phase === "fill" || phase === "completion") tx.freezeReservations();
      if (phase === "completion") fillNativeStringLiteralResources(tx, pack!);
      const descriptor = types.types[0]!.object;
      if (descriptor.kind !== "array") throw new Error("expected string data array");
      descriptor.mutable = false;
      const before = structuredClone(module);
      expect(() => {
        if (phase === "reserve") reserveNativeStringLiteralResources(tx, demands(false), types);
        if (phase === "lookup") requireNativeStringLiteral(tx, pack!, "then");
        if (phase === "inventory") nativeStringLiteralReservationInventory(tx, pack!);
        if (phase === "fill") fillNativeStringLiteralResources(tx, pack!);
        if (phase === "completion") requireCompletedNativeStringLiterals(tx, pack!);
      }).toThrow(/altered/);
      expect(module).toStrictEqual(before);
    });
  for (const utf8 of [false, true])
    it(`preserves combined allocation and fill order, utf8=${utf8}`, () => {
      const a = fixture(),
        b = fixture();
      const combined = reserveNativeStringLiteralResources(a.tx, demands(utf8));
      const types = reserveNativeStringLiteralTypes(b.tx, "strings", utf8);
      expect(Object.isFrozen(types)).toBe(true);
      expect(Object.isFrozen(types.layout)).toBe(true);
      expect(Object.isFrozen(types.types)).toBe(true);
      expect(types.types).toHaveLength(utf8 ? 7 : 5);
      expect(b.module.globals).toHaveLength(0);
      expect(b.module.functions).toHaveLength(0);
      const split = reserveNativeStringLiteralResources(b.tx, demands(utf8), types);
      expect(split.types).toBe(types.types);
      expect(split.layout).toBe(types.layout);
      expect(split.literals[0]).toBe(split.literals[1]);
      expect(b.module).toStrictEqual(a.module);
      a.tx.freezeReservations();
      b.tx.freezeReservations();
      fillNativeStringLiteralResources(a.tx, combined);
      fillNativeStringLiteralResources(b.tx, split);
      expect(requireCompletedNativeStringLiterals(b.tx, split)).toBe(split);
      expect(b.module).toStrictEqual(a.module);
    });

  it("permits function and global imports between types and literals", () => {
    const { module, tx } = fixture();
    const types = reserveNativeStringLiteralTypes(tx, "strings", false);
    tx.reserveFunctionImport("host:fn", "host", "fn", { params: [], results: [] });
    const imported = tx.reserveGlobalImport("host:global", "host", "global", { kind: "i32" }, false);
    const pack = reserveNativeStringLiteralResources(tx, demands(false), types);
    expect(module.imports).toHaveLength(2);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    expect(tx.physicalIndex(imported)).toBe(0);
    const first = pack.literals[0]!;
    if (first.kind !== "global") throw new Error("expected literal global");
    expect(tx.physicalIndex(first.global)).toBe(1);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
  });

  for (const mutation of ["copied", "foreign", "key", "config"] as const)
    it(`rejects ${mutation} supplied types before literal allocations`, () => {
      const positive = fixture();
      const genuine = reserveNativeStringLiteralTypes(positive.tx, "strings", false);
      expect(reserveNativeStringLiteralResources(positive.tx, demands(false), genuine).types).toBe(genuine.types);
      const a = fixture(),
        control = fixture();
      const types = reserveNativeStringLiteralTypes(a.tx, "strings", false);
      reserveNativeStringLiteralTypes(control.tx, "strings", false);
      const supplied = mutation === "copied" ? { ...types } : mutation === "foreign" ? genuine : types;
      const requirements = {
        ...demands(false),
        ...(mutation === "key" ? { key: "other" } : {}),
        ...(mutation === "config" ? { utf8Storage: true } : {}),
      };
      const before = structuredClone(a.module);
      const records = [...a.module.types];
      expect(() => reserveNativeStringLiteralResources(a.tx, requirements, supplied)).toThrow(
        mutation === "copied" || mutation === "foreign" ? "foreign or forged type owner" : "type key/config mismatch",
      );
      expect(a.module).toStrictEqual(before);
      records.forEach((record, index) => expect(a.module.types[index]).toBe(record));
      expect(probe(a.tx)).toStrictEqual(probe(control.tx));
      expect(a.module.funcOrdinalToPosition).toStrictEqual(control.module.funcOrdinalToPosition);
    });
});
