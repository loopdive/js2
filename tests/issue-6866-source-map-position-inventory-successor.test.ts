import { captureDenoPostPositionMainPredecessorPolicySource } from "./helpers/ir-deno-post-position-main-successor.js";
import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
import { capturePositionClassFieldsMainPredecessorPolicySource } from "./helpers/ir-position-class-fields-main-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  captureSourceMapPositionInventoryPredecessorPolicy,
  captureSourceMapPositionInventoryPredecessorPolicySource,
  sourceMapPositionInventorySuccessorReceiptPath,
} from "./helpers/ir-source-map-position-inventory-successor.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";
// Independent fixed observations of the actual source; receipt contents are never the oracle.
const expected = {
  before: {
    source: {
      bytes: 588351,
      sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
      gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
    },
    dataSha256: "56532a3cda4a9a8ec083fc0ebb7d38300fe754dd8f7cc4d49c20784ae77f05e0",
    filesSha256: "fdd1e7da8bc2decab20f41771aa30b724a3ecda1929f590f286e2f530171be9c",
    fileCount: 1837,
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
  },
  current: {
    source: {
      bytes: 588471,
      sha256: "a2e9c7243c13ae37b293f02ae19eba03f072db30195ce0479f0926488fa3de98",
      gitBlob: "d0ff19228046a1bed50bd821194a5f2ffe2f6754",
    },
    dataSha256: "e27bdf5d6dae65b37905253ca8f4383a84eace68a9d99700ae93ed0e83ec42e5",
    filesSha256: "0618fa655d6afb12bcb7565ccfc8de5d8d89327f62d760d44fbae37408e358d5",
    fileCount: 1838,
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
  },
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  index: 85,
  row: {
    path: "src/ir/program/source-map-position.ts",
    state: "clean",
    layer: "ir-program",
  },
  previous: {
    path: "src/ir/program/errors.ts",
    state: "clean",
    layer: "ir-program",
  },
  next: {
    path: "src/ir/program/data.ts",
    state: "clean",
    layer: "ir-program",
  },
  offset: 82745,
  insertion:
    '    {\n      "path": "src/ir/program/source-map-position.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n',
} as const;
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
type Policy = Record<string, unknown> & { files: Record<string, unknown>[] };
function profile(raw: string, which: "before" | "current"): Policy {
  const pin = expected[which];
  expect(Buffer.byteLength(raw)).toBe(pin.source.bytes);
  expect(sha(raw)).toBe(pin.source.sha256);
  expect(blob(raw)).toBe(pin.source.gitBlob);
  const data = JSON.parse(raw) as Policy;
  expect(data.files).toHaveLength(pin.fileCount);
  expect(Object.keys(data)).toEqual(pin.topLevelKeys);
  expect(sha(JSON.stringify(data))).toBe(pin.dataSha256);
  expect(sha(JSON.stringify(data.files))).toBe(pin.filesSha256);
  expect(sha(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "files"))))).toBe(
    expected.nonFilesSha256,
  );
  return data;
}
function independent() {
  const raw = capturePositionClassFieldsMainPredecessorPolicySource(
    capturePositionFinallyMainPredecessorPolicySource(
      captureDenoPostPositionMainPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
    ),
  );
  const current = profile(raw, "current");
  const bytes = Buffer.from(raw),
    insertion = Buffer.from(expected.insertion);
  expect(bytes.subarray(expected.offset, expected.offset + insertion.length)).toEqual(insertion);
  const beforeRaw = Buffer.concat([
    bytes.subarray(0, expected.offset),
    bytes.subarray(expected.offset + insertion.length),
  ]).toString("utf8");
  const before = profile(beforeRaw, "before");
  expect(
    Buffer.concat([
      Buffer.from(beforeRaw).subarray(0, expected.offset),
      insertion,
      Buffer.from(beforeRaw).subarray(expected.offset),
    ]).toString("utf8"),
  ).toBe(raw);
  expect(current.files[expected.index]).toEqual(expected.row);
  expect(current.files[expected.index - 1]).toEqual(expected.previous);
  expect(current.files[expected.index + 1]).toEqual(expected.next);
  const semantic = structuredClone(current);
  semantic.files.splice(expected.index, 1);
  expect(semantic).toEqual(before);
  const replay = structuredClone(semantic);
  replay.files.splice(expected.index, 0, structuredClone(expected.row));
  expect(replay).toEqual(current);
  return { raw, current, beforeRaw, before };
}
function healthy() {
  const witness = independent();
  const trace: string[] = [];
  const authority = (path: string): string => {
    trace.push(path);
    return read(path);
  };
  expect(captureSourceMapPositionInventoryPredecessorPolicySource(witness.raw, authority)).toBe(witness.beforeRaw);
  const data = captureSourceMapPositionInventoryPredecessorPolicy(witness.current, authority);
  expect(data).toEqual(witness.before);
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(Object.getPrototypeOf((data.files as object[])[0])).toBe(Object.prototype);
  expect(trace).toEqual([
    sourceMapPositionInventorySuccessorReceiptPath,
    sourceMapPositionInventorySuccessorReceiptPath,
  ]);
  expect(captureMainInventoryPredecessorPolicySource(witness.beforeRaw)).toHaveLength(584712);
  expect(captureMainInventoryPredecessorPolicy(data).files as unknown[]).toHaveLength(1826);
  return witness;
}
describe("one canonical source-map position inventory row independent proof", () => {
  it("independently pins the complete finite helper and receipt", () => {
    for (const pin of [
      {
        path: "tests/helpers/ir-source-map-position-inventory-successor.ts",
        bytes: 10137,
        sha256: "f38b30f68e7e6d4e77d60126e9fe29ef4c0c934225f02a759c41a58402a49b90",
      },
      {
        path: "tests/helpers/ir-source-map-position-inventory-successor.json",
        bytes: 2437,
        sha256: "b2afd57a2583d7a103b07ce1bcc577475023ee29f54ee433f115a6fcf43572b0",
      },
    ]) {
      const raw = read(pin.path);
      expect(Buffer.byteLength(raw)).toBe(pin.bytes);
      expect(sha(raw)).toBe(pin.sha256);
    }
  });
  it("binds actual1838 to exact1837 whole-file replay and downstream1826 custody", () => {
    healthy();
  });
  for (const [name, mutate] of [
    [
      "missing row",
      (data: Policy) => {
        data.files.splice(expected.index, 1);
      },
    ],
    [
      "duplicated row",
      (data: Policy) => {
        data.files.splice(expected.index, 0, structuredClone(expected.row));
      },
    ],
    [
      "reordered insertion",
      (data: Policy) => {
        [data.files[expected.index], data.files[expected.index + 1]] = [
          data.files[expected.index + 1]!,
          data.files[expected.index]!,
        ];
      },
    ],
    [
      "changed inserted layer",
      (data: Policy) => {
        data.files[expected.index]!.layer = "ir-core";
      },
    ],
    [
      "changed retained row",
      (data: Policy) => {
        data.files[0]!.layer = "ir-core";
      },
    ],
    [
      "changed activation",
      (data: Policy) => {
        (data.activationHistory as unknown[]).push({});
      },
    ],
    [
      "changed allowed edges",
      (data: Policy) => {
        data.allowedEdges = [];
      },
    ],
    [
      "changed eligibility",
      (data: Policy) => {
        data.layers = [];
      },
    ],
  ] as const)
    it(`refuses semantic ${name} after healthy capture and accepts restoration`, () => {
      const witness = healthy(),
        retained = JSON.stringify(witness.current),
        mutant = structuredClone(witness.current);
      mutate(mutant);
      expect(() => captureSourceMapPositionInventoryPredecessorPolicy(mutant)).toThrow(
        /complete policy profile mismatch/,
      );
      expect(JSON.stringify(witness.current)).toBe(retained);
      healthy();
    });
  for (const name of ["extra raw byte", "changed retained raw byte", "old as current"] as const)
    it(`refuses raw ${name} after healthy capture and accepts restoration`, () => {
      const witness = healthy();
      const mutant =
        name === "extra raw byte"
          ? witness.raw + "\n"
          : name === "old as current"
            ? witness.beforeRaw
            : witness.raw.replace("compiler", "Compiler");
      expect(() => captureSourceMapPositionInventoryPredecessorPolicySource(mutant)).toThrow(
        /complete raw source profile mismatch/,
      );
      healthy();
    });
  it("refuses semantic old-as-current and returns detached nested ordinary data", () => {
    const witness = healthy();
    expect(() => captureSourceMapPositionInventoryPredecessorPolicy(witness.before)).toThrow(
      /complete policy profile mismatch/,
    );
    const output = captureSourceMapPositionInventoryPredecessorPolicy(witness.current) as Policy;
    expect(output.files).not.toBe(witness.current.files);
    expect(output.files[0]).not.toBe(witness.current.files[0]);
    output.files[0]!.layer = "mutant";
    healthy();
  });
  for (const mode of ["changed", "missing", "boxed"] as const)
    it(`authenticates ${mode} receipt freshly on raw and semantic operations`, () => {
      const witness = healthy();
      let reads = 0,
        malformed = false;
      const authority = (path: string): string => {
        reads++;
        if (!malformed) return read(path);
        if (mode === "missing") throw new Error("missing authority");
        return mode === "boxed" ? (Object(read(path)) as string) : read(path) + "\n";
      };
      captureSourceMapPositionInventoryPredecessorPolicySource(witness.raw, authority);
      malformed = true;
      expect(() => captureSourceMapPositionInventoryPredecessorPolicySource(witness.raw, authority)).toThrow();
      expect(() => captureSourceMapPositionInventoryPredecessorPolicy(witness.current, authority)).toThrow();
      malformed = false;
      expect(captureSourceMapPositionInventoryPredecessorPolicySource(witness.raw, authority)).toBe(witness.beforeRaw);
      expect(reads).toBe(4);
      healthy();
    });
  for (const mode of ["boxed raw", "boxed nested", "accessor", "sparse", "symbol", "cycle"] as const)
    it(`refuses ${mode} without touching coercion or getter sentinels`, () => {
      const witness = healthy();
      let touched = 0;
      const sentinel = () => {
        touched++;
        return "unexpected";
      };
      if (mode === "boxed raw") {
        const boxed = Object(witness.raw);
        boxed.toString = sentinel;
        boxed.valueOf = sentinel;
        expect(() => captureSourceMapPositionInventoryPredecessorPolicySource(boxed)).toThrow(/primitive string/);
      } else {
        const mutant = structuredClone(witness.current);
        if (mode === "boxed nested") {
          const boxed = Object("clean");
          boxed.toString = sentinel;
          boxed.valueOf = sentinel;
          mutant.files[0]!.state = boxed;
        }
        if (mode === "accessor") Object.defineProperty(mutant.files[0], "state", { get: sentinel, enumerable: true });
        if (mode === "sparse") Reflect.deleteProperty(mutant.files, "0");
        if (mode === "symbol") Object.defineProperty(mutant, Symbol("extra"), { value: 1 });
        if (mode === "cycle") mutant.cycle = mutant;
        expect(() => captureSourceMapPositionInventoryPredecessorPolicy(mutant)).toThrow();
      }
      expect(touched).toBe(0);
      healthy();
    });
});
