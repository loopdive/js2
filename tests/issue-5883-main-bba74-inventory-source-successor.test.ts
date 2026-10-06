// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Fixed witnesses authored from Git tree 3b37a9a1 and blobs 109e1bab21 / 2d69c0400d.
// On an old checkout only, forward replay supplies a preview fixture, NOT merged-main execution evidence.
// Runtime acquisition is physical source + fixed witnesses; there is no Git fallback.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  capture5883InventoryCheckpointPolicySource,
  capture5883InventoryPredecessorPolicy,
  capture5883InventoryPredecessorPolicySource,
} from "./helpers/ir-5883-inventory-source-successor.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";

const expected = {
  schema: "fixed-pr5883-main-bba74-inventory-source-successor-v1",
  coordinateUnit: "utf8-byte",
  sourcePath: "scripts/compiler-boundaries.json",
  main: "bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1",
  previewTree: "3b37a9a1e7a28e6b1b30fb6c3b25f48768b53844",
  checkpoint: "884d2fc58f40a28c391ef5cf238b49582329e55b",
  before: {
    source: {
      bytes: 590105,
      sha256: "29f555ed9afe384c0cf7d3bfe45115083eb42d5445d1f6c983f85aaa6424bad9",
      gitBlob: "2d69c0400d7d42a5d8d4103ada085a071bb00a37",
    },
    dataSha256: "faae7f2cc8a2e0c15f7ec7966789ea0e8f3a2597120a428d3cce4673d82b1265",
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
    movesCount: 15,
    movesSha256: "dee1f3da0891e29bfb95534a899b3f5da31dae05c45d3a35be7123115e1466b4",
    filesCount: 1841,
    filesSha256: "e47ea0d0ca1a99541dcd287186f5f187f7e1f270c0f4fb9b8c42ca37d8386d61",
    retainedSha256: "dd91458d637f35a7ad9ac9c3a0663e34fd4e0fa9dc6e4786b3b8fa716e1afa12",
  },
  current: {
    source: {
      bytes: 590751,
      sha256: "491fc3c8e470a5a4c58da8e7d78cd24ab3a2cd18d7ce6bcccf279d927c0ea942",
      gitBlob: "109e1bab21c7ffdf936e8d2d2208c22e31ef77dd",
    },
    dataSha256: "2c3a9c757d9068dc2701f269bf3df3bccf645e0046c7b05db4ac723dbc6c0ac7",
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
    movesCount: 15,
    movesSha256: "dee1f3da0891e29bfb95534a899b3f5da31dae05c45d3a35be7123115e1466b4",
    filesCount: 1843,
    filesSha256: "a246e8bb1d23b73af9320d9baa55394de0c8ba29e870c92076a234929ab32957",
    retainedSha256: "dd91458d637f35a7ad9ac9c3a0663e34fd4e0fa9dc6e4786b3b8fa716e1afa12",
  },
  additions: [
    {
      field: "files",
      index: 984,
      rows: [
        {
          path: "src/codegen/statements/finally-private-local.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "5267",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      ],
      previous: {
        path: "src/codegen/statements/exceptions.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/statements/finally-ran-guard.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1652,
      rows: [
        {
          path: "src/codegen/classes/externref-class-fields.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      ],
      previous: {
        path: "src/codegen/error-subclass-proto-chain.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/class-proto-toplevel-write.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  rawSpans: [
    {
      beforeOffset: 364890,
      afterOffset: 364890,
      before: "",
      after:
        '    {\n      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    },
    {
      beforeOffset: 544525,
      afterOffset: 544843,
      before: "",
      after:
        '    {\n      "path": "src/codegen/classes/externref-class-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    },
  ],
} as const;
const mainReceiptPath = "tests/helpers/ir-5883-main-bba74-inventory-source-successor.json";
const oldReceiptPath = "tests/helpers/ir-5883-inventory-source-successor.json";
const mainReceiptPin = { bytes: 5514, sha256: "18c1fdee2a7d8c56ed9c1dcea6c6fe2624eec568181e4f27fdd3e924b80f1c18" };
const oldReceiptPin = { bytes: 8642, sha256: "dae4ccaa122c9b406f136d71a89e613e80d677392cc5ddd9456c90424316bba6" };
const predecessorPin = {
  bytes: 588351,
  sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
  gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
};
const historicalPin = {
  bytes: 584712,
  sha256: "c71c9f9a61cebf84bff0f75f26fcd271265e53c83a66f59ed416e1cbc1675209",
  gitBlob: "2a85037d2b4ffa2dd93aff1fa4080581e48a8c88",
};
type Policy = Record<string, any> & { moves: Record<string, any>[]; files: Record<string, any>[] };
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
function sourcePin(raw: string) {
  const bytes = Buffer.from(raw);
  return {
    bytes: bytes.length,
    sha256: sha(bytes),
    gitBlob: createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex"),
  };
}
function fullProfile(raw: string, which: "before" | "current") {
  const value = JSON.parse(raw) as Policy,
    pin = expected[which];
  expect(sourcePin(raw)).toEqual(pin.source);
  expect(Object.keys(value)).toEqual(pin.topLevelKeys);
  expect(sha(JSON.stringify(value))).toBe(pin.dataSha256);
  expect(value.moves).toHaveLength(pin.movesCount);
  expect(sha(JSON.stringify(value.moves))).toBe(pin.movesSha256);
  expect(value.files).toHaveLength(pin.filesCount);
  expect(sha(JSON.stringify(value.files))).toBe(pin.filesSha256);
  expect(
    sha(
      JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "moves" && key !== "files"))),
    ),
  ).toBe(pin.retainedSha256);
  return value;
}
function inverse(raw: string, spans: readonly { afterOffset: number; after: string }[]): string {
  let bytes = Buffer.from(raw);
  for (const span of [...spans].reverse()) {
    const end = span.afterOffset + Buffer.byteLength(span.after);
    expect(bytes.subarray(span.afterOffset, end).toString("utf8")).toBe(span.after);
    bytes = Buffer.concat([bytes.subarray(0, span.afterOffset), bytes.subarray(end)]);
  }
  return bytes.toString("utf8");
}
function forward(raw: string): string {
  let bytes = Buffer.from(raw);
  for (const span of [...expected.rawSpans].reverse())
    bytes = Buffer.concat([
      bytes.subarray(0, span.beforeOffset),
      Buffer.from(span.after),
      bytes.subarray(span.beforeOffset),
    ]);
  return bytes.toString("utf8");
}
function witness() {
  const physical = read("scripts/compiler-boundaries.json");
  const pin = sourcePin(physical);
  let current: string, checkpoint: string;
  if (JSON.stringify(pin) === JSON.stringify(expected.current.source)) {
    current = physical;
    checkpoint = inverse(current, expected.rawSpans);
  } else {
    expect(pin).toEqual(expected.before.source);
    checkpoint = physical;
    current = forward(checkpoint);
  }
  const input = fullProfile(current, "current"),
    prior = fullProfile(checkpoint, "before");
  expect(inverse(current, expected.rawSpans)).toBe(checkpoint);
  expect(forward(checkpoint)).toBe(current);
  const semantic = structuredClone(input);
  for (const group of expected.additions) {
    expect(input.files.slice(group.index, group.index + group.rows.length)).toEqual(group.rows);
    expect(input.files[group.index - 1]).toEqual(group.previous);
    expect(input.files[group.index + group.rows.length]).toEqual(group.next);
  }
  for (const group of [...expected.additions].reverse()) semantic.files.splice(group.index, group.rows.length);
  expect(semantic).toEqual(prior);
  const replay = structuredClone(prior);
  for (const group of expected.additions) replay.files.splice(group.index, 0, ...structuredClone(group.rows));
  expect(replay).toEqual(input);
  const originalReceipt = read(oldReceiptPath);
  expect(Buffer.byteLength(originalReceipt)).toBe(oldReceiptPin.bytes);
  expect(sha(originalReceipt)).toBe(oldReceiptPin.sha256);
  const original = inverse(checkpoint, JSON.parse(originalReceipt).rawSpans);
  expect(sourcePin(original)).toEqual(predecessorPin);
  return { current, checkpoint, input, prior, original, predecessor: JSON.parse(original) as Policy };
}
function healthy() {
  const w = witness();
  expect(capture5883InventoryCheckpointPolicySource(w.current)).toBe(w.checkpoint);
  expect(capture5883InventoryPredecessorPolicySource(w.current)).toBe(w.original);
  expect(capture5883InventoryPredecessorPolicy(w.input)).toEqual(w.predecessor);
  return w;
}
function reject(value: Policy) {
  expect(() => capture5883InventoryPredecessorPolicy(value)).toThrow("complete policy profile mismatch");
  expect(() => capture5883InventoryPredecessorPolicySource(JSON.stringify(value))).toThrow(
    "complete raw source profile mismatch",
  );
}
afterEach(async () => {
  await setImmediate();
});

describe("PR5883 exact bba74 main two-row source preservation", () => {
  it("independently pins full raw and semantic profiles, two exact rows, neighbors and spans", () => {
    const raw = read(mainReceiptPath);
    expect(Buffer.byteLength(raw)).toBe(mainReceiptPin.bytes);
    expect(sha(raw)).toBe(mainReceiptPin.sha256);
    expect(JSON.parse(raw)).toEqual(expected);
    expect(expected.additions).toHaveLength(2);
    expect(expected.rawSpans).toHaveLength(2);
    expect(expected.current.filesCount - expected.before.filesCount).toBe(2);
    expect(expected.current.movesSha256).toBe(expected.before.movesSha256);
    expect(expected.current.retainedSha256).toBe(expected.before.retainedSha256);
    healthy();
  });
  it("proves exact two-row inverse and forward byte replay and semantic equality", () => {
    const w = healthy();
    expect(inverse(w.current, expected.rawSpans)).toBe(w.checkpoint);
    expect(forward(w.checkpoint)).toBe(w.current);
    expect(capture5883InventoryCheckpointPolicySource(w.checkpoint)).toBe(w.checkpoint);
  });
  it("composes new raw and semantic sources through both unchanged historical domains", () => {
    const w = healthy();
    const raw = captureMainInventoryPredecessorPolicySource(capture5883InventoryPredecessorPolicySource(w.current));
    expect(sourcePin(raw)).toEqual(historicalPin);
    const semantic = captureMainInventoryPredecessorPolicy(capture5883InventoryPredecessorPolicy(w.input));
    expect(semantic).toEqual(JSON.parse(raw));
    expect(sha(JSON.stringify(semantic))).toBe("7975101a306d4746f3431244115981fa1824bc558a4b563c2a55288ab457591c");
  });
  it("keeps exact old source behavior and old receipt read trace without reading the new receipt", () => {
    const w = healthy(),
      trace: string[] = [];
    const reader = (path: string) => {
      trace.push(path);
      return read(path);
    };
    expect(capture5883InventoryPredecessorPolicySource(w.checkpoint, reader)).toBe(w.original);
    expect(capture5883InventoryPredecessorPolicy(w.prior, reader)).toEqual(w.predecessor);
    expect(capture5883InventoryCheckpointPolicySource(w.checkpoint, reader)).toBe(w.checkpoint);
    expect(trace).toEqual(Array(3).fill(oldReceiptPath));
  });
  it("restricts checkpoint projection to exact old or new raw profiles", () => {
    const w = healthy();
    for (const raw of [w.original, w.current + "\n", w.checkpoint + "\n", JSON.stringify(w.input), "null"])
      expect(() => capture5883InventoryCheckpointPolicySource(raw)).toThrow("complete raw source profile mismatch");
    healthy();
  });
  it("detaches a frozen new-profile operand without changing retained input", () => {
    const w = healthy(),
      original = JSON.stringify(w.input);
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(w.input);
    const result = capture5883InventoryPredecessorPolicy(w.input) as Policy;
    expect(result).toEqual(w.predecessor);
    expect(result.files).not.toBe(w.input.files);
    expect(result.files[0]).not.toBe(w.input.files[0]);
    result.files[0].path += ".detached";
    expect(JSON.stringify(w.input)).toBe(original);
  });
  for (const group of expected.additions) {
    it("rejects main file row " + group.index + " property order", () => {
      const w = healthy(),
        data = structuredClone(w.input);
      data.files[group.index] = Object.fromEntries(Object.entries(data.files[group.index]).reverse());
      reject(data);
      healthy();
    });
    for (const mutation of ["remove", "duplicate", "relocate", "change"] as const) {
      it("rejects main file row " + group.index + " " + mutation + " in both domains", () => {
        const w = healthy(),
          data = structuredClone(w.input),
          index = group.index;
        if (mutation === "remove") data.files.splice(index, 1);
        if (mutation === "duplicate") data.files.splice(index, 0, structuredClone(data.files[index]));
        if (mutation === "relocate") data.files.push(...data.files.splice(index, 1));
        if (mutation === "change") data.files[index].path += ".altered";
        reject(data);
        healthy();
      });
    }
    for (const key of ["path", "state", "layer", "destination", "owner", "nextBoundary"] as const) {
      it("rejects main file row " + group.index + " property " + key, () => {
        const w = healthy(),
          data = structuredClone(w.input);
        data.files[group.index][key] += " altered";
        reject(data);
        healthy();
      });
    }
    for (const side of ["previous", "next"] as const) {
      it("rejects main file row " + group.index + " neighbor " + side, () => {
        const w = healthy(),
          data = structuredClone(w.input);
        data.files[group.index + (side === "previous" ? -1 : 1)].path += ".altered";
        reject(data);
        healthy();
      });
    }
  }
  for (const mutation of [
    "moves",
    "evidence",
    "description",
    "retained file",
    "property order",
    "extra top key",
  ] as const) {
    it("rejects main retained " + mutation, () => {
      const w = healthy();
      let data = structuredClone(w.input);
      if (mutation === "moves") data.moves.reverse();
      if (mutation === "evidence") data.evidence[0].symbols.pop();
      if (mutation === "description") data.description += " altered";
      if (mutation === "retained file") data.files[0].path += ".altered";
      if (mutation === "property order") data = Object.fromEntries(Object.entries(data).reverse()) as Policy;
      if (mutation === "extra top key") data.extra = true;
      reject(data);
      healthy();
    });
  }
  for (const [index, span] of expected.rawSpans.entries()) {
    for (const mutation of ["remove", "duplicate", "relocate", "change"] as const) {
      it("rejects main raw span " + index + " " + mutation, () => {
        const w = healthy(),
          bytes = Buffer.from(w.current),
          at = span.afterOffset,
          end = at + Buffer.byteLength(span.after);
        const without = Buffer.concat([bytes.subarray(0, at), bytes.subarray(end)]);
        const mutant =
          mutation === "remove"
            ? without
            : mutation === "duplicate"
              ? Buffer.concat([bytes.subarray(0, at), Buffer.from(span.after), bytes.subarray(at)])
              : mutation === "relocate"
                ? Buffer.concat([without, Buffer.from(span.after)])
                : Buffer.concat([
                    bytes.subarray(0, at),
                    Buffer.from(span.after.replace(".ts", ".tx")),
                    bytes.subarray(end),
                  ]);
        expect(() => capture5883InventoryPredecessorPolicySource(mutant.toString())).toThrow(
          "complete raw source profile mismatch",
        );
        expect(() => capture5883InventoryCheckpointPolicySource(mutant.toString())).toThrow(
          "complete raw source profile mismatch",
        );
        healthy();
      });
    }
  }
  it("rejects main raw whitespace and swapped rows while preserving semantic serialization parity", () => {
    const w = healthy();
    expect(capture5883InventoryPredecessorPolicy(JSON.parse(JSON.stringify(w.input)))).toEqual(w.predecessor);
    for (const raw of [w.current + "\n", JSON.stringify(w.input)])
      expect(() => capture5883InventoryPredecessorPolicySource(raw)).toThrow("complete raw source profile mismatch");
    const data = structuredClone(w.input),
      [a, b] = expected.additions;
    [data.files[a.index], data.files[b.index]] = [data.files[b.index], data.files[a.index]];
    reject(data);
    healthy();
  });
  for (const field of [
    "before",
    "current",
    "additions",
    "rawSpans",
    "coordinateUnit",
    "sourcePath",
    "main",
    "previewTree",
  ] as const) {
    it("rejects corrupt main receipt metadata " + field + " after a healthy call", () => {
      const w = healthy(),
        changed = JSON.parse(read(mainReceiptPath));
      changed[field] = null;
      const reader = (path: string) => (path === mainReceiptPath ? JSON.stringify(changed) : read(path));
      expect(() => capture5883InventoryPredecessorPolicySource(w.current, reader)).toThrow(
        "fixed receipt pin mismatch",
      );
      expect(() => capture5883InventoryPredecessorPolicy(w.input, reader)).toThrow("fixed receipt pin mismatch");
      expect(() => capture5883InventoryCheckpointPolicySource(w.current, reader)).toThrow("fixed receipt pin mismatch");
      healthy();
    });
  }
  for (const mode of ["raw", "semantic", "projection"] as const) {
    it(mode + " reauthenticates both receipts behind the same reader after success and restoration", () => {
      const w = healthy(),
        trace: string[] = [];
      let corrupt: string | undefined;
      const reader = (path: string) => {
        trace.push(path);
        const raw = read(path);
        return path === corrupt ? raw + "\n" : raw;
      };
      const run = () =>
        mode === "raw"
          ? capture5883InventoryPredecessorPolicySource(w.current, reader)
          : mode === "semantic"
            ? capture5883InventoryPredecessorPolicy(w.input, reader)
            : capture5883InventoryCheckpointPolicySource(w.current, reader);
      const result = mode === "raw" ? w.original : mode === "semantic" ? w.predecessor : w.checkpoint;
      expect(run()).toEqual(result);
      expect(trace.splice(0)).toEqual([oldReceiptPath, mainReceiptPath]);
      for (const path of [mainReceiptPath, oldReceiptPath]) {
        corrupt = path;
        expect(run).toThrow("fixed receipt pin mismatch");
        expect(trace.splice(0)).toEqual(
          path === mainReceiptPath ? [oldReceiptPath, mainReceiptPath] : [oldReceiptPath],
        );
        corrupt = undefined;
        expect(run()).toEqual(result);
        expect(trace.splice(0)).toEqual([oldReceiptPath, mainReceiptPath]);
      }
    });
  }
  for (const mode of ["raw", "projection"] as const) {
    for (const kind of ["boxed", "number", "null", "undefined", "array", "object", "symbol"] as const) {
      it("guards main " + mode + " " + kind + " before authority IO and coercion", () => {
        const w = healthy();
        let reads = 0,
          coercions = 0;
        const values: Record<string, unknown> = {
          boxed: new String(w.current),
          number: 1,
          null: null,
          undefined,
          array: [],
          object: {},
          symbol: Symbol(),
        };
        const value = values[kind];
        if (value && typeof value === "object")
          Object.defineProperty(value, Symbol.toPrimitive, {
            value: () => {
              coercions++;
              return w.current;
            },
          });
        const reader = () => {
          reads++;
          throw new Error("missing main authority");
        };
        const capture =
          mode === "raw" ? capture5883InventoryPredecessorPolicySource : capture5883InventoryCheckpointPolicySource;
        expect(() => capture(value as string, reader)).toThrow("raw input must be a primitive string");
        expect(reads).toBe(0);
        expect(coercions).toBe(0);
        expect(() => capture(w.current, reader)).toThrow("missing main authority");
        expect(reads).toBe(1);
      });
    }
  }
  for (const kind of ["primitive", "top getter", "row getter", "array getter", "sparse"] as const) {
    it("guards main semantic " + kind + " before authority IO and getter execution", () => {
      const w = healthy();
      let value: unknown = structuredClone(w.input),
        reads = 0,
        getters = 0;
      const data = value as Policy,
        getter = () => {
          getters++;
          return "not evaluated";
        };
      if (kind === "primitive") value = 1;
      if (kind === "top getter") Object.defineProperty(data, "description", { enumerable: true, get: getter });
      if (kind === "row getter") Object.defineProperty(data.files[984], "path", { enumerable: true, get: getter });
      if (kind === "array getter") Object.defineProperty(data.files, "984", { enumerable: true, get: getter });
      if (kind === "sparse") expect(Reflect.deleteProperty(data.files, "984")).toBe(true);
      const reader = () => {
        reads++;
        throw new Error("missing main authority");
      };
      expect(() => capture5883InventoryPredecessorPolicy(value, reader)).toThrow(/PR5883 inventory source successor:/);
      expect(reads).toBe(0);
      expect(getters).toBe(0);
      expect(() => capture5883InventoryPredecessorPolicy(w.input, reader)).toThrow("missing main authority");
      expect(reads).toBe(1);
      expect(getters).toBe(0);
    });
  }
});
