// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  assertIrNativeClassLayoutSourceReceiptStructure,
  createIrNativeClassLayoutSourceReader,
  irNativeClassLayoutSourcePath as layoutPath,
  irNativeClassLayoutSourceReceiptPath as receiptPath,
  readBeforeIrNativeClassLayoutSource as beforeClass,
} from "./helpers/ir-native-class-layout-source-successor.js";
import type { IrNativeClassLayoutSourceReceipt } from "./helpers/ir-native-class-layout-source-successor.js";
import { readBeforeIrNativeAllocationTypeOwnership } from "./helpers/ir-native-allocation-type-ownership-successor.js";
import { readBeforeIrAllocationRuleSharing } from "./helpers/ir-allocation-rule-sharing-successor.js";
import { readBeforeIrAllocationProvenanceLookup } from "./helpers/ir-allocation-provenance-lookup-successor.js";
import { reconstructIrValidationAnalysisSources } from "./helpers/ir-validation-analysis-relocation.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { prepareSourceClassPlans } from "../src/ir/source-class-plans.js";
import { assertSourceClassPreparation } from "../src/ir/program/class-preparation.js";
import { assertPreparedIrClassLayouts } from "../src/ir/program/class-layouts.js";
import { preparedIrClassLayoutKey } from "../src/ir/program/abi-signatures.js";
import { irClassTypeRef } from "../src/ir/abi-bindings.js";
import { asValueId } from "../src/ir/core/nodes.js";
import type { IrFunction } from "../src/ir/core/nodes.js";
import type { IrType } from "../src/ir/core/types.js";
import type { PreparedIrAbiEntry } from "../src/ir/program/prepared-contracts.js";

const disk = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const receiptText = disk(receiptPath);
const receipt = JSON.parse(receiptText) as IrNativeClassLayoutSourceReceipt;
const required = [receiptPath, ...receipt.current.map((r) => r.path), ...receipt.anchors.map((r) => r.path)];
const snapshot = (): Map<string, string> => new Map(required.map((path) => [path, disk(path)]));
const reader =
  (values: ReadonlyMap<string, string>, reads: string[] = []) =>
  (path: string): string => {
    reads.push(path);
    const text = values.get(path);
    if (text === undefined) throw Error(`missing ${path}`);
    return text;
  };
const composed = (path: string): string =>
  readBeforeIrAllocationProvenanceLookup(path, (p) =>
    readBeforeIrAllocationRuleSharing(p, (q) =>
      readBeforeIrNativeAllocationTypeOwnership(q, createIrNativeClassLayoutSourceReader(disk)),
    ),
  );
const helperPath = "tests/helpers/ir-native-class-layout-source-successor.ts";
it("N01 pins the whole independent helper and fixed receipt without circular self-hash", () => {
  expect(Buffer.byteLength(disk(helperPath))).toBe(6756);
  expect(sha(disk(helperPath))).toBe("d950856c4a218840c61741046bdea483ad9a632a33b664664dbe6dd0cafbf168");
  expect(Buffer.byteLength(receiptText)).toBe(12174);
  expect(sha(receiptText)).toBe("5adc5506d732c4c9c2e9170557c9a084c8f6dd3dd72929b120aa7d1bdf658045");
  assertIrNativeClassLayoutSourceReceiptStructure(receipt);
  expect(receipt.current).toHaveLength(34);
  expect(receipt.anchors).toHaveLength(8);
  expect(new Set(required).size).toBe(43);
});
it("N02 freshly reads all 43 authentic operands once before mapped delivery", () => {
  const reads: string[] = [];
  const source = beforeClass(layoutPath, reader(snapshot(), reads));
  expect(reads).toEqual(required);
  expect(Buffer.byteLength(source)).toBe(receipt.before.bytes);
  expect(sha(source)).toBe(receipt.before.sha256);
  expect(blob(source)).toBe(receipt.before.gitBlob);
});
it("N03 independently reconstructs complete inverse and forward from five bounded insertions", () => {
  const current = Buffer.from(disk(layoutPath));
  let cursor = 0;
  const inverse: Buffer[] = [];
  for (const edit of receipt.edits) {
    expect(current.subarray(edit.currentStart, edit.currentEnd).toString()).toBe(edit.currentText);
    expect(edit.beforeText).toBe("");
    inverse.push(current.subarray(cursor, edit.currentStart));
    cursor = edit.currentEnd;
  }
  inverse.push(current.subarray(cursor));
  const old = Buffer.concat(inverse);
  expect(old.toString()).toBe(beforeClass(layoutPath, disk));
  let from = 0;
  const forward: Buffer[] = [];
  for (const edit of receipt.edits) {
    forward.push(old.subarray(from, edit.beforeStart), Buffer.from(edit.currentText));
    from = edit.beforeEnd;
  }
  forward.push(old.subarray(from));
  expect(Buffer.concat(forward).equals(current)).toBe(true);
  expect(sha(old.toString())).toBe("900a8b56289b6565feb9dd52fb06405de720916208542be3079465942d0a6f42");
});
it("N04 preserves complete historical nine-source reconstruction and 135 transfer receipt", async () => {
  const old = reconstructIrValidationAnalysisSources(composed);
  const relocation = JSON.parse(disk("tests/helpers/ir-validation-analysis-relocation.json"));
  expect(old.size).toBe(9);
  expect(relocation.current).toHaveLength(13);
  expect(relocation.transfers).toHaveLength(135);
  for (const row of relocation.originals) {
    const text = old.get(row.path)!;
    expect(Buffer.byteLength(text)).toBe(row.bytes);
    expect(sha(text)).toBe(row.sha256);
    expect(blob(text)).toBe(row.gitBlob);
  }
  await yieldTurn();
});
it("N05 refuses every source and anchor mutation with complete fixed pins", async () => {
  let cases = 0;
  for (const row of [...receipt.current, ...receipt.anchors]) {
    const values = snapshot();
    values.set(row.path, values.get(row.path)! + "\n");
    expect(() => beforeClass(layoutPath, reader(values))).toThrow(`complete source pin ${row.path}`);
    cases++;
    await yieldTurn();
  }
  expect(cases).toBe(42);
});
it("N06 refuses every missing source and anchor before delivery", async () => {
  let cases = 0;
  for (const row of [...receipt.current, ...receipt.anchors]) {
    const values = snapshot();
    values.delete(row.path);
    expect(() => beforeClass(layoutPath, reader(values))).toThrow(`missing ${row.path}`);
    cases++;
    await yieldTurn();
  }
  expect(cases).toBe(42);
});
it("N07 authenticates added checks and preserved kernel bytes rather than span names", () => {
  const current = disk(layoutPath);
  const offsets = [
    0,
    ...receipt.edits
      .filter((e) => e.currentText.trim())
      .map((e) => e.currentStart + Math.floor(e.currentText.length / 2)),
  ];
  expect(offsets).toHaveLength(5);
  for (const offset of offsets) {
    const values = snapshot();
    values.set(layoutPath, current.slice(0, offset) + "!" + current.slice(offset + 1));
    expect(() => beforeClass(layoutPath, reader(values))).toThrow(`complete source pin ${layoutPath}`);
  }
});
it("N08 refuses receipt replacement, truncation, reformats and caller-computed repins", () => {
  const variants = [
    "",
    receiptText.slice(0, -1),
    receiptText + "\n",
    JSON.stringify(receipt),
    receiptText.replace('"schema": 1', '"schema": 2'),
  ];
  const forged = structuredClone(receipt);
  (forged.current[0] as { sha256: string }).sha256 = sha(disk(forged.current[0]!.path) + "\n");
  variants.push(JSON.stringify(forged, null, 2) + "\n");
  for (const text of variants) {
    const values = snapshot();
    values.set(receiptPath, text);
    expect(() => beforeClass(layoutPath, reader(values))).toThrow("complete receipt pin");
  }
});
it("N09 rejects closed DATA extra fields, omitted or duplicated populations and changed bindings", () => {
  const variants: unknown[] = [
    { ...receipt, extra: true },
    { ...receipt, base: "foreign" },
    { ...receipt, current: receipt.current.slice(1) },
    { ...receipt, anchors: [...receipt.anchors, receipt.anchors[0]] },
    { ...receipt, current: [...receipt.current].reverse() },
    { ...receipt, edits: receipt.edits.slice(1) },
    { ...receipt, before: { ...receipt.before, sha256: "0".repeat(64) } },
    { ...receipt, current: receipt.current.map((r, i) => (i === 0 ? { ...r, bytes: r.bytes + 1 } : r)) },
  ];
  for (const value of variants) expect(() => assertIrNativeClassLayoutSourceReceiptStructure(value)).toThrow(/receipt/);
});
it("N10 refuses receipt getters without invoking them, at root, nested pin and array elements", () => {
  let invoked = 0;
  for (const kind of ["root", "pin", "element"] as const) {
    const value = structuredClone(receipt);
    const getter = {
      enumerable: true,
      get() {
        invoked++;
        throw Error("getter executed");
      },
    };
    if (kind === "root") Object.defineProperty(value, "current", getter);
    if (kind === "pin") Object.defineProperty(value.current[0], "sha256", getter);
    if (kind === "element") Object.defineProperty(value.current, "0", getter);
    expect(() => assertIrNativeClassLayoutSourceReceiptStructure(value)).toThrow(/DATA descriptor|array descriptor/);
  }
  expect(invoked).toBe(0);
});
it("N11 refuses symbols, holes, extra array fields, cycles, prototypes and executable DATA", () => {
  const symbol = { ...receipt, [Symbol("extra")]: 1 };
  const hole = structuredClone(receipt);
  Reflect.deleteProperty(hole.current, "0");
  const extra = structuredClone(receipt);
  Object.defineProperty(extra.current, "extra", { value: 1, enumerable: true });
  const cycle = { ...receipt, extra: {} as unknown };
  cycle.extra = cycle;
  const prototype = Object.assign(Object.create({ foreign: true }), receipt);
  const nonenumerable = { ...receipt };
  Object.defineProperty(nonenumerable, "hidden", { value: 1 });
  for (const value of [symbol, hole, extra, cycle, prototype, nonenumerable, { ...receipt, extra: () => 0 }])
    expect(() => assertIrNativeClassLayoutSourceReceiptStructure(value)).toThrow(/DATA/);
});
it("N12 refuses repinned dataset permutations and changed spans without caller authority", () => {
  for (const value of [
    {
      ...receipt,
      edits: receipt.edits.map((e, i) =>
        i === 0 ? { ...e, currentText: e.currentText + "\n", currentEnd: e.currentEnd + 1 } : e,
      ),
    },
    {
      ...receipt,
      current: receipt.current.map((r, i) =>
        i === 0 ? { ...r, gitBlob: blob("replacement"), sha256: sha("replacement"), bytes: 11 } : r,
      ),
    },
    { ...receipt, path: "src/ir/program/class-preparation.ts" },
    { ...receipt, kind: "historical-equivalence" },
  ])
    expect(() => assertIrNativeClassLayoutSourceReceiptStructure(value)).toThrow("fixed receipt DATA population");
});
it("N13 reauthenticates warm readers after source drift and restoration", () => {
  const values = snapshot(),
    reads: string[] = [];
  const read = reader(values, reads);
  const first = beforeClass(layoutPath, read);
  const path = "src/ir/program/class-preparation.ts",
    original = values.get(path)!;
  values.set(path, original + "\n");
  expect(() => beforeClass(layoutPath, read)).toThrow(`complete source pin ${path}`);
  values.set(path, original);
  reads.length = 0;
  expect(beforeClass(layoutPath, read)).toBe(first);
  expect(reads).toEqual(required);
});
it("N14 reauthenticates warm readers after anchor and receipt drift", () => {
  const values = snapshot(),
    read = reader(values);
  beforeClass(layoutPath, read);
  for (const path of [receipt.anchors[0]!.path, receiptPath]) {
    const original = values.get(path)!;
    values.set(path, original + "\n");
    expect(() => beforeClass(layoutPath, read)).toThrow(/complete source pin|complete receipt pin/);
    values.set(path, original);
    expect(beforeClass(layoutPath, read)).toBe(beforeClass(layoutPath, disk));
  }
});
it("N15 returns captured mapped bytes without a second physical source read", () => {
  const values = snapshot(),
    reads: string[] = [];
  const counts = new Map<string, number>();
  const result = beforeClass(layoutPath, (path) => {
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    reads.push(path);
    if (count !== 1) throw Error("second read");
    return values.get(path)!;
  });
  expect(result).toBe(beforeClass(layoutPath, disk));
  expect(reads).toEqual(required);
});
it("N16 validates complete capture even for unknown passthrough and reads unknown once", () => {
  const values = snapshot(),
    reads: string[] = [];
  values.set("opaque.txt", "passthrough");
  expect(beforeClass("opaque.txt", reader(values, reads))).toBe("passthrough");
  expect(reads).toEqual([...required, "opaque.txt"]);
  reads.length = 0;
  values.set(layoutPath, values.get(layoutPath)! + "\n");
  expect(() => beforeClass("opaque.txt", reader(values, reads))).toThrow("complete source pin");
  expect(reads).not.toContain("opaque.txt");
});
it("N17 rejects non-primitive source text without coercing attacker getters", () => {
  let coercions = 0;
  const object = {
    toString() {
      coercions++;
      return disk(layoutPath);
    },
  };
  const bad = (path: string): string => (path === layoutPath ? (object as unknown as string) : disk(path));
  expect(() => beforeClass(layoutPath, bad)).toThrow("non-string source");
  const unknown = (path: string): string => (path === "opaque.txt" ? (object as unknown as string) : disk(path));
  expect(() => beforeClass("opaque.txt", unknown)).toThrow("non-string passthrough");
  expect(coercions).toBe(0);
});
it("N18 rejects stale historical input at the actual live capture boundary", () => {
  const old = beforeClass(layoutPath, disk),
    values = snapshot();
  values.set(layoutPath, old);
  expect(() => beforeClass(layoutPath, reader(values))).toThrow(`complete source pin ${layoutPath}`);
});
it("N19 preserves both complete driver preimages after removing only two authorized reader hooks", () => {
  const added =
    'import { createIrNativeClassLayoutSourceReader } from "./helpers/ir-native-class-layout-source-successor.js";\n';
  const binding =
    "const raw = (path: string): string =>\n  readBeforeIrNativeAllocationTypeOwnership(path, createIrNativeClassLayoutSourceReader(actualRaw));";
  const original = "const raw = (path: string): string => readBeforeIrNativeAllocationTypeOwnership(path, actualRaw);";
  for (const [path, bytes, expected] of [
    [
      "tests/issue-6920-allocation-provenance-preservation.test.ts",
      24557,
      "e8ec6b7c824e65f2af7e39e2136d620951f02beb7fe2ce79f1bcb00b697b5a90",
    ],
    [
      "tests/issue-6920-allocation-rule-sharing-preservation.test.ts",
      26382,
      "6f91b3d16602653a0289403226f74facf6e46bb5718e703e9b918dba55cd8edd",
    ],
  ] as const) {
    const text = disk(path);
    expect(text.split(added)).toHaveLength(2);
    expect(text.split(binding)).toHaveLength(2);
    const restored = text.replace(added, "").replace(binding, original);
    expect(Buffer.byteLength(restored)).toBe(bytes);
    expect(sha(restored)).toBe(expected);
  }
});

/** Isolated typed layout DATA fixture, not a class body producer or executable PreparedIR. */
function currentLayoutData() {
  const ast = analyzeMultiSource(
    { "./entry.ts": "class C{x:number;}export function run():number{return 7;}" },
    "./entry.ts",
  );
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
    wholeProgramClassConstructors: true,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const row = prepareSourceClassPlans(ast.checker, identity).plans[0]!.data;
  assertSourceClassPreparation(inventory, [row]);
  const type: IrType = { kind: "class", shape: row.shape };
  const signatureOnly: IrFunction = {
    unitId: row.constructorUnitId,
    name: "signature-only-not-executable",
    params: [...row.shape.constructorParams, type].map((type, i) => ({ value: asValueId(i), name: `p${i}`, type })),
    resultTypes: [type],
    blocks: [],
    exported: false,
    valueCount: row.shape.constructorParams.length + 1,
  };
  const ref = irClassTypeRef(row.classId, row.shape.className);
  const entry: PreparedIrAbiEntry = {
    plan: {
      id: ref.binding.bindingId,
      order: { sourceOrder: 0, declarationOrder: 0 },
      displayName: ref.name,
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "class", classId: row.classId, layoutKey: preparedIrClassLayoutKey(row.shape) },
    },
    contract: { kind: "class", ref, shape: row.shape, preparation: row },
  };
  const program: Parameters<typeof assertPreparedIrClassLayouts>[0] = {
    inventory,
    abi: { entries: [entry] },
    ir: { functions: [signatureOnly] },
    allocations: { size: 0, entries: [], metadata: [] },
  };
  return { row, program, entry };
}
it("N20 runs actual current class DATA joins with authentic original inventory, without runtime credit", () => {
  const { program } = currentLayoutData();
  assertPreparedIrClassLayouts(program);
  assertPreparedIrClassLayouts({
    abi: { entries: [] },
    ir: { functions: [] },
    allocations: { size: 0, entries: [], metadata: [] },
  });
});
it("N21 current source preparation refuses missing inventory and incomplete original constructors", () => {
  const { program, entry } = currentLayoutData();
  const { inventory: unused, ...withoutInventory } = program;
  void unused;
  expect(() => assertPreparedIrClassLayouts(withoutInventory)).toThrow(
    "source class preparation lacks original inventory",
  );
  if (entry.contract.kind !== "class") throw Error("class fixture");
  const { preparation: omitted, ...contract } = entry.contract;
  void omitted;
  expect(() => assertPreparedIrClassLayouts({ ...program, abi: { entries: [{ ...entry, contract }] } })).toThrow(
    "original source constructor lacks complete class preparation",
  );
});
it("N22 current class layout rejects preparation/ABI shape disagreement", () => {
  const { program, entry } = currentLayoutData();
  if (entry.contract.kind !== "class") throw Error("class fixture");
  const contract = { ...entry.contract, shape: { ...entry.contract.shape, className: "contradiction" } };
  expect(() => assertPreparedIrClassLayouts({ ...program, abi: { entries: [{ ...entry, contract }] } })).toThrow(
    "class ABI layout contradicts its source preparation",
  );
});
it("N23 current validator checks authentic class census, source identity and signature joins", () => {
  const { program, entry, row } = currentLayoutData();
  if (entry.contract.kind !== "class") throw Error("class fixture");
  const contract = entry.contract;
  expect(() =>
    assertPreparedIrClassLayouts({
      ...program,
      abi: { entries: [{ ...entry, contract: { ...contract, preparation: { ...row, fieldIntents: [] } } }] },
    }),
  ).toThrow("incomplete field/default census");
  const foreign = { ...row, sourceId: (row.sourceId + "foreign") as typeof row.sourceId };
  expect(() =>
    assertPreparedIrClassLayouts({
      ...program,
      abi: { entries: [{ ...entry, contract: { ...contract, preparation: foreign } }] },
    }),
  ).toThrow("duplicate, missing or foreign class identity");
  expect(() => assertPreparedIrClassLayouts({ ...program, ir: { functions: [] } })).toThrow(
    "constructor init body signature contradicts",
  );
});
it("N24 current class descriptor validation refuses executable accessors without invoking them", () => {
  const { program } = currentLayoutData();
  let invoked = 0;
  const allocations = { ...program.allocations };
  Object.defineProperty(allocations, "poison", {
    enumerable: true,
    get() {
      invoked++;
      throw Error("executed");
    },
  });
  expect(() => assertPreparedIrClassLayouts({ ...program, allocations })).toThrow(
    "prepared class graph contains executable accessors",
  );
  expect(invoked).toBe(0);
});
it("N25 factory captures once per inner operation and never rereads known or repeated unknown paths", () => {
  const values = snapshot(),
    reads: string[] = [];
  values.set("opaque.txt", "unknown");
  const captured = createIrNativeClassLayoutSourceReader(reader(values, reads));
  expect(reads).toEqual(required);
  for (const path of required) expect(typeof captured(path)).toBe("string");
  expect(captured(layoutPath)).toBe(beforeClass(layoutPath, disk));
  expect(reads).toEqual(required);
  expect(captured("opaque.txt")).toBe("unknown");
  expect(captured("opaque.txt")).toBe("unknown");
  expect(reads).toEqual([...required, "opaque.txt"]);
});
it("N26 exact driver hook performs one fresh capture per raw invocation, including warm mutation refusal", () => {
  const values = snapshot(),
    reads: string[] = [];
  const actual = reader(values, reads);
  const raw = (path: string): string =>
    readBeforeIrNativeAllocationTypeOwnership(path, createIrNativeClassLayoutSourceReader(actual));
  const path = "src/ir/analysis/contracts/allocations.ts";
  const first = raw(path);
  expect(reads).toEqual(required);
  reads.length = 0;
  expect(raw(path)).toBe(first);
  expect(reads).toEqual(required);
  const owner = "src/ir/program/class-preparation.ts",
    original = values.get(owner)!;
  values.set(owner, original + "\n");
  expect(() => raw(path)).toThrow(`complete source pin ${owner}`);
  values.set(owner, original);
  reads.length = 0;
  expect(raw(path)).toBe(first);
  expect(reads).toEqual(required);
});
it("N27 a private captured snapshot cannot authorize the next operation after physical drift", () => {
  const values = snapshot(),
    actual = reader(values);
  const captured = createIrNativeClassLayoutSourceReader(actual);
  const before = captured(layoutPath);
  values.set(layoutPath, values.get(layoutPath)! + "\n");
  expect(captured(layoutPath)).toBe(before);
  expect(() => createIrNativeClassLayoutSourceReader(actual)).toThrow(`complete source pin ${layoutPath}`);
});
