// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import {
  buildPrototypeSeederBody,
  buildPrototypeSeedDataTail,
  buildPrototypeSeedEntry,
  PROTOTYPE_SEED_FLAGS,
  type PrototypeSeedEntry,
} from "../src/runtime/wasmgc/values/prototype-seeder-bodies.js";
import {
  authenticatePrototypeSeederDonor,
  capturePrototypeSeeder,
  prototypeSeederBase,
  prototypeSeederFixture,
  readPrototypeSeederSource,
  selectPrototypeSeederFunction,
  transformPrototypeSeederCandidate,
  type PrototypeSeederScenario,
} from "./helpers/prototype-seeder-donor.js";

const receipt = authenticatePrototypeSeederDonor();
describe("fixed prototype seeder donor and proposed adapter", () => {
  it("keeps exact donor provenance and the explicit unwired status", () => {
    expect(receipt.base).toBe(prototypeSeederBase);
    expect(receipt.records).toHaveLength(2);
    expect(receipt.records.reduce((sum, record) => sum + record.spans.length, 0)).toBe(7);
    expect(receipt.status).toBe("pure-recipe candidate; legacy adapter not installed");
    for (const record of receipt.records)
      expect(selectPrototypeSeederFunction(record.path, readPrototypeSeederSource(record.path))).toBe(
        record.selected.text,
      );
  });
  for (const record of receipt.records) {
    it("reconstructs the complete pinned donor in both directions: " + record.path, () => {
      const candidate = transformPrototypeSeederCandidate(record.path, record.source, false);
      expect(candidate).not.toBe(record.source);
      expect(transformPrototypeSeederCandidate(record.path, candidate, true)).toBe(record.source);
    });
    for (const [index, span] of record.spans.entries())
      it(`${record.path}:${index} rejects damaged, removed and duplicate spans in both directions`, () => {
        const candidate = transformPrototypeSeederCandidate(record.path, record.source, false);
        for (const [source, from, inverse] of [
          [record.source, span.before, false],
          [candidate, span.after, true],
        ] as const) {
          expect(source.split(from)).toHaveLength(2);
          for (const changedSpan of [from.replace(/\S/, "~"), "", from + from]) {
            const changed = source.replace(from, () => changedSpan);
            expect(changed).not.toBe(source);
            expect(() => transformPrototypeSeederCandidate(record.path, changed, inverse)).toThrow(
              "span missing or duplicated",
            );
          }
        }
      });
    it("rejects reordering and edits outside the selected spans: " + record.path, () => {
      const candidate = transformPrototypeSeederCandidate(record.path, record.source, false);
      for (const [source, inverse] of [
        [record.source, false],
        [candidate, true],
      ] as const) {
        const first = record.spans[0]![inverse ? "after" : "before"];
        const last = record.spans.at(-1)![inverse ? "after" : "before"];
        const marker = "__prototype_seeder_order__";
        expect(source).not.toContain(marker);
        const changed = source.replace(first, marker).replace(last, first).replace(marker, last);
        expect(() => transformPrototypeSeederCandidate(record.path, changed, inverse)).toThrow("order or offset");
        expect(() => transformPrototypeSeederCandidate(record.path, source + "\n// outside\n", inverse)).toThrow(
          "retained source",
        );
      }
    });
  }
  it("rejects changed receipt authority and unknown source paths after positive authentication", () => {
    authenticatePrototypeSeederDonor();
    expect(() => authenticatePrototypeSeederDonor(readPrototypeSeederSource(prototypeSeederFixture) + "\n")).toThrow(
      "receipt mismatch",
    );
    expect(() => transformPrototypeSeederCandidate("unowned", "", false)).toThrow("unrecorded");
  });
});

const scenarios: PrototypeSeederScenario[] = [
  {},
  { constructorCarrier: "missing", csv: "" },
  { constructorCarrier: "declined", csv: "run" },
  { constructorCarrier: "ref", changing: true },
  { csv: "first, ,second,first" },
  { csv: "size", getters: ["size"] },
  { csv: "size", getters: ["size"], missingAccessor: true },
  { csv: "missing,works", missingClosures: ["missing"] },
  { csv: "@@3,@@03,@@7" },
  { csv: "@@bad,@@1.5,@@7" },
  { csv: "@@7,run", missingSymbol: true },
  { name: "Date", csv: "toGMTString,toUTCString" },
  { csv: "toString", crossBrandAlias: true },
  {
    csv: "",
    data: [
      ["name", "Error"],
      ["message", ""],
    ],
  },
  { name: "Uint8Array", memberDirty: false, csv: "", data: [["BYTES_PER_ELEMENT", 1]] },
  { csv: "", data: [["BYTES_PER_ELEMENT", 8]], missingNumber: true },
  { csv: "", accessors: [{ key: "stack", get: "get stack", set: "set stack" }] },
  { csv: "", accessors: [{ key: "stack", get: "get stack", set: "set stack" }], missingClosures: ["get stack"] },
  { csv: "", accessors: [{ key: "stack", get: "get stack", set: "set stack" }], missingClosures: ["set stack"] },
  { csv: "", accessors: [{ key: "stack", get: "get stack", set: "set stack" }], missingAccessor: true },
  { csv: "", tag: "Map" },
  { csv: "", tag: "Map", missingSymbol: true },
  { standalone: false },
  { memberDirty: false },
  { missingGlue: true },
  { missingValue: true },
  { invalidBrand: true },
  { existing: true },
  { reenter: true },
  {
    constructorCarrier: "ref",
    changing: true,
    reenter: true,
    name: "Date",
    csv: "toGMTString,toUTCString,size,@@3",
    getters: ["size"],
    data: [
      ["name", "Date"],
      ["BYTES_PER_ELEMENT", 8],
    ],
    accessors: [{ key: "stack", get: "get stack", set: "set stack" }],
    tag: "Date",
  },
];
describe("actual donor construction and acquisition order", () => {
  it.each(scenarios)("preserves every body, local, registration and acquisition: %j", (scenario) => {
    expect(capturePrototypeSeeder(true, scenario)).toStrictEqual(capturePrototypeSeeder(false, scenario));
  });
  it("captures the constructor descriptor target after flush and members after real closure acquisition", () => {
    const result = capturePrototypeSeeder(true, scenarios.at(-1)!);
    expect(result.registered).toHaveLength(1);
    const events = result.trace as unknown[][];
    const flush = events.findIndex((event) => event[0] === "flush");
    expect(flush).toBeGreaterThan(0);
    expect(events[flush + 1]![0]).toBe("get");
    expect(events[flush + 1]![1]).toBe("__defineProperty_value");
    expect(events.findIndex((event) => event[0] === "closure")).toBeGreaterThan(flush);
    expect(events.filter((event) => event[0] === "reentered")).toEqual([["reentered", "__nativeproto_seed_-997"]]);
    expect(events.at(-1)![0]).toBe("set");
  });
  it("retains exact alias identity and does not request a second Date alias closure", () => {
    const result = capturePrototypeSeeder(true, { name: "Date", csv: "toGMTString,toUTCString" });
    const events = result.trace as unknown[][];
    expect(events.filter((event) => event[0] === "closure").map((event) => event[2])).toEqual([
      "toUTCString",
      "toUTCString",
    ]);
    const values = events.filter((event) => event[0] === "singleton").map((event) => event[1]);
    expect(values[0]).toBe(values[1]);
  });
  it("keeps pending demand and empty seeding distinct from a complete native brand", () => {
    const pending = capturePrototypeSeeder(true, { missingValue: true });
    expect(pending.pending).toEqual([-997]);
    expect(pending.registered).toEqual([]);
    const empty = capturePrototypeSeeder(true, { constructorCarrier: "missing", csv: "" });
    expect(empty.result).toBeUndefined();
    expect(empty.registry).toEqual([]);
    expect(buildPrototypeSeederBody([])).toEqual([]);
  });
});

interface Observation {
  kind: string;
  target: unknown;
  key: unknown;
  value: unknown;
  setter?: unknown;
  flags: number;
}
async function executableSeeder(offset: boolean, poison?: "flags" | "remove" | "throw") {
  const module = createEmptyModule();
  const E: ValType = { kind: "externref" },
    F: ValType = { kind: "f64" },
    I: ValType = { kind: "i32" };
  const controls: Record<string, unknown> = {};
  const observations: Observation[] = [];
  let imports = 0;
  const imported = (name: string, params: ValType[], results: ValType[], implementation: unknown) => {
    const typeIdx = module.types.length;
    module.types.push({ kind: "func", params, results });
    module.imports.push({ module: "control", name, desc: { kind: "func", typeIdx } });
    controls[name] = implementation;
    return imports++;
  };
  if (offset) imported("prefix", [], [], () => {});
  const target = {},
    constructorValue = () => 1,
    method = () => 2,
    getter = () => 3,
    setter = () => 4;
  const symbols = new Map([
    [3, Symbol.toPrimitive],
    [4, Symbol.toStringTag],
    [7, Symbol.match],
  ]);
  const value = (name: string, operand: unknown): Instr[] => [
    { op: "call", funcIdx: imported(name, [], [E], () => operand) },
  ];
  const callable = (name: string, operand: unknown): Instr[] => [...value(name, operand), { op: "any.convert_extern" }];
  const key = (name: string) => ({ kind: "string", literal: value("key:" + name, name) }) as const;
  const defineValueIdx = imported(
    "defineValue",
    [E, E, E, F],
    [E],
    (object: unknown, property: unknown, item: unknown, flags: number) => {
      observations.push({ kind: "data", target: object, key: property, value: item, flags });
      return { deliberatelyDifferentReturnTarget: true };
    },
  );
  const defineAccessorIdx = imported(
    "defineAccessor",
    [E, E, E, E, F],
    [E],
    (object: unknown, property: unknown, get: unknown, set: unknown, flags: number) => {
      if (poison === "throw") throw 99;
      observations.push({ kind: "accessor", target: object, key: property, value: get, setter: set, flags });
      return object;
    },
  );
  const boxNumberIdx = imported("boxNumber", [F], [E], (number: number) => number);
  const boxSymbolIdx = imported("boxSymbol", [I], [E], (id: number) => symbols.get(id));
  const sharedMethod = callable("method", method);
  const entries: PrototypeSeedEntry[] = [
    { kind: "constructor", key: key("constructor"), value: value("constructor", constructorValue), defineValueIdx },
    { kind: "method", member: "run", key: key("run"), singleton: sharedMethod, defineIdx: defineValueIdx },
    {
      kind: "getter",
      member: "size",
      key: key("size"),
      singleton: callable("getter", getter),
      defineIdx: defineAccessorIdx,
    },
    {
      kind: "method",
      member: "@@3",
      key: { kind: "symbol", symbolId: 3, boxSymbolIdx },
      singleton: sharedMethod,
      defineIdx: defineValueIdx,
    },
    {
      kind: "method",
      member: "@@03",
      key: { kind: "symbol", symbolId: 3, boxSymbolIdx },
      singleton: sharedMethod,
      defineIdx: defineValueIdx,
    },
    { kind: "string-data", key: key("name"), value: value("name", "Error"), defineValueIdx },
    { kind: "number-data", key: key("BYTES_PER_ELEMENT"), value: 8, boxNumberIdx, defineValueIdx },
    {
      kind: "accessor-pair",
      key: key("stack"),
      getter: callable("getStack", getter),
      setter: callable("setStack", setter),
      defineAccessorIdx,
    },
    { kind: "symbol-tag", value: value("tag", "Example"), boxSymbolIdx, defineValueIdx },
  ];
  const expected: Observation[] = [
    { kind: "data", target, key: "constructor", value: constructorValue, flags: 189 },
    { kind: "data", target, key: "run", value: method, flags: 189 },
    { kind: "accessor", target, key: "size", value: getter, setter: null, flags: 52 },
    { kind: "data", target, key: Symbol.toPrimitive, value: method, flags: 188 },
    { kind: "data", target, key: Symbol.toPrimitive, value: method, flags: 189 },
    { kind: "data", target, key: "name", value: "Error", flags: 189 },
    { kind: "data", target, key: "BYTES_PER_ELEMENT", value: 8, flags: 184 },
    { kind: "accessor", target, key: "stack", value: getter, setter, flags: 52 },
    { kind: "data", target, key: Symbol.toStringTag, value: "Example", flags: 188 },
  ];
  const body = buildPrototypeSeederBody(poison === "remove" ? entries.slice(1) : entries);
  if (poison === "flags") {
    const instruction = body.find((instruction) => instruction.op === "f64.const" && instruction.value === 184);
    if (!instruction || instruction.op !== "f64.const") throw Error("poison target missing");
    instruction.value = 189;
  }
  const typeIdx = module.types.length;
  module.types.push({ kind: "func", params: [E], results: [] });
  module.functions.push({ name: "seed", typeIdx, locals: [], body, exported: true });
  module.exports.push({ name: "seed", desc: { kind: "func", index: imports } });
  const binary = emitBinary(module);
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary, { control: controls as WebAssembly.ModuleImports });
  const seed = instance.exports.seed as (target: unknown) => void;
  return { seed: () => seed(target), observations, expected, entries };
}

describe("emitted prototype seeder with controlled descriptor observers", () => {
  it.each([false, true])(
    "executes all nine ordered installations with exact identities/attributes, offset=%s",
    async (offset) => {
      const fixture = await executableSeeder(offset);
      expect(fixture.seed()).toBeUndefined();
      expect(fixture.observations).toStrictEqual(fixture.expected);
      expect(fixture.observations.every((row) => row.target === fixture.expected[0]!.target)).toBe(true);
    },
  );
  it.each(["flags", "remove"] as const)("observes the %s mutation after a passing emitted control", async (poison) => {
    const positive = await executableSeeder(false);
    positive.seed();
    expect(positive.observations).toStrictEqual(positive.expected);
    const changed = await executableSeeder(false, poison);
    changed.seed();
    expect(changed.observations).not.toStrictEqual(changed.expected);
    if (poison === "remove") expect(changed.observations).toHaveLength(8);
    else expect(changed.observations.find((row) => row.key === "BYTES_PER_ELEMENT")!.flags).toBe(189);
  });
  it("propagates a real descriptor throw and executes no later seed", async () => {
    const fixture = await executableSeeder(false, "throw");
    let caught: unknown;
    try {
      fixture.seed();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(99);
    expect(fixture.observations).toStrictEqual(fixture.expected.slice(0, 2));
  });
  it("freshly constructs nested reused operands at every position without changing input data", () => {
    const operand: Instr[] = [
      { op: "i32.const", value: 1 },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "ref.null.extern" }],
        else: [{ op: "ref.null.extern" }],
      },
    ];
    const entry: PrototypeSeedEntry = {
      kind: "string-data",
      key: { kind: "string", literal: operand },
      value: operand,
      defineValueIdx: 7,
    };
    const before = structuredClone(operand),
      first = buildPrototypeSeedEntry(entry),
      second = buildPrototypeSeedEntry(entry);
    expect(first).toStrictEqual(second);
    const firstIf = first[2];
    if (!firstIf || firstIf.op !== "if") throw Error("nested operand missing");
    firstIf.then.push({ op: "nop" });
    expect(first).not.toStrictEqual(second);
    expect(operand).toStrictEqual(before);
    expect(second).toStrictEqual(buildPrototypeSeedEntry(entry));
    expect(first[4]).toStrictEqual(before[1]);
  });
  it("retains the constructor helper's supplied flags and return-target drop ABI", () => {
    expect(buildPrototypeSeedDataTail(17, 123)).toStrictEqual([
      { op: "f64.const", value: 123 },
      { op: "call", funcIdx: 17 },
      { op: "drop" },
    ]);
    expect(PROTOTYPE_SEED_FLAGS).toStrictEqual({ method: 189, symbolTag: 188, constant: 184, accessor: 52 });
  });
});
