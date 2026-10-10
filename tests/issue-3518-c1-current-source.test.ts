// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  independentPolicyGeometryEpoch,
  independentRemainderPolicyEpoch,
  independentlyAcquirePolicyGeometryEpoch,
  independentlyAcquireRemainderPolicyPrefix,
  independentlyInvertRemainderPolicyBytes,
  independentlyAcquireHistoricalPolicyHelper,
} from "./helpers/ir-independent-policy-history-fixture.js";
import {
  captureSourceMapProgramValidatorRelocation,
  programValidatorRelocationCurrentPaths,
  programValidatorRelocationReceiptPath,
  type ProgramValidatorDonorPath,
} from "./helpers/ir-program-validator-relocation.js";
import {
  authenticateRuntimePreparationPolicyEvolution,
  authenticateCurrentMainInventoryEvolution,
  runtimePreparationRemainderHistoricalSource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  beforeCanonicalInstructionsSource,
  captureC1CurrentPopulation,
  reconstructC1CurrentSources,
  type C1ResolverObservationIO,
} from "./helpers/ir-c1-current-source.js";
import { captureLinearLayoutPredecessor } from "./helpers/ir-lowering-analysis-relocation.js";
import {
  captureC1HistoricalAuthority,
  captureGeometryCurrentMainPredecessorPolicySource,
  c1HistoricalArtifactPath,
} from "./helpers/ir-c1-historical-authority.js";
import {
  reconstructRuntimeProgramRelocationPopulation,
  runtimeProgramRelocationCurrentPaths,
  runtimeProgramRelocationDependencyPaths,
  runtimeProgramRelocationPopulationPaths,
  runtimeProgramRelocationReceiptPath,
} from "./helpers/ir-runtime-program-relocation.js";

afterEach(async () => {
  // Yield between synchronous source proofs so Vitest can process task-update RPCs.
  await setImmediate();
});

// Root replaces this ONE external assertion root after final instrument formatting/manifest assembly.
// A missing freeze is a hard failure, never an alternate accepted manifest.
const independentFreeze: string =
  '{"manifestSha256":"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda","anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\n","anchorPin":{"bytes":194,"sha256":"5ba405e0295edc7723625c3efaf340d609988a65268e905409e9656e8dfc105f","gitBlob":"48041b1231b955022d620fb64a371fdf33ffdd53"},"declarationPin":{"bytes":1633,"sha256":"5294c0fce2be6c6974b61a3686c05e60aa66d5bb4599fc97cb315ee53cab71be","gitBlob":"8c594e598e0d946ed92fd658cbe2efe3063ca2c4"}}';
const root = resolve(import.meta.dirname, "..");
const manifestPath = "tests/helpers/ir-c1-authority.json";
const anchorPath = "tests/helpers/ir-c1-authority-root.ts";
const linearPath = "src/codegen-linear/index.ts";
const digest = (source: string): string => createHash("sha256").update(source).digest("hex");
const read = (path: string): string => {
  const packageRoot = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  return readFileSync(
    path.startsWith("typescript-package/")
      ? resolve(packageRoot, path.slice("typescript-package/".length))
      : resolve(root, path),
    "utf8",
  );
};
function actualIO(): C1ResolverObservationIO {
  return {
    fileExists: (path) => existsSync(path) && statSync(path).isFile(),
    directoryExists: (path) => existsSync(path) && statSync(path).isDirectory(),
    realpath: (path) => realpathSync(path),
  };
}

// The complete authority channel is separate from the independently measured
// thirteen resolver requests/fifty-seven filesystem observations and receipt+46
// population reads. Its explicit order is checked on the coherent current seal.
const historicalLoweringAnalysisAuthorityTrace = [
  "tests/helpers/ir-c1-authority-root.ts",
  "tests/helpers/ir-c1-authority.json",
  "tests/helpers/ir-runtime-program-relocation.ts",
  "tests/helpers/ir-runtime-program-relocation.json",
  "tests/helpers/ir-validation-policy-evolution.ts",
  "tests/helpers/ir-validation-policy-evolution.json",
  "tests/helpers/ir-runtime-program-policy-evolution.json",
  "tests/helpers/ir-runtime-program-policy-well-known-symbols.json",
  "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
  "tests/helpers/ir-runtime-program-policy-runtime-preparation.json",
  "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
  "tests/helpers/ir-runtime-program-policy-host-carrier.json",
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
  "tests/helpers/ir-c1-historical-authority.ts",
  "tests/helpers/ir-c1-current-source.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
  "tests/issue-3518-program-data-contract-boundary.test.ts",
  "tests/issue-3518-program-data-contract-seam.test.ts",
  "tests/issue-3518-program-ownership-runtime-seam.test.ts",
  "tests/issue-3518-program-pre-a-evolution.test.ts",
  "tests/issue-3518-program-initial-graph-evolution.test.ts",
  "tests/issue-3518-runtime-program-relocation.test.ts",
  "tests/issue-3518-runtime-program-policy-evolution.test.ts",
  "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",
  "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
  "tests/fixtures/issue-3518-c1-historical-authority/linear-index.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/runtime-program-relocation.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-data-contract-seam.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-ownership-runtime-seam.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-pre-a-evolution.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-initial-graph-evolution.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/runtime-program-policy-evolution.ts.txt",
  "tests/helpers/ir-program-validator-relocation.ts",
  "tests/helpers/ir-source-map-schema-source-epoch.json",
  "tests/helpers/ir-program-validator-relocation.ts",
  "tests/helpers/ir-lowering-analysis-relocation.ts",
  "tests/helpers/ir-lowering-analysis-relocation.json",
  "src/ir/backend/legality.ts",
  "src/ir/analysis/backend-legality.ts",
  "tests/helpers/ir-source-map-schema-source-epoch.json",
  "tests/helpers/ir-program-validator-relocation.ts",
  "tests/helpers/ir-program-validator-relocation.json",
  "src/ir/program-runtime-demands.ts",
  "src/ir/program/runtime-demands.ts",
  "src/ir/program-runtime-abi.ts",
  "src/ir/program/runtime-abi.ts",
  "src/ir/runtime-program-manifest.ts",
  "src/ir/program/runtime-manifest.ts",
  "src/ir/program-runtime-validation.ts",
  "src/ir/program/runtime-validation.ts",
  "src/ir/program-validation.ts",
  "src/ir/program/validation.ts",
  "src/ir/analysis/linear-memory-plan.ts",
  "tests/helpers/ir-lowering-analysis-relocation.json",
  "src/ir/analysis/contracts/linear-memory-layout.ts",
  "src/checker/oracle-backend.ts",
  "src/codegen-linear/c-abi.ts",
  "src/codegen-linear/refcount/ownership.ts",
  "src/wasm/model/instructions.ts",
  "src/position-map.ts",
  "src/shared/contracts/source-origin.ts",
  "src/ts-api.ts",
  "src/frontend/typescript.ts",
  "tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "package.json",
  "typescript-package/package.json",
] as const;

const artifacts = [
  [linearPath, "linear-index.ts.txt", 224418, "c4648365cfa0fa4526ea64e76cd72b932998a09a4056a8321384b7ef62abbbae"],
  [
    "tests/issue-3518-runtime-program-relocation.test.ts",
    "runtime-program-relocation.test.ts.txt",
    21449,
    "324fa026106c484167f6631158043bf16298d07d6f82f1136808fa07054dcc6b",
  ],
  [
    "tests/issue-3518-program-data-contract-seam.test.ts",
    "program-data-contract-seam.test.ts.txt",
    35973,
    "84f249d70f2546cb9ac025f72c7817d5d58e4950c00691fd585caba7bd0cffda",
  ],
  [
    "tests/issue-3518-program-ownership-runtime-seam.test.ts",
    "program-ownership-runtime-seam.test.ts.txt",
    36546,
    "66dfa1235ce24d821a9530a5c3531b56eef2817033d89f0d3e8109f9ead13220",
  ],
  [
    "tests/issue-3518-program-pre-a-evolution.test.ts",
    "program-pre-a-evolution.test.ts.txt",
    17640,
    "0ee5b4d09d0efd9bd5f084fde4fb87bf316ad4aae85867c30d9903cce9353068",
  ],
  [
    "tests/issue-3518-program-initial-graph-evolution.test.ts",
    "program-initial-graph-evolution.test.ts.txt",
    24556,
    "44f5ac79766e9046aa4ed3ccc32c5e609209d0000ffe4d7b06d9afcc8049c2e6",
  ],
  [
    "tests/helpers/ir-runtime-program-policy-evolution.ts",
    "runtime-program-policy-evolution.ts.txt",
    93405,
    "e243101b31f29b2b4aa2637fdd3f9c814a5b6bada558ce565d3d3c132e71892f",
  ],
] as const;
const instruments = [
  "tests/helpers/ir-c1-historical-authority.ts",
  "tests/helpers/ir-c1-current-source.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
  "tests/issue-3518-program-data-contract-boundary.test.ts",
  "tests/issue-3518-program-data-contract-seam.test.ts",
  "tests/issue-3518-program-ownership-runtime-seam.test.ts",
  "tests/issue-3518-program-pre-a-evolution.test.ts",
  "tests/issue-3518-program-initial-graph-evolution.test.ts",
  "tests/issue-3518-runtime-program-relocation.test.ts",
  "tests/issue-3518-runtime-program-policy-evolution.test.ts",
  "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",
  "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
] as const;
const closurePaths = [
  "src/ir/identity.ts",
  "src/ir/analysis/linear-memory-plan.ts",
  "src/checker/oracle-backend.ts",
  "src/codegen-linear/c-abi.ts",
  "src/codegen-linear/refcount/ownership.ts",
  "src/ir/types.ts",
  "src/wasm/model/instructions.ts",
  "src/position-map.ts",
  "src/shared/contracts/source-origin.ts",
  "src/shared/contracts/ir-unit-inventory.ts",
  "src/ts-api.ts",
  "src/frontend/typescript.ts",
] as const;
const extras = closurePaths.filter((path) => !runtimeProgramRelocationPopulationPaths.includes(path));
const configPaths = ["tsconfig.json", "package.json", "pnpm-lock.yaml"] as const;
const immutableAuthorities = [
  "tests/helpers/ir-runtime-program-relocation.ts",
  "tests/helpers/ir-runtime-program-relocation.json",
  "tests/helpers/ir-validation-policy-evolution.ts",
  "tests/helpers/ir-validation-policy-evolution.json",
  "tests/helpers/ir-runtime-program-policy-evolution.json",
  "tests/helpers/ir-runtime-program-policy-well-known-symbols.json",
  "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
  "tests/helpers/ir-runtime-program-policy-runtime-preparation.json",
  "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
  "tests/helpers/ir-runtime-program-policy-host-carrier.json",
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
] as const;
const resolverRequests = [
  ["src/codegen-linear/index.ts", "../ir/identity.js", "repository", "src/ir/identity.ts"],
  [
    "src/codegen-linear/index.ts",
    "../ir/analysis/linear-memory-plan.js",
    "repository",
    "src/ir/analysis/linear-memory-plan.ts",
  ],
  ["src/codegen-linear/index.ts", "./c-abi.js", "repository", "src/codegen-linear/c-abi.ts"],
  ["src/codegen-linear/index.ts", "../checker/oracle-backend.js", "repository", "src/checker/oracle-backend.ts"],
  ["src/ir/identity.ts", "../position-map.js", "repository", "src/position-map.ts"],
  [
    "src/ir/identity.ts",
    "../shared/contracts/ir-unit-inventory.js",
    "repository",
    "src/shared/contracts/ir-unit-inventory.ts",
  ],
  ["src/ir/identity.ts", "../ts-api.js", "repository", "src/ts-api.ts"],
  ["src/codegen-linear/c-abi.ts", "../ir/types.js", "repository", "src/ir/types.ts"],
  ["src/codegen-linear/c-abi.ts", "./refcount/ownership.js", "repository", "src/codegen-linear/refcount/ownership.ts"],
  ["src/ir/types.ts", "../wasm/model/instructions.js", "repository", "src/wasm/model/instructions.ts"],
  ["src/position-map.ts", "./shared/contracts/source-origin.js", "repository", "src/shared/contracts/source-origin.ts"],
  ["src/ts-api.ts", "./frontend/typescript.js", "repository", "src/frontend/typescript.ts"],
  ["src/frontend/typescript.ts", "typescript", "typescript-package", "lib/typescript.d.ts"],
] as const;
function replaced(path: string, source: string): (request: string) => string {
  return (request) => (request === path ? source : read(request));
}
function replaceOnce(source: string, old: string, next: string): string {
  const at = source.indexOf(old);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(old, at + old.length)).toBe(-1);
  expect(next).not.toBe(old);
  return source.slice(0, at) + next + source.slice(at + old.length);
}
function pin(source: string) {
  return {
    bytes: Buffer.byteLength(source),
    sha256: digest(source),
    gitBlob: createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
  };
}
function manifest() {
  if (independentFreeze.includes("ROOT_FREEZE_REQUIRED"))
    throw new Error("ROOT_FREEZE_REQUIRED: independent manifest/anchor/declaration assertion root incomplete");
  const expected = JSON.parse(independentFreeze) as {
    manifestSha256: string;
    anchorSource: string;
    anchorPin: ReturnType<typeof pin>;
    declarationPin: ReturnType<typeof pin>;
  };
  expect(digest(read(manifestPath))).toBe(expected.manifestSha256);
  const historicalAnchor = Buffer.from(read(anchorPath)).subarray(0, expected.anchorPin.bytes).toString("utf8");
  expect(historicalAnchor).toBe(expected.anchorSource);
  expect(pin(historicalAnchor)).toEqual(expected.anchorPin);
  return { expected, data: JSON.parse(read(manifestPath)) };
}

// Independent physical geometry authority. Historical fixtures below are derived only after this replay.
const geometryReceiptPath = "tests/helpers/ir-linear-layout-geometry-successor.json";
const sharedGeometryPath = "src/shared/contracts/linear-memory-layout.ts";
const completeGeometryImplementationPin = {
  bytes: 35439,
  sha256: "87bf7de1961b821cf303b5d7e686a5e44614b08b7b371ee6afe4a16172a7851e",
  gitBlob: "4260f7bdb92344a9b20427b75113020b6d9e31a9",
};
const geometryReceiptPin = {
  bytes: 69621,
  sha256: "e4af32c53ea548b693fbcee78c55b3af47b7985e2dc1b340ddf9c28e0a8f573f",
  gitBlob: "2ad1d8ef1c76fb3cfe9dfa951ccf826f4e03c010",
};
const actualGeometryPins = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 45359,
    sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
    gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 3161,
    sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",
    gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",
  },
  {
    path: "src/shared/contracts/linear-memory-layout.ts",
    bytes: 7580,
    sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",
    gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",
  },
] as const;
const geometryBeforePins = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
    gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 4763,
    sha256: "977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754",
    gitBlob: "280a72ab47f43584f93efb664e3e64b55dc896b5",
  },
] as const;
const forwardingBeforePin = {
  bytes: 4670,
  sha256: "dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72",
  gitBlob: "cac9d1e33659380a6ee8d8e03014af53e1123533",
};
const geometryReadOrder = [
  geometryReceiptPath,
  ...actualGeometryPins.map((entry) => entry.path),
  "tests/helpers/ir-lowering-analysis-relocation.json",
] as const;
type GeometryPin = { bytes: number; sha256: string; gitBlob: string };
type GeometryCopy = {
  kind: "copy";
  name: string;
  path: string;
  offset: number;
  length: number;
  sourceSha256: string;
  outputOffset: number;
};
type GeometryLiteral = { kind: "literal"; name: string; text: string; outputOffset: number };
type GeometryRecipe = { path: string; pin: GeometryPin; pieces: (GeometryCopy | GeometryLiteral)[] };
type GeometryCoverage = { path: string; spans: { offset: number; length: number; sha256: string; uses: number }[] };
type GeometryReceipt = {
  schema: string;
  sourceBase: string;
  currentInputs: typeof actualGeometryPins;
  geometryBeforeInputs: typeof geometryBeforePins;
  sharedAbsentBefore: boolean;
  oldAuthority: {
    helperPrefix: { path: string; bytes: number; sha256: string };
    receipt: GeometryPin & { path: string };
  };
  geometry: {
    inverse: GeometryRecipe[];
    inverseCoverage: GeometryCoverage[];
    forward: GeometryRecipe[];
    forwardCoverage: GeometryCoverage[];
  };
  forwarding: {
    commit: string;
    parent: string;
    path: string;
    offset: number;
    length: number;
    beforePin: GeometryPin;
    afterPin: GeometryPin;
    inverseText: string;
    forwardText: string;
  };
};
function geometryBytePin(bytes: Buffer): GeometryPin {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitBlob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  };
}
function requireGeometryPin(bytes: Buffer, expected: GeometryPin): void {
  expect(geometryBytePin(bytes)).toEqual({ bytes: expected.bytes, sha256: expected.sha256, gitBlob: expected.gitBlob });
}
function independentlyReplayGeometry(
  recipes: GeometryRecipe[],
  coverage: GeometryCoverage[],
  sources: ReadonlyMap<string, Buffer>,
  expected: readonly (GeometryPin & { path: string })[],
): Map<string, Buffer> {
  expect(recipes.map((entry) => entry.path)).toEqual(expected.map((entry) => entry.path));
  expect(coverage.map((entry) => entry.path)).toEqual([...sources.keys()]);
  const copied: GeometryCopy[] = [];
  const outputs = new Map<string, Buffer>();
  for (const [index, recipe] of recipes.entries()) {
    expect(recipe.pin).toEqual({
      bytes: expected[index]!.bytes,
      sha256: expected[index]!.sha256,
      gitBlob: expected[index]!.gitBlob,
    });
    let cursor = 0;
    const pieces: Buffer[] = [];
    for (const piece of recipe.pieces) {
      expect(piece.outputOffset).toBe(cursor);
      expect(typeof piece.name).toBe("string");
      expect(piece.name.length).toBeGreaterThan(0);
      let value: Buffer;
      if (piece.kind === "copy") {
        const donor = sources.get(piece.path);
        expect(donor).toBeDefined();
        if (!donor) throw new Error("independent geometry donor outside closed source domain: " + piece.path);
        expect(Number.isSafeInteger(piece.offset) && piece.offset >= 0).toBe(true);
        expect(Number.isSafeInteger(piece.length) && piece.length > 0).toBe(true);
        expect(piece.offset + piece.length).toBeLessThanOrEqual(donor.length);
        value = donor.subarray(piece.offset, piece.offset + piece.length);
        expect(createHash("sha256").update(value).digest("hex")).toBe(piece.sourceSha256);
        copied.push(piece);
      } else {
        expect(piece.kind).toBe("literal");
        value = Buffer.from(piece.text, "utf8");
        expect(value.toString("utf8")).toBe(piece.text);
        expect(value.length).toBeGreaterThan(0);
      }
      pieces.push(value);
      cursor += value.length;
    }
    const output = Buffer.concat(pieces);
    requireGeometryPin(output, expected[index]!);
    expect(outputs.has(recipe.path)).toBe(false);
    outputs.set(recipe.path, output);
  }
  // Every input byte has one explicit coverage interval, including discarded/introduced spans with zero use.
  for (const row of coverage) {
    const source = sources.get(row.path)!;
    let cursor = 0;
    for (const span of row.spans) {
      expect(span.offset).toBe(cursor);
      expect(Number.isSafeInteger(span.length) && span.length > 0).toBe(true);
      const end = span.offset + span.length;
      expect(end).toBeLessThanOrEqual(source.length);
      expect(createHash("sha256").update(source.subarray(span.offset, end)).digest("hex")).toBe(span.sha256);
      const users = copied.filter(
        (piece) => piece.path === row.path && piece.offset < end && piece.offset + piece.length > span.offset,
      );
      for (const piece of users) {
        expect(piece.offset).toBeLessThanOrEqual(span.offset);
        expect(piece.offset + piece.length).toBeGreaterThanOrEqual(end);
      }
      expect(users).toHaveLength(span.uses);
      cursor = end;
    }
    expect(cursor).toBe(source.length);
  }
  return outputs;
}
function independentGeometryViews(readCurrent: (path: string) => string) {
  const receiptBytes = Buffer.from(readCurrent(geometryReceiptPath));
  requireGeometryPin(receiptBytes, geometryReceiptPin);
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as GeometryReceipt;
  expect(Object.keys(receipt)).toEqual([
    "schema",
    "sourceBase",
    "currentInputs",
    "geometryBeforeInputs",
    "sharedAbsentBefore",
    "oldAuthority",
    "geometry",
    "forwarding",
  ]);
  expect(receipt.schema).toBe("ir-linear-layout-geometry-successor-v1");
  expect(receipt.sourceBase).toBe("b932e3a05e353acc59e7b547ef4e417a5d8637e1");
  expect(receipt.currentInputs).toEqual(actualGeometryPins);
  expect(receipt.geometryBeforeInputs).toEqual(geometryBeforePins);
  expect(receipt.sharedAbsentBefore).toBe(true);
  expect(receipt.oldAuthority.helperPrefix).toEqual({
    path: "tests/helpers/ir-lowering-analysis-relocation.ts",
    bytes: 18956,
    sha256: "253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99",
  });
  const current = new Map(
    actualGeometryPins.map((entry) => {
      const source = Buffer.from(readCurrent(entry.path));
      requireGeometryPin(source, entry);
      return [entry.path, source] as const;
    }),
  );
  const oldReceipt = Buffer.from(readCurrent(receipt.oldAuthority.receipt.path));
  requireGeometryPin(oldReceipt, {
    bytes: 111423,
    sha256: "dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134",
    gitBlob: "6fee96e10bb22a1f3071ddc41b4a2af39ee96763",
  });
  const before = independentlyReplayGeometry(
    receipt.geometry.inverse,
    receipt.geometry.inverseCoverage,
    current,
    geometryBeforePins,
  );
  const forward = independentlyReplayGeometry(
    receipt.geometry.forward,
    receipt.geometry.forwardCoverage,
    before,
    actualGeometryPins,
  );
  for (const [path, source] of current) expect(forward.get(path)).toEqual(source);
  const forwarding = receipt.forwarding;
  expect([forwarding.commit, forwarding.parent, forwarding.path, forwarding.offset, forwarding.length]).toEqual([
    "2a98b75de993bdc568e3668a2965c026876fe322",
    "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",
    "src/ir/analysis/contracts/linear-memory-layout.ts",
    2820,
    93,
  ]);
  const layout = before.get(forwarding.path)!;
  requireGeometryPin(layout, geometryBeforePins[1]);
  expect(forwarding.afterPin).toEqual({
    bytes: geometryBeforePins[1].bytes,
    sha256: geometryBeforePins[1].sha256,
    gitBlob: geometryBeforePins[1].gitBlob,
  });
  expect(forwarding.beforePin).toEqual(forwardingBeforePin);
  const inverseSpan = Buffer.from(forwarding.inverseText);
  expect(inverseSpan).toHaveLength(93);
  expect(layout.subarray(2820, 2913)).toEqual(inverseSpan);
  const loweringLayout = Buffer.concat([layout.subarray(0, 2820), layout.subarray(2913)]);
  requireGeometryPin(loweringLayout, forwardingBeforePin);
  // Authored forward operand is read separately; never manufacture it from the inverse result.
  const forwardSpan = Buffer.from(forwarding.forwardText);
  expect(forwardSpan).toHaveLength(93);
  expect(Buffer.concat([loweringLayout.subarray(0, 2820), forwardSpan, loweringLayout.subarray(2820)])).toEqual(layout);
  return {
    currentPlanner: current.get(actualGeometryPins[0].path)!.toString("utf8"),
    currentLayout: current.get(actualGeometryPins[1].path)!.toString("utf8"),
    currentShared: current.get(actualGeometryPins[2].path)!.toString("utf8"),
    geometryBeforePlanner: before.get(geometryBeforePins[0].path)!.toString("utf8"),
    geometryBeforeLayout: layout.toString("utf8"),
    loweringBeforePlanner: before.get(geometryBeforePins[0].path)!.toString("utf8"),
    loweringBeforeLayout: loweringLayout.toString("utf8"),
  };
}

// ROOT supplies this final literal after reviewing the seven-row v2 receipt and complete root.
// Candidate authoring pins are kept in the private packet, never promoted to trusted expectations here.
const independentNumberPredecessorFreeze: string =
  '{"receiptPin":{"bytes":225765,"sha256":"6282c645887c98e2d7bd2e194d61c9d78e72518510e3e2334b370e3a6837bcd7","gitBlob":"0f19d3721c377ac1b1469896361c541de662a5a6"},"anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\nexport const c1GeometrySuccessorSha256 = \\"6282c645887c98e2d7bd2e194d61c9d78e72518510e3e2334b370e3a6837bcd7\\";\\n","anchorPin":{"bytes":303,"sha256":"6ff696fc5384e3369112ae585290ee74755c2013d13d644b9fba8ef3e8747842","gitBlob":"b23d9ff1b6aa2767eb5a191ba9a123e1104f4f95"},"instruments":[{"path":"tests/helpers/ir-c1-historical-authority.ts","currentPin":{"bytes":96713,"sha256":"cc4ef7be19720ccf45e3cdd857ff373a9a770460c81cdc2bf8b1f7460754c8c3","gitBlob":"79854cea40345e4b216cc6781d6193552988531b"}},{"path":"tests/helpers/ir-c1-current-source.ts","currentPin":{"bytes":53563,"sha256":"a766bff19e173800163e596d6f0a0adc0c2a7c7c32992dafbd30217135c4e6c1","gitBlob":"f9ec52eac7b94cc9c47287578593e4cb13a19a23"}},{"path":"tests/helpers/ir-runtime-program-policy-evolution.ts","currentPin":{"bytes":411837,"sha256":"8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c","gitBlob":"15ae96d3887a5eb61fc6404df098d58f0d96b2f4"}},{"path":"tests/issue-3518-program-data-contract-boundary.test.ts","currentPin":{"bytes":33840,"sha256":"24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469","gitBlob":"18a17efe93db58ab5f6f0322f845c92e86859d41"}},{"path":"tests/issue-3518-runtime-program-policy-evolution.test.ts","currentPin":{"bytes":29161,"sha256":"a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1","gitBlob":"43d2493da1d08c890841f03774f5e664731a82f6"}},{"path":"tests/issue-3518-well-known-symbol-policy-evolution.test.ts","currentPin":{"bytes":29764,"sha256":"fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4","gitBlob":"a009cd0ffbd2f91d971dada7abbf239c557d79d8"}},{"path":"tests/issue-3518-number-prerequisite-policy-evolution.test.ts","currentPin":{"bytes":113131,"sha256":"81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae","gitBlob":"4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84"}}]}';
// Independently authored from complete reviewed N2/H1b/R2/A2 files; prior R1/A1 literal above remains evidence.
const independentThirteenSuccessorFreeze: string =
  '{"receiptPin":{"bytes":234263,"sha256":"f0c041143521b640edfab049fe71e97c13430b4c559063c05b857266e61c0126","gitBlob":"87ae00a5a9930af9d77af61cecb17894497076cf"},"anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\nexport const c1GeometrySuccessorSha256 = \\"f0c041143521b640edfab049fe71e97c13430b4c559063c05b857266e61c0126\\";\\n","anchorPin":{"bytes":303,"sha256":"c8522cf112584bdcdf0e2184c5cd59a108827ac121c5bdf794d8cecf709dc4ca","gitBlob":"e404102a8712f058059ca84d068fe0af774deccf"},"instruments":[{"path":"tests/helpers/ir-c1-historical-authority.ts","currentPin":{"bytes":96713,"sha256":"7bbfaf6687f7411147f00833380027d3959b743ec7dc033fc9bba8d69849992b","gitBlob":"c59701cc36595cea2536c35edcc1e42278ba3e5c"}},{"path":"tests/helpers/ir-c1-current-source.ts","currentPin":{"bytes":53563,"sha256":"a766bff19e173800163e596d6f0a0adc0c2a7c7c32992dafbd30217135c4e6c1","gitBlob":"f9ec52eac7b94cc9c47287578593e4cb13a19a23"}},{"path":"tests/helpers/ir-runtime-program-policy-evolution.ts","currentPin":{"bytes":411837,"sha256":"8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c","gitBlob":"15ae96d3887a5eb61fc6404df098d58f0d96b2f4"}},{"path":"tests/issue-3518-program-data-contract-boundary.test.ts","currentPin":{"bytes":33840,"sha256":"24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469","gitBlob":"18a17efe93db58ab5f6f0322f845c92e86859d41"}},{"path":"tests/issue-3518-runtime-program-policy-evolution.test.ts","currentPin":{"bytes":29161,"sha256":"a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1","gitBlob":"43d2493da1d08c890841f03774f5e664731a82f6"}},{"path":"tests/issue-3518-well-known-symbol-policy-evolution.test.ts","currentPin":{"bytes":29764,"sha256":"fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4","gitBlob":"a009cd0ffbd2f91d971dada7abbf239c557d79d8"}},{"path":"tests/issue-3518-number-prerequisite-policy-evolution.test.ts","currentPin":{"bytes":116007,"sha256":"546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea","gitBlob":"1fb4a992f18ccad293e3030d9f0d88c40d40d78a"}}]}';
// ROOT final fourteen-epoch source/receipt/root association remains failclosed until review.
const independentFourteenSuccessorFreeze: string =
  '{"receiptPin":{"bytes":237358,"sha256":"d69e2ec8aa386c3a5a4b8879ebafd1a6950285f2669da4301e60f900c2e49a7d","gitBlob":"59898a6a9f2c46c2600a67b55af05f9a276eeb81"},"anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\nexport const c1GeometrySuccessorSha256 = \\"d69e2ec8aa386c3a5a4b8879ebafd1a6950285f2669da4301e60f900c2e49a7d\\";\\n","anchorPin":{"bytes":303,"sha256":"55325cd807e4959c30626261f033d182fd9d3f6f046dadf25d74b665630ad8ff","gitBlob":"57b625c3178fa30505fa08d73b335a1eb5c7e05e"},"instruments":[{"path":"tests/helpers/ir-c1-historical-authority.ts","currentPin":{"bytes":97604,"sha256":"42e63830cb48f96803360cf051981b28368bfcb3f1675a32a0f29ff02e5e3e2b","gitBlob":"3a2ef83e164a4128f6b284739be0e25d1242a19f"}},{"path":"tests/helpers/ir-c1-current-source.ts","currentPin":{"bytes":53563,"sha256":"a766bff19e173800163e596d6f0a0adc0c2a7c7c32992dafbd30217135c4e6c1","gitBlob":"f9ec52eac7b94cc9c47287578593e4cb13a19a23"}},{"path":"tests/helpers/ir-runtime-program-policy-evolution.ts","currentPin":{"bytes":411837,"sha256":"8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c","gitBlob":"15ae96d3887a5eb61fc6404df098d58f0d96b2f4"}},{"path":"tests/issue-3518-program-data-contract-boundary.test.ts","currentPin":{"bytes":33840,"sha256":"24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469","gitBlob":"18a17efe93db58ab5f6f0322f845c92e86859d41"}},{"path":"tests/issue-3518-runtime-program-policy-evolution.test.ts","currentPin":{"bytes":29161,"sha256":"a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1","gitBlob":"43d2493da1d08c890841f03774f5e664731a82f6"}},{"path":"tests/issue-3518-well-known-symbol-policy-evolution.test.ts","currentPin":{"bytes":29764,"sha256":"fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4","gitBlob":"a009cd0ffbd2f91d971dada7abbf239c557d79d8"}},{"path":"tests/issue-3518-number-prerequisite-policy-evolution.test.ts","currentPin":{"bytes":116007,"sha256":"546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea","gitBlob":"1fb4a992f18ccad293e3030d9f0d88c40d40d78a"}}]}';
const independentCurrentSuccessorFreeze: string =
  '{"receiptPin":{"bytes":257831,"sha256":"5dfc7f4216ae2699e2efcad01ae1ba4b0d35b754a651155683db60a089ad4b3f","gitBlob":"66c6cb4b635f5174c4f9bd0b4d0b199c9106883e"},"anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\nexport const c1GeometrySuccessorSha256 = \\"5dfc7f4216ae2699e2efcad01ae1ba4b0d35b754a651155683db60a089ad4b3f\\";\\n","anchorPin":{"bytes":303,"sha256":"d916f416c7f39d139f01511849f39f0f5be86f7e17867c4d6f9e7b0b2bf83abd","gitBlob":"a3cd9c287c9151537163605fa1e49b43abb5e6ee"},"instruments":[{"path":"tests/helpers/ir-c1-historical-authority.ts","currentPin":{"bytes":103380,"sha256":"52c3cc6514ae8f1084dd154a94d7dca34c061a6e45baedf1d8bc094aac526b8e","gitBlob":"13581c9dd08696c08ba660fe433bc4a9b0fbe2cf"}},{"path":"tests/helpers/ir-c1-current-source.ts","currentPin":{"bytes":53563,"sha256":"a766bff19e173800163e596d6f0a0adc0c2a7c7c32992dafbd30217135c4e6c1","gitBlob":"f9ec52eac7b94cc9c47287578593e4cb13a19a23"}},{"path":"tests/helpers/ir-runtime-program-policy-evolution.ts","currentPin":{"bytes":411837,"sha256":"8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c","gitBlob":"15ae96d3887a5eb61fc6404df098d58f0d96b2f4"}},{"path":"tests/issue-3518-program-data-contract-boundary.test.ts","currentPin":{"bytes":33840,"sha256":"24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469","gitBlob":"18a17efe93db58ab5f6f0322f845c92e86859d41"}},{"path":"tests/issue-3518-runtime-program-policy-evolution.test.ts","currentPin":{"bytes":29161,"sha256":"a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1","gitBlob":"43d2493da1d08c890841f03774f5e664731a82f6"}},{"path":"tests/issue-3518-well-known-symbol-policy-evolution.test.ts","currentPin":{"bytes":29764,"sha256":"fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4","gitBlob":"a009cd0ffbd2f91d971dada7abbf239c557d79d8"}},{"path":"tests/issue-3518-number-prerequisite-policy-evolution.test.ts","currentPin":{"bytes":116007,"sha256":"546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea","gitBlob":"1fb4a992f18ccad293e3030d9f0d88c40d40d78a"}}]}';
const independentCurrentAuthorityTrace: string =
  '["tests/helpers/ir-c1-authority-root.ts","tests/helpers/ir-c1-authority.json","tests/helpers/ir-runtime-program-relocation.ts","tests/helpers/ir-runtime-program-relocation.json","tests/helpers/ir-validation-policy-evolution.ts","tests/helpers/ir-validation-policy-evolution.json","tests/helpers/ir-runtime-program-policy-evolution.json","tests/helpers/ir-runtime-program-policy-well-known-symbols.json","tests/helpers/ir-runtime-program-policy-number-prerequisites.json","tests/helpers/ir-runtime-program-policy-runtime-preparation.json","tests/helpers/ir-runtime-program-policy-dynamic-code.json","tests/helpers/ir-runtime-program-policy-host-carrier.json","tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json","tests/helpers/ir-c1-historical-authority.ts","tests/helpers/ir-c1-authority-root.ts","tests/helpers/ir-c1-linear-layout-geometry-successor.json","tests/helpers/ir-c1-current-source.ts","tests/helpers/ir-runtime-program-policy-evolution.ts","tests/issue-3518-program-data-contract-boundary.test.ts","tests/issue-3518-program-data-contract-seam.test.ts","tests/issue-3518-program-ownership-runtime-seam.test.ts","tests/issue-3518-program-pre-a-evolution.test.ts","tests/issue-3518-program-initial-graph-evolution.test.ts","tests/issue-3518-runtime-program-relocation.test.ts","tests/issue-3518-runtime-program-policy-evolution.test.ts","tests/issue-3518-well-known-symbol-policy-evolution.test.ts","tests/issue-3518-number-prerequisite-policy-evolution.test.ts","tests/fixtures/issue-3518-c1-historical-authority/linear-index.ts.txt","tests/fixtures/issue-3518-c1-historical-authority/runtime-program-relocation.test.ts.txt","tests/fixtures/issue-3518-c1-historical-authority/program-data-contract-seam.test.ts.txt","tests/fixtures/issue-3518-c1-historical-authority/program-ownership-runtime-seam.test.ts.txt","tests/fixtures/issue-3518-c1-historical-authority/program-pre-a-evolution.test.ts.txt","tests/fixtures/issue-3518-c1-historical-authority/program-initial-graph-evolution.test.ts.txt","tests/fixtures/issue-3518-c1-historical-authority/runtime-program-policy-evolution.ts.txt","tests/helpers/ir-program-validator-relocation.ts","tests/helpers/ir-source-map-schema-source-epoch.json","tests/helpers/ir-program-validator-relocation.ts","tests/helpers/ir-lowering-analysis-relocation.ts","tests/helpers/ir-lowering-analysis-relocation.json","src/ir/backend/legality.ts","src/ir/analysis/backend-legality.ts","tests/helpers/ir-source-map-schema-source-epoch.json","tests/helpers/ir-program-validator-relocation.ts","tests/helpers/ir-program-validator-relocation.json","src/ir/program-runtime-demands.ts","src/ir/program/runtime-demands.ts","src/ir/program-runtime-abi.ts","src/ir/program/runtime-abi.ts","src/ir/runtime-program-manifest.ts","src/ir/program/runtime-manifest.ts","src/ir/program-runtime-validation.ts","src/ir/program/runtime-validation.ts","src/ir/program-validation.ts","src/ir/program/validation.ts","src/ir/analysis/linear-memory-plan.ts","tests/helpers/ir-lowering-analysis-relocation.ts","tests/helpers/ir-linear-layout-geometry-successor.json","src/ir/analysis/linear-memory-plan.ts","src/ir/analysis/contracts/linear-memory-layout.ts","src/shared/contracts/linear-memory-layout.ts","tests/helpers/ir-lowering-analysis-relocation.json","src/checker/oracle-backend.ts","src/codegen-linear/c-abi.ts","tests/helpers/ir-c1-authority-root.ts","tests/helpers/ir-c1-linear-layout-geometry-successor.json","src/codegen-linear/c-abi.ts","src/codegen-linear/refcount/ownership.ts","src/wasm/model/instructions.ts","src/position-map.ts","src/shared/contracts/source-origin.ts","src/ts-api.ts","src/frontend/typescript.ts","tsconfig.json","package.json","pnpm-lock.yaml","package.json","typescript-package/package.json"]';
const successorReceiptPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";
const successorInstrumentPaths = [
  "tests/helpers/ir-c1-historical-authority.ts",
  "tests/helpers/ir-c1-current-source.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
  "tests/issue-3518-program-data-contract-boundary.test.ts",
  "tests/issue-3518-runtime-program-policy-evolution.test.ts",
  "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",
  "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
] as const;
type SuccessorSpan = { inputOffset: number; outputOffset: number; from: string; to: string };
type SuccessorInstrument = {
  path: string;
  beforePin: GeometryPin;
  currentPin: GeometryPin;
  inverse: SuccessorSpan[];
  forward: SuccessorSpan[];
};
type SuccessorSource = {
  path: string;
  beforePin: GeometryPin;
  currentPin: GeometryPin;
  epochs: {
    commit: string;
    parent: string;
    beforePin: GeometryPin;
    currentPin: GeometryPin;
    inverse: SuccessorSpan[];
    forward: SuccessorSpan[];
  }[];
};
type CurrentSuccessorFreeze = {
  receiptPin: GeometryPin;
  anchorSource: string;
  anchorPin: GeometryPin;
  instruments: { path: string; currentPin: GeometryPin }[];
};
function currentSuccessorFreeze(): CurrentSuccessorFreeze {
  if (independentCurrentSuccessorFreeze.includes("ROOT_FINAL_V2")) throw new Error(independentCurrentSuccessorFreeze);
  const expected = JSON.parse(independentCurrentSuccessorFreeze) as CurrentSuccessorFreeze;
  expect(expected.instruments.map((entry) => entry.path)).toEqual(successorInstrumentPaths);
  expect(expected.anchorPin.bytes).toBe(303);
  return expected;
}
function currentAuthorityTrace(): readonly string[] {
  if (independentCurrentAuthorityTrace.includes("ROOT_MEASURED")) throw new Error(independentCurrentAuthorityTrace);
  return JSON.parse(independentCurrentAuthorityTrace) as string[];
}
function authenticateCurrentH1Implementation(): void {
  const expected = currentSuccessorFreeze().instruments[0]!;
  // Only the physical implementation is gated here; supplied authority/source mutants retain their real internal guard.
  const source = read(expected.path);
  if (
    pin(source).bytes !== expected.currentPin.bytes ||
    pin(source).sha256 !== expected.currentPin.sha256 ||
    pin(source).gitBlob !== expected.currentPin.gitBlob
  )
    throw new Error("external C1 implementation full pin: " + expected.path);
}
function currentHistoricalAuthority(...args: Parameters<typeof captureC1HistoricalAuthority>) {
  authenticateCurrentH1Implementation();
  return captureC1HistoricalAuthority(...args);
}
function currentPopulationCapture(...args: Parameters<typeof captureC1CurrentPopulation>) {
  authenticateCurrentH1Implementation();
  return captureC1CurrentPopulation(...args);
}
function currentSourceReconstruction(...args: Parameters<typeof reconstructC1CurrentSources>) {
  authenticateCurrentH1Implementation();
  return reconstructC1CurrentSources(...args);
}
function compositionRequire(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error("independent C1 Number composition: " + label);
}
function compositionPrimitiveBytes(source: string): Buffer {
  compositionRequire(typeof source === "string", "primitive source required");
  const bytes = Buffer.from(source, "utf8");
  compositionRequire(bytes.toString("utf8") === source, "source UTF-8 round-trip required");
  return bytes;
}
function compositionOwnDataRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  compositionRequire(typeof value === "object" && value !== null && !Array.isArray(value), label + " record");
  const actual = Reflect.ownKeys(value);
  compositionRequire(
    actual.length === keys.length && actual.every((key, index) => key === keys[index]),
    label + " keys",
  );
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    compositionRequire(descriptor !== undefined && Object.hasOwn(descriptor, "value"), label + " own data " + key);
    result[key] = descriptor.value;
  }
  return result;
}
function independentlyReplaySuccessorSpans(
  source: string,
  spans: readonly SuccessorSpan[],
  label: string,
  target: GeometryPin,
): string {
  const targetBytes = target.bytes;
  const input = compositionPrimitiveBytes(source),
    output: Buffer[] = [];
  compositionRequire(Number.isSafeInteger(targetBytes) && targetBytes >= 0, label + " fixed target size");
  compositionRequire(Array.isArray(spans) && spans.length > 0, label + " empty recipe");
  let inputCursor = 0,
    outputCursor = 0,
    previousInputStart = -1,
    previousOutputStart = -1;
  for (let index = 0; index < spans.length; index += 1) {
    const element = Object.getOwnPropertyDescriptor(spans, String(index));
    compositionRequire(element !== undefined && Object.hasOwn(element, "value"), label + " own data span");
    const span = compositionOwnDataRecord(
      element.value,
      ["inputOffset", "outputOffset", "from", "to"],
      label + " span",
    );
    const inputStart = span.inputOffset,
      outputStart = span.outputOffset;
    compositionRequire(typeof inputStart === "number" && Number.isSafeInteger(inputStart), label + " input integer");
    compositionRequire(typeof outputStart === "number" && Number.isSafeInteger(outputStart), label + " output integer");
    compositionRequire(
      inputStart > previousInputStart && inputStart >= inputCursor,
      label + " strictly increasing input starts",
    );
    compositionRequire(
      outputStart > previousOutputStart && outputStart >= outputCursor,
      label + " strictly increasing output starts",
    );
    compositionRequire(inputStart <= input.length, label + " input bound");
    compositionRequire(outputStart <= targetBytes, label + " fixed output start bound");
    const unchanged = input.subarray(inputCursor, inputStart);
    const unchangedEnd = outputCursor + unchanged.length;
    compositionRequire(
      Number.isSafeInteger(unchangedEnd) && unchangedEnd <= targetBytes,
      label + " fixed unchanged output bound",
    );
    compositionRequire(outputStart === unchangedEnd, label + " output coordinate");
    const from = compositionPrimitiveBytes(span.from as string),
      to = compositionPrimitiveBytes(span.to as string);
    const inputEnd = inputStart + from.length,
      outputEnd = outputStart + to.length;
    compositionRequire(Number.isSafeInteger(inputEnd) && inputEnd <= input.length, label + " fragment input bound");
    compositionRequire(
      Number.isSafeInteger(outputEnd) && outputEnd <= targetBytes,
      label + " fixed replacement output bound",
    );
    compositionRequire(input.subarray(inputStart, inputEnd).equals(from), label + " exact fragment");
    compositionRequire(!from.equals(to), label + " unchanged edit");
    output.push(unchanged, to);
    inputCursor = inputEnd;
    outputCursor = outputEnd;
    previousInputStart = inputStart;
    previousOutputStart = outputStart;
  }
  const tail = input.subarray(inputCursor),
    finalEnd = outputCursor + tail.length;
  compositionRequire(Number.isSafeInteger(finalEnd) && finalEnd === targetBytes, label + " fixed final tail bound");
  output.push(tail);
  const bytes = Buffer.concat(output),
    result = bytes.toString("utf8");
  compositionRequire(compositionPrimitiveBytes(result).equals(bytes), label + " output UTF-8 round-trip");
  return result;
}

function independentlyAcquireSuccessor() {
  const expected = currentSuccessorFreeze();
  expect(pin(read(anchorPath))).toEqual(expected.anchorPin);
  expect(read(anchorPath)).toBe(expected.anchorSource);
  const { data, expected: historical } = manifest();
  expect(read(anchorPath).slice(0, historical.anchorPin.bytes)).toBe(historical.anchorSource);
  const text = read(successorReceiptPath);
  expect(pin(text)).toEqual(expected.receiptPin);
  const receipt = JSON.parse(text) as {
    schema: string;
    predecessorManifestSha256: string;
    instruments: SuccessorInstrument[];
    linearOptions: typeof data.linearOptions;
    cabiSource: SuccessorSource;
    policySource: SuccessorSource;
  };
  expect(Object.keys(receipt)).toEqual([
    "schema",
    "predecessorManifestSha256",
    "instruments",
    "linearOptions",
    "cabiSource",
    "policySource",
  ]);
  expect(receipt.schema).toBe("ir-c1-linear-layout-geometry-prerequisites-successor-v2");
  expect(receipt.predecessorManifestSha256).toBe(historical.manifestSha256);
  expect(receipt.instruments.map((entry) => entry.path)).toEqual(successorInstrumentPaths);
  const originalPublished = new Map<string, string>();
  for (const [index, entry] of receipt.instruments.entries()) {
    expect(Object.keys(entry)).toEqual(["path", "beforePin", "currentPin", "inverse", "forward"]);
    const original = data.currentInstruments.find((record: { path: string }) => record.path === entry.path);
    expect(original).toBeDefined();
    expect(entry.beforePin).toEqual(original.pin);
    expect(entry.currentPin).toEqual(expected.instruments[index]!.currentPin);
    const physical = read(entry.path);
    expect(pin(physical)).toEqual(expected.instruments[index]!.currentPin);
    const before = independentlyReplaySuccessorSpans(physical, entry.inverse, "inverse " + entry.path, original.pin);
    expect(pin(before)).toEqual(original.pin);
    const forward = independentlyReplaySuccessorSpans(
      before,
      entry.forward,
      "forward " + entry.path,
      expected.instruments[index]!.currentPin,
    );
    expect(pin(forward)).toEqual(expected.instruments[index]!.currentPin);
    expect(forward).toBe(physical);
    originalPublished.set(entry.path, before);
  }
  return { receipt, originalPublished };
}
function independentSuccessorSourceBefore(source: string, record: SuccessorSource): string {
  expect(pin(source)).toEqual(record.currentPin);
  let before = source;
  for (const epoch of [...record.epochs].reverse()) {
    expect(pin(before)).toEqual(epoch.currentPin);
    before = independentlyReplaySuccessorSpans(
      before,
      epoch.inverse,
      "inverse " + record.path + " " + epoch.commit,
      epoch.beforePin,
    );
    expect(pin(before)).toEqual(epoch.beforePin);
  }
  expect(pin(before)).toEqual(record.beforePin);
  let forward = before;
  for (const epoch of record.epochs) {
    expect(pin(forward)).toEqual(epoch.beforePin);
    forward = independentlyReplaySuccessorSpans(
      forward,
      epoch.forward,
      "forward " + record.path + " " + epoch.commit,
      epoch.currentPin,
    );
    expect(pin(forward)).toEqual(epoch.currentPin);
  }
  expect(forward).toBe(source);
  return before;
}
// Fixture-owned finite recipes derived from genuine Git operands, independent of helper answers.
// Every acquisition checks complete input/output pins and a separately authored forward recipe.
type IndependentFixtureEpoch = {
  readonly path: string;
  readonly beforePin: GeometryPin;
  readonly currentPin: GeometryPin;
  readonly inverse: readonly SuccessorSpan[];
  readonly forward: readonly SuccessorSpan[];
};
function independentlyAcquireFixtureEpoch(current: string, proof: IndependentFixtureEpoch): string {
  expect(pin(current)).toEqual(proof.currentPin);
  const before = independentlyReplaySuccessorSpans(
    current,
    proof.inverse,
    "fixture inverse " + proof.path,
    proof.beforePin,
  );
  expect(pin(before)).toEqual(proof.beforePin);
  const replay = independentlyReplaySuccessorSpans(
    before,
    proof.forward,
    "fixture forward " + proof.path,
    proof.currentPin,
  );
  expect(pin(replay)).toEqual(proof.currentPin);
  expect(replay).toBe(current);
  return before;
}
const independentProgramDataEpoch = {
  path: "src/ir/program/data.ts",
  beforePin: {
    bytes: 10682,
    sha256: "01cc4349696dca0b0f439e7b639e269a83d99849911a6db963dcc5b4b6ecea16",
    gitBlob: "fd8693ee3c82d08039b91af4d4a1bda408966176",
  },
  currentPin: {
    bytes: 10831,
    sha256: "6010f226a79bef58d1f8a2a84761eca2fa479ca33d5ace96636c75fa58512b06",
    gitBlob: "8f205f87ebe7505cac4539de0f0a2bc15f906ebe",
  },
  inverse: [
    {
      inputOffset: 4946,
      outputOffset: 4946,
      from: 'function isRecursiveIrClassShape(value: object): boolean {\n  const own = (key: PropertyKey): unknown => {\n    const descriptor = Object.getOwnPropertyDescriptor(value, key);\n    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;\n  };\n  const classId = own("classId");\n  return (\n    own(IR_CLASS_SHAPE_CELL) === true &&\n    typeof classId === "string" &&\n    classId.startsWith("ir-class:v1:") &&\n    typeof own("className") === "string" &&\n    Array.isArray(own("fields")) &&\n    Array.isArray(own("methods")) &&\n    Array.isArray(own("constructorParams"))\n  );\n}\n',
      to: 'function isRecursiveIrClassShape(value: object): boolean {\n  const candidate = value as Record<PropertyKey, unknown>;\n  return (\n    candidate[IR_CLASS_SHAPE_CELL] === true &&\n    typeof candidate.classId === "string" &&\n    candidate.classId.startsWith("ir-class:v1:") &&\n    typeof candidate.className === "string" &&\n    Array.isArray(candidate.fields) &&\n    Array.isArray(candidate.methods) &&\n    Array.isArray(candidate.constructorParams)\n  );\n}\n',
    },
  ],
  forward: [
    {
      inputOffset: 4946,
      outputOffset: 4946,
      from: 'function isRecursiveIrClassShape(value: object): boolean {\n  const candidate = value as Record<PropertyKey, unknown>;\n  return (\n    candidate[IR_CLASS_SHAPE_CELL] === true &&\n    typeof candidate.classId === "string" &&\n    candidate.classId.startsWith("ir-class:v1:") &&\n    typeof candidate.className === "string" &&\n    Array.isArray(candidate.fields) &&\n    Array.isArray(candidate.methods) &&\n    Array.isArray(candidate.constructorParams)\n  );\n}\n',
      to: 'function isRecursiveIrClassShape(value: object): boolean {\n  const own = (key: PropertyKey): unknown => {\n    const descriptor = Object.getOwnPropertyDescriptor(value, key);\n    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;\n  };\n  const classId = own("classId");\n  return (\n    own(IR_CLASS_SHAPE_CELL) === true &&\n    typeof classId === "string" &&\n    classId.startsWith("ir-class:v1:") &&\n    typeof own("className") === "string" &&\n    Array.isArray(own("fields")) &&\n    Array.isArray(own("methods")) &&\n    Array.isArray(own("constructorParams"))\n  );\n}\n',
    },
  ],
} as const;
function provedHistoricalGeometry() {
  const expected = independentGeometryViews(read);
  requireGeometryPin(
    Buffer.from(read("tests/helpers/ir-lowering-analysis-relocation.ts")),
    completeGeometryImplementationPin,
  );
  const prefix = Buffer.from(read("tests/helpers/ir-lowering-analysis-relocation.ts")).subarray(0, 18956);
  requireGeometryPin(prefix, {
    bytes: 18956,
    sha256: "253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99",
    gitBlob: "c732f2eb22a127714373bc8fa363514bcf7a818b",
  });
  return expected;
}
// Explicit historical control only: this reader is never substituted into a real current C1/type host.
function historicalAuthorityControlReader(): (path: string) => string {
  const { receipt, originalPublished } = independentlyAcquireSuccessor();
  const geometry = provedHistoricalGeometry();
  const historical = JSON.parse(independentFreeze) as { anchorSource: string };
  const oldCabi = independentSuccessorSourceBefore(read(receipt.cabiSource.path), receipt.cabiSource);
  const views = new Map(originalPublished);
  views.set(anchorPath, historical.anchorSource);
  views.set(actualGeometryPins[0].path, geometry.loweringBeforePlanner);
  views.set(actualGeometryPins[1].path, geometry.loweringBeforeLayout);
  views.set(receipt.cabiSource.path, oldCabi);
  const allowed = new Set<string>([
    ...historicalLoweringAnalysisAuthorityTrace,
    ...runtimeProgramRelocationPopulationPaths,
    runtimeProgramRelocationReceiptPath,
  ]);
  return (path) => {
    if (!allowed.has(path)) throw new Error("historical authority control outside closed domain: " + path);
    return views.has(path) ? views.get(path)! : read(path);
  };
}

describe("C1 independent geometry successor acquisition", () => {
  it("independently inverses all seven actual instruments and forwards each complete physical source", () => {
    const { receipt, originalPublished } = independentlyAcquireSuccessor();
    expect(originalPublished.size).toBe(7);
    const { data } = manifest();
    for (const entry of data.currentInstruments)
      expect(pin(originalPublished.get(entry.path) ?? read(entry.path))).toEqual(entry.pin);
    expect(receipt.instruments.map((entry) => entry.path)).toEqual(successorInstrumentPaths);
  });
  it("keeps original thirteen-request topology separate from the approved current sixteen-request closure", () => {
    const { receipt } = independentlyAcquireSuccessor(),
      { data } = manifest();
    expect(data.linearOptions.resolver.requests).toHaveLength(13);
    expect(data.linearOptions.resolver.observations).toHaveLength(57);
    expect(receipt.linearOptions.resolver.requests).toHaveLength(16);
    expect(receipt.linearOptions.resolver.observations).toHaveLength(66);
    expect(receipt.linearOptions.resolver.requests.slice(0, 13)).toEqual(data.linearOptions.resolver.requests);
    expect(receipt.linearOptions.resolver.observations.slice(0, 57)).toEqual(data.linearOptions.resolver.observations);
    for (const entry of actualGeometryPins)
      expect(receipt.linearOptions.closureInputs.find((row: { path: string }) => row.path === entry.path)).toEqual({
        path: entry.path,
        pin: { bytes: entry.bytes, sha256: entry.sha256, gitBlob: entry.gitBlob },
      });
    expect(pin(read(receipt.cabiSource.path))).toEqual(receipt.cabiSource.currentPin);
    expect(pin(independentSuccessorSourceBefore(read(receipt.cabiSource.path), receipt.cabiSource))).toEqual(
      receipt.cabiSource.beforePin,
    );
    const current = currentHistoricalAuthority(read);
    expect(current.linearOptions.resolver.requests).toHaveLength(16);
    expect(current.linearOptions.resolver.observations).toHaveLength(66);
    // The historical channel is an explicit locally closed control, never the current resolver/type host.
    const historical = currentHistoricalAuthority(historicalAuthorityControlReader());
    expect(historical.linearOptions.resolver.requests).toHaveLength(13);
    expect(historical.linearOptions.resolver.observations).toHaveLength(57);
  });
  it("retains the complete old authority transcript separately from the measured current order", () => {
    expect(historicalLoweringAnalysisAuthorityTrace[0]).toBe(anchorPath);
    expect(historicalLoweringAnalysisAuthorityTrace).not.toContain(successorReceiptPath);
    expect(currentAuthorityTrace()).toContain(successorReceiptPath);
    expect(currentAuthorityTrace()).toContain(sharedGeometryPath);
  });
  it("selects only the forwarding import and refuses absent or ambiguous full import fragments", () => {
    const source = read(actualGeometryPins[1].path);
    const fragment =
      'import type { LinearStorageKind, LinearSizePlan } from "../../../shared/contracts/linear-memory-layout.js";\n';
    const changed =
      'import type { LinearStorageKind, LinearSizePlan } from "../../../shared/contracts/linear-memory-layouu.js";\n';
    const specifier = '"../../../shared/contracts/linear-memory-layout.js"';
    // The specifier occurs twice, but the full type import has exactly one physical occurrence.
    expect(source.split(specifier)).toHaveLength(3);
    expect(source.split(fragment)).toHaveLength(2);
    const mutant = replaceOnce(source, fragment, changed);
    expect(mutant.split(fragment)).toHaveLength(1);
    expect(mutant.split(changed)).toHaveLength(2);
    expect(mutant.split(specifier)).toHaveLength(2);
    expect(mutant.slice(source.indexOf("export type {"))).toBe(source.slice(source.indexOf("export type {")));
    expect(() => replaceOnce(mutant, fragment, changed)).toThrow();
    expect(() => replaceOnce(source + fragment, fragment, changed)).toThrow();
    currentPopulationCapture(read, read);
  });
  it.each([
    [
      "shared pointer constant",
      sharedGeometryPath,
      "export const LINEAR_POINTER_BYTES = 4;",
      "export const LINEAR_POINTER_BYTES = 8;",
    ],
    ["shared readonly member", sharedGeometryPath, "  readonly name: string;", "  name: string;"],
    [
      "IR forwarding import",
      actualGeometryPins[1].path,
      'import type { LinearStorageKind, LinearSizePlan } from "../../../shared/contracts/linear-memory-layout.js";\n',
      'import type { LinearStorageKind, LinearSizePlan } from "../../../shared/contracts/linear-memory-layouu.js";\n',
    ],
    [
      "current planner algorithm",
      actualGeometryPins[0].path,
      "export class LinearMemoryPlan",
      "export class LinearMemoryPlam",
    ],
  ] as const)("refuses a present current geometry fragment independently: %s", (_name, path, before, after) => {
    currentPopulationCapture(read, read);
    const source = read(path),
      mutant = replaceOnce(source, before, after);
    let observed = 0;
    expect(() =>
      currentPopulationCapture(read, (request) => {
        if (request === path) {
          observed++;
          return mutant;
        }
        return read(request);
      }),
    ).toThrow("lowering analysis relocation: full pin changed " + path);
    expect(observed).toBe(path === actualGeometryPins[0].path ? 2 : 1);
    currentPopulationCapture(read, read);
  });
});

describe("C1 historical/current authority separation", () => {
  it("has an independently pinned acyclic freeze with exact artifact/instrument/edit membership", () => {
    const { expected, data } = manifest();
    expect(data.artifacts.map((entry: { logicalPath: string }) => entry.logicalPath)).toEqual(
      artifacts.map(([logical]) => logical),
    );
    expect(data.currentInstruments.map((entry: { path: string }) => entry.path)).toEqual(instruments);
    expect(data.instrumentEdits.map((entry: { path: string }) => entry.path)).toEqual(instruments.slice(2));
    expect(data.immutableAuthorities.map((entry: { path: string }) => entry.path)).toEqual(immutableAuthorities);
    for (const entry of data.currentInstruments) {
      expect([manifestPath, anchorPath, "tests/issue-3518-c1-current-source.test.ts"]).not.toContain(entry.path);
      expect(read(entry.path)).not.toContain(expected.manifestSha256);
    }
    expect(data.linearOptions.declaration.pin).toEqual(expected.declarationPin);
    expect(data.linearOptions.closureInputs.map((entry: { path: string }) => entry.path)).toEqual(closurePaths);
    expect(data.linearOptions.resolver.configInputs.map((entry: { path: string }) => entry.path)).toEqual(configPaths);
    expect(
      data.linearOptions.resolver.requests.map(
        (entry: { containingFile: string; module: string; target: { scope: string; path: string } }) => [
          entry.containingFile,
          entry.module,
          entry.target.scope,
          entry.target.path,
        ],
      ),
    ).toEqual(resolverRequests);
    expect(data.linearOptions.resolver.observations).toHaveLength(57);
    expect(Buffer.byteLength(read(runtimeProgramRelocationReceiptPath))).toBe(680099);
    expect(digest(read(runtimeProgramRelocationReceiptPath))).toBe(
      "aeeae92fa9c31d8d7ae6aa8805c91862cb1fa2b79486fa4d69cce29d7d065763",
    );
    expect(data.population.currentPaths).toEqual(runtimeProgramRelocationCurrentPaths);
    expect(data.population.dependencyPaths).toEqual(runtimeProgramRelocationDependencyPaths);
    expect([data.population.transferCount, data.population.movedCount, data.population.retainedCount]).toEqual([
      91, 12, 79,
    ]);
  });
  it.each(artifacts)("preserves exact full historical bytes for %s", (logical, basename, bytes, sha256) => {
    const authority = currentHistoricalAuthority(read);
    const path = "tests/fixtures/issue-3518-c1-historical-authority/" + basename;
    expect(c1HistoricalArtifactPath(logical)).toBe(path);
    expect(authority.readHistorical(logical)).toBe(read(path));
    expect(Buffer.byteLength(read(path))).toBe(bytes);
    expect(digest(read(path))).toBe(sha256);
  });
  it("independently inverts every recorded edit and replays exact current bytes", () => {
    const { data } = manifest();
    const successor = independentlyAcquireSuccessor();
    for (const edit of data.instrumentEdits) {
      const current = Buffer.from(successor.originalPublished.get(edit.path) ?? read(edit.path));
      expect(pin(current.toString())).toEqual(edit.afterPin);
      let before = Buffer.from(current),
        last = Number.POSITIVE_INFINITY;
      for (const span of [...edit.spans].reverse()) {
        const after = Buffer.from(span.after);
        expect(span.afterOffset + after.length).toBeLessThanOrEqual(last);
        expect(before.subarray(span.afterOffset, span.afterOffset + after.length)).toEqual(after);
        before = Buffer.concat([
          before.subarray(0, span.afterOffset),
          Buffer.from(span.before),
          before.subarray(span.afterOffset + after.length),
        ]);
        last = span.afterOffset;
      }
      expect(pin(before.toString())).toEqual(edit.beforePin);
      let replay = Buffer.from(before);
      for (const span of [...edit.spans].reverse()) {
        const old = Buffer.from(span.before);
        expect(replay.subarray(span.beforeOffset, span.beforeOffset + old.length)).toEqual(old);
        replay = Buffer.concat([
          replay.subarray(0, span.beforeOffset),
          Buffer.from(span.after),
          replay.subarray(span.beforeOffset + old.length),
        ]);
      }
      expect(replay).toEqual(current);
      const currentRow = successor.receipt.instruments.find((entry) => entry.path === edit.path);
      const physicalReplay = currentRow
        ? independentlyReplaySuccessorSpans(
            replay.toString("utf8"),
            currentRow.forward,
            "forward " + edit.path,
            currentRow.currentPin,
          )
        : replay.toString("utf8");
      expect(physicalReplay).toBe(read(edit.path));
      // Exact inversion retains every unchanged interval; archived callers additionally bind their complete originals.
      const archived = artifacts.find(([logical]) => logical === edit.path);
      if (archived) expect(before.toString()).toBe(read(c1HistoricalArtifactPath(archived[0])));
    }
  });
  it("bounds every frozen resolver observation by the independent thirteen-request domain", () => {
    const { data } = manifest();
    const repositoryFiles = new Set<string>(configPaths),
      repositoryDirectories = new Set<string>([""]);
    for (const [containing, , scope, target] of resolverRequests) {
      if (scope === "repository")
        for (const extension of [".ts", ".tsx", ".d.ts", ".js", ".jsx"])
          repositoryFiles.add(target.slice(0, -3) + extension);
      for (const path of [containing, ...(scope === "repository" ? [target] : [])]) {
        let directory = dirname(path);
        while (directory !== ".") {
          repositoryDirectories.add(directory);
          repositoryFiles.add(directory + "/package.json");
          directory = dirname(directory);
        }
      }
    }
    for (const directory of ["src/frontend/node_modules", "src/node_modules", "node_modules"])
      for (const path of [directory, directory + "/@types"]) repositoryDirectories.add(path);
    const packageFiles = new Set([
      "package.json",
      "lib/typescript.ts",
      "lib/typescript.tsx",
      "lib/typescript.d.ts",
      "lib/typescript.js",
      "lib/typescript.jsx",
    ]);
    const packageDirectories = new Set(["", "lib"]);
    const negativePackageProbes = [
      "node_modules/typescript.ts",
      "node_modules/typescript.tsx",
      "node_modules/typescript.d.ts",
    ];
    const allowed = (location: { scope: string; path: string }, files: boolean, directories: boolean): void => {
      expect(["repository", "typescript-package"]).toContain(location.scope);
      const fileSet = location.scope === "repository" ? repositoryFiles : packageFiles;
      const directorySet = location.scope === "repository" ? repositoryDirectories : packageDirectories;
      expect((files && fileSet.has(location.path)) || (directories && directorySet.has(location.path))).toBe(true);
    };
    for (const [ordinal, observation] of data.linearOptions.resolver.observations.entries()) {
      expect(["readFile", "fileExists", "directoryExists", "realpath"]).toContain(observation.operation);
      if (observation.location.scope === "repository" && negativePackageProbes.includes(observation.location.path)) {
        expect(observation.operation).toBe("fileExists");
        expect(observation.exists).toBe(false);
        expect(ordinal).toBe(50 + negativePackageProbes.indexOf(observation.location.path));
        continue;
      }
      allowed(
        observation.location,
        observation.operation !== "directoryExists",
        observation.operation === "directoryExists" || observation.operation === "realpath",
      );
      if (observation.operation === "realpath") allowed(observation.target, true, true);
    }
    expect(data.linearOptions.resolver.observations.slice(50, 53).map((item: any) => item.location.path)).toEqual(
      negativePackageProbes,
    );
    const packageMetadata = JSON.parse(read("typescript-package/package.json"));
    expect([packageMetadata.version, packageMetadata.typings]).toEqual(["5.9.3", "./lib/typescript.d.ts"]);
  });
  it("detaches and deeply freezes every nested contract object on successive captures", () => {
    const first = currentHistoricalAuthority(read),
      second = currentHistoricalAuthority(read);
    expect(second).not.toBe(first);
    expect(second.linearOptions).not.toBe(first.linearOptions);
    expect(second.linearOptions).toEqual(first.linearOptions);
    let count = 0;
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      count++;
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, "__mutant", true)).toBe(false);
      expect(Object.hasOwn(value, "__mutant")).toBe(false);
      for (const item of Object.values(value)) walk(item);
    };
    walk(first.linearOptions);
    expect(count).toBeGreaterThan(30);
  });
  it.each(artifacts)("rejects a warm historical artifact mutation independently: %s", (logical) => {
    currentHistoricalAuthority(read);
    const path = c1HistoricalArtifactPath(logical);
    expect(() => currentHistoricalAuthority(replaced(path, read(path) + "\n// mutant\n"))).toThrow();
  });
  it.each(instruments)("rejects a warm current instrument mutation independently: %s", (path) => {
    currentHistoricalAuthority(read);
    expect(() => currentHistoricalAuthority(replaced(path, read(path) + "\n// mutant\n"))).toThrow();
  });
  it.each(immutableAuthorities)("retains fresh unchanged authority for %s", (path) => {
    currentHistoricalAuthority(read);
    expect(() => currentHistoricalAuthority(replaced(path, read(path) + "\n// mutant\n"))).toThrow();
  });
  it.each([anchorPath, manifestPath])("does not reuse success after %s changes", (path) => {
    currentHistoricalAuthority(read);
    expect(() => currentSourceReconstruction(read, replaced(path, read(path) + "\n"))).toThrow();
  });
  it.each([
    [
      "missing artifact",
      (data: any) => {
        data.artifacts.pop();
      },
    ],
    [
      "duplicate artifact",
      (data: any) => {
        data.artifacts.push(data.artifacts[0]);
      },
    ],
    [
      "path-swapped artifact",
      (data: any) => {
        data.artifacts[0].artifactPath = data.artifacts[1].artifactPath;
      },
    ],
    [
      "missing instrument",
      (data: any) => {
        data.currentInstruments.pop();
      },
    ],
    [
      "duplicate instrument",
      (data: any) => {
        data.currentInstruments.push(data.currentInstruments[0]);
      },
    ],
    [
      "extra contract key",
      (data: any) => {
        data.linearOptions.unknown = true;
      },
    ],
    [
      "missing resolver observation",
      (data: any) => {
        data.linearOptions.resolver.observations.pop();
      },
    ],
  ] as const)("refuses changed manifest authority: %s", (_name, edit) => {
    currentHistoricalAuthority(read);
    const candidate = JSON.parse(read(manifestPath));
    edit(candidate);
    expect(() => currentHistoricalAuthority(replaced(manifestPath, JSON.stringify(candidate)))).toThrow();
  });
});

describe("C1 fresh live source contract bridge", () => {
  it("captures exact receipt+46 population order separately from fresh authority/type reads", () => {
    const population: string[] = [],
      authority: string[] = [];
    const capture = () =>
      currentPopulationCapture(
        (path) => {
          population.push(path);
          return read(path);
        },
        (path) => {
          authority.push(path);
          return read(path);
        },
      );
    const first = capture(),
      second = capture();
    expect(population).toEqual([
      runtimeProgramRelocationReceiptPath,
      ...runtimeProgramRelocationPopulationPaths,
      runtimeProgramRelocationReceiptPath,
      ...runtimeProgramRelocationPopulationPaths,
    ]);
    expect(runtimeProgramRelocationCurrentPaths).toHaveLength(8);
    expect(runtimeProgramRelocationDependencyPaths).toHaveLength(38);
    expect(first.historicalPopulation.size).toBe(46);
    expect([...first.originals.keys()]).toEqual([
      "src/ir/program.ts",
      "src/ir/program-abi-contracts.ts",
      "src/ir/prepared-component-dependencies.ts",
      "src/ir/generator-support.ts",
    ]);
    expect([...second.originals]).toEqual([...first.originals]);
    expect(second.historicalPopulation).not.toBe(first.historicalPopulation);
    expect(authority).toEqual([...currentAuthorityTrace(), ...currentAuthorityTrace()]);
    expect(first.observedCurrentPins).toHaveLength(46);
    expect(extras).toHaveLength(9);
    for (const path of extras)
      expect(authority.filter((item) => item === path)).toHaveLength(
        2 * currentAuthorityTrace().filter((item) => item === path).length,
      );
    // Root's independently measured57-operation transcript reads repository package metadata once per resolver run.
    for (const [path, count] of [
      ["tsconfig.json", 2],
      ["package.json", 4],
      ["pnpm-lock.yaml", 2],
      ["typescript-package/package.json", 2],
    ] as const)
      expect(authority.filter((item) => item === path)).toHaveLength(count);
    // New authority reads are independently counted; the original receipt+46 population channel stays unchanged.
    for (const path of [programValidatorRelocationReceiptPath, ...programValidatorRelocationCurrentPaths])
      expect(authority.filter((item) => item === path)).toHaveLength(2);
    expect(authority.filter((path) => path === sourceMapEpochPath)).toHaveLength(4);
    expect(authority.filter((path) => path === sourceMapComponentPath)).toHaveLength(6);
    const originalReceipt = JSON.parse(first.receiptText);
    expect(originalReceipt.transfers).toHaveLength(91);
    expect(originalReceipt.transfers.filter((item: { moved: boolean }) => item.moved)).toHaveLength(12);
    expect(originalReceipt.transfers.filter((item: { moved: boolean }) => !item.moved)).toHaveLength(79);
  });
  it("independently proves DATA declaration inverse and forward with unchanged bytes outside the declaration", () => {
    const current = read(independentProgramDataEpoch.path);
    const predecessor = independentlyAcquireFixtureEpoch(current, independentProgramDataEpoch);
    const oldBytes = Buffer.from(predecessor),
      currentBytes = Buffer.from(current);
    expect(oldBytes.subarray(0, 4946)).toEqual(currentBytes.subarray(0, 4946));
    expect(oldBytes.subarray(5399)).toEqual(currentBytes.subarray(5548));
    expect(oldBytes.subarray(5399)).toHaveLength(5283);
    const capture = currentPopulationCapture(read, read);
    expect(capture.historicalPopulation.get(independentProgramDataEpoch.path)).toBe(predecessor);
    expect(capture.observedCurrentPins.find((record) => record.path === independentProgramDataEpoch.path)!.pin).toEqual(
      independentProgramDataEpoch.currentPin,
    );
  });
  it.each([0, 4946, 5548] as const)(
    "refuses DATA current byte mutation at %s and retains fresh healthy acquisition",
    (at) => {
      const current = read(independentProgramDataEpoch.path);
      const replacement = current[at] === "x" ? "y" : "x";
      const mutant = current.slice(0, at) + replacement + current.slice(at + 1);
      expect(Buffer.byteLength(mutant)).toBe(Buffer.byteLength(current));
      expect(() => independentlyAcquireFixtureEpoch(mutant, independentProgramDataEpoch)).toThrow();
      expect(() =>
        currentPopulationCapture((path) => (path === independentProgramDataEpoch.path ? mutant : read(path)), read),
      ).toThrow("C1 current source: full pin mismatch: " + independentProgramDataEpoch.path + " program DATA current");
      independentlyAcquireFixtureEpoch(current, independentProgramDataEpoch);
      currentPopulationCapture(read, read);
    },
  );
  it("refuses the genuine DATA predecessor as a current operand while retaining its historical identity", () => {
    const current = read(independentProgramDataEpoch.path);
    const predecessor = independentlyAcquireFixtureEpoch(current, independentProgramDataEpoch);
    expect(() => independentlyAcquireFixtureEpoch(predecessor, independentProgramDataEpoch)).toThrow();
    expect(() =>
      currentPopulationCapture((path) => (path === independentProgramDataEpoch.path ? predecessor : read(path)), read),
    ).toThrow("C1 current source: full pin mismatch: " + independentProgramDataEpoch.path + " program DATA current");
    independentlyAcquireFixtureEpoch(current, independentProgramDataEpoch);
    currentPopulationCapture(read, read);
  });
  it("substitutes only the historical linear dependency and keeps detached mutation on the old guard", () => {
    const capture = currentPopulationCapture(read, read);
    // Preserve the old linear/validator substitutions and independently prove each additional historical source epoch, including DATA.
    const validator = captureSourceMapProgramValidatorRelocation(read);
    const relocated = ["src/ir/program-runtime-abi.ts", "src/ir/program-validation.ts"] as const;
    for (const [path, source] of capture.historicalPopulation)
      if (path === "src/ir/backend/legality.ts") {
        expect(pin(source)).toEqual({
          bytes: 26410,
          sha256: "6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98",
          gitBlob: "d4854103ad1fae2f12c105fc0e1a66e2d20a5c6e",
        });
        expect(source).not.toBe(read(path));
        expect(capture.observedCurrentPins.find((record) => record.path === path)!.pin).toEqual({
          bytes: 5833,
          sha256: "5b67993fe312a0f5a52f9ef816c76a10cd32470f7e2a53819dec736764f45878",
          gitBlob: "c38edb2f3d1350b0ea23f887c9349ac768d48afa",
        });
      } else if (path === "src/ir/types.ts") {
        expect(pin(source)).toEqual({
          bytes: 7744,
          sha256: "d82e92ee276dd9a57bd69d9dee16410d24225a028bd9dca53bc406f69b9623ac",
          gitBlob: "f7717d7c70bb57bd73d799a1d26d1825aa0a41e8",
        });
        expect(source).not.toBe(read(path));
        expect(capture.observedCurrentPins.find((record) => record.path === path)!.pin).toEqual({
          bytes: 7756,
          sha256: "0282ae61c6a43f837a9a3c7b12d879151e67ec155939c541cd9b5ea662979140",
          gitBlob: "bdf9d6ace5f7f5530373cea6007a1ad7dfe905d0",
        });
      } else if (path === independentProgramDataEpoch.path) {
        const current = read(path);
        const predecessor = independentlyAcquireFixtureEpoch(current, independentProgramDataEpoch);
        expect(source).toBe(predecessor);
        expect(pin(source)).toEqual(independentProgramDataEpoch.beforePin);
        expect(source).not.toBe(current);
        expect(pin(current)).toEqual(independentProgramDataEpoch.currentPin);
        expect(capture.observedCurrentPins.find((record) => record.path === path)!.pin).toEqual(
          independentProgramDataEpoch.currentPin,
        );
      } else if (sourceMapPopulationPaths.includes(path)) {
        const proven = independentSourceMapPredecessor(path, read(path));
        expect(source).toBe(proven.before);
        expect(source).not.toBe(read(path));
        expect(capture.observedCurrentPins.find((record) => record.path === path)!.pin).toEqual(proven.currentPin);
      } else if (path !== linearPath)
        expect(source).toBe(
          relocated.includes(path as (typeof relocated)[number])
            ? validator.readBefore(path as ProgramValidatorDonorPath)
            : read(path),
        );
    for (const path of relocated) {
      expect(validator.readCurrent(path)).toBe(read(path));
      const observed = capture.observedCurrentPins.find((record) => record.path === path)!;
      const expectedPin =
        path === "src/ir/program-runtime-abi.ts"
          ? { bytes: 363, sha256: "cec827cc20299610d6351e050cce5e9d3bd5198c9b334eb95253b96372ed7247" }
          : { bytes: 236, sha256: "b64454a7c97179e8efdab677049fb0f231ba3b6ce731bff602b231406d2dd098" };
      expect(observed.pin.bytes).toBe(expectedPin.bytes);
      expect(observed.pin.sha256).toBe(expectedPin.sha256);
    }
    expect(digest(capture.historicalPopulation.get(linearPath)!)).toBe(
      "c4648365cfa0fa4526ea64e76cd72b932998a09a4056a8321384b7ef62abbbae",
    );
    const mutant = new Map(capture.historicalPopulation);
    mutant.set(
      "src/ir/program/owner.ts",
      mutant.get("src/ir/program/owner.ts")! + "\n// mutation after initial capture\n",
    );
    expect(() => reconstructRuntimeProgramRelocationPopulation(mutant, capture.receiptText)).toThrow(/length\/SHA256/);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it.each(runtimeProgramRelocationPopulationPaths.filter((path) => path !== linearPath))(
    "refuses warm full-source mutation of current/dependency %s",
    (path) => {
      currentSourceReconstruction(read, read);
      expect(() => currentSourceReconstruction(replaced(path, read(path) + "\n// mutant\n"), read)).toThrow();
    },
  );
  it.each(extras)("refuses changed additional type owner %s", (path) => {
    expect(currentSourceReconstruction(read, read).size).toBe(4);
    const mutant = read(path) + "\n// mutant\n";
    let mutatedReads = 0;
    const operation = () =>
      currentSourceReconstruction(read, (request) => {
        if (request === path) {
          mutatedReads++;
          return mutant;
        }
        return read(request);
      });
    if (path === "src/ir/analysis/linear-memory-plan.ts")
      expect(operation).toThrow("lowering analysis relocation: full pin changed src/ir/analysis/linear-memory-plan.ts");
    else if (path === "src/codegen-linear/c-abi.ts")
      expect(operation).toThrow("C1 historical authority: full-file pin changed: cabiSource supplied current");
    else expect(operation).toThrow(/full pin mismatch/);
    expect(mutatedReads).toBe(path === "src/ir/analysis/linear-memory-plan.ts" ? 2 : 1);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it.each(configPaths)("refuses changed authenticated resolver config %s", (path) => {
    currentSourceReconstruction(read, read);
    expect(() => currentSourceReconstruction(read, replaced(path, read(path) + "\n"))).toThrow(/full pin mismatch/);
  });
  it("passes an explicit bad receipt operand through to the unchanged guard", () => {
    currentSourceReconstruction(read, read);
    expect(() =>
      currentSourceReconstruction(
        replaced(runtimeProgramRelocationReceiptPath, read(runtimeProgramRelocationReceiptPath) + "\n"),
        read,
      ),
    ).toThrow(/receipt digest/);
  });
  it.each([
    ["optional member", "exposeArenaReset?: boolean;", "exposeArenaReset: boolean;"],
    ["member type", "exposeArenaReset?: boolean;", "exposeArenaReset?: string;"],
    ["readonly member", "exposeArenaReset?: boolean;", "readonly exposeArenaReset?: boolean;"],
    ["getter member", "exposeArenaReset?: boolean;", "get exposeArenaReset(): boolean;"],
    ["generic declaration", "export interface LinearOptions {", "export interface LinearOptions<T> {"],
    ["heritage declaration", "export interface LinearOptions {", "export interface LinearOptions extends Object {"],
    ["nonexported declaration", "export interface LinearOptions {", "interface LinearOptions {"],
    ["renamed declaration", "export interface LinearOptions {", "export interface WrongLinearOptions {"],
    ["import target", 'from "../ir/identity.js";', 'from "../ir/program.js";'],
    ["clause role", "import type { BuildIrUnitInventoryOptions }", "import { BuildIrUnitInventoryOptions }"],
    ["specifier role", "type LinearAllocatorPolicyId }", "LinearAllocatorPolicyId }"],
    [
      "inline import target",
      'import("../checker/oracle-backend.js").OracleBackend',
      'import("../checker/index.js").OracleBackend',
    ],
  ] as const)("refuses changed LinearOptions %s", (_label, before, after) => {
    currentSourceReconstruction(read, read);
    const mutant = replaceOnce(read(linearPath), before, after);
    expect(() => currentSourceReconstruction(replaced(linearPath, mutant), read)).toThrow();
  });
  it.each([
    "\nexport interface LinearOptions {}\n",
    "\nexport type LinearOptions = unknown;\n",
    "\nexport { generateLinearModule as LinearOptions };\n",
    "\nimport type { BuildIrUnitInventoryOptions } from '../ir/identity.js';\n",
    "\ninterface ExternCImportSpec {}\n",
    "\nexport * from '../ir/program.js';\n",
    "\nimport LinearOptions = require('../ir/program.js');\n",
    "\nexport * as LinearOptions from '../ir/program.js';\n",
    "\nconst { LinearOptions } = { LinearOptions: 1 };\n",
    "\nfunction broken( {\n",
  ])("refuses duplicate/alternate/unparsed contract source: %s", (addition) => {
    expect(() => currentSourceReconstruction(replaced(linearPath, read(linearPath) + addition), read)).toThrow();
  });
  it("accepts an unrelated concat-body edit while direct old full-file authentication refuses it", () => {
    const mutant = replaceOnce(
      read(linearPath),
      "linearCoercion.emitStringConcat(ctx, fctx, expr.left, expr.right, TO_STRING_COMPILER);",
      "linearCoercion.emitStringConcat(ctx, fctx, expr.right, expr.left, TO_STRING_COMPILER);",
    );
    const capture = currentPopulationCapture(replaced(linearPath, mutant), read);
    expect(capture.originals.size).toBe(4);
    expect(capture.observedCurrentPins.find((item) => item.path === linearPath)?.pin.sha256).toBe(digest(mutant));
    const direct = new Map(capture.historicalPopulation);
    direct.set(linearPath, mutant);
    expect(() => reconstructRuntimeProgramRelocationPopulation(direct, capture.receiptText)).toThrow(/length\/SHA256/);
  });
  it.each(["src/ir/identity.ts", "src/frontend/typescript.ts"])(
    "refuses a missing resolver-target probe response for %s",
    (path) => {
      currentSourceReconstruction(read, read);
      const actual = actualIO();
      let reached = false;
      const io = {
        ...actual,
        fileExists: (request: string) => {
          if (request === resolve(root, path)) {
            reached = true;
            return false;
          }
          return actual.fileExists(request);
        },
      };
      expect(() => currentSourceReconstruction(read, read, io)).toThrow(/resolver observation/);
      expect(reached).toBe(true);
      expect(currentSourceReconstruction(read, read).size).toBe(4);
    },
  );
  it("refuses a missing resolver-directory probe response", () => {
    currentSourceReconstruction(read, read);
    const actual = actualIO();
    let reached = false;
    const io = {
      ...actual,
      directoryExists: (request: string) => {
        if (request === resolve(root, "src/ir")) {
          reached = true;
          return false;
        }
        return actual.directoryExists(request);
      },
    };
    expect(() => currentSourceReconstruction(read, read, io)).toThrow(/resolver observation/);
    expect(reached).toBe(true);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it("refuses a package that disappears during resolver traversal after real setup validation", () => {
    currentSourceReconstruction(read, read);
    const actual = actualIO();
    let reached = false;
    const io = {
      ...actual,
      directoryExists: (request: string) => {
        if (request === resolve(root, "node_modules/typescript")) {
          reached = true;
          return false;
        }
        return actual.directoryExists(request);
      },
    };
    expect(() => currentSourceReconstruction(read, read, io)).toThrow(/resolver observation/);
    expect(reached).toBe(true);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it.each(["node_modules/typescript.ts", "node_modules/typescript.tsx", "node_modules/typescript.d.ts"])(
    "refuses a newly present earlier shadow target %s",
    (path) => {
      currentSourceReconstruction(read, read);
      const actual = actualIO();
      let reached = false;
      const io = {
        ...actual,
        fileExists: (request: string) => {
          if (request === resolve(root, path)) {
            reached = true;
            return true;
          }
          return actual.fileExists(request);
        },
      };
      expect(() => currentSourceReconstruction(read, read, io)).toThrow(/resolver observation/);
      expect(reached).toBe(true);
      expect(currentSourceReconstruction(read, read).size).toBe(4);
    },
  );
  it("rejects accessor IO without invoking it or accepting extra expected-proof fields", () => {
    currentSourceReconstruction(read, read);
    let getters = 0;
    const accessor = actualIO();
    Object.defineProperty(accessor, "fileExists", {
      enumerable: true,
      get: () => {
        getters++;
        return () => true;
      },
    });
    expect(() => currentSourceReconstruction(read, read, accessor)).toThrow(/resolver IO data-function/);
    expect(getters).toBe(0);
    expect(() =>
      currentSourceReconstruction(read, read, { ...actualIO(), observations: [] } as C1ResolverObservationIO),
    ).toThrow(/resolver IO key membership/);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it.each([Object(true), undefined, "yes"])("requires primitive boolean IO result %s", (value) => {
    expect(currentSourceReconstruction(read, read).size).toBe(4);
    const actual = actualIO();
    let reached = false;
    const io = {
      ...actual,
      fileExists: () => {
        reached = true;
        return value as never;
      },
    };
    expect(() => currentSourceReconstruction(read, read, io)).toThrow(/fileExists primitive boolean/);
    expect(reached).toBe(true);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it("requires an actual absolute primitive realpath result", () => {
    expect(currentSourceReconstruction(read, read).size).toBe(4);
    const actual = actualIO();
    let reached = false;
    const io = {
      ...actual,
      realpath: () => {
        reached = true;
        return "lib/typescript.d.ts";
      },
    };
    expect(() => currentSourceReconstruction(read, read, io)).toThrow(/realpath primitive absolute path/);
    expect(reached).toBe(true);
    expect(currentSourceReconstruction(read, read).size).toBe(4);
  });
  it.each([undefined, Object("source"), 1])("refuses nonprimitive live source %s", (value) => {
    expect(() =>
      currentSourceReconstruction((path) => (path === linearPath ? (value as never) : read(path)), read),
    ).toThrow(/primitive source/);
  });
  it("typechecks actual current and exact historical contracts in both assignment directions", async () => {
    const { expected } = manifest();
    const historical = currentHistoricalAuthority(read).readHistorical(linearPath);
    const parsed = ts.createSourceFile(linearPath, historical, ts.ScriptTarget.Latest, true);
    const declarations = parsed.statements
      .filter(ts.isInterfaceDeclaration)
      .filter((item) => item.name.text === "LinearOptions");
    expect(declarations).toHaveLength(1);
    const declaration = historical.slice(declarations[0]!.getStart(parsed), declarations[0]!.end);
    expect(pin(declaration)).toEqual(expected.declarationPin);
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("native type probe requires owned POSIX process-group termination");
    const scratchRoot = resolve(root, ".tmp");
    mkdirSync(scratchRoot, { recursive: true });
    const directory = mkdtempSync(resolve(scratchRoot, "c1-native-type-probe-"));
    try {
      const historicalFile = resolve(directory, "src/codegen-linear/historical-options.ts");
      const entryFile = resolve(directory, "entry.ts");
      const currentFile = resolve(root, "src/codegen-linear/index.ts");
      mkdirSync(dirname(historicalFile), { recursive: true });
      const forwarders = [
        ["src/ir/identity.ts", "BuildIrUnitInventoryOptions", "src/ir/identity.ts"],
        ["src/ir/analysis/linear-memory-plan.ts", "LinearAllocatorPolicyId", "src/ir/analysis/linear-memory-plan.ts"],
        ["src/codegen-linear/c-abi.ts", "ExternCImportSpec", "src/codegen-linear/c-abi.ts"],
        ["src/checker/oracle-backend.ts", "OracleBackend", "src/checker/oracle-backend.ts"],
      ] as const;
      for (const [scratchPath, name, repositoryPath] of forwarders) {
        const file = resolve(directory, scratchPath);
        const target = resolve(root, repositoryPath);
        expect(statSync(target).isFile()).toBe(true);
        expect(typeof readFileSync(target, "utf8")).toBe("string");
        const relativeModule = relative(dirname(file), target).split(sep).join("/").replace(/\.ts$/, ".js");
        const module = relativeModule.startsWith(".") ? relativeModule : "./" + relativeModule;
        expect(resolve(dirname(file), module.replace(/\.js$/, ".ts"))).toBe(target);
        const source = `export type { ${name} } from "${module}";\n`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
        expect(readFileSync(file, "utf8")).toBe(source);
      }
      const moduleFor = (target: string): string => {
        const path = relative(dirname(entryFile), target).split(sep).join("/").replace(/\.ts$/, ".js");
        return path.startsWith(".") ? path : "./" + path;
      };
      const currentModule = moduleFor(currentFile);
      const historicalModule = moduleFor(historicalFile);
      expect(resolve(dirname(entryFile), currentModule.replace(/\.js$/, ".ts"))).toBe(currentFile);
      expect(resolve(dirname(entryFile), historicalModule.replace(/\.js$/, ".ts"))).toBe(historicalFile);
      const historicalSource = `import type { BuildIrUnitInventoryOptions } from "../ir/identity.js";\nimport type { LinearAllocatorPolicyId } from "../ir/analysis/linear-memory-plan.js";\nimport type { ExternCImportSpec } from "./c-abi.js";\n${declaration}\n`;
      writeFileSync(historicalFile, historicalSource);
      expect(readFileSync(historicalFile, "utf8")).toBe(historicalSource);
      writeFileSync(
        entryFile,
        `import type { LinearOptions as Current } from "${currentModule}";\nimport type { LinearOptions as Historical } from "${historicalModule}";\nfunction assign(current: Current, historical: Historical) { const old: Historical = current; const live: Current = historical; return [old, live]; }\nconst emptyOld: Historical = {}; const emptyLive: Current = {};\n// @ts-expect-error nested required min cannot disappear\nconst oldBad: Historical = { importMemory: { module: "m", name: "memory" } };\n// @ts-expect-error same required min in actual current contract\nconst liveBad: Current = { importMemory: { module: "m", name: "memory" } };\n// @ts-expect-error historical arena flag is boolean\nconst oldType: Historical = { exposeArenaReset: "yes" };\n// @ts-expect-error actual current arena flag is boolean\nconst liveType: Current = { exposeArenaReset: "yes" };\n// @ts-expect-error historical linked heap requires malloc import\nconst oldHeap: Historical = { linkedHeap: { chunkBytes: 64 } };\n// @ts-expect-error actual current linked heap requires malloc import\nconst liveHeap: Current = { linkedHeap: { chunkBytes: 64 } };\nvoid assign; void emptyOld; void emptyLive;\n`,
      );
      const configFile = resolve(directory, "tsconfig.json");
      writeFileSync(
        configFile,
        JSON.stringify({
          extends: resolve(root, "tsconfig.ts7.json"),
          compilerOptions: { rootDir: root, noEmit: true, incremental: false, preserveSymlinks: false },
          files: ["entry.ts"],
          include: [],
          exclude: [],
        }),
      );
      const result = await new Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
        error: Error | undefined;
        output: string;
      }>((resolveChild) => {
        const child = spawn(
          process.execPath,
          [
            resolve(root, "node_modules/typescript7/lib/tsc.js"),
            "--noEmit",
            "--project",
            configFile,
            "--pretty",
            "false",
          ],
          {
            cwd: root,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
          },
        );
        let failure: Error | undefined;
        const chunks: Buffer[] = [];
        let outputBytes = 0;
        const limit = 8 * 1024 * 1024;
        const terminate = (reason: Error): void => {
          failure ??= reason;
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                failure = new Error("native type probe process-group termination failed: " + String(error));
              }
            }
          }
        };
        const timer = setTimeout(() => terminate(new Error("native type probe exceeded 30000 ms")), 30000);
        const collect = (chunk: Buffer): void => {
          const remaining = limit - outputBytes;
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          outputBytes += chunk.length;
          if (outputBytes > limit) terminate(new Error("native type probe exceeded 8 MiB combined output"));
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.stdout.on("error", (error) => terminate(error));
        child.stderr.on("error", (error) => terminate(error));
        child.on("error", (error) => terminate(error));
        child.on("close", (status, signal) => {
          clearTimeout(timer);
          if (signal !== null || status !== 0)
            terminate(new Error("native type probe exited abnormally: " + String(status) + "/" + String(signal)));
          resolveChild({ status, signal, error: failure, output: Buffer.concat(chunks).toString("utf8") });
        });
      });
      expect(result.error, result.output).toBeUndefined();
      expect(result.signal, result.output).toBeNull();
      expect(result.status, result.output).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// These fixed test literals are independent of the production inverse and manifest.
function assertCanonicalTestPin(source: string, expected: ReturnType<typeof pin>, label: string): void {
  if (typeof source !== "string" || JSON.stringify(pin(source)) !== JSON.stringify(expected))
    throw new Error("canonical test full pin mismatch: " + label);
}
function canonicalTestFail(detail: string): never {
  throw new Error("canonical test: " + detail);
}
const canonicalInputEpochs = [
  {
    path: "src/wasm/model/instructions.ts",
    beforePin: {
      bytes: 14904,
      sha256: "b305b96583e473272f26032cd1e4ad4653a32d4f56db74df50dac7f1c2461b6d",
      gitBlob: "699c7b386f529b6017659a2f4b0f3c5671235969",
    },
    currentPin: {
      bytes: 15135,
      sha256: "8c4c9a27c00e57caafe29e64f465b49b6ab13d77744d9d071b80609bb65d4360",
      gitBlob: "d3c10d8a8e4c1ecd45d2a7c13e372daa8ae378d0",
    },
    spans: [
      {
        beforeOffset: 2703,
        afterOffset: 2703,
        before: '  | { kind: "i32"; boolean?: true; symbol?: true }\n',
        after:
          '  // (#6798) `int32` marks a `type i32 = number` destination: an f64 entering it\n  // converts with ToInt32 (wrap, like `x | 0`), not the saturating truncation\n  // the generic f64 → i32 coercion keeps for indices.\n  | { kind: "i32"; boolean?: true; symbol?: true; int32?: true }\n',
      },
    ],
  },
  {
    path: "package.json",
    beforePin: {
      bytes: 29631,
      sha256: "6dcd7ca0c6895e71d3bc3373c05b49b6d6b0a07df8732131386e557d82dc6434",
      gitBlob: "57ab56f8f065cf84e366bc0f61269336444b0b7b",
    },
    currentPin: {
      bytes: 29828,
      sha256: "bc084f6c2a17667e42d0c985330cbe064715984a7007201a5635c1622b10c395",
      gitBlob: "e25ea8aa13863815c93d511ba78f5e629b4b4121",
    },
    spans: [
      {
        beforeOffset: 1789,
        afterOffset: 1789,
        before: '    "binaryen": "^132.0.0",\n    "bun": ">=1.3.14",\n    "deno": ">=2.8.1"\n',
        after: '    "binaryen": "^132.0.0"\n',
      },
      {
        beforeOffset: 1913,
        afterOffset: 1867,
        before: '      "optional": true\n    },\n    "bun": {\n      "optional": true\n    },\n    "deno": {\n',
        after: "",
      },
      {
        beforeOffset: 2282,
        afterOffset: 2149,
        before: '    "build": "vite build --config vite.config.lib.ts && node scripts/build-test262-cli.mjs",\n',
        after:
          '    "build": "vite build --config vite.config.lib.ts && node scripts/prune-dist-declarations.mjs && node scripts/build-test262-cli.mjs",\n',
      },
      {
        beforeOffset: 4780,
        afterOffset: 4691,
        before: "",
        after:
          '    "check:import-cycles": "node scripts/check-import-cycles.mjs",\n    "check:flat-dir-budget": "node scripts/check-flat-dir-budget.mjs",\n',
      },
      {
        beforeOffset: 7427,
        afterOffset: 7476,
        before: "",
        after: '    "check:orphaned-scripts": "node scripts/check-orphaned-scripts.mjs",\n',
      },
      {
        beforeOffset: 8284,
        afterOffset: 8406,
        before: "",
        after: '    "check:tracked-ignored": "node scripts/check-tracked-ignored.mjs",\n',
      },
      {
        beforeOffset: 29143,
        afterOffset: 29336,
        before: '    "vitest": "^3",\n',
        after: '    "vitest": "^3.2.6",\n',
      },
    ],
  },
  {
    path: "pnpm-lock.yaml",
    beforePin: {
      bytes: 292598,
      sha256: "cd18b2b644544c06017f91c790c44156d6ad178e568b5ae2b3746b0740728273",
      gitBlob: "70f62186954477b320c5af66514303e024d8e9c1",
    },
    currentPin: {
      bytes: 292602,
      sha256: "6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac",
      gitBlob: "03fbaf3f914c0dcd1ebbda6a1d2bce86491d0e3a",
    },
    spans: [
      {
        beforeOffset: 3290,
        afterOffset: 3290,
        before:
          "        specifier: ^3\n        version: 3.2.4(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3)\n",
        after:
          "        specifier: ^3.2.6\n        version: 3.2.7(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3)\n",
      },
      {
        beforeOffset: 77978,
        afterOffset: 77982,
        before:
          "  '@vitest/expect@3.2.4':\n    resolution: {integrity: sha512-Io0yyORnB6sikFlt8QW5K7slY4OjqNX9jmJQ02QDda8lyM6B5oNgVWoSoKPac8/kgnCUzuHQKrSLtu/uOqqrig==}\n",
        after:
          "  '@vitest/expect@3.2.7':\n    resolution: {integrity: sha512-E8eBXaKibuvH2pSZErOjdVb5vF4PbKYcrnluBTYxEk1l/VhhwZg1kZQsdtjq+CsF5CFydf2Rdkz7jDHKSisi3w==}\n",
      },
      {
        beforeOffset: 78130,
        afterOffset: 78134,
        before:
          "  '@vitest/mocker@3.2.4':\n    resolution: {integrity: sha512-46ryTE9RZO/rfDd7pEqFl7etuyzekzEhUbTW3BvmeO/BcCMEgq59BKhek3dXDWgAj4oMK6OZi+vRr1wPW6qjEQ==}\n",
        after:
          "  '@vitest/mocker@3.2.7':\n    resolution: {integrity: sha512-Trr0hYO9CM3Wj6ksWHRhK9IZpIY6wTMO5u/MqXurMxT57sWBaOPEtP3Oq60ihZuh5JsiagKfz95OcxdEP6dBrA==}\n",
      },
      {
        beforeOffset: 78458,
        afterOffset: 78462,
        before:
          "  '@vitest/pretty-format@3.2.4':\n    resolution: {integrity: sha512-IVNZik8IVRJRTr9fxlitMKeJeXFFFN0JaB9PHPGQ8NKQbGpfjlTx9zO4RefN8gp7eqjNy8nyK3NZmBzOPeIxtA==}\n",
        after:
          "  '@vitest/pretty-format@3.2.7':\n    resolution: {integrity: sha512-KUHlwqVu0sRlhCdyPdQ/wBoTfRahjUky1MubOmYw9fWfIZy1gNoHpuaaQBPAaMaVYdQYHJLurzj8ECCj5OwTqA==}\n",
      },
      {
        beforeOffset: 78617,
        afterOffset: 78621,
        before:
          "  '@vitest/runner@3.2.4':\n    resolution: {integrity: sha512-oukfKT9Mk41LreEW09vt45f8wx7DordoWUZMYdY/cyAk7w5TWkTRCNZYF7sX7n2wB7jyGAl74OxgwhPgKaqDMQ==}\n",
        after:
          "  '@vitest/runner@3.2.7':\n    resolution: {integrity: sha512-sB9y4ovltoQP+WaUPwmSxO9WIg9Ig694Di5PalVPsYHklAdE027mehpWF2SQSVq+k6sFgaivbTjTJwZLSHbedA==}\n",
      },
      {
        beforeOffset: 78769,
        afterOffset: 78773,
        before:
          "  '@vitest/snapshot@3.2.4':\n    resolution: {integrity: sha512-dEYtS7qQP2CjU27QBC5oUOxLE/v5eLkGqPE0ZKEIDGMs4vKWe7IjgLOeauHsR0D5YuuycGRO5oSRXnwnmA78fQ==}\n",
        after:
          "  '@vitest/snapshot@3.2.7':\n    resolution: {integrity: sha512-7C+MwShwtBSI5Buwoyg3s/iY1eHL9PKAf+O1wVh/TdnjXUtkoL/9YQtre90i4MtNXM6edP1wJ2zOBpfCyhIS7g==}\n",
      },
      {
        beforeOffset: 78923,
        afterOffset: 78927,
        before:
          "  '@vitest/spy@3.2.4':\n    resolution: {integrity: sha512-vAfasCOe6AIK70iP5UD11Ac4siNUNJ9i/9PZ3NKx07sG6sUxeag1LWdNrMWeKKYBLlzuK+Gn65Yd5nyL6ds+nw==}\n",
        after:
          "  '@vitest/spy@3.2.7':\n    resolution: {integrity: sha512-Q2eQGI6d2L/hBtZ0qNuKcAGid68XK6cv1xsoaIma6PaJhHPoqcEJhYpXZ/5myCMqkNgtP6UKuBhbc0nHKnrkuQ==}\n",
      },
      {
        beforeOffset: 79072,
        afterOffset: 79076,
        before:
          "  '@vitest/utils@3.2.4':\n    resolution: {integrity: sha512-fB2V0JFrQSMsCo9HiSq3Ezpdv4iYaXRG1Sx8edX3MwxfyNn83mKiGzOcH+Fkxt4MHxr3y42fQi1oeAInqgX2QA==}\n",
        after:
          "  '@vitest/utils@3.2.7':\n    resolution: {integrity: sha512-x6BDOd7dyo3PFLY3I9/HJ25X/6OurhGXk2/B9gOZNPF7XDVjeBK4k01lQE5uvDpbuheErh91qYuE1E2OEjK3Rw==}\n",
      },
      {
        beforeOffset: 185798,
        afterOffset: 185802,
        before:
          "  vitest@3.2.4:\n    resolution: {integrity: sha512-LUCP5ev3GURDysTWiP47wRRUpLKMOfPh+yKTx3kVIEiu5KOMeqzpnYNsKyOoVrULivR8tLcks4+lga33Whn90A==}\n",
        after:
          "  vitest@3.2.7:\n    resolution: {integrity: sha512-KrxIJ62Fd89gfysR4WotlgZABiz2dqFPgqGzX7s+CwsqLFomRH7777ZcrOD6+WVAh7khPQP41A+BKbpcJFrdEg==}\n",
      },
      {
        beforeOffset: 186142,
        afterOffset: 186146,
        before: "      '@vitest/browser': 3.2.4\n      '@vitest/ui': 3.2.4\n",
        after: "      '@vitest/browser': 3.2.7\n      '@vitest/ui': 3.2.7\n",
      },
      {
        beforeOffset: 229045,
        afterOffset: 229049,
        before: "  '@vitest/expect@3.2.4':\n",
        after: "  '@vitest/expect@3.2.7':\n",
      },
      {
        beforeOffset: 229116,
        afterOffset: 229120,
        before: "      '@vitest/spy': 3.2.4\n      '@vitest/utils': 3.2.4\n",
        after: "      '@vitest/spy': 3.2.7\n      '@vitest/utils': 3.2.7\n",
      },
      {
        beforeOffset: 229216,
        afterOffset: 229220,
        before: "  '@vitest/mocker@3.2.4(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))':\n",
        after: "  '@vitest/mocker@3.2.7(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))':\n",
      },
      {
        beforeOffset: 229333,
        afterOffset: 229337,
        before: "      '@vitest/spy': 3.2.4\n",
        after: "      '@vitest/spy': 3.2.7\n",
      },
      {
        beforeOffset: 229521,
        afterOffset: 229525,
        before: "  '@vitest/pretty-format@3.2.4':\n",
        after: "  '@vitest/pretty-format@3.2.7':\n",
      },
      {
        beforeOffset: 229598,
        afterOffset: 229602,
        before: "  '@vitest/runner@3.2.4':\n",
        after: "  '@vitest/runner@3.2.7':\n",
      },
      {
        beforeOffset: 229642,
        afterOffset: 229646,
        before: "      '@vitest/utils': 3.2.4\n",
        after: "      '@vitest/utils': 3.2.7\n",
      },
      {
        beforeOffset: 229718,
        afterOffset: 229722,
        before: "  '@vitest/snapshot@3.2.4':\n",
        after: "  '@vitest/snapshot@3.2.7':\n",
      },
      {
        beforeOffset: 229764,
        afterOffset: 229768,
        before: "      '@vitest/pretty-format': 3.2.4\n",
        after: "      '@vitest/pretty-format': 3.2.7\n",
      },
      {
        beforeOffset: 229849,
        afterOffset: 229853,
        before: "  '@vitest/spy@3.2.4':\n",
        after: "  '@vitest/spy@3.2.7':\n",
      },
      {
        beforeOffset: 229912,
        afterOffset: 229916,
        before: "  '@vitest/utils@3.2.4':\n",
        after: "  '@vitest/utils@3.2.7':\n",
      },
      {
        beforeOffset: 229955,
        afterOffset: 229959,
        before: "      '@vitest/pretty-format': 3.2.4\n",
        after: "      '@vitest/pretty-format': 3.2.7\n",
      },
      {
        beforeOffset: 288211,
        afterOffset: 288215,
        before: "  vitest@3.2.4(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3):\n",
        after: "  vitest@3.2.7(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3):\n",
      },
      {
        beforeOffset: 288347,
        afterOffset: 288351,
        before:
          "      '@vitest/expect': 3.2.4\n      '@vitest/mocker': 3.2.4(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))\n      '@vitest/pretty-format': 3.2.4\n      '@vitest/runner': 3.2.4\n      '@vitest/snapshot': 3.2.4\n      '@vitest/spy': 3.2.4\n      '@vitest/utils': 3.2.4\n",
        after:
          "      '@vitest/expect': 3.2.7\n      '@vitest/mocker': 3.2.7(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))\n      '@vitest/pretty-format': 3.2.7\n      '@vitest/runner': 3.2.7\n      '@vitest/snapshot': 3.2.7\n      '@vitest/spy': 3.2.7\n      '@vitest/utils': 3.2.7\n",
      },
    ],
  },
] as const;
function canonicalPreviousInput(path: string, source: string): string {
  const record = canonicalInputEpochs.find((entry) => entry.path === path);
  if (!record) canonicalTestFail("unknown canonical input epoch: " + path);
  assertCanonicalTestPin(source, record.currentPin, path);
  const current = Buffer.from(source, "utf8");
  const pieces: Buffer[] = [];
  let cursor = 0;
  let previousBeforeEnd = 0;
  let delta = 0;
  for (const span of record.spans) {
    const before = Buffer.from(span.before, "utf8");
    const after = Buffer.from(span.after, "utf8");
    if (
      span.beforeOffset < previousBeforeEnd ||
      span.afterOffset < cursor ||
      span.afterOffset !== span.beforeOffset + delta ||
      !current.subarray(span.afterOffset, span.afterOffset + after.length).equals(after)
    )
      canonicalTestFail("canonical input epoch span membership: " + path);
    pieces.push(current.subarray(cursor, span.afterOffset), before);
    cursor = span.afterOffset + after.length;
    previousBeforeEnd = span.beforeOffset + before.length;
    delta += after.length - before.length;
  }
  pieces.push(current.subarray(cursor));
  const predecessor = Buffer.concat(pieces);
  assertCanonicalTestPin(predecessor.toString("utf8"), record.beforePin, "canonical input epoch predecessor: " + path);
  const replayPieces: Buffer[] = [];
  cursor = 0;
  for (const span of record.spans) {
    const before = Buffer.from(span.before, "utf8");
    const after = Buffer.from(span.after, "utf8");
    if (!predecessor.subarray(span.beforeOffset, span.beforeOffset + before.length).equals(before))
      canonicalTestFail("canonical input epoch predecessor membership: " + path);
    replayPieces.push(predecessor.subarray(cursor, span.beforeOffset), after);
    cursor = span.beforeOffset + before.length;
  }
  replayPieces.push(predecessor.subarray(cursor));
  const replay = Buffer.concat(replayPieces);
  if (!replay.equals(current)) canonicalTestFail("canonical input epoch reciprocal bytes: " + path);
  assertCanonicalTestPin(replay.toString("utf8"), record.currentPin, "canonical input epoch replay: " + path);
  return predecessor.toString("utf8");
}

function canonicalPreviousPackage(source: string): string {
  return canonicalPreviousInput("package.json", source);
}
// Only the old package positive receives this independently authenticated predecessor view.
function canonicalPreviousPackageContractView(data: ReturnType<typeof JSON.parse>) {
  const record = canonicalInputEpochs[1];
  expect(data.currentBase).toBe("3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8");
  canonicalPreviousPackage(read("package.json"));
  const inputs = data.linearOptions.resolver.configInputs;
  const packageInputs = inputs.filter((input: { path: string }) => input.path === "package.json");
  expect(packageInputs).toHaveLength(1);
  expect(packageInputs[0].pin).toEqual(record.currentPin);
  const observations = data.linearOptions.resolver.observations;
  const packageObservations = observations.filter(
    (item: { operation: string; location: { scope: string; path: string } }) =>
      item.operation === "readFile" && item.location.scope === "repository" && item.location.path === "package.json",
  );
  expect(packageObservations).toEqual([
    { operation: "readFile", location: { scope: "repository", path: "package.json" }, pin: record.currentPin },
  ]);
  return {
    ...data,
    currentBase: "fcf4b188d0bd19f23665a318316af766e641f737",
    linearOptions: {
      ...data.linearOptions,
      resolver: {
        ...data.linearOptions.resolver,
        configInputs: inputs.map((item: { path: string }) =>
          item.path === "package.json" ? { ...item, pin: record.beforePin } : item,
        ),
        observations: observations.map((item: { operation: string; location: { scope: string; path: string } }) =>
          item.operation === "readFile" && item.location.scope === "repository" && item.location.path === "package.json"
            ? { ...item, pin: record.beforePin }
            : item,
        ),
      },
    },
  };
}

// These controls independently fix the package-only epoch; the original 149 rows stay above unchanged.
describe("C1 current-main package script epoch", () => {
  const scriptLine = '    "check:claude-md-paths": "node scripts/check-claude-md-paths.mjs",\n';
  const offset = 8473;
  const currentPin = {
    bytes: 29631,
    sha256: "6dcd7ca0c6895e71d3bc3373c05b49b6d6b0a07df8732131386e557d82dc6434",
    gitBlob: "57ab56f8f065cf84e366bc0f61269336444b0b7b",
  };
  const oldPin = {
    bytes: 29560,
    sha256: "86f91d71aa0d5094ae95368df26379bb4a54e448bad612a07db1f41e5ec356ae",
    gitBlob: "bd4ea397a4ba48ed3ee023adf39ecd9429f2abac",
  };
  const predecessor = (source: string): string => {
    const bytes = Buffer.from(source);
    return Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + 71)]).toString("utf8");
  };
  it("independently proves the exact current script insertion and full inverse/replay", () => {
    const current = canonicalPreviousPackage(read("package.json"));
    expect(pin(current)).toEqual(currentPin);
    const bytes = Buffer.from(current),
      insertion = Buffer.from(scriptLine);
    expect(insertion.length).toBe(71);
    expect(bytes.indexOf(insertion)).toBe(offset);
    expect(bytes.lastIndexOf(insertion)).toBe(offset);
    const old = predecessor(current);
    expect(pin(old)).toEqual(oldPin);
    const oldBytes = Buffer.from(old);
    expect(Buffer.concat([oldBytes.subarray(0, offset), insertion, oldBytes.subarray(offset)]).toString("utf8")).toBe(
      current,
    );
    expect(JSON.parse(current).dependencies).toEqual(JSON.parse(old).dependencies);
    expect(JSON.parse(current).devDependencies).toEqual(JSON.parse(old).devDependencies);
    const oldScripts = JSON.parse(old).scripts;
    const currentScripts = JSON.parse(current).scripts;
    expect(currentScripts["check:claude-md-paths"]).toBe("node scripts/check-claude-md-paths.mjs");
    for (const [name, value] of Object.entries(oldScripts)) expect(currentScripts[name]).toBe(value);
    expect(Object.keys(currentScripts)).toHaveLength(Object.keys(oldScripts).length + 1);
  });
  it("pins the audited current base and measured package read without changing request topology or read counts", () => {
    const data = canonicalPreviousPackageContractView(manifest().data);
    expect(data.currentBase).toBe("fcf4b188d0bd19f23665a318316af766e641f737");
    expect(data.historicalBase).toBe("bfcf326c9426988e66fa6cc446132ed9ad9c1965");
    expect(
      data.linearOptions.resolver.requests.map(
        (request: { containingFile: string; module: string; target: { scope: string; path: string } }) => [
          request.containingFile,
          request.module,
          request.target.scope,
          request.target.path,
        ],
      ),
    ).toEqual(resolverRequests);
    expect(data.linearOptions.resolver.observations).toHaveLength(57);
    expect(
      data.linearOptions.resolver.observations.filter(
        (observation: { operation: string; location: { scope: string; path: string } }) =>
          observation.operation === "readFile" &&
          observation.location.scope === "repository" &&
          observation.location.path === "package.json",
      ),
    ).toEqual([{ operation: "readFile", location: { scope: "repository", path: "package.json" }, pin: currentPin }]);
    expect(
      data.linearOptions.resolver.configInputs.find((input: { path: string }) => input.path === "package.json").pin,
    ).toEqual(currentPin);
    const population: string[] = [],
      authority: string[] = [];
    currentPopulationCapture(
      (path) => {
        population.push(path);
        return read(path);
      },
      (path) => {
        authority.push(path);
        return read(path);
      },
    );
    expect(population).toEqual([runtimeProgramRelocationReceiptPath, ...runtimeProgramRelocationPopulationPaths]);
    expect(population).toHaveLength(47);
    expect(authority.filter((path) => path === "package.json")).toHaveLength(2);
    for (const path of extras)
      expect(authority.filter((item) => item === path)).toHaveLength(
        currentAuthorityTrace().filter((item) => item === path).length,
      );
    expect(authority).toEqual(currentAuthorityTrace());
  });
  it.each([
    ["stale old package", (source: string) => predecessor(source)],
    [
      "changed script command",
      (source: string) =>
        source.replace("node scripts/check-claude-md-paths.mjs", "node scripts/check-claude-md-patht.mjs"),
    ],
    ["duplicate script insertion", (source: string) => source.replace(scriptLine, scriptLine + scriptLine)],
    [
      "extra script",
      (source: string) => source.replace(scriptLine, scriptLine + '    "unreviewed-script": "node unknown.mjs",\n'),
    ],
    [
      "dependency metadata mutation",
      (source: string) => {
        const data = JSON.parse(source);
        data.dependencies["unreviewed-dependency"] = "1.0.0";
        return JSON.stringify(data);
      },
    ],
  ] as const)("refuses %s before invoking resolver IO", (_name, mutate) => {
    let calls = 0;
    const actual = actualIO();
    const io: C1ResolverObservationIO = {
      fileExists: (path) => {
        calls++;
        return actual.fileExists(path);
      },
      directoryExists: (path) => {
        calls++;
        return actual.directoryExists(path);
      },
      realpath: (path) => {
        calls++;
        return actual.realpath(path);
      },
    };
    expect(() =>
      currentPopulationCapture(
        read,
        replaced("package.json", mutate(canonicalPreviousPackage(read("package.json")))),
        io,
      ),
    ).toThrow(/full pin mismatch: package.json/);
    expect(calls).toBe(0);
  });
  it.each(["tsconfig.json", "pnpm-lock.yaml"])("retains full current config refusal for %s", (path) => {
    expect(() => currentPopulationCapture(read, replaced(path, read(path) + "\n"))).toThrow(/full pin mismatch/);
  });
  it("refuses a second operation after package mutation and freshly accepts restored actual input", () => {
    let packageSource = read("package.json");
    const authority = (path: string): string => (path === "package.json" ? packageSource : read(path));
    const first = currentPopulationCapture(read, authority);
    packageSource = predecessor(canonicalPreviousPackage(packageSource));
    expect(() => currentPopulationCapture(read, authority)).toThrow(/full pin mismatch: package.json/);
    packageSource = read("package.json");
    const restored = currentPopulationCapture(read, authority);
    expect([...restored.originals]).toEqual([...first.originals]);
    expect(restored.originals).not.toBe(first.originals);
  });
});

// Canonical-input epoch controls use actual current bytes; no predecessor view reaches the bridge.
const canonicalPaths = ["src/wasm/model/instructions.ts", "package.json", "pnpm-lock.yaml"] as const;
const canonicalSpanRows = [
  {
    path: "src/wasm/model/instructions.ts",
    index: 0,
  },
  {
    path: "package.json",
    index: 0,
  },
  {
    path: "package.json",
    index: 1,
  },
  {
    path: "package.json",
    index: 2,
  },
  {
    path: "package.json",
    index: 3,
  },
  {
    path: "package.json",
    index: 4,
  },
  {
    path: "package.json",
    index: 5,
  },
  {
    path: "package.json",
    index: 6,
  },
  {
    path: "pnpm-lock.yaml",
    index: 0,
  },
  {
    path: "pnpm-lock.yaml",
    index: 1,
  },
  {
    path: "pnpm-lock.yaml",
    index: 2,
  },
  {
    path: "pnpm-lock.yaml",
    index: 3,
  },
  {
    path: "pnpm-lock.yaml",
    index: 4,
  },
  {
    path: "pnpm-lock.yaml",
    index: 5,
  },
  {
    path: "pnpm-lock.yaml",
    index: 6,
  },
  {
    path: "pnpm-lock.yaml",
    index: 7,
  },
  {
    path: "pnpm-lock.yaml",
    index: 8,
  },
  {
    path: "pnpm-lock.yaml",
    index: 9,
  },
  {
    path: "pnpm-lock.yaml",
    index: 10,
  },
  {
    path: "pnpm-lock.yaml",
    index: 11,
  },
  {
    path: "pnpm-lock.yaml",
    index: 12,
  },
  {
    path: "pnpm-lock.yaml",
    index: 13,
  },
  {
    path: "pnpm-lock.yaml",
    index: 14,
  },
  {
    path: "pnpm-lock.yaml",
    index: 15,
  },
  {
    path: "pnpm-lock.yaml",
    index: 16,
  },
  {
    path: "pnpm-lock.yaml",
    index: 17,
  },
  {
    path: "pnpm-lock.yaml",
    index: 18,
  },
  {
    path: "pnpm-lock.yaml",
    index: 19,
  },
  {
    path: "pnpm-lock.yaml",
    index: 20,
  },
  {
    path: "pnpm-lock.yaml",
    index: 21,
  },
  {
    path: "pnpm-lock.yaml",
    index: 22,
  },
  {
    path: "pnpm-lock.yaml",
    index: 23,
  },
] as const;
describe("C1 named canonical input epoch", () => {
  it("authenticates the actual current base, closure/config pins and package observation", () => {
    const { data } = manifest();
    expect(data.currentBase).toBe("3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8");
    expect(data.historicalBase).toBe("bfcf326c9426988e66fa6cc446132ed9ad9c1965");
    const capture = currentPopulationCapture(read, read);
    expect(capture.originals.size).toBe(4);
    for (const record of canonicalInputEpochs) {
      expect(pin(read(record.path))).toEqual(record.currentPin);
      const inputs =
        record.path === "src/wasm/model/instructions.ts"
          ? data.linearOptions.closureInputs
          : data.linearOptions.resolver.configInputs;
      expect(inputs.filter((entry: { path: string }) => entry.path === record.path)).toEqual([
        { path: record.path, pin: record.currentPin },
      ]);
    }
    expect(
      data.linearOptions.resolver.observations.filter(
        (item: { operation: string; location: { scope: string; path: string } }) =>
          item.operation === "readFile" &&
          item.location.scope === "repository" &&
          item.location.path === "package.json",
      ),
    ).toEqual([
      {
        operation: "readFile",
        location: { scope: "repository", path: "package.json" },
        pin: canonicalInputEpochs[1].currentPin,
      },
    ]);
  });
  it.each(canonicalPaths)("independently reconstructs and replays the exact predecessor for %s", (path) => {
    const record = canonicalInputEpochs.find((entry) => entry.path === path)!;
    const current = read(path);
    expect(pin(current)).toEqual(record.currentPin);
    expect(pin(canonicalPreviousInput(path, current))).toEqual(record.beforePin);
  });
  it.each(canonicalPaths)("refuses stale predecessor bytes before resolver IO for %s", (path) => {
    let calls = 0;
    const io: C1ResolverObservationIO = {
      fileExists: () => {
        calls++;
        return false;
      },
      directoryExists: () => {
        calls++;
        return false;
      },
      realpath: (value) => {
        calls++;
        return value;
      },
    };
    expect(() => currentPopulationCapture(read, replaced(path, canonicalPreviousInput(path, read(path))), io)).toThrow(
      /full pin mismatch/,
    );
    expect(calls).toBe(0);
  });
  for (const mode of ["omission", "duplicate", "content"] as const) {
    it.each(canonicalSpanRows)(`refuses canonical ${mode} span $path/$index`, ({ path, index }) => {
      const record = canonicalInputEpochs.find((entry) => entry.path === path)!;
      const span = record.spans[index]!;
      const actual = read(path),
        bytes = Buffer.from(actual),
        before = Buffer.from(span.before),
        after = Buffer.from(span.after);
      const replacement =
        mode === "omission"
          ? before
          : mode === "duplicate"
            ? after.length
              ? Buffer.concat([after, after])
              : Buffer.concat([before, before])
            : after.length
              ? Buffer.from(after)
              : Buffer.from("\n");
      if (mode === "content" && after.length) replacement[0] = replacement[0]! ^ 1;
      const mutant = Buffer.concat([
        bytes.subarray(0, span.afterOffset),
        replacement,
        bytes.subarray(span.afterOffset + after.length),
      ]).toString("utf8");
      expect(mutant).not.toBe(actual);
      let calls = 0;
      const io: C1ResolverObservationIO = {
        fileExists: () => {
          calls++;
          return false;
        },
        directoryExists: () => {
          calls++;
          return false;
        },
        realpath: (value) => {
          calls++;
          return value;
        },
      };
      expect(() => currentPopulationCapture(read, replaced(path, mutant), io)).toThrow(/full pin mismatch/);
      expect(calls).toBe(0);
    });
  }
  it.each(["package.json", "pnpm-lock.yaml"] as const)("refuses reordered canonical fragments in %s", (path) => {
    const record = canonicalInputEpochs.find((entry) => entry.path === path)!;
    const first = record.spans[0],
      second = record.spans[path === "package.json" ? 2 : 1]!;
    const actual = read(path),
      bytes = Buffer.from(actual);
    const firstAfter = Buffer.from(first.after),
      secondAfter = Buffer.from(second.after);
    expect(firstAfter.equals(secondAfter)).toBe(false);
    const mutant = Buffer.concat([
      bytes.subarray(0, first.afterOffset),
      secondAfter,
      bytes.subarray(first.afterOffset + firstAfter.length, second.afterOffset),
      firstAfter,
      bytes.subarray(second.afterOffset + secondAfter.length),
    ]).toString("utf8");
    expect(mutant).not.toBe(actual);
    expect(() => currentPopulationCapture(read, replaced(path, mutant))).toThrow(/full pin mismatch/);
  });
  it.each(canonicalPaths)("refuses a fresh second-operation mutation and accepts actual restoration for %s", (path) => {
    let source = read(path);
    const reader = (input: string): string => (input === path ? source : read(input));
    const first = currentPopulationCapture(read, reader);
    source += "\n";
    expect(() => currentPopulationCapture(read, reader)).toThrow(/full pin mismatch/);
    source = read(path);
    const restored = currentPopulationCapture(read, reader);
    expect([...restored.originals]).toEqual([...first.originals]);
    expect(restored.originals).not.toBe(first.originals);
  });
  it("retains required i32 members and the actual new int32 brand without restoring old source", () => {
    const source = read("src/wasm/model/instructions.ts");
    expect(pin(source)).toEqual(canonicalInputEpochs[0].currentPin);
    expect(source).toContain('  | { kind: "i32"; boolean?: true; symbol?: true; int32?: true }');
    const historical = canonicalPreviousInput("src/wasm/model/instructions.ts", source);
    expect(historical).toContain('  | { kind: "i32"; boolean?: true; symbol?: true }');
    expect(historical).not.toContain("int32?: true");
  });
  it.each(["src/ir/identity.ts", "tsconfig.json"])("does not admit unrelated current input changes in %s", (path) => {
    let calls = 0;
    const mutant = read(path) + "\n";
    const inject = (input: string): string => {
      if (input === path) {
        calls++;
        return mutant;
      }
      return read(input);
    };
    const populationPath = path === "src/ir/identity.ts";
    expect(() => currentPopulationCapture(populationPath ? inject : read, populationPath ? read : inject)).toThrow(
      populationPath ? /length\/SHA256: src\/ir\/identity\.ts/ : /full pin mismatch: tsconfig\.json/,
    );
    expect(calls).toBe(1);
  });
});

describe("C1 canonical instructions historical operand", () => {
  const record = canonicalInputEpochs[0];
  const span = record.spans[0];
  const actualInstructions = (): string => read(record.path);
  const alterSpan = (replacement: string): string => {
    const current = Buffer.from(actualInstructions());
    const after = Buffer.from(span.after);
    expect(current.subarray(span.afterOffset, span.afterOffset + after.length).toString("utf8")).toBe(span.after);
    return Buffer.concat([
      current.subarray(0, span.afterOffset),
      Buffer.from(replacement),
      current.subarray(span.afterOffset + after.length),
    ]).toString("utf8");
  };
  it("independently inverts and replays the exact current instructions operand", () => {
    const current = actualInstructions();
    expect(pin(current)).toEqual(record.currentPin);
    const bytes = Buffer.from(current);
    const predecessor = Buffer.concat([
      bytes.subarray(0, span.afterOffset),
      Buffer.from(span.before),
      bytes.subarray(span.afterOffset + Buffer.byteLength(span.after)),
    ]).toString("utf8");
    expect(pin(predecessor)).toEqual(record.beforePin);
    expect(predecessor).toBe(canonicalPreviousInput(record.path, current));
    expect(beforeCanonicalInstructionsSource(current)).toBe(predecessor);
    const old = Buffer.from(predecessor);
    expect(old.subarray(span.beforeOffset, span.beforeOffset + Buffer.byteLength(span.before)).toString("utf8")).toBe(
      span.before,
    );
    const replay = Buffer.concat([
      old.subarray(0, span.beforeOffset),
      Buffer.from(span.after),
      old.subarray(span.beforeOffset + Buffer.byteLength(span.before)),
    ]).toString("utf8");
    expect(replay).toBe(current);
    expect(pin(replay)).toEqual(record.currentPin);
  });
  it("refuses a nonprimitive instructions operand without conversion", () => {
    let conversions = 0;
    const operand = {
      toString: () => {
        conversions++;
        return actualInstructions();
      },
    };
    expect(() => beforeCanonicalInstructionsSource(operand)).toThrow(
      /primitive source required: src\/wasm\/model\/instructions\.ts/,
    );
    expect(conversions).toBe(0);
  });
  it("refuses the stale predecessor instructions operand", () => {
    const current = actualInstructions();
    const stale = canonicalPreviousInput(record.path, current);
    expect(pin(stale)).toEqual(record.beforePin);
    expect(stale).not.toBe(current);
    expect(() => beforeCanonicalInstructionsSource(stale)).toThrow(/full pin mismatch/);
  });
  it("refuses omission of the current instructions span", () => {
    const mutant = alterSpan("");
    expect(mutant).not.toBe(actualInstructions());
    expect(mutant).not.toContain(span.after);
    expect(() => beforeCanonicalInstructionsSource(mutant)).toThrow(/full pin mismatch/);
  });
  it("refuses duplication of the current instructions span", () => {
    const mutant = alterSpan(span.after + span.after);
    expect(mutant).not.toBe(actualInstructions());
    expect(mutant).toContain(span.after + span.after);
    expect(() => beforeCanonicalInstructionsSource(mutant)).toThrow(/full pin mismatch/);
  });
  it("refuses a same-length instructions content mutation", () => {
    const bytes = Buffer.from(actualInstructions());
    bytes[span.afterOffset] = bytes[span.afterOffset]! ^ 1;
    const mutant = bytes.toString("utf8");
    expect(Buffer.byteLength(mutant)).toBe(record.currentPin.bytes);
    expect(mutant).not.toBe(actualInstructions());
    expect(() => beforeCanonicalInstructionsSource(mutant)).toThrow(/full pin mismatch/);
  });
  it("refuses a shifted current instructions span", () => {
    const current = actualInstructions();
    const bytes = Buffer.from(current);
    expect(bytes[bytes.length - 1]).toBe(10);
    const mutant = Buffer.concat([
      bytes.subarray(0, span.afterOffset),
      Buffer.from("\n"),
      bytes.subarray(span.afterOffset, bytes.length - 1),
    ]).toString("utf8");
    expect(Buffer.byteLength(mutant)).toBe(record.currentPin.bytes);
    expect(mutant).not.toBe(current);
    expect(
      Buffer.from(mutant)
        .subarray(span.afterOffset + 1, span.afterOffset + 1 + Buffer.byteLength(span.after))
        .toString("utf8"),
    ).toBe(span.after);
    expect(() => beforeCanonicalInstructionsSource(mutant)).toThrow(/full pin mismatch/);
  });
  it("authenticates each fresh instructions argument and accepts restoration", () => {
    const current = actualInstructions();
    const expected = canonicalPreviousInput(record.path, current);
    expect(beforeCanonicalInstructionsSource(current)).toBe(expected);
    const mutant = current + "\n";
    expect(mutant).not.toBe(current);
    expect(() => beforeCanonicalInstructionsSource(mutant)).toThrow(/full pin mismatch/);
    expect(beforeCanonicalInstructionsSource(actualInstructions())).toBe(expected);
  });
});

// These controls exercise the normal C1 bridge and its two reader channels.
// Physical helper faults are isolated in the portable preservation suite.
describe("C1 lowering-analysis guarded reader integration", () => {
  const helper = "tests/helpers/ir-lowering-analysis-relocation.ts";
  const receipt = "tests/helpers/ir-lowering-analysis-relocation.json";
  const legality = "src/ir/backend/legality.ts";
  const planner = "src/ir/analysis/linear-memory-plan.ts";
  function healthy() {
    const authority: string[] = [];
    const got = currentPopulationCapture(read, (path) => {
      authority.push(path);
      return read(path);
    });
    expect(authority).toEqual(currentAuthorityTrace());
    expect(got.historicalPopulation.size).toBe(46);
    expect(got.originals.size).toBe(4);
    expect(pin(got.historicalPopulation.get(legality)!)).toEqual({
      bytes: 26410,
      sha256: "6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98",
      gitBlob: "d4854103ad1fae2f12c105fc0e1a66e2d20a5c6e",
    });
    expect(pin(read(planner))).toEqual({
      bytes: 45359,
      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",
    });
    expect(pin(provedHistoricalGeometry().loweringBeforePlanner)).toEqual({
      bytes: 49040,
      sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
      gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
    });
    return got;
  }
  it("uses fresh complete authority reads and keeps current planner in actual resolution", () => {
    const first = healthy(),
      second = healthy();
    expect(second.historicalPopulation).not.toBe(first.historicalPopulation);
    expect([...second.originals]).toEqual([...first.originals]);
    expect(first.observedCurrentPins.find((item) => item.path === legality)!.pin.sha256).toBe(
      "5b67993fe312a0f5a52f9ef816c76a10cd32470f7e2a53819dec736764f45878",
    );
  });
  it("refuses supplied population legality while the authority adapter remains healthy", () => {
    healthy();
    const mutant = read(legality) + "\n// supplied population mutation\n";
    let supplied = 0;
    expect(() =>
      currentPopulationCapture((path) => {
        if (path === legality) {
          supplied++;
          return mutant;
        }
        return read(path);
      }, read),
    ).toThrow("lowering analysis relocation: supplied current source differs " + legality);
    expect(supplied).toBe(1);
    healthy();
  });
  it("refuses changed adapter authority with a healthy population", () => {
    healthy();
    let observed = 0;
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path === legality) {
          observed++;
          return read(path) + "\n// authority mutation\n";
        }
        return read(path);
      }),
    ).toThrow("lowering analysis relocation: full pin changed " + legality);
    expect(observed).toBe(1);
    healthy();
  });
  it.each([
    [
      "layout readonly member",
      "src/ir/analysis/contracts/linear-memory-layout.ts",
      "readonly name: string;",
      "name: string;",
      "lowering analysis relocation: full pin changed ",
    ],
    [
      "layout import route",
      "src/ir/analysis/contracts/linear-memory-layout.ts",
      '"../../core/nodes.js"',
      '"../../nodes.js"',
      "lowering analysis relocation: full pin changed ",
    ],
    [
      "canonical verifier body",
      "src/ir/analysis/backend-legality.ts",
      "return errors;",
      "return errors.slice();",
      "lowering analysis relocation: full pin changed ",
    ],
    [
      "canonical verifier import",
      "src/ir/analysis/backend-legality.ts",
      '"../core/types.js"',
      '"../types.js"',
      "lowering analysis relocation: full pin changed ",
    ],
    [
      "retained target projection",
      legality,
      "const nativeRegimeInJs =",
      "let nativeRegimeInJs =",
      "lowering analysis relocation: full pin changed ",
    ],
    [
      "retained planner algorithm",
      planner,
      "export const LINEAR_POINTER_BYTES = 4;",
      "export const LINEAR_POINTER_BYTES = 8;",
      "C1 current source: full pin mismatch: ",
    ],
  ] as const)("refuses source mutation at its actual first guard: %s", (_name, path, before, after, diagnostic) => {
    healthy();
    if (_name === "layout readonly member" || _name === "retained planner algorithm") {
      const geometry = provedHistoricalGeometry();
      const historicalReader = (request: string): string => {
        if (request === planner) return geometry.loweringBeforePlanner;
        if (request === "src/ir/analysis/contracts/linear-memory-layout.ts") return geometry.loweringBeforeLayout;
        if (request === receipt) return read(receipt);
        throw new Error("historical lowering mutation outside reader domain: " + request);
      };
      const seed = historicalReader(path),
        mutant = replaceOnce(seed, before, after);
      let observed = 0;
      const raw = path === planner ? mutant : geometry.loweringBeforePlanner;
      expect(() =>
        captureLinearLayoutPredecessor(raw, (request) => {
          if (request === path) {
            observed++;
            return mutant;
          }
          return historicalReader(request);
        }),
      ).toThrow("lowering analysis relocation: full pin changed " + path);
      expect(observed).toBe(path === planner ? 0 : 1);
      healthy();
      return;
    }
    const seed = read(path),
      mutant = replaceOnce(seed, before, after);
    expect(mutant).not.toBe(seed);
    let observed = 0;
    expect(() =>
      currentPopulationCapture(read, (request) => {
        if (request === path) {
          observed++;
          return mutant;
        }
        return read(request);
      }),
    ).toThrow(diagnostic + path);
    expect(observed).toBe(1);
    healthy();
  });
  it("refuses immutable source-receipt mutation before interior schema interpretation", () => {
    healthy();
    const seed = read(receipt),
      mutant = replaceOnce(seed, '"sourceBase": "549b', '"sourceBase": "049b');
    let observed = 0;
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path === receipt) {
          observed++;
          return mutant;
        }
        return read(path);
      }),
    ).toThrow("lowering analysis relocation: full pin changed " + receipt);
    expect(observed).toBe(1);
    healthy();
  });
  it("retains a missing receipt error and accepts fresh restoration", () => {
    healthy();
    const missing = Object.assign(new Error("missing lowering analysis receipt"), { code: "ENOENT" });
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path === receipt) throw missing;
        return read(path);
      }),
    ).toThrow(missing);
    healthy();
  });
  it("observes corrupted helper authority before reading the source receipt", () => {
    healthy();
    let helperReads = 0,
      receiptReads = 0;
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path === helper) {
          helperReads++;
          return read(path) + "\n// authority helper mutation\n";
        }
        if (path === receipt) receiptReads++;
        return read(path);
      }),
    ).toThrow("C1 current source: full pin mismatch: " + helper);
    expect(helperReads).toBe(1);
    expect(receiptReads).toBe(0);
    healthy();
  });
  it.each(["nonprimitive original receipt", "changed original owner"] as const)(
    "keeps original operand rejection before supplemental IO: %s",
    (name) => {
      healthy();
      let supplemental = 0;
      const owner = "src/ir/program/owner.ts",
        mutant = read(owner) + "\n// original current mutation\n";
      const operation = () =>
        currentPopulationCapture(
          (path) => {
            if (name === "nonprimitive original receipt" && path === runtimeProgramRelocationReceiptPath)
              return undefined as unknown as string;
            if (name === "changed original owner" && path === owner) return mutant;
            return read(path);
          },
          (path) => {
            if (path === helper || path === receipt) {
              supplemental++;
              throw new Error("supplemental IO bomb");
            }
            return read(path);
          },
        );
      if (name === "nonprimitive original receipt")
        expect(operation).toThrow(
          "C1 current source: primitive source required: " + runtimeProgramRelocationReceiptPath,
        );
      else expect(operation).toThrow(/length\/SHA256/);
      expect(supplemental).toBe(0);
      healthy();
    },
  );
});

// The owner is supplemental authority, never a fabricated member of population47.
describe("C1 actual early-return owner authority", () => {
  const owner = "src/ir/analysis/backend-legality.ts";
  const adapter = "src/ir/backend/legality.ts";
  const ownerPin = {
    bytes: 21387,
    sha256: "cdd60287d9c98f700eca41f351f02ac609f3e9fdd43a25e28d7951f16f0c1a37",
    gitBlob: "157777ff1c14c6cf5f0e4241c4e361843d694f5b",
  };
  const previousPin = {
    bytes: 21362,
    sha256: "e6bdc35fbf47fc26581c24cbecb08f27a4d590a7006d005031b6a309db26b506",
    gitBlob: "34a1399bdd963163f2155f0de0933d085dbc4f25",
  };
  function healthy() {
    const authority: string[] = [],
      actualOwner: string[] = [];
    const got = currentPopulationCapture(read, (path) => {
      authority.push(path);
      const value = read(path);
      if (path === owner) actualOwner.push(value);
      return value;
    });
    expect(authority).toEqual(currentAuthorityTrace());
    expect(actualOwner).toHaveLength(1);
    expect(pin(actualOwner[0]!)).toEqual(ownerPin);
    expect(got.observedCurrentPins.some((row) => row.path === owner)).toBe(false);
    expect(got.observedCurrentPins.some((row) => row.pin.sha256 === previousPin.sha256)).toBe(false);
    expect(got.historicalPopulation.has(owner)).toBe(false);
    expect(pin(got.historicalPopulation.get(adapter)!)).toEqual({
      bytes: 26410,
      sha256: "6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98",
      gitBlob: "d4854103ad1fae2f12c105fc0e1a66e2d20a5c6e",
    });
    expect(pin(read("src/ir/analysis/linear-memory-plan.ts"))).toEqual({
      bytes: 45359,
      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",
    });
    expect(pin(provedHistoricalGeometry().loweringBeforePlanner)).toEqual({
      bytes: 49040,
      sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
      gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
    });
    return actualOwner[0]!;
  }
  it("observes actual cdd owner once while returning only the original legality donor", () => {
    healthy();
    healthy();
  });
  it.each(["missing", "corrupt", "old e6 substitution", "same-size unrelated edit"] as const)(
    "refuses %s actual owner authority and accepts healthy restoration",
    (name) => {
      const current = Buffer.from(healthy());
      const insertion = Buffer.from('    case "early.return":\n');
      expect(current.subarray(8250, 8275)).toEqual(insertion);
      const original = Buffer.concat([current.subarray(0, 8250), current.subarray(8275)]);
      expect(pin(original.toString("utf8"))).toEqual(previousPin);
      const missing = Object.assign(new Error("missing current early-return owner"), { code: "ENOENT" });
      let reads = 0;
      const operation = () =>
        currentPopulationCapture(read, (path) => {
          if (path !== owner) return read(path);
          reads++;
          if (name === "missing") throw missing;
          if (name === "old e6 substitution") return original.toString("utf8");
          if (name === "corrupt") return current.toString("utf8") + "\n// owner mutation\n";
          const changed = Buffer.from(current);
          changed[0] = changed[0]! ^ 1;
          return changed.toString("utf8");
        });
      if (name === "missing") expect(operation).toThrow(missing);
      else expect(operation).toThrow("full pin changed " + owner);
      expect(reads).toBe(1);
      healthy();
    },
  );
});

// Independent fixed union epoch: expected bytes come from root's reviewed source span, never an H2 output.
const booleanTypesPath = "src/ir/types.ts";
const booleanTypesBeforePin = {
  bytes: 7744,
  sha256: "d82e92ee276dd9a57bd69d9dee16410d24225a028bd9dca53bc406f69b9623ac",
  gitBlob: "f7717d7c70bb57bd73d799a1d26d1825aa0a41e8",
};
const booleanTypesCurrentPin = {
  bytes: 7756,
  sha256: "0282ae61c6a43f837a9a3c7b12d879151e67ec155939c541cd9b5ea662979140",
  gitBlob: "bdf9d6ace5f7f5530373cea6007a1ad7dfe905d0",
};
const booleanTypesOffset = 6465;
const booleanTypesBefore =
  'export type ExportBoundaryKind = TypedArrayKind | "string" | "symbol" | "promise" | "dynamic" | "aggregate";';
const booleanTypesCurrent =
  'export type ExportBoundaryKind = TypedArrayKind | "boolean" | "string" | "symbol" | "promise" | "dynamic" | "aggregate";';
function independentBooleanTypesBefore(current: string): string {
  expect(pin(current)).toEqual(booleanTypesCurrentPin);
  const bytes = Buffer.from(current),
    before = Buffer.from(booleanTypesBefore),
    after = Buffer.from(booleanTypesCurrent);
  expect(bytes.subarray(booleanTypesOffset, booleanTypesOffset + after.length)).toEqual(after);
  const predecessor = Buffer.concat([
    bytes.subarray(0, booleanTypesOffset),
    before,
    bytes.subarray(booleanTypesOffset + after.length),
  ]);
  expect(pin(predecessor.toString("utf8"))).toEqual(booleanTypesBeforePin);
  expect(predecessor.subarray(booleanTypesOffset, booleanTypesOffset + before.length)).toEqual(before);
  const replay = Buffer.concat([
    predecessor.subarray(0, booleanTypesOffset),
    after,
    predecessor.subarray(booleanTypesOffset + before.length),
  ]);
  expect(replay).toEqual(bytes);
  expect(pin(replay.toString("utf8"))).toEqual(booleanTypesCurrentPin);
  return predecessor.toString("utf8");
}
function booleanTypesHealthy(): void {
  const capture = currentPopulationCapture(read, read);
  expect(capture.originals.size).toBe(4);
  expect(pin(capture.historicalPopulation.get(booleanTypesPath)!)).toEqual(booleanTypesBeforePin);
  expect(capture.observedCurrentPins.filter((row) => row.path === booleanTypesPath)).toEqual([
    { path: booleanTypesPath, pin: booleanTypesCurrentPin },
  ]);
}
function booleanTypesExpectMissing(action: () => void, path: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", path: resolve(root, path) });
}
/** Same fail-closed persistent-backup and expected-fault identity protocol as the established authority harness. */
function booleanTypesWithFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (path !== booleanTypesPath) throw new Error("unapproved Boolean type authority fault: " + path);
  if (byte !== 0) throw new Error("unapproved Boolean type fault byte");
  const target = resolve(root, path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-boolean-types-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = resolve(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(resolve(scratch, "operation-"));
    backup = resolve(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        booleanTypesExpectMissing(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        booleanTypesExpectMissing(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

describe("C1 fixed Boolean type union epoch", () => {
  it("independently proves current inverse and full forward replay", () => {
    const current = read(booleanTypesPath),
      predecessor = independentBooleanTypesBefore(current);
    const capture = currentPopulationCapture(read, read);
    expect(capture.historicalPopulation.get(booleanTypesPath)).toBe(predecessor);
    expect(capture.observedCurrentPins.find((row) => row.path === booleanTypesPath)?.pin).toEqual(
      booleanTypesCurrentPin,
    );
    expect(reconstructRuntimeProgramRelocationPopulation(capture.historicalPopulation, capture.receiptText)).toEqual(
      capture.originals,
    );
  });
  it("keeps genuine current types refused by the unchanged direct historical guard", () => {
    booleanTypesHealthy();
    const capture = currentPopulationCapture(read, read),
      mutant = new Map(capture.historicalPopulation);
    mutant.set(booleanTypesPath, read(booleanTypesPath));
    expect(() => reconstructRuntimeProgramRelocationPopulation(mutant, capture.receiptText)).toThrow(
      /length\/SHA256: src\/ir\/types\.ts/,
    );
    booleanTypesHealthy();
  });
  it("refuses the stale predecessor before real resolver IO", () => {
    booleanTypesHealthy();
    let calls = 0;
    const io: C1ResolverObservationIO = {
      fileExists: () => {
        calls++;
        return false;
      },
      directoryExists: () => {
        calls++;
        return false;
      },
      realpath: (path) => {
        calls++;
        return path;
      },
    };
    expect(() =>
      currentPopulationCapture(
        replaced(booleanTypesPath, independentBooleanTypesBefore(read(booleanTypesPath))),
        read,
        io,
      ),
    ).toThrow("C1 current source: full pin mismatch: " + booleanTypesPath);
    expect(calls).toBe(0);
    booleanTypesHealthy();
  });
  it.each([
    "missing Boolean member",
    "duplicate Boolean member",
    "same-size member content",
    "shifted fragment",
    "outside union",
  ] as const)("refuses exact current type mutation: %s", (name) => {
    booleanTypesHealthy();
    const seed = read(booleanTypesPath);
    let mutant: string;
    if (name === "missing Boolean member") mutant = replaceOnce(seed, booleanTypesCurrent, booleanTypesBefore);
    else if (name === "duplicate Boolean member")
      mutant = replaceOnce(
        seed,
        booleanTypesCurrent,
        booleanTypesCurrent.replace('"boolean"', '"boolean" | "boolean"'),
      );
    else if (name === "same-size member content")
      mutant = replaceOnce(seed, booleanTypesCurrent, booleanTypesCurrent.replace('"boolean"', '"booleam"'));
    else if (name === "shifted fragment") {
      expect(seed.endsWith("\n")).toBe(true);
      mutant = "\n" + seed.slice(0, -1);
    } else mutant = replaceOnce(seed, "Loopdive GmbH", "Loopdive GmbI");
    expect(mutant).not.toBe(seed);
    if (name === "same-size member content" || name === "shifted fragment" || name === "outside union")
      expect(Buffer.byteLength(mutant)).toBe(Buffer.byteLength(seed));
    let reached = 0,
      resolver = 0;
    const io: C1ResolverObservationIO = {
      fileExists: () => {
        resolver++;
        return false;
      },
      directoryExists: () => {
        resolver++;
        return false;
      },
      realpath: (path) => {
        resolver++;
        return path;
      },
    };
    expect(() =>
      currentPopulationCapture(
        (path) => {
          if (path === booleanTypesPath) {
            reached++;
            return mutant;
          }
          return read(path);
        },
        read,
        io,
      ),
    ).toThrow("C1 current source: full pin mismatch: " + booleanTypesPath);
    expect(reached).toBe(1);
    expect(resolver).toBe(0);
    booleanTypesHealthy();
  });
  it("refuses nonprimitive population types without coercion", () => {
    booleanTypesHealthy();
    let coerced = 0,
      reached = 0;
    const value = {
      toString() {
        coerced++;
        throw new Error("coercion must not run");
      },
      [Symbol.toPrimitive]() {
        coerced++;
        throw new Error("coercion must not run");
      },
    };
    expect(() =>
      currentPopulationCapture((path) => {
        if (path === booleanTypesPath) {
          reached++;
          return value as unknown as string;
        }
        return read(path);
      }, read),
    ).toThrow("C1 current source: primitive source required: " + booleanTypesPath);
    expect(reached).toBe(1);
    expect(coerced).toBe(0);
    booleanTypesHealthy();
  });
  it("does not replace a supplied population mutant with healthy authority bytes", () => {
    booleanTypesHealthy();
    const mutant = read(booleanTypesPath) + "\n// supplied population mutation\n";
    let population = 0,
      authority = 0;
    expect(() =>
      currentPopulationCapture(
        (path) => {
          if (path === booleanTypesPath) {
            population++;
            return mutant;
          }
          return read(path);
        },
        (path) => {
          if (path === booleanTypesPath) authority++;
          return read(path);
        },
      ),
    ).toThrow("C1 current source: full pin mismatch: " + booleanTypesPath);
    expect(population).toBe(1);
    expect(authority).toBe(0);
    booleanTypesHealthy();
  });
  it("refuses a changed second-call population after a healthy warm capture", () => {
    let reads = 0;
    const reader = (path: string): string => {
      if (path === booleanTypesPath && ++reads === 2) return read(path) + "\n// warm mutation\n";
      return read(path);
    };
    expect(currentPopulationCapture(reader, read).originals.size).toBe(4);
    expect(() => currentPopulationCapture(reader, read)).toThrow(
      "C1 current source: full pin mismatch: " + booleanTypesPath,
    );
    expect(reads).toBe(2);
    booleanTypesHealthy();
  });
  it.each(["mutation", "missing"] as const)(
    "refuses a real fresh types source fault and accepts exact restoration: %s",
    (kind) => {
      booleanTypesHealthy();
      booleanTypesWithFault(booleanTypesPath, kind, () => {
        if (kind === "missing") booleanTypesExpectMissing(() => currentPopulationCapture(read, read), booleanTypesPath);
        else
          expect(() => currentPopulationCapture(read, read)).toThrow(
            "C1 current source: full pin mismatch: " + booleanTypesPath,
          );
      });
      expect(pin(read(booleanTypesPath))).toEqual(booleanTypesCurrentPin);
      booleanTypesHealthy();
    },
  );
  it("resolves the actual current Boolean union with the unchanged operation and target contract", () => {
    const { data } = manifest(),
      population: string[] = [],
      authority: string[] = [],
      observed: { operation: string; path: string }[] = [];
    const actual = actualIO();
    const locate = (path: string): string => {
      const packageRoot = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
      for (const packagePath of [packageRoot, resolve(root, "node_modules/typescript")])
        if (path === packagePath || path.startsWith(packagePath + sep))
          return "typescript-package/" + relative(packagePath, path).split(sep).join("/");
      return relative(root, path).split(sep).join("/");
    };
    const io: C1ResolverObservationIO = {
      fileExists: (path) => {
        observed.push({ operation: "fileExists", path: locate(path) });
        return actual.fileExists(path);
      },
      directoryExists: (path) => {
        observed.push({ operation: "directoryExists", path: locate(path) });
        return actual.directoryExists(path);
      },
      realpath: (path) => {
        observed.push({ operation: "realpath", path: locate(path) });
        return actual.realpath(path);
      },
    };
    let supplied: string | undefined;
    const capture = currentPopulationCapture(
      (path) => {
        population.push(path);
        const source = read(path);
        if (path === booleanTypesPath) supplied = source;
        return source;
      },
      (path) => {
        authority.push(path);
        return read(path);
      },
      io,
    );
    expect(population).toEqual([runtimeProgramRelocationReceiptPath, ...runtimeProgramRelocationPopulationPaths]);
    expect(authority).toEqual(currentAuthorityTrace());
    expect(authority.filter((path) => path === booleanTypesPath)).toHaveLength(0);
    expect(pin(supplied!)).toEqual(booleanTypesCurrentPin);
    const file = ts.createSourceFile(booleanTypesPath, supplied!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = file.statements
      .filter(ts.isTypeAliasDeclaration)
      .filter((row) => row.name.text === "ExportBoundaryKind");
    expect(declarations).toHaveLength(1);
    expect(ts.isUnionTypeNode(declarations[0]!.type)).toBe(true);
    const union = declarations[0]!.type;
    if (!ts.isUnionTypeNode(union)) throw new Error("actual ExportBoundaryKind union missing");
    expect(
      union.types
        .filter(ts.isLiteralTypeNode)
        .filter((row) => ts.isStringLiteral(row.literal) && row.literal.text === "boolean"),
    ).toHaveLength(1);
    expect(data.linearOptions.resolver.requests).toHaveLength(13);
    expect(data.linearOptions.resolver.observations).toHaveLength(57);
    expect(observed).toEqual(
      independentlyAcquireSuccessor()
        .receipt.linearOptions.resolver.observations.filter(
          (row: { operation: string }) => row.operation !== "readFile",
        )
        .map((row: { operation: string; location: { scope: string; path: string } }) => ({
          operation: row.operation,
          path:
            row.location.scope === "typescript-package" ? "typescript-package/" + row.location.path : row.location.path,
        })),
    );
    expect(resolverRequests[1]).toEqual([
      linearPath,
      "../ir/analysis/linear-memory-plan.js",
      "repository",
      "src/ir/analysis/linear-memory-plan.ts",
    ]);
    expect(capture.observedCurrentPins.find((row) => row.path === booleanTypesPath)?.pin).toEqual(
      booleanTypesCurrentPin,
    );
  });
});

// Fixed incoming SourceOrigin epoch; supplemental closure authority is NOT population47.
const sourceOriginPath = "src/shared/contracts/source-origin.ts";
const sourceOriginOffset = 261;
const sourceOriginBeforeFragment = '  | "iterator-statics-prelude";\n';
const sourceOriginCurrentFragment = '  | "iterator-statics-prelude"\n  | "intl-listformat-prelude";\n';
const sourceOriginBeforePin = {
  bytes: 689,
  sha256: "cc8e05036afdaca04c3e7055ad22f82c57f6e2e31b7e49a69e9081823c2eacde",
  gitBlob: "7d9e62164db0594b761ea88eac9a07ac2d142f73",
};
const sourceOriginCurrentPin = {
  bytes: 719,
  sha256: "cb199a6040c361256dc244d4e4e8183490524a0ee9505920a660e34eea3cc9b4",
  gitBlob: "d6d98de15c656d3ecb32653b447b31486d3b9f05",
};
function sourceOriginIndependentBefore(current: string): string {
  expect(pin(current)).toEqual(sourceOriginCurrentPin);
  const bytes = Buffer.from(current),
    before = Buffer.from(sourceOriginBeforeFragment),
    after = Buffer.from(sourceOriginCurrentFragment);
  expect(before.length).toBe(32);
  expect(after.length).toBe(62);
  expect(bytes.subarray(sourceOriginOffset, sourceOriginOffset + after.length)).toEqual(after);
  expect(current.split(sourceOriginCurrentFragment)).toHaveLength(2);
  const previous = Buffer.concat([
    bytes.subarray(0, sourceOriginOffset),
    before,
    bytes.subarray(sourceOriginOffset + after.length),
  ]);
  expect(pin(previous.toString("utf8"))).toEqual(sourceOriginBeforePin);
  const replay = Buffer.concat([
    previous.subarray(0, sourceOriginOffset),
    after,
    previous.subarray(sourceOriginOffset + before.length),
  ]);
  expect(replay).toEqual(bytes);
  expect(pin(replay.toString("utf8"))).toEqual(sourceOriginCurrentPin);
  return previous.toString("utf8");
}
function sourceOriginHealthy(): string {
  const authority: string[] = [],
    population: string[] = [],
    supplied: string[] = [];
  const capture = currentPopulationCapture(
    (path) => {
      population.push(path);
      return read(path);
    },
    (path) => {
      authority.push(path);
      const value = read(path);
      if (path === sourceOriginPath) supplied.push(value);
      return value;
    },
  );
  expect(population).toEqual([runtimeProgramRelocationReceiptPath, ...runtimeProgramRelocationPopulationPaths]);
  expect(authority).toEqual(currentAuthorityTrace());
  expect(supplied).toHaveLength(1);
  expect(pin(supplied[0]!)).toEqual(sourceOriginCurrentPin);
  expect(population).not.toContain(sourceOriginPath);
  expect(capture.historicalPopulation.size).toBe(46);
  expect(capture.originals.size).toBe(4);
  expect(capture.historicalPopulation.has(sourceOriginPath)).toBe(false);
  expect(capture.observedCurrentPins.some((row) => row.path === sourceOriginPath)).toBe(false);
  return supplied[0]!;
}
function sourceOriginExpectMissing(action: () => void, path: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", path: resolve(root, path) });
}
function sourceOriginWithFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (path !== sourceOriginPath) throw new Error("unapproved SourceOrigin authority fault: " + path);
  if (byte !== 0) throw new Error("unapproved SourceOrigin fault byte");
  const target = resolve(root, path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-source-origin-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = resolve(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(resolve(scratch, "operation-"));
    backup = resolve(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        sourceOriginExpectMissing(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        sourceOriginExpectMissing(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

describe("C1 fixed current SourceOrigin closure epoch", () => {
  it("independently authenticates full inverse and forward replay without a production projector", () => {
    const current = sourceOriginHealthy();
    const previous = sourceOriginIndependentBefore(current);
    expect(previous).not.toContain('"intl-listformat-prelude"');
    expect(sourceOriginHealthy()).toBe(current);
  });
  it.each(["stale689", "missing member", "duplicate member", "renamed member", "unrelated source edit"] as const)(
    "refuses supplied authority %s before resolver IO and observes exact restoration",
    (name) => {
      const current = sourceOriginHealthy();
      let mutant: string;
      if (name === "stale689") mutant = sourceOriginIndependentBefore(current);
      else if (name === "missing member")
        mutant = replaceOnce(current, sourceOriginCurrentFragment, sourceOriginBeforeFragment + "\n");
      else if (name === "duplicate member")
        mutant = replaceOnce(
          current,
          sourceOriginCurrentFragment,
          sourceOriginCurrentFragment.replace(
            '  | "intl-listformat-prelude";',
            '  | "intl-listformat-prelude"\n  | "intl-listformat-prelude";',
          ),
        );
      else if (name === "renamed member")
        mutant = replaceOnce(current, '"intl-listformat-prelude"', '"intl-listformat-preludf"');
      else mutant = replaceOnce(current, "Loopdive GmbH", "Loopdive GmbI");
      expect(mutant).not.toBe(current);
      if (name === "renamed member" || name === "unrelated source edit") expect(Buffer.byteLength(mutant)).toBe(719);
      let authority = 0,
        population = 0,
        resolver = 0;
      const io: C1ResolverObservationIO = {
        fileExists: () => {
          resolver++;
          return false;
        },
        directoryExists: () => {
          resolver++;
          return false;
        },
        realpath: (path) => {
          resolver++;
          return path;
        },
      };
      expect(() =>
        currentPopulationCapture(
          (path) => {
            if (path === sourceOriginPath) population++;
            return read(path);
          },
          (path) => {
            if (path === sourceOriginPath) {
              authority++;
              return mutant;
            }
            return read(path);
          },
          io,
        ),
      ).toThrow("C1 current source: full pin mismatch: " + sourceOriginPath);
      expect(authority).toBe(1);
      expect(population).toBe(0);
      expect(resolver).toBe(0);
      expect(sourceOriginHealthy()).toBe(current);
    },
  );
  it("refuses boxed authority before coercion or resolver activity", () => {
    sourceOriginHealthy();
    let coerced = 0,
      reached = 0,
      resolver = 0;
    const boxed = new String(read(sourceOriginPath));
    boxed.toString = () => {
      coerced++;
      throw Error("boxed authority coercion executed");
    };
    const io: C1ResolverObservationIO = {
      fileExists: () => {
        resolver++;
        return false;
      },
      directoryExists: () => {
        resolver++;
        return false;
      },
      realpath: (path) => {
        resolver++;
        return path;
      },
    };
    expect(() =>
      currentPopulationCapture(
        read,
        (path) => {
          if (path === sourceOriginPath) {
            reached++;
            return boxed as unknown as string;
          }
          return read(path);
        },
        io,
      ),
    ).toThrow("C1 current source: primitive source required: " + sourceOriginPath);
    expect(reached).toBe(1);
    expect(coerced).toBe(0);
    expect(resolver).toBe(0);
    sourceOriginHealthy();
  });
  it("does not replace a supplied mutant with a second healthy authority read", () => {
    sourceOriginHealthy();
    let reads = 0;
    const mutant = read(sourceOriginPath) + "\n// injected SourceOrigin mutation\n";
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path === sourceOriginPath && ++reads === 1) return mutant;
        return read(path);
      }),
    ).toThrow("C1 current source: full pin mismatch: " + sourceOriginPath);
    expect(reads).toBe(1);
    sourceOriginHealthy();
  });
  it("authenticates a fresh changed authority after a healthy warm capture", () => {
    let reads = 0;
    const reader = (path: string): string =>
      path === sourceOriginPath && ++reads === 2 ? read(path) + "\n// warm SourceOrigin mutation\n" : read(path);
    expect(currentPopulationCapture(read, reader).originals.size).toBe(4);
    expect(() => currentPopulationCapture(read, reader)).toThrow(
      "C1 current source: full pin mismatch: " + sourceOriginPath,
    );
    expect(reads).toBe(2);
    sourceOriginHealthy();
  });
  it.each(["mutation", "missing"] as const)(
    "refuses actual SourceOrigin file %s and preserves exact physical restoration",
    (kind) => {
      const current = sourceOriginHealthy();
      sourceOriginWithFault(sourceOriginPath, kind, () => {
        if (kind === "missing") sourceOriginExpectMissing(() => currentPopulationCapture(read, read), sourceOriginPath);
        else
          expect(() => currentPopulationCapture(read, read)).toThrow(
            "C1 current source: full pin mismatch: " + sourceOriginPath,
          );
      });
      expect(sourceOriginHealthy()).toBe(current);
      expect(pin(read(sourceOriginPath))).toEqual(sourceOriginCurrentPin);
    },
  );
  it("retains current719 closure text and the unchanged thirteen-request fifty-seven-observation resolution", () => {
    const current = sourceOriginHealthy(),
      { data } = manifest();
    const file = ts.createSourceFile(sourceOriginPath, current, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = file.statements
      .filter(ts.isTypeAliasDeclaration)
      .filter((row) => row.name.text === "CompilerSourceProducer");
    expect(declarations).toHaveLength(1);
    const union = declarations[0]!.type;
    if (!ts.isUnionTypeNode(union)) throw Error("actual CompilerSourceProducer union missing");
    expect(
      union.types
        .filter(ts.isLiteralTypeNode)
        .filter((row) => ts.isStringLiteral(row.literal) && row.literal.text === "intl-listformat-prelude"),
    ).toHaveLength(1);
    expect(data.linearOptions.closureInputs[8]).toEqual({ path: sourceOriginPath, pin: sourceOriginCurrentPin });
    expect(data.linearOptions.resolver.requests).toHaveLength(13);
    expect(data.linearOptions.resolver.observations).toHaveLength(57);
    expect(data.linearOptions.resolver.requests[10]).toEqual({
      containingFile: "src/position-map.ts",
      module: "./shared/contracts/source-origin.js",
      target: { scope: "repository", path: sourceOriginPath },
    });
    // ModuleResolutionHost resolves this declaration via fileExists; it does not read its contents.
    expect(
      data.linearOptions.resolver.observations.filter(
        (row: { location: { path: string } }) => row.location.path === sourceOriginPath,
      ),
    ).toEqual([{ operation: "fileExists", location: { scope: "repository", path: sourceOriginPath }, exists: true }]);
    let sourceOriginExists = 0;
    const actual = actualIO();
    const io: C1ResolverObservationIO = {
      fileExists: (path) => {
        if (path === resolve(root, sourceOriginPath)) sourceOriginExists++;
        return actual.fileExists(path);
      },
      directoryExists: actual.directoryExists,
      realpath: actual.realpath,
    };
    expect(currentPopulationCapture(read, read, io).originals.size).toBe(4);
    expect(sourceOriginExists).toBe(1);
  });
  it("separately reads real current SourceOrigin in a TypeScript type program and proves one new literal member", () => {
    sourceOriginHealthy();
    const target = resolve(root, sourceOriginPath);
    const options: ts.CompilerOptions = { noEmit: true, noLib: true };
    const host = ts.createCompilerHost(options);
    const originalRead = host.readFile;
    const supplied: { path: string; source: string }[] = [];
    host.readFile = (path) => {
      const source = originalRead(path);
      if (path === target) {
        expect(typeof source).toBe("string");
        if (source === undefined) throw Error("actual SourceOrigin type-program read missing");
        supplied.push({ path, source });
      }
      return source;
    };
    const program = ts.createProgram([target], options, host);
    const file = program.getSourceFile(target);
    expect(file).toBeDefined();
    if (!file) throw Error("actual SourceOrigin type-program source absent");
    expect(supplied).toHaveLength(1);
    expect(pin(supplied[0]!.source)).toEqual(sourceOriginCurrentPin);
    expect(file.text).toBe(supplied[0]!.source);
    const declarations = file.statements
      .filter(ts.isTypeAliasDeclaration)
      .filter((row) => row.name.text === "CompilerSourceProducer");
    expect(declarations).toHaveLength(1);
    const type = program.getTypeChecker().getTypeAtLocation(declarations[0]!.name);
    expect(type.isUnion()).toBe(true);
    if (!type.isUnion()) throw Error("actual source producer type union absent");
    expect(type.types.filter((row) => row.isStringLiteral() && row.value === "intl-listformat-prelude")).toHaveLength(
      1,
    );
    // This independent program read is outside C1's fixed13/57 ModuleResolutionHost observations.
    sourceOriginHealthy();
  });
});

// Independent fixed source-map recipe authority; production normalizers are
// never used as the oracle for the four historical population operands.
const sourceMapEpochPath = "tests/helpers/ir-source-map-schema-source-epoch.json";
const sourceMapComponentPath = "tests/helpers/ir-program-validator-relocation.ts";
const sourceMapPopulationPaths: readonly string[] = [
  "src/ir/core/nodes.ts",
  "src/ir/program/input-contracts.ts",
  "src/ir/program/prepared-contracts.ts",
  "src/shared/contracts/ir-unit-inventory.ts",
];
const sourceMapClosurePaths = ["src/position-map.ts", "src/shared/contracts/ir-unit-inventory.ts"] as const;
const sourceMapComponentPin = {
  bytes: 46642,
  sha256: "6e32ca208775e8eeae765bf3345cdd3cb1e0f40a1784f684afd9c4dff3a4cfe0",
  gitBlob: "d82bdac04db23be88135f00a2b43bdb172cb5f89",
};
function independentSourceMapPredecessor(path: string, current: string) {
  const raw = read(sourceMapEpochPath);
  expect(Buffer.byteLength(raw)).toBe(49534);
  expect(digest(raw)).toBe("7dda716408c18981a48dc6fba90834aa0e7fb95f3f8900b7c4c16e1545f38f3c");
  const recipe = JSON.parse(raw);
  const matches = recipe.entries.filter((entry: { path: string }) => entry.path === path);
  expect(matches).toHaveLength(1);
  const entry = matches[0];
  expect(entry.current.path).toBe(path);
  expect(entry.before.path).toBe(path);
  const currentPin = { bytes: entry.current.bytes, sha256: entry.current.sha256, gitBlob: entry.current.gitBlob };
  const beforePin = { bytes: entry.before.bytes, sha256: entry.before.sha256, gitBlob: entry.before.gitBlob };
  expect(pin(current)).toEqual(currentPin);
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const span of entry.spans) {
    expect(bytes.subarray(span.currentStart, span.currentEnd).toString("utf8")).toBe(span.currentText);
    parts.push(bytes.subarray(cursor, span.currentStart), Buffer.from(span.beforeText));
    cursor = span.currentEnd;
  }
  parts.push(bytes.subarray(cursor));
  const before = Buffer.concat(parts).toString("utf8");
  expect(pin(before)).toEqual(beforePin);
  const old = Buffer.from(before),
    replay: Buffer[] = [];
  cursor = 0;
  for (const span of entry.spans) {
    expect(old.subarray(span.beforeStart, span.beforeEnd).toString("utf8")).toBe(span.beforeText);
    replay.push(old.subarray(cursor, span.beforeStart), Buffer.from(span.currentText));
    cursor = span.beforeEnd;
  }
  replay.push(old.subarray(cursor));
  const replayed = Buffer.concat(replay).toString("utf8");
  expect(pin(replayed)).toEqual(currentPin);
  expect(replayed).toBe(current);
  return { before, currentPin, beforePin };
}
function sourceMapFactoryHealthy() {
  expect(pin(read(sourceMapComponentPath))).toEqual(sourceMapComponentPin);
  const capture = currentPopulationCapture(read, read);
  expect(capture.historicalPopulation.size).toBe(46);
  expect(capture.observedCurrentPins).toHaveLength(46);
  return capture;
}

describe("C1 source-map epoch actual population and authority operands", () => {
  it.each(sourceMapPopulationPaths)(
    "retains actual current and independently proven historical bytes for %s",
    (path) => {
      const capture = sourceMapFactoryHealthy();
      const current = read(path),
        proven = independentSourceMapPredecessor(path, current);
      expect(capture.historicalPopulation.get(path)).toBe(proven.before);
      expect(capture.observedCurrentPins.find((record) => record.path === path)!.pin).toEqual(pin(current));
      expect(current).not.toBe(proven.before);
      sourceMapFactoryHealthy();
    },
  );
  it.each(sourceMapPopulationPaths)(
    "refuses the warm changed supplied population operand %s and accepts its exact restoration",
    (path) => {
      const healthy = sourceMapFactoryHealthy();
      const current = read(path);
      let operand = current,
        supplied: string | undefined;
      const reader = (request: string): string => {
        if (request !== path) return read(request);
        supplied = operand;
        return operand;
      };
      expect(currentPopulationCapture(reader, read).historicalPopulation).toEqual(healthy.historicalPopulation);
      operand += "\n// actual supplied population mutation\n";
      expect(() => currentPopulationCapture(reader, read)).toThrow(/complete source pin mismatch/);
      expect(supplied).toBe(operand);
      operand = current;
      expect(
        currentPopulationCapture(reader, read).observedCurrentPins.find((record) => record.path === path)!.pin,
      ).toEqual(pin(current));
      sourceMapFactoryHealthy();
    },
  );
  it.each(sourceMapPopulationPaths)("rejects boxed supplied population %s before getters or coercion", (path) => {
    sourceMapFactoryHealthy();
    let getters = 0,
      coercions = 0,
      reached = false;
    const boxed = Object(read(path));
    Object.defineProperty(boxed, Symbol.toPrimitive, {
      get() {
        getters++;
        return () => {
          coercions++;
          return read(path);
        };
      },
    });
    expect(() =>
      currentPopulationCapture((request) => {
        if (request !== path) return read(request);
        reached = true;
        return boxed as string;
      }, read),
    ).toThrow(/primitive source/);
    expect(reached).toBe(true);
    expect([getters, coercions]).toEqual([0, 0]);
    sourceMapFactoryHealthy();
  });
  it.each(sourceMapClosurePaths)(
    "refuses the changed actual native closure source %s without substituting its historical text",
    (path) => {
      sourceMapFactoryHealthy();
      const mutant = read(path) + "\n// actual current closure mutation\n";
      let reached = false;
      const supplied = (request: string): string => {
        if (request !== path) return read(request);
        reached = true;
        return mutant;
      };
      expect(() =>
        sourceMapPopulationPaths.includes(path)
          ? currentPopulationCapture(supplied, read)
          : currentPopulationCapture(read, supplied),
      ).toThrow(/full pin mismatch|complete source pin mismatch/);
      expect(reached).toBe(true);
      sourceMapFactoryHealthy();
    },
  );
  it("rejects a supplied component suffix mutant through full current authority before its prefix-only API", () => {
    sourceMapFactoryHealthy();
    const mutant = read(sourceMapComponentPath) + "\n// supplied component suffix mutation\n";
    let reached = false;
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path !== sourceMapComponentPath) return read(path);
        reached = true;
        return mutant;
      }),
    ).toThrow(/full pin mismatch/);
    expect(reached).toBe(true);
    sourceMapFactoryHealthy();
  });
  it("refuses a boxed component authority without invoking its conversion hooks", () => {
    sourceMapFactoryHealthy();
    let calls = 0,
      reached = false;
    const boxed = Object(read(sourceMapComponentPath));
    Object.defineProperty(boxed, "valueOf", {
      get() {
        calls++;
        return () => {
          calls++;
          return read(sourceMapComponentPath);
        };
      },
    });
    expect(() =>
      currentPopulationCapture(read, (path) => {
        if (path !== sourceMapComponentPath) return read(path);
        reached = true;
        return boxed as string;
      }),
    ).toThrow(/primitive source/);
    expect(reached).toBe(true);
    expect(calls).toBe(0);
    sourceMapFactoryHealthy();
  });
  for (const kind of ["missing", "corrupt", "stale recipe"] as const)
    it(`refuses a supplied ${kind} source-map epoch and observes exact restoration`, () => {
      sourceMapFactoryHealthy();
      const original = read(sourceMapEpochPath),
        recipe = JSON.parse(original);
      recipe.entries.find((entry: { path: string }) => entry.path === "src/ir/program/validation.ts").current =
        recipe.entries.find((entry: { path: string }) => entry.path === "src/ir/program/validation.ts").before;
      let reached = false;
      const mutant = kind === "corrupt" ? original + "{" : JSON.stringify(recipe);
      expect(() =>
        currentPopulationCapture(read, (path) => {
          if (path !== sourceMapEpochPath) return read(path);
          reached = true;
          if (kind === "missing") return read(path + ".missing-independent-control");
          return mutant;
        }),
      ).toThrow(kind === "missing" ? /ENOENT/ : /source map schema receipt bytes mismatch/);
      expect(reached).toBe(true);
      // Corrupt/stale records stop at the immutable recipe digest, not a row guard.
      sourceMapFactoryHealthy();
    });
});

const remainderPreparationPath = "src/ir/runtime/intrinsic-preparation.ts";
const remainderPolicyPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const remainderIndependentProof = {
  source: {
    before: {
      bytes: 49541,
      sha256: "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",
      gitBlob: "d8726293aa8df3f95df1962e4c21df437d37d723",
    },
    current: {
      bytes: 49704,
      sha256: "171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82",
      gitBlob: "f018b105325cdd04934ba538bb5e32ef115b7976",
    },
    edits: [
      {
        beforeOffset: 1142,
        afterOffset: 1142,
        before: "",
        after: 'import { irNumberRemainderCallableDeclaration } from "./number-remainder-callables.js";\n',
      },
      {
        beforeOffset: 39459,
        afterOffset: 39547,
        before: "                  irOrdinaryObjectCallableDeclaration(declaration.ref))\n",
        after:
          "                  irOrdinaryObjectCallableDeclaration(declaration.ref) ||\n                  irNumberRemainderCallableDeclaration(declaration.ref))\n",
      },
    ],
  },
  helper: { before: independentRemainderPolicyEpoch.beforePin, current: independentRemainderPolicyEpoch.currentPin },
} as const;
function independentlyInvertRemainderBytes(current: string, proof: typeof remainderIndependentProof.source): string {
  const bytes = Buffer.from(current, "utf8");
  expect(pin(current)).toEqual(proof.current);
  const pieces: Buffer[] = [];
  let end = 0;
  for (const edit of proof.edits) {
    const after = Buffer.from(edit.after),
      before = Buffer.from(edit.before);
    expect(bytes.subarray(edit.afterOffset, edit.afterOffset + after.length)).toEqual(after);
    pieces.push(bytes.subarray(end, edit.afterOffset), before);
    end = edit.afterOffset + after.length;
  }
  pieces.push(bytes.subarray(end));
  const previous = Buffer.concat(pieces);
  expect(pin(previous.toString("utf8"))).toEqual(proof.before);
  const replay: Buffer[] = [];
  end = 0;
  for (const edit of proof.edits) {
    const before = Buffer.from(edit.before);
    expect(previous.subarray(edit.beforeOffset, edit.beforeOffset + before.length)).toEqual(before);
    replay.push(previous.subarray(end, edit.beforeOffset), Buffer.from(edit.after));
    end = edit.beforeOffset + before.length;
  }
  replay.push(previous.subarray(end));
  expect(Buffer.concat(replay)).toEqual(bytes);
  return previous.toString("utf8");
}
function remainderPolicyHealthy(): void {
  currentHistoricalAuthority(read);
  expect(runtimePreparationRemainderHistoricalSource(read(remainderPreparationPath))).toBe(
    independentlyInvertRemainderBytes(read(remainderPreparationPath), remainderIndependentProof.source),
  );
  const receipt = authenticateRuntimePreparationPolicyEvolution();
  expect(receipt.sourceInputs.find((entry) => entry.path === remainderPreparationPath)).toEqual({
    path: remainderPreparationPath,
    bytes: remainderIndependentProof.source.before.bytes,
    sha256: remainderIndependentProof.source.before.sha256,
  });
  expect(authenticateCurrentMainInventoryEvolution().schema).toBe(1);
}
function remainderSourceWithFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (path !== remainderPreparationPath) throw new Error("unapproved remainder source authority fault: " + path);
  if (byte !== 0) throw new Error("unapproved remainder source fault byte");
  const target = resolve(root, path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-remainder-source-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = resolve(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(resolve(scratch, "operation-"));
    backup = resolve(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        booleanTypesExpectMissing(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        booleanTypesExpectMissing(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

describe("C1 finite numeric remainder historical inputs", () => {
  it("independently proves exact current source inverse and full forward replay", () => {
    const current = read(remainderPreparationPath);
    const prior = independentlyInvertRemainderBytes(current, remainderIndependentProof.source);
    expect(runtimePreparationRemainderHistoricalSource(current)).toBe(prior);
    remainderPolicyHealthy();
  });
  it("rejects the still-geometrical raw prefix before accepting the genuine recovered remainder prefix", () => {
    const current = read(remainderPolicyPath);
    const rawPrefix = Buffer.from(current).subarray(0, remainderIndependentProof.helper.current.bytes).toString("utf8");
    expect(pin(rawPrefix)).not.toEqual(remainderIndependentProof.helper.current);
    expect(() => independentlyInvertRemainderPolicyBytes(rawPrefix)).toThrow();
    const recovered = independentlyAcquireRemainderPolicyPrefix(current);
    const historical = independentlyInvertRemainderPolicyBytes(recovered);
    expect(pin(historical)).toEqual(remainderIndependentProof.helper.before);
  });
  it.each([318, 350593, 411836] as const)(
    "refuses complete policy geometry byte mutation at %s before the old remainder algorithms",
    (at) => {
      const current = read(remainderPolicyPath);
      const mutant = current.slice(0, at) + (current[at] === "x" ? "y" : "x") + current.slice(at + 1);
      expect(Buffer.byteLength(mutant)).toBe(Buffer.byteLength(current));
      expect(() => independentlyAcquireRemainderPolicyPrefix(mutant)).toThrow();
      const prefix = independentlyAcquireRemainderPolicyPrefix(current);
      independentlyInvertRemainderPolicyBytes(prefix);
    },
  );
  it.each([
    ["DATA", independentProgramDataEpoch],
    ["policy geometry", independentPolicyGeometryEpoch],
  ] as const)("checks inverse and independently authored forward recipe authority for %s", (_label, proof) => {
    const current = read(proof.path);
    const inverse = proof.inverse.map((span, index) => (index === 0 ? { ...span, to: "x" + span.to } : span));
    const forward = proof.forward.map((span, index) => (index === 0 ? { ...span, to: "x" + span.to } : span));
    const acquire =
      proof.path === remainderPolicyPath ? independentlyAcquirePolicyGeometryEpoch : independentlyAcquireFixtureEpoch;
    expect(() => acquire(current, { ...proof, inverse })).toThrow();
    expect(() => acquire(current, { ...proof, forward })).toThrow();
    acquire(current, proof);
  });
  it("independently recovers the complete prior helper before every old prefix algorithm", () => {
    const prefix = independentlyAcquireRemainderPolicyPrefix(read(remainderPolicyPath));
    independentlyInvertRemainderPolicyBytes(prefix);
    remainderPolicyHealthy();
  });
  it.each(["missing import", "missing predicate", "unrelated byte", "exact stale original"] as const)(
    "refuses %s as current preparation source",
    (kind) => {
      const current = read(remainderPreparationPath);
      const old = independentlyInvertRemainderBytes(current, remainderIndependentProof.source);
      const mutant =
        kind === "missing import"
          ? current.replace(remainderIndependentProof.source.edits[0].after, "")
          : kind === "missing predicate"
            ? current.replace(
                remainderIndependentProof.source.edits[1].after,
                remainderIndependentProof.source.edits[1].before,
              )
            : kind === "unrelated byte"
              ? current.replace("Licensed", "licensed")
              : old;
      expect(mutant).not.toBe(current);
      runtimePreparationRemainderHistoricalSource(current);
      expect(() => runtimePreparationRemainderHistoricalSource(mutant)).toThrow(
        "complete current remainder preparation source changed",
      );
      remainderPolicyHealthy();
    },
  );
  it("refuses non-string current source without coercion", () => {
    let coercions = 0;
    const source = {
      toString() {
        coercions++;
        return read(remainderPreparationPath);
      },
    };
    expect(() => runtimePreparationRemainderHistoricalSource(source)).toThrow(
      "primitive current remainder preparation source required",
    );
    expect(coercions).toBe(0);
    remainderPolicyHealthy();
  });
  it("rereads a changed actual source after healthy capture and restores exact custody", () => {
    const original = read(remainderPreparationPath);
    remainderPolicyHealthy();
    remainderSourceWithFault(remainderPreparationPath, "mutation", () => {
      expect(() => authenticateRuntimePreparationPolicyEvolution()).toThrow(
        "complete current remainder preparation source changed",
      );
    });
    expect(read(remainderPreparationPath)).toBe(original);
    expect(pin(read(remainderPreparationPath))).toEqual(remainderIndependentProof.source.current);
    remainderPolicyHealthy();
  });
});

describe("C1 program-data caller remainder reader association", () => {
  it.each([
    [
      "preparation import",
      'import { beforeRemainderRuntimePreparationRelocation as beforeRuntimePreparationRelocation } from "./helpers/ir-remainder-runtime-preparation-relocation.js";',
      'import { beforeRuntimePreparationRelocation } from "./helpers/ir-runtime-preparation-relocation.js";',
    ],
    [
      "contract import",
      'import { runtimeContractCurrentPaths } from "./helpers/ir-runtime-contract-evolution.js";\nimport { reconstructRemainderRuntimeContractReceiptSources as reconstructRuntimeContractReceiptSources } from "./helpers/ir-remainder-runtime-contract-evolution.js";',
      'import {\n  reconstructRuntimeContractReceiptSources,\n  runtimeContractCurrentPaths,\n} from "./helpers/ir-runtime-contract-evolution.js";',
    ],
  ] as const)(
    "refuses a warm rolled-back %s and accepts fresh exact restoration",
    (_label, currentImport, oldImport) => {
      const path = "tests/issue-3518-program-data-contract-boundary.test.ts";
      const current = read(path);
      let operand = current,
        supplied: string | undefined;
      const reader = (request: string): string => {
        if (request !== path) return read(request);
        supplied = operand;
        return operand;
      };
      const healthy = currentHistoricalAuthority(reader);
      expect(supplied).toBe(current);
      operand = replaceOnce(current, currentImport, oldImport);
      expect(operand).not.toBe(current);
      expect(operand).toContain(oldImport);
      expect(operand).not.toContain(currentImport);
      expect(() => currentHistoricalAuthority(reader)).toThrow(
        "C1 historical authority: full-file pin changed: " + path,
      );
      expect(supplied).toBe(operand);
      operand = current;
      const restored = currentHistoricalAuthority(reader);
      expect(supplied).toBe(current);
      expect(restored).not.toBe(healthy);
      expect(restored.linearOptions).toEqual(healthy.linearOptions);
      expect(pin(read(path))).toEqual(pin(current));
    },
  );
});

describe("C1 initial-graph optional-field reader association", () => {
  it.each([
    [
      "tests/issue-3518-program-data-contract-boundary.test.ts",
      "beforeOptionalFieldModuleRecords(initialPreCProgramRead)",
      "initialPreCProgramRead",
    ],
    [
      "tests/issue-3518-program-initial-graph-evolution.test.ts",
      "return beforeOptionalFieldModuleRecords(beforeSourceEpoch);",
      "return beforeSourceEpoch;",
    ],
  ] as const)(
    "refuses a warm adapter operand rollback in %s and accepts exact fresh restoration",
    (path, currentView, oldView) => {
      const current = read(path);
      let operand = current,
        supplied: string | undefined;
      const reader = (request: string): string => {
        if (request !== path) return read(request);
        supplied = operand;
        return operand;
      };
      const healthy = currentHistoricalAuthority(reader);
      expect(supplied).toBe(current);
      operand = replaceOnce(current, currentView, oldView);
      expect(operand).not.toBe(current);
      expect(operand).toContain(oldView);
      expect(operand).not.toContain(currentView);
      expect(() => currentHistoricalAuthority(reader)).toThrow(
        "C1 historical authority: full-file pin changed: " + path,
      );
      expect(supplied).toBe(operand);
      operand = current;
      const restored = currentHistoricalAuthority(reader);
      expect(supplied).toBe(current);
      expect(restored).not.toBe(healthy);
      expect(restored.linearOptions).toEqual(healthy.linearOptions);
      expect(pin(read(path))).toEqual(pin(current));
    },
  );
});

describe("C1 independent policy history fixture extraction custody", () => {
  it("pins the complete pure helper and the retained two-stage C1 acquisition association", () => {
    const source = read("tests/helpers/ir-independent-policy-history-fixture.ts");
    expect(pin(source)).toEqual({
      bytes: 24394,
      sha256: "09bf4df558c226a1291ec07d279f0c6f3172beefff6a61f588395a367231bff7",
      gitBlob: "a3d9aca3efd83bfdecc9001b38d8bf7c84b071ce",
    });
    const current = read(remainderPolicyPath);
    const prefix = independentlyAcquireRemainderPolicyPrefix(current);
    const historical = independentlyInvertRemainderPolicyBytes(prefix);
    expect(pin(historical)).toEqual(remainderIndependentProof.helper.before);
    expect(independentlyAcquireHistoricalPolicyHelper(current)).toBe(historical);
    remainderPolicyHealthy();
  });
});

// Number N2/H1b successor, with complete N1/H1a/R1/A1 intermediate evidence retained.
function freezeCompositionLiteral<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeCompositionLiteral(child);
    Object.freeze(value);
  }
  return value;
}
const numberCallerStage = freezeCompositionLiteral({
  path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
  beforePin: {
    bytes: 113131,
    sha256: "81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae",
    gitBlob: "4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84",
  },
  currentPin: {
    bytes: 116007,
    sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",
    gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",
  },
  inverse: [
    {
      inputOffset: 2335,
      outputOffset: 2335,
      from: "  beforeRuntimePreparationPolicySource,\n  runtimePreparationRemainderHistoricalSource,\n",
      to: "  beforeRuntimePreparationPolicySource,\n",
    },
    {
      inputOffset: 42006,
      outputOffset: 41959,
      from: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n  const readPinnedPreparationOperand = (operandPath: string): string => {\n    const source = readHistoricalPolicyOperand(operandPath);\n    return operandPath === "src/ir/runtime/intrinsic-preparation.ts"\n      ? runtimePreparationRemainderHistoricalSource(source)\n      : source;\n  };\n',
      to: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n',
    },
    {
      inputOffset: 47703,
      outputOffset: 47371,
      from: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      const source = readPinnedPreparationOperand(pin.path);\n      expect([Buffer.byteLength(source), sha(source)]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
      to: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      expect([Buffer.byteLength(read(pin.path)), sha(read(pin.path))]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
    },
    {
      inputOffset: 48220,
      outputOffset: 47843,
      from: '  it("successor reader freshly proves current preparation bytes and preserves every other raw operand channel", () => {\n    const actual = readHistoricalPolicyOperand(path);\n    const historical = readPinnedPreparationOperand(path);\n    expect([Buffer.byteLength(actual), sha(actual)]).toEqual([\n      49704,\n      "171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82",\n    ]);\n    expect([Buffer.byteLength(historical), sha(historical)]).toEqual([\n      49541,\n      "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n    ]);\n    expect(historical).not.toBe(actual);\n    for (const pin of [...authority().sourceInputs, authority().numberReceipt]) {\n      if (pin.path !== path) expect(readPinnedPreparationOperand(pin.path)).toBe(readHistoricalPolicyOperand(pin.path));\n    }\n    const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";\n    const helper = readHistoricalPolicyOperand(helperPath);\n    expect(readPinnedPreparationOperand(helperPath)).toBe(helper);\n    expect(Buffer.byteLength(helper)).toBe(93405);\n    expect(createHash("sha256").update(Buffer.from(helper).subarray(0, 40368)).digest("hex")).toBe(\n      "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",\n    );\n    accept(current());\n  });\n\n  it.each([0, 1142, 39547, 49703] as const)(\n    "successor reader freshly refuses actual preparation byte %s after success and restores",\n    (offset) => {\n      const original = readHistoricalPolicyOperand(path);\n      const healthy = readPinnedPreparationOperand(path);\n      const exact = new URL(`../${path}`, import.meta.url).pathname;\n      expect([Buffer.byteLength(healthy), sha(healthy)]).toEqual([\n        49541,\n        "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n      ]);\n      accept(current());\n      try {\n        intercepted.set(exact, offset);\n        interceptedReads.set(exact, 0);\n        expect(readHistoricalPolicyOperand(path)).not.toBe(original);\n        expect(() => readPinnedPreparationOperand(path)).toThrow(\n          new Error("current main inventory evolution: complete current remainder preparation source changed"),\n        );\n        expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(2);\n      } finally {\n        intercepted.delete(exact);\n        interceptedReads.delete(exact);\n      }\n      expect(readHistoricalPolicyOperand(path)).toBe(original);\n      expect(readPinnedPreparationOperand(path)).toBe(healthy);\n      accept(current());\n    },\n  );\n\n  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
      to: '  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
    },
  ],
  forward: [
    {
      inputOffset: 2335,
      outputOffset: 2335,
      from: "  beforeRuntimePreparationPolicySource,\n",
      to: "  beforeRuntimePreparationPolicySource,\n  runtimePreparationRemainderHistoricalSource,\n",
    },
    {
      inputOffset: 41959,
      outputOffset: 42006,
      from: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n',
      to: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n  const readPinnedPreparationOperand = (operandPath: string): string => {\n    const source = readHistoricalPolicyOperand(operandPath);\n    return operandPath === "src/ir/runtime/intrinsic-preparation.ts"\n      ? runtimePreparationRemainderHistoricalSource(source)\n      : source;\n  };\n',
    },
    {
      inputOffset: 47371,
      outputOffset: 47703,
      from: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      expect([Buffer.byteLength(read(pin.path)), sha(read(pin.path))]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
      to: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      const source = readPinnedPreparationOperand(pin.path);\n      expect([Buffer.byteLength(source), sha(source)]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
    },
    {
      inputOffset: 47843,
      outputOffset: 48220,
      from: '  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
      to: '  it("successor reader freshly proves current preparation bytes and preserves every other raw operand channel", () => {\n    const actual = readHistoricalPolicyOperand(path);\n    const historical = readPinnedPreparationOperand(path);\n    expect([Buffer.byteLength(actual), sha(actual)]).toEqual([\n      49704,\n      "171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82",\n    ]);\n    expect([Buffer.byteLength(historical), sha(historical)]).toEqual([\n      49541,\n      "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n    ]);\n    expect(historical).not.toBe(actual);\n    for (const pin of [...authority().sourceInputs, authority().numberReceipt]) {\n      if (pin.path !== path) expect(readPinnedPreparationOperand(pin.path)).toBe(readHistoricalPolicyOperand(pin.path));\n    }\n    const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";\n    const helper = readHistoricalPolicyOperand(helperPath);\n    expect(readPinnedPreparationOperand(helperPath)).toBe(helper);\n    expect(Buffer.byteLength(helper)).toBe(93405);\n    expect(createHash("sha256").update(Buffer.from(helper).subarray(0, 40368)).digest("hex")).toBe(\n      "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",\n    );\n    accept(current());\n  });\n\n  it.each([0, 1142, 39547, 49703] as const)(\n    "successor reader freshly refuses actual preparation byte %s after success and restores",\n    (offset) => {\n      const original = readHistoricalPolicyOperand(path);\n      const healthy = readPinnedPreparationOperand(path);\n      const exact = new URL(`../${path}`, import.meta.url).pathname;\n      expect([Buffer.byteLength(healthy), sha(healthy)]).toEqual([\n        49541,\n        "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n      ]);\n      accept(current());\n      try {\n        intercepted.set(exact, offset);\n        interceptedReads.set(exact, 0);\n        expect(readHistoricalPolicyOperand(path)).not.toBe(original);\n        expect(() => readPinnedPreparationOperand(path)).toThrow(\n          new Error("current main inventory evolution: complete current remainder preparation source changed"),\n        );\n        expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(2);\n      } finally {\n        intercepted.delete(exact);\n        interceptedReads.delete(exact);\n      }\n      expect(readHistoricalPolicyOperand(path)).toBe(original);\n      expect(readPinnedPreparationOperand(path)).toBe(healthy);\n      accept(current());\n    },\n  );\n\n  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
    },
  ],
} as const);
const h1CallerStage = freezeCompositionLiteral({
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 96713,
    sha256: "cc4ef7be19720ccf45e3cdd857ff373a9a770460c81cdc2bf8b1f7460754c8c3",
    gitBlob: "79854cea40345e4b216cc6781d6193552988531b",
  },
  currentPin: {
    bytes: 96713,
    sha256: "7bbfaf6687f7411147f00833380027d3959b743ec7dc033fc9bba8d69849992b",
    gitBlob: "c59701cc36595cea2536c35edcc1e42278ba3e5c",
  },
  inverse: [
    {
      inputOffset: 47330,
      outputOffset: 47330,
      from: '    currentPin: {\n      bytes: 116007,\n      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",\n      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",\n    },\n',
      to: '    currentPin: {\n      bytes: 113131,\n      sha256: "81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae",\n      gitBlob: "4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84",\n    },\n',
    },
  ],
  forward: [
    {
      inputOffset: 47330,
      outputOffset: 47330,
      from: '    currentPin: {\n      bytes: 113131,\n      sha256: "81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae",\n      gitBlob: "4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84",\n    },\n',
      to: '    currentPin: {\n      bytes: 116007,\n      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",\n      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",\n    },\n',
    },
  ],
} as const);
const numberCallerOld = freezeCompositionLiteral({
  path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
  beforePin: {
    bytes: 112437,
    sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",
    gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",
  },
  currentPin: {
    bytes: 113131,
    sha256: "81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae",
    gitBlob: "4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84",
  },
  inverse: [
    {
      inputOffset: 4154,
      outputOffset: 4154,
      from: 'import {\n  captureGeometryCurrentMainPredecessorPolicySource,\n  c1HistoricalArtifactPath,\n  type C1HistoricalLogicalPath,\n} from "./helpers/ir-c1-historical-authority.js";\n',
      to: 'import { c1HistoricalArtifactPath, type C1HistoricalLogicalPath } from "./helpers/ir-c1-historical-authority.js";\n',
    },
    {
      inputOffset: 6801,
      outputOffset: 6743,
      from: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
      to: '                                      read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 43224,
      outputOffset: 43034,
      from: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
      to: '                                      read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 61407,
      outputOffset: 61085,
      from: '                                    captureGeometryCurrentMainPredecessorPolicySource(\n                                      read("scripts/compiler-boundaries.json"),\n                                    ),\n',
      to: '                                    read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 82748,
      outputOffset: 82298,
      from: '                                  captureGeometryCurrentMainPredecessorPolicySource(\n                                    read("scripts/compiler-boundaries.json"),\n                                  ),\n',
      to: '                                  read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 98030,
      outputOffset: 97456,
      from: '                                captureGeometryCurrentMainPredecessorPolicySource(\n                                  read("scripts/compiler-boundaries.json"),\n                                ),\n',
      to: '                                read("scripts/compiler-boundaries.json"),\n',
    },
  ],
  forward: [
    {
      inputOffset: 4154,
      outputOffset: 4154,
      from: 'import { c1HistoricalArtifactPath, type C1HistoricalLogicalPath } from "./helpers/ir-c1-historical-authority.js";\n',
      to: 'import {\n  captureGeometryCurrentMainPredecessorPolicySource,\n  c1HistoricalArtifactPath,\n  type C1HistoricalLogicalPath,\n} from "./helpers/ir-c1-historical-authority.js";\n',
    },
    {
      inputOffset: 6743,
      outputOffset: 6801,
      from: '                                      read("scripts/compiler-boundaries.json"),\n',
      to: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
    },
    {
      inputOffset: 43034,
      outputOffset: 43224,
      from: '                                      read("scripts/compiler-boundaries.json"),\n',
      to: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
    },
    {
      inputOffset: 61085,
      outputOffset: 61407,
      from: '                                    read("scripts/compiler-boundaries.json"),\n',
      to: '                                    captureGeometryCurrentMainPredecessorPolicySource(\n                                      read("scripts/compiler-boundaries.json"),\n                                    ),\n',
    },
    {
      inputOffset: 82298,
      outputOffset: 82748,
      from: '                                  read("scripts/compiler-boundaries.json"),\n',
      to: '                                  captureGeometryCurrentMainPredecessorPolicySource(\n                                    read("scripts/compiler-boundaries.json"),\n                                  ),\n',
    },
    {
      inputOffset: 97456,
      outputOffset: 98030,
      from: '                                read("scripts/compiler-boundaries.json"),\n',
      to: '                                captureGeometryCurrentMainPredecessorPolicySource(\n                                  read("scripts/compiler-boundaries.json"),\n                                ),\n',
    },
  ],
} as const);
const h1CallerOld = freezeCompositionLiteral({
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 44161,
    sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",
    gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",
  },
  currentPin: {
    bytes: 96713,
    sha256: "cc4ef7be19720ccf45e3cdd857ff373a9a770460c81cdc2bf8b1f7460754c8c3",
    gitBlob: "79854cea40345e4b216cc6781d6193552988531b",
  },
  inverse: [
    {
      inputOffset: 238,
      outputOffset: 238,
      from: 'import * as c1AuthorityRoot from "./ir-c1-authority-root.js";\n',
      to: "",
    },
    {
      inputOffset: 34274,
      outputOffset: 34212,
      from: '  const geometryDigest = geometryAnchorDigest(false);\n  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))\n    fail("warm anchor source changed");\n',
      to: '  if (anchor !== canonicalAnchor) fail("warm anchor source changed");\n',
    },
    {
      inputOffset: 36516,
      outputOffset: 36329,
      from: "  let contract = validateLinearOptions(manifest.linearOptions);\n",
      to: "  const contract = validateLinearOptions(manifest.linearOptions);\n",
    },
    {
      inputOffset: 36828,
      outputOffset: 36643,
      from: '  const instrumentTexts = new Map<string, string>();\n  let successor: Data | undefined;\n  for (const record of instruments) {\n    const text = readText(readAuthority, record.path);\n    instrumentTexts.set(record.path, text);\n    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);\n    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {\n      successor ??= captureGeometrySuccessor(readAuthority);\n      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);\n    } else requirePin(text, record.pin, record.path);\n  }\n  if (successor) {\n    // Never combine an old supplied instrument with another instrument\'s successor epoch.\n    for (const value of array(successor.instruments, "geometry instruments")) {\n      const record = value as Data;\n      requirePin(\n        instrumentTexts.get(record.path as string)!,\n        validatePin(record.currentPin, "geometry current pin"),\n        "complete geometry instrument epoch",\n      );\n    }\n    contract = geometryLinearOptions(contract, successor.linearOptions);\n  }\n',
      to: "  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);\n",
    },
    {
      inputOffset: 41211,
      outputOffset: 40026,
      from: "function validateResolverTopology(resolver: Data, currentGeometry = false): void {\n  const expectedRequests = currentGeometry\n    ? [...fixedResolverRequests, ...geometryResolverRequests]\n    : fixedResolverRequests;\n",
      to: "function validateResolverTopology(resolver: Data): void {\n",
    },
    {
      inputOffset: 41729,
      outputOffset: 40385,
      from: '  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");\n',
      to: '  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");\n',
    },
    {
      inputOffset: 42417,
      outputOffset: 41078,
      from: "  for (const request of expectedRequests) {\n",
      to: "  for (const request of fixedResolverRequests) {\n",
    },
    {
      inputOffset: 45495,
      outputOffset: 44161,
      from: '\n// One finite geometry successor. ROOT owns the receipt and independent anchor activation.\nconst geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";\nconst geometryCallerContracts = [\n  {\n    path: "tests/issue-3518-program-data-contract-boundary.test.ts",\n    beforePin: {\n      bytes: 33595,\n      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",\n      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",\n    },\n    currentPin: {\n      bytes: 33840,\n      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",\n      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",\n    },\n  },\n  {\n    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 28811,\n      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",\n      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",\n    },\n    currentPin: {\n      bytes: 29161,\n      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",\n      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",\n    },\n  },\n  {\n    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 29570,\n      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",\n      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",\n    },\n    currentPin: {\n      bytes: 29764,\n      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",\n      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",\n    },\n  },\n  {\n    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 112437,\n      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",\n      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",\n    },\n    currentPin: {\n      bytes: 113131,\n      sha256: "81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae",\n      gitBlob: "4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84",\n    },\n  },\n] as const;\nconst geometryInstrumentPins: readonly C1PathPin[] = [\n  {\n    path: "tests/helpers/ir-c1-historical-authority.ts",\n    pin: {\n      bytes: 44161,\n      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",\n      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",\n    },\n  },\n  {\n    path: "tests/helpers/ir-c1-current-source.ts",\n    pin: {\n      bytes: 42599,\n      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",\n      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",\n    },\n  },\n  {\n    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    pin: {\n      bytes: 409599,\n      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",\n      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",\n    },\n  },\n  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),\n];\nconst geometryClosurePins: readonly C1PathPin[] = [\n  {\n    path: "src/ir/analysis/linear-memory-plan.ts",\n    pin: {\n      bytes: 45359,\n      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",\n      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",\n    },\n  },\n  {\n    path: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 3161,\n      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",\n      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",\n    },\n  },\n  {\n    path: "src/shared/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 7580,\n      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",\n      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",\n    },\n  },\n];\nconst geometryResolverRequests: readonly C1ResolverRequest[] = [\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "./contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    module: "../../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n];\nfunction geometryAnchorDigest(required: boolean): string | undefined {\n  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");\n  if (descriptor === undefined) {\n    if (required) fail("geometry instrument authority not activated");\n    return undefined;\n  }\n  if (\n    !Object.hasOwn(descriptor, "value") ||\n    typeof descriptor.value !== "string" ||\n    !/^[a-f0-9]{64}$/.test(descriptor.value)\n  )\n    fail("geometry instrument anchor data digest required");\n  return descriptor.value;\n}\nfunction geometryAnchorLine(digest: string | undefined): string {\n  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\\n`;\n}\nfunction captureGeometrySuccessor(readAuthority: AuthorityReader): Data {\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const digest = geometryAnchorDigest(true);\n  const anchor = readText(readAuthority, anchorPath);\n  const canonical =\n    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\n" +\n    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\\n` +\n    geometryAnchorLine(digest);\n  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");\n  const raw = readText(readAuthority, geometrySuccessorPath);\n  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");\n  const receipt = keys(\n    parseJson(raw, geometrySuccessorPath),\n    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],\n    "geometry instrument receipt",\n  );\n  if (\n    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||\n    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256\n  )\n    fail("geometry instrument receipt domain");\n  const instruments = array(receipt.instruments, "geometry instruments");\n  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");\n  instruments.forEach((value, index) => {\n    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");\n    if (\n      record.path !== geometryInstrumentPins[index]!.path ||\n      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)\n    )\n      fail("geometry instrument predecessor domain");\n    const currentPin = validatePin(record.currentPin, "geometry current pin");\n    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);\n    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(record[direction], "geometry " + direction);\n      if (!spans.length) fail("geometry instrument missing " + direction);\n      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));\n    }\n  });\n  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");\n  validatePrerequisiteSection(receipt.policySource, "policySource");\n  return receipt;\n}\nfunction geometryInstrumentReplay(\n  source: string,\n  spans: unknown,\n  target: C1Pin,\n  stage = "geometry instrument",\n): string {\n  const bytes = Buffer.from(source, "utf8");\n  const pieces: Buffer[] = [];\n  let inputEnd = 0,\n    outputEnd = 0,\n    previousInput = -1,\n    previousOutput = -1;\n  for (const value of array(spans, "geometry replay spans")) {\n    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");\n    if (\n      !Number.isSafeInteger(span.inputOffset) ||\n      !Number.isSafeInteger(span.outputOffset) ||\n      typeof span.from !== "string" ||\n      typeof span.to !== "string"\n    )\n      fail(stage + " span data");\n    const inputOffset = span.inputOffset as number,\n      outputOffset = span.outputOffset as number;\n    const from = Buffer.from(span.from),\n      to = Buffer.from(span.to);\n    if (\n      inputOffset < inputEnd ||\n      outputOffset < outputEnd ||\n      inputOffset <= previousInput ||\n      outputOffset <= previousOutput ||\n      inputOffset - inputEnd !== outputOffset - outputEnd ||\n      inputOffset + from.length > bytes.length ||\n      outputOffset + to.length > target.bytes ||\n      from.toString("utf8") !== span.from ||\n      to.toString("utf8") !== span.to ||\n      span.from === span.to ||\n      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)\n    )\n      fail(stage + " span membership/coordinates");\n    pieces.push(bytes.subarray(inputEnd, inputOffset), to);\n    previousInput = inputOffset;\n    previousOutput = outputOffset;\n    inputEnd = inputOffset + from.length;\n    outputEnd = outputOffset + to.length;\n  }\n  pieces.push(bytes.subarray(inputEnd));\n  const output = Buffer.concat(pieces).toString("utf8");\n  requirePin(output, target, stage + " replay");\n  return output;\n}\nfunction geometryInstrumentBefore(path: string, source: string, receipt: Data): string {\n  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as\n    | Data\n    | undefined;\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");\n  const before = geometryInstrumentReplay(\n    source,\n    record.inverse,\n    validatePin(record.beforePin, path),\n    "geometry instrument inverse: " + path,\n  );\n  const replay = geometryInstrumentReplay(\n    before,\n    record.forward,\n    validatePin(record.currentPin, path),\n    "geometry instrument forward: " + path,\n  );\n  if (replay !== source) fail("geometry independent instrument forward equality: " + path);\n  return before;\n}\n/** Exactly seven published instruments; primitive/path/reader checks precede IO. */\nexport function c1GeometryInstrumentPredecessor(\n  path: string,\n  source: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof path !== "string" || typeof source !== "string")\n    fail("geometry instrument primitive path/source required");\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const record = geometryInstrumentPins.find((entry) => entry.path === path);\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  // Exact original supplied inputs retain their pre-existing authority path.\n  if (same(measured(source), record.pin)) return source;\n  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));\n}\nfunction geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {\n  const contract = keys(\n    value,\n    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],\n    "geometry linear options",\n  );\n  const expectedClosure = [\n    ...before.closureInputs.map((entry) =>\n      entry.path === geometryClosurePins[0]!.path\n        ? geometryClosurePins[0]!\n        : entry.path === "src/codegen-linear/c-abi.ts"\n          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }\n          : entry,\n    ),\n    ...geometryClosurePins.slice(1),\n  ];\n  if (\n    contract.sourcePath !== before.sourcePath ||\n    !same(contract.declaration, before.declaration) ||\n    !same(contract.bindings, before.bindings) ||\n    !same(contract.closureInputs, expectedClosure)\n  )\n    fail("geometry-only closure successor");\n  const resolver = keys(\n    contract.resolver,\n    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],\n    "geometry resolver",\n  );\n  if (\n    !same(resolver.configInputs, before.resolver.configInputs) ||\n    resolver.optionsSource !== before.resolver.optionsSource ||\n    resolver.optionsSha256 !== before.resolver.optionsSha256\n  )\n    fail("geometry resolver configuration changed");\n  validateResolverTopology(resolver, true);\n  const observations = array(resolver.observations, "geometry observations");\n  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))\n    fail("unrelated geometry resolver transcript drift");\n  return contract as unknown as C1LinearOptionsContract;\n}\n\n// Fixed Git identities and full pins independently checked against the adopted Astra amendment.\nconst cabiSourceEpochContracts = [\n  {\n    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",\n    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",\n    beforePin: {\n      bytes: 26965,\n      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",\n      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",\n    },\n    currentPin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n  },\n  {\n    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",\n    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",\n    beforePin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n    currentPin: {\n      bytes: 27454,\n      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",\n      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",\n    },\n  },\n] as const;\nconst policySourceEpochContracts = [\n  {\n    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",\n    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",\n    beforePin: {\n      bytes: 599721,\n      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",\n      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",\n    },\n    currentPin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n  },\n  {\n    commit: "1156d385765f06d675bc6f6c25caa138501fef58",\n    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",\n    beforePin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n    currentPin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n  },\n  {\n    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",\n    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",\n    beforePin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n    currentPin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n  },\n  {\n    commit: "534620a636c63c257bc5afb8d543d0306b26928c",\n    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",\n    beforePin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n    currentPin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n  },\n  {\n    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",\n    parent: "26091eabd4561e5be154741e7e18143070d3ce59",\n    beforePin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n    currentPin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n  },\n  {\n    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",\n    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",\n    beforePin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n    currentPin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n  },\n  {\n    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",\n    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",\n    beforePin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n    currentPin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n  },\n  {\n    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",\n    beforePin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n    currentPin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n  },\n  {\n    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",\n    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    beforePin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n    currentPin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n  },\n  {\n    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",\n    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",\n    beforePin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n    currentPin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n  },\n  {\n    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",\n    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",\n    beforePin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n    currentPin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n  },\n  {\n    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",\n    parent: "e610189829ad1554b813d6ca224515666b0e2d28",\n    beforePin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n    currentPin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n  },\n  {\n    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",\n    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",\n    beforePin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n    currentPin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n  },\n] as const;\nconst prerequisitePolicyTopLevelKeys = [\n  "schema",\n  "description",\n  "sourceRoot",\n  "tsconfig",\n  "requireGitProvenance",\n  "externalAssets",\n  "frontendWrapper",\n  "moduleExtensions",\n  "layers",\n  "allowedEdges",\n  "externalPackages",\n  "activationHistory",\n  "nonModules",\n  "moves",\n  "evidence",\n  "files",\n] as const;\nconst prerequisitePolicySemanticRules = [\n  {\n    beforeFileCount: 1874,\n    currentFileCount: 1876,\n    additions: [\n      {\n        index: 122,\n        row: {\n          path: "src/checker/js-collection-inference.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "frontend-ts",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure.",\n        },\n        previousPath: "src/checker/inhouse-oracle.ts",\n        nextPath: "src/checker/language-service.ts",\n      },\n      {\n        index: 905,\n        row: {\n          path: "src/codegen/object-model/global-var-binding-exotic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",\n        nextPath: "src/codegen/object-model/proxy-trap-read.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1876,\n    currentFileCount: 1879,\n    additions: [\n      {\n        index: 576,\n        row: {\n          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/fnctor-ctor-param-types.ts",\n        nextPath: "src/codegen/fnctor-escape-gate.ts",\n      },\n      {\n        index: 976,\n        row: {\n          path: "src/codegen/expressions/spread-elem-extern.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/spread-arg-list.ts",\n        nextPath: "src/codegen/stack-balance.ts",\n      },\n      {\n        index: 978,\n        row: {\n          path: "src/codegen/expressions/standalone-any-length.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/stack-balance.ts",\n        nextPath: "src/codegen/standalone-class-instance-proto.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1879,\n    currentFileCount: 1881,\n    additions: [\n      {\n        index: 343,\n        row: {\n          path: "src/codegen/closures/closure-binding-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/capture-source-slot.ts",\n        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",\n      },\n      {\n        index: 1059,\n        row: {\n          path: "src/codegen/object-model/struct-field-name-tags.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/struct-hierarchy-layout.ts",\n        nextPath: "src/codegen/object-model/struct-optional-widen.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1881,\n    currentFileCount: 1882,\n    additions: [\n      {\n        index: 331,\n        row: {\n          path: "src/codegen/object-model/generator-function-proto-arm.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",\n        },\n        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",\n        nextPath: "src/codegen/closed-struct-extern-set.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1882,\n    currentFileCount: 1883,\n    additions: [\n      {\n        index: 1494,\n        row: {\n          path: "src/runtime/native-regime-view.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-function-source.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1883,\n    currentFileCount: 1884,\n    additions: [\n      {\n        index: 1113,\n        row: {\n          path: "src/codegen/array/vec-receiver-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/array/vec-elem-fidelity.ts",\n        nextPath: "src/codegen/vec-externref-hole-presence.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1884,\n    currentFileCount: 1885,\n    additions: [\n      {\n        index: 1335,\n        row: {\n          path: "src/ir/lowering/string-operations.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "compiler",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",\n        },\n        previousPath: "src/ir/lower-generic.ts",\n        nextPath: "src/ir/lower.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1885,\n    currentFileCount: 1886,\n    additions: [\n      {\n        index: 911,\n        row: {\n          path: "src/codegen/closures/function-intrinsic-construct.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/promoted-capture-value.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1886,\n    currentFileCount: 1887,\n    additions: [\n      {\n        index: 1498,\n        row: {\n          path: "src/runtime/process-capability.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-regime-view.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1887,\n    currentFileCount: 1889,\n    additions: [\n      {\n        index: 237,\n        row: {\n          path: "src/codegen/async-frame-binding-continuity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/async-await-hoist.ts",\n        nextPath: "src/codegen/async-cps-ast.ts",\n      },\n      {\n        index: 440,\n        row: {\n          path: "src/codegen/expressions/identifier-receiver-slot.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/dynamic-proto.ts",\n        nextPath: "src/codegen/dynamic-read-narrowing.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1889,\n    currentFileCount: 1892,\n    additions: [\n      {\n        index: 914,\n        row: {\n          path: "src/codegen/expressions/primitive-newtarget-default.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",\n        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n      },\n      {\n        index: 915,\n        row: {\n          path: "src/codegen/expressions/uncalled-shim-eval.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",\n        },\n        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",\n        nextPath: "src/codegen/object-model/construct-default-proto.ts",\n      },\n      {\n        index: 916,\n        row: {\n          path: "src/codegen/object-model/construct-default-proto.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1892,\n    currentFileCount: 1898,\n    additions: [\n      {\n        index: 1865,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/contracts.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/alloc-verification.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      },\n      {\n        index: 1866,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/census.ts",\n      },\n      {\n        index: 1867,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/census.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n      },\n      {\n        index: 1868,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/metadata.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/census.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",\n      },\n      {\n        index: 1869,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/verify.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n        nextPath: "src/ir/runtime/verify.ts",\n      },\n      {\n        index: 1872,\n        row: {\n          path: "src/ir/program/allocation-body-validation.ts",\n          state: "clean",\n          layer: "ir-program",\n        },\n        previousPath: "src/ir/program/allocations.ts",\n        nextPath: "src/ir/program/class-layouts.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 6,\n        id: "ir-analysis",\n        fields: ["roots", "entries", "minModules"],\n        beforeValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          minModules: 14,\n        },\n        currentValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/allocation-evidence",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n            "src/ir/analysis/allocation-evidence/contracts.ts",\n            "src/ir/analysis/allocation-evidence/effect-rules.ts",\n            "src/ir/analysis/allocation-evidence/census.ts",\n            "src/ir/analysis/allocation-evidence/metadata.ts",\n            "src/ir/analysis/allocation-evidence/verify.ts",\n          ],\n          minModules: 19,\n        },\n      },\n      {\n        index: 9,\n        id: "ir-program",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n          ],\n          minModules: 48,\n        },\n        currentValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n            "src/ir/program/allocation-body-validation.ts",\n          ],\n          minModules: 49,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1898,\n    currentFileCount: 1899,\n    additions: [\n      {\n        index: 1532,\n        row: {\n          path: "src/shared/contracts/linear-memory-layout.ts",\n          state: "clean",\n          layer: "foundation",\n        },\n        previousPath: "src/shared/contracts/identity-values.ts",\n        nextPath: "src/shared/contracts/ir-identity.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 0,\n        id: "foundation",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n          ],\n          minModules: 9,\n        },\n        currentValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n            "src/shared/contracts/linear-memory-layout.ts",\n          ],\n          minModules: 10,\n        },\n      },\n    ],\n  },\n] as const;\n\ntype PrerequisiteSectionName = "cabiSource" | "policySource";\nfunction validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {\n  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);\n  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;\n  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";\n  if (\n    source.path !== path ||\n    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||\n    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)\n  )\n    fail(name + " fixed source domain");\n  const epochs = array(source.epochs, name + " epochs");\n  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");\n  for (const [index, value] of epochs.entries()) {\n    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");\n    const contract = contracts[index]!;\n    if (\n      epoch.commit !== contract.commit ||\n      epoch.parent !== contract.parent ||\n      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||\n      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||\n      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))\n    )\n      fail(name + " fixed epoch identity/pins");\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(epoch[direction], name + " " + direction);\n      if (!spans.length) fail(name + " missing " + direction);\n      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");\n    }\n  }\n  return source;\n}\nfunction prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {\n  const before = keys(\n    parseJson(beforeRaw, stage + " before"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " before policy",\n  );\n  const current = keys(\n    parseJson(currentRaw, stage + " current"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " current policy",\n  );\n  const rule = prerequisitePolicySemanticRules[index]!;\n  const beforeFiles = array(before.files, stage + " before files"),\n    currentFiles = array(current.files, stage + " current files");\n  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)\n    fail(stage + " semantic file counts");\n  const removed = new Set<number>();\n  for (const addition of rule.additions) {\n    const at: number = addition.index;\n    const row = currentFiles[at];\n    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;\n    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;\n    if (\n      removed.has(addition.index) ||\n      !same(row, addition.row) ||\n      previous !== addition.previousPath ||\n      next !== addition.nextPath\n    )\n      fail(stage + " semantic ordered row/neighbors");\n    removed.add(addition.index);\n  }\n  if (\n    !same(\n      currentFiles.filter((_, at) => !removed.has(at)),\n      beforeFiles,\n    )\n  )\n    fail(stage + " semantic retained file rows");\n  const beforeLayers = array(before.layers, stage + " before layers"),\n    currentLayers = array(current.layers, stage + " current layers");\n  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");\n  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];\n  for (const change of rule.layers) {\n    const old = beforeLayers[change.index] as Data,\n      actual = currentLayers[change.index] as Data;\n    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))\n      fail(stage + " semantic layer identity/keys");\n    for (const field of change.fields) {\n      if (\n        !same(old[field], (change.beforeValues as Data)[field]) ||\n        !same(actual[field], (change.currentValues as Data)[field])\n      )\n        fail(stage + " semantic changed layer field: " + change.id + "/" + field);\n      replayLayers[change.index]![field] = actual[field];\n    }\n  }\n  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");\n  const replay = { ...before, files: currentFiles, layers: replayLayers };\n  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");\n}\nfunction prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {\n  const receipt = captureGeometrySuccessor(reader);\n  const source = validatePrerequisiteSection(receipt[name], name);\n  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");\n  const physical = readText(reader, source.path as string);\n  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");\n  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");\n  const epochs = array(source.epochs, name + " epochs") as Data[];\n  let before = rawCurrent;\n  const authenticatedCurrents: string[] = [];\n  for (let index = epochs.length - 1; index >= 0; index--) {\n    const epoch = epochs[index]!;\n    const stage = name + " inverse epoch " + (index + 1);\n    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");\n    authenticatedCurrents[index] = before;\n    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);\n    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);\n    before = predecessor;\n  }\n  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");\n  let replay = before;\n  for (const [index, epoch] of epochs.entries()) {\n    const stage = name + " forward epoch " + (index + 1);\n    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");\n    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);\n    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");\n    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);\n    replay = current;\n  }\n  if (replay !== rawCurrent) fail(name + " independent complete source equality");\n  return before;\n}\n/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */\nexport function captureC1LinearCabiPredecessor(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");\n  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");\n}\n/** Thirteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\nexport function captureGeometryCurrentMainPredecessorPolicySource(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");\n  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");\n}\n',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 238,
      outputOffset: 238,
      from: "",
      to: 'import * as c1AuthorityRoot from "./ir-c1-authority-root.js";\n',
    },
    {
      inputOffset: 34212,
      outputOffset: 34274,
      from: '  if (anchor !== canonicalAnchor) fail("warm anchor source changed");\n',
      to: '  const geometryDigest = geometryAnchorDigest(false);\n  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))\n    fail("warm anchor source changed");\n',
    },
    {
      inputOffset: 36329,
      outputOffset: 36516,
      from: "  const contract = validateLinearOptions(manifest.linearOptions);\n",
      to: "  let contract = validateLinearOptions(manifest.linearOptions);\n",
    },
    {
      inputOffset: 36643,
      outputOffset: 36828,
      from: "  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);\n",
      to: '  const instrumentTexts = new Map<string, string>();\n  let successor: Data | undefined;\n  for (const record of instruments) {\n    const text = readText(readAuthority, record.path);\n    instrumentTexts.set(record.path, text);\n    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);\n    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {\n      successor ??= captureGeometrySuccessor(readAuthority);\n      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);\n    } else requirePin(text, record.pin, record.path);\n  }\n  if (successor) {\n    // Never combine an old supplied instrument with another instrument\'s successor epoch.\n    for (const value of array(successor.instruments, "geometry instruments")) {\n      const record = value as Data;\n      requirePin(\n        instrumentTexts.get(record.path as string)!,\n        validatePin(record.currentPin, "geometry current pin"),\n        "complete geometry instrument epoch",\n      );\n    }\n    contract = geometryLinearOptions(contract, successor.linearOptions);\n  }\n',
    },
    {
      inputOffset: 40026,
      outputOffset: 41211,
      from: "function validateResolverTopology(resolver: Data): void {\n",
      to: "function validateResolverTopology(resolver: Data, currentGeometry = false): void {\n  const expectedRequests = currentGeometry\n    ? [...fixedResolverRequests, ...geometryResolverRequests]\n    : fixedResolverRequests;\n",
    },
    {
      inputOffset: 40385,
      outputOffset: 41729,
      from: '  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");\n',
      to: '  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");\n',
    },
    {
      inputOffset: 41078,
      outputOffset: 42417,
      from: "  for (const request of fixedResolverRequests) {\n",
      to: "  for (const request of expectedRequests) {\n",
    },
    {
      inputOffset: 44161,
      outputOffset: 45495,
      from: "",
      to: '\n// One finite geometry successor. ROOT owns the receipt and independent anchor activation.\nconst geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";\nconst geometryCallerContracts = [\n  {\n    path: "tests/issue-3518-program-data-contract-boundary.test.ts",\n    beforePin: {\n      bytes: 33595,\n      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",\n      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",\n    },\n    currentPin: {\n      bytes: 33840,\n      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",\n      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",\n    },\n  },\n  {\n    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 28811,\n      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",\n      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",\n    },\n    currentPin: {\n      bytes: 29161,\n      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",\n      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",\n    },\n  },\n  {\n    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 29570,\n      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",\n      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",\n    },\n    currentPin: {\n      bytes: 29764,\n      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",\n      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",\n    },\n  },\n  {\n    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 112437,\n      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",\n      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",\n    },\n    currentPin: {\n      bytes: 113131,\n      sha256: "81cdd13ea7f9f907c7d9f268cd0ad6dffda4b996671f5ed49721d7e162ae57ae",\n      gitBlob: "4be3d8d341b1e42ce0f7ea3dc9799fb0cfe32e84",\n    },\n  },\n] as const;\nconst geometryInstrumentPins: readonly C1PathPin[] = [\n  {\n    path: "tests/helpers/ir-c1-historical-authority.ts",\n    pin: {\n      bytes: 44161,\n      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",\n      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",\n    },\n  },\n  {\n    path: "tests/helpers/ir-c1-current-source.ts",\n    pin: {\n      bytes: 42599,\n      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",\n      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",\n    },\n  },\n  {\n    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    pin: {\n      bytes: 409599,\n      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",\n      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",\n    },\n  },\n  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),\n];\nconst geometryClosurePins: readonly C1PathPin[] = [\n  {\n    path: "src/ir/analysis/linear-memory-plan.ts",\n    pin: {\n      bytes: 45359,\n      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",\n      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",\n    },\n  },\n  {\n    path: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 3161,\n      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",\n      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",\n    },\n  },\n  {\n    path: "src/shared/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 7580,\n      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",\n      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",\n    },\n  },\n];\nconst geometryResolverRequests: readonly C1ResolverRequest[] = [\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "./contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    module: "../../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n];\nfunction geometryAnchorDigest(required: boolean): string | undefined {\n  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");\n  if (descriptor === undefined) {\n    if (required) fail("geometry instrument authority not activated");\n    return undefined;\n  }\n  if (\n    !Object.hasOwn(descriptor, "value") ||\n    typeof descriptor.value !== "string" ||\n    !/^[a-f0-9]{64}$/.test(descriptor.value)\n  )\n    fail("geometry instrument anchor data digest required");\n  return descriptor.value;\n}\nfunction geometryAnchorLine(digest: string | undefined): string {\n  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\\n`;\n}\nfunction captureGeometrySuccessor(readAuthority: AuthorityReader): Data {\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const digest = geometryAnchorDigest(true);\n  const anchor = readText(readAuthority, anchorPath);\n  const canonical =\n    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\n" +\n    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\\n` +\n    geometryAnchorLine(digest);\n  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");\n  const raw = readText(readAuthority, geometrySuccessorPath);\n  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");\n  const receipt = keys(\n    parseJson(raw, geometrySuccessorPath),\n    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],\n    "geometry instrument receipt",\n  );\n  if (\n    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||\n    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256\n  )\n    fail("geometry instrument receipt domain");\n  const instruments = array(receipt.instruments, "geometry instruments");\n  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");\n  instruments.forEach((value, index) => {\n    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");\n    if (\n      record.path !== geometryInstrumentPins[index]!.path ||\n      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)\n    )\n      fail("geometry instrument predecessor domain");\n    const currentPin = validatePin(record.currentPin, "geometry current pin");\n    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);\n    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(record[direction], "geometry " + direction);\n      if (!spans.length) fail("geometry instrument missing " + direction);\n      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));\n    }\n  });\n  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");\n  validatePrerequisiteSection(receipt.policySource, "policySource");\n  return receipt;\n}\nfunction geometryInstrumentReplay(\n  source: string,\n  spans: unknown,\n  target: C1Pin,\n  stage = "geometry instrument",\n): string {\n  const bytes = Buffer.from(source, "utf8");\n  const pieces: Buffer[] = [];\n  let inputEnd = 0,\n    outputEnd = 0,\n    previousInput = -1,\n    previousOutput = -1;\n  for (const value of array(spans, "geometry replay spans")) {\n    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");\n    if (\n      !Number.isSafeInteger(span.inputOffset) ||\n      !Number.isSafeInteger(span.outputOffset) ||\n      typeof span.from !== "string" ||\n      typeof span.to !== "string"\n    )\n      fail(stage + " span data");\n    const inputOffset = span.inputOffset as number,\n      outputOffset = span.outputOffset as number;\n    const from = Buffer.from(span.from),\n      to = Buffer.from(span.to);\n    if (\n      inputOffset < inputEnd ||\n      outputOffset < outputEnd ||\n      inputOffset <= previousInput ||\n      outputOffset <= previousOutput ||\n      inputOffset - inputEnd !== outputOffset - outputEnd ||\n      inputOffset + from.length > bytes.length ||\n      outputOffset + to.length > target.bytes ||\n      from.toString("utf8") !== span.from ||\n      to.toString("utf8") !== span.to ||\n      span.from === span.to ||\n      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)\n    )\n      fail(stage + " span membership/coordinates");\n    pieces.push(bytes.subarray(inputEnd, inputOffset), to);\n    previousInput = inputOffset;\n    previousOutput = outputOffset;\n    inputEnd = inputOffset + from.length;\n    outputEnd = outputOffset + to.length;\n  }\n  pieces.push(bytes.subarray(inputEnd));\n  const output = Buffer.concat(pieces).toString("utf8");\n  requirePin(output, target, stage + " replay");\n  return output;\n}\nfunction geometryInstrumentBefore(path: string, source: string, receipt: Data): string {\n  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as\n    | Data\n    | undefined;\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");\n  const before = geometryInstrumentReplay(\n    source,\n    record.inverse,\n    validatePin(record.beforePin, path),\n    "geometry instrument inverse: " + path,\n  );\n  const replay = geometryInstrumentReplay(\n    before,\n    record.forward,\n    validatePin(record.currentPin, path),\n    "geometry instrument forward: " + path,\n  );\n  if (replay !== source) fail("geometry independent instrument forward equality: " + path);\n  return before;\n}\n/** Exactly seven published instruments; primitive/path/reader checks precede IO. */\nexport function c1GeometryInstrumentPredecessor(\n  path: string,\n  source: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof path !== "string" || typeof source !== "string")\n    fail("geometry instrument primitive path/source required");\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const record = geometryInstrumentPins.find((entry) => entry.path === path);\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  // Exact original supplied inputs retain their pre-existing authority path.\n  if (same(measured(source), record.pin)) return source;\n  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));\n}\nfunction geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {\n  const contract = keys(\n    value,\n    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],\n    "geometry linear options",\n  );\n  const expectedClosure = [\n    ...before.closureInputs.map((entry) =>\n      entry.path === geometryClosurePins[0]!.path\n        ? geometryClosurePins[0]!\n        : entry.path === "src/codegen-linear/c-abi.ts"\n          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }\n          : entry,\n    ),\n    ...geometryClosurePins.slice(1),\n  ];\n  if (\n    contract.sourcePath !== before.sourcePath ||\n    !same(contract.declaration, before.declaration) ||\n    !same(contract.bindings, before.bindings) ||\n    !same(contract.closureInputs, expectedClosure)\n  )\n    fail("geometry-only closure successor");\n  const resolver = keys(\n    contract.resolver,\n    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],\n    "geometry resolver",\n  );\n  if (\n    !same(resolver.configInputs, before.resolver.configInputs) ||\n    resolver.optionsSource !== before.resolver.optionsSource ||\n    resolver.optionsSha256 !== before.resolver.optionsSha256\n  )\n    fail("geometry resolver configuration changed");\n  validateResolverTopology(resolver, true);\n  const observations = array(resolver.observations, "geometry observations");\n  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))\n    fail("unrelated geometry resolver transcript drift");\n  return contract as unknown as C1LinearOptionsContract;\n}\n\n// Fixed Git identities and full pins independently checked against the adopted Astra amendment.\nconst cabiSourceEpochContracts = [\n  {\n    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",\n    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",\n    beforePin: {\n      bytes: 26965,\n      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",\n      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",\n    },\n    currentPin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n  },\n  {\n    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",\n    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",\n    beforePin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n    currentPin: {\n      bytes: 27454,\n      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",\n      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",\n    },\n  },\n] as const;\nconst policySourceEpochContracts = [\n  {\n    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",\n    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",\n    beforePin: {\n      bytes: 599721,\n      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",\n      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",\n    },\n    currentPin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n  },\n  {\n    commit: "1156d385765f06d675bc6f6c25caa138501fef58",\n    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",\n    beforePin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n    currentPin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n  },\n  {\n    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",\n    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",\n    beforePin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n    currentPin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n  },\n  {\n    commit: "534620a636c63c257bc5afb8d543d0306b26928c",\n    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",\n    beforePin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n    currentPin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n  },\n  {\n    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",\n    parent: "26091eabd4561e5be154741e7e18143070d3ce59",\n    beforePin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n    currentPin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n  },\n  {\n    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",\n    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",\n    beforePin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n    currentPin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n  },\n  {\n    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",\n    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",\n    beforePin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n    currentPin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n  },\n  {\n    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",\n    beforePin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n    currentPin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n  },\n  {\n    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",\n    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    beforePin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n    currentPin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n  },\n  {\n    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",\n    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",\n    beforePin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n    currentPin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n  },\n  {\n    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",\n    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",\n    beforePin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n    currentPin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n  },\n  {\n    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",\n    parent: "e610189829ad1554b813d6ca224515666b0e2d28",\n    beforePin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n    currentPin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n  },\n  {\n    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",\n    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",\n    beforePin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n    currentPin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n  },\n] as const;\nconst prerequisitePolicyTopLevelKeys = [\n  "schema",\n  "description",\n  "sourceRoot",\n  "tsconfig",\n  "requireGitProvenance",\n  "externalAssets",\n  "frontendWrapper",\n  "moduleExtensions",\n  "layers",\n  "allowedEdges",\n  "externalPackages",\n  "activationHistory",\n  "nonModules",\n  "moves",\n  "evidence",\n  "files",\n] as const;\nconst prerequisitePolicySemanticRules = [\n  {\n    beforeFileCount: 1874,\n    currentFileCount: 1876,\n    additions: [\n      {\n        index: 122,\n        row: {\n          path: "src/checker/js-collection-inference.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "frontend-ts",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure.",\n        },\n        previousPath: "src/checker/inhouse-oracle.ts",\n        nextPath: "src/checker/language-service.ts",\n      },\n      {\n        index: 905,\n        row: {\n          path: "src/codegen/object-model/global-var-binding-exotic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",\n        nextPath: "src/codegen/object-model/proxy-trap-read.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1876,\n    currentFileCount: 1879,\n    additions: [\n      {\n        index: 576,\n        row: {\n          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/fnctor-ctor-param-types.ts",\n        nextPath: "src/codegen/fnctor-escape-gate.ts",\n      },\n      {\n        index: 976,\n        row: {\n          path: "src/codegen/expressions/spread-elem-extern.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/spread-arg-list.ts",\n        nextPath: "src/codegen/stack-balance.ts",\n      },\n      {\n        index: 978,\n        row: {\n          path: "src/codegen/expressions/standalone-any-length.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/stack-balance.ts",\n        nextPath: "src/codegen/standalone-class-instance-proto.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1879,\n    currentFileCount: 1881,\n    additions: [\n      {\n        index: 343,\n        row: {\n          path: "src/codegen/closures/closure-binding-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/capture-source-slot.ts",\n        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",\n      },\n      {\n        index: 1059,\n        row: {\n          path: "src/codegen/object-model/struct-field-name-tags.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/struct-hierarchy-layout.ts",\n        nextPath: "src/codegen/object-model/struct-optional-widen.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1881,\n    currentFileCount: 1882,\n    additions: [\n      {\n        index: 331,\n        row: {\n          path: "src/codegen/object-model/generator-function-proto-arm.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",\n        },\n        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",\n        nextPath: "src/codegen/closed-struct-extern-set.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1882,\n    currentFileCount: 1883,\n    additions: [\n      {\n        index: 1494,\n        row: {\n          path: "src/runtime/native-regime-view.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-function-source.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1883,\n    currentFileCount: 1884,\n    additions: [\n      {\n        index: 1113,\n        row: {\n          path: "src/codegen/array/vec-receiver-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/array/vec-elem-fidelity.ts",\n        nextPath: "src/codegen/vec-externref-hole-presence.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1884,\n    currentFileCount: 1885,\n    additions: [\n      {\n        index: 1335,\n        row: {\n          path: "src/ir/lowering/string-operations.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "compiler",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",\n        },\n        previousPath: "src/ir/lower-generic.ts",\n        nextPath: "src/ir/lower.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1885,\n    currentFileCount: 1886,\n    additions: [\n      {\n        index: 911,\n        row: {\n          path: "src/codegen/closures/function-intrinsic-construct.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/promoted-capture-value.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1886,\n    currentFileCount: 1887,\n    additions: [\n      {\n        index: 1498,\n        row: {\n          path: "src/runtime/process-capability.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-regime-view.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1887,\n    currentFileCount: 1889,\n    additions: [\n      {\n        index: 237,\n        row: {\n          path: "src/codegen/async-frame-binding-continuity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/async-await-hoist.ts",\n        nextPath: "src/codegen/async-cps-ast.ts",\n      },\n      {\n        index: 440,\n        row: {\n          path: "src/codegen/expressions/identifier-receiver-slot.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/dynamic-proto.ts",\n        nextPath: "src/codegen/dynamic-read-narrowing.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1889,\n    currentFileCount: 1892,\n    additions: [\n      {\n        index: 914,\n        row: {\n          path: "src/codegen/expressions/primitive-newtarget-default.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",\n        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n      },\n      {\n        index: 915,\n        row: {\n          path: "src/codegen/expressions/uncalled-shim-eval.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",\n        },\n        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",\n        nextPath: "src/codegen/object-model/construct-default-proto.ts",\n      },\n      {\n        index: 916,\n        row: {\n          path: "src/codegen/object-model/construct-default-proto.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1892,\n    currentFileCount: 1898,\n    additions: [\n      {\n        index: 1865,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/contracts.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/alloc-verification.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      },\n      {\n        index: 1866,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/census.ts",\n      },\n      {\n        index: 1867,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/census.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n      },\n      {\n        index: 1868,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/metadata.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/census.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",\n      },\n      {\n        index: 1869,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/verify.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n        nextPath: "src/ir/runtime/verify.ts",\n      },\n      {\n        index: 1872,\n        row: {\n          path: "src/ir/program/allocation-body-validation.ts",\n          state: "clean",\n          layer: "ir-program",\n        },\n        previousPath: "src/ir/program/allocations.ts",\n        nextPath: "src/ir/program/class-layouts.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 6,\n        id: "ir-analysis",\n        fields: ["roots", "entries", "minModules"],\n        beforeValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          minModules: 14,\n        },\n        currentValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/allocation-evidence",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n            "src/ir/analysis/allocation-evidence/contracts.ts",\n            "src/ir/analysis/allocation-evidence/effect-rules.ts",\n            "src/ir/analysis/allocation-evidence/census.ts",\n            "src/ir/analysis/allocation-evidence/metadata.ts",\n            "src/ir/analysis/allocation-evidence/verify.ts",\n          ],\n          minModules: 19,\n        },\n      },\n      {\n        index: 9,\n        id: "ir-program",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n          ],\n          minModules: 48,\n        },\n        currentValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n            "src/ir/program/allocation-body-validation.ts",\n          ],\n          minModules: 49,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1898,\n    currentFileCount: 1899,\n    additions: [\n      {\n        index: 1532,\n        row: {\n          path: "src/shared/contracts/linear-memory-layout.ts",\n          state: "clean",\n          layer: "foundation",\n        },\n        previousPath: "src/shared/contracts/identity-values.ts",\n        nextPath: "src/shared/contracts/ir-identity.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 0,\n        id: "foundation",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n          ],\n          minModules: 9,\n        },\n        currentValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n            "src/shared/contracts/linear-memory-layout.ts",\n          ],\n          minModules: 10,\n        },\n      },\n    ],\n  },\n] as const;\n\ntype PrerequisiteSectionName = "cabiSource" | "policySource";\nfunction validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {\n  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);\n  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;\n  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";\n  if (\n    source.path !== path ||\n    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||\n    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)\n  )\n    fail(name + " fixed source domain");\n  const epochs = array(source.epochs, name + " epochs");\n  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");\n  for (const [index, value] of epochs.entries()) {\n    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");\n    const contract = contracts[index]!;\n    if (\n      epoch.commit !== contract.commit ||\n      epoch.parent !== contract.parent ||\n      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||\n      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||\n      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))\n    )\n      fail(name + " fixed epoch identity/pins");\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(epoch[direction], name + " " + direction);\n      if (!spans.length) fail(name + " missing " + direction);\n      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");\n    }\n  }\n  return source;\n}\nfunction prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {\n  const before = keys(\n    parseJson(beforeRaw, stage + " before"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " before policy",\n  );\n  const current = keys(\n    parseJson(currentRaw, stage + " current"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " current policy",\n  );\n  const rule = prerequisitePolicySemanticRules[index]!;\n  const beforeFiles = array(before.files, stage + " before files"),\n    currentFiles = array(current.files, stage + " current files");\n  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)\n    fail(stage + " semantic file counts");\n  const removed = new Set<number>();\n  for (const addition of rule.additions) {\n    const at: number = addition.index;\n    const row = currentFiles[at];\n    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;\n    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;\n    if (\n      removed.has(addition.index) ||\n      !same(row, addition.row) ||\n      previous !== addition.previousPath ||\n      next !== addition.nextPath\n    )\n      fail(stage + " semantic ordered row/neighbors");\n    removed.add(addition.index);\n  }\n  if (\n    !same(\n      currentFiles.filter((_, at) => !removed.has(at)),\n      beforeFiles,\n    )\n  )\n    fail(stage + " semantic retained file rows");\n  const beforeLayers = array(before.layers, stage + " before layers"),\n    currentLayers = array(current.layers, stage + " current layers");\n  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");\n  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];\n  for (const change of rule.layers) {\n    const old = beforeLayers[change.index] as Data,\n      actual = currentLayers[change.index] as Data;\n    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))\n      fail(stage + " semantic layer identity/keys");\n    for (const field of change.fields) {\n      if (\n        !same(old[field], (change.beforeValues as Data)[field]) ||\n        !same(actual[field], (change.currentValues as Data)[field])\n      )\n        fail(stage + " semantic changed layer field: " + change.id + "/" + field);\n      replayLayers[change.index]![field] = actual[field];\n    }\n  }\n  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");\n  const replay = { ...before, files: currentFiles, layers: replayLayers };\n  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");\n}\nfunction prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {\n  const receipt = captureGeometrySuccessor(reader);\n  const source = validatePrerequisiteSection(receipt[name], name);\n  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");\n  const physical = readText(reader, source.path as string);\n  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");\n  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");\n  const epochs = array(source.epochs, name + " epochs") as Data[];\n  let before = rawCurrent;\n  const authenticatedCurrents: string[] = [];\n  for (let index = epochs.length - 1; index >= 0; index--) {\n    const epoch = epochs[index]!;\n    const stage = name + " inverse epoch " + (index + 1);\n    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");\n    authenticatedCurrents[index] = before;\n    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);\n    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);\n    before = predecessor;\n  }\n  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");\n  let replay = before;\n  for (const [index, epoch] of epochs.entries()) {\n    const stage = name + " forward epoch " + (index + 1);\n    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");\n    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);\n    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");\n    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);\n    replay = current;\n  }\n  if (replay !== rawCurrent) fail(name + " independent complete source equality");\n  return before;\n}\n/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */\nexport function captureC1LinearCabiPredecessor(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");\n  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");\n}\n/** Thirteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\nexport function captureGeometryCurrentMainPredecessorPolicySource(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");\n  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");\n}\n',
    },
  ],
} as const);
const numberCallerComposed = freezeCompositionLiteral({
  path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
  beforePin: {
    bytes: 112437,
    sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",
    gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",
  },
  currentPin: {
    bytes: 116007,
    sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",
    gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",
  },
  inverse: [
    {
      inputOffset: 2335,
      outputOffset: 2335,
      from: "  beforeRuntimePreparationPolicySource,\n  runtimePreparationRemainderHistoricalSource,\n",
      to: "  beforeRuntimePreparationPolicySource,\n",
    },
    {
      inputOffset: 4201,
      outputOffset: 4154,
      from: 'import {\n  captureGeometryCurrentMainPredecessorPolicySource,\n  c1HistoricalArtifactPath,\n  type C1HistoricalLogicalPath,\n} from "./helpers/ir-c1-historical-authority.js";\n',
      to: 'import { c1HistoricalArtifactPath, type C1HistoricalLogicalPath } from "./helpers/ir-c1-historical-authority.js";\n',
    },
    {
      inputOffset: 6848,
      outputOffset: 6743,
      from: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
      to: '                                      read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 42006,
      outputOffset: 41769,
      from: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n  const readPinnedPreparationOperand = (operandPath: string): string => {\n    const source = readHistoricalPolicyOperand(operandPath);\n    return operandPath === "src/ir/runtime/intrinsic-preparation.ts"\n      ? runtimePreparationRemainderHistoricalSource(source)\n      : source;\n  };\n',
      to: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n',
    },
    {
      inputOffset: 43556,
      outputOffset: 43034,
      from: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
      to: '                                      read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 47703,
      outputOffset: 47049,
      from: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      const source = readPinnedPreparationOperand(pin.path);\n      expect([Buffer.byteLength(source), sha(source)]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
      to: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      expect([Buffer.byteLength(read(pin.path)), sha(read(pin.path))]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
    },
    {
      inputOffset: 48220,
      outputOffset: 47521,
      from: '  it("successor reader freshly proves current preparation bytes and preserves every other raw operand channel", () => {\n    const actual = readHistoricalPolicyOperand(path);\n    const historical = readPinnedPreparationOperand(path);\n    expect([Buffer.byteLength(actual), sha(actual)]).toEqual([\n      49704,\n      "171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82",\n    ]);\n    expect([Buffer.byteLength(historical), sha(historical)]).toEqual([\n      49541,\n      "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n    ]);\n    expect(historical).not.toBe(actual);\n    for (const pin of [...authority().sourceInputs, authority().numberReceipt]) {\n      if (pin.path !== path) expect(readPinnedPreparationOperand(pin.path)).toBe(readHistoricalPolicyOperand(pin.path));\n    }\n    const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";\n    const helper = readHistoricalPolicyOperand(helperPath);\n    expect(readPinnedPreparationOperand(helperPath)).toBe(helper);\n    expect(Buffer.byteLength(helper)).toBe(93405);\n    expect(createHash("sha256").update(Buffer.from(helper).subarray(0, 40368)).digest("hex")).toBe(\n      "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",\n    );\n    accept(current());\n  });\n\n  it.each([0, 1142, 39547, 49703] as const)(\n    "successor reader freshly refuses actual preparation byte %s after success and restores",\n    (offset) => {\n      const original = readHistoricalPolicyOperand(path);\n      const healthy = readPinnedPreparationOperand(path);\n      const exact = new URL(`../${path}`, import.meta.url).pathname;\n      expect([Buffer.byteLength(healthy), sha(healthy)]).toEqual([\n        49541,\n        "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n      ]);\n      accept(current());\n      try {\n        intercepted.set(exact, offset);\n        interceptedReads.set(exact, 0);\n        expect(readHistoricalPolicyOperand(path)).not.toBe(original);\n        expect(() => readPinnedPreparationOperand(path)).toThrow(\n          new Error("current main inventory evolution: complete current remainder preparation source changed"),\n        );\n        expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(2);\n      } finally {\n        intercepted.delete(exact);\n        interceptedReads.delete(exact);\n      }\n      expect(readHistoricalPolicyOperand(path)).toBe(original);\n      expect(readPinnedPreparationOperand(path)).toBe(healthy);\n      accept(current());\n    },\n  );\n\n  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
      to: '  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
    },
    {
      inputOffset: 64283,
      outputOffset: 61085,
      from: '                                    captureGeometryCurrentMainPredecessorPolicySource(\n                                      read("scripts/compiler-boundaries.json"),\n                                    ),\n',
      to: '                                    read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 85624,
      outputOffset: 82298,
      from: '                                  captureGeometryCurrentMainPredecessorPolicySource(\n                                    read("scripts/compiler-boundaries.json"),\n                                  ),\n',
      to: '                                  read("scripts/compiler-boundaries.json"),\n',
    },
    {
      inputOffset: 100906,
      outputOffset: 97456,
      from: '                                captureGeometryCurrentMainPredecessorPolicySource(\n                                  read("scripts/compiler-boundaries.json"),\n                                ),\n',
      to: '                                read("scripts/compiler-boundaries.json"),\n',
    },
  ],
  forward: [
    {
      inputOffset: 2335,
      outputOffset: 2335,
      from: "  beforeRuntimePreparationPolicySource,\n",
      to: "  beforeRuntimePreparationPolicySource,\n  runtimePreparationRemainderHistoricalSource,\n",
    },
    {
      inputOffset: 4154,
      outputOffset: 4201,
      from: 'import { c1HistoricalArtifactPath, type C1HistoricalLogicalPath } from "./helpers/ir-c1-historical-authority.js";\n',
      to: 'import {\n  captureGeometryCurrentMainPredecessorPolicySource,\n  c1HistoricalArtifactPath,\n  type C1HistoricalLogicalPath,\n} from "./helpers/ir-c1-historical-authority.js";\n',
    },
    {
      inputOffset: 6743,
      outputOffset: 6848,
      from: '                                      read("scripts/compiler-boundaries.json"),\n',
      to: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
    },
    {
      inputOffset: 41769,
      outputOffset: 42006,
      from: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n',
      to: '  const path = "src/ir/runtime/intrinsic-preparation.ts";\n  const readPinnedPreparationOperand = (operandPath: string): string => {\n    const source = readHistoricalPolicyOperand(operandPath);\n    return operandPath === "src/ir/runtime/intrinsic-preparation.ts"\n      ? runtimePreparationRemainderHistoricalSource(source)\n      : source;\n  };\n',
    },
    {
      inputOffset: 43034,
      outputOffset: 43556,
      from: '                                      read("scripts/compiler-boundaries.json"),\n',
      to: '                                      captureGeometryCurrentMainPredecessorPolicySource(\n                                        read("scripts/compiler-boundaries.json"),\n                                      ),\n',
    },
    {
      inputOffset: 47049,
      outputOffset: 47703,
      from: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      expect([Buffer.byteLength(read(pin.path)), sha(read(pin.path))]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
      to: "    for (const pin of [...r.sourceInputs, r.numberReceipt]) {\n      const source = readPinnedPreparationOperand(pin.path);\n      expect([Buffer.byteLength(source), sha(source)]).toEqual([pin.bytes, pin.sha256]);\n    }\n",
    },
    {
      inputOffset: 47521,
      outputOffset: 48220,
      from: '  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
      to: '  it("successor reader freshly proves current preparation bytes and preserves every other raw operand channel", () => {\n    const actual = readHistoricalPolicyOperand(path);\n    const historical = readPinnedPreparationOperand(path);\n    expect([Buffer.byteLength(actual), sha(actual)]).toEqual([\n      49704,\n      "171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82",\n    ]);\n    expect([Buffer.byteLength(historical), sha(historical)]).toEqual([\n      49541,\n      "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n    ]);\n    expect(historical).not.toBe(actual);\n    for (const pin of [...authority().sourceInputs, authority().numberReceipt]) {\n      if (pin.path !== path) expect(readPinnedPreparationOperand(pin.path)).toBe(readHistoricalPolicyOperand(pin.path));\n    }\n    const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";\n    const helper = readHistoricalPolicyOperand(helperPath);\n    expect(readPinnedPreparationOperand(helperPath)).toBe(helper);\n    expect(Buffer.byteLength(helper)).toBe(93405);\n    expect(createHash("sha256").update(Buffer.from(helper).subarray(0, 40368)).digest("hex")).toBe(\n      "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",\n    );\n    accept(current());\n  });\n\n  it.each([0, 1142, 39547, 49703] as const)(\n    "successor reader freshly refuses actual preparation byte %s after success and restores",\n    (offset) => {\n      const original = readHistoricalPolicyOperand(path);\n      const healthy = readPinnedPreparationOperand(path);\n      const exact = new URL(`../${path}`, import.meta.url).pathname;\n      expect([Buffer.byteLength(healthy), sha(healthy)]).toEqual([\n        49541,\n        "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",\n      ]);\n      accept(current());\n      try {\n        intercepted.set(exact, offset);\n        interceptedReads.set(exact, 0);\n        expect(readHistoricalPolicyOperand(path)).not.toBe(original);\n        expect(() => readPinnedPreparationOperand(path)).toThrow(\n          new Error("current main inventory evolution: complete current remainder preparation source changed"),\n        );\n        expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(2);\n      } finally {\n        intercepted.delete(exact);\n        interceptedReads.delete(exact);\n      }\n      expect(readHistoricalPolicyOperand(path)).toBe(original);\n      expect(readPinnedPreparationOperand(path)).toBe(healthy);\n      accept(current());\n    },\n  );\n\n  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {\n',
    },
    {
      inputOffset: 61085,
      outputOffset: 64283,
      from: '                                    read("scripts/compiler-boundaries.json"),\n',
      to: '                                    captureGeometryCurrentMainPredecessorPolicySource(\n                                      read("scripts/compiler-boundaries.json"),\n                                    ),\n',
    },
    {
      inputOffset: 82298,
      outputOffset: 85624,
      from: '                                  read("scripts/compiler-boundaries.json"),\n',
      to: '                                  captureGeometryCurrentMainPredecessorPolicySource(\n                                    read("scripts/compiler-boundaries.json"),\n                                  ),\n',
    },
    {
      inputOffset: 97456,
      outputOffset: 100906,
      from: '                                read("scripts/compiler-boundaries.json"),\n',
      to: '                                captureGeometryCurrentMainPredecessorPolicySource(\n                                  read("scripts/compiler-boundaries.json"),\n                                ),\n',
    },
  ],
} as const);
const h1CallerComposed = freezeCompositionLiteral({
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 44161,
    sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",
    gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",
  },
  currentPin: {
    bytes: 96713,
    sha256: "7bbfaf6687f7411147f00833380027d3959b743ec7dc033fc9bba8d69849992b",
    gitBlob: "c59701cc36595cea2536c35edcc1e42278ba3e5c",
  },
  inverse: [
    {
      inputOffset: 238,
      outputOffset: 238,
      from: 'import * as c1AuthorityRoot from "./ir-c1-authority-root.js";\n',
      to: "",
    },
    {
      inputOffset: 34274,
      outputOffset: 34212,
      from: '  const geometryDigest = geometryAnchorDigest(false);\n  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))\n    fail("warm anchor source changed");\n',
      to: '  if (anchor !== canonicalAnchor) fail("warm anchor source changed");\n',
    },
    {
      inputOffset: 36516,
      outputOffset: 36329,
      from: "  let contract = validateLinearOptions(manifest.linearOptions);\n",
      to: "  const contract = validateLinearOptions(manifest.linearOptions);\n",
    },
    {
      inputOffset: 36828,
      outputOffset: 36643,
      from: '  const instrumentTexts = new Map<string, string>();\n  let successor: Data | undefined;\n  for (const record of instruments) {\n    const text = readText(readAuthority, record.path);\n    instrumentTexts.set(record.path, text);\n    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);\n    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {\n      successor ??= captureGeometrySuccessor(readAuthority);\n      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);\n    } else requirePin(text, record.pin, record.path);\n  }\n  if (successor) {\n    // Never combine an old supplied instrument with another instrument\'s successor epoch.\n    for (const value of array(successor.instruments, "geometry instruments")) {\n      const record = value as Data;\n      requirePin(\n        instrumentTexts.get(record.path as string)!,\n        validatePin(record.currentPin, "geometry current pin"),\n        "complete geometry instrument epoch",\n      );\n    }\n    contract = geometryLinearOptions(contract, successor.linearOptions);\n  }\n',
      to: "  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);\n",
    },
    {
      inputOffset: 41211,
      outputOffset: 40026,
      from: "function validateResolverTopology(resolver: Data, currentGeometry = false): void {\n  const expectedRequests = currentGeometry\n    ? [...fixedResolverRequests, ...geometryResolverRequests]\n    : fixedResolverRequests;\n",
      to: "function validateResolverTopology(resolver: Data): void {\n",
    },
    {
      inputOffset: 41729,
      outputOffset: 40385,
      from: '  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");\n',
      to: '  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");\n',
    },
    {
      inputOffset: 42417,
      outputOffset: 41078,
      from: "  for (const request of expectedRequests) {\n",
      to: "  for (const request of fixedResolverRequests) {\n",
    },
    {
      inputOffset: 45495,
      outputOffset: 44161,
      from: '\n// One finite geometry successor. ROOT owns the receipt and independent anchor activation.\nconst geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";\nconst geometryCallerContracts = [\n  {\n    path: "tests/issue-3518-program-data-contract-boundary.test.ts",\n    beforePin: {\n      bytes: 33595,\n      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",\n      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",\n    },\n    currentPin: {\n      bytes: 33840,\n      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",\n      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",\n    },\n  },\n  {\n    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 28811,\n      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",\n      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",\n    },\n    currentPin: {\n      bytes: 29161,\n      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",\n      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",\n    },\n  },\n  {\n    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 29570,\n      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",\n      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",\n    },\n    currentPin: {\n      bytes: 29764,\n      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",\n      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",\n    },\n  },\n  {\n    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 112437,\n      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",\n      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",\n    },\n    currentPin: {\n      bytes: 116007,\n      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",\n      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",\n    },\n  },\n] as const;\nconst geometryInstrumentPins: readonly C1PathPin[] = [\n  {\n    path: "tests/helpers/ir-c1-historical-authority.ts",\n    pin: {\n      bytes: 44161,\n      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",\n      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",\n    },\n  },\n  {\n    path: "tests/helpers/ir-c1-current-source.ts",\n    pin: {\n      bytes: 42599,\n      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",\n      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",\n    },\n  },\n  {\n    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    pin: {\n      bytes: 409599,\n      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",\n      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",\n    },\n  },\n  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),\n];\nconst geometryClosurePins: readonly C1PathPin[] = [\n  {\n    path: "src/ir/analysis/linear-memory-plan.ts",\n    pin: {\n      bytes: 45359,\n      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",\n      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",\n    },\n  },\n  {\n    path: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 3161,\n      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",\n      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",\n    },\n  },\n  {\n    path: "src/shared/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 7580,\n      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",\n      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",\n    },\n  },\n];\nconst geometryResolverRequests: readonly C1ResolverRequest[] = [\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "./contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    module: "../../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n];\nfunction geometryAnchorDigest(required: boolean): string | undefined {\n  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");\n  if (descriptor === undefined) {\n    if (required) fail("geometry instrument authority not activated");\n    return undefined;\n  }\n  if (\n    !Object.hasOwn(descriptor, "value") ||\n    typeof descriptor.value !== "string" ||\n    !/^[a-f0-9]{64}$/.test(descriptor.value)\n  )\n    fail("geometry instrument anchor data digest required");\n  return descriptor.value;\n}\nfunction geometryAnchorLine(digest: string | undefined): string {\n  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\\n`;\n}\nfunction captureGeometrySuccessor(readAuthority: AuthorityReader): Data {\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const digest = geometryAnchorDigest(true);\n  const anchor = readText(readAuthority, anchorPath);\n  const canonical =\n    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\n" +\n    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\\n` +\n    geometryAnchorLine(digest);\n  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");\n  const raw = readText(readAuthority, geometrySuccessorPath);\n  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");\n  const receipt = keys(\n    parseJson(raw, geometrySuccessorPath),\n    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],\n    "geometry instrument receipt",\n  );\n  if (\n    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||\n    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256\n  )\n    fail("geometry instrument receipt domain");\n  const instruments = array(receipt.instruments, "geometry instruments");\n  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");\n  instruments.forEach((value, index) => {\n    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");\n    if (\n      record.path !== geometryInstrumentPins[index]!.path ||\n      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)\n    )\n      fail("geometry instrument predecessor domain");\n    const currentPin = validatePin(record.currentPin, "geometry current pin");\n    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);\n    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(record[direction], "geometry " + direction);\n      if (!spans.length) fail("geometry instrument missing " + direction);\n      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));\n    }\n  });\n  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");\n  validatePrerequisiteSection(receipt.policySource, "policySource");\n  return receipt;\n}\nfunction geometryInstrumentReplay(\n  source: string,\n  spans: unknown,\n  target: C1Pin,\n  stage = "geometry instrument",\n): string {\n  const bytes = Buffer.from(source, "utf8");\n  const pieces: Buffer[] = [];\n  let inputEnd = 0,\n    outputEnd = 0,\n    previousInput = -1,\n    previousOutput = -1;\n  for (const value of array(spans, "geometry replay spans")) {\n    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");\n    if (\n      !Number.isSafeInteger(span.inputOffset) ||\n      !Number.isSafeInteger(span.outputOffset) ||\n      typeof span.from !== "string" ||\n      typeof span.to !== "string"\n    )\n      fail(stage + " span data");\n    const inputOffset = span.inputOffset as number,\n      outputOffset = span.outputOffset as number;\n    const from = Buffer.from(span.from),\n      to = Buffer.from(span.to);\n    if (\n      inputOffset < inputEnd ||\n      outputOffset < outputEnd ||\n      inputOffset <= previousInput ||\n      outputOffset <= previousOutput ||\n      inputOffset - inputEnd !== outputOffset - outputEnd ||\n      inputOffset + from.length > bytes.length ||\n      outputOffset + to.length > target.bytes ||\n      from.toString("utf8") !== span.from ||\n      to.toString("utf8") !== span.to ||\n      span.from === span.to ||\n      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)\n    )\n      fail(stage + " span membership/coordinates");\n    pieces.push(bytes.subarray(inputEnd, inputOffset), to);\n    previousInput = inputOffset;\n    previousOutput = outputOffset;\n    inputEnd = inputOffset + from.length;\n    outputEnd = outputOffset + to.length;\n  }\n  pieces.push(bytes.subarray(inputEnd));\n  const output = Buffer.concat(pieces).toString("utf8");\n  requirePin(output, target, stage + " replay");\n  return output;\n}\nfunction geometryInstrumentBefore(path: string, source: string, receipt: Data): string {\n  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as\n    | Data\n    | undefined;\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");\n  const before = geometryInstrumentReplay(\n    source,\n    record.inverse,\n    validatePin(record.beforePin, path),\n    "geometry instrument inverse: " + path,\n  );\n  const replay = geometryInstrumentReplay(\n    before,\n    record.forward,\n    validatePin(record.currentPin, path),\n    "geometry instrument forward: " + path,\n  );\n  if (replay !== source) fail("geometry independent instrument forward equality: " + path);\n  return before;\n}\n/** Exactly seven published instruments; primitive/path/reader checks precede IO. */\nexport function c1GeometryInstrumentPredecessor(\n  path: string,\n  source: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof path !== "string" || typeof source !== "string")\n    fail("geometry instrument primitive path/source required");\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const record = geometryInstrumentPins.find((entry) => entry.path === path);\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  // Exact original supplied inputs retain their pre-existing authority path.\n  if (same(measured(source), record.pin)) return source;\n  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));\n}\nfunction geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {\n  const contract = keys(\n    value,\n    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],\n    "geometry linear options",\n  );\n  const expectedClosure = [\n    ...before.closureInputs.map((entry) =>\n      entry.path === geometryClosurePins[0]!.path\n        ? geometryClosurePins[0]!\n        : entry.path === "src/codegen-linear/c-abi.ts"\n          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }\n          : entry,\n    ),\n    ...geometryClosurePins.slice(1),\n  ];\n  if (\n    contract.sourcePath !== before.sourcePath ||\n    !same(contract.declaration, before.declaration) ||\n    !same(contract.bindings, before.bindings) ||\n    !same(contract.closureInputs, expectedClosure)\n  )\n    fail("geometry-only closure successor");\n  const resolver = keys(\n    contract.resolver,\n    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],\n    "geometry resolver",\n  );\n  if (\n    !same(resolver.configInputs, before.resolver.configInputs) ||\n    resolver.optionsSource !== before.resolver.optionsSource ||\n    resolver.optionsSha256 !== before.resolver.optionsSha256\n  )\n    fail("geometry resolver configuration changed");\n  validateResolverTopology(resolver, true);\n  const observations = array(resolver.observations, "geometry observations");\n  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))\n    fail("unrelated geometry resolver transcript drift");\n  return contract as unknown as C1LinearOptionsContract;\n}\n\n// Fixed Git identities and full pins independently checked against the adopted Astra amendment.\nconst cabiSourceEpochContracts = [\n  {\n    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",\n    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",\n    beforePin: {\n      bytes: 26965,\n      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",\n      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",\n    },\n    currentPin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n  },\n  {\n    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",\n    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",\n    beforePin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n    currentPin: {\n      bytes: 27454,\n      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",\n      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",\n    },\n  },\n] as const;\nconst policySourceEpochContracts = [\n  {\n    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",\n    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",\n    beforePin: {\n      bytes: 599721,\n      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",\n      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",\n    },\n    currentPin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n  },\n  {\n    commit: "1156d385765f06d675bc6f6c25caa138501fef58",\n    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",\n    beforePin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n    currentPin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n  },\n  {\n    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",\n    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",\n    beforePin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n    currentPin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n  },\n  {\n    commit: "534620a636c63c257bc5afb8d543d0306b26928c",\n    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",\n    beforePin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n    currentPin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n  },\n  {\n    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",\n    parent: "26091eabd4561e5be154741e7e18143070d3ce59",\n    beforePin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n    currentPin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n  },\n  {\n    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",\n    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",\n    beforePin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n    currentPin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n  },\n  {\n    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",\n    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",\n    beforePin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n    currentPin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n  },\n  {\n    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",\n    beforePin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n    currentPin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n  },\n  {\n    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",\n    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    beforePin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n    currentPin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n  },\n  {\n    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",\n    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",\n    beforePin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n    currentPin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n  },\n  {\n    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",\n    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",\n    beforePin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n    currentPin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n  },\n  {\n    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",\n    parent: "e610189829ad1554b813d6ca224515666b0e2d28",\n    beforePin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n    currentPin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n  },\n  {\n    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",\n    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",\n    beforePin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n    currentPin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n  },\n] as const;\nconst prerequisitePolicyTopLevelKeys = [\n  "schema",\n  "description",\n  "sourceRoot",\n  "tsconfig",\n  "requireGitProvenance",\n  "externalAssets",\n  "frontendWrapper",\n  "moduleExtensions",\n  "layers",\n  "allowedEdges",\n  "externalPackages",\n  "activationHistory",\n  "nonModules",\n  "moves",\n  "evidence",\n  "files",\n] as const;\nconst prerequisitePolicySemanticRules = [\n  {\n    beforeFileCount: 1874,\n    currentFileCount: 1876,\n    additions: [\n      {\n        index: 122,\n        row: {\n          path: "src/checker/js-collection-inference.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "frontend-ts",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure.",\n        },\n        previousPath: "src/checker/inhouse-oracle.ts",\n        nextPath: "src/checker/language-service.ts",\n      },\n      {\n        index: 905,\n        row: {\n          path: "src/codegen/object-model/global-var-binding-exotic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",\n        nextPath: "src/codegen/object-model/proxy-trap-read.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1876,\n    currentFileCount: 1879,\n    additions: [\n      {\n        index: 576,\n        row: {\n          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/fnctor-ctor-param-types.ts",\n        nextPath: "src/codegen/fnctor-escape-gate.ts",\n      },\n      {\n        index: 976,\n        row: {\n          path: "src/codegen/expressions/spread-elem-extern.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/spread-arg-list.ts",\n        nextPath: "src/codegen/stack-balance.ts",\n      },\n      {\n        index: 978,\n        row: {\n          path: "src/codegen/expressions/standalone-any-length.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/stack-balance.ts",\n        nextPath: "src/codegen/standalone-class-instance-proto.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1879,\n    currentFileCount: 1881,\n    additions: [\n      {\n        index: 343,\n        row: {\n          path: "src/codegen/closures/closure-binding-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/capture-source-slot.ts",\n        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",\n      },\n      {\n        index: 1059,\n        row: {\n          path: "src/codegen/object-model/struct-field-name-tags.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/struct-hierarchy-layout.ts",\n        nextPath: "src/codegen/object-model/struct-optional-widen.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1881,\n    currentFileCount: 1882,\n    additions: [\n      {\n        index: 331,\n        row: {\n          path: "src/codegen/object-model/generator-function-proto-arm.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",\n        },\n        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",\n        nextPath: "src/codegen/closed-struct-extern-set.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1882,\n    currentFileCount: 1883,\n    additions: [\n      {\n        index: 1494,\n        row: {\n          path: "src/runtime/native-regime-view.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-function-source.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1883,\n    currentFileCount: 1884,\n    additions: [\n      {\n        index: 1113,\n        row: {\n          path: "src/codegen/array/vec-receiver-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/array/vec-elem-fidelity.ts",\n        nextPath: "src/codegen/vec-externref-hole-presence.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1884,\n    currentFileCount: 1885,\n    additions: [\n      {\n        index: 1335,\n        row: {\n          path: "src/ir/lowering/string-operations.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "compiler",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",\n        },\n        previousPath: "src/ir/lower-generic.ts",\n        nextPath: "src/ir/lower.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1885,\n    currentFileCount: 1886,\n    additions: [\n      {\n        index: 911,\n        row: {\n          path: "src/codegen/closures/function-intrinsic-construct.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/promoted-capture-value.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1886,\n    currentFileCount: 1887,\n    additions: [\n      {\n        index: 1498,\n        row: {\n          path: "src/runtime/process-capability.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-regime-view.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1887,\n    currentFileCount: 1889,\n    additions: [\n      {\n        index: 237,\n        row: {\n          path: "src/codegen/async-frame-binding-continuity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/async-await-hoist.ts",\n        nextPath: "src/codegen/async-cps-ast.ts",\n      },\n      {\n        index: 440,\n        row: {\n          path: "src/codegen/expressions/identifier-receiver-slot.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/dynamic-proto.ts",\n        nextPath: "src/codegen/dynamic-read-narrowing.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1889,\n    currentFileCount: 1892,\n    additions: [\n      {\n        index: 914,\n        row: {\n          path: "src/codegen/expressions/primitive-newtarget-default.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",\n        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n      },\n      {\n        index: 915,\n        row: {\n          path: "src/codegen/expressions/uncalled-shim-eval.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",\n        },\n        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",\n        nextPath: "src/codegen/object-model/construct-default-proto.ts",\n      },\n      {\n        index: 916,\n        row: {\n          path: "src/codegen/object-model/construct-default-proto.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1892,\n    currentFileCount: 1898,\n    additions: [\n      {\n        index: 1865,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/contracts.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/alloc-verification.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      },\n      {\n        index: 1866,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/census.ts",\n      },\n      {\n        index: 1867,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/census.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n      },\n      {\n        index: 1868,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/metadata.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/census.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",\n      },\n      {\n        index: 1869,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/verify.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n        nextPath: "src/ir/runtime/verify.ts",\n      },\n      {\n        index: 1872,\n        row: {\n          path: "src/ir/program/allocation-body-validation.ts",\n          state: "clean",\n          layer: "ir-program",\n        },\n        previousPath: "src/ir/program/allocations.ts",\n        nextPath: "src/ir/program/class-layouts.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 6,\n        id: "ir-analysis",\n        fields: ["roots", "entries", "minModules"],\n        beforeValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          minModules: 14,\n        },\n        currentValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/allocation-evidence",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n            "src/ir/analysis/allocation-evidence/contracts.ts",\n            "src/ir/analysis/allocation-evidence/effect-rules.ts",\n            "src/ir/analysis/allocation-evidence/census.ts",\n            "src/ir/analysis/allocation-evidence/metadata.ts",\n            "src/ir/analysis/allocation-evidence/verify.ts",\n          ],\n          minModules: 19,\n        },\n      },\n      {\n        index: 9,\n        id: "ir-program",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n          ],\n          minModules: 48,\n        },\n        currentValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n            "src/ir/program/allocation-body-validation.ts",\n          ],\n          minModules: 49,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1898,\n    currentFileCount: 1899,\n    additions: [\n      {\n        index: 1532,\n        row: {\n          path: "src/shared/contracts/linear-memory-layout.ts",\n          state: "clean",\n          layer: "foundation",\n        },\n        previousPath: "src/shared/contracts/identity-values.ts",\n        nextPath: "src/shared/contracts/ir-identity.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 0,\n        id: "foundation",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n          ],\n          minModules: 9,\n        },\n        currentValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n            "src/shared/contracts/linear-memory-layout.ts",\n          ],\n          minModules: 10,\n        },\n      },\n    ],\n  },\n] as const;\n\ntype PrerequisiteSectionName = "cabiSource" | "policySource";\nfunction validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {\n  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);\n  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;\n  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";\n  if (\n    source.path !== path ||\n    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||\n    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)\n  )\n    fail(name + " fixed source domain");\n  const epochs = array(source.epochs, name + " epochs");\n  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");\n  for (const [index, value] of epochs.entries()) {\n    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");\n    const contract = contracts[index]!;\n    if (\n      epoch.commit !== contract.commit ||\n      epoch.parent !== contract.parent ||\n      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||\n      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||\n      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))\n    )\n      fail(name + " fixed epoch identity/pins");\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(epoch[direction], name + " " + direction);\n      if (!spans.length) fail(name + " missing " + direction);\n      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");\n    }\n  }\n  return source;\n}\nfunction prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {\n  const before = keys(\n    parseJson(beforeRaw, stage + " before"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " before policy",\n  );\n  const current = keys(\n    parseJson(currentRaw, stage + " current"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " current policy",\n  );\n  const rule = prerequisitePolicySemanticRules[index]!;\n  const beforeFiles = array(before.files, stage + " before files"),\n    currentFiles = array(current.files, stage + " current files");\n  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)\n    fail(stage + " semantic file counts");\n  const removed = new Set<number>();\n  for (const addition of rule.additions) {\n    const at: number = addition.index;\n    const row = currentFiles[at];\n    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;\n    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;\n    if (\n      removed.has(addition.index) ||\n      !same(row, addition.row) ||\n      previous !== addition.previousPath ||\n      next !== addition.nextPath\n    )\n      fail(stage + " semantic ordered row/neighbors");\n    removed.add(addition.index);\n  }\n  if (\n    !same(\n      currentFiles.filter((_, at) => !removed.has(at)),\n      beforeFiles,\n    )\n  )\n    fail(stage + " semantic retained file rows");\n  const beforeLayers = array(before.layers, stage + " before layers"),\n    currentLayers = array(current.layers, stage + " current layers");\n  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");\n  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];\n  for (const change of rule.layers) {\n    const old = beforeLayers[change.index] as Data,\n      actual = currentLayers[change.index] as Data;\n    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))\n      fail(stage + " semantic layer identity/keys");\n    for (const field of change.fields) {\n      if (\n        !same(old[field], (change.beforeValues as Data)[field]) ||\n        !same(actual[field], (change.currentValues as Data)[field])\n      )\n        fail(stage + " semantic changed layer field: " + change.id + "/" + field);\n      replayLayers[change.index]![field] = actual[field];\n    }\n  }\n  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");\n  const replay = { ...before, files: currentFiles, layers: replayLayers };\n  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");\n}\nfunction prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {\n  const receipt = captureGeometrySuccessor(reader);\n  const source = validatePrerequisiteSection(receipt[name], name);\n  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");\n  const physical = readText(reader, source.path as string);\n  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");\n  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");\n  const epochs = array(source.epochs, name + " epochs") as Data[];\n  let before = rawCurrent;\n  const authenticatedCurrents: string[] = [];\n  for (let index = epochs.length - 1; index >= 0; index--) {\n    const epoch = epochs[index]!;\n    const stage = name + " inverse epoch " + (index + 1);\n    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");\n    authenticatedCurrents[index] = before;\n    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);\n    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);\n    before = predecessor;\n  }\n  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");\n  let replay = before;\n  for (const [index, epoch] of epochs.entries()) {\n    const stage = name + " forward epoch " + (index + 1);\n    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");\n    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);\n    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");\n    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);\n    replay = current;\n  }\n  if (replay !== rawCurrent) fail(name + " independent complete source equality");\n  return before;\n}\n/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */\nexport function captureC1LinearCabiPredecessor(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");\n  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");\n}\n/** Thirteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\nexport function captureGeometryCurrentMainPredecessorPolicySource(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");\n  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");\n}\n',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 238,
      outputOffset: 238,
      from: "",
      to: 'import * as c1AuthorityRoot from "./ir-c1-authority-root.js";\n',
    },
    {
      inputOffset: 34212,
      outputOffset: 34274,
      from: '  if (anchor !== canonicalAnchor) fail("warm anchor source changed");\n',
      to: '  const geometryDigest = geometryAnchorDigest(false);\n  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))\n    fail("warm anchor source changed");\n',
    },
    {
      inputOffset: 36329,
      outputOffset: 36516,
      from: "  const contract = validateLinearOptions(manifest.linearOptions);\n",
      to: "  let contract = validateLinearOptions(manifest.linearOptions);\n",
    },
    {
      inputOffset: 36643,
      outputOffset: 36828,
      from: "  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);\n",
      to: '  const instrumentTexts = new Map<string, string>();\n  let successor: Data | undefined;\n  for (const record of instruments) {\n    const text = readText(readAuthority, record.path);\n    instrumentTexts.set(record.path, text);\n    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);\n    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {\n      successor ??= captureGeometrySuccessor(readAuthority);\n      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);\n    } else requirePin(text, record.pin, record.path);\n  }\n  if (successor) {\n    // Never combine an old supplied instrument with another instrument\'s successor epoch.\n    for (const value of array(successor.instruments, "geometry instruments")) {\n      const record = value as Data;\n      requirePin(\n        instrumentTexts.get(record.path as string)!,\n        validatePin(record.currentPin, "geometry current pin"),\n        "complete geometry instrument epoch",\n      );\n    }\n    contract = geometryLinearOptions(contract, successor.linearOptions);\n  }\n',
    },
    {
      inputOffset: 40026,
      outputOffset: 41211,
      from: "function validateResolverTopology(resolver: Data): void {\n",
      to: "function validateResolverTopology(resolver: Data, currentGeometry = false): void {\n  const expectedRequests = currentGeometry\n    ? [...fixedResolverRequests, ...geometryResolverRequests]\n    : fixedResolverRequests;\n",
    },
    {
      inputOffset: 40385,
      outputOffset: 41729,
      from: '  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");\n',
      to: '  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");\n',
    },
    {
      inputOffset: 41078,
      outputOffset: 42417,
      from: "  for (const request of fixedResolverRequests) {\n",
      to: "  for (const request of expectedRequests) {\n",
    },
    {
      inputOffset: 44161,
      outputOffset: 45495,
      from: "",
      to: '\n// One finite geometry successor. ROOT owns the receipt and independent anchor activation.\nconst geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";\nconst geometryCallerContracts = [\n  {\n    path: "tests/issue-3518-program-data-contract-boundary.test.ts",\n    beforePin: {\n      bytes: 33595,\n      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",\n      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",\n    },\n    currentPin: {\n      bytes: 33840,\n      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",\n      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",\n    },\n  },\n  {\n    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 28811,\n      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",\n      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",\n    },\n    currentPin: {\n      bytes: 29161,\n      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",\n      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",\n    },\n  },\n  {\n    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 29570,\n      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",\n      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",\n    },\n    currentPin: {\n      bytes: 29764,\n      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",\n      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",\n    },\n  },\n  {\n    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 112437,\n      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",\n      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",\n    },\n    currentPin: {\n      bytes: 116007,\n      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",\n      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",\n    },\n  },\n] as const;\nconst geometryInstrumentPins: readonly C1PathPin[] = [\n  {\n    path: "tests/helpers/ir-c1-historical-authority.ts",\n    pin: {\n      bytes: 44161,\n      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",\n      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",\n    },\n  },\n  {\n    path: "tests/helpers/ir-c1-current-source.ts",\n    pin: {\n      bytes: 42599,\n      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",\n      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",\n    },\n  },\n  {\n    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    pin: {\n      bytes: 409599,\n      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",\n      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",\n    },\n  },\n  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),\n];\nconst geometryClosurePins: readonly C1PathPin[] = [\n  {\n    path: "src/ir/analysis/linear-memory-plan.ts",\n    pin: {\n      bytes: 45359,\n      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",\n      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",\n    },\n  },\n  {\n    path: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 3161,\n      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",\n      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",\n    },\n  },\n  {\n    path: "src/shared/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 7580,\n      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",\n      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",\n    },\n  },\n];\nconst geometryResolverRequests: readonly C1ResolverRequest[] = [\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "./contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    module: "../../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n];\nfunction geometryAnchorDigest(required: boolean): string | undefined {\n  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");\n  if (descriptor === undefined) {\n    if (required) fail("geometry instrument authority not activated");\n    return undefined;\n  }\n  if (\n    !Object.hasOwn(descriptor, "value") ||\n    typeof descriptor.value !== "string" ||\n    !/^[a-f0-9]{64}$/.test(descriptor.value)\n  )\n    fail("geometry instrument anchor data digest required");\n  return descriptor.value;\n}\nfunction geometryAnchorLine(digest: string | undefined): string {\n  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\\n`;\n}\nfunction captureGeometrySuccessor(readAuthority: AuthorityReader): Data {\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const digest = geometryAnchorDigest(true);\n  const anchor = readText(readAuthority, anchorPath);\n  const canonical =\n    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\n" +\n    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\\n` +\n    geometryAnchorLine(digest);\n  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");\n  const raw = readText(readAuthority, geometrySuccessorPath);\n  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");\n  const receipt = keys(\n    parseJson(raw, geometrySuccessorPath),\n    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],\n    "geometry instrument receipt",\n  );\n  if (\n    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||\n    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256\n  )\n    fail("geometry instrument receipt domain");\n  const instruments = array(receipt.instruments, "geometry instruments");\n  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");\n  instruments.forEach((value, index) => {\n    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");\n    if (\n      record.path !== geometryInstrumentPins[index]!.path ||\n      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)\n    )\n      fail("geometry instrument predecessor domain");\n    const currentPin = validatePin(record.currentPin, "geometry current pin");\n    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);\n    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(record[direction], "geometry " + direction);\n      if (!spans.length) fail("geometry instrument missing " + direction);\n      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));\n    }\n  });\n  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");\n  validatePrerequisiteSection(receipt.policySource, "policySource");\n  return receipt;\n}\nfunction geometryInstrumentReplay(\n  source: string,\n  spans: unknown,\n  target: C1Pin,\n  stage = "geometry instrument",\n): string {\n  const bytes = Buffer.from(source, "utf8");\n  const pieces: Buffer[] = [];\n  let inputEnd = 0,\n    outputEnd = 0,\n    previousInput = -1,\n    previousOutput = -1;\n  for (const value of array(spans, "geometry replay spans")) {\n    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");\n    if (\n      !Number.isSafeInteger(span.inputOffset) ||\n      !Number.isSafeInteger(span.outputOffset) ||\n      typeof span.from !== "string" ||\n      typeof span.to !== "string"\n    )\n      fail(stage + " span data");\n    const inputOffset = span.inputOffset as number,\n      outputOffset = span.outputOffset as number;\n    const from = Buffer.from(span.from),\n      to = Buffer.from(span.to);\n    if (\n      inputOffset < inputEnd ||\n      outputOffset < outputEnd ||\n      inputOffset <= previousInput ||\n      outputOffset <= previousOutput ||\n      inputOffset - inputEnd !== outputOffset - outputEnd ||\n      inputOffset + from.length > bytes.length ||\n      outputOffset + to.length > target.bytes ||\n      from.toString("utf8") !== span.from ||\n      to.toString("utf8") !== span.to ||\n      span.from === span.to ||\n      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)\n    )\n      fail(stage + " span membership/coordinates");\n    pieces.push(bytes.subarray(inputEnd, inputOffset), to);\n    previousInput = inputOffset;\n    previousOutput = outputOffset;\n    inputEnd = inputOffset + from.length;\n    outputEnd = outputOffset + to.length;\n  }\n  pieces.push(bytes.subarray(inputEnd));\n  const output = Buffer.concat(pieces).toString("utf8");\n  requirePin(output, target, stage + " replay");\n  return output;\n}\nfunction geometryInstrumentBefore(path: string, source: string, receipt: Data): string {\n  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as\n    | Data\n    | undefined;\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");\n  const before = geometryInstrumentReplay(\n    source,\n    record.inverse,\n    validatePin(record.beforePin, path),\n    "geometry instrument inverse: " + path,\n  );\n  const replay = geometryInstrumentReplay(\n    before,\n    record.forward,\n    validatePin(record.currentPin, path),\n    "geometry instrument forward: " + path,\n  );\n  if (replay !== source) fail("geometry independent instrument forward equality: " + path);\n  return before;\n}\n/** Exactly seven published instruments; primitive/path/reader checks precede IO. */\nexport function c1GeometryInstrumentPredecessor(\n  path: string,\n  source: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof path !== "string" || typeof source !== "string")\n    fail("geometry instrument primitive path/source required");\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const record = geometryInstrumentPins.find((entry) => entry.path === path);\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  // Exact original supplied inputs retain their pre-existing authority path.\n  if (same(measured(source), record.pin)) return source;\n  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));\n}\nfunction geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {\n  const contract = keys(\n    value,\n    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],\n    "geometry linear options",\n  );\n  const expectedClosure = [\n    ...before.closureInputs.map((entry) =>\n      entry.path === geometryClosurePins[0]!.path\n        ? geometryClosurePins[0]!\n        : entry.path === "src/codegen-linear/c-abi.ts"\n          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }\n          : entry,\n    ),\n    ...geometryClosurePins.slice(1),\n  ];\n  if (\n    contract.sourcePath !== before.sourcePath ||\n    !same(contract.declaration, before.declaration) ||\n    !same(contract.bindings, before.bindings) ||\n    !same(contract.closureInputs, expectedClosure)\n  )\n    fail("geometry-only closure successor");\n  const resolver = keys(\n    contract.resolver,\n    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],\n    "geometry resolver",\n  );\n  if (\n    !same(resolver.configInputs, before.resolver.configInputs) ||\n    resolver.optionsSource !== before.resolver.optionsSource ||\n    resolver.optionsSha256 !== before.resolver.optionsSha256\n  )\n    fail("geometry resolver configuration changed");\n  validateResolverTopology(resolver, true);\n  const observations = array(resolver.observations, "geometry observations");\n  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))\n    fail("unrelated geometry resolver transcript drift");\n  return contract as unknown as C1LinearOptionsContract;\n}\n\n// Fixed Git identities and full pins independently checked against the adopted Astra amendment.\nconst cabiSourceEpochContracts = [\n  {\n    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",\n    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",\n    beforePin: {\n      bytes: 26965,\n      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",\n      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",\n    },\n    currentPin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n  },\n  {\n    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",\n    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",\n    beforePin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n    currentPin: {\n      bytes: 27454,\n      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",\n      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",\n    },\n  },\n] as const;\nconst policySourceEpochContracts = [\n  {\n    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",\n    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",\n    beforePin: {\n      bytes: 599721,\n      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",\n      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",\n    },\n    currentPin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n  },\n  {\n    commit: "1156d385765f06d675bc6f6c25caa138501fef58",\n    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",\n    beforePin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n    currentPin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n  },\n  {\n    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",\n    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",\n    beforePin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n    currentPin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n  },\n  {\n    commit: "534620a636c63c257bc5afb8d543d0306b26928c",\n    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",\n    beforePin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n    currentPin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n  },\n  {\n    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",\n    parent: "26091eabd4561e5be154741e7e18143070d3ce59",\n    beforePin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n    currentPin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n  },\n  {\n    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",\n    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",\n    beforePin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n    currentPin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n  },\n  {\n    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",\n    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",\n    beforePin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n    currentPin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n  },\n  {\n    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",\n    beforePin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n    currentPin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n  },\n  {\n    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",\n    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    beforePin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n    currentPin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n  },\n  {\n    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",\n    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",\n    beforePin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n    currentPin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n  },\n  {\n    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",\n    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",\n    beforePin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n    currentPin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n  },\n  {\n    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",\n    parent: "e610189829ad1554b813d6ca224515666b0e2d28",\n    beforePin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n    currentPin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n  },\n  {\n    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",\n    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",\n    beforePin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n    currentPin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n  },\n] as const;\nconst prerequisitePolicyTopLevelKeys = [\n  "schema",\n  "description",\n  "sourceRoot",\n  "tsconfig",\n  "requireGitProvenance",\n  "externalAssets",\n  "frontendWrapper",\n  "moduleExtensions",\n  "layers",\n  "allowedEdges",\n  "externalPackages",\n  "activationHistory",\n  "nonModules",\n  "moves",\n  "evidence",\n  "files",\n] as const;\nconst prerequisitePolicySemanticRules = [\n  {\n    beforeFileCount: 1874,\n    currentFileCount: 1876,\n    additions: [\n      {\n        index: 122,\n        row: {\n          path: "src/checker/js-collection-inference.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "frontend-ts",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure.",\n        },\n        previousPath: "src/checker/inhouse-oracle.ts",\n        nextPath: "src/checker/language-service.ts",\n      },\n      {\n        index: 905,\n        row: {\n          path: "src/codegen/object-model/global-var-binding-exotic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",\n        nextPath: "src/codegen/object-model/proxy-trap-read.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1876,\n    currentFileCount: 1879,\n    additions: [\n      {\n        index: 576,\n        row: {\n          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/fnctor-ctor-param-types.ts",\n        nextPath: "src/codegen/fnctor-escape-gate.ts",\n      },\n      {\n        index: 976,\n        row: {\n          path: "src/codegen/expressions/spread-elem-extern.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/spread-arg-list.ts",\n        nextPath: "src/codegen/stack-balance.ts",\n      },\n      {\n        index: 978,\n        row: {\n          path: "src/codegen/expressions/standalone-any-length.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/stack-balance.ts",\n        nextPath: "src/codegen/standalone-class-instance-proto.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1879,\n    currentFileCount: 1881,\n    additions: [\n      {\n        index: 343,\n        row: {\n          path: "src/codegen/closures/closure-binding-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/capture-source-slot.ts",\n        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",\n      },\n      {\n        index: 1059,\n        row: {\n          path: "src/codegen/object-model/struct-field-name-tags.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/struct-hierarchy-layout.ts",\n        nextPath: "src/codegen/object-model/struct-optional-widen.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1881,\n    currentFileCount: 1882,\n    additions: [\n      {\n        index: 331,\n        row: {\n          path: "src/codegen/object-model/generator-function-proto-arm.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",\n        },\n        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",\n        nextPath: "src/codegen/closed-struct-extern-set.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1882,\n    currentFileCount: 1883,\n    additions: [\n      {\n        index: 1494,\n        row: {\n          path: "src/runtime/native-regime-view.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-function-source.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1883,\n    currentFileCount: 1884,\n    additions: [\n      {\n        index: 1113,\n        row: {\n          path: "src/codegen/array/vec-receiver-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/array/vec-elem-fidelity.ts",\n        nextPath: "src/codegen/vec-externref-hole-presence.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1884,\n    currentFileCount: 1885,\n    additions: [\n      {\n        index: 1335,\n        row: {\n          path: "src/ir/lowering/string-operations.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "compiler",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",\n        },\n        previousPath: "src/ir/lower-generic.ts",\n        nextPath: "src/ir/lower.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1885,\n    currentFileCount: 1886,\n    additions: [\n      {\n        index: 911,\n        row: {\n          path: "src/codegen/closures/function-intrinsic-construct.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/promoted-capture-value.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1886,\n    currentFileCount: 1887,\n    additions: [\n      {\n        index: 1498,\n        row: {\n          path: "src/runtime/process-capability.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-regime-view.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1887,\n    currentFileCount: 1889,\n    additions: [\n      {\n        index: 237,\n        row: {\n          path: "src/codegen/async-frame-binding-continuity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/async-await-hoist.ts",\n        nextPath: "src/codegen/async-cps-ast.ts",\n      },\n      {\n        index: 440,\n        row: {\n          path: "src/codegen/expressions/identifier-receiver-slot.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/dynamic-proto.ts",\n        nextPath: "src/codegen/dynamic-read-narrowing.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1889,\n    currentFileCount: 1892,\n    additions: [\n      {\n        index: 914,\n        row: {\n          path: "src/codegen/expressions/primitive-newtarget-default.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",\n        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n      },\n      {\n        index: 915,\n        row: {\n          path: "src/codegen/expressions/uncalled-shim-eval.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",\n        },\n        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",\n        nextPath: "src/codegen/object-model/construct-default-proto.ts",\n      },\n      {\n        index: 916,\n        row: {\n          path: "src/codegen/object-model/construct-default-proto.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1892,\n    currentFileCount: 1898,\n    additions: [\n      {\n        index: 1865,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/contracts.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/alloc-verification.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      },\n      {\n        index: 1866,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/census.ts",\n      },\n      {\n        index: 1867,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/census.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n      },\n      {\n        index: 1868,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/metadata.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/census.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",\n      },\n      {\n        index: 1869,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/verify.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n        nextPath: "src/ir/runtime/verify.ts",\n      },\n      {\n        index: 1872,\n        row: {\n          path: "src/ir/program/allocation-body-validation.ts",\n          state: "clean",\n          layer: "ir-program",\n        },\n        previousPath: "src/ir/program/allocations.ts",\n        nextPath: "src/ir/program/class-layouts.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 6,\n        id: "ir-analysis",\n        fields: ["roots", "entries", "minModules"],\n        beforeValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          minModules: 14,\n        },\n        currentValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/allocation-evidence",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n            "src/ir/analysis/allocation-evidence/contracts.ts",\n            "src/ir/analysis/allocation-evidence/effect-rules.ts",\n            "src/ir/analysis/allocation-evidence/census.ts",\n            "src/ir/analysis/allocation-evidence/metadata.ts",\n            "src/ir/analysis/allocation-evidence/verify.ts",\n          ],\n          minModules: 19,\n        },\n      },\n      {\n        index: 9,\n        id: "ir-program",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n          ],\n          minModules: 48,\n        },\n        currentValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n            "src/ir/program/allocation-body-validation.ts",\n          ],\n          minModules: 49,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1898,\n    currentFileCount: 1899,\n    additions: [\n      {\n        index: 1532,\n        row: {\n          path: "src/shared/contracts/linear-memory-layout.ts",\n          state: "clean",\n          layer: "foundation",\n        },\n        previousPath: "src/shared/contracts/identity-values.ts",\n        nextPath: "src/shared/contracts/ir-identity.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 0,\n        id: "foundation",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n          ],\n          minModules: 9,\n        },\n        currentValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n            "src/shared/contracts/linear-memory-layout.ts",\n          ],\n          minModules: 10,\n        },\n      },\n    ],\n  },\n] as const;\n\ntype PrerequisiteSectionName = "cabiSource" | "policySource";\nfunction validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {\n  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);\n  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;\n  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";\n  if (\n    source.path !== path ||\n    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||\n    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)\n  )\n    fail(name + " fixed source domain");\n  const epochs = array(source.epochs, name + " epochs");\n  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");\n  for (const [index, value] of epochs.entries()) {\n    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");\n    const contract = contracts[index]!;\n    if (\n      epoch.commit !== contract.commit ||\n      epoch.parent !== contract.parent ||\n      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||\n      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||\n      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))\n    )\n      fail(name + " fixed epoch identity/pins");\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(epoch[direction], name + " " + direction);\n      if (!spans.length) fail(name + " missing " + direction);\n      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");\n    }\n  }\n  return source;\n}\nfunction prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {\n  const before = keys(\n    parseJson(beforeRaw, stage + " before"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " before policy",\n  );\n  const current = keys(\n    parseJson(currentRaw, stage + " current"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " current policy",\n  );\n  const rule = prerequisitePolicySemanticRules[index]!;\n  const beforeFiles = array(before.files, stage + " before files"),\n    currentFiles = array(current.files, stage + " current files");\n  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)\n    fail(stage + " semantic file counts");\n  const removed = new Set<number>();\n  for (const addition of rule.additions) {\n    const at: number = addition.index;\n    const row = currentFiles[at];\n    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;\n    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;\n    if (\n      removed.has(addition.index) ||\n      !same(row, addition.row) ||\n      previous !== addition.previousPath ||\n      next !== addition.nextPath\n    )\n      fail(stage + " semantic ordered row/neighbors");\n    removed.add(addition.index);\n  }\n  if (\n    !same(\n      currentFiles.filter((_, at) => !removed.has(at)),\n      beforeFiles,\n    )\n  )\n    fail(stage + " semantic retained file rows");\n  const beforeLayers = array(before.layers, stage + " before layers"),\n    currentLayers = array(current.layers, stage + " current layers");\n  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");\n  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];\n  for (const change of rule.layers) {\n    const old = beforeLayers[change.index] as Data,\n      actual = currentLayers[change.index] as Data;\n    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))\n      fail(stage + " semantic layer identity/keys");\n    for (const field of change.fields) {\n      if (\n        !same(old[field], (change.beforeValues as Data)[field]) ||\n        !same(actual[field], (change.currentValues as Data)[field])\n      )\n        fail(stage + " semantic changed layer field: " + change.id + "/" + field);\n      replayLayers[change.index]![field] = actual[field];\n    }\n  }\n  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");\n  const replay = { ...before, files: currentFiles, layers: replayLayers };\n  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");\n}\nfunction prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {\n  const receipt = captureGeometrySuccessor(reader);\n  const source = validatePrerequisiteSection(receipt[name], name);\n  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");\n  const physical = readText(reader, source.path as string);\n  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");\n  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");\n  const epochs = array(source.epochs, name + " epochs") as Data[];\n  let before = rawCurrent;\n  const authenticatedCurrents: string[] = [];\n  for (let index = epochs.length - 1; index >= 0; index--) {\n    const epoch = epochs[index]!;\n    const stage = name + " inverse epoch " + (index + 1);\n    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");\n    authenticatedCurrents[index] = before;\n    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);\n    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);\n    before = predecessor;\n  }\n  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");\n  let replay = before;\n  for (const [index, epoch] of epochs.entries()) {\n    const stage = name + " forward epoch " + (index + 1);\n    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");\n    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);\n    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");\n    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);\n    replay = current;\n  }\n  if (replay !== rawCurrent) fail(name + " independent complete source equality");\n  return before;\n}\n/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */\nexport function captureC1LinearCabiPredecessor(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");\n  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");\n}\n/** Thirteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\nexport function captureGeometryCurrentMainPredecessorPolicySource(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");\n  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");\n}\n',
    },
  ],
} as const);
const numberCallerPath = "tests/issue-3518-number-prerequisite-policy-evolution.test.ts";
const historicalCallerPath = "tests/helpers/ir-c1-historical-authority.ts";
const independentNumberHistoricalTrace = freezeCompositionLiteral([
  "tests/helpers/ir-c1-authority-root.ts",
  "tests/helpers/ir-c1-authority.json",
  "tests/helpers/ir-runtime-program-relocation.ts",
  "tests/helpers/ir-runtime-program-relocation.json",
  "tests/helpers/ir-validation-policy-evolution.ts",
  "tests/helpers/ir-validation-policy-evolution.json",
  "tests/helpers/ir-runtime-program-policy-evolution.json",
  "tests/helpers/ir-runtime-program-policy-well-known-symbols.json",
  "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
  "tests/helpers/ir-runtime-program-policy-runtime-preparation.json",
  "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
  "tests/helpers/ir-runtime-program-policy-host-carrier.json",
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
  "tests/helpers/ir-c1-historical-authority.ts",
  "tests/helpers/ir-c1-authority-root.ts",
  "tests/helpers/ir-c1-linear-layout-geometry-successor.json",
  "tests/helpers/ir-c1-current-source.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
  "tests/issue-3518-program-data-contract-boundary.test.ts",
  "tests/issue-3518-program-data-contract-seam.test.ts",
  "tests/issue-3518-program-ownership-runtime-seam.test.ts",
  "tests/issue-3518-program-pre-a-evolution.test.ts",
  "tests/issue-3518-program-initial-graph-evolution.test.ts",
  "tests/issue-3518-runtime-program-relocation.test.ts",
  "tests/issue-3518-runtime-program-policy-evolution.test.ts",
  "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",
  "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
  "tests/fixtures/issue-3518-c1-historical-authority/linear-index.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/runtime-program-relocation.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-data-contract-seam.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-ownership-runtime-seam.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-pre-a-evolution.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/program-initial-graph-evolution.test.ts.txt",
  "tests/fixtures/issue-3518-c1-historical-authority/runtime-program-policy-evolution.ts.txt",
] as const);

function compositionPin(source: string, expected: GeometryPin): void {
  compositionPrimitiveBytes(source);
  expect(pin(source)).toEqual(expected);
}
function fixedCallerMetadata(
  actual: IndependentFixtureEpoch,
  fixed: IndependentFixtureEpoch,
): { inverse: readonly SuccessorSpan[]; forward: readonly SuccessorSpan[] } {
  const values = compositionOwnDataRecord(
    actual,
    ["path", "beforePin", "currentPin", "inverse", "forward"],
    "caller proof",
  );
  compositionRequire(values.path === fixed.path, "fixed caller proof path");
  for (const record of ["beforePin", "currentPin"] as const) {
    const supplied = compositionOwnDataRecord(values[record], ["bytes", "sha256", "gitBlob"], "caller " + record);
    for (const field of ["bytes", "sha256", "gitBlob"] as const)
      compositionRequire(supplied[field] === fixed[record][field], "fixed caller " + record + " " + field);
  }
  compositionRequire(Array.isArray(values.inverse) && Array.isArray(values.forward), "caller recipe arrays");
  return { inverse: values.inverse as SuccessorSpan[], forward: values.forward as SuccessorSpan[] };
}
function independentlyCheckComposedCaller(
  current: string,
  stage: IndependentFixtureEpoch,
  old: IndependentFixtureEpoch,
  composed: IndependentFixtureEpoch,
) {
  compositionPrimitiveBytes(current);
  const stageValues = compositionOwnDataRecord(
    stage,
    ["path", "beforePin", "currentPin", "inverse", "forward"],
    "caller stage",
  );
  const fixed =
    stageValues.path === numberCallerPath
      ? ([numberCallerStage, numberCallerOld, numberCallerComposed] as const)
      : stageValues.path === historicalCallerPath
        ? ([h1CallerStage, h1CallerOld, h1CallerComposed] as const)
        : undefined;
  compositionRequire(fixed !== undefined, "closed caller proof domain");
  for (const [actual, expected] of [
    [stage, fixed[0]],
    [old, fixed[1]],
    [composed, fixed[2]],
  ] as const)
    fixedCallerMetadata(actual, expected);
  const check = (
    source: string,
    proof: IndependentFixtureEpoch,
    authority: IndependentFixtureEpoch,
    label: string,
  ): string => {
    const recipes = fixedCallerMetadata(proof, authority);
    compositionPin(source, authority.currentPin);
    const before = independentlyReplaySuccessorSpans(source, recipes.inverse, label + " inverse", authority.beforePin);
    compositionPin(before, authority.beforePin);
    const forward = independentlyReplaySuccessorSpans(
      before,
      recipes.forward,
      label + " forward",
      authority.currentPin,
    );
    compositionPin(forward, authority.currentPin);
    expect(forward).toBe(source);
    return before;
  };
  const intermediate = check(current, stage, fixed[0], "intermediate " + stage.path);
  expect(fixed[0].beforePin).toEqual(fixed[1].currentPin);
  const original = check(intermediate, old, fixed[1], "old " + stage.path);
  expect(fixed[2].beforePin).toEqual(fixed[1].beforePin);
  expect(fixed[2].currentPin).toEqual(fixed[0].currentPin);
  expect(check(current, composed, fixed[2], "composed " + stage.path)).toBe(original);
  return { current, intermediate, original };
}
// Genuine thirteen-epoch operands stay historical; no archive is accepted by a physical current reader.
function thirteenSuccessorFreeze(): CurrentSuccessorFreeze {
  const expected = JSON.parse(independentThirteenSuccessorFreeze) as CurrentSuccessorFreeze;
  expect(expected.instruments.map((entry) => entry.path)).toEqual(successorInstrumentPaths);
  expect(expected.anchorPin.bytes).toBe(303);
  return expected;
}
// Proposed immediate H1 metadata stage independently fixed from both complete owner operands.
const sliceH1Stage = {
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 96713,
    sha256: "7bbfaf6687f7411147f00833380027d3959b743ec7dc033fc9bba8d69849992b",
    gitBlob: "c59701cc36595cea2536c35edcc1e42278ba3e5c",
  },
  currentPin: {
    bytes: 97604,
    sha256: "42e63830cb48f96803360cf051981b28368bfcb3f1675a32a0f29ff02e5e3e2b",
    gitBlob: "3a2ef83e164a4128f6b284739be0e25d1242a19f",
  },
  inverse: [
    {
      inputOffset: 65832,
      outputOffset: 65832,
      from: '  {\n    commit: "b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771",\n    parent: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",\n    beforePin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n    currentPin: {\n      bytes: 607104,\n      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",\n      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",\n    },\n  },\n',
      to: "",
    },
    {
      inputOffset: 89726,
      outputOffset: 89232,
      from: '  {\n    beforeFileCount: 1899,\n    currentFileCount: 1900,\n    additions: [\n      {\n        index: 155,\n        row: {\n          path: "src/codegen-linear/runtime/string-slice.ts",\n          state: "unmigrated",\n          layer: "legacy-linear",\n        },\n        previousPath: "src/codegen-linear/runtime.ts",\n        nextPath: "src/codegen-linear/simd.ts",\n      },\n    ],\n    layers: [],\n  },\n',
      to: "",
    },
    {
      inputOffset: 97052,
      outputOffset: 96161,
      from: "/** Fourteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Thirteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
  ],
  forward: [
    {
      inputOffset: 65832,
      outputOffset: 65832,
      from: "",
      to: '  {\n    commit: "b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771",\n    parent: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",\n    beforePin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n    currentPin: {\n      bytes: 607104,\n      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",\n      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",\n    },\n  },\n',
    },
    {
      inputOffset: 89232,
      outputOffset: 89726,
      from: "",
      to: '  {\n    beforeFileCount: 1899,\n    currentFileCount: 1900,\n    additions: [\n      {\n        index: 155,\n        row: {\n          path: "src/codegen-linear/runtime/string-slice.ts",\n          state: "unmigrated",\n          layer: "legacy-linear",\n        },\n        previousPath: "src/codegen-linear/runtime.ts",\n        nextPath: "src/codegen-linear/simd.ts",\n      },\n    ],\n    layers: [],\n  },\n',
    },
    {
      inputOffset: 96161,
      outputOffset: 97052,
      from: "/** Thirteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Fourteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
  ],
} as const;

// Independent complete owner operands: this stage restores authentic14, never an active fallback.
const finalPolicyH1Stage = {
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 97604,
    sha256: "42e63830cb48f96803360cf051981b28368bfcb3f1675a32a0f29ff02e5e3e2b",
    gitBlob: "3a2ef83e164a4128f6b284739be0e25d1242a19f",
  },
  currentPin: {
    bytes: 101086,
    sha256: "ac0c6d08c889b084853fd15a99a78fb0ed2f2dec76444a19e958d17212d15652",
    gitBlob: "d2fd28c88dda7043531753b5c077bf6dcfd3799f",
  },
  inverse: [
    {
      inputOffset: 66326,
      outputOffset: 66326,
      from: '  {\n    commit: "320399e7e8e6866b81560ecdc8f60a260cf10991",\n    parent: "43b1f746771bf266f15b285fc8bac93d3c8d22d8",\n    beforePin: {\n      bytes: 607104,\n      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",\n      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",\n    },\n    currentPin: {\n      bytes: 608189,\n      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",\n      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",\n    },\n  },\n  {\n    commit: "dd5452e4c0be68ec6582bba3eb5d3aba0756c5a1",\n    parent: "a3cccd199b24865b1ea3f77a519e1a8bcc34ad3a",\n    beforePin: {\n      bytes: 608189,\n      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",\n      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",\n    },\n    currentPin: {\n      bytes: 608556,\n      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",\n      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",\n    },\n  },\n',
      to: "",
    },
    {
      inputOffset: 91111,
      outputOffset: 90123,
      from: '  {\n    beforeFileCount: 1900,\n    currentFileCount: 1903,\n    additions: [\n      {\n        index: 198,\n        row: {\n          path: "src/codegen/array/array-search-core.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service.",\n        },\n        previousPath: "src/codegen/array-element-typing.ts",\n        nextPath: "src/codegen/array/array-search-proto-value.ts",\n      },\n      {\n        index: 199,\n        row: {\n          path: "src/codegen/array/array-search-proto-value.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",\n        },\n        previousPath: "src/codegen/array/array-search-core.ts",\n        nextPath: "src/codegen/array/array-generic-value-bodies.ts",\n      },\n      {\n        index: 200,\n        row: {\n          path: "src/codegen/array/array-generic-value-bodies.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",\n        },\n        previousPath: "src/codegen/array/array-search-proto-value.ts",\n        nextPath: "src/codegen/array/array-fill-proto-value.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1903,\n    currentFileCount: 1904,\n    additions: [\n      {\n        index: 201,\n        row: {\n          path: "src/codegen/array/array-copy-methods-value.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",\n        },\n        previousPath: "src/codegen/array/array-generic-value-bodies.ts",\n        nextPath: "src/codegen/array/array-fill-proto-value.ts",\n      },\n    ],\n    layers: [],\n  },\n',
      to: "",
    },
    {
      inputOffset: 100535,
      outputOffset: 97052,
      from: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Fourteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
  ],
  forward: [
    {
      inputOffset: 66326,
      outputOffset: 66326,
      from: "",
      to: '  {\n    commit: "320399e7e8e6866b81560ecdc8f60a260cf10991",\n    parent: "43b1f746771bf266f15b285fc8bac93d3c8d22d8",\n    beforePin: {\n      bytes: 607104,\n      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",\n      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",\n    },\n    currentPin: {\n      bytes: 608189,\n      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",\n      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",\n    },\n  },\n  {\n    commit: "dd5452e4c0be68ec6582bba3eb5d3aba0756c5a1",\n    parent: "a3cccd199b24865b1ea3f77a519e1a8bcc34ad3a",\n    beforePin: {\n      bytes: 608189,\n      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",\n      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",\n    },\n    currentPin: {\n      bytes: 608556,\n      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",\n      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",\n    },\n  },\n',
    },
    {
      inputOffset: 90123,
      outputOffset: 91111,
      from: "",
      to: '  {\n    beforeFileCount: 1900,\n    currentFileCount: 1903,\n    additions: [\n      {\n        index: 198,\n        row: {\n          path: "src/codegen/array/array-search-core.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service.",\n        },\n        previousPath: "src/codegen/array-element-typing.ts",\n        nextPath: "src/codegen/array/array-search-proto-value.ts",\n      },\n      {\n        index: 199,\n        row: {\n          path: "src/codegen/array/array-search-proto-value.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",\n        },\n        previousPath: "src/codegen/array/array-search-core.ts",\n        nextPath: "src/codegen/array/array-generic-value-bodies.ts",\n      },\n      {\n        index: 200,\n        row: {\n          path: "src/codegen/array/array-generic-value-bodies.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",\n        },\n        previousPath: "src/codegen/array/array-search-proto-value.ts",\n        nextPath: "src/codegen/array/array-fill-proto-value.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1903,\n    currentFileCount: 1904,\n    additions: [\n      {\n        index: 201,\n        row: {\n          path: "src/codegen/array/array-copy-methods-value.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",\n        },\n        previousPath: "src/codegen/array/array-generic-value-bodies.ts",\n        nextPath: "src/codegen/array/array-fill-proto-value.ts",\n      },\n    ],\n    layers: [],\n  },\n',
    },
    {
      inputOffset: 97052,
      outputOffset: 100535,
      from: "/** Fourteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
  ],
} as const;
const canonicalPolicyEpochs = [
  {
    commit: "320399e7e8e6866b81560ecdc8f60a260cf10991",
    parent: "43b1f746771bf266f15b285fc8bac93d3c8d22d8",
    beforePin: {
      bytes: 607104,
      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",
      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",
    },
    currentPin: {
      bytes: 608189,
      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",
      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",
    },
    inverse: [
      {
        inputOffset: 110764,
        outputOffset: 110764,
        from: '    {\n      "path": "src/codegen/array/array-search-core.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service."\n    },\n    {\n      "path": "src/codegen/array/array-search-proto-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core."\n    },\n    {\n      "path": "src/codegen/array/array-generic-value-bodies.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction."\n    },\n',
        to: "",
      },
    ],
    forward: [
      {
        inputOffset: 110764,
        outputOffset: 110764,
        from: "",
        to: '    {\n      "path": "src/codegen/array/array-search-core.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service."\n    },\n    {\n      "path": "src/codegen/array/array-search-proto-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core."\n    },\n    {\n      "path": "src/codegen/array/array-generic-value-bodies.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction."\n    },\n',
      },
    ],
  },
  {
    commit: "dd5452e4c0be68ec6582bba3eb5d3aba0756c5a1",
    parent: "a3cccd199b24865b1ea3f77a519e1a8bcc34ad3a",
    beforePin: {
      bytes: 608189,
      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",
      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",
    },
    currentPin: {
      bytes: 608556,
      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",
      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",
    },
    inverse: [
      {
        inputOffset: 111849,
        outputOffset: 111849,
        from: '    {\n      "path": "src/codegen/array/array-copy-methods-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction."\n    },\n',
        to: "",
      },
    ],
    forward: [
      {
        inputOffset: 111849,
        outputOffset: 111849,
        from: "",
        to: '    {\n      "path": "src/codegen/array/array-copy-methods-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction."\n    },\n',
      },
    ],
  },
] as const;
const fourteenH1Record = {
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 44161,
    sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",
    gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",
  },
  currentPin: {
    bytes: 97604,
    sha256: "42e63830cb48f96803360cf051981b28368bfcb3f1675a32a0f29ff02e5e3e2b",
    gitBlob: "3a2ef83e164a4128f6b284739be0e25d1242a19f",
  },
  inverse: [
    {
      inputOffset: 238,
      outputOffset: 238,
      from: 'import * as c1AuthorityRoot from "./ir-c1-authority-root.js";\n',
      to: "",
    },
    {
      inputOffset: 34274,
      outputOffset: 34212,
      from: '  const geometryDigest = geometryAnchorDigest(false);\n  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))\n    fail("warm anchor source changed");\n',
      to: '  if (anchor !== canonicalAnchor) fail("warm anchor source changed");\n',
    },
    {
      inputOffset: 36516,
      outputOffset: 36329,
      from: "  let contract = validateLinearOptions(manifest.linearOptions);\n",
      to: "  const contract = validateLinearOptions(manifest.linearOptions);\n",
    },
    {
      inputOffset: 36828,
      outputOffset: 36643,
      from: '  const instrumentTexts = new Map<string, string>();\n  let successor: Data | undefined;\n  for (const record of instruments) {\n    const text = readText(readAuthority, record.path);\n    instrumentTexts.set(record.path, text);\n    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);\n    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {\n      successor ??= captureGeometrySuccessor(readAuthority);\n      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);\n    } else requirePin(text, record.pin, record.path);\n  }\n  if (successor) {\n    // Never combine an old supplied instrument with another instrument\'s successor epoch.\n    for (const value of array(successor.instruments, "geometry instruments")) {\n      const record = value as Data;\n      requirePin(\n        instrumentTexts.get(record.path as string)!,\n        validatePin(record.currentPin, "geometry current pin"),\n        "complete geometry instrument epoch",\n      );\n    }\n    contract = geometryLinearOptions(contract, successor.linearOptions);\n  }\n',
      to: "  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);\n",
    },
    {
      inputOffset: 41211,
      outputOffset: 40026,
      from: "function validateResolverTopology(resolver: Data, currentGeometry = false): void {\n  const expectedRequests = currentGeometry\n    ? [...fixedResolverRequests, ...geometryResolverRequests]\n    : fixedResolverRequests;\n",
      to: "function validateResolverTopology(resolver: Data): void {\n",
    },
    {
      inputOffset: 41729,
      outputOffset: 40385,
      from: '  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");\n',
      to: '  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");\n',
    },
    {
      inputOffset: 42417,
      outputOffset: 41078,
      from: "  for (const request of expectedRequests) {\n",
      to: "  for (const request of fixedResolverRequests) {\n",
    },
    {
      inputOffset: 45495,
      outputOffset: 44161,
      from: '\n// One finite geometry successor. ROOT owns the receipt and independent anchor activation.\nconst geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";\nconst geometryCallerContracts = [\n  {\n    path: "tests/issue-3518-program-data-contract-boundary.test.ts",\n    beforePin: {\n      bytes: 33595,\n      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",\n      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",\n    },\n    currentPin: {\n      bytes: 33840,\n      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",\n      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",\n    },\n  },\n  {\n    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 28811,\n      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",\n      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",\n    },\n    currentPin: {\n      bytes: 29161,\n      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",\n      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",\n    },\n  },\n  {\n    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 29570,\n      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",\n      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",\n    },\n    currentPin: {\n      bytes: 29764,\n      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",\n      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",\n    },\n  },\n  {\n    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 112437,\n      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",\n      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",\n    },\n    currentPin: {\n      bytes: 116007,\n      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",\n      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",\n    },\n  },\n] as const;\nconst geometryInstrumentPins: readonly C1PathPin[] = [\n  {\n    path: "tests/helpers/ir-c1-historical-authority.ts",\n    pin: {\n      bytes: 44161,\n      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",\n      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",\n    },\n  },\n  {\n    path: "tests/helpers/ir-c1-current-source.ts",\n    pin: {\n      bytes: 42599,\n      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",\n      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",\n    },\n  },\n  {\n    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    pin: {\n      bytes: 409599,\n      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",\n      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",\n    },\n  },\n  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),\n];\nconst geometryClosurePins: readonly C1PathPin[] = [\n  {\n    path: "src/ir/analysis/linear-memory-plan.ts",\n    pin: {\n      bytes: 45359,\n      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",\n      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",\n    },\n  },\n  {\n    path: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 3161,\n      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",\n      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",\n    },\n  },\n  {\n    path: "src/shared/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 7580,\n      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",\n      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",\n    },\n  },\n];\nconst geometryResolverRequests: readonly C1ResolverRequest[] = [\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "./contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    module: "../../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n];\nfunction geometryAnchorDigest(required: boolean): string | undefined {\n  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");\n  if (descriptor === undefined) {\n    if (required) fail("geometry instrument authority not activated");\n    return undefined;\n  }\n  if (\n    !Object.hasOwn(descriptor, "value") ||\n    typeof descriptor.value !== "string" ||\n    !/^[a-f0-9]{64}$/.test(descriptor.value)\n  )\n    fail("geometry instrument anchor data digest required");\n  return descriptor.value;\n}\nfunction geometryAnchorLine(digest: string | undefined): string {\n  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\\n`;\n}\nfunction captureGeometrySuccessor(readAuthority: AuthorityReader): Data {\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const digest = geometryAnchorDigest(true);\n  const anchor = readText(readAuthority, anchorPath);\n  const canonical =\n    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\n" +\n    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\\n` +\n    geometryAnchorLine(digest);\n  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");\n  const raw = readText(readAuthority, geometrySuccessorPath);\n  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");\n  const receipt = keys(\n    parseJson(raw, geometrySuccessorPath),\n    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],\n    "geometry instrument receipt",\n  );\n  if (\n    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||\n    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256\n  )\n    fail("geometry instrument receipt domain");\n  const instruments = array(receipt.instruments, "geometry instruments");\n  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");\n  instruments.forEach((value, index) => {\n    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");\n    if (\n      record.path !== geometryInstrumentPins[index]!.path ||\n      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)\n    )\n      fail("geometry instrument predecessor domain");\n    const currentPin = validatePin(record.currentPin, "geometry current pin");\n    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);\n    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(record[direction], "geometry " + direction);\n      if (!spans.length) fail("geometry instrument missing " + direction);\n      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));\n    }\n  });\n  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");\n  validatePrerequisiteSection(receipt.policySource, "policySource");\n  return receipt;\n}\nfunction geometryInstrumentReplay(\n  source: string,\n  spans: unknown,\n  target: C1Pin,\n  stage = "geometry instrument",\n): string {\n  const bytes = Buffer.from(source, "utf8");\n  const pieces: Buffer[] = [];\n  let inputEnd = 0,\n    outputEnd = 0,\n    previousInput = -1,\n    previousOutput = -1;\n  for (const value of array(spans, "geometry replay spans")) {\n    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");\n    if (\n      !Number.isSafeInteger(span.inputOffset) ||\n      !Number.isSafeInteger(span.outputOffset) ||\n      typeof span.from !== "string" ||\n      typeof span.to !== "string"\n    )\n      fail(stage + " span data");\n    const inputOffset = span.inputOffset as number,\n      outputOffset = span.outputOffset as number;\n    const from = Buffer.from(span.from),\n      to = Buffer.from(span.to);\n    if (\n      inputOffset < inputEnd ||\n      outputOffset < outputEnd ||\n      inputOffset <= previousInput ||\n      outputOffset <= previousOutput ||\n      inputOffset - inputEnd !== outputOffset - outputEnd ||\n      inputOffset + from.length > bytes.length ||\n      outputOffset + to.length > target.bytes ||\n      from.toString("utf8") !== span.from ||\n      to.toString("utf8") !== span.to ||\n      span.from === span.to ||\n      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)\n    )\n      fail(stage + " span membership/coordinates");\n    pieces.push(bytes.subarray(inputEnd, inputOffset), to);\n    previousInput = inputOffset;\n    previousOutput = outputOffset;\n    inputEnd = inputOffset + from.length;\n    outputEnd = outputOffset + to.length;\n  }\n  pieces.push(bytes.subarray(inputEnd));\n  const output = Buffer.concat(pieces).toString("utf8");\n  requirePin(output, target, stage + " replay");\n  return output;\n}\nfunction geometryInstrumentBefore(path: string, source: string, receipt: Data): string {\n  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as\n    | Data\n    | undefined;\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");\n  const before = geometryInstrumentReplay(\n    source,\n    record.inverse,\n    validatePin(record.beforePin, path),\n    "geometry instrument inverse: " + path,\n  );\n  const replay = geometryInstrumentReplay(\n    before,\n    record.forward,\n    validatePin(record.currentPin, path),\n    "geometry instrument forward: " + path,\n  );\n  if (replay !== source) fail("geometry independent instrument forward equality: " + path);\n  return before;\n}\n/** Exactly seven published instruments; primitive/path/reader checks precede IO. */\nexport function c1GeometryInstrumentPredecessor(\n  path: string,\n  source: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof path !== "string" || typeof source !== "string")\n    fail("geometry instrument primitive path/source required");\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const record = geometryInstrumentPins.find((entry) => entry.path === path);\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  // Exact original supplied inputs retain their pre-existing authority path.\n  if (same(measured(source), record.pin)) return source;\n  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));\n}\nfunction geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {\n  const contract = keys(\n    value,\n    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],\n    "geometry linear options",\n  );\n  const expectedClosure = [\n    ...before.closureInputs.map((entry) =>\n      entry.path === geometryClosurePins[0]!.path\n        ? geometryClosurePins[0]!\n        : entry.path === "src/codegen-linear/c-abi.ts"\n          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }\n          : entry,\n    ),\n    ...geometryClosurePins.slice(1),\n  ];\n  if (\n    contract.sourcePath !== before.sourcePath ||\n    !same(contract.declaration, before.declaration) ||\n    !same(contract.bindings, before.bindings) ||\n    !same(contract.closureInputs, expectedClosure)\n  )\n    fail("geometry-only closure successor");\n  const resolver = keys(\n    contract.resolver,\n    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],\n    "geometry resolver",\n  );\n  if (\n    !same(resolver.configInputs, before.resolver.configInputs) ||\n    resolver.optionsSource !== before.resolver.optionsSource ||\n    resolver.optionsSha256 !== before.resolver.optionsSha256\n  )\n    fail("geometry resolver configuration changed");\n  validateResolverTopology(resolver, true);\n  const observations = array(resolver.observations, "geometry observations");\n  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))\n    fail("unrelated geometry resolver transcript drift");\n  return contract as unknown as C1LinearOptionsContract;\n}\n\n// Fixed Git identities and full pins independently checked against the adopted Astra amendment.\nconst cabiSourceEpochContracts = [\n  {\n    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",\n    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",\n    beforePin: {\n      bytes: 26965,\n      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",\n      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",\n    },\n    currentPin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n  },\n  {\n    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",\n    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",\n    beforePin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n    currentPin: {\n      bytes: 27454,\n      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",\n      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",\n    },\n  },\n] as const;\nconst policySourceEpochContracts = [\n  {\n    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",\n    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",\n    beforePin: {\n      bytes: 599721,\n      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",\n      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",\n    },\n    currentPin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n  },\n  {\n    commit: "1156d385765f06d675bc6f6c25caa138501fef58",\n    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",\n    beforePin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n    currentPin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n  },\n  {\n    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",\n    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",\n    beforePin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n    currentPin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n  },\n  {\n    commit: "534620a636c63c257bc5afb8d543d0306b26928c",\n    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",\n    beforePin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n    currentPin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n  },\n  {\n    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",\n    parent: "26091eabd4561e5be154741e7e18143070d3ce59",\n    beforePin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n    currentPin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n  },\n  {\n    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",\n    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",\n    beforePin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n    currentPin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n  },\n  {\n    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",\n    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",\n    beforePin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n    currentPin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n  },\n  {\n    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",\n    beforePin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n    currentPin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n  },\n  {\n    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",\n    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    beforePin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n    currentPin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n  },\n  {\n    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",\n    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",\n    beforePin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n    currentPin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n  },\n  {\n    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",\n    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",\n    beforePin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n    currentPin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n  },\n  {\n    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",\n    parent: "e610189829ad1554b813d6ca224515666b0e2d28",\n    beforePin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n    currentPin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n  },\n  {\n    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",\n    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",\n    beforePin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n    currentPin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n  },\n  {\n    commit: "b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771",\n    parent: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",\n    beforePin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n    currentPin: {\n      bytes: 607104,\n      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",\n      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",\n    },\n  },\n] as const;\nconst prerequisitePolicyTopLevelKeys = [\n  "schema",\n  "description",\n  "sourceRoot",\n  "tsconfig",\n  "requireGitProvenance",\n  "externalAssets",\n  "frontendWrapper",\n  "moduleExtensions",\n  "layers",\n  "allowedEdges",\n  "externalPackages",\n  "activationHistory",\n  "nonModules",\n  "moves",\n  "evidence",\n  "files",\n] as const;\nconst prerequisitePolicySemanticRules = [\n  {\n    beforeFileCount: 1874,\n    currentFileCount: 1876,\n    additions: [\n      {\n        index: 122,\n        row: {\n          path: "src/checker/js-collection-inference.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "frontend-ts",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure.",\n        },\n        previousPath: "src/checker/inhouse-oracle.ts",\n        nextPath: "src/checker/language-service.ts",\n      },\n      {\n        index: 905,\n        row: {\n          path: "src/codegen/object-model/global-var-binding-exotic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",\n        nextPath: "src/codegen/object-model/proxy-trap-read.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1876,\n    currentFileCount: 1879,\n    additions: [\n      {\n        index: 576,\n        row: {\n          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/fnctor-ctor-param-types.ts",\n        nextPath: "src/codegen/fnctor-escape-gate.ts",\n      },\n      {\n        index: 976,\n        row: {\n          path: "src/codegen/expressions/spread-elem-extern.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/spread-arg-list.ts",\n        nextPath: "src/codegen/stack-balance.ts",\n      },\n      {\n        index: 978,\n        row: {\n          path: "src/codegen/expressions/standalone-any-length.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/stack-balance.ts",\n        nextPath: "src/codegen/standalone-class-instance-proto.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1879,\n    currentFileCount: 1881,\n    additions: [\n      {\n        index: 343,\n        row: {\n          path: "src/codegen/closures/closure-binding-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/capture-source-slot.ts",\n        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",\n      },\n      {\n        index: 1059,\n        row: {\n          path: "src/codegen/object-model/struct-field-name-tags.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/struct-hierarchy-layout.ts",\n        nextPath: "src/codegen/object-model/struct-optional-widen.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1881,\n    currentFileCount: 1882,\n    additions: [\n      {\n        index: 331,\n        row: {\n          path: "src/codegen/object-model/generator-function-proto-arm.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",\n        },\n        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",\n        nextPath: "src/codegen/closed-struct-extern-set.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1882,\n    currentFileCount: 1883,\n    additions: [\n      {\n        index: 1494,\n        row: {\n          path: "src/runtime/native-regime-view.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-function-source.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1883,\n    currentFileCount: 1884,\n    additions: [\n      {\n        index: 1113,\n        row: {\n          path: "src/codegen/array/vec-receiver-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/array/vec-elem-fidelity.ts",\n        nextPath: "src/codegen/vec-externref-hole-presence.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1884,\n    currentFileCount: 1885,\n    additions: [\n      {\n        index: 1335,\n        row: {\n          path: "src/ir/lowering/string-operations.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "compiler",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",\n        },\n        previousPath: "src/ir/lower-generic.ts",\n        nextPath: "src/ir/lower.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1885,\n    currentFileCount: 1886,\n    additions: [\n      {\n        index: 911,\n        row: {\n          path: "src/codegen/closures/function-intrinsic-construct.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/promoted-capture-value.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1886,\n    currentFileCount: 1887,\n    additions: [\n      {\n        index: 1498,\n        row: {\n          path: "src/runtime/process-capability.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-regime-view.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1887,\n    currentFileCount: 1889,\n    additions: [\n      {\n        index: 237,\n        row: {\n          path: "src/codegen/async-frame-binding-continuity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/async-await-hoist.ts",\n        nextPath: "src/codegen/async-cps-ast.ts",\n      },\n      {\n        index: 440,\n        row: {\n          path: "src/codegen/expressions/identifier-receiver-slot.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/dynamic-proto.ts",\n        nextPath: "src/codegen/dynamic-read-narrowing.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1889,\n    currentFileCount: 1892,\n    additions: [\n      {\n        index: 914,\n        row: {\n          path: "src/codegen/expressions/primitive-newtarget-default.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",\n        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n      },\n      {\n        index: 915,\n        row: {\n          path: "src/codegen/expressions/uncalled-shim-eval.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",\n        },\n        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",\n        nextPath: "src/codegen/object-model/construct-default-proto.ts",\n      },\n      {\n        index: 916,\n        row: {\n          path: "src/codegen/object-model/construct-default-proto.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1892,\n    currentFileCount: 1898,\n    additions: [\n      {\n        index: 1865,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/contracts.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/alloc-verification.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      },\n      {\n        index: 1866,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/census.ts",\n      },\n      {\n        index: 1867,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/census.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n      },\n      {\n        index: 1868,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/metadata.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/census.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",\n      },\n      {\n        index: 1869,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/verify.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n        nextPath: "src/ir/runtime/verify.ts",\n      },\n      {\n        index: 1872,\n        row: {\n          path: "src/ir/program/allocation-body-validation.ts",\n          state: "clean",\n          layer: "ir-program",\n        },\n        previousPath: "src/ir/program/allocations.ts",\n        nextPath: "src/ir/program/class-layouts.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 6,\n        id: "ir-analysis",\n        fields: ["roots", "entries", "minModules"],\n        beforeValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          minModules: 14,\n        },\n        currentValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/allocation-evidence",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n            "src/ir/analysis/allocation-evidence/contracts.ts",\n            "src/ir/analysis/allocation-evidence/effect-rules.ts",\n            "src/ir/analysis/allocation-evidence/census.ts",\n            "src/ir/analysis/allocation-evidence/metadata.ts",\n            "src/ir/analysis/allocation-evidence/verify.ts",\n          ],\n          minModules: 19,\n        },\n      },\n      {\n        index: 9,\n        id: "ir-program",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n          ],\n          minModules: 48,\n        },\n        currentValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n            "src/ir/program/allocation-body-validation.ts",\n          ],\n          minModules: 49,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1898,\n    currentFileCount: 1899,\n    additions: [\n      {\n        index: 1532,\n        row: {\n          path: "src/shared/contracts/linear-memory-layout.ts",\n          state: "clean",\n          layer: "foundation",\n        },\n        previousPath: "src/shared/contracts/identity-values.ts",\n        nextPath: "src/shared/contracts/ir-identity.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 0,\n        id: "foundation",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n          ],\n          minModules: 9,\n        },\n        currentValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n            "src/shared/contracts/linear-memory-layout.ts",\n          ],\n          minModules: 10,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1899,\n    currentFileCount: 1900,\n    additions: [\n      {\n        index: 155,\n        row: {\n          path: "src/codegen-linear/runtime/string-slice.ts",\n          state: "unmigrated",\n          layer: "legacy-linear",\n        },\n        previousPath: "src/codegen-linear/runtime.ts",\n        nextPath: "src/codegen-linear/simd.ts",\n      },\n    ],\n    layers: [],\n  },\n] as const;\n\ntype PrerequisiteSectionName = "cabiSource" | "policySource";\nfunction validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {\n  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);\n  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;\n  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";\n  if (\n    source.path !== path ||\n    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||\n    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)\n  )\n    fail(name + " fixed source domain");\n  const epochs = array(source.epochs, name + " epochs");\n  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");\n  for (const [index, value] of epochs.entries()) {\n    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");\n    const contract = contracts[index]!;\n    if (\n      epoch.commit !== contract.commit ||\n      epoch.parent !== contract.parent ||\n      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||\n      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||\n      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))\n    )\n      fail(name + " fixed epoch identity/pins");\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(epoch[direction], name + " " + direction);\n      if (!spans.length) fail(name + " missing " + direction);\n      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");\n    }\n  }\n  return source;\n}\nfunction prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {\n  const before = keys(\n    parseJson(beforeRaw, stage + " before"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " before policy",\n  );\n  const current = keys(\n    parseJson(currentRaw, stage + " current"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " current policy",\n  );\n  const rule = prerequisitePolicySemanticRules[index]!;\n  const beforeFiles = array(before.files, stage + " before files"),\n    currentFiles = array(current.files, stage + " current files");\n  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)\n    fail(stage + " semantic file counts");\n  const removed = new Set<number>();\n  for (const addition of rule.additions) {\n    const at: number = addition.index;\n    const row = currentFiles[at];\n    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;\n    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;\n    if (\n      removed.has(addition.index) ||\n      !same(row, addition.row) ||\n      previous !== addition.previousPath ||\n      next !== addition.nextPath\n    )\n      fail(stage + " semantic ordered row/neighbors");\n    removed.add(addition.index);\n  }\n  if (\n    !same(\n      currentFiles.filter((_, at) => !removed.has(at)),\n      beforeFiles,\n    )\n  )\n    fail(stage + " semantic retained file rows");\n  const beforeLayers = array(before.layers, stage + " before layers"),\n    currentLayers = array(current.layers, stage + " current layers");\n  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");\n  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];\n  for (const change of rule.layers) {\n    const old = beforeLayers[change.index] as Data,\n      actual = currentLayers[change.index] as Data;\n    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))\n      fail(stage + " semantic layer identity/keys");\n    for (const field of change.fields) {\n      if (\n        !same(old[field], (change.beforeValues as Data)[field]) ||\n        !same(actual[field], (change.currentValues as Data)[field])\n      )\n        fail(stage + " semantic changed layer field: " + change.id + "/" + field);\n      replayLayers[change.index]![field] = actual[field];\n    }\n  }\n  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");\n  const replay = { ...before, files: currentFiles, layers: replayLayers };\n  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");\n}\nfunction prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {\n  const receipt = captureGeometrySuccessor(reader);\n  const source = validatePrerequisiteSection(receipt[name], name);\n  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");\n  const physical = readText(reader, source.path as string);\n  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");\n  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");\n  const epochs = array(source.epochs, name + " epochs") as Data[];\n  let before = rawCurrent;\n  const authenticatedCurrents: string[] = [];\n  for (let index = epochs.length - 1; index >= 0; index--) {\n    const epoch = epochs[index]!;\n    const stage = name + " inverse epoch " + (index + 1);\n    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");\n    authenticatedCurrents[index] = before;\n    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);\n    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);\n    before = predecessor;\n  }\n  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");\n  let replay = before;\n  for (const [index, epoch] of epochs.entries()) {\n    const stage = name + " forward epoch " + (index + 1);\n    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");\n    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);\n    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");\n    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);\n    replay = current;\n  }\n  if (replay !== rawCurrent) fail(name + " independent complete source equality");\n  return before;\n}\n/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */\nexport function captureC1LinearCabiPredecessor(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");\n  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");\n}\n/** Fourteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\nexport function captureGeometryCurrentMainPredecessorPolicySource(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");\n  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");\n}\n',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 238,
      outputOffset: 238,
      from: "",
      to: 'import * as c1AuthorityRoot from "./ir-c1-authority-root.js";\n',
    },
    {
      inputOffset: 34212,
      outputOffset: 34274,
      from: '  if (anchor !== canonicalAnchor) fail("warm anchor source changed");\n',
      to: '  const geometryDigest = geometryAnchorDigest(false);\n  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))\n    fail("warm anchor source changed");\n',
    },
    {
      inputOffset: 36329,
      outputOffset: 36516,
      from: "  const contract = validateLinearOptions(manifest.linearOptions);\n",
      to: "  let contract = validateLinearOptions(manifest.linearOptions);\n",
    },
    {
      inputOffset: 36643,
      outputOffset: 36828,
      from: "  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);\n",
      to: '  const instrumentTexts = new Map<string, string>();\n  let successor: Data | undefined;\n  for (const record of instruments) {\n    const text = readText(readAuthority, record.path);\n    instrumentTexts.set(record.path, text);\n    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);\n    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {\n      successor ??= captureGeometrySuccessor(readAuthority);\n      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);\n    } else requirePin(text, record.pin, record.path);\n  }\n  if (successor) {\n    // Never combine an old supplied instrument with another instrument\'s successor epoch.\n    for (const value of array(successor.instruments, "geometry instruments")) {\n      const record = value as Data;\n      requirePin(\n        instrumentTexts.get(record.path as string)!,\n        validatePin(record.currentPin, "geometry current pin"),\n        "complete geometry instrument epoch",\n      );\n    }\n    contract = geometryLinearOptions(contract, successor.linearOptions);\n  }\n',
    },
    {
      inputOffset: 40026,
      outputOffset: 41211,
      from: "function validateResolverTopology(resolver: Data): void {\n",
      to: "function validateResolverTopology(resolver: Data, currentGeometry = false): void {\n  const expectedRequests = currentGeometry\n    ? [...fixedResolverRequests, ...geometryResolverRequests]\n    : fixedResolverRequests;\n",
    },
    {
      inputOffset: 40385,
      outputOffset: 41729,
      from: '  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");\n',
      to: '  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");\n',
    },
    {
      inputOffset: 41078,
      outputOffset: 42417,
      from: "  for (const request of fixedResolverRequests) {\n",
      to: "  for (const request of expectedRequests) {\n",
    },
    {
      inputOffset: 44161,
      outputOffset: 45495,
      from: "",
      to: '\n// One finite geometry successor. ROOT owns the receipt and independent anchor activation.\nconst geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";\nconst geometryCallerContracts = [\n  {\n    path: "tests/issue-3518-program-data-contract-boundary.test.ts",\n    beforePin: {\n      bytes: 33595,\n      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",\n      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",\n    },\n    currentPin: {\n      bytes: 33840,\n      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",\n      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",\n    },\n  },\n  {\n    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 28811,\n      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",\n      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",\n    },\n    currentPin: {\n      bytes: 29161,\n      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",\n      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",\n    },\n  },\n  {\n    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 29570,\n      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",\n      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",\n    },\n    currentPin: {\n      bytes: 29764,\n      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",\n      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",\n    },\n  },\n  {\n    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",\n    beforePin: {\n      bytes: 112437,\n      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",\n      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",\n    },\n    currentPin: {\n      bytes: 116007,\n      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",\n      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",\n    },\n  },\n] as const;\nconst geometryInstrumentPins: readonly C1PathPin[] = [\n  {\n    path: "tests/helpers/ir-c1-historical-authority.ts",\n    pin: {\n      bytes: 44161,\n      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",\n      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",\n    },\n  },\n  {\n    path: "tests/helpers/ir-c1-current-source.ts",\n    pin: {\n      bytes: 42599,\n      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",\n      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",\n    },\n  },\n  {\n    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    pin: {\n      bytes: 409599,\n      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",\n      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",\n    },\n  },\n  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),\n];\nconst geometryClosurePins: readonly C1PathPin[] = [\n  {\n    path: "src/ir/analysis/linear-memory-plan.ts",\n    pin: {\n      bytes: 45359,\n      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",\n      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",\n    },\n  },\n  {\n    path: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 3161,\n      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",\n      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",\n    },\n  },\n  {\n    path: "src/shared/contracts/linear-memory-layout.ts",\n    pin: {\n      bytes: 7580,\n      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",\n      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",\n    },\n  },\n];\nconst geometryResolverRequests: readonly C1ResolverRequest[] = [\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/linear-memory-plan.ts",\n    module: "./contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },\n  },\n  {\n    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",\n    module: "../../../shared/contracts/linear-memory-layout.js",\n    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },\n  },\n];\nfunction geometryAnchorDigest(required: boolean): string | undefined {\n  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");\n  if (descriptor === undefined) {\n    if (required) fail("geometry instrument authority not activated");\n    return undefined;\n  }\n  if (\n    !Object.hasOwn(descriptor, "value") ||\n    typeof descriptor.value !== "string" ||\n    !/^[a-f0-9]{64}$/.test(descriptor.value)\n  )\n    fail("geometry instrument anchor data digest required");\n  return descriptor.value;\n}\nfunction geometryAnchorLine(digest: string | undefined): string {\n  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\\n`;\n}\nfunction captureGeometrySuccessor(readAuthority: AuthorityReader): Data {\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const digest = geometryAnchorDigest(true);\n  const anchor = readText(readAuthority, anchorPath);\n  const canonical =\n    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\n" +\n    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\\n` +\n    geometryAnchorLine(digest);\n  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");\n  const raw = readText(readAuthority, geometrySuccessorPath);\n  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");\n  const receipt = keys(\n    parseJson(raw, geometrySuccessorPath),\n    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],\n    "geometry instrument receipt",\n  );\n  if (\n    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||\n    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256\n  )\n    fail("geometry instrument receipt domain");\n  const instruments = array(receipt.instruments, "geometry instruments");\n  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");\n  instruments.forEach((value, index) => {\n    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");\n    if (\n      record.path !== geometryInstrumentPins[index]!.path ||\n      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)\n    )\n      fail("geometry instrument predecessor domain");\n    const currentPin = validatePin(record.currentPin, "geometry current pin");\n    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);\n    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(record[direction], "geometry " + direction);\n      if (!spans.length) fail("geometry instrument missing " + direction);\n      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));\n    }\n  });\n  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");\n  validatePrerequisiteSection(receipt.policySource, "policySource");\n  return receipt;\n}\nfunction geometryInstrumentReplay(\n  source: string,\n  spans: unknown,\n  target: C1Pin,\n  stage = "geometry instrument",\n): string {\n  const bytes = Buffer.from(source, "utf8");\n  const pieces: Buffer[] = [];\n  let inputEnd = 0,\n    outputEnd = 0,\n    previousInput = -1,\n    previousOutput = -1;\n  for (const value of array(spans, "geometry replay spans")) {\n    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");\n    if (\n      !Number.isSafeInteger(span.inputOffset) ||\n      !Number.isSafeInteger(span.outputOffset) ||\n      typeof span.from !== "string" ||\n      typeof span.to !== "string"\n    )\n      fail(stage + " span data");\n    const inputOffset = span.inputOffset as number,\n      outputOffset = span.outputOffset as number;\n    const from = Buffer.from(span.from),\n      to = Buffer.from(span.to);\n    if (\n      inputOffset < inputEnd ||\n      outputOffset < outputEnd ||\n      inputOffset <= previousInput ||\n      outputOffset <= previousOutput ||\n      inputOffset - inputEnd !== outputOffset - outputEnd ||\n      inputOffset + from.length > bytes.length ||\n      outputOffset + to.length > target.bytes ||\n      from.toString("utf8") !== span.from ||\n      to.toString("utf8") !== span.to ||\n      span.from === span.to ||\n      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)\n    )\n      fail(stage + " span membership/coordinates");\n    pieces.push(bytes.subarray(inputEnd, inputOffset), to);\n    previousInput = inputOffset;\n    previousOutput = outputOffset;\n    inputEnd = inputOffset + from.length;\n    outputEnd = outputOffset + to.length;\n  }\n  pieces.push(bytes.subarray(inputEnd));\n  const output = Buffer.concat(pieces).toString("utf8");\n  requirePin(output, target, stage + " replay");\n  return output;\n}\nfunction geometryInstrumentBefore(path: string, source: string, receipt: Data): string {\n  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as\n    | Data\n    | undefined;\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");\n  const before = geometryInstrumentReplay(\n    source,\n    record.inverse,\n    validatePin(record.beforePin, path),\n    "geometry instrument inverse: " + path,\n  );\n  const replay = geometryInstrumentReplay(\n    before,\n    record.forward,\n    validatePin(record.currentPin, path),\n    "geometry instrument forward: " + path,\n  );\n  if (replay !== source) fail("geometry independent instrument forward equality: " + path);\n  return before;\n}\n/** Exactly seven published instruments; primitive/path/reader checks precede IO. */\nexport function c1GeometryInstrumentPredecessor(\n  path: string,\n  source: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof path !== "string" || typeof source !== "string")\n    fail("geometry instrument primitive path/source required");\n  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");\n  const record = geometryInstrumentPins.find((entry) => entry.path === path);\n  if (!record) fail("geometry instrument path outside fixed domain: " + path);\n  // Exact original supplied inputs retain their pre-existing authority path.\n  if (same(measured(source), record.pin)) return source;\n  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));\n}\nfunction geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {\n  const contract = keys(\n    value,\n    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],\n    "geometry linear options",\n  );\n  const expectedClosure = [\n    ...before.closureInputs.map((entry) =>\n      entry.path === geometryClosurePins[0]!.path\n        ? geometryClosurePins[0]!\n        : entry.path === "src/codegen-linear/c-abi.ts"\n          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }\n          : entry,\n    ),\n    ...geometryClosurePins.slice(1),\n  ];\n  if (\n    contract.sourcePath !== before.sourcePath ||\n    !same(contract.declaration, before.declaration) ||\n    !same(contract.bindings, before.bindings) ||\n    !same(contract.closureInputs, expectedClosure)\n  )\n    fail("geometry-only closure successor");\n  const resolver = keys(\n    contract.resolver,\n    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],\n    "geometry resolver",\n  );\n  if (\n    !same(resolver.configInputs, before.resolver.configInputs) ||\n    resolver.optionsSource !== before.resolver.optionsSource ||\n    resolver.optionsSha256 !== before.resolver.optionsSha256\n  )\n    fail("geometry resolver configuration changed");\n  validateResolverTopology(resolver, true);\n  const observations = array(resolver.observations, "geometry observations");\n  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))\n    fail("unrelated geometry resolver transcript drift");\n  return contract as unknown as C1LinearOptionsContract;\n}\n\n// Fixed Git identities and full pins independently checked against the adopted Astra amendment.\nconst cabiSourceEpochContracts = [\n  {\n    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",\n    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",\n    beforePin: {\n      bytes: 26965,\n      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",\n      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",\n    },\n    currentPin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n  },\n  {\n    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",\n    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",\n    beforePin: {\n      bytes: 27414,\n      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",\n      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",\n    },\n    currentPin: {\n      bytes: 27454,\n      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",\n      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",\n    },\n  },\n] as const;\nconst policySourceEpochContracts = [\n  {\n    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",\n    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",\n    beforePin: {\n      bytes: 599721,\n      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",\n      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",\n    },\n    currentPin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n  },\n  {\n    commit: "1156d385765f06d675bc6f6c25caa138501fef58",\n    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",\n    beforePin: {\n      bytes: 600520,\n      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",\n      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",\n    },\n    currentPin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n  },\n  {\n    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",\n    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",\n    beforePin: {\n      bytes: 601510,\n      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",\n      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",\n    },\n    currentPin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n  },\n  {\n    commit: "534620a636c63c257bc5afb8d543d0306b26928c",\n    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",\n    beforePin: {\n      bytes: 602174,\n      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",\n      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",\n    },\n    currentPin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n  },\n  {\n    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",\n    parent: "26091eabd4561e5be154741e7e18143070d3ce59",\n    beforePin: {\n      bytes: 602572,\n      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",\n      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",\n    },\n    currentPin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n  },\n  {\n    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",\n    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",\n    beforePin: {\n      bytes: 602694,\n      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",\n      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",\n    },\n    currentPin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n  },\n  {\n    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",\n    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",\n    beforePin: {\n      bytes: 603019,\n      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",\n      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",\n    },\n    currentPin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n  },\n  {\n    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",\n    beforePin: {\n      bytes: 603481,\n      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",\n      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",\n    },\n    currentPin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n  },\n  {\n    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",\n    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",\n    beforePin: {\n      bytes: 603831,\n      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",\n      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",\n    },\n    currentPin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n  },\n  {\n    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",\n    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",\n    beforePin: {\n      bytes: 603953,\n      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",\n      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",\n    },\n    currentPin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n  },\n  {\n    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",\n    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",\n    beforePin: {\n      bytes: 604615,\n      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",\n      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",\n    },\n    currentPin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n  },\n  {\n    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",\n    parent: "e610189829ad1554b813d6ca224515666b0e2d28",\n    beforePin: {\n      bytes: 605605,\n      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",\n      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",\n    },\n    currentPin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n  },\n  {\n    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",\n    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",\n    beforePin: {\n      bytes: 606787,\n      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",\n      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",\n    },\n    currentPin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n  },\n  {\n    commit: "b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771",\n    parent: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",\n    beforePin: {\n      bytes: 606971,\n      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",\n      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",\n    },\n    currentPin: {\n      bytes: 607104,\n      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",\n      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",\n    },\n  },\n] as const;\nconst prerequisitePolicyTopLevelKeys = [\n  "schema",\n  "description",\n  "sourceRoot",\n  "tsconfig",\n  "requireGitProvenance",\n  "externalAssets",\n  "frontendWrapper",\n  "moduleExtensions",\n  "layers",\n  "allowedEdges",\n  "externalPackages",\n  "activationHistory",\n  "nonModules",\n  "moves",\n  "evidence",\n  "files",\n] as const;\nconst prerequisitePolicySemanticRules = [\n  {\n    beforeFileCount: 1874,\n    currentFileCount: 1876,\n    additions: [\n      {\n        index: 122,\n        row: {\n          path: "src/checker/js-collection-inference.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "frontend-ts",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure.",\n        },\n        previousPath: "src/checker/inhouse-oracle.ts",\n        nextPath: "src/checker/language-service.ts",\n      },\n      {\n        index: 905,\n        row: {\n          path: "src/codegen/object-model/global-var-binding-exotic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",\n        nextPath: "src/codegen/object-model/proxy-trap-read.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1876,\n    currentFileCount: 1879,\n    additions: [\n      {\n        index: 576,\n        row: {\n          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/fnctor-ctor-param-types.ts",\n        nextPath: "src/codegen/fnctor-escape-gate.ts",\n      },\n      {\n        index: 976,\n        row: {\n          path: "src/codegen/expressions/spread-elem-extern.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/spread-arg-list.ts",\n        nextPath: "src/codegen/stack-balance.ts",\n      },\n      {\n        index: 978,\n        row: {\n          path: "src/codegen/expressions/standalone-any-length.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/stack-balance.ts",\n        nextPath: "src/codegen/standalone-class-instance-proto.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1879,\n    currentFileCount: 1881,\n    additions: [\n      {\n        index: 343,\n        row: {\n          path: "src/codegen/closures/closure-binding-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/capture-source-slot.ts",\n        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",\n      },\n      {\n        index: 1059,\n        row: {\n          path: "src/codegen/object-model/struct-field-name-tags.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/struct-hierarchy-layout.ts",\n        nextPath: "src/codegen/object-model/struct-optional-widen.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1881,\n    currentFileCount: 1882,\n    additions: [\n      {\n        index: 331,\n        row: {\n          path: "src/codegen/object-model/generator-function-proto-arm.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",\n        },\n        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",\n        nextPath: "src/codegen/closed-struct-extern-set.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1882,\n    currentFileCount: 1883,\n    additions: [\n      {\n        index: 1494,\n        row: {\n          path: "src/runtime/native-regime-view.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-function-source.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1883,\n    currentFileCount: 1884,\n    additions: [\n      {\n        index: 1113,\n        row: {\n          path: "src/codegen/array/vec-receiver-identity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/array/vec-elem-fidelity.ts",\n        nextPath: "src/codegen/vec-externref-hole-presence.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1884,\n    currentFileCount: 1885,\n    additions: [\n      {\n        index: 1335,\n        row: {\n          path: "src/ir/lowering/string-operations.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "compiler",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",\n        },\n        previousPath: "src/ir/lower-generic.ts",\n        nextPath: "src/ir/lower.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1885,\n    currentFileCount: 1886,\n    additions: [\n      {\n        index: 911,\n        row: {\n          path: "src/codegen/closures/function-intrinsic-construct.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/promoted-capture-value.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1886,\n    currentFileCount: 1887,\n    additions: [\n      {\n        index: 1498,\n        row: {\n          path: "src/runtime/process-capability.ts",\n          state: "unmigrated",\n          layer: "legacy-host",\n        },\n        previousPath: "src/runtime/native-regime-view.ts",\n        nextPath: "src/runtime/object-create-class-instance.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1887,\n    currentFileCount: 1889,\n    additions: [\n      {\n        index: 237,\n        row: {\n          path: "src/codegen/async-frame-binding-continuity.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/async-await-hoist.ts",\n        nextPath: "src/codegen/async-cps-ast.ts",\n      },\n      {\n        index: 440,\n        row: {\n          path: "src/codegen/expressions/identifier-receiver-slot.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/dynamic-proto.ts",\n        nextPath: "src/codegen/dynamic-read-narrowing.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1889,\n    currentFileCount: 1892,\n    additions: [\n      {\n        index: 914,\n        row: {\n          path: "src/codegen/expressions/primitive-newtarget-default.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",\n        },\n        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",\n        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n      },\n      {\n        index: 915,\n        row: {\n          path: "src/codegen/expressions/uncalled-shim-eval.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",\n        },\n        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",\n        nextPath: "src/codegen/object-model/construct-default-proto.ts",\n      },\n      {\n        index: 916,\n        row: {\n          path: "src/codegen/object-model/construct-default-proto.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",\n        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",\n      },\n    ],\n    layers: [],\n  },\n  {\n    beforeFileCount: 1892,\n    currentFileCount: 1898,\n    additions: [\n      {\n        index: 1865,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/contracts.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/alloc-verification.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      },\n      {\n        index: 1866,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/census.ts",\n      },\n      {\n        index: 1867,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/census.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n      },\n      {\n        index: 1868,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/metadata.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/census.ts",\n        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",\n      },\n      {\n        index: 1869,\n        row: {\n          path: "src/ir/analysis/allocation-evidence/verify.ts",\n          state: "clean",\n          layer: "ir-analysis",\n        },\n        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",\n        nextPath: "src/ir/runtime/verify.ts",\n      },\n      {\n        index: 1872,\n        row: {\n          path: "src/ir/program/allocation-body-validation.ts",\n          state: "clean",\n          layer: "ir-program",\n        },\n        previousPath: "src/ir/program/allocations.ts",\n        nextPath: "src/ir/program/class-layouts.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 6,\n        id: "ir-analysis",\n        fields: ["roots", "entries", "minModules"],\n        beforeValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          minModules: 14,\n        },\n        currentValues: {\n          roots: [\n            "src/ir/analysis/contracts",\n            "src/ir/analysis/allocation-evidence",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/backend-legality.ts",\n          ],\n          entries: [\n            "src/ir/analysis/contracts/allocations.ts",\n            "src/ir/analysis/alloc-registry.ts",\n            "src/ir/analysis/effects.ts",\n            "src/ir/analysis/intrinsics.ts",\n            "src/ir/analysis/async-plan.ts",\n            "src/ir/analysis/lattice.ts",\n            "src/ir/analysis/ownership.ts",\n            "src/ir/analysis/encoding.ts",\n            "src/ir/analysis/escape.ts",\n            "src/ir/analysis/dominance.ts",\n            "src/ir/analysis/alloc-verification.ts",\n            "src/ir/analysis/nested-stackification.ts",\n            "src/ir/analysis/contracts/linear-memory-layout.ts",\n            "src/ir/analysis/backend-legality.ts",\n            "src/ir/analysis/allocation-evidence/contracts.ts",\n            "src/ir/analysis/allocation-evidence/effect-rules.ts",\n            "src/ir/analysis/allocation-evidence/census.ts",\n            "src/ir/analysis/allocation-evidence/metadata.ts",\n            "src/ir/analysis/allocation-evidence/verify.ts",\n          ],\n          minModules: 19,\n        },\n      },\n      {\n        index: 9,\n        id: "ir-program",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n          ],\n          minModules: 48,\n        },\n        currentValues: {\n          entries: [\n            "src/ir/program/abi-inventory.ts",\n            "src/ir/program/abi.ts",\n            "src/ir/program/startup.ts",\n            "src/ir/program/abi-lookup.ts",\n            "src/ir/program/callable-bindings.ts",\n            "src/ir/program/controls.ts",\n            "src/ir/program/index.ts",\n            "src/ir/program/input-contracts.ts",\n            "src/ir/program/prepared-contracts.ts",\n            "src/ir/program/errors.ts",\n            "src/ir/program/data.ts",\n            "src/ir/program/input.ts",\n            "src/ir/program/native-vector-resources.ts",\n            "src/ir/program/native-promise-resources.ts",\n            "src/ir/program/native-value-resources.ts",\n            "src/ir/program/native-string-value-demands.ts",\n            "src/ir/program/runtime-support.ts",\n            "src/ir/program/formatter-support.ts",\n            "src/ir/program/native-number-format-requirements.ts",\n            "src/ir/program/async-frame-setup.ts",\n            "src/ir/program/prepared-async-frame-plan.ts",\n            "src/ir/program/abi-signatures.ts",\n            "src/ir/program/host-async-dynamic.ts",\n            "src/ir/program/host-import-plan.ts",\n            "src/ir/program/host-number-boundary-setup.ts",\n            "src/ir/program/runtime-abi-identity.ts",\n            "src/ir/program/native-string-output-requirements.ts",\n            "src/ir/program/callable-results.ts",\n            "src/ir/program/native-source-closure-requirements.ts",\n            "src/ir/program/population.ts",\n            "src/ir/program/native-ref-cell-requirements.ts",\n            "src/ir/program/native-invocation-requirements.ts",\n            "src/ir/program/native-object-access-requirements.ts",\n            "src/ir/program/native-getter-invocation-requirements.ts",\n            "src/ir/program/native-object-result-requirements.ts",\n            "src/ir/program/native-object-result-values.ts",\n            "src/ir/program/native-prototype-requirements.ts",\n            "src/ir/program/native-realm-requirements.ts",\n            "src/ir/program/allocations.ts",\n            "src/ir/program/class-layouts.ts",\n            "src/ir/program/owner.ts",\n            "src/ir/program/draft-abi-lookup.ts",\n            "src/ir/program/runtime-support-dependencies.ts",\n            "src/ir/program/runtime-demands.ts",\n            "src/ir/program/runtime-abi.ts",\n            "src/ir/program/runtime-manifest.ts",\n            "src/ir/program/runtime-validation.ts",\n            "src/ir/program/validation.ts",\n            "src/ir/program/allocation-body-validation.ts",\n          ],\n          minModules: 49,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1898,\n    currentFileCount: 1899,\n    additions: [\n      {\n        index: 1532,\n        row: {\n          path: "src/shared/contracts/linear-memory-layout.ts",\n          state: "clean",\n          layer: "foundation",\n        },\n        previousPath: "src/shared/contracts/identity-values.ts",\n        nextPath: "src/shared/contracts/ir-identity.ts",\n      },\n    ],\n    layers: [\n      {\n        index: 0,\n        id: "foundation",\n        fields: ["entries", "minModules"],\n        beforeValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n          ],\n          minModules: 9,\n        },\n        currentValues: {\n          entries: [\n            "src/shared/contracts/source-origin.ts",\n            "src/shared/contracts/ir-identity.ts",\n            "src/shared/contracts/identity-values.ts",\n            "src/shared/contracts/ir-counted-string-identity.ts",\n            "src/shared/contracts/ir-preparation-failure.ts",\n            "src/shared/contracts/ir-unit-inventory.ts",\n            "src/shared/contracts/ir-preparation-errors.ts",\n            "src/shared/contracts/ir-counted-string-site-id.ts",\n            "src/shared/contracts/string-surrogate.ts",\n            "src/shared/contracts/linear-memory-layout.ts",\n          ],\n          minModules: 10,\n        },\n      },\n    ],\n  },\n  {\n    beforeFileCount: 1899,\n    currentFileCount: 1900,\n    additions: [\n      {\n        index: 155,\n        row: {\n          path: "src/codegen-linear/runtime/string-slice.ts",\n          state: "unmigrated",\n          layer: "legacy-linear",\n        },\n        previousPath: "src/codegen-linear/runtime.ts",\n        nextPath: "src/codegen-linear/simd.ts",\n      },\n    ],\n    layers: [],\n  },\n] as const;\n\ntype PrerequisiteSectionName = "cabiSource" | "policySource";\nfunction validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {\n  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);\n  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;\n  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";\n  if (\n    source.path !== path ||\n    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||\n    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)\n  )\n    fail(name + " fixed source domain");\n  const epochs = array(source.epochs, name + " epochs");\n  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");\n  for (const [index, value] of epochs.entries()) {\n    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");\n    const contract = contracts[index]!;\n    if (\n      epoch.commit !== contract.commit ||\n      epoch.parent !== contract.parent ||\n      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||\n      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||\n      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))\n    )\n      fail(name + " fixed epoch identity/pins");\n    for (const direction of ["inverse", "forward"] as const) {\n      const spans = array(epoch[direction], name + " " + direction);\n      if (!spans.length) fail(name + " missing " + direction);\n      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");\n    }\n  }\n  return source;\n}\nfunction prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {\n  const before = keys(\n    parseJson(beforeRaw, stage + " before"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " before policy",\n  );\n  const current = keys(\n    parseJson(currentRaw, stage + " current"),\n    [...prerequisitePolicyTopLevelKeys],\n    stage + " current policy",\n  );\n  const rule = prerequisitePolicySemanticRules[index]!;\n  const beforeFiles = array(before.files, stage + " before files"),\n    currentFiles = array(current.files, stage + " current files");\n  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)\n    fail(stage + " semantic file counts");\n  const removed = new Set<number>();\n  for (const addition of rule.additions) {\n    const at: number = addition.index;\n    const row = currentFiles[at];\n    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;\n    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;\n    if (\n      removed.has(addition.index) ||\n      !same(row, addition.row) ||\n      previous !== addition.previousPath ||\n      next !== addition.nextPath\n    )\n      fail(stage + " semantic ordered row/neighbors");\n    removed.add(addition.index);\n  }\n  if (\n    !same(\n      currentFiles.filter((_, at) => !removed.has(at)),\n      beforeFiles,\n    )\n  )\n    fail(stage + " semantic retained file rows");\n  const beforeLayers = array(before.layers, stage + " before layers"),\n    currentLayers = array(current.layers, stage + " current layers");\n  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");\n  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];\n  for (const change of rule.layers) {\n    const old = beforeLayers[change.index] as Data,\n      actual = currentLayers[change.index] as Data;\n    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))\n      fail(stage + " semantic layer identity/keys");\n    for (const field of change.fields) {\n      if (\n        !same(old[field], (change.beforeValues as Data)[field]) ||\n        !same(actual[field], (change.currentValues as Data)[field])\n      )\n        fail(stage + " semantic changed layer field: " + change.id + "/" + field);\n      replayLayers[change.index]![field] = actual[field];\n    }\n  }\n  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");\n  const replay = { ...before, files: currentFiles, layers: replayLayers };\n  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");\n}\nfunction prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {\n  const receipt = captureGeometrySuccessor(reader);\n  const source = validatePrerequisiteSection(receipt[name], name);\n  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");\n  const physical = readText(reader, source.path as string);\n  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");\n  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");\n  const epochs = array(source.epochs, name + " epochs") as Data[];\n  let before = rawCurrent;\n  const authenticatedCurrents: string[] = [];\n  for (let index = epochs.length - 1; index >= 0; index--) {\n    const epoch = epochs[index]!;\n    const stage = name + " inverse epoch " + (index + 1);\n    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");\n    authenticatedCurrents[index] = before;\n    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);\n    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);\n    before = predecessor;\n  }\n  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");\n  let replay = before;\n  for (const [index, epoch] of epochs.entries()) {\n    const stage = name + " forward epoch " + (index + 1);\n    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");\n    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);\n    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");\n    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);\n    replay = current;\n  }\n  if (replay !== rawCurrent) fail(name + " independent complete source equality");\n  return before;\n}\n/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */\nexport function captureC1LinearCabiPredecessor(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");\n  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");\n}\n/** Fourteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\nexport function captureGeometryCurrentMainPredecessorPolicySource(\n  rawCurrent: string,\n  readAuthority: AuthorityReader = readActual,\n): string {\n  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");\n  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");\n  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");\n}\n',
    },
  ],
} as const;

const independentSixteenSuccessorFreeze: string =
  '{"receiptPin":{"bytes":249677,"sha256":"0a7b29a73313302aa2600e01139baeb90db5a617f2ab5c8dd8449fa3af990ddb","gitBlob":"44be3db6a3bcdf58cc1e5eb243782dcd7c45a49f"},"anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\nexport const c1GeometrySuccessorSha256 = \\"0a7b29a73313302aa2600e01139baeb90db5a617f2ab5c8dd8449fa3af990ddb\\";\\n","anchorPin":{"bytes":303,"sha256":"34c9c8b6b95cf7c7d0f18aaad47f0a522e652f4b26c52cbaba1b69494ddecf8a","gitBlob":"d239203e8cb93aa5058e80d49cc66b686c478069"},"instruments":[{"path":"tests/helpers/ir-c1-historical-authority.ts","currentPin":{"bytes":101086,"sha256":"ac0c6d08c889b084853fd15a99a78fb0ed2f2dec76444a19e958d17212d15652","gitBlob":"d2fd28c88dda7043531753b5c077bf6dcfd3799f"}},{"path":"tests/helpers/ir-c1-current-source.ts","currentPin":{"bytes":53563,"sha256":"a766bff19e173800163e596d6f0a0adc0c2a7c7c32992dafbd30217135c4e6c1","gitBlob":"f9ec52eac7b94cc9c47287578593e4cb13a19a23"}},{"path":"tests/helpers/ir-runtime-program-policy-evolution.ts","currentPin":{"bytes":411837,"sha256":"8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c","gitBlob":"15ae96d3887a5eb61fc6404df098d58f0d96b2f4"}},{"path":"tests/issue-3518-program-data-contract-boundary.test.ts","currentPin":{"bytes":33840,"sha256":"24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469","gitBlob":"18a17efe93db58ab5f6f0322f845c92e86859d41"}},{"path":"tests/issue-3518-runtime-program-policy-evolution.test.ts","currentPin":{"bytes":29161,"sha256":"a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1","gitBlob":"43d2493da1d08c890841f03774f5e664731a82f6"}},{"path":"tests/issue-3518-well-known-symbol-policy-evolution.test.ts","currentPin":{"bytes":29764,"sha256":"fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4","gitBlob":"a009cd0ffbd2f91d971dada7abbf239c557d79d8"}},{"path":"tests/issue-3518-number-prerequisite-policy-evolution.test.ts","currentPin":{"bytes":116007,"sha256":"546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea","gitBlob":"1fb4a992f18ccad293e3030d9f0d88c40d40d78a"}}]}';
const seventeenthH1Stage = {
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 101086,
    sha256: "ac0c6d08c889b084853fd15a99a78fb0ed2f2dec76444a19e958d17212d15652",
    gitBlob: "d2fd28c88dda7043531753b5c077bf6dcfd3799f",
  },
  currentPin: {
    bytes: 102253,
    sha256: "02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a",
    gitBlob: "4ecb94bd9aa929547e6699f38fe1e61cb1216b86",
  },
  inverse: [
    {
      inputOffset: 67314,
      outputOffset: 67314,
      from: '  {\n    commit: "5d7c261f46ca5dc06d09f47da8665d3151335224",\n    parent: "6720ce5198f5252239ff4800b383de2072830d99",\n    beforePin: {\n      bytes: 608556,\n      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",\n      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",\n    },\n    currentPin: {\n      bytes: 608912,\n      sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n      gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",\n    },\n  },\n',
      to: "",
    },
    {
      inputOffset: 94100,
      outputOffset: 93606,
      from: '  {\n    beforeFileCount: 1904,\n    currentFileCount: 1905,\n    additions: [\n      {\n        index: 202,\n        row: {\n          path: "src/codegen/array/array-sort-value.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.",\n        },\n        previousPath: "src/codegen/array/array-copy-methods-value.ts",\n        nextPath: "src/codegen/array/array-fill-proto-value.ts",\n      },\n    ],\n    layers: [],\n  },\n',
      to: "",
    },
    {
      inputOffset: 101700,
      outputOffset: 100535,
      from: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
  ],
  forward: [
    {
      inputOffset: 67314,
      outputOffset: 67314,
      from: "",
      to: '  {\n    commit: "5d7c261f46ca5dc06d09f47da8665d3151335224",\n    parent: "6720ce5198f5252239ff4800b383de2072830d99",\n    beforePin: {\n      bytes: 608556,\n      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",\n      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",\n    },\n    currentPin: {\n      bytes: 608912,\n      sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n      gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",\n    },\n  },\n',
    },
    {
      inputOffset: 93606,
      outputOffset: 94100,
      from: "",
      to: '  {\n    beforeFileCount: 1904,\n    currentFileCount: 1905,\n    additions: [\n      {\n        index: 202,\n        row: {\n          path: "src/codegen/array/array-sort-value.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary:\n            "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.",\n        },\n        previousPath: "src/codegen/array/array-copy-methods-value.ts",\n        nextPath: "src/codegen/array/array-fill-proto-value.ts",\n      },\n    ],\n    layers: [],\n  },\n',
    },
    {
      inputOffset: 100535,
      outputOffset: 101700,
      from: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
  ],
} as const;
const seventeenthReceiptStage = {
  path: "tests/helpers/ir-c1-linear-layout-geometry-successor.json",
  beforePin: {
    bytes: 249677,
    sha256: "0a7b29a73313302aa2600e01139baeb90db5a617f2ab5c8dd8449fa3af990ddb",
    gitBlob: "44be3db6a3bcdf58cc1e5eb243782dcd7c45a49f",
  },
  currentPin: {
    bytes: 253824,
    sha256: "1bf3f3c1f6abdbf7e4912625d802e43705ba9184cb81038b115af16f5da5ec7b",
    gitBlob: "968528f295b8097dbbd8976f0a0ede1c04341c60",
  },
  inverse: [
    {
      inputOffset: 490,
      outputOffset: 490,
      from: '"bytes": 102253',
      to: '"bytes": 101086',
    },
    {
      inputOffset: 515,
      outputOffset: 515,
      from: '"sha256": "02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a"',
      to: '"sha256": "ac0c6d08c889b084853fd15a99a78fb0ed2f2dec76444a19e958d17212d15652"',
    },
    {
      inputOffset: 601,
      outputOffset: 601,
      from: '"gitBlob": "4ecb94bd9aa929547e6699f38fe1e61cb1216b86"',
      to: '"gitBlob": "d2fd28c88dda7043531753b5c077bf6dcfd3799f"',
    },
    {
      inputOffset: 26825,
      outputOffset: 26825,
      from: '  {\\n    commit: \\"5d7c261f46ca5dc06d09f47da8665d3151335224\\",\\n    parent: \\"6720ce5198f5252239ff4800b383de2072830d99\\",\\n    beforePin: {\\n      bytes: 608556,\\n      sha256: \\"e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e\\",\\n      gitBlob: \\"7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba\\",\\n    },\\n    currentPin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n  },\\n',
      to: "",
    },
    {
      inputOffset: 55189,
      outputOffset: 54669,
      from: '  {\\n    beforeFileCount: 1904,\\n    currentFileCount: 1905,\\n    additions: [\\n      {\\n        index: 202,\\n        row: {\\n          path: \\"src/codegen/array/array-sort-value.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary:\\n            \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\",\\n        },\\n        previousPath: \\"src/codegen/array/array-copy-methods-value.ts\\",\\n        nextPath: \\"src/codegen/array/array-fill-proto-value.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
      to: "",
    },
    {
      inputOffset: 63095,
      outputOffset: 61867,
      from: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
    {
      inputOffset: 89889,
      outputOffset: 88659,
      from: '  {\\n    commit: \\"5d7c261f46ca5dc06d09f47da8665d3151335224\\",\\n    parent: \\"6720ce5198f5252239ff4800b383de2072830d99\\",\\n    beforePin: {\\n      bytes: 608556,\\n      sha256: \\"e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e\\",\\n      gitBlob: \\"7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba\\",\\n    },\\n    currentPin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n  },\\n',
      to: "",
    },
    {
      inputOffset: 118253,
      outputOffset: 116503,
      from: '  {\\n    beforeFileCount: 1904,\\n    currentFileCount: 1905,\\n    additions: [\\n      {\\n        index: 202,\\n        row: {\\n          path: \\"src/codegen/array/array-sort-value.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary:\\n            \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\",\\n        },\\n        previousPath: \\"src/codegen/array/array-copy-methods-value.ts\\",\\n        nextPath: \\"src/codegen/array/array-fill-proto-value.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
      to: "",
    },
    {
      inputOffset: 126159,
      outputOffset: 123701,
      from: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
    {
      inputOffset: 213538,
      outputOffset: 211078,
      from: '"bytes": 608912',
      to: '"bytes": 608556',
    },
    {
      inputOffset: 213561,
      outputOffset: 211101,
      from: '"sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd"',
      to: '"sha256": "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e"',
    },
    {
      inputOffset: 213645,
      outputOffset: 211185,
      from: '"gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"',
      to: '"gitBlob": "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba"',
    },
    {
      inputOffset: 252124,
      outputOffset: 249664,
      from: ',\n      {\n        "commit": "5d7c261f46ca5dc06d09f47da8665d3151335224",\n        "parent": "6720ce5198f5252239ff4800b383de2072830d99",\n        "beforePin": {\n          "bytes": 608556,\n          "sha256": "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",\n          "gitBlob": "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba"\n        },\n        "currentPin": {\n          "bytes": 608912,\n          "sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n          "gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"\n        },\n        "inverse": [\n          {\n            "inputOffset": 112261,\n            "outputOffset": 112261,\n            "from": "sort-value.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\"\\n    },\\n    {\\n      \\"path\\": \\"src/codegen/array/array-",\n            "to": ""\n          }\n        ],\n        "forward": [\n          {\n            "inputOffset": 112261,\n            "outputOffset": 112261,\n            "from": "",\n            "to": "sort-value.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\"\\n    },\\n    {\\n      \\"path\\": \\"src/codegen/array/array-"\n          }\n        ]\n      }',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 490,
      outputOffset: 490,
      from: '"bytes": 101086',
      to: '"bytes": 102253',
    },
    {
      inputOffset: 515,
      outputOffset: 515,
      from: '"sha256": "ac0c6d08c889b084853fd15a99a78fb0ed2f2dec76444a19e958d17212d15652"',
      to: '"sha256": "02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a"',
    },
    {
      inputOffset: 601,
      outputOffset: 601,
      from: '"gitBlob": "d2fd28c88dda7043531753b5c077bf6dcfd3799f"',
      to: '"gitBlob": "4ecb94bd9aa929547e6699f38fe1e61cb1216b86"',
    },
    {
      inputOffset: 26825,
      outputOffset: 26825,
      from: "",
      to: '  {\\n    commit: \\"5d7c261f46ca5dc06d09f47da8665d3151335224\\",\\n    parent: \\"6720ce5198f5252239ff4800b383de2072830d99\\",\\n    beforePin: {\\n      bytes: 608556,\\n      sha256: \\"e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e\\",\\n      gitBlob: \\"7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba\\",\\n    },\\n    currentPin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n  },\\n',
    },
    {
      inputOffset: 54669,
      outputOffset: 55189,
      from: "",
      to: '  {\\n    beforeFileCount: 1904,\\n    currentFileCount: 1905,\\n    additions: [\\n      {\\n        index: 202,\\n        row: {\\n          path: \\"src/codegen/array/array-sort-value.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary:\\n            \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\",\\n        },\\n        previousPath: \\"src/codegen/array/array-copy-methods-value.ts\\",\\n        nextPath: \\"src/codegen/array/array-fill-proto-value.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
    },
    {
      inputOffset: 61867,
      outputOffset: 63095,
      from: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
    {
      inputOffset: 88659,
      outputOffset: 89889,
      from: "",
      to: '  {\\n    commit: \\"5d7c261f46ca5dc06d09f47da8665d3151335224\\",\\n    parent: \\"6720ce5198f5252239ff4800b383de2072830d99\\",\\n    beforePin: {\\n      bytes: 608556,\\n      sha256: \\"e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e\\",\\n      gitBlob: \\"7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba\\",\\n    },\\n    currentPin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n  },\\n',
    },
    {
      inputOffset: 116503,
      outputOffset: 118253,
      from: "",
      to: '  {\\n    beforeFileCount: 1904,\\n    currentFileCount: 1905,\\n    additions: [\\n      {\\n        index: 202,\\n        row: {\\n          path: \\"src/codegen/array/array-sort-value.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary:\\n            \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\",\\n        },\\n        previousPath: \\"src/codegen/array/array-copy-methods-value.ts\\",\\n        nextPath: \\"src/codegen/array/array-fill-proto-value.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
    },
    {
      inputOffset: 123701,
      outputOffset: 126159,
      from: "/** Sixteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
      to: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */",
    },
    {
      inputOffset: 211078,
      outputOffset: 213538,
      from: '"bytes": 608556',
      to: '"bytes": 608912',
    },
    {
      inputOffset: 211101,
      outputOffset: 213561,
      from: '"sha256": "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e"',
      to: '"sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd"',
    },
    {
      inputOffset: 211185,
      outputOffset: 213645,
      from: '"gitBlob": "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba"',
      to: '"gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"',
    },
    {
      inputOffset: 249664,
      outputOffset: 252124,
      from: "",
      to: ',\n      {\n        "commit": "5d7c261f46ca5dc06d09f47da8665d3151335224",\n        "parent": "6720ce5198f5252239ff4800b383de2072830d99",\n        "beforePin": {\n          "bytes": 608556,\n          "sha256": "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",\n          "gitBlob": "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba"\n        },\n        "currentPin": {\n          "bytes": 608912,\n          "sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n          "gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"\n        },\n        "inverse": [\n          {\n            "inputOffset": 112261,\n            "outputOffset": 112261,\n            "from": "sort-value.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\"\\n    },\\n    {\\n      \\"path\\": \\"src/codegen/array/array-",\n            "to": ""\n          }\n        ],\n        "forward": [\n          {\n            "inputOffset": 112261,\n            "outputOffset": 112261,\n            "from": "",\n            "to": "sort-value.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.\\"\\n    },\\n    {\\n      \\"path\\": \\"src/codegen/array/array-"\n          }\n        ]\n      }',
    },
  ],
} as const;
const seventeenthPolicyEpoch = {
  commit: "5d7c261f46ca5dc06d09f47da8665d3151335224",
  parent: "6720ce5198f5252239ff4800b383de2072830d99",
  beforePin: {
    bytes: 608556,
    sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",
    gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",
  },
  currentPin: {
    bytes: 608912,
    sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",
    gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",
  },
  inverse: [
    {
      inputOffset: 112261,
      outputOffset: 112261,
      from: 'sort-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction."\n    },\n    {\n      "path": "src/codegen/array/array-',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 112261,
      outputOffset: 112261,
      from: "",
      to: 'sort-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction."\n    },\n    {\n      "path": "src/codegen/array/array-',
    },
  ],
} as const;
const seventeenthPolicySemanticAuthority = {
  beforeFileCount: 1904,
  currentFileCount: 1905,
  additions: [
    {
      index: 202,
      row: {
        path: "src/codegen/array/array-sort-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.",
      },
      previousPath: "src/codegen/array/array-copy-methods-value.ts",
      nextPath: "src/codegen/array/array-fill-proto-value.ts",
    },
  ],
  layers: [],
} as const;

const independentTestedSeventeenSuccessorFreeze: string =
  '{"receiptPin":{"bytes":253824,"sha256":"1bf3f3c1f6abdbf7e4912625d802e43705ba9184cb81038b115af16f5da5ec7b","gitBlob":"968528f295b8097dbbd8976f0a0ede1c04341c60"},"anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"32a15b44ebf42a538cb44ecff4e00b4f3e40b0ca52da3a3559109cca584adfda\\";\\nexport const c1GeometrySuccessorSha256 = \\"1bf3f3c1f6abdbf7e4912625d802e43705ba9184cb81038b115af16f5da5ec7b\\";\\n","anchorPin":{"bytes":303,"sha256":"99c284ea2d176f23d15d782596bc0897096c9b8993c5ed5e8b3dda8d960a1d7c","gitBlob":"2ac37c9abc459c875e442c8fd97123208111ca18"},"instruments":[{"path":"tests/helpers/ir-c1-historical-authority.ts","currentPin":{"bytes":102253,"sha256":"02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a","gitBlob":"4ecb94bd9aa929547e6699f38fe1e61cb1216b86"}},{"path":"tests/helpers/ir-c1-current-source.ts","currentPin":{"bytes":53563,"sha256":"a766bff19e173800163e596d6f0a0adc0c2a7c7c32992dafbd30217135c4e6c1","gitBlob":"f9ec52eac7b94cc9c47287578593e4cb13a19a23"}},{"path":"tests/helpers/ir-runtime-program-policy-evolution.ts","currentPin":{"bytes":411837,"sha256":"8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c","gitBlob":"15ae96d3887a5eb61fc6404df098d58f0d96b2f4"}},{"path":"tests/issue-3518-program-data-contract-boundary.test.ts","currentPin":{"bytes":33840,"sha256":"24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469","gitBlob":"18a17efe93db58ab5f6f0322f845c92e86859d41"}},{"path":"tests/issue-3518-runtime-program-policy-evolution.test.ts","currentPin":{"bytes":29161,"sha256":"a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1","gitBlob":"43d2493da1d08c890841f03774f5e664731a82f6"}},{"path":"tests/issue-3518-well-known-symbol-policy-evolution.test.ts","currentPin":{"bytes":29764,"sha256":"fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4","gitBlob":"a009cd0ffbd2f91d971dada7abbf239c557d79d8"}},{"path":"tests/issue-3518-number-prerequisite-policy-evolution.test.ts","currentPin":{"bytes":116007,"sha256":"546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea","gitBlob":"1fb4a992f18ccad293e3030d9f0d88c40d40d78a"}}]}';
const eighteenthH1Stage = {
  path: "tests/helpers/ir-c1-historical-authority.ts",
  beforePin: {
    bytes: 102253,
    sha256: "02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a",
    gitBlob: "4ecb94bd9aa929547e6699f38fe1e61cb1216b86",
  },
  currentPin: {
    bytes: 103380,
    sha256: "52c3cc6514ae8f1084dd154a94d7dca34c061a6e45baedf1d8bc094aac526b8e",
    gitBlob: "13581c9dd08696c08ba660fe433bc4a9b0fbe2cf",
  },
  inverse: [
    {
      inputOffset: 67808,
      outputOffset: 67808,
      from: '  {\n    commit: "0c65834a6cf2f99c6183f0fb171d0d3db56b0800",\n    parent: "c902aea8db3a566afd32c9749eb1d740df6d5a4f",\n    beforePin: {\n      bytes: 608912,\n      sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n      gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",\n    },\n    currentPin: {\n      bytes: 609239,\n      sha256: "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",\n      gitBlob: "82d1fcd8623827c904eb2158d1c8361969f996fe",\n    },\n  },\n',
      to: "",
    },
    {
      inputOffset: 95265,
      outputOffset: 94771,
      from: '  {\n    beforeFileCount: 1905,\n    currentFileCount: 1906,\n    additions: [\n      {\n        index: 354,\n        row: {\n          path: "src/codegen/closures/closure-type-sources.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/closure-header-layout.ts",\n        nextPath: "src/codegen/closures/conditional-capture-box.ts",\n      },\n    ],\n    layers: [],\n  },\n',
      to: "",
    },
    {
      inputOffset: 102828,
      outputOffset: 101700,
      from: "/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\n",
      to: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\n",
    },
  ],
  forward: [
    {
      inputOffset: 67808,
      outputOffset: 67808,
      from: "",
      to: '  {\n    commit: "0c65834a6cf2f99c6183f0fb171d0d3db56b0800",\n    parent: "c902aea8db3a566afd32c9749eb1d740df6d5a4f",\n    beforePin: {\n      bytes: 608912,\n      sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n      gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",\n    },\n    currentPin: {\n      bytes: 609239,\n      sha256: "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",\n      gitBlob: "82d1fcd8623827c904eb2158d1c8361969f996fe",\n    },\n  },\n',
    },
    {
      inputOffset: 94771,
      outputOffset: 95265,
      from: "",
      to: '  {\n    beforeFileCount: 1905,\n    currentFileCount: 1906,\n    additions: [\n      {\n        index: 354,\n        row: {\n          path: "src/codegen/closures/closure-type-sources.ts",\n          state: "unmigrated",\n          layer: "mixed-needs-split",\n          destination: "backend-wasmgc",\n          owner: "3518-coordinator",\n          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",\n        },\n        previousPath: "src/codegen/closures/closure-header-layout.ts",\n        nextPath: "src/codegen/closures/conditional-capture-box.ts",\n      },\n    ],\n    layers: [],\n  },\n',
    },
    {
      inputOffset: 101700,
      outputOffset: 102828,
      from: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\n",
      to: "/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\n",
    },
  ],
} as const;
const eighteenthReceiptStage = {
  path: "tests/helpers/ir-c1-linear-layout-geometry-successor.json",
  beforePin: {
    bytes: 253824,
    sha256: "1bf3f3c1f6abdbf7e4912625d802e43705ba9184cb81038b115af16f5da5ec7b",
    gitBlob: "968528f295b8097dbbd8976f0a0ede1c04341c60",
  },
  currentPin: {
    bytes: 257831,
    sha256: "5dfc7f4216ae2699e2efcad01ae1ba4b0d35b754a651155683db60a089ad4b3f",
    gitBlob: "66c6cb4b635f5174c4f9bd0b4d0b199c9106883e",
  },
  inverse: [
    {
      inputOffset: 480,
      outputOffset: 480,
      from: '{\n        "bytes": 103380,\n        "sha256": "52c3cc6514ae8f1084dd154a94d7dca34c061a6e45baedf1d8bc094aac526b8e",\n        "gitBlob": "13581c9dd08696c08ba660fe433bc4a9b0fbe2cf"\n      }',
      to: '{\n        "bytes": 102253,\n        "sha256": "02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a",\n        "gitBlob": "4ecb94bd9aa929547e6699f38fe1e61cb1216b86"\n      }',
    },
    {
      inputOffset: 27331,
      outputOffset: 27331,
      from: '    },\\n  },\\n  {\\n    commit: \\"0c65834a6cf2f99c6183f0fb171d0d3db56b0800\\",\\n    parent: \\"c902aea8db3a566afd32c9749eb1d740df6d5a4f\\",\\n    beforePin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n    currentPin: {\\n      bytes: 609239,\\n      sha256: \\"cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3\\",\\n      gitBlob: \\"82d1fcd8623827c904eb2158d1c8361969f996fe\\",\\n',
      to: "",
    },
    {
      inputOffset: 56417,
      outputOffset: 55897,
      from: '  {\\n    beforeFileCount: 1905,\\n    currentFileCount: 1906,\\n    additions: [\\n      {\\n        index: 354,\\n        row: {\\n          path: \\"src/codegen/closures/closure-type-sources.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary: \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\",\\n        },\\n        previousPath: \\"src/codegen/closures/closure-header-layout.ts\\",\\n        nextPath: \\"src/codegen/closures/conditional-capture-box.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
      to: "",
    },
    {
      inputOffset: 64285,
      outputOffset: 63095,
      from: "/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
      to: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
    },
    {
      inputOffset: 91584,
      outputOffset: 90395,
      from: '    },\\n  },\\n  {\\n    commit: \\"0c65834a6cf2f99c6183f0fb171d0d3db56b0800\\",\\n    parent: \\"c902aea8db3a566afd32c9749eb1d740df6d5a4f\\",\\n    beforePin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n    currentPin: {\\n      bytes: 609239,\\n      sha256: \\"cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3\\",\\n      gitBlob: \\"82d1fcd8623827c904eb2158d1c8361969f996fe\\",\\n',
      to: "",
    },
    {
      inputOffset: 120670,
      outputOffset: 118961,
      from: '  {\\n    beforeFileCount: 1905,\\n    currentFileCount: 1906,\\n    additions: [\\n      {\\n        index: 354,\\n        row: {\\n          path: \\"src/codegen/closures/closure-type-sources.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary: \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\",\\n        },\\n        previousPath: \\"src/codegen/closures/closure-header-layout.ts\\",\\n        nextPath: \\"src/codegen/closures/conditional-capture-box.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
      to: "",
    },
    {
      inputOffset: 128538,
      outputOffset: 126159,
      from: "/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
      to: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
    },
    {
      inputOffset: 215908,
      outputOffset: 213530,
      from: '{\n      "bytes": 609239,\n      "sha256": "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",\n      "gitBlob": "82d1fcd8623827c904eb2158d1c8361969f996fe"\n    }',
      to: '{\n      "bytes": 608912,\n      "sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n      "gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"\n    }',
    },
    {
      inputOffset: 256189,
      outputOffset: 253811,
      from: ',\n      {\n        "commit": "0c65834a6cf2f99c6183f0fb171d0d3db56b0800",\n        "parent": "c902aea8db3a566afd32c9749eb1d740df6d5a4f",\n        "beforePin": {\n          "bytes": 608912,\n          "sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n          "gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"\n        },\n        "currentPin": {\n          "bytes": 609239,\n          "sha256": "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",\n          "gitBlob": "82d1fcd8623827c904eb2158d1c8361969f996fe"\n        },\n        "inverse": [\n          {\n            "inputOffset": 161031,\n            "outputOffset": 161031,\n            "from": "    {\\n      \\"path\\": \\"src/codegen/closures/closure-type-sources.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\"\\n    },\\n",\n            "to": ""\n          }\n        ],\n        "forward": [\n          {\n            "inputOffset": 161031,\n            "outputOffset": 161031,\n            "from": "",\n            "to": "    {\\n      \\"path\\": \\"src/codegen/closures/closure-type-sources.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\"\\n    },\\n"\n          }\n        ]\n      }',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 480,
      outputOffset: 480,
      from: '{\n        "bytes": 102253,\n        "sha256": "02dca93ec6c16f5f8dea859122547631c1f98e7afe0f37ea76b9b08dc373617a",\n        "gitBlob": "4ecb94bd9aa929547e6699f38fe1e61cb1216b86"\n      }',
      to: '{\n        "bytes": 103380,\n        "sha256": "52c3cc6514ae8f1084dd154a94d7dca34c061a6e45baedf1d8bc094aac526b8e",\n        "gitBlob": "13581c9dd08696c08ba660fe433bc4a9b0fbe2cf"\n      }',
    },
    {
      inputOffset: 27331,
      outputOffset: 27331,
      from: "",
      to: '    },\\n  },\\n  {\\n    commit: \\"0c65834a6cf2f99c6183f0fb171d0d3db56b0800\\",\\n    parent: \\"c902aea8db3a566afd32c9749eb1d740df6d5a4f\\",\\n    beforePin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n    currentPin: {\\n      bytes: 609239,\\n      sha256: \\"cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3\\",\\n      gitBlob: \\"82d1fcd8623827c904eb2158d1c8361969f996fe\\",\\n',
    },
    {
      inputOffset: 55897,
      outputOffset: 56417,
      from: "",
      to: '  {\\n    beforeFileCount: 1905,\\n    currentFileCount: 1906,\\n    additions: [\\n      {\\n        index: 354,\\n        row: {\\n          path: \\"src/codegen/closures/closure-type-sources.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary: \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\",\\n        },\\n        previousPath: \\"src/codegen/closures/closure-header-layout.ts\\",\\n        nextPath: \\"src/codegen/closures/conditional-capture-box.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
    },
    {
      inputOffset: 63095,
      outputOffset: 64285,
      from: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
      to: "/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
    },
    {
      inputOffset: 90395,
      outputOffset: 91584,
      from: "",
      to: '    },\\n  },\\n  {\\n    commit: \\"0c65834a6cf2f99c6183f0fb171d0d3db56b0800\\",\\n    parent: \\"c902aea8db3a566afd32c9749eb1d740df6d5a4f\\",\\n    beforePin: {\\n      bytes: 608912,\\n      sha256: \\"e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd\\",\\n      gitBlob: \\"1af8a4f11e3b69d23930cc388dd614f76750de8d\\",\\n    },\\n    currentPin: {\\n      bytes: 609239,\\n      sha256: \\"cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3\\",\\n      gitBlob: \\"82d1fcd8623827c904eb2158d1c8361969f996fe\\",\\n',
    },
    {
      inputOffset: 118961,
      outputOffset: 120670,
      from: "",
      to: '  {\\n    beforeFileCount: 1905,\\n    currentFileCount: 1906,\\n    additions: [\\n      {\\n        index: 354,\\n        row: {\\n          path: \\"src/codegen/closures/closure-type-sources.ts\\",\\n          state: \\"unmigrated\\",\\n          layer: \\"mixed-needs-split\\",\\n          destination: \\"backend-wasmgc\\",\\n          owner: \\"3518-coordinator\\",\\n          nextBoundary: \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\",\\n        },\\n        previousPath: \\"src/codegen/closures/closure-header-layout.ts\\",\\n        nextPath: \\"src/codegen/closures/conditional-capture-box.ts\\",\\n      },\\n    ],\\n    layers: [],\\n  },\\n',
    },
    {
      inputOffset: 126159,
      outputOffset: 128538,
      from: "/** Seventeen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
      to: "/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */\\n",
    },
    {
      inputOffset: 213530,
      outputOffset: 215908,
      from: '{\n      "bytes": 608912,\n      "sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n      "gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"\n    }',
      to: '{\n      "bytes": 609239,\n      "sha256": "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",\n      "gitBlob": "82d1fcd8623827c904eb2158d1c8361969f996fe"\n    }',
    },
    {
      inputOffset: 253811,
      outputOffset: 256189,
      from: "",
      to: ',\n      {\n        "commit": "0c65834a6cf2f99c6183f0fb171d0d3db56b0800",\n        "parent": "c902aea8db3a566afd32c9749eb1d740df6d5a4f",\n        "beforePin": {\n          "bytes": 608912,\n          "sha256": "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",\n          "gitBlob": "1af8a4f11e3b69d23930cc388dd614f76750de8d"\n        },\n        "currentPin": {\n          "bytes": 609239,\n          "sha256": "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",\n          "gitBlob": "82d1fcd8623827c904eb2158d1c8361969f996fe"\n        },\n        "inverse": [\n          {\n            "inputOffset": 161031,\n            "outputOffset": 161031,\n            "from": "    {\\n      \\"path\\": \\"src/codegen/closures/closure-type-sources.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\"\\n    },\\n",\n            "to": ""\n          }\n        ],\n        "forward": [\n          {\n            "inputOffset": 161031,\n            "outputOffset": 161031,\n            "from": "",\n            "to": "    {\\n      \\"path\\": \\"src/codegen/closures/closure-type-sources.ts\\",\\n      \\"state\\": \\"unmigrated\\",\\n      \\"layer\\": \\"mixed-needs-split\\",\\n      \\"destination\\": \\"backend-wasmgc\\",\\n      \\"owner\\": \\"3518-coordinator\\",\\n      \\"nextBoundary\\": \\"Separate AST/context-driven generation, physical resources and generated native runtime.\\"\\n    },\\n"\n          }\n        ]\n      }',
    },
  ],
} as const;
const eighteenthPolicyEpoch = {
  commit: "0c65834a6cf2f99c6183f0fb171d0d3db56b0800",
  parent: "c902aea8db3a566afd32c9749eb1d740df6d5a4f",
  beforePin: {
    bytes: 608912,
    sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",
    gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",
  },
  currentPin: {
    bytes: 609239,
    sha256: "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",
    gitBlob: "82d1fcd8623827c904eb2158d1c8361969f996fe",
  },
  inverse: [
    {
      inputOffset: 161031,
      outputOffset: 161031,
      from: '    {\n      "path": "src/codegen/closures/closure-type-sources.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 161031,
      outputOffset: 161031,
      from: "",
      to: '    {\n      "path": "src/codegen/closures/closure-type-sources.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    },
  ],
} as const;
const eighteenthPolicySemanticAuthority = {
  beforeFileCount: 1905,
  currentFileCount: 1906,
  additions: [
    {
      index: 354,
      row: {
        path: "src/codegen/closures/closure-type-sources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previousPath: "src/codegen/closures/closure-header-layout.ts",
      nextPath: "src/codegen/closures/conditional-capture-box.ts",
    },
  ],
  layers: [],
} as const;
function independentlyAcquireSeventeenSuccessor() {
  const acquired = independentlyAcquireSuccessor();
  authenticateCurrentH1Implementation();
  const seventeenFreeze = JSON.parse(independentTestedSeventeenSuccessorFreeze) as CurrentSuccessorFreeze;
  const h1 = independentlyAcquireFixtureEpoch(read(historicalCallerPath), eighteenthH1Stage);
  const seventeenReceipt = independentlyAcquireFixtureEpoch(read(successorReceiptPath), eighteenthReceiptStage);
  const currentPolicy = read(slicePolicyPath);
  const seventeenPolicy = independentlyAcquireFixtureEpoch(currentPolicy, {
    path: slicePolicyPath,
    ...eighteenthPolicyEpoch,
  });
  expect(pin(h1)).toEqual(seventeenFreeze.instruments[0]!.currentPin);
  expect(pin(seventeenReceipt)).toEqual(seventeenFreeze.receiptPin);
  expect(pin(seventeenFreeze.anchorSource)).toEqual(seventeenFreeze.anchorPin);
  expect(acquired.receipt.policySource.epochs).toHaveLength(18);
  expect(acquired.receipt.policySource.epochs[17]).toEqual(eighteenthPolicyEpoch);
  const receipt = JSON.parse(seventeenReceipt) as typeof acquired.receipt;
  expect(Object.keys(receipt)).toEqual(Object.keys(acquired.receipt));
  expect(receipt.policySource.epochs).toHaveLength(17);
  expect(receipt.policySource.epochs).toEqual(acquired.receipt.policySource.epochs.slice(0, 17));
  expect(receipt.policySource.currentPin).toEqual(eighteenthPolicyEpoch.beforePin);
  expect(pin(seventeenPolicy)).toEqual(receipt.policySource.currentPin);
  expect(receipt.instruments).toHaveLength(7);
  for (const [index, instrument] of receipt.instruments.entries()) {
    expect(instrument.currentPin).toEqual(seventeenFreeze.instruments[index]!.currentPin);
    if (index > 0) expect(instrument).toEqual(acquired.receipt.instruments[index]);
    const current = index === 0 ? h1 : read(instrument.path);
    const original = independentlyReplaySuccessorSpans(
      current,
      instrument.inverse,
      "tested seventeen independent inverse",
      instrument.beforePin,
    );
    expect(original).toBe(acquired.originalPublished.get(instrument.path));
    expect(
      independentlyReplaySuccessorSpans(
        original,
        instrument.forward,
        "tested seventeen independent forward",
        instrument.currentPin,
      ),
    ).toBe(current);
  }
  expect(receipt.linearOptions).toEqual(acquired.receipt.linearOptions);
  expect(receipt.cabiSource).toEqual(acquired.receipt.cabiSource);
  const predecessor = independentSuccessorSourceBefore(currentPolicy, acquired.receipt.policySource);
  const trace: string[] = [];
  expect(
    captureGeometryCurrentMainPredecessorPolicySource(currentPolicy, (path) => {
      expect(slicePolicyReadOrder).toContain(path);
      trace.push(path);
      return read(path);
    }),
  ).toBe(predecessor);
  expect(trace).toEqual(slicePolicyReadOrder);
  expect(pin(predecessor).bytes).toBe(599721);
  return { ...acquired, receipt, h1, seventeenReceipt, seventeenPolicy, seventeenFreeze };
}

function independentlyAcquireSixteenSuccessor() {
  const acquired = independentlyAcquireSeventeenSuccessor();
  authenticateCurrentH1Implementation();
  const sixteenFreeze = JSON.parse(independentSixteenSuccessorFreeze) as CurrentSuccessorFreeze;
  const h1 = independentlyAcquireFixtureEpoch(acquired.h1, seventeenthH1Stage);
  const sixteenReceipt = independentlyAcquireFixtureEpoch(acquired.seventeenReceipt, seventeenthReceiptStage);
  const sixteenPolicy = independentlyAcquireFixtureEpoch(acquired.seventeenPolicy, {
    path: slicePolicyPath,
    ...seventeenthPolicyEpoch,
  });
  expect(pin(h1)).toEqual(sixteenFreeze.instruments[0]!.currentPin);
  expect(pin(sixteenReceipt)).toEqual(sixteenFreeze.receiptPin);
  expect(pin(sixteenFreeze.anchorSource)).toEqual(sixteenFreeze.anchorPin);
  expect(acquired.receipt.policySource.epochs).toHaveLength(17);
  expect(acquired.receipt.policySource.epochs[16]).toEqual(seventeenthPolicyEpoch);
  const receipt = JSON.parse(sixteenReceipt) as typeof acquired.receipt;
  expect(Object.keys(receipt)).toEqual(Object.keys(acquired.receipt));
  expect(receipt.policySource.epochs).toHaveLength(16);
  expect(receipt.policySource.epochs).toEqual(acquired.receipt.policySource.epochs.slice(0, 16));
  expect(receipt.policySource.currentPin).toEqual(seventeenthPolicyEpoch.beforePin);
  expect(pin(sixteenPolicy)).toEqual(receipt.policySource.currentPin);
  expect(receipt.instruments).toHaveLength(7);
  for (const [index, instrument] of receipt.instruments.entries()) {
    expect(instrument.currentPin).toEqual(sixteenFreeze.instruments[index]!.currentPin);
    if (index > 0) expect(instrument).toEqual(acquired.receipt.instruments[index]);
    const current = index === 0 ? h1 : read(instrument.path);
    const predecessor = independentlyReplaySuccessorSpans(
      current,
      instrument.inverse,
      "sealed sixteen independent inverse",
      instrument.beforePin,
    );
    expect(predecessor).toBe(acquired.originalPublished.get(instrument.path));
    expect(
      independentlyReplaySuccessorSpans(
        predecessor,
        instrument.forward,
        "sealed sixteen independent forward",
        instrument.currentPin,
      ),
    ).toBe(current);
  }
  expect(receipt.linearOptions).toEqual(acquired.receipt.linearOptions);
  expect(receipt.cabiSource).toEqual(acquired.receipt.cabiSource);
  return { ...acquired, receipt, h1, sixteenReceipt, sixteenPolicy, sixteenFreeze };
}

function independentlyAcquireFourteenSuccessor() {
  const acquired = independentlyAcquireSixteenSuccessor();
  const fourteenFreeze = JSON.parse(independentFourteenSuccessorFreeze) as CurrentSuccessorFreeze;
  const h1 = independentlyAcquireFixtureEpoch(acquired.h1, finalPolicyH1Stage);
  expect(pin(h1)).toEqual(fourteenFreeze.instruments[0]!.currentPin);
  expect(acquired.receipt.policySource.epochs).toHaveLength(16);
  expect(acquired.receipt.policySource.epochs.slice(14)).toEqual(canonicalPolicyEpochs);
  let fourteenPolicy = acquired.sixteenPolicy;
  for (const epoch of [...canonicalPolicyEpochs].reverse())
    fourteenPolicy = independentlyAcquireFixtureEpoch(fourteenPolicy, {
      path: "scripts/compiler-boundaries.json",
      ...epoch,
    });
  expect(pin(fourteenPolicy)).toEqual(canonicalPolicyEpochs[0].beforePin);
  const receipt: typeof acquired.receipt = {
    ...acquired.receipt,
    instruments: acquired.receipt.instruments.map((entry, index) =>
      index === 0
        ? {
            ...fourteenH1Record,
            inverse: fourteenH1Record.inverse.map((span) => ({ ...span })),
            forward: fourteenH1Record.forward.map((span) => ({ ...span })),
          }
        : entry,
    ),
    policySource: {
      ...acquired.receipt.policySource,
      currentPin: canonicalPolicyEpochs[0].beforePin,
      epochs: acquired.receipt.policySource.epochs.slice(0, 14),
    },
  };
  const fourteenReceipt = JSON.stringify(receipt, null, 2) + "\n";
  expect(pin(fourteenReceipt)).toEqual(fourteenFreeze.receiptPin);
  expect(pin(fourteenFreeze.anchorSource)).toEqual(fourteenFreeze.anchorPin);
  expect(receipt.instruments[0]).toEqual(fourteenH1Record);
  // Reciprocally associate complete historical DATA with the actual independently pinned current receipt.
  const restoredCurrent = {
    ...receipt,
    instruments: receipt.instruments.map((entry, index) => (index === 0 ? acquired.receipt.instruments[0]! : entry)),
    policySource: {
      ...receipt.policySource,
      currentPin: canonicalPolicyEpochs[1].currentPin,
      epochs: [...receipt.policySource.epochs, ...canonicalPolicyEpochs],
    },
  };
  expect(JSON.stringify(restoredCurrent, null, 2) + "\n").toBe(acquired.sixteenReceipt);
  return { ...acquired, receipt, h1, fourteenPolicy, fourteenReceipt, fourteenFreeze };
}

function independentlyAcquireThirteenSuccessor() {
  const acquired = independentlyAcquireFourteenSuccessor();
  const thirteenFreeze = thirteenSuccessorFreeze();
  const h1 = independentlyAcquireFixtureEpoch(acquired.h1, sliceH1Stage);
  expect(pin(h1)).toEqual(thirteenFreeze.instruments[0]!.currentPin);
  const policy = acquired.receipt.policySource;
  expect(policy.epochs).toHaveLength(14);
  const last = policy.epochs[13]!;
  expect(last.commit).toBe("b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771");
  expect(last.parent).toBe("dbf5b4f74b37d67e525b2af36fd1fe49803b1348");
  const receipt = {
    ...acquired.receipt,
    instruments: acquired.receipt.instruments.map((entry, index) => (index === 0 ? h1CallerComposed : entry)),
    policySource: { ...policy, currentPin: last.beforePin, epochs: policy.epochs.slice(0, 13) },
  };
  const thirteenReceipt = JSON.stringify(receipt, null, 2) + "\n";
  expect(pin(thirteenReceipt)).toEqual(thirteenFreeze.receiptPin);
  expect(pin(thirteenFreeze.anchorSource)).toEqual(thirteenFreeze.anchorPin);
  expect(receipt.instruments).toHaveLength(7);
  for (const [index, entry] of receipt.instruments.entries())
    expect(entry.currentPin).toEqual(thirteenFreeze.instruments[index]!.currentPin);
  return { ...acquired, receipt, thirteenReceipt, thirteenFreeze, h1 };
}

function independentlyAcquireNumberComposition() {
  const acquired = independentlyAcquireThirteenSuccessor();
  expect(acquired.receipt.instruments[0]).toEqual(h1CallerComposed);
  expect(acquired.receipt.instruments[6]).toEqual(numberCallerComposed);
  const oldFreeze = JSON.parse(independentNumberPredecessorFreeze) as CurrentSuccessorFreeze;
  const oldRecords = acquired.receipt.instruments.map((record, index) =>
    index === 0 ? h1CallerOld : index === 6 ? numberCallerOld : record,
  );
  const oldReceipt = JSON.stringify({ ...acquired.receipt, instruments: oldRecords }, null, 2) + "\n";
  compositionPin(oldReceipt, oldFreeze.receiptPin);
  compositionPin(oldFreeze.anchorSource, oldFreeze.anchorPin);
  const sources = new Map<string, string>();
  const callerProofs = [
    [historicalCallerPath, h1CallerStage, h1CallerOld, h1CallerComposed],
    [numberCallerPath, numberCallerStage, numberCallerOld, numberCallerComposed],
  ] as const;
  for (const [path, stage, old, composed] of callerProofs) {
    const source = path === historicalCallerPath ? acquired.h1 : read(path);
    const result = independentlyCheckComposedCaller(source, stage, old, composed);
    sources.set(path, result.intermediate);
    expect(result.original).toBe(acquired.originalPublished.get(path));
  }
  for (const [index, record] of oldFreeze.instruments.entries()) {
    const source = sources.get(record.path) ?? read(record.path);
    compositionPin(source, record.currentPin);
    if (index !== 0 && index !== 6)
      expect(record.currentPin).toEqual(currentSuccessorFreeze().instruments[index]!.currentPin);
  }
  const observed: [string, string][] = [];
  const capture = currentHistoricalAuthority((path) => {
    const source = read(path);
    observed.push([path, source]);
    return source;
  });
  expect(observed.map(([path]) => path)).toEqual(independentNumberHistoricalTrace);
  for (const [path, source] of observed) expect(source).toBe(read(path));
  const logical = "tests/helpers/ir-runtime-program-policy-evolution.ts";
  const historical = capture.readHistorical(logical);
  expect(historical).toBe(read(c1HistoricalArtifactPath(logical)));
  expect(Buffer.byteLength(historical)).toBe(93405);
  expect(createHash("sha256").update(Buffer.from(historical).subarray(0, 40368)).digest("hex")).toBe(
    "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",
  );
  return { ...acquired, oldReceipt, oldFreeze, sources };
}
function compositionFailure(action: () => unknown): Error {
  let caught: unknown;
  let accepted = 0;
  try {
    action();
    accepted += 1;
  } catch (error) {
    caught = error;
  }
  expect(accepted).toBe(0);
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  return caught as Error;
}
function expectCompositionError(action: () => unknown, message: string): void {
  expect(compositionFailure(action).message).toBe(message);
}
function numberReaderFromActualSource(readPhysical: (path: string) => string) {
  const source = read(numberCallerPath);
  compositionPin(source, numberCallerStage.currentPin);
  const parsed = ts.createSourceFile(numberCallerPath, source, ts.ScriptTarget.Latest, true);
  expect((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toHaveLength(0);
  const names = [
    "historicalPolicyOperandPaths",
    "historicalPolicyPhysicalPath",
    "readHistoricalPolicyOperand",
    "readPinnedPreparationOperand",
  ] as const;
  const nodes = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.includes(node.name.text as (typeof names)[number])
    )
      nodes.set(node.name.text, [...(nodes.get(node.name.text) ?? []), node]);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const fragments = names.map((name) => {
    expect(nodes.get(name)).toHaveLength(1);
    return "const " + nodes.get(name)![0]!.getText(parsed) + ";\n";
  });
  const pinned = nodes.get("readPinnedPreparationOperand")![0]!;
  const statement = pinned.parent.parent;
  expect("  " + statement.getText(parsed) + "\n").toBe(
    numberCallerStage.inverse[1].from.slice(numberCallerStage.inverse[1].to.length),
  );
  const loop = numberCallerStage.inverse[2];
  expect(
    Buffer.from(source)
      .subarray(loop.inputOffset, loop.inputOffset + Buffer.byteLength(loop.from))
      .toString("utf8"),
  ).toBe(loop.from);
  expect(loop.from).toContain("const source = readPinnedPreparationOperand(pin.path);");
  const emitted = ts.transpileModule(fragments.join(""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  expect(emitted.diagnostics ?? []).toHaveLength(0);
  // Execute the freshly authenticated actual arrow/declarations, with explicit reader/export bindings.
  // This is the reader association control; it neither imports the test nor registers its callbacks.
  return new Function(
    "read",
    "c1HistoricalArtifactPath",
    "runtimePreparationRemainderHistoricalSource",
    emitted.outputText + "\nreturn { readPinnedPreparationOperand, readHistoricalPolicyOperand };\n",
  )(readPhysical, c1HistoricalArtifactPath, runtimePreparationRemainderHistoricalSource) as {
    readPinnedPreparationOperand(path: string): string;
    readHistoricalPolicyOperand(path: string): string;
  };
}

describe("C1 independently composed Number caller authority", () => {
  it("retains R1 A1 N1 H1a complete intermediate evidence and binds exact R2 A2 seven-source capture", () => {
    independentlyAcquireNumberComposition();
  });
  it.each([
    [numberCallerPath, numberCallerStage, numberCallerOld, numberCallerComposed],
    [historicalCallerPath, h1CallerStage, h1CallerOld, h1CallerComposed],
  ] as const)(
    "proves every intermediate old and composed direction and refuses actual recipe faults for %s",
    (path, stage, old, composed) => {
      const source = path === historicalCallerPath ? independentlyAcquireThirteenSuccessor().h1 : read(path);
      const healthy = () => independentlyCheckComposedCaller(source, stage, old, composed);
      healthy();
      for (const layer of ["stage", "old", "composed"] as const)
        for (const direction of ["inverse", "forward"] as const)
          for (const fault of [
            "input coordinate",
            "output coordinate",
            "from",
            "to",
            "missing",
            "duplicate",
            "surrogate",
            "unsafe",
          ] as const) {
            healthy();
            const changed = structuredClone(
              layer === "stage" ? stage : layer === "old" ? old : composed,
            ) as unknown as SuccessorInstrument;
            const spans = changed[direction];
            if (fault === "input coordinate") spans[0]!.inputOffset += 1;
            if (fault === "output coordinate") spans[0]!.outputOffset += 1;
            if (fault === "from") spans[0]!.from = "x" + spans[0]!.from;
            if (fault === "to") spans[0]!.to = "x" + spans[0]!.to;
            if (fault === "missing") spans.splice(0, 1);
            if (fault === "duplicate") spans.splice(1, 0, { ...spans[0]! });
            if (fault === "surrogate") spans[0]!.to = "\ud800";
            if (fault === "unsafe") spans[0]!.inputOffset = Number.MAX_SAFE_INTEGER + 1;
            compositionFailure(() =>
              independentlyCheckComposedCaller(
                source,
                layer === "stage" ? changed : stage,
                layer === "old" ? changed : old,
                layer === "composed" ? changed : composed,
              ),
            );
            healthy();
          }
    },
  );
  it.each(["import", "local reader", "pin loop", "untouched tail", "exact N1"] as const)(
    "refuses the precise Number caller association fault %s",
    (fault) => {
      const { sources } = independentlyAcquireNumberComposition();
      const source = read(numberCallerPath);
      const index = fault === "import" ? 0 : fault === "local reader" ? 1 : 2;
      const span = numberCallerStage.inverse[index];
      const bytes = Buffer.from(source);
      const mutant =
        fault === "exact N1"
          ? sources.get(numberCallerPath)!
          : fault === "untouched tail"
            ? source.slice(0, -1) + (source.endsWith("\n") ? " " : "\n")
            : Buffer.concat([
                bytes.subarray(0, span.inputOffset),
                Buffer.from(span.to),
                bytes.subarray(span.inputOffset + Buffer.byteLength(span.from)),
              ]).toString("utf8");
      expect(mutant).not.toBe(source);
      expectCompositionError(
        () => currentHistoricalAuthority(replaced(numberCallerPath, mutant)),
        "C1 historical authority: full-file pin changed: " + numberCallerPath + " geometry current",
      );
      expect(read(numberCallerPath)).toBe(source);
      independentlyAcquireNumberComposition();
    },
  );
  it.each([numberCallerPath, historicalCallerPath, successorReceiptPath, anchorPath] as const)(
    "rereads warm mutation and missing identity with exact restoration for %s",
    (path) => {
      independentlyAcquireNumberComposition();
      const source = read(path);
      const message =
        path === anchorPath
          ? "C1 historical authority: warm anchor source changed"
          : path === successorReceiptPath
            ? "C1 historical authority: geometry instrument receipt digest mismatch"
            : "C1 historical authority: full-file pin changed: " + path + " geometry current";
      expectCompositionError(
        () => currentHistoricalAuthority(replaced(path, source + "\n// independently owned warm fault\n")),
        message,
      );
      expect(read(path)).toBe(source);
      independentlyAcquireNumberComposition();
      const missing = new Error("C1 Number successor supplied missing input: " + path);
      let reached = 0;
      const reader = (request: string): string => {
        if (request === path) {
          reached += 1;
          throw missing;
        }
        return read(request);
      };
      expect(compositionFailure(() => currentHistoricalAuthority(reader))).toBe(missing);
      expect(reached).toBe(1);
      expect(read(path)).toBe(source);
      independentlyAcquireNumberComposition();
    },
  );
  it("executes the exact authenticated Number reader declarations and preserves the six-path archive/raw association", () => {
    independentlyAcquireNumberComposition();
    const observed: string[] = [];
    const actual = numberReaderFromActualSource((path) => {
      observed.push(path);
      return read(path);
    });
    const current = read(remainderPreparationPath);
    const historical = actual.readPinnedPreparationOperand(remainderPreparationPath);
    expect(historical).toBe(runtimePreparationRemainderHistoricalSource(current));
    compositionPin(current, remainderIndependentProof.source.current);
    compositionPin(historical, remainderIndependentProof.source.before);
    expect(observed).toEqual([remainderPreparationPath]);
    for (const [logical] of artifacts.slice(1)) {
      expect(actual.readPinnedPreparationOperand(logical)).toBe(read(c1HistoricalArtifactPath(logical)));
      expect(observed.at(-1)).toBe(c1HistoricalArtifactPath(logical));
    }
    const other = "tests/helpers/ir-runtime-program-policy-runtime-preparation.json";
    expect(actual.readPinnedPreparationOperand(other)).toBe(read(other));
    expect(observed.at(-1)).toBe(other);
    independentlyAcquireNumberComposition();
  });
  it.each(["missing", "lone surrogate", "boxed source", "undefined"] as const)(
    "rejects uncovered actual Number-reader preparation input %s without fallback or coercion",
    (kind) => {
      independentlyAcquireNumberComposition();
      const missing = new Error("Number actual reader missing preparation source");
      let reads = 0,
        coercions = 0;
      const boxed = {
        [Symbol.toPrimitive]: () => {
          coercions += 1;
          return "source";
        },
      };
      const actual = numberReaderFromActualSource((path) => {
        if (path !== remainderPreparationPath) return read(path);
        reads += 1;
        if (kind === "missing") throw missing;
        return (kind === "lone surrogate" ? "\ud800" : kind === "boxed source" ? boxed : undefined) as never;
      });
      if (kind === "missing")
        expect(compositionFailure(() => actual.readPinnedPreparationOperand(remainderPreparationPath))).toBe(missing);
      else
        expectCompositionError(
          () => actual.readPinnedPreparationOperand(remainderPreparationPath),
          "runtime preparation policy evolution: " +
            (kind === "lone surrogate"
              ? "current remainder preparation source is not UTF-8"
              : "primitive current remainder preparation source required"),
        );
      expect(reads).toBe(1);
      expect(coercions).toBe(0);
      independentlyAcquireNumberComposition();
    },
  );
});

// Fresh Node process, genuine native TS loader, exact physical loaded H1/root files.
// This string is authored fixture code. It is never evaluated by static packet construction.
const coldNumberRunner = String.raw`
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const [casePath, h1Path, rootPath, receiptFile] = process.argv.slice(2);
if (Number(process.versions.node.split(".")[0]) < 25 || typeof registerHooks !== "function")
  throw new Error("cold C1 epoch requires Node >=25 native TypeScript loader and registerHooks");
const payload = JSON.parse(readFileSync(casePath, "utf8"));
const files = new Map(payload.files);
const h1URL = pathToFileURL(h1Path).href, rootURL = pathToFileURL(rootPath).href;
const loadedSources = [];
const bytePin = (source) => ({
  bytes: Buffer.byteLength(source),
  sha256: createHash("sha256").update(source).digest("hex"),
  gitBlob: createHash("sha1").update("blob " + Buffer.byteLength(source) + "\0").update(source).digest("hex"),
});
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === h1URL && specifier === "./ir-c1-authority-root.js")
      return nextResolve(rootURL, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url === h1URL || url === rootURL) {
      if (result.source === undefined || result.source === null)
        throw new Error("cold C1 native loader did not expose actual TS source bytes");
      const source = Buffer.from(result.source).toString("utf8");
      if (!Buffer.from(source).equals(Buffer.from(result.source)))
        throw new Error("cold C1 native loaded source is not exact UTF-8");
      loadedSources.push({ url, format: result.format, source, pin: bytePin(source) });
    }
    return result;
  },
});
const h1 = await import(h1URL);
const loadedRoot = await import(rootURL);
const descriptor = Object.getOwnPropertyDescriptor(loadedRoot, "c1GeometrySuccessorSha256");
if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string")
  throw new Error("cold C1 root did not load a primitive own data digest export");
const policyMissing = new Error(payload.policyCapture?.missingMessage ?? "slice policy authority missing");
let policyMutation = false;
const capture = () => {
  const readerOperands = [];
  let acceptance = 0, failure, missingIdentity = false;
  const reader = (path) => {
    let source;
    if (path === payload.historicalPath) source = readFileSync(h1Path, "utf8");
    else if (path === payload.anchorPath) source = readFileSync(rootPath, "utf8");
    else if (path === payload.receiptPath) source = readFileSync(receiptFile, "utf8");
    else if (files.has(path)) {
      if (policyMutation && path === "scripts/compiler-boundaries.json" && payload.policyCapture?.fault === "missing") {
        readerOperands.push([path, files.get(path)]);
        throw policyMissing;
      }
      source = files.get(path);
      if (policyMutation && path === "scripts/compiler-boundaries.json") source += "\n";
    }
    else throw new Error("cold C1 unexpected reader path: " + path);
    readerOperands.push([path, source]);
    return source;
  };
  let historical;
  try {
    if (payload.policyCapture) {
      historical = h1.captureGeometryCurrentMainPredecessorPolicySource(payload.policyCapture.source, reader);
    } else {
      const result = h1.captureC1HistoricalAuthority(reader);
      historical = result.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts");
    }
    acceptance += 1;
  } catch (error) {
    missingIdentity = error === policyMissing;
    failure = { isError: error instanceof Error, name: error?.name, message: error?.message };
  }
  return { acceptance, failure, missingIdentity, readerOperands, historical };
};
const phases = [capture()];
let policyPriority;
if (payload.policyCapture?.action === "fresh") {
  policyMutation = true; phases.push(capture());
  policyMutation = false; phases.push(capture());
}
if (payload.policyCapture?.action === "priority") {
  let reads = 0, coercions = 0;
  const reader = () => { reads++; throw new Error("slice policy IO bomb"); };
  const boxed = { toString() { coercions++; return "source"; } };
  const errors = [];
  for (const [source, authority] of [[boxed, reader], ["source", null]]) {
    try { h1.captureGeometryCurrentMainPredecessorPolicySource(source, authority); errors.push(null); }
    catch (error) { errors.push({ isError: error instanceof Error, name: error?.name, message: error?.message }); }
  }
  policyPriority = { reads, coercions, errors };
}
let warmRestoration;
if (payload.warmFault) {
  const physical = payload.warmFault.path === payload.anchorPath ? rootPath
    : payload.warmFault.path === payload.receiptPath ? receiptFile : undefined;
  if (!physical) throw new Error("cold C1 warm fault outside exact root/receipt domain");
  const original = readFileSync(physical, "utf8"), before = statSync(physical);
  try {
    writeFileSync(physical, payload.warmFault.source);
    phases.push(capture());
  } finally {
    writeFileSync(physical, original);
    const after = statSync(physical);
    warmRestoration = {
      before: bytePin(original), after: bytePin(readFileSync(physical, "utf8")),
      modeBefore: before.mode & 0o7777, modeAfter: after.mode & 0o7777,
      sameIdentity: before.dev === after.dev && before.ino === after.ino,
    };
  }
  phases.push(capture());
}
process.stdout.write(JSON.stringify({ loadedSources, loadedRootDigest: descriptor.value, phases, warmRestoration, policyPriority }));
`;
type ColdNumberResult = {
  loadedSources: { url: string; format: string; source: string; pin: GeometryPin }[];
  loadedRootDigest: string;
  phases: {
    evidenceDirectory: string;
    acceptance: number;
    failure?: { isError: boolean; name: string; message: string };
    readerOperands: [string, string][];
    historical?: string;
    missingIdentity?: boolean;
  }[];
  policyPriority?: { reads: number; coercions: number; errors: { isError: boolean; name: string; message: string }[] };
  warmRestoration?: {
    before: GeometryPin;
    after: GeometryPin;
    modeBefore: number;
    modeAfter: number;
    sameIdentity: boolean;
  };
};
async function runColdNumberEpoch(
  h1Source: string,
  rootSource: string,
  fileSources: Map<string, string>,
  warmFault?: { path: string; source: string },
  policyCapture?: {
    source: string;
    action?: "fresh" | "priority";
    fault?: "mutation" | "missing";
    missingMessage?: "canonical policy authority missing" | "canonical17 policy authority missing";
  },
): Promise<ColdNumberResult> {
  const suppliedScratch = process.env.JS2_C1_EVIDENCE_ROOT;
  const scratch = suppliedScratch === undefined ? resolve(root, ".tmp") : suppliedScratch;
  if (suppliedScratch !== undefined) {
    expect(suppliedScratch).toBe(resolve(suppliedScratch));
    expect(lstatSync(scratch).isDirectory()).toBe(true);
    expect(realpathSync(scratch)).toBe(scratch);
  }
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(resolve(scratch, "c1-number-cold-loader-"));
  const h1File = resolve(directory, "historical.ts"),
    rootFile = resolve(directory, "ir-c1-authority-root.ts");
  const receiptFile = resolve(directory, "receipt.json"),
    runnerFile = resolve(directory, "runner.mjs"),
    caseFile = resolve(directory, "case.json");
  const sources = new Map([
    [h1File, h1Source],
    [rootFile, rootSource],
    [receiptFile, fileSources.get(successorReceiptPath)!],
    [runnerFile, coldNumberRunner],
    [
      caseFile,
      JSON.stringify({
        files: [...fileSources],
        historicalPath: historicalCallerPath,
        anchorPath,
        receiptPath: successorReceiptPath,
        warmFault,
        policyCapture,
      }),
    ],
  ]);
  try {
    for (const [path, source] of sources) {
      compositionPrimitiveBytes(source);
      writeFileSync(path, source, { flag: "wx", mode: 0o644 });
      chmodSync(path, 0o644);
      expect(readFileSync(path, "utf8")).toBe(source);
    }
    const processResult = await new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
      output: string;
      failure?: Error;
    }>((settle) => {
      const chunks: Buffer[] = [];
      let count = 0,
        failure: Error | undefined;
      const stdoutFile = resolve(directory, "stdout.log"),
        stderrFile = resolve(directory, "stderr.log");
      writeFileSync(stdoutFile, "", { flag: "wx", mode: 0o644 });
      writeFileSync(stderrFile, "", { flag: "wx", mode: 0o644 });
      const child = spawn(process.execPath, [runnerFile, caseFile, h1File, rootFile, receiptFile], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      const rememberFailure = (error: Error): void => {
        failure ??= error;
      };
      const retainChunk = (path: string, chunk: Buffer): void => {
        try {
          writeFileSync(path, chunk, { flag: "a" });
        } catch (error) {
          rememberFailure(error instanceof Error ? error : new Error("cold C1 log write failed", { cause: error }));
        }
      };
      const collect = (chunk: Buffer): void => {
        retainChunk(stdoutFile, chunk);
        count += chunk.length;
        if (count <= 16 * 1024 * 1024) chunks.push(chunk);
        else
          rememberFailure(
            new Error("cold C1 child exceeded retained 16 MiB parsing limit; full output remains on disk"),
          );
      };
      const stderr: Buffer[] = [];
      child.stdout.on("data", collect);
      child.stderr.on("data", (chunk: Buffer) => {
        retainChunk(stderrFile, chunk);
        count += chunk.length;
        if (count <= 16 * 1024 * 1024) stderr.push(chunk);
        else
          rememberFailure(
            new Error("cold C1 child exceeded retained 16 MiB parsing limit; full output remains on disk"),
          );
      });
      child.stdout.on("error", rememberFailure);
      child.stderr.on("error", rememberFailure);
      child.on("error", rememberFailure);
      // No timer, cancellation, signal, kill or alternate result: await the actual natural close.
      child.on("close", (status, signal) => {
        if (status !== 0 || signal !== null)
          failure ??= new Error(
            "cold C1 child natural exit " + status + "/" + signal + ": " + Buffer.concat(stderr).toString("utf8"),
          );
        settle({ status, signal, output: Buffer.concat(chunks).toString("utf8"), failure });
      });
    });
    expect(processResult.failure, processResult.output).toBeUndefined();
    expect(processResult.signal).toBeNull();
    expect(processResult.status).toBe(0);
    const result = JSON.parse(processResult.output) as ColdNumberResult;
    expect(result.phases).toHaveLength(warmFault !== undefined || policyCapture?.action === "fresh" ? 3 : 1);
    expect(result.loadedSources.map((value) => value.url)).toEqual([
      pathToFileURL(h1File).href,
      pathToFileURL(rootFile).href,
    ]);
    expect(result.loadedSources.map((value) => value.source)).toEqual([h1Source, rootSource]);
    expect(result.loadedSources.map((value) => value.pin)).toEqual([pin(h1Source), pin(rootSource)]);
    expect(result.loadedSources.every((value) => value.format === "module-typescript")).toBe(true);
    expect(result.loadedRootDigest).toBe(rootSource.match(/c1GeometrySuccessorSha256 = "([a-f0-9]{64})";/)![1]);
    for (const [path, source] of sources) {
      expect(readFileSync(path, "utf8")).toBe(source);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(lstatSync(path).mode & 0o7777).toBe(0o644);
    }
    // Retain all physical files and natural-close logs through downstream exact phase assertions.
    for (const phase of result.phases) phase.evidenceDirectory = directory;
    return result;
  } catch (error) {
    throw new Error("cold C1 context failed; complete scratch evidence retained at " + directory, { cause: error });
  }
}
function coldNumberInputs() {
  const acquired = independentlyAcquireNumberComposition();
  const files = new Map(independentNumberHistoricalTrace.map((path) => [path, read(path)]));
  files.set(historicalCallerPath, acquired.h1);
  files.set(anchorPath, acquired.thirteenFreeze.anchorSource);
  files.set(successorReceiptPath, acquired.thirteenReceipt);
  return { ...acquired, files };
}
function assertColdPhase(
  phase: ColdNumberResult["phases"][number],
  expectedFiles: Map<string, string>,
  message?: string,
): void {
  try {
    const trace =
      message === undefined
        ? [...independentNumberHistoricalTrace]
        : message.includes("fixed geometry caller current pin") ||
            message.includes("geometry instrument predecessor domain") ||
            message.includes("geometry instrument population") ||
            message.includes("exact object keys") ||
            message.includes("fixed source domain") ||
            message.includes("geometry instrument receipt digest mismatch") ||
            message.includes("full-file pin changed: " + historicalCallerPath)
          ? independentNumberHistoricalTrace.slice(
              0,
              independentNumberHistoricalTrace.indexOf(successorReceiptPath) + 1,
            )
          : message.includes("warm anchor source changed")
            ? [anchorPath]
            : independentNumberHistoricalTrace.slice(0, independentNumberHistoricalTrace.indexOf(numberCallerPath) + 1);
    expect(phase.readerOperands.map(([path]) => path)).toEqual(trace);
    expect(phase.readerOperands.length).toBeGreaterThan(0);
    for (const [path, source] of phase.readerOperands) expect(source).toBe(expectedFiles.get(path));
    if (message === undefined) {
      expect(phase.acceptance).toBe(1);
      expect(phase.failure).toBeUndefined();
      expect(phase.historical).toBe(expectedFiles.get(c1HistoricalArtifactPath(remainderPolicyPath)));
      expect(Buffer.byteLength(phase.historical!)).toBe(93405);
    } else {
      expect(phase.acceptance).toBe(0);
      expect(phase.failure).toEqual({ isError: true, name: "Error", message });
    }
  } catch (error) {
    throw new Error("cold C1 exact phase failed; complete scratch evidence retained at " + phase.evidenceDirectory, {
      cause: error,
    });
  }
}

function coldNumberState(
  input: ReturnType<typeof coldNumberInputs>,
  h1Old: boolean,
  receiptOld: boolean,
  numberOld: boolean,
) {
  const files = new Map(input.files);
  const h1 = h1Old ? input.sources.get(historicalCallerPath)! : input.h1;
  const anchor = receiptOld ? input.oldFreeze.anchorSource : input.thirteenFreeze.anchorSource;
  files.set(historicalCallerPath, h1);
  files.set(anchorPath, anchor);
  files.set(successorReceiptPath, receiptOld ? input.oldReceipt : input.thirteenReceipt);
  files.set(numberCallerPath, numberOld ? input.sources.get(numberCallerPath)! : read(numberCallerPath));
  return { files, h1, anchor };
}
async function healthyColdNumberEpochs(input: ReturnType<typeof coldNumberInputs>): Promise<void> {
  for (const old of [true, false]) {
    const state = coldNumberState(input, old, old, old);
    const result = await runColdNumberEpoch(state.h1, state.anchor, state.files);
    expect(result.phases).toHaveLength(1);
    assertColdPhase(result.phases[0]!, state.files);
  }
}

describe("C1 genuine independently loaded Number old and new epochs", () => {
  it("naturally loads and captures valid complete R1 A1 N1 H1a and R2 A2 N2 H1b epochs separately", async () => {
    const input = coldNumberInputs();
    await healthyColdNumberEpochs(input);
    independentlyAcquireNumberComposition();
  });
  it.each([
    [
      true,
      true,
      false,
      "C1 historical authority: full-file pin changed: tests/issue-3518-number-prerequisite-policy-evolution.test.ts geometry current",
    ],
    [
      true,
      false,
      true,
      "C1 historical authority: fixed geometry caller current pin: tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    ],
    [
      true,
      false,
      false,
      "C1 historical authority: fixed geometry caller current pin: tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    ],
    [
      false,
      true,
      true,
      "C1 historical authority: fixed geometry caller current pin: tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    ],
    [
      false,
      true,
      false,
      "C1 historical authority: fixed geometry caller current pin: tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    ],
    [
      false,
      false,
      true,
      "C1 historical authority: full-file pin changed: tests/issue-3518-number-prerequisite-policy-evolution.test.ts geometry current",
    ],
  ] as const)(
    "genuinely cold-loads H1old=%s receiptOld=%s NumberOld=%s and refuses the mixed epoch",
    async (h1Old, receiptOld, numberOld, message) => {
      const input = coldNumberInputs();
      await healthyColdNumberEpochs(input);
      const state = coldNumberState(input, h1Old, receiptOld, numberOld);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files);
      expect(result.phases).toHaveLength(1);
      assertColdPhase(result.phases[0]!, state.files, message);
      await healthyColdNumberEpochs(input);
      independentlyAcquireNumberComposition();
    },
  );
  it.each(["Number contract literal", "fixed caller comparison"] as const)(
    "loads the actual H1 source guard fault %s and refuses before restoring exact epochs",
    async (fault) => {
      const input = coldNumberInputs();
      await healthyColdNumberEpochs(input);
      const state = coldNumberState(input, false, false, false);
      const fixedComparison =
        '    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);\n';
      const literal = h1CallerStage.inverse[0].from;
      const changedLiteral = literal.replace(numberCallerStage.currentPin.sha256, "0".repeat(64));
      const mutant =
        fault === "Number contract literal"
          ? replaceOnce(state.h1, literal, changedLiteral)
          : replaceOnce(state.h1, fixedComparison, "    // owned negative control: fixed current comparison removed\n");
      state.files.set(historicalCallerPath, mutant);
      const result = await runColdNumberEpoch(mutant, state.anchor, state.files);
      assertColdPhase(
        result.phases[0]!,
        state.files,
        fault === "Number contract literal"
          ? "C1 historical authority: fixed geometry caller current pin: " + numberCallerPath
          : "C1 historical authority: full-file pin changed: " + historicalCallerPath + " geometry current",
      );
      await healthyColdNumberEpochs(input);
      independentlyAcquireNumberComposition();
    },
  );
  it.each([
    [
      "Number current pin",
      "fixed geometry caller current pin: tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    ],
    ["Number before pin", "geometry instrument predecessor domain"],
    ["record path", "geometry instrument predecessor domain"],
    ["record order", "geometry instrument predecessor domain"],
    ["record count", "geometry instrument population"],
    ["record key", "exact object keys: geometry instrument"],
    ["receipt key", "exact object keys: geometry instrument receipt"],
    ["CABI source", "cabiSource fixed source domain"],
    ["policy source", "policySource fixed source domain"],
    ["resolver configuration", "geometry resolver configuration changed"],
    ["unrelated closure", "geometry-only closure successor"],
  ] as const)(
    "cold-loads an independently bound negative root for the exact receipt-domain fault %s",
    async (fault, detail) => {
      const input = coldNumberInputs();
      await healthyColdNumberEpochs(input);
      const state = coldNumberState(input, false, false, false);
      const receipt = JSON.parse(state.files.get(successorReceiptPath)!) as any;
      if (fault === "Number current pin") receipt.instruments[6].currentPin.bytes += 1;
      if (fault === "Number before pin") receipt.instruments[6].beforePin.bytes += 1;
      if (fault === "record path") receipt.instruments[6].path += ".foreign";
      if (fault === "record order")
        [receipt.instruments[5], receipt.instruments[6]] = [receipt.instruments[6], receipt.instruments[5]];
      if (fault === "record count") receipt.instruments.pop();
      if (fault === "record key") receipt.instruments[6].extra = true;
      if (fault === "receipt key") receipt.extra = true;
      if (fault === "CABI source") receipt.cabiSource.path += ".foreign";
      if (fault === "policy source") receipt.policySource.path += ".foreign";
      if (fault === "resolver configuration") receipt.linearOptions.resolver.optionsSha256 = "0".repeat(64);
      if (fault === "unrelated closure") receipt.linearOptions.closureInputs[0].pin.bytes += 1;
      const changedReceipt = JSON.stringify(receipt, null, 2) + "\n";
      // Only this deliberately authored negative operand receives a corresponding physical root.
      // Healthy expected R2/A2 values remain the independent reviewed literals above.
      const negativeAnchor = replaceOnce(state.anchor, input.thirteenFreeze.receiptPin.sha256, digest(changedReceipt));
      state.files.set(successorReceiptPath, changedReceipt);
      state.files.set(anchorPath, negativeAnchor);
      const result = await runColdNumberEpoch(state.h1, negativeAnchor, state.files);
      assertColdPhase(result.phases[0]!, state.files, "C1 historical authority: " + detail);
      await healthyColdNumberEpochs(input);
      independentlyAcquireNumberComposition();
    },
  );
  it.each([anchorPath, successorReceiptPath] as const)(
    "retains loaded A2 while freshly refusing the physical old %s and restores its exact bytes and identity",
    async (path) => {
      const input = coldNumberInputs();
      const state = coldNumberState(input, false, false, false);
      const source = path === anchorPath ? input.oldFreeze.anchorSource : input.oldReceipt;
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, { path, source });
      expect(result.phases).toHaveLength(3);
      assertColdPhase(result.phases[0]!, state.files);
      const faultFiles = new Map(state.files);
      faultFiles.set(path, source);
      assertColdPhase(
        result.phases[1]!,
        faultFiles,
        path === anchorPath
          ? "C1 historical authority: warm anchor source changed"
          : "C1 historical authority: geometry instrument receipt digest mismatch",
      );
      assertColdPhase(result.phases[2]!, state.files);
      expect(result.loadedRootDigest).toBe(input.thirteenFreeze.receiptPin.sha256);
      expect(result.warmRestoration).toEqual({
        before: pin(state.files.get(path)!),
        after: pin(state.files.get(path)!),
        modeBefore: 0o644,
        modeAfter: 0o644,
        sameIdentity: true,
      });
      independentlyAcquireNumberComposition();
    },
  );
});

describe("C1 composed complete seven-instrument epoch association", () => {
  it("refuses an original H1 operand mixed with the six accepted current operands at the complete epoch guard", () => {
    const { originalPublished } = independentlyAcquireNumberComposition();
    const original = originalPublished.get(historicalCallerPath)!;
    compositionPin(original, h1CallerOld.beforePin);
    expectCompositionError(
      () => currentHistoricalAuthority(replaced(historicalCallerPath, original)),
      "C1 historical authority: full-file pin changed: complete geometry instrument epoch",
    );
    independentlyAcquireNumberComposition();
  });
});

// Independent fixed row/pins from genuine dbf5 and b38 source operands, never helper answers.
const slicePolicyEpoch = {
  commit: "b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771",
  parent: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",
  beforePin: {
    bytes: 606971,
    sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",
    gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",
  },
  currentPin: {
    bytes: 607104,
    sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",
    gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",
  },
  inverse: [
    {
      inputOffset: 97949,
      outputOffset: 97949,
      from: '    {\n      "path": "src/codegen-linear/runtime/string-slice.ts",\n      "state": "unmigrated",\n      "layer": "legacy-linear"\n    },\n',
      to: "",
    },
  ],
  forward: [
    {
      inputOffset: 97949,
      outputOffset: 97949,
      from: "",
      to: '    {\n      "path": "src/codegen-linear/runtime/string-slice.ts",\n      "state": "unmigrated",\n      "layer": "legacy-linear"\n    },\n',
    },
  ],
} as const;
const slicePolicyPath = "scripts/compiler-boundaries.json";
const slicePolicyReadOrder = [anchorPath, successorReceiptPath, slicePolicyPath] as const;
function slicePolicyHealthy() {
  const acquired = independentlyAcquireFourteenSuccessor();
  expect(acquired.receipt.policySource.epochs).toHaveLength(14);
  expect(acquired.receipt.policySource.epochs[13]).toEqual(slicePolicyEpoch);
  const current = acquired.fourteenPolicy;
  expect(pin(current)).toEqual(slicePolicyEpoch.currentPin);
  const intermediate = independentlyAcquireFixtureEpoch(current, {
    path: slicePolicyPath,
    ...slicePolicyEpoch,
  });
  expect(pin(intermediate)).toEqual(slicePolicyEpoch.beforePin);
  const old = JSON.parse(intermediate),
    live = JSON.parse(current);
  expect(old.files).toHaveLength(1899);
  expect(live.files).toHaveLength(1900);
  expect(live.files[155]).toEqual({
    path: "src/codegen-linear/runtime/string-slice.ts",
    state: "unmigrated",
    layer: "legacy-linear",
  });
  expect(live.files[154].path).toBe("src/codegen-linear/runtime.ts");
  expect(live.files[156].path).toBe("src/codegen-linear/simd.ts");
  expect(live.files.filter((_row: unknown, index: number) => index !== 155)).toEqual(old.files);
  expect({ ...live, files: old.files }).toEqual(old);
  const predecessor = independentSuccessorSourceBefore(current, acquired.receipt.policySource);
  return { ...acquired, current, intermediate, predecessor };
}
function sliceColdFiles(input: ReturnType<typeof slicePolicyHealthy>) {
  return new Map<string, string>([
    [historicalCallerPath, input.h1],
    [anchorPath, input.fourteenFreeze.anchorSource],
    [successorReceiptPath, input.fourteenReceipt],
    [slicePolicyPath, input.current],
  ]);
}
function assertColdSlicePhase(result: ColdNumberResult, files: Map<string, string>, expected: string, error?: string) {
  expect(result.phases).toHaveLength(1);
  const phase = result.phases[0]!;
  expect(phase.readerOperands.map(([path]) => path)).toEqual(
    error?.includes("policySource supplied current") || error?.includes("fixed source domain")
      ? slicePolicyReadOrder.slice(0, 2)
      : slicePolicyReadOrder,
  );
  for (const [path, source] of phase.readerOperands) expect(source).toBe(files.get(path));
  if (error === undefined) {
    expect(phase.acceptance).toBe(1);
    expect(phase.failure).toBeUndefined();
    expect(phase.historical).toBe(expected);
  } else {
    expect(phase.acceptance).toBe(0);
    expect(phase.failure).toEqual({ isError: true, name: "Error", message: error });
  }
}
// Only explicit negative fixtures receive new physical roots and source-pin metadata.
// Unchanged engines/rules execute against fully replayed negative H1/source operands.
function diagnosticSliceState(input: ReturnType<typeof slicePolicyHealthy>, changed: string) {
  const old = Buffer.from(input.intermediate),
    current = Buffer.from(changed);
  let start = 0,
    suffix = 0;
  while (start < old.length && start < current.length && old[start] === current[start]) start++;
  while (
    suffix < old.length - start &&
    suffix < current.length - start &&
    old[old.length - 1 - suffix] === current[current.length - 1 - suffix]
  )
    suffix++;
  const from = current.subarray(start, current.length - suffix).toString("utf8");
  const to = old.subarray(start, old.length - suffix).toString("utf8");
  expect(from).not.toBe(to);
  const inverse = [{ inputOffset: start, outputOffset: start, from, to }];
  const forward = [{ inputOffset: start, outputOffset: start, from: to, to: from }];
  expect(
    independentlyReplaySuccessorSpans(changed, inverse, "negative policy inverse", slicePolicyEpoch.beforePin),
  ).toBe(input.intermediate);
  expect(independentlyReplaySuccessorSpans(input.intermediate, forward, "negative policy forward", pin(changed))).toBe(
    changed,
  );
  const contract = sliceH1Stage.forward[0].to;
  const changedPin = pin(changed);
  const negativeContract = replaceOnce(
    replaceOnce(
      replaceOnce(contract, "bytes: 607104", "bytes: " + changedPin.bytes),
      slicePolicyEpoch.currentPin.sha256,
      changedPin.sha256,
    ),
    slicePolicyEpoch.currentPin.gitBlob,
    changedPin.gitBlob,
  );
  const h1 = replaceOnce(input.h1, contract, negativeContract);
  const receipt = structuredClone(input.receipt);
  const h1Record = receipt.instruments[0]!;
  h1Record.currentPin = pin(h1);
  const inverseH1 = h1Record.inverse.filter((span) => span.from.includes(contract));
  const forwardH1 = h1Record.forward.filter((span) => span.to.includes(contract));
  expect(inverseH1).toHaveLength(1);
  expect(forwardH1).toHaveLength(1);
  inverseH1[0]!.from = replaceOnce(inverseH1[0]!.from, contract, negativeContract);
  forwardH1[0]!.to = replaceOnce(forwardH1[0]!.to, contract, negativeContract);
  const original = independentlyReplaySuccessorSpans(h1, h1Record.inverse, "negative H1 inverse", h1Record.beforePin);
  expect(original).toBe(input.originalPublished.get(historicalCallerPath));
  expect(independentlyReplaySuccessorSpans(original, h1Record.forward, "negative H1 forward", pin(h1))).toBe(h1);
  receipt.policySource.currentPin = changedPin;
  const last = receipt.policySource.epochs[13]!;
  last.currentPin = changedPin;
  last.inverse = inverse;
  last.forward = forward;
  const text = JSON.stringify(receipt, null, 2) + "\n";
  const anchor = replaceOnce(input.fourteenFreeze.anchorSource, input.fourteenFreeze.receiptPin.sha256, digest(text));
  const files = sliceColdFiles(input);
  files.set(historicalCallerPath, h1);
  files.set(anchorPath, anchor);
  files.set(successorReceiptPath, text);
  files.set(slicePolicyPath, changed);
  return { h1, anchor, files };
}

async function healthyColdSlice(input: ReturnType<typeof slicePolicyHealthy>) {
  const files = sliceColdFiles(input);
  const result = await runColdNumberEpoch(input.h1, input.fourteenFreeze.anchorSource, files, undefined, {
    source: input.current,
  });
  assertColdSlicePhase(result, files, input.predecessor);
  return result;
}
describe("C1 independent fourteenth slice-policy current association", () => {
  it("genuinely loads the fixed archived thirteen-policy context and reaches its original predecessor", async () => {
    const input = slicePolicyHealthy(),
      historical = independentlyAcquireThirteenSuccessor();
    const files = sliceColdFiles(input);
    files.set(historicalCallerPath, historical.h1);
    files.set(anchorPath, historical.thirteenFreeze.anchorSource);
    files.set(successorReceiptPath, historical.thirteenReceipt);
    files.set(slicePolicyPath, input.intermediate);
    const result = await runColdNumberEpoch(historical.h1, historical.thirteenFreeze.anchorSource, files, undefined, {
      source: input.intermediate,
    });
    assertColdSlicePhase(result, files, input.predecessor);
    slicePolicyHealthy();
  });
  it("proves all fourteen current epochs, exact thirteen intermediate and loaded current public API", async () => {
    const input = slicePolicyHealthy();
    const files = sliceColdFiles(input);
    const result = await runColdNumberEpoch(input.h1, input.fourteenFreeze.anchorSource, files, undefined, {
      source: input.current,
    });
    assertColdSlicePhase(result, files, input.predecessor);
    slicePolicyHealthy();
  });
  it.each(["whitespace", "inserted-row byte", "old thirteen"] as const)(
    "refuses supplied current full-source fault %s at the fixed hash before physical policy read",
    async (fault) => {
      const input = slicePolicyHealthy();
      await healthyColdSlice(input);
      const changed =
        fault === "old thirteen"
          ? input.intermediate
          : fault === "whitespace"
            ? input.current + "\n"
            : replaceOnce(
                input.current,
                '"path": "src/codegen-linear/runtime/string-slice.ts"',
                '"path": "src/codegen-linear/runtime/string-slicf.ts"',
              );
      const files = sliceColdFiles(input);
      const result = await runColdNumberEpoch(input.h1, input.fourteenFreeze.anchorSource, files, undefined, {
        source: changed,
      });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        "C1 historical authority: full-file pin changed: policySource supplied current",
      );
      await healthyColdSlice(input);
      slicePolicyHealthy();
    },
  );
  it.each(["mutation", "missing"] as const)(
    "freshly refuses physical policy %s after success and restores a healthy repeat",
    async (fault) => {
      const input = slicePolicyHealthy(),
        files = sliceColdFiles(input);
      const result = await runColdNumberEpoch(input.h1, input.fourteenFreeze.anchorSource, files, undefined, {
        source: input.current,
        action: "fresh",
        fault,
      });
      expect(result.phases).toHaveLength(3);
      for (const index of [0, 2])
        assertColdSlicePhase({ ...result, phases: [result.phases[index]!] }, files, input.predecessor);
      const failedFiles = new Map(files);
      if (fault === "mutation") failedFiles.set(slicePolicyPath, input.current + "\n");
      assertColdSlicePhase(
        { ...result, phases: [result.phases[1]!] },
        failedFiles,
        input.predecessor,
        fault === "missing"
          ? "slice policy authority missing"
          : "C1 historical authority: full-file pin changed: policySource actual current",
      );
      expect(result.phases[1]!.missingIdentity).toBe(fault === "missing");
      slicePolicyHealthy();
    },
  );
  it("retains primitive and callable-first zero-reader-IO priorities", async () => {
    const input = slicePolicyHealthy();
    const result = await runColdNumberEpoch(
      input.h1,
      input.fourteenFreeze.anchorSource,
      sliceColdFiles(input),
      undefined,
      { source: input.current, action: "priority" },
    );
    assertColdSlicePhase(result, sliceColdFiles(input), input.predecessor);
    expect(result.policyPriority).toEqual({
      reads: 0,
      coercions: 0,
      errors: [
        {
          isError: true,
          name: "Error",
          message: "C1 historical authority: current-main geometry policy must be a primitive string",
        },
        {
          isError: true,
          name: "Error",
          message: "C1 historical authority: current-main geometry policy authority reader must be callable",
        },
      ],
    });
    await healthyColdSlice(input);
    slicePolicyHealthy();
  });
  it.each(["inverse offset", "inverse payload", "forward-only payload"] as const)(
    "reaches the exact new policy recipe detector for %s under an independent negative root",
    async (fault) => {
      const input = slicePolicyHealthy(),
        receipt = structuredClone(input.receipt);
      const last = receipt.policySource.epochs[13]!;
      if (fault === "inverse offset") last.inverse[0]!.inputOffset++;
      if (fault === "inverse payload") last.inverse[0]!.from = "x" + last.inverse[0]!.from;
      if (fault === "forward-only payload") last.forward[0]!.to = "x" + last.forward[0]!.to;
      const text = JSON.stringify(receipt, null, 2) + "\n";
      const anchor = replaceOnce(
        input.fourteenFreeze.anchorSource,
        input.fourteenFreeze.receiptPin.sha256,
        digest(text),
      );
      const files = sliceColdFiles(input);
      files.set(anchorPath, anchor);
      files.set(successorReceiptPath, text);
      const result = await runColdNumberEpoch(input.h1, anchor, files, undefined, {
        source: input.current,
      });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        fault === "forward-only payload"
          ? "C1 historical authority: full-file pin changed: policySource forward epoch 14 replay"
          : "C1 historical authority: policySource inverse epoch 14 span membership/coordinates",
      );
      slicePolicyHealthy();
    },
  );
  it.each(["state", "layer", "path", "order", "duplicate", "omission", "unrelated DATA"] as const)(
    "reaches the unchanged semantic rule for current slice-row fault %s",
    async (fault) => {
      const input = slicePolicyHealthy(),
        data = JSON.parse(input.current);
      if (fault === "state") data.files[155].state = "migrated";
      if (fault === "layer") data.files[155].layer = "ir-analysis";
      if (fault === "path") data.files[155].path += ".foreign";
      if (fault === "order") [data.files[154], data.files[155]] = [data.files[155], data.files[154]];
      if (fault === "duplicate") data.files.splice(156, 0, { ...data.files[155] });
      if (fault === "omission") data.files.splice(155, 1);
      if (fault === "unrelated DATA") data.description += " owned negative fixture";
      // Omission has one explicit whitespace edit so inverse can return the exact unchanged13 input.
      const changed = (fault === "omission" ? " " : "") + JSON.stringify(data, null, 2) + "\n";
      expect(changed).not.toBe(input.current);
      await healthyColdSlice(input);
      const ordinaryFiles = sliceColdFiles(input);
      const ordinary = await runColdNumberEpoch(input.h1, input.fourteenFreeze.anchorSource, ordinaryFiles, undefined, {
        source: changed,
      });
      assertColdSlicePhase(
        ordinary,
        ordinaryFiles,
        input.predecessor,
        "C1 historical authority: full-file pin changed: policySource supplied current",
      );
      const state = diagnosticSliceState(input, changed);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: changed });
      const detail =
        fault === "duplicate" || fault === "omission"
          ? "semantic file counts"
          : fault === "unrelated DATA"
            ? "complete semantic replay/retained content"
            : "semantic ordered row/neighbors";
      assertColdSlicePhase(
        result,
        state.files,
        input.predecessor,
        "C1 historical authority: policySource inverse epoch 14 " + detail,
      );
      slicePolicyHealthy();
    },
  );
  it.each(["old H1 with current policy", "current H1 with old receipt"] as const)(
    "cold-loads the genuine mixed policy epoch %s and refuses it",
    async (fault) => {
      const input = slicePolicyHealthy(),
        historical = independentlyAcquireThirteenSuccessor();
      const files = sliceColdFiles(input);
      files.set(historicalCallerPath, fault === "old H1 with current policy" ? historical.h1 : input.h1);
      files.set(anchorPath, historical.thirteenFreeze.anchorSource);
      files.set(successorReceiptPath, historical.thirteenReceipt);
      const result = await runColdNumberEpoch(
        files.get(historicalCallerPath)!,
        historical.thirteenFreeze.anchorSource,
        files,
        undefined,
        { source: input.current },
      );
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        "C1 historical authority: " +
          (fault === "old H1 with current policy"
            ? "full-file pin changed: policySource supplied current"
            : "policySource fixed source domain"),
      );
      slicePolicyHealthy();
    },
  );
});

const canonicalPolicySemanticAuthority = [
  {
    epoch: 15,
    beforeFileCount: 1900,
    currentFileCount: 1903,
    additions: [
      {
        index: 198,
        row: {
          path: "src/codegen/array/array-search-core.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service.",
        },
        previousPath: "src/codegen/array-element-typing.ts",
        nextPath: "src/codegen/array/array-search-proto-value.ts",
      },
      {
        index: 199,
        row: {
          path: "src/codegen/array/array-search-proto-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",
        },
        previousPath: "src/codegen/array/array-search-core.ts",
        nextPath: "src/codegen/array/array-generic-value-bodies.ts",
      },
      {
        index: 200,
        row: {
          path: "src/codegen/array/array-generic-value-bodies.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",
        },
        previousPath: "src/codegen/array/array-search-proto-value.ts",
        nextPath: "src/codegen/array/array-fill-proto-value.ts",
      },
    ],
    layers: [],
    rawInsertionOffset: 110764,
    rawInsertionBytes: 1085,
    rawInsertionSha256: "3d89500da2d723534b8abbfd1591332983a98bd8b03976e1b6b3048627f29759",
    retainedRowsEqual: true,
    otherDataEqual: true,
    rawInverseEqual: true,
    rawForwardEqual: true,
  },
  {
    epoch: 16,
    beforeFileCount: 1903,
    currentFileCount: 1904,
    additions: [
      {
        index: 201,
        row: {
          path: "src/codegen/array/array-copy-methods-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",
        },
        previousPath: "src/codegen/array/array-generic-value-bodies.ts",
        nextPath: "src/codegen/array/array-fill-proto-value.ts",
      },
    ],
    layers: [],
    rawInsertionOffset: 111849,
    rawInsertionBytes: 367,
    rawInsertionSha256: "5aa0d79970ea4774b27e0e0d35ea26e27327f97e69742e260df29994842e3e96",
    retainedRowsEqual: true,
    otherDataEqual: true,
    rawInverseEqual: true,
    rawForwardEqual: true,
  },
] as const;
function canonicalPolicyHealthy() {
  const acquired = independentlyAcquireSixteenSuccessor();
  authenticateCurrentH1Implementation();
  expect(acquired.receipt.policySource.epochs).toHaveLength(16);
  expect(acquired.receipt.policySource.epochs.slice(14)).toEqual(canonicalPolicyEpochs);
  const current = acquired.sixteenPolicy;
  compositionPin(current, canonicalPolicyEpochs[1].currentPin);
  const intermediate = independentlyAcquireFixtureEpoch(current, {
    path: slicePolicyPath,
    ...canonicalPolicyEpochs[1],
  });
  const fourteen = independentlyAcquireFixtureEpoch(intermediate, {
    path: slicePolicyPath,
    ...canonicalPolicyEpochs[0],
  });
  const previous = independentlyAcquireFourteenSuccessor();
  expect(fourteen).toBe(previous.fourteenPolicy);
  const predecessor = independentSuccessorSourceBefore(current, acquired.receipt.policySource);
  expect(pin(predecessor).bytes).toBe(599721);
  const data = JSON.parse(current),
    old = JSON.parse(fourteen),
    fifteenData = JSON.parse(intermediate);
  for (const [index, authority] of canonicalPolicySemanticAuthority.entries()) {
    const sourceData = index === 0 ? fifteenData : data;
    for (const added of authority.additions) {
      expect(sourceData.files[added.index]).toEqual(added.row);
      expect(sourceData.files[added.index - 1].path).toBe(added.previousPath);
      expect(sourceData.files[added.index + 1].path).toBe(added.nextPath);
    }
  }
  expect(data.files).toHaveLength(1904);
  expect(old.files).toHaveLength(1900);
  // Independently fixed source records come from the reviewed genuine introducing-commit packet.
  for (const [index, path] of [
    [198, "src/codegen/array/array-search-core.ts"],
    [199, "src/codegen/array/array-search-proto-value.ts"],
    [200, "src/codegen/array/array-generic-value-bodies.ts"],
    [201, "src/codegen/array/array-copy-methods-value.ts"],
  ] as const) {
    expect(data.files[index].path).toBe(path);
    expect(data.files[index].state).toBe("unmigrated");
    expect(data.files[index].layer).toBe("mixed-needs-split");
    expect(data.files[index].destination).toBe("backend-wasmgc");
    expect(data.files[index].owner).toBe("3518-coordinator");
  }
  expect(data.files.filter((_row: unknown, i: number) => i < 198 || i > 201)).toEqual(old.files);
  expect({ ...data, files: old.files }).toEqual(old);
  return { ...acquired, current, intermediate, fourteen, predecessor };
}
function canonicalColdFiles(input: ReturnType<typeof canonicalPolicyHealthy>) {
  return new Map<string, string>([
    [historicalCallerPath, input.h1],
    [anchorPath, input.sixteenFreeze.anchorSource],
    [successorReceiptPath, input.sixteenReceipt],
    [slicePolicyPath, input.current],
  ]);
}
async function healthyColdCanonical(input: ReturnType<typeof canonicalPolicyHealthy>) {
  const files = canonicalColdFiles(input);
  const result = await runColdNumberEpoch(input.h1, input.sixteenFreeze.anchorSource, files, undefined, {
    source: input.current,
  });
  assertColdSlicePhase(result, files, input.predecessor);
  return result;
}
function canonicalContractLiteral(
  epoch: Pick<SuccessorSource["epochs"][number], "commit" | "parent" | "beforePin" | "currentPin">,
  before: GeometryPin,
  current: GeometryPin,
) {
  const literalPin = (name: string, value: GeometryPin) =>
    `    ${name}: {\n      bytes: ${value.bytes},\n      sha256: "${value.sha256}",\n      gitBlob: "${value.gitBlob}",\n    },\n`;
  return (
    `  {\n    commit: "${epoch.commit}",\n    parent: "${epoch.parent}",\n` +
    literalPin("beforePin", before) +
    literalPin("currentPin", current) +
    "  },\n"
  );
}
// Finite negative fixture recipes reuse the existing independent strict span replayer.
// The healthy authority pins/rules never come from these intentionally malformed operands.
function canonicalNegativeSourceEpoch(
  before: string,
  current: string,
  epoch: Pick<SuccessorSource["epochs"][number], "commit" | "parent" | "beforePin" | "currentPin">,
) {
  const a = Buffer.from(before),
    b = Buffer.from(current);
  let start = 0,
    suffix = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    suffix < a.length - start &&
    suffix < b.length - start &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const from = b.subarray(start, b.length - suffix).toString("utf8"),
    to = a.subarray(start, a.length - suffix).toString("utf8");
  expect(from).not.toBe(to);
  const inverse = [{ inputOffset: start, outputOffset: start, from, to }];
  const forward = [{ inputOffset: start, outputOffset: start, from: to, to: from }];
  expect(independentlyReplaySuccessorSpans(current, inverse, "canonical negative inverse", pin(before))).toBe(before);
  expect(independentlyReplaySuccessorSpans(before, forward, "canonical negative forward", pin(current))).toBe(current);
  return { ...epoch, beforePin: pin(before), currentPin: pin(current), inverse, forward };
}
function canonicalDiagnosticState(
  input: ReturnType<typeof canonicalPolicyHealthy>,
  intermediate: string,
  current: string,
) {
  const receipt = structuredClone(input.receipt);
  const fifteen =
    intermediate === input.intermediate
      ? receipt.policySource.epochs[14]!
      : canonicalNegativeSourceEpoch(input.fourteen, intermediate, canonicalPolicyEpochs[0]);
  const sixteen = canonicalNegativeSourceEpoch(intermediate, current, canonicalPolicyEpochs[1]);
  receipt.policySource.currentPin = pin(current);
  receipt.policySource.epochs[14] = fifteen;
  receipt.policySource.epochs[15] = sixteen;
  let h1 = input.h1;
  for (const [index, negative] of [fifteen, sixteen].entries()) {
    const fixed = canonicalPolicyEpochs[index]!;
    if (index === 0 && intermediate === input.intermediate) {
      expect(negative.beforePin).toEqual(fixed.beforePin);
      expect(negative.currentPin).toEqual(fixed.currentPin);
      const literal = canonicalContractLiteral(fixed, fixed.beforePin, fixed.currentPin);
      expect(canonicalContractLiteral(fixed, negative.beforePin, negative.currentPin)).toBe(literal);
      expect(h1.split(literal)).toHaveLength(2);
      continue;
    }
    h1 = replaceOnce(
      h1,
      canonicalContractLiteral(fixed, fixed.beforePin, fixed.currentPin),
      canonicalContractLiteral(fixed, negative.beforePin, negative.currentPin),
    );
  }
  const record = receipt.instruments[0]!;
  record.currentPin = pin(h1);
  expect(record.inverse.at(-1)!.inputOffset).toBe(45495);
  expect(record.forward.at(-1)!.outputOffset).toBe(45495);
  record.inverse.at(-1)!.from = Buffer.from(h1).subarray(45495).toString("utf8");
  record.forward.at(-1)!.to = Buffer.from(h1).subarray(45495).toString("utf8");
  const original = independentlyReplaySuccessorSpans(
    h1,
    record.inverse,
    "canonical negative H1 inverse",
    record.beforePin,
  );
  expect(original).toBe(input.originalPublished.get(historicalCallerPath));
  expect(independentlyReplaySuccessorSpans(original, record.forward, "canonical negative H1 forward", pin(h1))).toBe(
    h1,
  );
  const text = JSON.stringify(receipt, null, 2) + "\n";
  const anchor = replaceOnce(input.sixteenFreeze.anchorSource, input.sixteenFreeze.receiptPin.sha256, digest(text));
  const files = canonicalColdFiles(input);
  files.set(historicalCallerPath, h1);
  files.set(anchorPath, anchor);
  files.set(successorReceiptPath, text);
  files.set(slicePolicyPath, current);
  return { h1, anchor, files };
}

async function refuseColdCanonicalSupplied(input: ReturnType<typeof canonicalPolicyHealthy>, changed: string) {
  const files = canonicalColdFiles(input);
  const result = await runColdNumberEpoch(input.h1, input.sixteenFreeze.anchorSource, files, undefined, {
    source: changed,
  });
  assertColdSlicePhase(
    result,
    files,
    input.predecessor,
    "C1 historical authority: full-file pin changed: policySource supplied current",
  );
}

describe("C1 independent sixteenth canonical-policy current association", () => {
  it("loads actual fixed16, proves both genuine new source steps and the complete original599721 predecessor", async () => {
    const input = canonicalPolicyHealthy();
    await healthyColdCanonical(input);
    const historical = independentlyAcquireFourteenSuccessor();
    const files = canonicalColdFiles(input);
    files.set(historicalCallerPath, historical.h1);
    files.set(anchorPath, historical.fourteenFreeze.anchorSource);
    files.set(successorReceiptPath, historical.fourteenReceipt);
    files.set(slicePolicyPath, historical.fourteenPolicy);
    const result = await runColdNumberEpoch(historical.h1, historical.fourteenFreeze.anchorSource, files, undefined, {
      source: historical.fourteenPolicy,
    });
    assertColdSlicePhase(result, files, input.predecessor);
    canonicalPolicyHealthy();
  });
  it.each(["old14", "intermediate15", "whitespace", "new-row byte"] as const)(
    "refuses supplied16 source fault %s before physical policy I/O",
    async (fault) => {
      const input = canonicalPolicyHealthy();
      await healthyColdCanonical(input);
      const changed =
        fault === "old14"
          ? input.fourteen
          : fault === "intermediate15"
            ? input.intermediate
            : fault === "whitespace"
              ? input.current + "\n"
              : replaceOnce(
                  input.current,
                  '"path": "src/codegen/array/array-copy-methods-value.ts"',
                  '"path": "src/codegen/array/array-copy-methods-valuf.ts"',
                );
      await refuseColdCanonicalSupplied(input, changed);
      canonicalPolicyHealthy();
    },
  );
  it.each(["mutation", "missing"] as const)(
    "current16 rereads supplied authority %s after success with same missing identity and healthy restoration",
    async (fault) => {
      const input = canonicalPolicyHealthy(),
        files = canonicalColdFiles(input);
      const result = await runColdNumberEpoch(input.h1, input.sixteenFreeze.anchorSource, files, undefined, {
        source: input.current,
        action: "fresh",
        fault,
        missingMessage: "canonical policy authority missing",
      });
      expect(result.phases).toHaveLength(3);
      for (const index of [0, 2])
        assertColdSlicePhase({ ...result, phases: [result.phases[index]!] }, files, input.predecessor);
      const failedFiles = new Map(files);
      if (fault === "mutation") failedFiles.set(slicePolicyPath, input.current + "\n");
      assertColdSlicePhase(
        { ...result, phases: [result.phases[1]!] },
        failedFiles,
        input.predecessor,
        fault === "missing"
          ? "canonical policy authority missing"
          : "C1 historical authority: full-file pin changed: policySource actual current",
      );
      expect(result.phases[1]!.missingIdentity).toBe(fault === "missing");
      canonicalPolicyHealthy();
    },
  );
  it("retains actual16 primitive and callable priorities with zero coercions and authority reads", async () => {
    const input = canonicalPolicyHealthy(),
      files = canonicalColdFiles(input);
    const result = await runColdNumberEpoch(input.h1, input.sixteenFreeze.anchorSource, files, undefined, {
      source: input.current,
      action: "priority",
    });
    assertColdSlicePhase(result, files, input.predecessor);
    expect(result.policyPriority).toEqual({
      reads: 0,
      coercions: 0,
      errors: [
        {
          isError: true,
          name: "Error",
          message: "C1 historical authority: current-main geometry policy must be a primitive string",
        },
        {
          isError: true,
          name: "Error",
          message: "C1 historical authority: current-main geometry policy authority reader must be callable",
        },
      ],
    });
    await healthyColdCanonical(input);
    canonicalPolicyHealthy();
  });
  it.each([14, 15] as const)(
    "reaches each genuine new epoch recipe inverse/forward guards at index%s",
    async (index) => {
      const input = canonicalPolicyHealthy();
      await healthyColdCanonical(input);
      for (const fault of ["inverse offset", "inverse payload", "forward-only payload"] as const) {
        const receipt = structuredClone(input.receipt),
          epoch = receipt.policySource.epochs[index]!;
        if (fault === "inverse offset") epoch.inverse[0]!.inputOffset++;
        if (fault === "inverse payload") epoch.inverse[0]!.from = "x" + epoch.inverse[0]!.from;
        if (fault === "forward-only payload") epoch.forward[0]!.to = "x" + epoch.forward[0]!.to;
        const text = JSON.stringify(receipt, null, 2) + "\n";
        const anchor = replaceOnce(
          input.sixteenFreeze.anchorSource,
          input.sixteenFreeze.receiptPin.sha256,
          digest(text),
        );
        const files = canonicalColdFiles(input);
        files.set(anchorPath, anchor);
        files.set(successorReceiptPath, text);
        const result = await runColdNumberEpoch(input.h1, anchor, files, undefined, {
          source: input.current,
        });
        assertColdSlicePhase(
          result,
          files,
          input.predecessor,
          fault === "forward-only payload"
            ? `C1 historical authority: full-file pin changed: policySource forward epoch ${index + 1} replay`
            : `C1 historical authority: policySource inverse epoch ${index + 1} span membership/coordinates`,
        );
        await healthyColdCanonical(input);
        canonicalPolicyHealthy();
      }
    },
  );
  it.each([198, 199, 200, 201] as const)(
    "reaches unchanged semantic rules for every field/order/omission/duplicate of canonical addition%s",
    async (index) => {
      const input = canonicalPolicyHealthy();
      await healthyColdCanonical(input);
      for (const fault of [
        "state",
        "layer",
        "path",
        "destination",
        "owner",
        "nextBoundary",
        "order",
        "omission",
        "duplicate",
      ] as const) {
        const live = JSON.parse(input.current),
          old = JSON.parse(input.intermediate);
        const change = (data: any) => {
          if (fault === "order")
            [data.files[index - 1], data.files[index]] = [data.files[index], data.files[index - 1]];
          else if (fault === "omission") data.files.splice(index, 1);
          else if (fault === "duplicate") data.files.splice(index, 0, { ...data.files[index] });
          else data.files[index][fault] += " owned negative fixture";
        };
        change(live);
        if (index < 201 && fault !== "omission" && fault !== "duplicate") change(old);
        // Count faults stop at16's fixed counts; semantic15 field/order faults preserve16's retained DATA.
        const intermediate =
          index < 201 && fault !== "omission" && fault !== "duplicate"
            ? JSON.stringify(old, null, 2) + "\n"
            : input.intermediate;
        const current = (fault === "omission" && index === 201 ? " " : "") + JSON.stringify(live, null, 2) + "\n";
        expect(current).not.toBe(input.current);
        await refuseColdCanonicalSupplied(input, current);
        const state = canonicalDiagnosticState(input, intermediate, current);
        const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: current });
        const stage =
          index < 201 &&
          fault !== "omission" &&
          fault !== "duplicate" &&
          !(index === 200 && (fault === "path" || fault === "order"))
            ? 15
            : 16;
        assertColdSlicePhase(
          result,
          state.files,
          input.predecessor,
          `C1 historical authority: policySource inverse epoch ${stage} ` +
            (fault === "omission" || fault === "duplicate" ? "semantic file counts" : "semantic ordered row/neighbors"),
        );
        await healthyColdCanonical(input);
        canonicalPolicyHealthy();
      }
    },
  );
  it.each(["retained row", "layer DATA", "top-level DATA"] as const)(
    "reaches unchanged16 retained-content detector for %s",
    async (fault) => {
      const input = canonicalPolicyHealthy();
      await healthyColdCanonical(input);
      const data = JSON.parse(input.current);
      if (fault === "retained row") data.files[0].state += " owned negative fixture";
      if (fault === "layer DATA") data.layers[0].description += " owned negative fixture";
      if (fault === "top-level DATA") data.description += " owned negative fixture";
      const current = JSON.stringify(data, null, 2) + "\n";
      const state = canonicalDiagnosticState(input, input.intermediate, current);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: current });
      assertColdSlicePhase(
        result,
        state.files,
        input.predecessor,
        "C1 historical authority: policySource inverse epoch 16 " +
          (fault === "retained row"
            ? "semantic retained file rows"
            : fault === "layer DATA"
              ? "semantic unrelated layer drift"
              : "complete semantic replay/retained content"),
      );
      await healthyColdCanonical(input);
      canonicalPolicyHealthy();
    },
  );
  it.each(["old14 H1/current16 policy", "current16 H1/old14 receipt"] as const)(
    "cold-loads exact mixed14/16 association %s and refuses",
    async (fault) => {
      const input = canonicalPolicyHealthy(),
        old = independentlyAcquireFourteenSuccessor();
      await healthyColdCanonical(input);
      const files = canonicalColdFiles(input);
      const h1 = fault === "old14 H1/current16 policy" ? old.h1 : input.h1;
      files.set(historicalCallerPath, h1);
      files.set(anchorPath, old.fourteenFreeze.anchorSource);
      files.set(successorReceiptPath, old.fourteenReceipt);
      const result = await runColdNumberEpoch(h1, old.fourteenFreeze.anchorSource, files, undefined, {
        source: input.current,
      });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        "C1 historical authority: " +
          (fault === "old14 H1/current16 policy"
            ? "full-file pin changed: policySource supplied current"
            : "policySource fixed source domain"),
      );
      await healthyColdCanonical(input);
      canonicalPolicyHealthy();
    },
  );
});

function seventeenthPolicyHealthy() {
  const acquired = independentlyAcquireSeventeenSuccessor();
  authenticateCurrentH1Implementation();
  const old = independentlyAcquireSixteenSuccessor();
  const current = acquired.seventeenPolicy;
  compositionPin(current, seventeenthPolicyEpoch.currentPin);
  expect(acquired.receipt.policySource.epochs).toHaveLength(17);
  expect(acquired.receipt.policySource.epochs[16]).toEqual(seventeenthPolicyEpoch);
  const before = independentlyAcquireFixtureEpoch(current, { path: slicePolicyPath, ...seventeenthPolicyEpoch });
  expect(before).toBe(old.sixteenPolicy);
  const predecessor = independentSuccessorSourceBefore(current, acquired.receipt.policySource);
  expect(pin(predecessor).bytes).toBe(599721);
  const data = JSON.parse(current),
    previous = JSON.parse(before);
  expect(data.files).toHaveLength(seventeenthPolicySemanticAuthority.currentFileCount);
  expect(previous.files).toHaveLength(seventeenthPolicySemanticAuthority.beforeFileCount);
  for (const addition of seventeenthPolicySemanticAuthority.additions) {
    expect(data.files[addition.index]).toEqual(addition.row);
    expect(data.files[addition.index - 1].path).toBe(addition.previousPath);
    expect(data.files[addition.index + 1].path).toBe(addition.nextPath);
  }
  expect(data.files.filter((_row: unknown, index: number) => index !== 202)).toEqual(previous.files);
  expect(data.layers).toEqual(previous.layers);
  expect(data.layers).toHaveLength(20);
  expect({ ...data, files: previous.files }).toEqual(previous);
  return { ...acquired, current, sixteen: before, predecessor, h1: acquired.h1, old };
}
function seventeenthColdFiles(input: ReturnType<typeof seventeenthPolicyHealthy>) {
  return new Map<string, string>([
    [historicalCallerPath, input.h1],
    [anchorPath, input.seventeenFreeze.anchorSource],
    [successorReceiptPath, input.seventeenReceipt],
    [slicePolicyPath, input.current],
  ]);
}
async function healthyColdSeventeenth(input: ReturnType<typeof seventeenthPolicyHealthy>) {
  const files = seventeenthColdFiles(input);
  const result = await runColdNumberEpoch(input.h1, input.seventeenFreeze.anchorSource, files, undefined, {
    source: input.current,
  });
  assertColdSlicePhase(result, files, input.predecessor);
  return result;
}
function seventeenthDiagnosticState(input: ReturnType<typeof seventeenthPolicyHealthy>, current: string) {
  const receipt = structuredClone(input.receipt);
  const negative = canonicalNegativeSourceEpoch(input.sixteen, current, seventeenthPolicyEpoch);
  receipt.policySource.currentPin = negative.currentPin;
  receipt.policySource.epochs[16] = negative;
  const h1 = replaceOnce(
    input.h1,
    canonicalContractLiteral(
      seventeenthPolicyEpoch,
      seventeenthPolicyEpoch.beforePin,
      seventeenthPolicyEpoch.currentPin,
    ),
    canonicalContractLiteral(seventeenthPolicyEpoch, negative.beforePin, negative.currentPin),
  );
  const record = receipt.instruments[0]!;
  record.currentPin = pin(h1);
  expect(record.inverse.at(-1)!.inputOffset).toBe(45495);
  expect(record.forward.at(-1)!.outputOffset).toBe(45495);
  record.inverse.at(-1)!.from = Buffer.from(h1).subarray(45495).toString("utf8");
  record.forward.at(-1)!.to = Buffer.from(h1).subarray(45495).toString("utf8");
  const original = independentlyReplaySuccessorSpans(
    h1,
    record.inverse,
    "seventeenth negative H1 inverse",
    record.beforePin,
  );
  expect(original).toBe(input.originalPublished.get(historicalCallerPath));
  expect(independentlyReplaySuccessorSpans(original, record.forward, "seventeenth negative H1 forward", pin(h1))).toBe(
    h1,
  );
  const text = JSON.stringify(receipt, null, 2) + "\n";
  const anchor = replaceOnce(input.seventeenFreeze.anchorSource, input.seventeenFreeze.receiptPin.sha256, digest(text));
  const files = seventeenthColdFiles(input);
  files.set(historicalCallerPath, h1);
  files.set(anchorPath, anchor);
  files.set(successorReceiptPath, text);
  files.set(slicePolicyPath, current);
  return { h1, anchor, files };
}

describe("C1 independent seventeenth canonical-policy current association", () => {
  it("loads actual fixed17 and genuinely cold16 with reciprocal complete policy and receipt bytes", async () => {
    const input = seventeenthPolicyHealthy();
    await healthyColdSeventeenth(input);
    const historical = canonicalPolicyHealthy();
    expect(historical.current).toBe(input.sixteen);
    await healthyColdCanonical(historical);
    seventeenthPolicyHealthy();
  });
  it.each(["old16", "whitespace", "new-row byte"] as const)(
    "refuses supplied17 source fault %s before physical policy I/O",
    async (fault) => {
      const input = seventeenthPolicyHealthy();
      await healthyColdSeventeenth(input);
      const changed =
        fault === "old16"
          ? input.sixteen
          : fault === "whitespace"
            ? input.current + "\n"
            : replaceOnce(
                input.current,
                '"path": "src/codegen/array/array-sort-value.ts"',
                '"path": "src/codegen/array/array-sort-valuf.ts"',
              );
      const files = seventeenthColdFiles(input);
      const result = await runColdNumberEpoch(input.h1, input.seventeenFreeze.anchorSource, files, undefined, {
        source: changed,
      });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        "C1 historical authority: full-file pin changed: policySource supplied current",
      );
      await healthyColdSeventeenth(input);
      seventeenthPolicyHealthy();
    },
  );
  it.each(["mutation", "missing"] as const)(
    "current17 freshly refuses supplied-reader %s after success with exact Error identity and recovery",
    async (fault) => {
      const input = seventeenthPolicyHealthy(),
        files = seventeenthColdFiles(input);
      await healthyColdSeventeenth(input);
      const result = await runColdNumberEpoch(input.h1, input.seventeenFreeze.anchorSource, files, undefined, {
        source: input.current,
        action: "fresh",
        fault,
        missingMessage: "canonical17 policy authority missing",
      });
      expect(result.phases).toHaveLength(3);
      for (const index of [0, 2])
        assertColdSlicePhase({ ...result, phases: [result.phases[index]!] }, files, input.predecessor);
      const failedFiles = new Map(files);
      if (fault === "mutation") failedFiles.set(slicePolicyPath, input.current + "\n");
      assertColdSlicePhase(
        { ...result, phases: [result.phases[1]!] },
        failedFiles,
        input.predecessor,
        fault === "missing"
          ? "canonical17 policy authority missing"
          : "C1 historical authority: full-file pin changed: policySource actual current",
      );
      expect(result.phases[1]!.missingIdentity).toBe(fault === "missing");
      await healthyColdSeventeenth(input);
      seventeenthPolicyHealthy();
    },
  );
  it("retains actual17 primitive and callable-first priorities with zero coercions and reader I/O", async () => {
    const input = seventeenthPolicyHealthy(),
      files = seventeenthColdFiles(input);
    const result = await runColdNumberEpoch(input.h1, input.seventeenFreeze.anchorSource, files, undefined, {
      source: input.current,
      action: "priority",
    });
    assertColdSlicePhase(result, files, input.predecessor);
    expect(result.policyPriority).toEqual({
      reads: 0,
      coercions: 0,
      errors: [
        {
          isError: true,
          name: "Error",
          message: "C1 historical authority: current-main geometry policy must be a primitive string",
        },
        {
          isError: true,
          name: "Error",
          message: "C1 historical authority: current-main geometry policy authority reader must be callable",
        },
      ],
    });
    await healthyColdSeventeenth(input);
    seventeenthPolicyHealthy();
  });
  it.each(["inverse offset", "inverse payload", "forward-only payload"] as const)(
    "reaches the genuine seventeenth policy recipe detector for %s",
    async (fault) => {
      const input = seventeenthPolicyHealthy();
      await healthyColdSeventeenth(input);
      const receipt = structuredClone(input.receipt),
        epoch = receipt.policySource.epochs[16]!;
      if (fault === "inverse offset") epoch.inverse[0]!.inputOffset++;
      if (fault === "inverse payload") epoch.inverse[0]!.from = "x" + epoch.inverse[0]!.from;
      if (fault === "forward-only payload") epoch.forward[0]!.to = "x" + epoch.forward[0]!.to;
      const text = JSON.stringify(receipt, null, 2) + "\n";
      const anchor = replaceOnce(
        input.seventeenFreeze.anchorSource,
        input.seventeenFreeze.receiptPin.sha256,
        digest(text),
      );
      const files = seventeenthColdFiles(input);
      files.set(anchorPath, anchor);
      files.set(successorReceiptPath, text);
      const result = await runColdNumberEpoch(input.h1, anchor, files, undefined, { source: input.current });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        fault === "forward-only payload"
          ? "C1 historical authority: full-file pin changed: policySource forward epoch 17 replay"
          : "C1 historical authority: policySource inverse epoch 17 span membership/coordinates",
      );
      await healthyColdSeventeenth(input);
      seventeenthPolicyHealthy();
    },
  );
  it("reaches each fixed new-row field, order, omission and duplicate detector at canonical row202", async () => {
    const input = seventeenthPolicyHealthy();
    await healthyColdSeventeenth(input);
    for (const fault of [
      "state",
      "layer",
      "path",
      "destination",
      "owner",
      "nextBoundary",
      "order",
      "omission",
      "duplicate",
    ] as const) {
      const data = JSON.parse(input.current);
      if (fault === "order") [data.files[201], data.files[202]] = [data.files[202], data.files[201]];
      else if (fault === "omission") data.files.splice(202, 1);
      else if (fault === "duplicate") data.files.splice(202, 0, { ...data.files[202] });
      else data.files[202][fault] += " owned negative fixture";
      const current = (fault === "omission" ? " " : "") + JSON.stringify(data, null, 2) + "\n";
      expect(current).not.toBe(input.current);
      const state = seventeenthDiagnosticState(input, current);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: current });
      assertColdSlicePhase(
        result,
        state.files,
        input.predecessor,
        "C1 historical authority: policySource inverse epoch 17 " +
          (fault === "omission" || fault === "duplicate" ? "semantic file counts" : "semantic ordered row/neighbors"),
      );
      await healthyColdSeventeenth(input);
      seventeenthPolicyHealthy();
    }
  });
  it.each(["retained row", "layer DATA", "top-level DATA"] as const)(
    "reaches unchanged17 exact DATA guard for %s",
    async (fault) => {
      const input = seventeenthPolicyHealthy();
      await healthyColdSeventeenth(input);
      const data = JSON.parse(input.current);
      if (fault === "retained row") data.files[0].state += " owned negative fixture";
      if (fault === "layer DATA") data.layers[0].description += " owned negative fixture";
      if (fault === "top-level DATA") data.description += " owned negative fixture";
      const current = JSON.stringify(data, null, 2) + "\n";
      const state = seventeenthDiagnosticState(input, current);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: current });
      assertColdSlicePhase(
        result,
        state.files,
        input.predecessor,
        "C1 historical authority: policySource inverse epoch 17 " +
          (fault === "retained row"
            ? "semantic retained file rows"
            : fault === "layer DATA"
              ? "semantic unrelated layer drift"
              : "complete semantic replay/retained content"),
      );
      await healthyColdSeventeenth(input);
      seventeenthPolicyHealthy();
    },
  );
  it.each(["old16 H1/current17 policy", "current17 H1/old16 receipt"] as const)(
    "cold-loads exact mixed16/17 association %s and refuses",
    async (fault) => {
      const input = seventeenthPolicyHealthy(),
        old = input.old;
      await healthyColdSeventeenth(input);
      const files = seventeenthColdFiles(input),
        h1 = fault === "old16 H1/current17 policy" ? old.h1 : input.h1;
      files.set(historicalCallerPath, h1);
      files.set(anchorPath, old.sixteenFreeze.anchorSource);
      files.set(successorReceiptPath, old.sixteenReceipt);
      const result = await runColdNumberEpoch(h1, old.sixteenFreeze.anchorSource, files, undefined, {
        source: input.current,
      });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        "C1 historical authority: " +
          (fault === "old16 H1/current17 policy"
            ? "full-file pin changed: policySource supplied current"
            : "policySource fixed source domain"),
      );
      await healthyColdSeventeenth(input);
      seventeenthPolicyHealthy();
    },
  );
});
function eighteenthPolicyHealthy() {
  const acquired = independentlyAcquireSuccessor();
  authenticateCurrentH1Implementation();
  const old = independentlyAcquireSeventeenSuccessor();
  const current = read(slicePolicyPath);
  compositionPin(current, eighteenthPolicyEpoch.currentPin);
  expect(acquired.receipt.policySource.epochs).toHaveLength(18);
  expect(acquired.receipt.policySource.epochs[17]).toEqual(eighteenthPolicyEpoch);
  const before = independentlyAcquireFixtureEpoch(current, { path: slicePolicyPath, ...eighteenthPolicyEpoch });
  expect(before).toBe(old.seventeenPolicy);
  const predecessor = independentSuccessorSourceBefore(current, acquired.receipt.policySource);
  expect(pin(predecessor).bytes).toBe(599721);
  const trace: string[] = [];
  const result = captureGeometryCurrentMainPredecessorPolicySource(current, (path) => {
    expect(slicePolicyReadOrder).toContain(path);
    trace.push(path);
    return read(path);
  });
  expect(trace).toEqual(slicePolicyReadOrder);
  expect(result).toBe(predecessor);
  const data = JSON.parse(current),
    previous = JSON.parse(before);
  expect(data.files).toHaveLength(eighteenthPolicySemanticAuthority.currentFileCount);
  expect(previous.files).toHaveLength(eighteenthPolicySemanticAuthority.beforeFileCount);
  for (const addition of eighteenthPolicySemanticAuthority.additions) {
    expect(data.files[addition.index]).toEqual(addition.row);
    expect(data.files[addition.index - 1].path).toBe(addition.previousPath);
    expect(data.files[addition.index + 1].path).toBe(addition.nextPath);
  }
  expect(data.files.filter((_row: unknown, index: number) => index !== 354)).toEqual(previous.files);
  expect(data.layers).toEqual(previous.layers);
  expect(data.layers).toHaveLength(20);
  expect({ ...data, files: previous.files }).toEqual(previous);
  return { ...acquired, current, seventeen: before, predecessor, h1: read(historicalCallerPath), old };
}
function eighteenthColdFiles(input: ReturnType<typeof eighteenthPolicyHealthy>) {
  return new Map<string, string>([
    [historicalCallerPath, input.h1],
    [anchorPath, currentSuccessorFreeze().anchorSource],
    [successorReceiptPath, read(successorReceiptPath)],
    [slicePolicyPath, input.current],
  ]);
}
async function healthyColdEighteenth(input: ReturnType<typeof eighteenthPolicyHealthy>) {
  const files = eighteenthColdFiles(input);
  const result = await runColdNumberEpoch(input.h1, currentSuccessorFreeze().anchorSource, files, undefined, {
    source: input.current,
  });
  assertColdSlicePhase(result, files, input.predecessor);
  return result;
}
function eighteenthDiagnosticState(input: ReturnType<typeof eighteenthPolicyHealthy>, current: string) {
  const receipt = structuredClone(input.receipt);
  const negative = canonicalNegativeSourceEpoch(input.seventeen, current, eighteenthPolicyEpoch);
  receipt.policySource.currentPin = negative.currentPin;
  receipt.policySource.epochs[17] = negative;
  const h1 = replaceOnce(
    input.h1,
    canonicalContractLiteral(eighteenthPolicyEpoch, eighteenthPolicyEpoch.beforePin, eighteenthPolicyEpoch.currentPin),
    canonicalContractLiteral(eighteenthPolicyEpoch, negative.beforePin, negative.currentPin),
  );
  const record = receipt.instruments[0]!;
  record.currentPin = pin(h1);
  expect(record.inverse.at(-1)!.inputOffset).toBe(45495);
  expect(record.forward.at(-1)!.outputOffset).toBe(45495);
  record.inverse.at(-1)!.from = Buffer.from(h1).subarray(45495).toString("utf8");
  record.forward.at(-1)!.to = Buffer.from(h1).subarray(45495).toString("utf8");
  const original = independentlyReplaySuccessorSpans(
    h1,
    record.inverse,
    "eighteenth negative H1 inverse",
    record.beforePin,
  );
  expect(original).toBe(input.originalPublished.get(historicalCallerPath));
  expect(independentlyReplaySuccessorSpans(original, record.forward, "eighteenth negative H1 forward", pin(h1))).toBe(
    h1,
  );
  const text = JSON.stringify(receipt, null, 2) + "\n";
  const anchor = replaceOnce(
    currentSuccessorFreeze().anchorSource,
    currentSuccessorFreeze().receiptPin.sha256,
    digest(text),
  );
  const files = eighteenthColdFiles(input);
  files.set(historicalCallerPath, h1);
  files.set(anchorPath, anchor);
  files.set(successorReceiptPath, text);
  files.set(slicePolicyPath, current);
  return { h1, anchor, files };
}

describe("C1 independent eighteenth canonical-policy current association", () => {
  it("loads actual fixed18 and genuinely cold17 with reciprocal complete policy and receipt bytes", async () => {
    const input = eighteenthPolicyHealthy();
    await healthyColdEighteenth(input);
    const historical = seventeenthPolicyHealthy();
    expect(historical.current).toBe(input.seventeen);
    await healthyColdSeventeenth(historical);
    eighteenthPolicyHealthy();
  });
  it.each(["old17", "whitespace", "new-row byte"] as const)(
    "refuses supplied18 source fault %s before physical policy I/O",
    async (fault) => {
      const input = eighteenthPolicyHealthy();
      await healthyColdEighteenth(input);
      const changed =
        fault === "old17"
          ? input.seventeen
          : fault === "whitespace"
            ? input.current + "\n"
            : replaceOnce(
                input.current,
                '"path": "src/codegen/closures/closure-type-sources.ts"',
                '"path": "src/codegen/closures/closure-type-sourcef.ts"',
              );
      const trace: string[] = [];
      expect(() =>
        captureGeometryCurrentMainPredecessorPolicySource(changed, (path) => {
          trace.push(path);
          return read(path);
        }),
      ).toThrow("C1 historical authority: full-file pin changed: policySource supplied current");
      expect(trace).toEqual(slicePolicyReadOrder.slice(0, 2));
      await healthyColdEighteenth(input);
      eighteenthPolicyHealthy();
    },
  );
  it.each(["mutation", "missing"] as const)(
    "current18 freshly refuses supplied-reader %s after success with exact Error identity and recovery",
    async (fault) => {
      const input = eighteenthPolicyHealthy(),
        missing = new Error("canonical18 policy authority missing");
      await healthyColdEighteenth(input);
      let changed = false;
      const trace: string[] = [];
      const reader = (path: string): string => {
        trace.push(path);
        if (changed && path === slicePolicyPath) {
          if (fault === "missing") throw missing;
          return read(path) + "\n";
        }
        return read(path);
      };
      expect(captureGeometryCurrentMainPredecessorPolicySource(input.current, reader)).toBe(input.predecessor);
      expect(trace).toEqual(slicePolicyReadOrder);
      trace.length = 0;
      changed = true;
      const action = () => captureGeometryCurrentMainPredecessorPolicySource(input.current, reader);
      if (fault === "missing") expect(compositionFailure(action)).toBe(missing);
      else
        expectCompositionError(action, "C1 historical authority: full-file pin changed: policySource actual current");
      expect(trace).toEqual(slicePolicyReadOrder);
      trace.length = 0;
      changed = false;
      expect(captureGeometryCurrentMainPredecessorPolicySource(input.current, reader)).toBe(input.predecessor);
      expect(trace).toEqual(slicePolicyReadOrder);
      await healthyColdEighteenth(input);
      eighteenthPolicyHealthy();
    },
  );
  it("retains actual18 primitive and callable-first priorities with zero coercions and reader I/O", () => {
    eighteenthPolicyHealthy();
    let reads = 0,
      coercions = 0;
    const boxed = {
      toString() {
        coercions++;
        return "source";
      },
    };
    const reader = () => {
      reads++;
      throw new Error("current18 IO bomb");
    };
    expect(() => captureGeometryCurrentMainPredecessorPolicySource(boxed as unknown as string, reader)).toThrow(
      "C1 historical authority: current-main geometry policy must be a primitive string",
    );
    expect(() => captureGeometryCurrentMainPredecessorPolicySource("source", null as never)).toThrow(
      "C1 historical authority: current-main geometry policy authority reader must be callable",
    );
    expect([reads, coercions]).toEqual([0, 0]);
    eighteenthPolicyHealthy();
  });
  it.each(["inverse offset", "inverse payload", "forward-only payload"] as const)(
    "reaches the genuine eighteenth policy recipe detector for %s",
    async (fault) => {
      const input = eighteenthPolicyHealthy();
      await healthyColdEighteenth(input);
      const receipt = structuredClone(input.receipt),
        epoch = receipt.policySource.epochs[17]!;
      if (fault === "inverse offset") epoch.inverse[0]!.inputOffset++;
      if (fault === "inverse payload") epoch.inverse[0]!.from = "x" + epoch.inverse[0]!.from;
      if (fault === "forward-only payload") epoch.forward[0]!.to = "x" + epoch.forward[0]!.to;
      const text = JSON.stringify(receipt, null, 2) + "\n";
      const anchor = replaceOnce(
        currentSuccessorFreeze().anchorSource,
        currentSuccessorFreeze().receiptPin.sha256,
        digest(text),
      );
      const files = eighteenthColdFiles(input);
      files.set(anchorPath, anchor);
      files.set(successorReceiptPath, text);
      const result = await runColdNumberEpoch(input.h1, anchor, files, undefined, { source: input.current });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        fault === "forward-only payload"
          ? "C1 historical authority: full-file pin changed: policySource forward epoch 18 replay"
          : "C1 historical authority: policySource inverse epoch 18 span membership/coordinates",
      );
      await healthyColdEighteenth(input);
      eighteenthPolicyHealthy();
    },
  );
  it("reaches each fixed new-row field, order, omission and duplicate detector at canonical row354", async () => {
    const input = eighteenthPolicyHealthy();
    await healthyColdEighteenth(input);
    for (const fault of [
      "state",
      "layer",
      "path",
      "destination",
      "owner",
      "nextBoundary",
      "order",
      "omission",
      "duplicate",
    ] as const) {
      const data = JSON.parse(input.current);
      if (fault === "order") [data.files[353], data.files[354]] = [data.files[354], data.files[353]];
      else if (fault === "omission") data.files.splice(354, 1);
      else if (fault === "duplicate") data.files.splice(354, 0, { ...data.files[354] });
      else data.files[354][fault] += " owned negative fixture";
      const current = (fault === "omission" ? " " : "") + JSON.stringify(data, null, 2) + "\n";
      expect(current).not.toBe(input.current);
      const state = eighteenthDiagnosticState(input, current);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: current });
      assertColdSlicePhase(
        result,
        state.files,
        input.predecessor,
        "C1 historical authority: policySource inverse epoch 18 " +
          (fault === "omission" || fault === "duplicate" ? "semantic file counts" : "semantic ordered row/neighbors"),
      );
      await healthyColdEighteenth(input);
      eighteenthPolicyHealthy();
    }
  });
  it.each(["retained row", "layer DATA", "top-level DATA"] as const)(
    "reaches unchanged18 exact DATA guard for %s",
    async (fault) => {
      const input = eighteenthPolicyHealthy();
      await healthyColdEighteenth(input);
      const data = JSON.parse(input.current);
      if (fault === "retained row") data.files[0].state += " owned negative fixture";
      if (fault === "layer DATA") data.layers[0].description += " owned negative fixture";
      if (fault === "top-level DATA") data.description += " owned negative fixture";
      const current = JSON.stringify(data, null, 2) + "\n";
      const state = eighteenthDiagnosticState(input, current);
      const result = await runColdNumberEpoch(state.h1, state.anchor, state.files, undefined, { source: current });
      assertColdSlicePhase(
        result,
        state.files,
        input.predecessor,
        "C1 historical authority: policySource inverse epoch 18 " +
          (fault === "retained row"
            ? "semantic retained file rows"
            : fault === "layer DATA"
              ? "semantic unrelated layer drift"
              : "complete semantic replay/retained content"),
      );
      await healthyColdEighteenth(input);
      eighteenthPolicyHealthy();
    },
  );
  it.each(["old17 H1/current18 policy", "current18 H1/old17 receipt"] as const)(
    "cold-loads exact mixed17/18 association %s and refuses",
    async (fault) => {
      const input = eighteenthPolicyHealthy(),
        old = input.old;
      await healthyColdEighteenth(input);
      const files = eighteenthColdFiles(input),
        h1 = fault === "old17 H1/current18 policy" ? old.h1 : input.h1;
      files.set(historicalCallerPath, h1);
      files.set(anchorPath, old.seventeenFreeze.anchorSource);
      files.set(successorReceiptPath, old.seventeenReceipt);
      const result = await runColdNumberEpoch(h1, old.seventeenFreeze.anchorSource, files, undefined, {
        source: input.current,
      });
      assertColdSlicePhase(
        result,
        files,
        input.predecessor,
        "C1 historical authority: " +
          (fault === "old17 H1/current18 policy"
            ? "full-file pin changed: policySource supplied current"
            : "policySource fixed source domain"),
      );
      await healthyColdEighteenth(input);
      eighteenthPolicyHealthy();
    },
  );
});
