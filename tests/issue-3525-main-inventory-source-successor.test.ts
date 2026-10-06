// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent test-only policy-source proof, not compiler or runtime acceptance.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { captureArrayBufferIsViewMainPredecessorPolicy } from "./helpers/ir-runtime-program-policy-evolution.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";

// Independently derived from authentic Git blob 2a85037d and actual f02 policy.
// No production inverse supplies these literal rows, coordinates or full pins.
const expected = {
  before: {
    bytes: 584712,
    sha256: "c71c9f9a61cebf84bff0f75f26fcd271265e53c83a66f59ed416e1cbc1675209",
    gitBlob: "2a85037d2b4ffa2dd93aff1fa4080581e48a8c88",
    fileCount: 1826,
    dataSha256: "7975101a306d4746f3431244115981fa1824bc558a4b563c2a55288ab457591c",
    filesSha256: "5e1616a98a054c70dcde26118598dbbd66eed02747f48c76e024cf64f9279e6b",
    rootWithoutFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  },
  current: {
    bytes: 588351,
    sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
    gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
    fileCount: 1837,
    dataSha256: "56532a3cda4a9a8ec083fc0ebb7d38300fe754dd8f7cc4d49c20784ae77f05e0",
    filesSha256: "fdd1e7da8bc2decab20f41771aa30b724a3ecda1929f590f286e2f530171be9c",
    rootWithoutFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  },
  topLevelKeys: [
    "schema",
    "description",
    "sourceRoot",
    "tsconfig",
    "requireGitProvenance",
    "externalAssets",
    "frontendWrapper",
    "moduleExtensions",
    "layers",
    "allowedEdges",
    "externalPackages",
    "activationHistory",
    "nonModules",
    "moves",
    "evidence",
    "files",
  ],
  spans: [
    {
      beforeOffset: 71486,
      afterOffset: 71486,
      before: "",
      after:
        '    },\n    {\n      "path": "src/codegen/expressions/apply-dynamic-arglist.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n',
    },
    {
      beforeOffset: 284587,
      afterOffset: 284918,
      before: "",
      after:
        '      "path": "src/codegen/object-model/native-carrier-get-prototype.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 288850,
      afterOffset: 289520,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/runtime-key-open-object.ts",\n',
    },
    {
      beforeOffset: 332019,
      afterOffset: 333023,
      before: "",
      after:
        '      "path": "src/codegen/object-model/proxy-get-iterator.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 358290,
      afterOffset: 359623,
      before: "",
      after:
        '      "path": "src/codegen/classes/standalone-collection-carrier.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 361580,
      afterOffset: 363248,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/statements/finally-ran-guard.ts",\n',
    },
    {
      beforeOffset: 495010,
      afterOffset: 497004,
      before: "",
      after:
        '      "path": "src/intl-listformat-prelude.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n    {\n',
    },
    {
      beforeOffset: 562816,
      afterOffset: 565116,
      before: "",
      after:
        '      "path": "src/codegen/analysis/async-leading-await-replay.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/analysis/async-for-of-region.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/node-builtin-named-import.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/vec-callback-method-host-delegation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
  ],
  added: [
    {
      index: 1,
      row: {
        path: "src/codegen/expressions/apply-dynamic-arglist.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 739,
      row: {
        path: "src/codegen/object-model/native-carrier-get-prototype.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 754,
      row: {
        path: "src/codegen/object-model/runtime-key-open-object.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 886,
      row: {
        path: "src/codegen/object-model/proxy-get-iterator.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 969,
      row: {
        path: "src/codegen/classes/standalone-collection-carrier.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 981,
      row: {
        path: "src/codegen/statements/finally-ran-guard.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1406,
      row: {
        path: "src/intl-listformat-prelude.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
    },
    {
      index: 1717,
      row: {
        path: "src/codegen/analysis/async-leading-await-replay.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1718,
      row: {
        path: "src/codegen/analysis/async-for-of-region.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1719,
      row: {
        path: "src/codegen/expressions/node-builtin-named-import.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1720,
      row: {
        path: "src/codegen/expressions/vec-callback-method-host-delegation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
} as const;
const root = resolve(import.meta.dirname, "..");
const sourcePath = "scripts/compiler-boundaries.json";
const receiptPath = "tests/helpers/ir-main-inventory-source-successor.json";
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown> & { path: string };
type Policy = Record<string, unknown> & { files: Row[] };
function profile(value: Policy, which: "current" | "before") {
  const pin = expected[which];
  expect(Object.keys(value)).toEqual(expected.topLevelKeys);
  expect(value.files).toHaveLength(pin.fileCount);
  expect(sha(JSON.stringify(value))).toBe(pin.dataSha256);
  expect(sha(JSON.stringify(value.files))).toBe(pin.filesSha256);
  expect(sha(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "files"))))).toBe(
    pin.rootWithoutFilesSha256,
  );
}
function independentRawBefore(current: string): string {
  expect(Buffer.byteLength(current)).toBe(expected.current.bytes);
  expect(sha(current)).toBe(expected.current.sha256);
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const span of expected.spans) {
    expect(span.before).toBe("");
    expect(bytes.subarray(span.afterOffset, span.afterOffset + Buffer.byteLength(span.after)).toString("utf8")).toBe(
      span.after,
    );
    parts.push(bytes.subarray(cursor, span.afterOffset), Buffer.from(span.before));
    cursor = span.afterOffset + Buffer.byteLength(span.after);
  }
  parts.push(bytes.subarray(cursor));
  const before = Buffer.concat(parts).toString("utf8");
  expect(Buffer.byteLength(before)).toBe(expected.before.bytes);
  expect(sha(before)).toBe(expected.before.sha256);
  const old = Buffer.from(before),
    replay: Buffer[] = [];
  cursor = 0;
  for (const span of expected.spans) {
    replay.push(old.subarray(cursor, span.beforeOffset), Buffer.from(span.after));
    cursor = span.beforeOffset;
  }
  replay.push(old.subarray(cursor));
  expect(Buffer.concat(replay).toString("utf8")).toBe(current);
  return before;
}
function independentPolicyBefore(current: Policy): Policy {
  profile(current, "current");
  const indices = new Set<number>();
  for (const { index, row } of expected.added) {
    expect(current.files[index]).toEqual(row);
    indices.add(index);
  }
  const before = { ...current, files: current.files.filter((_row, index) => !indices.has(index)) };
  profile(before, "before");
  return before;
}
function authorityReader() {
  const trace: string[] = [];
  return {
    trace,
    read: (path: string): string => {
      trace.push(path);
      return read(path);
    },
  };
}
function healthy() {
  const receipt = read(receiptPath),
    helper = read("tests/helpers/ir-main-inventory-source-successor.ts");
  expect(Buffer.byteLength(receipt)).toBe(18373);
  expect(sha(receipt)).toBe("06a6fcd2df50e87b1cd14d684db90e31e221bb9f001f52f2e5158720a93f50ef");
  expect(Buffer.byteLength(helper)).toBe(20834);
  expect(sha(helper)).toBe("41012f3d03e1521eb217c94996c542ae84b3de1410b2cf6c6744319c5da64b86");
  const current = read(sourcePath),
    before = independentRawBefore(current),
    input = JSON.parse(current) as Policy;
  const sourceAuthority = authorityReader(),
    semanticAuthority = authorityReader();
  expect(captureMainInventoryPredecessorPolicySource(current, sourceAuthority.read)).toBe(before);
  expect(captureMainInventoryPredecessorPolicy(input, semanticAuthority.read)).toEqual(independentPolicyBefore(input));
  expect(sourceAuthority.trace).toEqual([receiptPath]);
  expect(semanticAuthority.trace).toEqual([receiptPath]);
  return { current, before, input };
}
function freezeGraph(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) freezeGraph(descriptor.value);
  Object.freeze(value);
}

describe("fixed main inventory source successor independent proof", () => {
  it("independently binds all eight source insertions and eleven exact rows with full before/current replay", () => {
    const { current, before, input } = healthy();
    expect(expected.spans).toHaveLength(8);
    expect(expected.added).toHaveLength(11);
    expect(JSON.parse(before)).toEqual(independentPolicyBefore(input));
    console.info(
      "main inventory proof-only",
      JSON.stringify({
        currentBytes: Buffer.byteLength(current),
        historicalBytes: Buffer.byteLength(before),
        currentRows: input.files.length,
        historicalRows: JSON.parse(before).files.length,
        spans: expected.spans.length,
        addedRows: expected.added.length,
      }),
    );
  });
  it("preserves every retained field and row, detaches output and leaves a frozen actual operand unchanged", () => {
    const { input } = healthy();
    const retained = JSON.stringify(input),
      expectedBefore = independentPolicyBefore(input);
    freezeGraph(input);
    const result = captureMainInventoryPredecessorPolicy(input) as Policy;
    expect(result).toEqual(expectedBefore);
    expect(result).not.toBe(input);
    for (const key of expected.topLevelKeys) if (key !== "files") expect(result[key]).toEqual(input[key]);
    expect(result.files).not.toBe(input.files);
    for (let index = 0; index < result.files.length; index++)
      expect(result.files[index]).not.toBe(expectedBefore.files[index]);
    expect(JSON.stringify(input)).toBe(retained);
  });
  for (const kind of ["tail edit", "changed retained field", "already historical operand"] as const)
    it(`refuses raw ${kind} after healthy capture and observes exact restoration`, () => {
      const witness = healthy();
      const data = JSON.parse(witness.current);
      data.description += " mutant";
      const mutant =
        kind === "tail edit"
          ? witness.current + "\n"
          : kind === "changed retained field"
            ? JSON.stringify(data)
            : witness.before;
      expect(() => captureMainInventoryPredecessorPolicySource(mutant)).toThrow(/complete raw source profile mismatch/);
      healthy();
    });
  for (const [name, mutate] of [
    [
      "omitted added row",
      (data) => {
        data.files.splice(expected.added[0].index, 1);
      },
    ],
    [
      "duplicated added row",
      (data) => {
        data.files.splice(expected.added[0].index, 0, structuredClone(data.files[expected.added[0].index]));
      },
    ],
    [
      "changed added row owner",
      (data) => {
        data.files[expected.added[0].index].owner = "other";
      },
    ],
    [
      "changed retained row path",
      (data) => {
        data.files[0].path += ".mutant";
      },
    ],
    [
      "reordered current rows",
      (data) => {
        [data.files[0], data.files[1]] = [data.files[1], data.files[0]];
      },
    ],
    [
      "changed retained top-level field",
      (data) => {
        data.description = "mutant";
      },
    ],
    [
      "unexpected top-level field",
      (data) => {
        data.unrelated = true;
      },
    ],
  ] satisfies [string, (data: Policy) => void][])
    it(`refuses semantic ${name} between genuine healthy captures`, () => {
      const { input } = healthy();
      mutate(input);
      expect(() => captureMainInventoryPredecessorPolicy(input)).toThrow(/complete policy profile mismatch/);
      healthy();
    });
  for (const kind of ["top-level getter", "row getter", "array element getter", "sparse array"] as const)
    it(`refuses ${kind} before authority IO or getter execution`, () => {
      const { input } = healthy();
      let calls = 0;
      if (kind === "top-level getter") {
        const value = input.files;
        Object.defineProperty(input, "files", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "row getter") {
        const value = input.files[0].owner;
        Object.defineProperty(input.files[0], "owner", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "array element getter") {
        const value = input.files[3];
        Object.defineProperty(input.files, "3", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "sparse array") Reflect.deleteProperty(input.files, "3");
      const authority = authorityReader();
      expect(() => captureMainInventoryPredecessorPolicy(input, authority.read)).toThrow();
      expect(calls).toBe(0);
      expect(authority.trace).toEqual([]);
      healthy();
    });
  for (const lane of ["raw", "semantic"] as const)
    it(`rejects boxed ${lane} data without coercion or authority IO`, () => {
      const { current } = healthy();
      let calls = 0;
      const boxed = Object(current);
      Object.defineProperty(boxed, Symbol.toPrimitive, {
        get() {
          calls++;
          return () => {
            calls++;
            return current;
          };
        },
      });
      const authority = authorityReader();
      expect(() =>
        lane === "raw"
          ? captureMainInventoryPredecessorPolicySource(boxed as string, authority.read)
          : captureMainInventoryPredecessorPolicy(boxed, authority.read),
      ).toThrow();
      expect(calls).toBe(0);
      expect(authority.trace).toEqual([]);
      healthy();
    });
  for (const kind of ["corrupt", "missing"] as const)
    it(`refuses a physically ${kind} fixed receipt after warm capture and restores exact original bytes`, () => {
      const witness = healthy();
      const path = resolve(root, receiptPath),
        original = readFileSync(path),
        originalHash = sha(original);
      const scratchRoot = resolve(root, ".tmp", "main-inventory-authority-faults");
      mkdirSync(scratchRoot, { recursive: true });
      const directory = mkdtempSync(resolve(scratchRoot, "proof-")),
        backup = resolve(directory, "receipt-original.json");
      let moved = false;
      try {
        if (kind === "missing") {
          renameSync(path, backup);
          moved = true;
        } else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
        expect(() => captureMainInventoryPredecessorPolicySource(witness.current)).toThrow(
          kind === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
        );
        expect(() => captureMainInventoryPredecessorPolicy(witness.input)).toThrow(
          kind === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
        );
      } finally {
        if (moved) renameSync(backup, path);
        else writeFileSync(path, original);
        expect(sha(readFileSync(path))).toBe(originalHash);
        expect(readFileSync(path)).toEqual(original);
        rmSync(directory, { recursive: true, force: true });
      }
      healthy();
    });
});

describe("main inventory successor legacy semantic compatibility", () => {
  it("passes authentic semantic bridge output to the unchanged isView consumer with ordinary nested records", () => {
    const input = JSON.parse(read(sourcePath)) as Policy;
    const bridge = captureMainInventoryPredecessorPolicy(input) as Policy;
    profile(bridge, "before");
    const pending: unknown[] = [bridge];
    let records = 0;
    while (pending.length) {
      const value = pending.pop();
      if (value === null || typeof value !== "object") continue;
      if (!Array.isArray(value)) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        records++;
      }
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
        if ("value" in descriptor) pending.push(descriptor.value);
    }
    expect(records).toBeGreaterThan(1826);
    const legacy = captureArrayBufferIsViewMainPredecessorPolicy(bridge);
    expect(legacy.files).toHaveLength(1825);
    expect(sha(JSON.stringify(legacy))).toBe("475ebcec73e71dddd9b3cca9ec1e8c36c9e345436b3e2a7173e13da29c09427a");
    expect(sha(JSON.stringify(legacy.files))).toBe("2155c33a508f2f0177541878b0b50e4b11b5f7ccba4aceb762e90877023203a0");
    profile(bridge, "before");
    profile(input, "current");
  });
});
