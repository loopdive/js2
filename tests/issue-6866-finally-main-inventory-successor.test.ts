// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capturePositionFinallyMainPredecessorPolicy,
  capturePositionFinallyMainPredecessorPolicySource,
  positionFinallyMainSuccessorReceiptPath,
} from "./helpers/ir-position-finally-main-successor.js";
import {
  captureMainInventoryPredecessorPolicy,
  captureMainInventoryPredecessorPolicySource,
} from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureSourceMapPositionInventoryPredecessorPolicy,
  captureSourceMapPositionInventoryPredecessorPolicySource,
} from "./helpers/ir-source-map-position-inventory-successor.js";
import {
  capturePositionClassFieldsMainPredecessorPolicy,
  capturePositionClassFieldsMainPredecessorPolicySource,
} from "./helpers/ir-position-class-fields-main-successor.js";
// Independent fixed observations of the actual source; receipt contents are never the oracle.
const expected = {
  before: {
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
  current: {
    source: {
      bytes: 589117,
      sha256: "58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857",
      gitBlob: "e775a64483ace95ca46b0d65221cff9cf84c4500",
    },
    dataSha256: "fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368",
    filesSha256: "b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92",
    fileCount: 1840,
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
  index: 982,
  row: {
    path: "src/codegen/statements/finally-private-local.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "5267",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
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
  offset: 363627,
  insertion:
    '    {\n      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
  deliveredMain: {
    beforeRevision: "cdc0255882d45181072342d9fd57f291aca93092",
    currentRevision: "bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1",
    before: {
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
    current: {
      source: {
        bytes: 588997,
        sha256: "69eaf95c6d675c48c2bb092603c50779309976ec0373d0370a93ed7068445828",
        gitBlob: "44a73c9b98929ae8da309cc3721a3dcf029b618a",
      },
      dataSha256: "972ca4eca855effd6e8536e67f73b25994e0162e39519ce776f6c6d6e97512a4",
      filesSha256: "cd57b430bf595951d2bebbac4ccb21c8a538180b4274cc62a8633bcb4207c73b",
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
    index: 981,
    offset: 363507,
    insertion:
      '    {\n      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
  },
  ownIndex: 85,
  ownOffset: 82745,
  ownInsertion:
    '    {\n      "path": "src/ir/program/source-map-position.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n',
  ownRow: {
    path: "src/ir/program/source-map-position.ts",
    state: "clean",
    layer: "ir-program",
  },
  ownPrevious: {
    path: "src/ir/program/errors.ts",
    state: "clean",
    layer: "ir-program",
  },
  ownNext: {
    path: "src/ir/program/data.ts",
    state: "clean",
    layer: "ir-program",
  },
  retainedClassIndex: 1649,
  innerClassOutput: {
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
  innerOwnOutput: {
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
} as const;
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
type Policy = Record<string, unknown> & { files: Record<string, unknown>[] };
interface FixedProfile {
  readonly source: { readonly bytes: number; readonly sha256: string; readonly gitBlob: string };
  readonly dataSha256: string;
  readonly filesSha256: string;
  readonly fileCount: number;
  readonly topLevelKeys: readonly string[];
}
function profilePin(raw: string, pin: FixedProfile): Policy {
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
  const raw = read("scripts/compiler-boundaries.json");
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
  // Independently replay cdc→bba using the literal position row and finally span.
  const own = Buffer.from(expected.ownInsertion);
  expect(own).toHaveLength(120);
  expect(before.files[expected.ownIndex]).toEqual(expected.ownRow);
  expect(before.files[expected.ownIndex - 1]).toEqual(expected.ownPrevious);
  expect(before.files[expected.ownIndex + 1]).toEqual(expected.ownNext);
  const prepared = Buffer.from(beforeRaw);
  expect(prepared.subarray(expected.ownOffset, expected.ownOffset + own.length)).toEqual(own);
  const cdcRaw = Buffer.concat([
    prepared.subarray(0, expected.ownOffset),
    prepared.subarray(expected.ownOffset + own.length),
  ]).toString("utf8");
  const cdc = profilePin(cdcRaw, expected.deliveredMain.before);
  const cdcBytes = Buffer.from(cdcRaw);
  const mainRaw = Buffer.concat([
    cdcBytes.subarray(0, expected.deliveredMain.offset),
    insertion,
    cdcBytes.subarray(expected.deliveredMain.offset),
  ]).toString("utf8");
  const main = profilePin(mainRaw, expected.deliveredMain.current);
  expect(main.files[expected.deliveredMain.index]).toEqual(expected.row);
  const retainedMain = structuredClone(main);
  retainedMain.files.splice(expected.deliveredMain.index, 1);
  expect(retainedMain).toEqual(cdc);
  const mainBytes = Buffer.from(mainRaw);
  expect(
    Buffer.concat([mainBytes.subarray(0, expected.ownOffset), own, mainBytes.subarray(expected.ownOffset)]).toString(
      "utf8",
    ),
  ).toBe(raw);
  return { raw, current, beforeRaw, before, cdcRaw, mainRaw };
}
function healthy() {
  const witness = independent();
  const trace: string[] = [];
  const authority = (path: string): string => {
    trace.push(path);
    return read(path);
  };
  expect(capturePositionFinallyMainPredecessorPolicySource(witness.raw, authority)).toBe(witness.beforeRaw);
  const data = capturePositionFinallyMainPredecessorPolicy(witness.current, authority);
  expect(data).toEqual(witness.before);
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(Object.getPrototypeOf((data.files as object[])[0])).toBe(Object.prototype);
  expect(trace).toEqual([positionFinallyMainSuccessorReceiptPath, positionFinallyMainSuccessorReceiptPath]);
  const classRaw = capturePositionClassFieldsMainPredecessorPolicySource(witness.beforeRaw);
  const classData = capturePositionClassFieldsMainPredecessorPolicy(data);
  expect(classData).toEqual(profilePin(classRaw, expected.innerClassOutput));
  const ownRaw = captureSourceMapPositionInventoryPredecessorPolicySource(classRaw);
  expect(captureSourceMapPositionInventoryPredecessorPolicy(classData)).toEqual(
    profilePin(ownRaw, expected.innerOwnOutput),
  );
  expect(captureMainInventoryPredecessorPolicySource(ownRaw)).toHaveLength(584712);
  expect(
    captureMainInventoryPredecessorPolicy(captureSourceMapPositionInventoryPredecessorPolicy(classData))
      .files as unknown[],
  ).toHaveLength(1826);
  return witness;
}
describe("delivered finally main row position inventory independent proof", () => {
  it("independently pins the complete finite helper and receipt", () => {
    for (const pin of [
      {
        path: "tests/helpers/ir-position-finally-main-successor.ts",
        bytes: 12880,
        sha256: "ddb8b30d41ebcf440570f9d974cbf8f2591bd604e2662ab20b043623b353c21d",
      },
      {
        path: "tests/helpers/ir-position-finally-main-successor.json",
        bytes: 5518,
        sha256: "af42a17b8b56046ba1b145568746c253156e95a1f3522342779cf1d843a29fa2",
      },
    ]) {
      const raw = read(pin.path);
      expect(Buffer.byteLength(raw)).toBe(pin.bytes);
      expect(sha(raw)).toBe(pin.sha256);
    }
  });
  it("binds actual1840 to prepared1839 inner1838 original1837 cdc-to-bba lineage and downstream1826 custody", () => {
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
      "changed finally state",
      (data: Policy) => {
        data.files[expected.index]!.state = "clean";
      },
    ],
    [
      "changed finally nextBoundary",
      (data: Policy) => {
        data.files[expected.index]!.nextBoundary = "changed";
      },
    ],
    [
      "changed retained class-fields row",
      (data: Policy) => {
        data.files[expected.retainedClassIndex]!.owner = "changed";
      },
    ],
    [
      "changed previous neighbor",
      (data: Policy) => {
        data.files[expected.index - 1]!.owner = "changed";
      },
    ],
    [
      "changed next neighbor",
      (data: Policy) => {
        data.files[expected.index + 1]!.owner = "changed";
      },
    ],
    [
      "missing top-level key",
      (data: Policy) => {
        Reflect.deleteProperty(data, "description");
      },
    ],
    [
      "unknown top-level key",
      (data: Policy) => {
        data.unknown = true;
      },
    ],
    [
      "reordered top-level keys",
      (data: Policy) => {
        const description = data.description;
        Reflect.deleteProperty(data, "description");
        data.description = description;
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
      expect(() => capturePositionFinallyMainPredecessorPolicy(mutant)).toThrow(/complete policy profile mismatch/);
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
      expect(() => capturePositionFinallyMainPredecessorPolicySource(mutant)).toThrow(
        /complete raw source profile mismatch/,
      );
      healthy();
    });
  it("refuses semantic old-as-current and returns detached nested ordinary data", () => {
    const witness = healthy();
    expect(() => capturePositionFinallyMainPredecessorPolicy(witness.before)).toThrow(
      /complete policy profile mismatch/,
    );
    expect(() => capturePositionFinallyMainPredecessorPolicy(JSON.parse(witness.mainRaw))).toThrow(
      /complete policy profile mismatch/,
    );
    const output = capturePositionFinallyMainPredecessorPolicy(witness.current) as Policy;
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
      capturePositionFinallyMainPredecessorPolicySource(witness.raw, authority);
      malformed = true;
      expect(() => capturePositionFinallyMainPredecessorPolicySource(witness.raw, authority)).toThrow();
      expect(() => capturePositionFinallyMainPredecessorPolicy(witness.current, authority)).toThrow();
      malformed = false;
      expect(capturePositionFinallyMainPredecessorPolicySource(witness.raw, authority)).toBe(witness.beforeRaw);
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
        expect(() => capturePositionFinallyMainPredecessorPolicySource(boxed)).toThrow(/primitive string/);
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
        expect(() => capturePositionFinallyMainPredecessorPolicy(mutant)).toThrow();
      }
      expect(touched).toBe(0);
      healthy();
    });
  for (const target of ["current policy", "outer authority"] as const)
    it(`rejects physical ${target} corruption after healthy capture and restores exact bytes`, () => {
      const witness = healthy();
      const path =
        target === "current policy" ? "scripts/compiler-boundaries.json" : positionFinallyMainSuccessorReceiptPath;
      const url = new URL(`../${path}`, import.meta.url);
      const original = readFileSync(url);
      let reads = 0;
      const authority = (path: string): string => {
        reads++;
        return read(path);
      };
      expect(
        capturePositionFinallyMainPredecessorPolicySource(read("scripts/compiler-boundaries.json"), authority),
      ).toBe(witness.beforeRaw);
      try {
        writeFileSync(url, Buffer.concat([original, Buffer.from("\n")]));
        expect(readFileSync(url)).not.toEqual(original);
        if (target === "current policy") {
          expect(() =>
            capturePositionFinallyMainPredecessorPolicySource(read("scripts/compiler-boundaries.json"), authority),
          ).toThrow(/complete raw source profile mismatch/);
          // Preserve valid JSON while refusing the semantic current profile too.
          const mutant = JSON.parse(read("scripts/compiler-boundaries.json")) as Policy;
          mutant.files[expected.index]!.owner = "physically-read-mutant";
          writeFileSync(url, JSON.stringify(mutant));
          expect(() =>
            capturePositionFinallyMainPredecessorPolicy(
              JSON.parse(read("scripts/compiler-boundaries.json")),
              authority,
            ),
          ).toThrow(/complete policy profile mismatch/);
        } else {
          expect(() =>
            capturePositionFinallyMainPredecessorPolicySource(read("scripts/compiler-boundaries.json"), authority),
          ).toThrow(/fixed receipt pin mismatch/);
          expect(() =>
            capturePositionFinallyMainPredecessorPolicy(
              JSON.parse(read("scripts/compiler-boundaries.json")),
              authority,
            ),
          ).toThrow(/fixed receipt pin mismatch/);
        }
      } finally {
        writeFileSync(url, original);
      }
      expect(readFileSync(url)).toEqual(original);
      expect(
        capturePositionFinallyMainPredecessorPolicySource(read("scripts/compiler-boundaries.json"), authority),
      ).toBe(witness.beforeRaw);
      expect(reads).toBe(4);
      healthy();
    });
});
