import {
  createIrNativeNumberUndefinedFinalizationPolicyReader,
  createLazyIrNativeNumberUndefinedFinalizationPolicyReader,
} from "./helpers/ir-native-number-undefined-finalization-policy-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import ts from "typescript";
import {
  createIrNativeNumberUndefinedOptimizationPolicyReader as originalCapture,
  createLazyIrNativeNumberUndefinedOptimizationPolicyReader as originalLazy,
  assertNativeNumberUndefinedOptimizationPolicyReceipt as structure,
  nativeNumberUndefinedOptimizationPolicyReceiptPath as receiptPath,
  type OptimizationPolicyReceipt,
} from "./helpers/ir-native-number-undefined-optimization-policy-successor.js";
import { createIrNativeNumberUndefinedSourceEpochView } from "./helpers/ir-native-number-undefined-source-successor.js";
import {
  createIrNativeNumberUndefinedInventoryReader as inventoryReader,
  captureIrNativeNumberUndefinedInventoryPredecessorPolicy as inventoryData,
  captureIrNativeNumberUndefinedInventoryPredecessorPolicySource as inventoryRaw,
} from "./helpers/ir-native-number-undefined-inventory-successor.js";
const physicalDisk = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const actualDisk = (path: string): string => createIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk)(path);
const capture = (supplied: (path: string) => string) =>
  originalCapture(
    supplied === actualDisk ? createIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk) : supplied,
  );
const lazy = (supplied: (path: string) => string) =>
  originalLazy(
    supplied === actualDisk ? createLazyIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk) : supplied,
  );
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const receiptText = actualDisk(receiptPath),
  receipt = JSON.parse(receiptText) as OptimizationPolicyReceipt;
const required = [
  receiptPath,
  "scripts/compiler-boundaries.json",
  ...receipt.callers.map((r) => r.path),
  ...receipt.anchors.map((r) => r.path),
];
const snapshot = () => new Map(required.map((path) => [path, actualDisk(path)]));
const reader =
  (values: ReadonlyMap<string, unknown>, reads: string[] = []) =>
  (path: string): string => {
    reads.push(path);
    if (!values.has(path)) throw Error("missing " + path);
    return values.get(path) as string;
  };
function replay(
  text: string,
  edits: OptimizationPolicyReceipt["transforms"][number]["edits"],
  inverse: boolean,
): string {
  const parts: Buffer[] = [],
    input = Buffer.from(text);
  let cursor = 0;
  for (const edit of edits) {
    const start = inverse ? edit.currentStart : edit.beforeStart,
      end = inverse ? edit.currentEnd : edit.beforeEnd;
    const from = inverse ? edit.currentText : edit.beforeText,
      to = inverse ? edit.beforeText : edit.currentText;
    expect(start).toBeGreaterThanOrEqual(cursor);
    expect(input.subarray(start, end).toString()).toBe(from);
    parts.push(input.subarray(cursor, start), Buffer.from(to));
    cursor = end;
  }
  parts.push(input.subarray(cursor));
  return Buffer.concat(parts).toString();
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
it("O01 pins the complete new helper and fixed receipt externally, retaining the 2016 authority", () => {
  expect(
    Buffer.byteLength(actualDisk("tests/helpers/ir-native-number-undefined-optimization-policy-successor.ts")),
  ).toBe(17427);
  expect(hash(actualDisk("tests/helpers/ir-native-number-undefined-optimization-policy-successor.ts"))).toBe(
    "77f416ff5e61a9991149acc5f88d3c840f11a0d2b3ab0ff01ce0ecb1feef255a",
  );
  expect(Buffer.byteLength(receiptText)).toBe(49903);
  expect(hash(receiptText)).toBe("bd98c1cf03d0cfa702ca395a917f7bcbd73dd16dd898671023422f75eaad0ddd");
  structure(receipt);
  expect(receipt.before.source.bytes).toBe(637204);
  expect(receipt.before.source.sha256).toBe("f1934c0f22726ed604b009bc764ac3110f251f2aefb2533fa0dca7c13f874d88");
  expect(receipt.before.count).toBe(2016);
  expect(receipt.current.source.bytes).toBe(638010);
  expect(receipt.current.source.sha256).toBe("c147c9a37950d784905920d5a226584b1ed8e823246964f89791d4e8f2769f8f");
  expect(receipt.current.count).toBe(2018);
  expect(receipt.callers).toHaveLength(3);
  expect(receipt.anchors).toHaveLength(4);
  expect(receipt.transforms).toHaveLength(4);
  expect(new Set(required).size).toBe(9);
});
it("O02 authenticates exactly nine fresh physical reads and performs no mapped rereads", () => {
  const reads: string[] = [],
    view = capture(reader(snapshot(), reads));
  expect(reads).toEqual(required);
  for (const path of required) expect(typeof view(path)).toBe("string");
  expect(reads).toEqual(required);
  expect(hash(view("scripts/compiler-boundaries.json"))).toBe(receipt.before.source.sha256);
  expect(hash(actualDisk("scripts/compiler-boundaries.json"))).toBe(receipt.current.source.sha256);
  expect(view("scripts/compiler-boundaries.json")).not.toBe(actualDisk("scripts/compiler-boundaries.json"));
});
it("O03 independently reconstructs complete policy and all three caller inverses and forwards", () => {
  const view = capture(actualDisk);
  for (const transform of receipt.transforms) {
    const current = actualDisk(transform.path),
      prior = replay(current, transform.edits, true);
    expect(Buffer.byteLength(current)).toBe(transform.current.bytes);
    expect(hash(current)).toBe(transform.current.sha256);
    expect(blob(current)).toBe(transform.current.gitBlob);
    expect(Buffer.byteLength(prior)).toBe(transform.before.bytes);
    expect(hash(prior)).toBe(transform.before.sha256);
    expect(blob(prior)).toBe(transform.before.gitBlob);
    expect(prior).toBe(view(transform.path));
    expect(replay(prior, transform.edits, false)).toBe(current);
  }
});
it("O04 proves exact two-row DATA inverse and forward with every non-files field preserved", () => {
  const current = JSON.parse(actualDisk("scripts/compiler-boundaries.json")),
    before = JSON.parse(capture(actualDisk)("scripts/compiler-boundaries.json"));
  expect(receipt.inserted.map((r) => r.index)).toEqual([2016, 2017]);
  expect(receipt.inserted.map((r) => r.row.path)).toEqual([
    "src/compiler/ir-native-number-undefined-optimization.ts",
    "src/wasm/physical/native-number-undefined-binary.ts",
  ]);
  expect(receipt.inserted[0]!.row.layer).toBe("mixed-needs-split");
  expect(receipt.inserted[0]!.row.state).toBe("unmigrated");
  expect(receipt.inserted[1]!.row.layer).toBe("wasm-physical");
  const inverse = clone(current);
  for (const row of [...receipt.inserted].reverse()) {
    expect(inverse.files[row.index]).toEqual(row.row);
    inverse.files.splice(row.index, 1);
  }
  expect(inverse).toEqual(before);
  const forward = clone(before);
  for (const row of receipt.inserted) forward.files.splice(row.index, 0, row.row);
  expect(forward).toEqual(current);
  for (const [value, profile] of [
    [current, receipt.current],
    [before, receipt.before],
  ] as const) {
    expect(hash(JSON.stringify(value))).toBe(profile.data);
    expect(hash(JSON.stringify(value.files))).toBe(profile.files);
    expect(hash(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "files"))))).toBe(
      profile.nonFiles,
    );
  }
});
function callbacks(text: string): string[] {
  const file = ts.createSourceFile("caller.ts", text, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && /^(it|test)(\.|\(|$)/.test(node.expression.getText(file)))
      for (const argument of node.arguments)
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) result.push(argument.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}
it("O05 preserves historical callback bodies except the received real physical-save operand", () => {
  for (const transform of receipt.transforms.slice(1)) {
    const current = actualDisk(transform.path),
      prior = replay(current, transform.edits, true);
    const now = callbacks(current),
      old = callbacks(prior);
    expect(now.length).toBeGreaterThan(0);
    expect(now).toHaveLength(old.length);
    if (transform.path.includes("issue-3525-native-number-undefined-inventory")) {
      const changed = now.map((body, index) => ({ body, old: old[index]! })).filter((row) => row.body !== row.old);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.body).toBe(changed[0]!.old.replace("original = disk(path)", "original = actualDisk(path)"));
    } else expect(now).toEqual(old);
  }
});
it("O06 proves default composition creates one outer snapshot while explicit readers stay genuine", () => {
  const reads: string[] = [],
    values = new Map<string, string>(snapshot());
  const older = [
    "tests/helpers/ir-deno-post-position-main-successor.ts",
    "tests/helpers/ir-deno-post-position-main-successor.json",
  ];
  for (const path of older) values.set(path, actualDisk(path));
  const outer = capture(reader(values, reads));
  const current = inventoryReader(outer);
  expect(JSON.parse(current("scripts/compiler-boundaries.json")).files).toHaveLength(2001);
  expect(reads).toEqual([...required, ...older]);
  // Three of the five old reads are mapped; two authentic older anchors pass through once.
  expect(current("scripts/compiler-boundaries.json")).toBe(current("scripts/compiler-boundaries.json"));
});
it.each(required)("O07 refuses changed fresh physical operand %s without stale approval", (path) => {
  const values = snapshot(),
    read = reader(values),
    first = capture(read),
    prior = values.get(path)!;
  values.set(path, prior + " ");
  expect(() => capture(read)).toThrow();
  expect(first("scripts/compiler-boundaries.json")).toBe(
    replay(actualDisk("scripts/compiler-boundaries.json"), receipt.transforms[0]!.edits, true),
  );
  values.set(path, prior);
  expect(capture(read)("scripts/compiler-boundaries.json")).toBe(first("scripts/compiler-boundaries.json"));
});
it.each(required)("O08 refuses omitted and nonprimitive operand %s without coercion", (path) => {
  const values = new Map<string, unknown>(snapshot());
  values.delete(path);
  expect(() => capture(reader(values))).toThrow();
  let calls = 0;
  values.set(path, {
    toString() {
      calls++;
      return actualDisk(path);
    },
  });
  expect(() => capture(reader(values))).toThrow();
  expect(calls).toBe(0);
});
it.each(["row", "order", "duplicate", "omitted", "extra", "non-files", "raw"])(
  "O09 rejects actual policy %s mutation",
  (kind) => {
    const values = snapshot(),
      original = values.get("scripts/compiler-boundaries.json")!,
      value = JSON.parse(original);
    if (kind === "row") value.files[2016].state = "clean";
    if (kind === "order") [value.files[2016], value.files[2017]] = [value.files[2017], value.files[2016]];
    if (kind === "duplicate") value.files.push(clone(value.files[2016]));
    if (kind === "omitted") value.files.pop();
    if (kind === "extra") value.files.push({ path: "foreign" });
    if (kind === "non-files") value.description += " foreign";
    values.set("scripts/compiler-boundaries.json", kind === "raw" ? original + "\n" : JSON.stringify(value));
    expect(() => capture(reader(values))).toThrow();
  },
);
it.each(["repin", "fields", "getter", "symbol", "hole", "cycle", "prototype", "nonenumerable"])(
  "O10 refuses fixed receipt %s with zero accessor effects",
  (kind) => {
    const value = clone(receipt) as unknown as Record<string, unknown>;
    let reads = 0;
    if (kind === "repin") (value.current as { source: { sha256: string } }).source.sha256 = "foreign";
    if (kind === "fields") value.foreign = 1;
    if (kind === "getter")
      Object.defineProperty(value, "current", {
        enumerable: true,
        get() {
          reads++;
          return receipt.current;
        },
      });
    if (kind === "symbol") value[Symbol("foreign") as unknown as string] = 1;
    if (kind === "hole") Reflect.deleteProperty(value.callers as object, "0");
    if (kind === "cycle") value.foreign = value;
    if (kind === "prototype") Object.setPrototypeOf(value, {});
    if (kind === "nonenumerable") Object.defineProperty(value, "foreign", { value: 1 });
    expect(() => structure(value)).toThrow();
    expect(reads).toBe(0);
  },
);
it("O11 authenticates before unknown access and reads each unknown once per operation", () => {
  const values = snapshot();
  values.set("unknown-control", "actual");
  const reads: string[] = [],
    view = capture(reader(values, reads));
  expect(view("unknown-control")).toBe("actual");
  expect(view("unknown-control")).toBe("actual");
  expect(reads).toEqual([...required, "unknown-control"]);
  values.set(receiptPath, "stale");
  reads.length = 0;
  expect(() => capture(reader(values, reads))).toThrow();
  expect(reads).toEqual([receiptPath]);
});
it.each([receiptPath, ...receipt.callers.map((r) => r.path)])(
  "O12 detects actual owned disk drift %s and restores exact current bytes",
  async (path) => {
    const url = new URL(`../${path}`, import.meta.url),
      original = readFileSync(url);
    capture(actualDisk);
    try {
      writeFileSync(url, Buffer.concat([original, Buffer.from("\n")]));
      expect(() => capture(actualDisk)).toThrow();
    } finally {
      writeFileSync(url, original);
    }
    expect(readFileSync(url)).toEqual(original);
    expect(JSON.parse(capture(actualDisk)("scripts/compiler-boundaries.json")).files).toHaveLength(2016);
    await yieldTurn();
  },
);
it("O13 retains the actual unchanged 95-source closure rather than certifying historical output as current", async () => {
  const sourceReceipt = JSON.parse(actualDisk("tests/helpers/ir-native-number-undefined-source-successor.json"));
  expect(sourceReceipt.sources).toHaveLength(95);
  // #6920: the source record's closure is pinned at its own epoch; its
  // successor epoch replays the two sources main has since moved.
  const sourceEpoch = createIrNativeNumberUndefinedSourceEpochView(actualDisk);
  for (const row of sourceReceipt.sources) {
    const current = sourceEpoch(row.path);
    expect(Buffer.byteLength(current)).toBe(row.bytes);
    expect(hash(current)).toBe(row.sha256);
    expect(blob(current)).toBe(row.gitBlob);
    await yieldTurn();
  }
});

it.each([
  "tests/helpers/ir-deno-post-position-main-successor.ts",
  "tests/helpers/ir-deno-post-position-main-successor.json",
])("O14 inner authority rejects warm older-anchor drift %s after fresh outer authentication", (path) => {
  const values = new Map<string, string>(snapshot());
  for (const older of [
    "tests/helpers/ir-deno-post-position-main-successor.ts",
    "tests/helpers/ir-deno-post-position-main-successor.json",
  ])
    values.set(older, actualDisk(older));
  inventoryReader(capture(reader(values)));
  const prior = values.get(path)!;
  values.set(path, prior + " ");
  const outer = capture(reader(values));
  expect(() => inventoryReader(outer)).toThrow();
  values.set(path, prior);
  expect(JSON.parse(inventoryReader(capture(reader(values)))("scripts/compiler-boundaries.json")).files).toHaveLength(
    2001,
  );
});

it("O15 preserves genuine malformed DATA and raw refusal before any lazy default physical IO", () => {
  let reads = 0,
    getters = 0;
  const physical = () => {
    reads++;
    throw Error("bad physical authority");
  };
  const value = {};
  Object.defineProperty(value, "files", {
    enumerable: true,
    get() {
      getters++;
      return [];
    },
  });
  expect(() => inventoryData(value, lazy(physical))).toThrow();
  expect(() =>
    inventoryRaw(
      {
        toString() {
          getters++;
          return "stale";
        },
      } as unknown as string,
      lazy(physical),
    ),
  ).toThrow();
  expect(reads).toBe(0);
  expect(getters).toBe(0);
});
it("O16 creates fresh lazy defaults per explicit operation and authenticates genuine healthy eleven-read composition", () => {
  const values = new Map<string, string>(snapshot());
  for (const p of [
    "tests/helpers/ir-deno-post-position-main-successor.ts",
    "tests/helpers/ir-deno-post-position-main-successor.json",
  ])
    values.set(p, actualDisk(p));
  const reads: string[] = [],
    view = lazy(reader(values, reads));
  expect(reads).toHaveLength(0);
  const current = inventoryReader(view);
  expect(reads).toHaveLength(11);
  expect(JSON.parse(current("scripts/compiler-boundaries.json")).files).toHaveLength(2001);
  const old = values.get(receipt.callers[0]!.path)!;
  values.set(receipt.callers[0]!.path, old + " ");
  expect(() => inventoryReader(lazy(reader(values)))).toThrow();
  expect(JSON.parse(current("scripts/compiler-boundaries.json")).files).toHaveLength(2001);
  values.set(receipt.callers[0]!.path, old);
  expect(JSON.parse(inventoryReader(lazy(reader(values)))("scripts/compiler-boundaries.json")).files).toHaveLength(
    2001,
  );
});
it("O17 preserves explicit invalid source readers in the unchanged three real inventory APIs", () => {
  const raw = capture(actualDisk)("scripts/compiler-boundaries.json"),
    value = JSON.parse(raw);
  for (const invalid of [null, 0, false] as const) {
    expect(() => inventoryReader(invalid as never)).toThrow();
    expect(() => inventoryData(value, invalid as never)).toThrow();
    expect(() => inventoryRaw(raw, invalid as never)).toThrow();
  }
});

it.each(["boxed", "object", "getter", "empty", "null", "symbol", "number", "undefined"])(
  "O18 refuses %s paths before passthrough coercion and before lazy physical capture",
  (kind) => {
    let reads = 0,
      coercions = 0;
    const physical = (path: string) => {
      reads++;
      return actualDisk(path);
    };
    const view = capture(physical);
    reads = 0;
    let value: unknown;
    if (kind === "boxed") value = Object("scripts/compiler-boundaries.json");
    if (kind === "object")
      value = {
        toString() {
          coercions++;
          return "scripts/compiler-boundaries.json";
        },
      };
    if (kind === "getter") {
      value = {};
      Object.defineProperty(value, Symbol.toPrimitive, {
        get() {
          coercions++;
          return () => "scripts/compiler-boundaries.json";
        },
      });
    }
    if (kind === "empty") value = "";
    if (kind === "null") value = null;
    if (kind === "symbol") value = Symbol("policy");
    if (kind === "number") value = 0;
    expect(() => view(value as string)).toThrow("primitive nonempty path");
    expect(() => lazy(physical)(value as string)).toThrow("primitive nonempty path");
    expect(reads).toBe(0);
    expect(coercions).toBe(0);
  },
);

it.each(["raw", "semantic"])(
  "O19 preserves the original physical-policy %s refusal category without weakening authentication",
  (kind) => {
    const values = snapshot(),
      raw = values.get("scripts/compiler-boundaries.json")!;
    if (kind === "raw") values.set("scripts/compiler-boundaries.json", raw + "\n");
    else {
      const value = JSON.parse(raw);
      value.files[0].state = "foreign";
      values.set("scripts/compiler-boundaries.json", JSON.stringify(value));
    }
    expect(() => capture(reader(values))).toThrow(
      kind === "raw" ? /complete raw source profile mismatch/ : /complete policy profile mismatch/,
    );
  },
);

it.each([2016, 2001])(
  "O20 refuses the genuine historical %s policy as a fresh current2018 physical operand",
  (count) => {
    const values = snapshot(),
      outer = capture(actualDisk),
      prior =
        count === 2016
          ? outer("scripts/compiler-boundaries.json")
          : inventoryReader(outer)("scripts/compiler-boundaries.json");
    expect(JSON.parse(prior).files).toHaveLength(count);
    values.set("scripts/compiler-boundaries.json", prior);
    expect(() => capture(reader(values))).toThrow(/complete policy profile mismatch/);
  },
);
