// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  createIrNativeNumberUndefinedFinalizationPolicyReader as capture,
  createLazyIrNativeNumberUndefinedFinalizationPolicyReader as lazy,
  assertNativeNumberUndefinedFinalizationPolicyReceipt as structure,
  nativeNumberUndefinedFinalizationPolicyReceiptPath as receiptPath,
  type FinalizationPolicyReceipt,
} from "./helpers/ir-native-number-undefined-finalization-policy-successor.js";
import {
  createLazyIrNativeNumberUndefinedOptimizationPolicyReader as optimizationLazy,
  createIrNativeNumberUndefinedOptimizationPolicyReader as optimization,
} from "./helpers/ir-native-number-undefined-optimization-policy-successor.js";
import {
  captureIrNativeNumberUndefinedInventoryPredecessorPolicy as inventoryData,
  captureIrNativeNumberUndefinedInventoryPredecessorPolicySource as inventoryRaw,
  createIrNativeNumberUndefinedInventoryReader as inventory,
} from "./helpers/ir-native-number-undefined-inventory-successor.js";
const physical = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const receiptText = physical(receiptPath),
  receipt = JSON.parse(receiptText) as FinalizationPolicyReceipt;
const required = [
  receiptPath,
  "scripts/compiler-boundaries.json",
  ...receipt.callers.map((r) => r.path),
  ...receipt.anchors.map((r) => r.path),
];
const snapshot = () => new Map(required.map((path) => [path, physical(path)]));
const reader =
  (values: ReadonlyMap<string, unknown>, reads: string[] = []) =>
  (path: string): string => {
    reads.push(path);
    if (!values.has(path)) throw Error("missing " + path);
    return values.get(path) as string;
  };
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function replay(
  raw: string,
  edits: FinalizationPolicyReceipt["transforms"][number]["edits"],
  inverse: boolean,
): string {
  const input = Buffer.from(raw),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const edit of edits) {
    const start = inverse ? edit.currentStart : edit.beforeStart,
      end = inverse ? edit.currentEnd : edit.beforeEnd;
    expect(start).toBeGreaterThanOrEqual(cursor);
    expect(input.subarray(start, end).toString()).toBe(inverse ? edit.currentText : edit.beforeText);
    parts.push(input.subarray(cursor, start), Buffer.from(inverse ? edit.beforeText : edit.currentText));
    cursor = end;
  }
  parts.push(input.subarray(cursor));
  return Buffer.concat(parts).toString();
}
it("F01 externally pins the new helper and receipt without modifying six old authorities", () => {
  expect(Buffer.byteLength(physical("tests/helpers/ir-native-number-undefined-finalization-policy-successor.ts"))).toBe(
    10046,
  );
  expect(sha(physical("tests/helpers/ir-native-number-undefined-finalization-policy-successor.ts"))).toBe(
    "9143fbe561b23e4bda132f4ed2fe7d4d07e5cee1d287c64e6d93635e13f77f0b",
  );
  expect(Buffer.byteLength(receiptText)).toBe(18232);
  expect(sha(receiptText)).toBe("78ab11c6a40f0ac5a9728c375b3d3f1de374447908d0c9bcc85972dbc491a44f");
  structure(receipt);
  expect(receipt.anchors).toHaveLength(6);
  expect(receipt.callers).toHaveLength(4);
  expect(receipt.transforms).toHaveLength(5);
  expect(receipt.before.source.sha256).toBe("c147c9a37950d784905920d5a226584b1ed8e823246964f89791d4e8f2769f8f");
  expect(receipt.current.source.sha256).toBe("d0d2fdb7591c875303a0197fb413076a1f316c0ecb38ed7bcbc35ce40448f985");
});
it.each(receipt.transforms)("F02 independently replays complete raw inverse and forward $path", (transform) => {
  const current = physical(transform.path),
    before = replay(current, transform.edits, true);
  expect(Buffer.byteLength(before)).toBe(transform.before.bytes);
  expect(sha(before)).toBe(transform.before.sha256);
  expect(replay(before, transform.edits, false)).toBe(current);
  expect(capture(physical)(transform.path)).toBe(before);
});
it("F03 reconstructs whole DATA in both directions with exact row2016 and terminal rows", () => {
  const current = JSON.parse(physical("scripts/compiler-boundaries.json")),
    before = JSON.parse(capture(physical)("scripts/compiler-boundaries.json"));
  expect(current.files).toHaveLength(2020);
  expect(before.files).toHaveLength(2018);
  const inverse = clone(current);
  for (const row of [...receipt.inserted].reverse()) {
    expect(inverse.files[row.index]).toEqual(row.row);
    inverse.files.splice(row.index, 1);
  }
  for (const row of receipt.replaced) {
    expect(inverse.files[row.index]).toEqual(row.current);
    inverse.files[row.index] = row.before;
  }
  expect(inverse).toEqual(before);
  const forward = clone(before);
  for (const row of receipt.replaced) {
    expect(forward.files[row.index]).toEqual(row.before);
    forward.files[row.index] = row.current;
  }
  for (const row of receipt.inserted) forward.files.splice(row.index, 0, row.row);
  expect(forward).toEqual(current);
  expect(before.files[2016].state).toBe("unmigrated");
  expect(current.files[2016].state).toBe("compatibility-adapter");
  expect(current.files[2017]).toEqual(before.files[2017]);
  expect(current.files[2018].layer).toBe("mixed-needs-split");
  expect(current.files[2019].layer).toBe("mixed-needs-split");
});
it("F04 captures exactly12 physical operands once and genuine older Deno anchors only once", () => {
  const reads: string[] = [],
    values = new Map(snapshot());
  const older = [
    "tests/helpers/ir-deno-post-position-main-successor.ts",
    "tests/helpers/ir-deno-post-position-main-successor.json",
  ];
  for (const path of older) values.set(path, physical(path));
  const outer = capture(reader(values, reads));
  expect(reads).toEqual(required);
  expect(required).toHaveLength(12);
  const current = inventory(optimization(outer));
  expect(JSON.parse(current("scripts/compiler-boundaries.json")).files).toHaveLength(2001);
  expect(reads).toEqual([...required, ...older]);
  for (const path of required) outer(path);
  expect(reads).toHaveLength(14);
});
it.each(required)("F05 fresh operation rejects changed whole physical operand %s", (path) => {
  const values = snapshot(),
    reads: string[] = [],
    first = capture(reader(values, reads));
  values.set(path, values.get(path)! + " ");
  expect(() => capture(reader(values))).toThrow();
  expect(first("scripts/compiler-boundaries.json")).toBe(
    replay(physical("scripts/compiler-boundaries.json"), receipt.transforms[0]!.edits, true),
  );
});
it.each(required)("F06 refuses omitted and nonprimitive operand without coercion %s", (path) => {
  const values = new Map<string, unknown>(snapshot());
  values.delete(path);
  expect(() => capture(reader(values))).toThrow();
  let effects = 0;
  values.set(path, {
    toString() {
      effects++;
      return physical(path);
    },
  });
  expect(() => capture(reader(values))).toThrow();
  expect(effects).toBe(0);
});
it.each([
  "row2016",
  "row2017",
  "row2018",
  "row2019",
  "order",
  "duplicate",
  "missing",
  "extra",
  "nonfiles",
  "edges",
  "activation",
  "raw",
])("F07 refuses hostile policy %s", (kind) => {
  const values = snapshot(),
    raw = values.get("scripts/compiler-boundaries.json")!,
    parsed = JSON.parse(raw);
  if (kind.startsWith("row"))
    parsed.files[Number(kind.slice(3))].state =
      parsed.files[Number(kind.slice(3))].state === "clean" ? "unmigrated" : "clean";
  if (kind === "order") [parsed.files[2018], parsed.files[2019]] = [parsed.files[2019], parsed.files[2018]];
  if (kind === "duplicate") parsed.files.push(clone(parsed.files[2016]));
  if (kind === "missing") parsed.files.pop();
  if (kind === "extra") parsed.foreign = true;
  if (kind === "nonfiles") parsed.description += " foreign";
  if (kind === "edges") parsed.allowedEdges.foreign = ["foreign"];
  if (kind === "activation") parsed.activationHistory.push({ foreign: true });
  values.set("scripts/compiler-boundaries.json", kind === "raw" ? raw + " " : JSON.stringify(parsed));
  expect(() => capture(reader(values))).toThrow();
});
it.each([
  "extra",
  "replaced-before",
  "replaced-current",
  "replaced-index",
  "inserted",
  "caller",
  "anchor",
  "span",
  "before",
  "current",
  "order",
])("F08 closed receipt rejects diagnostic %s mutation", (kind) => {
  const value = clone(receipt) as Mutable<FinalizationPolicyReceipt> & { foreign?: boolean };
  if (kind === "extra") value.foreign = true;
  if (kind === "replaced-before") value.replaced[0].before.state = "clean";
  if (kind === "replaced-current") value.replaced[0].current.state = "clean";
  if (kind === "replaced-index") value.replaced[0].index++;
  if (kind === "inserted") value.inserted.pop();
  if (kind === "caller") value.callers[0].sha256 = "0".repeat(64);
  if (kind === "anchor") value.anchors.pop();
  if (kind === "span") value.transforms[0].edits[0].currentEnd++;
  if (kind === "before") value.before.count++;
  if (kind === "current") value.current.count++;
  if (kind === "order") value.callers.reverse();
  expect(() => structure(value)).toThrow();
});
it.each([undefined, null, 0, false, "", new String("scripts/compiler-boundaries.json")])(
  "F09 lazy malformed path %j refuses before physical IO",
  (value) => {
    let reads = 0,
      effects = 0;
    const view = lazy(() => {
      reads++;
      throw Error("physical effect");
    });
    const path =
      value instanceof String
        ? {
            toString() {
              effects++;
              return "scripts/compiler-boundaries.json";
            },
          }
        : value;
    expect(() => view(path as string)).toThrow();
    expect(reads).toBe(0);
    expect(effects).toBe(0);
  },
);
it("F10 accessor, cyclic, sparse, symbolic and inherited diagnostic receipt refuse with zero getter effects", () => {
  let getters = 0;
  const accessor = clone(receipt);
  Object.defineProperty(accessor, "schema", {
    get() {
      getters++;
      return 1;
    },
    enumerable: true,
  });
  expect(() => structure(accessor)).toThrow();
  expect(getters).toBe(0);
  const cyclic = clone(receipt) as unknown as Record<string, unknown>;
  cyclic.cycle = cyclic;
  expect(() => structure(cyclic)).toThrow();
  const sparse = clone(receipt) as Mutable<FinalizationPolicyReceipt>;
  Reflect.deleteProperty(sparse.callers, "0");
  expect(() => structure(sparse)).toThrow();
  const symbol = clone(receipt);
  Object.defineProperty(symbol, Symbol("foreign"), { value: 1 });
  expect(() => structure(symbol)).toThrow();
  expect(() => structure(Object.create(receipt))).toThrow();
});
it("F11 lazy operation authenticates only on first valid path and separate operations capture freshly", () => {
  const values = snapshot(),
    reads: string[] = [],
    one = lazy(reader(values, reads));
  expect(reads).toEqual([]);
  one("scripts/compiler-boundaries.json");
  expect(reads).toEqual(required);
  one("scripts/compiler-boundaries.json");
  expect(reads).toEqual(required);
  values.set(receiptPath, "changed");
  expect(() => lazy(reader(values))("scripts/compiler-boundaries.json")).toThrow();
});
it("F12 unknown primitive passthrough remains actual source and is read once within an operation", () => {
  const values = snapshot(),
    reads: string[] = [],
    path = "src/ir/native-number-undefined-source.ts",
    actual = physical(path);
  values.set(path, actual);
  const view = capture(reader(values, reads));
  expect(view(path)).toBe(actual);
  expect(view(path)).toBe(actual);
  expect(reads).toEqual([...required, path]);
});
it.each([receiptPath, ...receipt.callers.map((r) => r.path)])(
  "F13 actual owned disk drift %s fails freshly and restores exact bytes",
  async (path) => {
    await yieldTurn();
    const url = new URL(`../${path}`, import.meta.url),
      original = readFileSync(url);
    capture(physical);
    try {
      writeFileSync(url, Buffer.concat([original, Buffer.from("\n")]));
      expect(() => capture(physical)).toThrow();
    } finally {
      writeFileSync(url, original);
    }
    expect(readFileSync(url)).toEqual(original);
    expect(JSON.parse(capture(physical)("scripts/compiler-boundaries.json")).files).toHaveLength(2018);
  },
);

it("F14 genuine malformed DATA and nonprimitive raw refuse before lazy outer physical IO", () => {
  let reads = 0,
    getters = 0;
  const view = optimizationLazy(
    lazy(() => {
      reads++;
      throw Error("physical read executed");
    }),
  );
  const value = Object.defineProperty({}, "files", {
    enumerable: true,
    get() {
      getters++;
      throw Error("payload getter executed");
    },
  });
  expect(() => inventoryData(value, view)).toThrow();
  expect(() =>
    inventoryRaw(
      {
        toString() {
          getters++;
          return "not-json";
        },
      } as unknown as string,
      view,
    ),
  ).toThrow();
  expect(reads).toBe(0);
  expect(getters).toBe(0);
});

it("F15 primitive invalid raw preserves historical authenticate-before-semantic-refusal ordering", () => {
  const reads: string[] = [],
    values = new Map(snapshot());
  const older = [
    "tests/helpers/ir-deno-post-position-main-successor.ts",
    "tests/helpers/ir-deno-post-position-main-successor.json",
  ];
  for (const path of older) values.set(path, physical(path));
  expect(() => inventoryRaw("not-json", optimizationLazy(lazy(reader(values, reads))))).toThrow();
  expect(reads).toEqual([...required, ...older]);
});
it("F16 historical save preparation retains actual current physical caller and policy custody", () => {
  const inventoryPath = "tests/issue-3525-native-number-undefined-inventory-successor.test.ts";
  const callerPath = "tests/issue-4376-post-position-main-inventory-successor.test.ts";
  const code = physical(inventoryPath);
  expect(code).toContain(
    'const actualDisk = (path: string): string => readFileSync(resolve(root, path), "utf8");\nconst physicalDisk = actualDisk;',
  );
  expect(code).toContain("original = actualDisk(path);");
  const actualCaller = physical(callerPath),
    historicalCaller = capture(physical)(callerPath);
  expect(sha(actualCaller)).toBe(receipt.callers.find((row) => row.path === callerPath)!.sha256);
  expect(sha(actualCaller)).not.toBe(sha(historicalCaller));
  expect(sha(physical("scripts/compiler-boundaries.json"))).toBe(receipt.current.source.sha256);
  expect(sha(capture(physical)("scripts/compiler-boundaries.json"))).toBe(receipt.before.source.sha256);
});
