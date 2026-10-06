import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capturePositionClassFieldsMainPredecessorPolicy,
  capturePositionClassFieldsMainPredecessorPolicySource,
  positionClassFieldsMainSuccessorReceiptPath,
} from "./helpers/ir-position-class-fields-main-successor.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureSourceMapPositionInventoryPredecessorPolicy,
  captureSourceMapPositionInventoryPredecessorPolicySource,
} from "./helpers/ir-source-map-position-inventory-successor.js";
// Independent fixed observations of the actual source; receipt contents are never the oracle.
const expected = {
  before: {
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
  current: {
    source: {
      bytes: 588799,
      sha256: "3d497f1ec140ecd7056155e6e0a993801e126b93304af1a581820d779a979122",
      gitBlob: "9c248ee6471ee50973d5da74ba2d7d06e9eee92f",
    },
    dataSha256: "8c91785b4302f8f9b88641f325643e374484b54909c3bbc086c0456b5a6bdc9a",
    filesSha256: "7ede92f695b2c32bbc8cb5dea5e59a3e2f89a24bf37852f757866601ad01a62a",
    fileCount: 1839,
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
  index: 1648,
  row: {
    path: "src/codegen/classes/externref-class-fields.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
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
  offset: 542891,
  insertion:
    '    {\n      "path": "src/codegen/classes/externref-class-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
  deliveredMain: {
    beforeRevision: "abb3471c46bb9e7129b28812fe16313c857cda69",
    currentRevision: "cdc0255882d45181072342d9fd57f291aca93092",
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
        bytes: 588679,
        sha256: "e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e",
        gitBlob: "6066caa751c06e8726076ee622311f509bdd5f77",
      },
      dataSha256: "52245127b5852686adc2baf31be58a4af1eee857f2a2070a8a6b7cbb9636f669",
      filesSha256: "1ed6b8c66a8ecc80bfe88fe5a0f044fac2a88ee5775146f4f019caefe218a88e",
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
    index: 1647,
    offset: 542771,
    insertion:
      '    {\n      "path": "src/codegen/classes/externref-class-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
  },
} as const;
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
type Policy = Record<string, unknown> & { files: Record<string, unknown>[] };
function profilePin(
  raw: string,
  pin:
    | typeof expected.before
    | typeof expected.current
    | typeof expected.deliveredMain.before
    | typeof expected.deliveredMain.current,
): Policy {
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
function profile(raw: string, which: "before" | "current"): Policy {
  return profilePin(raw, expected[which]);
}

function independent() {
  const raw = capturePositionFinallyMainPredecessorPolicySource(read("scripts/compiler-boundaries.json"));
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
  // Independently replay the exact delivered-main insertion against original1837.
  const originalRaw = captureSourceMapPositionInventoryPredecessorPolicySource(beforeRaw);
  const original = profilePin(originalRaw, expected.deliveredMain.before);
  const originalBytes = Buffer.from(originalRaw);
  const mainRaw = Buffer.concat([
    originalBytes.subarray(0, expected.deliveredMain.offset),
    insertion,
    originalBytes.subarray(expected.deliveredMain.offset),
  ]).toString("utf8");
  const main = profilePin(mainRaw, expected.deliveredMain.current);
  expect(main.files[expected.deliveredMain.index]).toEqual(expected.row);
  const retainedMain = structuredClone(main);
  retainedMain.files.splice(expected.deliveredMain.index, 1);
  expect(retainedMain).toEqual(original);
  expect(before.files[85]).toEqual({
    path: "src/ir/program/source-map-position.ts",
    state: "clean",
    layer: "ir-program",
  });
  return { raw, current, beforeRaw, before, originalRaw, mainRaw };
}
function healthy() {
  const witness = independent();
  const trace: string[] = [];
  const authority = (path: string): string => {
    trace.push(path);
    return read(path);
  };
  expect(capturePositionClassFieldsMainPredecessorPolicySource(witness.raw, authority)).toBe(witness.beforeRaw);
  const data = capturePositionClassFieldsMainPredecessorPolicy(witness.current, authority);
  expect(data).toEqual(witness.before);
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(Object.getPrototypeOf((data.files as object[])[0])).toBe(Object.prototype);
  expect(trace).toEqual([positionClassFieldsMainSuccessorReceiptPath, positionClassFieldsMainSuccessorReceiptPath]);
  expect(
    captureMainInventoryPredecessorPolicySource(
      captureSourceMapPositionInventoryPredecessorPolicySource(witness.beforeRaw),
    ),
  ).toHaveLength(584712);
  expect(
    captureMainInventoryPredecessorPolicy(captureSourceMapPositionInventoryPredecessorPolicy(data)).files as unknown[],
  ).toHaveLength(1826);
  return witness;
}
describe("delivered class-fields main row position inventory independent proof", () => {
  it("independently pins the complete finite helper and receipt", () => {
    for (const pin of [
      {
        path: "tests/helpers/ir-position-class-fields-main-successor.ts",
        bytes: 12936,
        sha256: "eccb82c050fcc4aaf7662d3167257fac2ada9e4d134f699ca80f97a0852659ff",
      },
      {
        path: "tests/helpers/ir-position-class-fields-main-successor.json",
        bytes: 5558,
        sha256: "27bfb98ed1ac7a08f285f698426ae0eb9c61ef5e6e433ff1d70288da5295a112",
      },
    ]) {
      const raw = read(pin.path);
      expect(Buffer.byteLength(raw)).toBe(pin.bytes);
      expect(sha(raw)).toBe(pin.sha256);
    }
  });
  it("binds actual1839 to own1838 original1837 delivered-main1838 and downstream1826 custody", () => {
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
      "renamed main row",
      (data: Policy) => {
        data.files[expected.index]!.path += ".lookalike";
      },
    ],
    [
      "changed main ownership",
      (data: Policy) => {
        data.files[expected.index]!.owner = "another-owner";
      },
    ],
    [
      "changed retained own row",
      (data: Policy) => {
        data.files[85]!.layer = "ir-core";
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
      expect(() => capturePositionClassFieldsMainPredecessorPolicy(mutant)).toThrow(/complete policy profile mismatch/);
      expect(JSON.stringify(witness.current)).toBe(retained);
      healthy();
    });
  for (const name of [
    "extra raw byte",
    "changed retained raw byte",
    "old as current",
    "delivered main only",
    "raw prefix",
    "raw whitespace",
  ] as const)
    it(`refuses raw ${name} after healthy capture and accepts restoration`, () => {
      const witness = healthy();
      const mutant =
        name === "extra raw byte"
          ? witness.raw + "\n"
          : name === "old as current"
            ? witness.beforeRaw
            : name === "delivered main only"
              ? witness.mainRaw
              : name === "raw prefix"
                ? " " + witness.raw
                : name === "raw whitespace"
                  ? witness.raw.replace("  ", "   ")
                  : witness.raw.replace("compiler", "Compiler");
      expect(() => capturePositionClassFieldsMainPredecessorPolicySource(mutant)).toThrow(
        /complete raw source profile mismatch/,
      );
      healthy();
    });
  it("refuses semantic old-as-current and returns detached nested ordinary data", () => {
    const witness = healthy();
    expect(() => capturePositionClassFieldsMainPredecessorPolicy(witness.before)).toThrow(
      /complete policy profile mismatch/,
    );
    expect(() => capturePositionClassFieldsMainPredecessorPolicy(JSON.parse(witness.mainRaw))).toThrow(
      /complete policy profile mismatch/,
    );
    const output = capturePositionClassFieldsMainPredecessorPolicy(witness.current) as Policy;
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
      capturePositionClassFieldsMainPredecessorPolicySource(witness.raw, authority);
      malformed = true;
      expect(() => capturePositionClassFieldsMainPredecessorPolicySource(witness.raw, authority)).toThrow();
      expect(() => capturePositionClassFieldsMainPredecessorPolicy(witness.current, authority)).toThrow();
      malformed = false;
      expect(capturePositionClassFieldsMainPredecessorPolicySource(witness.raw, authority)).toBe(witness.beforeRaw);
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
        expect(() => capturePositionClassFieldsMainPredecessorPolicySource(boxed)).toThrow(/primitive string/);
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
        expect(() => capturePositionClassFieldsMainPredecessorPolicy(mutant)).toThrow();
      }
      expect(touched).toBe(0);
      healthy();
    });
  for (const target of ["current policy", "outer authority"] as const)
    it(`rejects physical ${target} corruption after healthy capture and restores exact bytes`, () => {
      const witness = healthy();
      // "current" is this proof's fixed authentic1839 class-fields epoch.
      // The finally capture in healthy() is outside the original four-read counter.
      const stagingRoot = resolve(import.meta.dirname, "..", ".tmp");
      mkdirSync(stagingRoot, { recursive: true });
      const staging = mkdtempSync(resolve(stagingRoot, "6866-class-fields-1839-"));
      const stagedPolicy = resolve(staging, "policy.json");
      try {
        writeFileSync(stagedPolicy, Buffer.from(witness.raw));
        const readOperand = () => readFileSync(stagedPolicy, "utf8");
        expect(readOperand()).toBe(witness.raw);
        const url =
          target === "current policy"
            ? stagedPolicy
            : new URL(`../${positionClassFieldsMainSuccessorReceiptPath}`, import.meta.url);
        const original = readFileSync(url);
        let reads = 0;
        const authority = (path: string): string => {
          reads++;
          return read(path);
        };
        expect(capturePositionClassFieldsMainPredecessorPolicySource(readOperand(), authority)).toBe(witness.beforeRaw);
        try {
          writeFileSync(url, Buffer.concat([original, Buffer.from("\n")]));
          expect(readFileSync(url)).not.toEqual(original);
          if (target === "current policy") {
            expect(() => capturePositionClassFieldsMainPredecessorPolicySource(readOperand(), authority)).toThrow(
              /complete raw source profile mismatch/,
            );
            // Preserve valid JSON while refusing the semantic current profile too.
            const mutant = JSON.parse(readOperand()) as Policy;
            mutant.files[expected.index]!.owner = "physically-read-mutant";
            writeFileSync(url, JSON.stringify(mutant));
            expect(() => capturePositionClassFieldsMainPredecessorPolicy(JSON.parse(readOperand()), authority)).toThrow(
              /complete policy profile mismatch/,
            );
          } else {
            expect(() => capturePositionClassFieldsMainPredecessorPolicySource(readOperand(), authority)).toThrow(
              /fixed receipt pin mismatch/,
            );
            expect(() => capturePositionClassFieldsMainPredecessorPolicy(JSON.parse(readOperand()), authority)).toThrow(
              /fixed receipt pin mismatch/,
            );
          }
        } finally {
          writeFileSync(url, original);
        }
        expect(readFileSync(url)).toEqual(original);
        expect(capturePositionClassFieldsMainPredecessorPolicySource(readOperand(), authority)).toBe(witness.beforeRaw);
        expect(reads).toBe(4);
        healthy();
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    });
});
