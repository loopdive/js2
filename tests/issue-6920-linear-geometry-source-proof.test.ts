// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { LinearLayoutGeometryCapture } from "./helpers/ir-lowering-analysis-relocation.js";

const root = new URL("../", import.meta.url);
const helperPath = "tests/helpers/ir-lowering-analysis-relocation.ts";
const receiptPath = "tests/helpers/ir-linear-layout-geometry-successor.json";
const oldReceiptPath = "tests/helpers/ir-lowering-analysis-relocation.json";
const plannerPath = "src/ir/analysis/linear-memory-plan.ts";
const layoutPath = "src/ir/analysis/contracts/linear-memory-layout.ts";
const sharedPath = "src/shared/contracts/linear-memory-layout.ts";
const readOrder = [receiptPath, plannerPath, layoutPath, sharedPath, oldReceiptPath] as const;
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
}
const inputPins = [
  {
    path: helperPath,
    bytes: 35439,
    sha256: "87bf7de1961b821cf303b5d7e686a5e44614b08b7b371ee6afe4a16172a7851e",
  },
  {
    path: receiptPath,
    bytes: 69621,
    sha256: "e4af32c53ea548b693fbcee78c55b3af47b7985e2dc1b340ddf9c28e0a8f573f",
  },
  {
    path: oldReceiptPath,
    bytes: 111423,
    sha256: "dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134",
  },
  {
    path: plannerPath,
    bytes: 45359,
    sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
  },
  {
    path: layoutPath,
    bytes: 3161,
    sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",
  },
  {
    path: sharedPath,
    bytes: 7580,
    sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",
  },
] as const;
function hashes(bytes: Buffer): Pin {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function physical(path: string): Buffer {
  return readFileSync(new URL(path, root));
}
function authenticateInputs(): void {
  for (const { path, bytes, sha256 } of inputPins) {
    const actual = hashes(physical(path));
    if (actual.bytes !== bytes || actual.sha256 !== sha256) {
      throw new Error(`geometry regression independent complete input pin: ${path}`);
    }
  }
  const prefix = hashes(physical(helperPath).subarray(0, 18956));
  if (prefix.bytes !== 18956 || prefix.sha256 !== "253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99") {
    throw new Error("geometry regression immutable helper prefix changed");
  }
}

// These independent complete pins execute before the actual implementation import.
// Historical view hashes were proved against genuine Git operands by ROOT;
// the test has no Git read, checkout fallback, embedded source or expected-pin override.
authenticateInputs();
const { captureLinearLayoutGeometry: capture } = await import("./helpers/ir-lowering-analysis-relocation.js");
const actualPlanner = physical(plannerPath).toString("utf8");
const viewPins = {
  currentPlanner: inputPins[3],
  currentLayout: inputPins[4],
  currentShared: inputPins[5],
  geometryBeforePlanner: {
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
  },
  geometryBeforeLayout: {
    bytes: 4763,
    sha256: "977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754",
  },
  loweringBeforePlanner: {
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
  },
  loweringBeforeLayout: {
    bytes: 4670,
    sha256: "dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72",
  },
  originalPlanner: {
    bytes: 52704,
    sha256: "382cb4acee2de86904da1c0162ecc8b9de4250f9f9cb49dcba57b1a056c1cc3c",
  },
} as const;
const fields = Object.keys(viewPins) as (keyof LinearLayoutGeometryCapture)[];
function assertView(view: LinearLayoutGeometryCapture): void {
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.getOwnPropertyNames(view)).toEqual(fields);
  expect(Object.getOwnPropertySymbols(view)).toEqual([]);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(view, field)!;
    expect(typeof descriptor.value).toBe("string");
    expect(descriptor.get).toBeUndefined();
    expect(descriptor.set).toBeUndefined();
    expect(descriptor.writable).toBe(false);
    expect(descriptor.configurable).toBe(false);
    const { bytes, sha256 } = viewPins[field];
    expect(hashes(Buffer.from(view[field], "utf8"))).toEqual({ bytes, sha256 });
  }
  expect(view.currentPlanner).toBe(actualPlanner);
  expect(view.currentLayout).toBe(physical(layoutPath).toString("utf8"));
  expect(view.currentShared).toBe(physical(sharedPath).toString("utf8"));
  expect(view.geometryBeforePlanner).toBe(view.loweringBeforePlanner);
}
function fixture() {
  const reads: string[] = [];
  let changed: string | undefined;
  const reader = (path: string): string => {
    if (!readOrder.some((allowed) => allowed === path)) throw new Error(`unknown geometry authority request: ${path}`);
    reads.push(path);
    const raw = physical(path).toString("utf8");
    return path === changed ? `${raw}\n// reader-channel corruption\n` : raw;
  };
  return {
    reads,
    reader,
    change: (path: string) => {
      changed = path;
    },
  };
}
function assertRefusal(call: () => unknown, message: string): void {
  let error: unknown;
  try {
    call();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
}
const prefix = "lowering analysis relocation: ";

describe("issue-6920 finite Linear geometry source proof", () => {
  afterAll(() => authenticateInputs());

  it("GP01 physical current capture reads five authorities and proves all eight views", () => {
    const f = fixture();
    assertView(capture(actualPlanner, f.reader));
    expect(f.reads).toEqual(readOrder);
  });

  it("GP02 repeated healthy captures return fresh frozen objects", () => {
    const first = fixture();
    const second = fixture();
    const a = capture(actualPlanner, first.reader);
    const b = capture(actualPlanner, second.reader);
    assertView(a);
    assertView(b);
    expect(a).not.toBe(b);
    expect(first.reads).toEqual(readOrder);
    expect(second.reads).toEqual(readOrder);
  });

  it("GP03 default physical reader proves the genuine donor", () => {
    assertView(capture(actualPlanner));
  });

  it("GP04 healthy mutable reader captures fresh current authority on each call", () => {
    const f = fixture();
    const first = capture(actualPlanner, f.reader);
    assertView(first);
    expect(f.reads).toEqual(readOrder);
    f.reads.length = 0;
    const second = capture(actualPlanner, f.reader);
    assertView(second);
    expect(first).not.toBe(second);
    expect(f.reads).toEqual(readOrder);
  });

  it("GP05 supplied planner mutant refuses despite healthy physical authority", () => {
    const f = fixture();
    assertRefusal(
      () => capture(`${actualPlanner}\n// supplied corruption\n`, f.reader),
      `${prefix}supplied current geometry source differs ${plannerPath}`,
    );
    expect(f.reads).toEqual(readOrder.slice(0, 2));
  });

  it("GP06 layout reader mutant refuses at the complete current layout pin", () => {
    const f = fixture();
    f.change(layoutPath);
    assertRefusal(() => capture(actualPlanner, f.reader), `${prefix}full pin changed ${layoutPath}`);
    expect(f.reads).toEqual(readOrder.slice(0, 3));
  });

  it("GP07 shared owner reader mutant refuses at the complete shared pin", () => {
    const f = fixture();
    f.change(sharedPath);
    assertRefusal(() => capture(actualPlanner, f.reader), `${prefix}full pin changed ${sharedPath}`);
    expect(f.reads).toEqual(readOrder.slice(0, 4));
  });

  it("GP08 geometry receipt reader mutant refuses before source reads", () => {
    const f = fixture();
    f.change(receiptPath);
    assertRefusal(() => capture(actualPlanner, f.reader), `${prefix}full pin changed ${receiptPath}`);
    expect(f.reads).toEqual([receiptPath]);
  });

  it("GP09 old relocation receipt reader mutant reaches the unchanged old proof", () => {
    const f = fixture();
    f.change(oldReceiptPath);
    assertRefusal(() => capture(actualPlanner, f.reader), `${prefix}full pin changed ${oldReceiptPath}`);
    expect(f.reads).toEqual(readOrder);
  });

  it("GP10 healthy then changed same reader refuses without a success cache", () => {
    const f = fixture();
    assertView(capture(actualPlanner, f.reader));
    expect(f.reads).toEqual(readOrder);
    f.reads.length = 0;
    f.change(sharedPath);
    assertRefusal(() => capture(actualPlanner, f.reader), `${prefix}full pin changed ${sharedPath}`);
    expect(f.reads).toEqual(readOrder.slice(0, 4));
  });

  it("GP11 boxed source refuses before authority IO", () => {
    const f = fixture();
    assertRefusal(
      () => capture(new String(actualPlanner) as unknown as string, f.reader),
      `${prefix}primitive source required`,
    );
    expect(f.reads).toEqual([]);
  });

  it("GP12 null source refuses before authority IO", () => {
    const f = fixture();
    assertRefusal(() => capture(null as unknown as string, f.reader), `${prefix}primitive source required`);
    expect(f.reads).toEqual([]);
  });

  it("GP13 numeric source refuses before authority IO", () => {
    const f = fixture();
    assertRefusal(() => capture(7 as unknown as string, f.reader), `${prefix}primitive source required`);
    expect(f.reads).toEqual([]);
  });

  it("GP14 noncallable reader refuses before authority IO", () => {
    const f = fixture();
    assertRefusal(() => capture(actualPlanner, {} as typeof f.reader), `${prefix}authority reader must be a function`);
    expect(f.reads).toEqual([]);
  });

  it("GP15 primitive source priority precedes noncallable reader validation", () => {
    const f = fixture();
    assertRefusal(
      () => capture(null as unknown as string, {} as typeof f.reader),
      `${prefix}primitive source required`,
    );
    expect(f.reads).toEqual([]);
  });
});

// Unknown-path and forward-only/deep-coverage mutants are not separately
// observable through this authenticated fixed public API. They are not credited
// to these outer-channel controls; ROOT owns the original deep preservation suite.
