// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  applyPrototypeSeederExtraction,
  prototypeSeederExtractionPath,
  prototypeSeederExtractionReceipt,
  readSeederExtractionSource,
} from "./helpers/prototype-seeder-extraction.js";
import {
  authenticatePrototypeSeederDonor,
  capturePrototypeSeeder,
  readCurrentPrototypeSeederSource,
  selectPrototypeSeederFunction,
  type PrototypeSeederScenario,
} from "./helpers/prototype-seeder-donor.js";
import { applyPrototypeSingletonExtraction } from "./helpers/prototype-singleton-extraction.js";

const receipt = prototypeSeederExtractionReceipt();
describe("installed seeder extraction after signed singleton recipes", () => {
  it("authenticates both actual parent blobs and the installed scope", () => {
    expect(receipt.base).toBe("637a810dc268bb7aa516aaffd08c0f72379d7c43");
    expect(receipt.status).toBe("installed legacy seeder extraction; no native prototype provider completion");
    expect(receipt.records.map((r) => r.gitBlob)).toEqual([
      "fd892b096eb3d98166971f5225cd67ddfd4f55a4",
      "d6fc988ad8018016ec6e2cb90e2801238e3e8ee3",
    ]);
    expect(receipt.records.map((r) => r.spans.length)).toEqual([8, 3]);
  });
  for (const record of receipt.records) {
    it("reconstructs the full parent and replays the actual adapter: " + record.path, () => {
      const current = readSeederExtractionSource(record.path);
      const restored = applyPrototypeSeederExtraction(record.path, current, true);
      expect(restored).toBe(record.source);
      expect(restored).not.toBe(current);
      expect(applyPrototypeSeederExtraction(record.path, restored, false)).toBe(current);
      const donor = authenticatePrototypeSeederDonor().records.find((r) => r.path === record.path)!;
      expect(selectPrototypeSeederFunction(record.path, restored)).toBe(donor.selected.text);
    });
    for (const [index, span] of record.spans.entries())
      it(`${record.path}:${index} rejects damaged, removed and duplicate declared spans`, () => {
        const current = readSeederExtractionSource(record.path);
        expect(applyPrototypeSeederExtraction(record.path, current, true)).toBe(record.source);
        for (const [source, from, inverse] of [
          [current, span.after, true],
          [record.source, span.before, false],
        ] as const) {
          expect(source.split(from)).toHaveLength(2);
          for (const changed of [from.replace(/\S/, "~"), "", from + from]) {
            const mutation = source.replace(from, () => changed);
            expect(mutation).not.toBe(source);
            expect(() => applyPrototypeSeederExtraction(record.path, mutation, inverse)).toThrow(
              "span missing or duplicated",
            );
          }
        }
      });
    it("rejects reordering, unrelated changes and parent-source substitution: " + record.path, () => {
      const current = readSeederExtractionSource(record.path);
      for (const [source, inverse] of [
        [current, true],
        [record.source, false],
      ] as const) {
        const first = record.spans[0]![inverse ? "after" : "before"];
        const last = record.spans.at(-1)![inverse ? "after" : "before"];
        const marker = "__seeder_extraction_order__";
        expect(source).not.toContain(marker);
        const swapped = source.replace(first, marker).replace(last, first).replace(marker, last);
        expect(() => applyPrototypeSeederExtraction(record.path, swapped, inverse)).toThrow("order or offset");
        expect(() => applyPrototypeSeederExtraction(record.path, source + "\n// unowned\n", inverse)).toThrow(
          "retained source mismatch",
        );
      }
      expect(() => applyPrototypeSeederExtraction(record.path, record.source, true)).toThrow(
        "span missing or duplicated",
      );
    });
  }
  for (const dependency of receipt.dependencies)
    it("authenticates the actual shared dependency " + dependency.path, () => {
      prototypeSeederExtractionReceipt();
      expect(() =>
        prototypeSeederExtractionReceipt(
          (path) => readSeederExtractionSource(path) + (path === dependency.path ? "\n" : ""),
        ),
      ).toThrow("dependency mismatch");
    });
  it("rejects changed receipt authority and unowned paths", () => {
    prototypeSeederExtractionReceipt();
    expect(() =>
      prototypeSeederExtractionReceipt(
        (path) => readSeederExtractionSource(path) + (path === prototypeSeederExtractionPath ? "\n" : ""),
      ),
    ).toThrow("receipt mismatch");
    expect(() => applyPrototypeSeederExtraction("unowned", "", true)).toThrow("unrecorded");
  });
  it("composes before the original singleton full-source inverse and replays both layers", () => {
    const current = readSeederExtractionSource("src/codegen/native-proto.ts");
    const historical = applyPrototypeSingletonExtraction(current, true);
    expect(historical).not.toBe(current);
    expect(applyPrototypeSingletonExtraction(historical, false)).toBe(current);
  });
});

const scenarios: PrototypeSeederScenario[] = [
  {},
  { constructorCarrier: "missing", csv: "" },
  { constructorCarrier: "declined", csv: "run" },
  { constructorCarrier: "ref", changing: true, reenter: true },
  { csv: "first, ,second,first" },
  { csv: "size", getters: ["size"] },
  { csv: "size", getters: ["size"], missingAccessor: true },
  { csv: "missing,works", missingClosures: ["missing"] },
  { csv: "@@3,@@03,@@7,@@bad,@@1.5" },
  { csv: "@@7,run", missingSymbol: true },
  { name: "Date", csv: "toGMTString,toUTCString", changing: true },
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
  { csv: "", accessors: [{ key: "stack", get: "get stack", set: "set stack" }], missingClosures: ["set stack"] },
  { csv: "", tag: "Map" },
  { csv: "", tag: "Map", missingSymbol: true },
  { standalone: false },
  { memberDirty: false },
  { missingGlue: true },
  { missingValue: true },
  { invalidBrand: true },
  { existing: true },
];
describe("actual legacy seeder adapter acquisition", () => {
  it.each(scenarios)("retains the complete donor trace and instruction body: %j", (scenario) => {
    expect(capturePrototypeSeeder("current", scenario)).toStrictEqual(capturePrototypeSeeder(false, scenario));
  });
  it("keeps borrowed literal and singleton instruction identities through deferred patching", () => {
    const scenario: PrototypeSeederScenario = {
      constructorCarrier: "ref",
      changing: true,
      reenter: true,
      deferred: true,
      name: "Date",
      csv: "toGMTString,toUTCString,size,@@3",
      getters: ["size"],
      data: [
        ["name", "Date"],
        ["BYTES_PER_ELEMENT", 8],
      ],
      accessors: [{ key: "stack", get: "get stack", set: "set stack" }],
      tag: "Date",
    };
    const actual = capturePrototypeSeeder("current", scenario);
    expect(actual).toStrictEqual(capturePrototypeSeeder(false, scenario));
    expect(actual.deferred!.retained.length).toBeGreaterThan(10);
    expect(actual.deferred!.retained.every(Boolean)).toBe(true);
    expect(actual.deferred!.after).not.toStrictEqual(actual.deferred!.before);
    // The preserved, uninstalled candidate copied those nodes. Do not silently
    // rewrite that receipt or mistake its value-only observations for identity.
    const prior = capturePrototypeSeeder(true, scenario);
    expect(prior.deferred!.retained.some((retained) => !retained)).toBe(true);
    expect(prior).not.toStrictEqual(actual);
  });
  it("observes removal of the current member tail after a positive", () => {
    const path = "src/codegen/native-proto.ts";
    const current = readCurrentPrototypeSeederSource(path);
    const tail = "    body.push(...buildPrototypeSeedMemberTail(member, kind, defineIdx));\n";
    expect(current.split(tail)).toHaveLength(2);
    const mutated = current.replace(tail, "");
    expect(mutated).not.toBe(current);
    const positive = capturePrototypeSeeder("current", {});
    expect(positive).toStrictEqual(capturePrototypeSeeder(false, {}));
    expect(
      capturePrototypeSeeder("current", {}, (p) => (p === path ? mutated : readCurrentPrototypeSeederSource(p))),
    ).not.toStrictEqual(positive);
    expect(() => applyPrototypeSeederExtraction(path, mutated, true)).toThrow("span missing or duplicated");
  });
});
