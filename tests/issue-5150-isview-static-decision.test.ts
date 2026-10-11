// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { arrayBufferIsViewStaticDecision } from "../src/codegen/expressions/arraybuffer-isview-static-decision.js";

const NUMERIC_VIEWS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
] as const;

interface DecisionCase {
  id: string;
  symbol?: string;
  anyOrUnknown?: boolean;
  union?: boolean;
  standalone?: boolean;
  alias?: string;
  externrefBacked?: boolean;
  builtinParent?: string;
  directParent?: string;
  expected: boolean | undefined;
  reads: readonly string[];
}

const ordinaryReads = (symbol: string) => [`typed:${symbol}`, `alias:${symbol}`, `extern:${symbol}`];
const directReads = ["typed:DV", "alias:DV", "extern:DV", "builtin:DV", "parent:DV"];
const directDV = { symbol: "DV", externrefBacked: true, builtinParent: "DataView", directParent: "DataView" };
const CASES: readonly DecisionCase[] = [
  ...NUMERIC_VIEWS.map((symbol) => ({ id: symbol, symbol, expected: true, reads: ordinaryReads(symbol) })),
  { id: "DataView", symbol: "DataView", expected: true, reads: ordinaryReads("DataView") },
  { id: "BigInt64Array", symbol: "BigInt64Array", expected: true, reads: ordinaryReads("BigInt64Array") },
  { id: "BigUint64Array", symbol: "BigUint64Array", expected: true, reads: ordinaryReads("BigUint64Array") },
  { id: "Any", anyOrUnknown: true, union: true, expected: undefined, reads: [] },
  { id: "Unknown", anyOrUnknown: true, expected: undefined, reads: [] },
  { id: "union", symbol: "Plain", union: true, expected: undefined, reads: [...ordinaryReads("Plain"), "union"] },
  { id: "undefined symbol resolvable", expected: false, reads: ["union"] },
  ...["Number", "Plain", "Array", "ArrayBuffer"].map((symbol) => ({
    id: `non-view ${symbol}`,
    symbol,
    expected: false,
    reads: [...ordinaryReads(symbol), "union"],
  })),
  { id: "direct DataView subclass", ...directDV, expected: undefined, reads: directReads },
  {
    id: "class expression alias",
    ...directDV,
    symbol: "Local",
    alias: "DV",
    expected: undefined,
    reads: ["typed:Local", "alias:Local", "extern:DV", "builtin:DV", "parent:DV"],
  },
  {
    id: "non-direct parent",
    ...directDV,
    directParent: "Parent",
    expected: false,
    reads: [...directReads, "union"],
  },
  {
    id: "non-externref class",
    ...directDV,
    externrefBacked: false,
    expected: false,
    reads: [...ordinaryReads("DV"), "union"],
  },
  {
    id: "non-DataView builtin parent",
    ...directDV,
    builtinParent: "Uint8Array",
    expected: false,
    reads: [...ordinaryReads("DV"), "builtin:DV", "union"],
  },
  {
    id: "standalone false",
    ...directDV,
    standalone: false,
    expected: false,
    reads: ["typed:DV", "alias:DV", "union"],
  },
  {
    id: "numeric view wins over Any and union",
    symbol: "Uint8Array",
    anyOrUnknown: true,
    union: true,
    expected: true,
    reads: ordinaryReads("Uint8Array"),
  },
  {
    id: "DataView wins over union",
    symbol: "DataView",
    union: true,
    expected: true,
    reads: ordinaryReads("DataView"),
  },
  {
    id: "BigInt view wins over Any and union",
    symbol: "BigInt64Array",
    anyOrUnknown: true,
    union: true,
    expected: true,
    reads: ordinaryReads("BigInt64Array"),
  },
  {
    id: "BigUint view avoids union",
    symbol: "BigUint64Array",
    union: true,
    expected: true,
    reads: ordinaryReads("BigUint64Array"),
  },
  {
    id: "Any ordinary symbol avoids union",
    symbol: "Plain",
    anyOrUnknown: true,
    union: true,
    expected: undefined,
    reads: ordinaryReads("Plain"),
  },
];

describe("#5150 pure isView static classification", () => {
  it.each(CASES)("$id", (row) => {
    const reads: string[] = [];
    const className = row.alias ?? row.symbol ?? "unused";
    const aliases = new Map(row.alias && row.symbol ? [[row.symbol, row.alias]] : []);
    const externrefs = new Set(row.externrefBacked ? [className] : []);
    const builtins = new Map(row.builtinParent ? [[className, row.builtinParent]] : []);
    const parents = new Map(row.directParent ? [[className, row.directParent]] : []);
    const typedArrays = new Set<string>(NUMERIC_VIEWS);
    const maps = [aliases, builtins, parents];
    for (const [map, label] of [
      [aliases, "alias"],
      [builtins, "builtin"],
      [parents, "parent"],
    ] as const) {
      const get = map.get.bind(map);
      vi.spyOn(map, "get").mockImplementation((key) => {
        reads.push(`${label}:${key}`);
        return get(key);
      });
    }
    for (const [set, label] of [
      [externrefs, "extern"],
      [typedArrays, "typed"],
    ] as const) {
      const has = set.has.bind(set);
      vi.spyOn(set, "has").mockImplementation((key) => {
        reads.push(`${label}:${key}`);
        return has(key);
      });
    }
    const mutations = [
      ...maps.flatMap((map) => [vi.spyOn(map, "set"), vi.spyOn(map, "delete"), vi.spyOn(map, "clear")]),
      ...[externrefs, typedArrays].flatMap((set) => [
        vi.spyOn(set, "add"),
        vi.spyOn(set, "delete"),
        vi.spyOn(set, "clear"),
      ]),
    ];
    const before = [...maps.map((map) => [...map]), [...externrefs], [...typedArrays]];
    const metadata = Object.freeze({
      standalone: row.standalone ?? true,
      classExprNameMap: aliases,
      classExternrefBackedSet: externrefs,
      classBuiltinParentMap: builtins,
      classParentMap: parents,
    });
    const rawType = Object.freeze({
      isUnion: vi.fn(() => {
        reads.push("union");
        return row.union ?? false;
      }),
    });
    const result = arrayBufferIsViewStaticDecision(
      metadata,
      row.symbol,
      row.anyOrUnknown ?? false,
      rawType,
      typedArrays,
    );
    expect(result).toBe(row.expected);
    expect(reads).toEqual(row.reads);
    expect(rawType.isUnion).toHaveBeenCalledTimes(row.reads.includes("union") ? 1 : 0);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect([...maps.map((map) => [...map]), [...externrefs], [...typedArrays]]).toEqual(before);
  });
});
