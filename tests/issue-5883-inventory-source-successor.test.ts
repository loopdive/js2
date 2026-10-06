// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent fixed-blob witnesses; no implementation output supplies expected values.
import { capture5883Main4bffInventoryViewSource } from "./helpers/ir-5883-main-4bff-inventory-views.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  capture5883InventoryCheckpointPolicySource,
  capture5883InventoryPredecessorPolicy,
  capture5883InventoryPredecessorPolicySource,
} from "./helpers/ir-5883-inventory-source-successor.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";

// Derived independently from Git blobs c5da824f89dd and 2d69c0400d7d at authoring time.
const expected = {
  before: {
    source: {
      bytes: 588351,
      sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
      gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
    },
    dataSha256: "56532a3cda4a9a8ec083fc0ebb7d38300fe754dd8f7cc4d49c20784ae77f05e0",
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
    movesCount: 12,
    movesSha256: "050fb62b7369179b0b3bd81193ec9bc275a77db1ebb45ac5fdef1a136ab037f2",
    filesCount: 1837,
    filesSha256: "fdd1e7da8bc2decab20f41771aa30b724a3ecda1929f590f286e2f530171be9c",
    retainedSha256: "dd91458d637f35a7ad9ac9c3a0663e34fd4e0fa9dc6e4786b3b8fa716e1afa12",
  },
  current: {
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
  additions: [
    {
      field: "moves",
      index: 0,
      rows: [
        {
          from: "src/codegen/promise-combinator-observable-protocol.ts",
          to: "src/codegen/promises/promise-combinator-observable-protocol.ts",
        },
        {
          from: "src/codegen/promise-observable-combinators.ts",
          to: "src/codegen/promises/promise-observable-combinators.ts",
        },
        {
          from: "src/codegen/vec-pop-body.ts",
          to: "src/codegen/vectors/vec-pop-body.ts",
        },
      ],
      previous: null,
      next: {
        from: "src/ir/nested-stackification.ts",
        to: "src/ir/analysis/nested-stackification.ts",
      },
    },
    {
      field: "files",
      index: 52,
      rows: [
        {
          path: "src/runtime/wasmgc/values/vector-storage-copy-body.ts",
          state: "clean",
          layer: "native-runtime",
        },
      ],
      previous: {
        path: "src/runtime/wasmgc/values/vector-grow-store.ts",
        state: "clean",
        layer: "native-runtime",
      },
      next: {
        path: "src/shared/contracts/ir-preparation-failure.ts",
        state: "clean",
        layer: "foundation",
      },
    },
    {
      field: "files",
      index: 869,
      rows: [
        {
          path: "src/codegen/promises/promise-combinator-observable-protocol.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-driven observable protocol registration and emission from allocator-owned resources and canonical native bodies; retain the legacy adapter until full IR equivalence.",
        },
        {
          path: "src/codegen/promises/promise-observable-combinators.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate AST/context-driven observable combinator lowering, allocator-owned live aggregate resources, and canonical native body construction.",
        },
      ],
      previous: {
        path: "src/codegen/promise-combinators.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/promise-executor.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1104,
      rows: [
        {
          path: "src/codegen/vectors/vec-pop-body.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Closed pop instruction builder separated from allocation; still uses backend physical types and handles, not a migrated semantic IR producer.",
        },
      ],
      previous: {
        path: "src/codegen/vec-props-key-source.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/vec-props.ts",
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
      beforeOffset: 68319,
      afterOffset: 68319,
      before: "",
      after:
        '    {\n      "from": "src/codegen/promise-combinator-observable-protocol.ts",\n      "to": "src/codegen/promises/promise-combinator-observable-protocol.ts"\n    },\n    {\n      "from": "src/codegen/promise-observable-combinators.ts",\n      "to": "src/codegen/promises/promise-observable-combinators.ts"\n    },\n    {\n      "from": "src/codegen/vec-pop-body.ts",\n      "to": "src/codegen/vectors/vec-pop-body.ts"\n    },\n',
    },
    {
      beforeOffset: 78933,
      afterOffset: 79347,
      before: "",
      after:
        '    {\n      "path": "src/runtime/wasmgc/values/vector-storage-copy-body.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n',
    },
    {
      beforeOffset: 326831,
      afterOffset: 327385,
      before: "",
      after:
        '    {\n      "path": "src/codegen/promises/promise-combinator-observable-protocol.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-driven observable protocol registration and emission from allocator-owned resources and canonical native bodies; retain the legacy adapter until full IR equivalence."\n    },\n    {\n      "path": "src/codegen/promises/promise-observable-combinators.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven observable combinator lowering, allocator-owned live aggregate resources, and canonical native body construction."\n    },\n',
    },
    {
      beforeOffset: 401719,
      afterOffset: 403102,
      before: "",
      after:
        '    {\n      "path": "src/codegen/vectors/vec-pop-body.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Closed pop instruction builder separated from allocation; still uses backend physical types and handles, not a migrated semantic IR producer."\n    },\n',
    },
  ],
} as const;

type Policy = Record<string, any> & { moves: Record<string, unknown>[]; files: Record<string, unknown>[] };
const sourcePath = "scripts/compiler-boundaries.json";
const receiptPath = "tests/helpers/ir-5883-inventory-source-successor.json";
const physical = (path: string) => fileURLToPath(new URL("../" + path, import.meta.url));
const read = (path: string) => readFileSync(physical(path), "utf8");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sourcePin = (raw: string) => {
  const bytes = Buffer.from(raw);
  return {
    bytes: bytes.length,
    sha256: sha(bytes),
    gitBlob: createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex"),
  };
};
function profile(policy: Policy, which: "before" | "current") {
  const pin = expected[which];
  expect(Object.keys(policy)).toEqual(pin.topLevelKeys);
  expect(sha(JSON.stringify(policy))).toBe(pin.dataSha256);
  expect(policy.moves).toHaveLength(pin.movesCount);
  expect(sha(JSON.stringify(policy.moves))).toBe(pin.movesSha256);
  expect(policy.files).toHaveLength(pin.filesCount);
  expect(sha(JSON.stringify(policy.files))).toBe(pin.filesSha256);
  expect(
    sha(JSON.stringify(Object.fromEntries(Object.entries(policy).filter(([k]) => k !== "moves" && k !== "files")))),
  ).toBe(pin.retainedSha256);
}
function independent() {
  const current = capture5883InventoryCheckpointPolicySource(
      capture5883Main4bffInventoryViewSource(read(sourcePath), "union-to-d"),
    ),
    input = JSON.parse(current) as Policy;
  expect(sourcePin(current)).toEqual(expected.current.source);
  profile(input, "current");
  let before = Buffer.from(current);
  for (const span of [...expected.rawSpans].reverse()) {
    expect(span.before).toBe("");
    const end = span.afterOffset + Buffer.byteLength(span.after);
    expect(before.subarray(span.afterOffset, end).toString()).toBe(span.after);
    before = Buffer.concat([before.subarray(0, span.afterOffset), before.subarray(end)]);
  }
  expect(sourcePin(before.toString())).toEqual(expected.before.source);
  let replay = before;
  for (const span of [...expected.rawSpans].reverse())
    replay = Buffer.concat([
      replay.subarray(0, span.beforeOffset),
      Buffer.from(span.after),
      replay.subarray(span.beforeOffset),
    ]);
  expect(replay.equals(Buffer.from(current))).toBe(true);
  const semantic = structuredClone(input);
  for (const field of ["moves", "files"] as const) {
    const removed = new Set<number>();
    for (const group of expected.additions.filter((group) => group.field === field)) {
      expect(input[field].slice(group.index, group.index + group.rows.length)).toEqual(group.rows);
      expect(group.index ? input[field][group.index - 1] : null).toEqual(group.previous);
      expect(input[field][group.index + group.rows.length]).toEqual(group.next);
      for (let index = group.index; index < group.index + group.rows.length; index++) removed.add(index);
    }
    semantic[field] = input[field].filter((_row, index) => !removed.has(index));
  }
  profile(semantic, "before");
  expect(JSON.parse(before.toString())).toEqual(semantic);
  return { current, input, before: before.toString(), semantic };
}
function healthy() {
  const witness = independent();
  expect(capture5883InventoryPredecessorPolicySource(witness.current)).toBe(witness.before);
  expect(capture5883InventoryPredecessorPolicy(witness.input)).toEqual(witness.semantic);
  return witness;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) freeze(descriptor.value);
  Object.freeze(value);
}
afterEach(async () => {
  await setImmediate();
});

describe("PR5883 fixed inventory source preservation", () => {
  it("independently proves both full domains, seven rows, four spans and unchanged retained fields", () => {
    expect(expected.rawSpans).toHaveLength(4);
    expect(expected.additions.reduce((n, group) => n + group.rows.length, 0)).toBe(7);
    const receipt = read(receiptPath);
    expect(Buffer.byteLength(receipt)).toBe(8642);
    expect(sha(receipt)).toBe("dae4ccaa122c9b406f136d71a89e613e80d677392cc5ddd9456c90424316bba6");
    const actual = JSON.parse(receipt);
    expect(actual.before).toEqual(expected.before);
    expect(actual.current).toEqual(expected.current);
    expect(actual.additions).toEqual(expected.additions);
    expect(actual.rawSpans).toEqual(expected.rawSpans);
    healthy();
  });
  it("composes the unchanged older raw and semantic APIs to the genuine 584712-byte domain", () => {
    const witness = healthy();
    expect(sha(read("tests/helpers/ir-main-inventory-source-successor.ts"))).toBe(
      "41012f3d03e1521eb217c94996c542ae84b3de1410b2cf6c6744319c5da64b86",
    );
    expect(sha(read("tests/helpers/ir-main-inventory-source-successor.json"))).toBe(
      "06a6fcd2df50e87b1cd14d684db90e31e221bb9f001f52f2e5158720a93f50ef",
    );
    const original = captureMainInventoryPredecessorPolicySource(
      capture5883InventoryPredecessorPolicySource(witness.current),
    );
    expect(sourcePin(original)).toEqual({
      bytes: 584712,
      sha256: "c71c9f9a61cebf84bff0f75f26fcd271265e53c83a66f59ed416e1cbc1675209",
      gitBlob: "2a85037d2b4ffa2dd93aff1fa4080581e48a8c88",
    });
    const semantic = captureMainInventoryPredecessorPolicy(capture5883InventoryPredecessorPolicy(witness.input));
    expect(sha(JSON.stringify(semantic))).toBe("7975101a306d4746f3431244115981fa1824bc558a4b563c2a55288ab457591c");
    expect(semantic).toEqual(JSON.parse(original));
    expect(() => captureMainInventoryPredecessorPolicySource(witness.current)).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => captureMainInventoryPredecessorPolicy(witness.input)).toThrow("complete policy profile mismatch");
  });
  it("detaches every semantic object and preserves a frozen operand", () => {
    const witness = healthy(),
      before = JSON.stringify(witness.input);
    const identities = new Set<object>();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      identities.add(value);
      for (const item of Object.values(value)) collect(item);
    };
    collect(witness.input);
    freeze(witness.input);
    const result = capture5883InventoryPredecessorPolicy(witness.input);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      expect(identities.has(value)).toBe(false);
      for (const item of Object.values(value)) visit(item);
    };
    visit(result);
    expect(result).toEqual(witness.semantic);
    expect(JSON.stringify(witness.input)).toBe(before);
  });
  it("rejects the genuine predecessor in both APIs rather than widening the domain", () => {
    const witness = healthy();
    expect(() => capture5883InventoryPredecessorPolicySource(witness.before)).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => capture5883InventoryPredecessorPolicy(witness.semantic)).toThrow("complete policy profile mismatch");
  });
  for (const group of expected.additions) {
    for (let offset = 0; offset < group.rows.length; offset++) {
      for (const mutation of ["remove", "duplicate", "relocate", "change"] as const) {
        it(
          "rejects " + group.field + " row " + (group.index + offset) + " " + mutation + " in raw and semantic inputs",
          () => {
            const witness = healthy(),
              changed = structuredClone(witness.input);
            const rows = changed[group.field],
              index = group.index + offset;
            if (mutation === "remove") rows.splice(index, 1);
            if (mutation === "duplicate") rows.splice(index, 0, structuredClone(rows[index]));
            if (mutation === "relocate") rows.push(...rows.splice(index, 1));
            if (mutation === "change") {
              const key = group.field === "moves" ? "to" : "path";
              rows[index] = { ...rows[index], [key]: String(rows[index][key]) + ".altered" };
            }
            expect(() => capture5883InventoryPredecessorPolicy(changed)).toThrow("complete policy profile mismatch");
            expect(() => capture5883InventoryPredecessorPolicySource(JSON.stringify(changed))).toThrow(
              "complete raw source profile mismatch",
            );
            healthy();
          },
        );
      }
    }
  }
  for (const group of expected.additions.filter((group) => group.field === "files")) {
    for (let offset = 0; offset < group.rows.length; offset++) {
      for (const key of ["state", "layer", "owner", "nextBoundary"] as const) {
        if (!Object.hasOwn(group.rows[offset], key)) continue;
        it("rejects added file row " + (group.index + offset) + " metadata " + key, () => {
          const witness = healthy(),
            changed = structuredClone(witness.input);
          const row = changed.files[group.index + offset];
          row[key] = String(row[key]) + " altered";
          expect(() => capture5883InventoryPredecessorPolicy(changed)).toThrow("complete policy profile mismatch");
          expect(() => capture5883InventoryPredecessorPolicySource(JSON.stringify(changed))).toThrow(
            "complete raw source profile mismatch",
          );
          healthy();
        });
      }
    }
  }
  for (const group of expected.additions) {
    it("rejects altered retained neighbors around " + group.field + " insertion " + group.index, () => {
      const witness = healthy(),
        changed = structuredClone(witness.input);
      changed[group.field][group.index + group.rows.length] = {
        ...changed[group.field][group.index + group.rows.length],
        extra: true,
      };
      expect(() => capture5883InventoryPredecessorPolicy(changed)).toThrow("complete policy profile mismatch");
      healthy();
    });
  }
  for (const mutation of ["description", "held evidence", "retained file", "extra top key", "row order"] as const) {
    it("rejects retained semantic " + mutation, () => {
      const witness = healthy(),
        changed = structuredClone(witness.input);
      if (mutation === "description") changed.description += " altered";
      if (mutation === "held evidence") changed.evidence[0].symbols.pop();
      if (mutation === "retained file") changed.files[0].path = "src/not-original.ts";
      if (mutation === "extra top key") changed.extra = true;
      if (mutation === "row order") changed.files.reverse();
      expect(() => capture5883InventoryPredecessorPolicy(changed)).toThrow("complete policy profile mismatch");
      healthy();
    });
  }
  for (const [index, span] of expected.rawSpans.entries()) {
    for (const mutation of ["remove", "duplicate", "relocate", "change"] as const) {
      it("rejects raw span " + index + " " + mutation, () => {
        const witness = healthy(),
          bytes = Buffer.from(witness.current);
        const at = span.afterOffset,
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
                    Buffer.from(span.after.replace('"', "'")),
                    bytes.subarray(end),
                  ]);
        expect(() => capture5883InventoryPredecessorPolicySource(mutant.toString())).toThrow(
          "complete raw source profile mismatch",
        );
        healthy();
      });
    }
  }
  it("rejects reordered raw spans and equivalent JSON whitespace while retaining semantic parity", () => {
    const witness = healthy();
    const serialized = JSON.stringify(witness.input);
    expect(capture5883InventoryPredecessorPolicy(JSON.parse(serialized))).toEqual(witness.semantic);
    expect(() => capture5883InventoryPredecessorPolicySource(serialized)).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => capture5883InventoryPredecessorPolicySource(witness.current + "\n")).toThrow(
      "complete raw source profile mismatch",
    );
    const first = expected.rawSpans[0].after,
      second = expected.rawSpans[1].after;
    const swapped = witness.current
      .replace(first, "PR5883_SPAN_SENTINEL")
      .replace(second, first)
      .replace("PR5883_SPAN_SENTINEL", second);
    expect(() => capture5883InventoryPredecessorPolicySource(swapped)).toThrow("complete raw source profile mismatch");
    healthy();
  });
  it("rejects a same-length valid-JSON row edit in both domains", () => {
    const witness = healthy();
    const mutant = witness.current.replace("vector-storage-copy-body.ts", "vector-storage-copy-bodx.ts");
    expect(mutant).not.toBe(witness.current);
    expect(Buffer.byteLength(mutant)).toBe(expected.current.source.bytes);
    const data = JSON.parse(mutant);
    expect(() => capture5883InventoryPredecessorPolicySource(mutant)).toThrow("complete raw source profile mismatch");
    expect(() => capture5883InventoryPredecessorPolicy(data)).toThrow("complete policy profile mismatch");
    healthy();
  });
  for (const kind of ["boxed", "number", "null", "undefined", "array", "object", "symbol"] as const) {
    it("guards raw " + kind + " before authority IO or coercion", () => {
      const witness = healthy();
      let reads = 0,
        coercions = 0;
      const values: Record<string, unknown> = {
        boxed: new String(witness.current),
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
            return witness.current;
          },
        });
      const missing = () => {
        reads++;
        throw new Error("missing authority witness");
      };
      expect(() => capture5883InventoryPredecessorPolicySource(value as string, missing)).toThrow(
        "raw input must be a primitive string",
      );
      expect(reads).toBe(0);
      expect(coercions).toBe(0);
      expect(() => capture5883InventoryPredecessorPolicySource(witness.current, missing)).toThrow(
        "missing authority witness",
      );
      expect(reads).toBe(1);
    });
  }
  for (const kind of [
    "null",
    "array",
    "boxed",
    "bigint",
    "cycle",
    "sparse",
    "hidden",
    "symbol",
    "foreign prototype",
    "top getter",
    "row getter",
    "array getter",
    "hidden array element",
  ] as const) {
    it("guards semantic " + kind + " before authority IO or getter execution", () => {
      const witness = healthy();
      let value: unknown = structuredClone(witness.input),
        getters = 0,
        reads = 0;
      const data = value as Policy;
      if (kind === "null") value = null;
      if (kind === "array") value = [];
      if (kind === "boxed") value = new String("boxed");
      if (kind === "bigint") data.extra = 1n;
      if (kind === "cycle") data.extra = data;
      if (kind === "sparse") expect(Reflect.deleteProperty(data.files, "0")).toBe(true);
      if (kind === "hidden") Object.defineProperty(data, "extra", { value: true });
      if (kind === "symbol") Object.defineProperty(data, Symbol(), { value: true });
      if (kind === "foreign prototype") Object.setPrototypeOf(data, { inherited: true });
      const getter = () => {
        getters++;
        return "not evaluated";
      };
      if (kind === "top getter") Object.defineProperty(data, "description", { enumerable: true, get: getter });
      if (kind === "row getter") Object.defineProperty(data.files[0], "path", { enumerable: true, get: getter });
      if (kind === "array getter") Object.defineProperty(data.files, "0", { enumerable: true, get: getter });
      if (kind === "hidden array element") Object.defineProperty(data.files, "0", { enumerable: false });
      const missing = () => {
        reads++;
        throw new Error("missing authority witness");
      };
      expect(() => capture5883InventoryPredecessorPolicy(value, missing)).toThrow(/PR5883 inventory source successor:/);
      expect(reads).toBe(0);
      expect(getters).toBe(0);
      expect(() => capture5883InventoryPredecessorPolicy(witness.input, missing)).toThrow("missing authority witness");
      expect(reads).toBe(1);
      expect(getters).toBe(0);
    });
  }
  for (const mode of ["raw", "semantic"] as const) {
    it(
      mode + " freshly authenticates the supplied reader after success, corruption, missing input and restoration",
      () => {
        const witness = healthy(),
          trace: string[] = [];
        let fault = "none";
        const reader = (path: string): string => {
          trace.push(path);
          if (fault === "missing") throw new Error("missing authority witness");
          const original = read(path);
          if (fault === "boxed") return new String(original) as unknown as string;
          return fault === "corrupt" ? original + "\n" : original;
        };
        const run = () =>
          mode === "raw"
            ? capture5883InventoryPredecessorPolicySource(witness.current, reader)
            : capture5883InventoryPredecessorPolicy(witness.input, reader);
        expect(run()).toEqual(mode === "raw" ? witness.before : witness.semantic);
        for (const faultName of ["missing", "corrupt", "boxed"]) {
          fault = faultName;
          expect(run).toThrow(
            faultName === "missing"
              ? "missing authority witness"
              : faultName === "corrupt"
                ? "fixed receipt pin mismatch"
                : "primitive authority text required",
          );
          fault = "none";
          expect(run()).toEqual(mode === "raw" ? witness.before : witness.semantic);
        }
        expect(trace).toEqual(Array(7).fill(receiptPath));
      },
    );
  }
  for (const fault of ["missing", "mutated"] as const) {
    it(
      "both default readers reject physically " + fault + " authority after success and accept restored exact bytes",
      () => {
        const witness = healthy(),
          path = physical(receiptPath),
          original = readFileSync(path);
        const directory = mkdtempSync(dirname(path) + "/.5883-authority-");
        const saved = directory + "/original.json";
        let moved = false;
        try {
          if (fault === "missing") {
            renameSync(path, saved);
            moved = true;
          } else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
          expect(() => capture5883InventoryPredecessorPolicySource(witness.current)).toThrow(
            fault === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
          );
          expect(() => capture5883InventoryPredecessorPolicy(witness.input)).toThrow(
            fault === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
          );
        } finally {
          if (moved) renameSync(saved, path);
          else writeFileSync(path, original);
          rmdirSync(directory);
          expect(readFileSync(path).equals(original)).toBe(true);
        }
        healthy();
      },
    );
  }
});
