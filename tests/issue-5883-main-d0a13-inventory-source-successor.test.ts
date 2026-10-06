// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent fixed witnesses authored from authenticated actual merge d81a1e9c and both policy blobs.
// Old-checkout forward replay is fixture evidence ONLY, never actual merged-main execution evidence.
// Runtime reads physical files and fixed receipts; no Git fallback.
import { capture5883Main4bffInventoryViewSource } from "./helpers/ir-5883-main-4bff-inventory-views.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  capture5883InventoryBba74PolicySource,
  capture5883InventoryCheckpointPolicySource,
  capture5883InventoryPredecessorPolicy,
  capture5883InventoryPredecessorPolicySource,
} from "./helpers/ir-5883-inventory-source-successor.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";

const expected = {
  schema: "fixed-pr5883-main-d0a13-inventory-source-successor-v1",
  coordinateUnit: "utf8-byte",
  sourcePath: "scripts/compiler-boundaries.json",
  main: "d0a13fb182e6a4e198ce34bd4ec2c489deeb10b9",
  merge: "d81a1e9c330adafebb496a7926240eda8991169f",
  mergeTree: "51d3d9b8bbbf8878e6955d9be6a040bcdc344186",
  before: {
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
  current: {
    source: {
      bytes: 591084,
      sha256: "8a8747f2771bd2aa9fa5c01233499f0d587b394d6b0e176e1889dae06900b765",
      gitBlob: "82e2c378a744f23c2ac3256ee8ceea16fe48a27e",
    },
    dataSha256: "4a199b3a38331d81420879afbb49e0312ba60539ed8a927de10951c2e51af680",
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
    filesCount: 1844,
    filesSha256: "32b10e52c025d69cef49b754d0c32c301cdb2ab51faf5b36a24d0f2393406d6a",
    retainedSha256: "dd91458d637f35a7ad9ac9c3a0663e34fd4e0fa9dc6e4786b3b8fa716e1afa12",
  },
  additions: [
    {
      field: "files",
      index: 890,
      rows: [
        {
          path: "src/codegen/object-model/proxy-forward-carriers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      ],
      previous: {
        path: "src/codegen/object-model/proxy-get-iterator.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/object-model/proxy-trap-read.ts",
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
      beforeOffset: 334729,
      afterOffset: 334729,
      before: "",
      after:
        '    {\n      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    },
  ],
} as const;
const oldPath = "tests/helpers/ir-5883-inventory-source-successor.json";
const bba74Path = "tests/helpers/ir-5883-main-bba74-inventory-source-successor.json";
const d0a13Path = "tests/helpers/ir-5883-main-d0a13-inventory-source-successor.json";
const authorityPins = {
  [oldPath]: { bytes: 8642, sha256: "dae4ccaa122c9b406f136d71a89e613e80d677392cc5ddd9456c90424316bba6" },
  [bba74Path]: { bytes: 5514, sha256: "18c1fdee2a7d8c56ed9c1dcea6c6fe2624eec568181e4f27fdd3e924b80f1c18" },
  [d0a13Path]: { bytes: 3936, sha256: "a9cae6b07573589385669cf19ac09c80642e9742b7959dcf16482c0f5e182281" },
};
const checkpointPin = {
  bytes: 590105,
  sha256: "29f555ed9afe384c0cf7d3bfe45115083eb42d5445d1f6c983f85aaa6424bad9",
  gitBlob: "2d69c0400d7d42a5d8d4103ada085a071bb00a37",
};
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
type Span = { beforeOffset: number; afterOffset: number; before: string; after: string };
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
function fixedReceipt(path: keyof typeof authorityPins) {
  const raw = read(path),
    pin = authorityPins[path];
  expect(Buffer.byteLength(raw)).toBe(pin.bytes);
  expect(sha(raw)).toBe(pin.sha256);
  return JSON.parse(raw);
}
function fullProfile(raw: string, which: "before" | "current") {
  const data = JSON.parse(raw) as Policy,
    pin = expected[which];
  expect(sourcePin(raw)).toEqual(pin.source);
  expect(Object.keys(data)).toEqual(pin.topLevelKeys);
  expect(sha(JSON.stringify(data))).toBe(pin.dataSha256);
  expect(data.moves).toHaveLength(pin.movesCount);
  expect(sha(JSON.stringify(data.moves))).toBe(pin.movesSha256);
  expect(data.files).toHaveLength(pin.filesCount);
  expect(sha(JSON.stringify(data.files))).toBe(pin.filesSha256);
  expect(
    sha(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "moves" && key !== "files")))),
  ).toBe(pin.retainedSha256);
  return data;
}
function inverse(raw: string, spans: readonly Span[]) {
  let bytes = Buffer.from(raw);
  for (const s of [...spans].reverse()) {
    expect(s.before).toBe("");
    const end = s.afterOffset + Buffer.byteLength(s.after);
    expect(bytes.subarray(s.afterOffset, end).toString()).toBe(s.after);
    bytes = Buffer.concat([bytes.subarray(0, s.afterOffset), bytes.subarray(end)]);
  }
  return bytes.toString();
}
function forward(raw: string, spans: readonly Span[]) {
  let bytes = Buffer.from(raw);
  for (const s of [...spans].reverse())
    bytes = Buffer.concat([bytes.subarray(0, s.beforeOffset), Buffer.from(s.after), bytes.subarray(s.beforeOffset)]);
  return bytes.toString();
}
function witness() {
  const old = fixedReceipt(oldPath),
    bba74 = fixedReceipt(bba74Path);
  expect(expected.before).toEqual(bba74.current);
  expect(bba74.before).toEqual(old.current);
  expect(old.current.source).toEqual(checkpointPin);
  expect(old.before.source).toEqual(predecessorPin);
  const physical = capture5883Main4bffInventoryViewSource(read("scripts/compiler-boundaries.json"), "union-to-d"),
    pin = sourcePin(physical);
  let current: string;
  if (JSON.stringify(pin) === JSON.stringify(expected.current.source)) current = physical;
  else if (JSON.stringify(pin) === JSON.stringify(expected.before.source))
    current = forward(physical, expected.rawSpans);
  else {
    expect(pin).toEqual(checkpointPin);
    const prior = forward(physical, bba74.rawSpans);
    expect(sourcePin(prior)).toEqual(expected.before.source);
    current = forward(prior, expected.rawSpans);
  }
  const input = fullProfile(current, "current");
  const priorRaw = inverse(current, expected.rawSpans),
    prior = fullProfile(priorRaw, "before");
  expect(forward(priorRaw, expected.rawSpans)).toBe(current);
  const group = expected.additions[0],
    semantic = structuredClone(input);
  expect(input.files.slice(group.index, group.index + group.rows.length)).toEqual(group.rows);
  expect(input.files[group.index - 1]).toEqual(group.previous);
  expect(input.files[group.index + group.rows.length]).toEqual(group.next);
  semantic.files.splice(group.index, group.rows.length);
  expect(semantic).toEqual(prior);
  const replay = structuredClone(prior);
  replay.files.splice(group.index, 0, ...structuredClone(group.rows));
  expect(replay).toEqual(input);
  const checkpoint = inverse(priorRaw, bba74.rawSpans);
  expect(sourcePin(checkpoint)).toEqual(checkpointPin);
  const predecessor = inverse(checkpoint, old.rawSpans);
  expect(sourcePin(predecessor)).toEqual(predecessorPin);
  return { current, input, priorRaw, prior, checkpoint, predecessor, data: JSON.parse(predecessor) as Policy };
}
function healthy() {
  const w = witness();
  expect(capture5883InventoryBba74PolicySource(w.current)).toBe(w.priorRaw);
  expect(capture5883InventoryCheckpointPolicySource(w.current)).toBe(w.checkpoint);
  expect(capture5883InventoryPredecessorPolicySource(w.current)).toBe(w.predecessor);
  expect(capture5883InventoryPredecessorPolicy(w.input)).toEqual(w.data);
  return w;
}
function reject(data: Policy) {
  expect(() => capture5883InventoryPredecessorPolicy(data)).toThrow("complete policy profile mismatch");
  for (const capture of [
    capture5883InventoryPredecessorPolicySource,
    capture5883InventoryBba74PolicySource,
    capture5883InventoryCheckpointPolicySource,
  ])
    expect(() => capture(JSON.stringify(data))).toThrow("complete raw source profile mismatch");
}
afterEach(async () => {
  await setImmediate();
});

describe("PR5883 exact d0a13 merged-main source preservation", () => {
  it("independently pins actual-merge profiles, one row, full neighbors and the 333-byte span", () => {
    expect(fixedReceipt(d0a13Path)).toEqual(expected);
    expect(expected.additions).toHaveLength(1);
    expect(expected.rawSpans).toHaveLength(1);
    expect(expected.current.filesCount - expected.before.filesCount).toBe(1);
    expect(Buffer.byteLength(expected.rawSpans[0].after)).toBe(333);
    expect(expected.rawSpans[0].afterOffset).toBe(334729);
    expect(expected.current.movesSha256).toBe(expected.before.movesSha256);
    expect(expected.current.retainedSha256).toBe(expected.before.retainedSha256);
    healthy();
  });
  it("proves complete raw and semantic inverse and reciprocal replay independently", () => {
    const w = healthy();
    expect(inverse(w.current, expected.rawSpans)).toBe(w.priorRaw);
    expect(forward(w.priorRaw, expected.rawSpans)).toBe(w.current);
  });
  it("independently authenticates both receipt-chain profile linkages", () => {
    const w = healthy(),
      bba74 = fixedReceipt(bba74Path),
      old = fixedReceipt(oldPath);
    expect(expected.before).toEqual(bba74.current);
    expect(bba74.before).toEqual(old.current);
    expect(sourcePin(w.predecessor)).toEqual(predecessorPin);
  });
  it("composes actual-current raw and semantic inputs down to the original historical domain", () => {
    const w = healthy();
    const raw = captureMainInventoryPredecessorPolicySource(capture5883InventoryPredecessorPolicySource(w.current));
    expect(sourcePin(raw)).toEqual(historicalPin);
    const data = captureMainInventoryPredecessorPolicy(capture5883InventoryPredecessorPolicy(w.input));
    expect(data).toEqual(JSON.parse(raw));
    expect(sha(JSON.stringify(data))).toBe("7975101a306d4746f3431244115981fa1824bc558a4b563c2a55288ab457591c");
  });
  it("preserves old checkpoint and bba74 input domains and their exact receipt read traces", () => {
    const w = healthy(),
      trace: string[] = [];
    const reader = (path: string) => {
      trace.push(path);
      return read(path);
    };
    expect(capture5883InventoryPredecessorPolicySource(w.checkpoint, reader)).toBe(w.predecessor);
    expect(trace.splice(0)).toEqual([oldPath]);
    expect(capture5883InventoryPredecessorPolicy(JSON.parse(w.checkpoint), reader)).toEqual(w.data);
    expect(trace.splice(0)).toEqual([oldPath]);
    expect(capture5883InventoryPredecessorPolicySource(w.priorRaw, reader)).toBe(w.predecessor);
    expect(trace.splice(0)).toEqual([oldPath, bba74Path]);
    expect(capture5883InventoryPredecessorPolicy(w.prior, reader)).toEqual(w.data);
    expect(trace.splice(0)).toEqual([oldPath, bba74Path]);
    expect(capture5883InventoryBba74PolicySource(w.priorRaw, reader)).toBe(w.priorRaw);
    expect(trace.splice(0)).toEqual([oldPath, bba74Path]);
    expect(capture5883InventoryBba74PolicySource(w.checkpoint, reader)).toBe(w.checkpoint);
    expect(trace.splice(0)).toEqual([oldPath]);
  });
  it("rejects unknown projection profiles and predecessor domains without widening", () => {
    const w = healthy();
    for (const capture of [capture5883InventoryBba74PolicySource, capture5883InventoryCheckpointPolicySource])
      for (const raw of [w.predecessor, w.current + "\n", w.priorRaw + "\n", JSON.stringify(w.input), "{}"])
        expect(() => capture(raw)).toThrow("complete raw source profile mismatch");
    expect(() => capture5883InventoryPredecessorPolicySource(w.predecessor)).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => capture5883InventoryPredecessorPolicy(w.data)).toThrow("complete policy profile mismatch");
    healthy();
  });
  it("recognizes exact single-row removal only as the preserved bba74 input domain", () => {
    const w = healthy(),
      data = structuredClone(w.input);
    data.files.splice(890, 1);
    expect(data).toEqual(w.prior);
    expect(sha(JSON.stringify(data))).toBe(expected.before.dataSha256);
    const raw = inverse(w.current, expected.rawSpans);
    expect(sourcePin(raw)).toEqual(expected.before.source);
    expect(capture5883InventoryPredecessorPolicySource(raw)).toBe(w.predecessor);
    expect(capture5883InventoryPredecessorPolicy(data)).toEqual(w.data);
    expect(capture5883InventoryBba74PolicySource(raw)).toBe(w.priorRaw);
    // Any further change is not a recognized predecessor and must reject.
    data.files[890].path += ".altered";
    reject(data);
    healthy();
  });
  for (const mutation of ["duplicate", "relocate", "change"] as const) {
    it("rejects d0a13 row 890 " + mutation + " in raw and semantic domains", () => {
      const w = healthy(),
        data = structuredClone(w.input);
      if (mutation === "duplicate") data.files.splice(890, 0, structuredClone(data.files[890]));
      if (mutation === "relocate") data.files.push(...data.files.splice(890, 1));
      if (mutation === "change") data.files[890].path += ".altered";
      reject(data);
      healthy();
    });
  }
  for (const property of ["path", "state", "layer", "destination", "owner", "nextBoundary"] as const) {
    it("rejects d0a13 row 890 property " + property, () => {
      const w = healthy(),
        data = structuredClone(w.input);
      data.files[890][property] += " altered";
      reject(data);
      healthy();
    });
  }
  for (const side of ["previous", "next"] as const) {
    it("rejects d0a13 row 890 neighbor " + side, () => {
      const w = healthy(),
        data = structuredClone(w.input);
      data.files[side === "previous" ? 889 : 891].path += ".altered";
      reject(data);
      healthy();
    });
  }
  for (const mutation of [
    "row property order",
    "row order",
    "top key order",
    "moves",
    "evidence",
    "description",
    "retained file",
    "extra field",
  ] as const) {
    it("rejects d0a13 retained or ordering change " + mutation, () => {
      const w = healthy();
      let data = structuredClone(w.input);
      if (mutation === "row property order")
        data.files[890] = Object.fromEntries(Object.entries(data.files[890]).reverse());
      if (mutation === "row order") [data.files[890], data.files[891]] = [data.files[891], data.files[890]];
      if (mutation === "top key order") data = Object.fromEntries(Object.entries(data).reverse()) as Policy;
      if (mutation === "moves") data.moves.reverse();
      if (mutation === "evidence") data.evidence[0].symbols.pop();
      if (mutation === "description") data.description += " altered";
      if (mutation === "retained file") data.files[0].path += ".altered";
      if (mutation === "extra field") data.extra = true;
      reject(data);
      healthy();
    });
  }
  for (const mutation of ["duplicate", "relocate", "change"] as const) {
    it("rejects d0a13 raw span " + mutation, () => {
      const w = healthy(),
        bytes = Buffer.from(w.current),
        s = expected.rawSpans[0],
        at = s.afterOffset,
        end = at + Buffer.byteLength(s.after);
      const without = Buffer.concat([bytes.subarray(0, at), bytes.subarray(end)]);
      const raw = (
        mutation === "duplicate"
          ? Buffer.concat([bytes.subarray(0, at), Buffer.from(s.after), bytes.subarray(at)])
          : mutation === "relocate"
            ? Buffer.concat([without, Buffer.from(s.after)])
            : Buffer.concat([bytes.subarray(0, at), Buffer.from(s.after.replace(".ts", ".tx")), bytes.subarray(end)])
      ).toString();
      expect(() => capture5883InventoryPredecessorPolicySource(raw)).toThrow("complete raw source profile mismatch");
      healthy();
    });
  }
  it("rejects equivalent raw whitespace while retaining semantic serialization parity", () => {
    const w = healthy();
    expect(capture5883InventoryPredecessorPolicy(JSON.parse(JSON.stringify(w.input)))).toEqual(w.data);
    for (const raw of [w.current + "\n", JSON.stringify(w.input)])
      expect(() => capture5883InventoryPredecessorPolicySource(raw)).toThrow("complete raw source profile mismatch");
    healthy();
  });
  for (const field of [
    "schema",
    "coordinateUnit",
    "sourcePath",
    "main",
    "merge",
    "mergeTree",
    "before",
    "current",
    "additions",
    "rawSpans",
  ] as const) {
    it("rejects corrupted d0a13 receipt metadata " + field + " after healthy acceptance", () => {
      const w = healthy(),
        changed = fixedReceipt(d0a13Path);
      changed[field] = null;
      const reader = (path: string) => (path === d0a13Path ? JSON.stringify(changed) : read(path));
      expect(() => capture5883InventoryPredecessorPolicySource(w.current, reader)).toThrow(
        "fixed receipt pin mismatch",
      );
      expect(() => capture5883InventoryPredecessorPolicy(w.input, reader)).toThrow("fixed receipt pin mismatch");
      expect(() => capture5883InventoryBba74PolicySource(w.current, reader)).toThrow("fixed receipt pin mismatch");
      healthy();
    });
  }
  for (const mode of ["raw", "semantic", "checkpoint", "bba74"] as const) {
    it(mode + " reauthenticates every chain receipt behind the same reader", () => {
      const w = healthy(),
        trace: string[] = [];
      let faultPath: string | undefined,
        fault = "none";
      const reader = (path: string): string => {
        trace.push(path);
        const raw = read(path);
        if (path !== faultPath) return raw;
        if (fault === "missing") throw new Error("missing chain receipt");
        if (fault === "boxed") return new String(raw) as unknown as string;
        return raw + "\n";
      };
      const run = () =>
        mode === "raw"
          ? capture5883InventoryPredecessorPolicySource(w.current, reader)
          : mode === "semantic"
            ? capture5883InventoryPredecessorPolicy(w.input, reader)
            : mode === "checkpoint"
              ? capture5883InventoryCheckpointPolicySource(w.current, reader)
              : capture5883InventoryBba74PolicySource(w.current, reader);
      const result =
        mode === "raw"
          ? w.predecessor
          : mode === "semantic"
            ? w.data
            : mode === "checkpoint"
              ? w.checkpoint
              : w.priorRaw;
      const paths = [oldPath, bba74Path, d0a13Path];
      expect(run()).toEqual(result);
      expect(trace.splice(0)).toEqual(paths);
      for (const [index, path] of paths.entries()) {
        for (const corruption of ["mutated", "missing", "boxed"]) {
          faultPath = path;
          fault = corruption;
          expect(run).toThrow(
            corruption === "missing"
              ? "missing chain receipt"
              : corruption === "boxed"
                ? "primitive authority text required"
                : "fixed receipt pin mismatch",
          );
          expect(trace.splice(0)).toEqual(paths.slice(0, index + 1));
          faultPath = undefined;
          fault = "none";
          expect(run()).toEqual(result);
          expect(trace.splice(0)).toEqual(paths);
        }
      }
    });
  }
  for (const mode of ["raw", "checkpoint", "bba74"] as const) {
    for (const kind of ["boxed", "number", "null", "undefined", "array", "object", "symbol"] as const) {
      it("guards d0a13 " + mode + " " + kind + " before authority IO and coercion", () => {
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
          throw new Error("missing authority");
        };
        const capture =
          mode === "raw"
            ? capture5883InventoryPredecessorPolicySource
            : mode === "checkpoint"
              ? capture5883InventoryCheckpointPolicySource
              : capture5883InventoryBba74PolicySource;
        expect(() => capture(value as string, reader)).toThrow("raw input must be a primitive string");
        expect(reads).toBe(0);
        expect(coercions).toBe(0);
        expect(() => capture(w.current, reader)).toThrow("missing authority");
        expect(reads).toBe(1);
      });
    }
  }
  for (const kind of [
    "primitive",
    "top getter",
    "row getter",
    "array getter",
    "sparse",
    "cycle",
    "hidden",
    "symbol",
  ] as const) {
    it("guards d0a13 semantic " + kind + " before authority IO and getter execution", () => {
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
      if (kind === "row getter") Object.defineProperty(data.files[890], "path", { enumerable: true, get: getter });
      if (kind === "array getter") Object.defineProperty(data.files, "890", { enumerable: true, get: getter });
      if (kind === "sparse") expect(Reflect.deleteProperty(data.files, "890")).toBe(true);
      if (kind === "cycle") data.extra = data;
      if (kind === "hidden") Object.defineProperty(data, "extra", { value: true });
      if (kind === "symbol") Object.defineProperty(data, Symbol(), { value: true });
      const reader = () => {
        reads++;
        throw new Error("missing authority");
      };
      expect(() => capture5883InventoryPredecessorPolicy(value, reader)).toThrow(/PR5883 inventory source successor:/);
      expect(reads).toBe(0);
      expect(getters).toBe(0);
      expect(() => capture5883InventoryPredecessorPolicy(w.input, reader)).toThrow("missing authority");
      expect(reads).toBe(1);
      expect(getters).toBe(0);
    });
  }
});
