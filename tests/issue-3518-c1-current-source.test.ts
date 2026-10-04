// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  captureProgramValidatorRelocation,
  programValidatorRelocationCurrentPaths,
  programValidatorRelocationReceiptPath,
  type ProgramValidatorDonorPath,
} from "./helpers/ir-program-validator-relocation.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  beforeCanonicalInstructionsSource,
  captureC1CurrentPopulation,
  reconstructC1CurrentSources,
  type C1ResolverObservationIO,
} from "./helpers/ir-c1-current-source.js";
import { captureC1HistoricalAuthority, c1HistoricalArtifactPath } from "./helpers/ir-c1-historical-authority.js";
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
  '{"manifestSha256":"d9608431567aaf08fdba2aadbc96c8d4d59762a7f5412c61798fd6fe49994dba","anchorSource":"// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\\n\\nexport const c1AuthorityManifestSha256 = \\"d9608431567aaf08fdba2aadbc96c8d4d59762a7f5412c61798fd6fe49994dba\\";\\n","anchorPin":{"bytes":194,"sha256":"ef9bc18dc7efd797a73a4fccce3097aaed3e7b83198a46e24376bcf5e14252dc","gitBlob":"9c212f99a80fc5b90c02b6064e75b3ef54f78473"},"declarationPin":{"bytes":1633,"sha256":"5294c0fce2be6c6974b61a3686c05e60aa66d5bb4599fc97cb315ee53cab71be","gitBlob":"8c594e598e0d946ed92fd658cbe2efe3063ca2c4"}}';
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
  expect(read(anchorPath)).toBe(expected.anchorSource);
  expect(pin(read(anchorPath))).toEqual(expected.anchorPin);
  return { expected, data: JSON.parse(read(manifestPath)) };
}

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
    const authority = captureC1HistoricalAuthority(read);
    const path = "tests/fixtures/issue-3518-c1-historical-authority/" + basename;
    expect(c1HistoricalArtifactPath(logical)).toBe(path);
    expect(authority.readHistorical(logical)).toBe(read(path));
    expect(Buffer.byteLength(read(path))).toBe(bytes);
    expect(digest(read(path))).toBe(sha256);
  });
  it("independently inverts every recorded edit and replays exact current bytes", () => {
    const { data } = manifest();
    for (const edit of data.instrumentEdits) {
      const current = Buffer.from(read(edit.path));
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
    const first = captureC1HistoricalAuthority(read),
      second = captureC1HistoricalAuthority(read);
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
    captureC1HistoricalAuthority(read);
    const path = c1HistoricalArtifactPath(logical);
    expect(() => captureC1HistoricalAuthority(replaced(path, read(path) + "\n// mutant\n"))).toThrow();
  });
  it.each(instruments)("rejects a warm current instrument mutation independently: %s", (path) => {
    captureC1HistoricalAuthority(read);
    expect(() => captureC1HistoricalAuthority(replaced(path, read(path) + "\n// mutant\n"))).toThrow();
  });
  it.each(immutableAuthorities)("retains fresh unchanged authority for %s", (path) => {
    captureC1HistoricalAuthority(read);
    expect(() => captureC1HistoricalAuthority(replaced(path, read(path) + "\n// mutant\n"))).toThrow();
  });
  it.each([anchorPath, manifestPath])("does not reuse success after %s changes", (path) => {
    captureC1HistoricalAuthority(read);
    expect(() => reconstructC1CurrentSources(read, replaced(path, read(path) + "\n"))).toThrow();
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
    captureC1HistoricalAuthority(read);
    const candidate = JSON.parse(read(manifestPath));
    edit(candidate);
    expect(() => captureC1HistoricalAuthority(replaced(manifestPath, JSON.stringify(candidate)))).toThrow();
  });
});

describe("C1 fresh live source contract bridge", () => {
  it("captures exact receipt+46 population order separately from fresh authority/type reads", () => {
    const population: string[] = [],
      authority: string[] = [];
    const capture = () =>
      captureC1CurrentPopulation(
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
    expect(first.observedCurrentPins).toHaveLength(46);
    expect(extras).toHaveLength(9);
    for (const path of extras) expect(authority.filter((item) => item === path)).toHaveLength(2);
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
    const originalReceipt = JSON.parse(first.receiptText);
    expect(originalReceipt.transfers).toHaveLength(91);
    expect(originalReceipt.transfers.filter((item: { moved: boolean }) => item.moved)).toHaveLength(12);
    expect(originalReceipt.transfers.filter((item: { moved: boolean }) => !item.moved)).toHaveLength(79);
  });
  it("substitutes only the historical linear dependency and keeps detached mutation on the old guard", () => {
    const capture = captureC1CurrentPopulation(read, read);
    // The original linear substitution is retained. Exactly two fixed dependency operands now have an outer reciprocal relocation proof.
    const validator = captureProgramValidatorRelocation(read);
    const relocated = ["src/ir/program-runtime-abi.ts", "src/ir/program-validation.ts"] as const;
    for (const [path, source] of capture.historicalPopulation)
      if (path !== linearPath)
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
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
  });
  it.each(runtimeProgramRelocationPopulationPaths.filter((path) => path !== linearPath))(
    "refuses warm full-source mutation of current/dependency %s",
    (path) => {
      reconstructC1CurrentSources(read, read);
      expect(() => reconstructC1CurrentSources(replaced(path, read(path) + "\n// mutant\n"), read)).toThrow();
    },
  );
  it.each(extras)("refuses changed additional type owner %s", (path) => {
    reconstructC1CurrentSources(read, read);
    expect(() => reconstructC1CurrentSources(read, replaced(path, read(path) + "\n// mutant\n"))).toThrow(
      /full pin mismatch/,
    );
  });
  it.each(configPaths)("refuses changed authenticated resolver config %s", (path) => {
    reconstructC1CurrentSources(read, read);
    expect(() => reconstructC1CurrentSources(read, replaced(path, read(path) + "\n"))).toThrow(/full pin mismatch/);
  });
  it("passes an explicit bad receipt operand through to the unchanged guard", () => {
    reconstructC1CurrentSources(read, read);
    expect(() =>
      reconstructC1CurrentSources(
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
    reconstructC1CurrentSources(read, read);
    const mutant = replaceOnce(read(linearPath), before, after);
    expect(() => reconstructC1CurrentSources(replaced(linearPath, mutant), read)).toThrow();
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
    expect(() => reconstructC1CurrentSources(replaced(linearPath, read(linearPath) + addition), read)).toThrow();
  });
  it("accepts an unrelated concat-body edit while direct old full-file authentication refuses it", () => {
    const mutant = replaceOnce(
      read(linearPath),
      "linearCoercion.emitStringConcat(ctx, fctx, expr.left, expr.right, TO_STRING_COMPILER);",
      "linearCoercion.emitStringConcat(ctx, fctx, expr.right, expr.left, TO_STRING_COMPILER);",
    );
    const capture = captureC1CurrentPopulation(replaced(linearPath, mutant), read);
    expect(capture.originals.size).toBe(4);
    expect(capture.observedCurrentPins.find((item) => item.path === linearPath)?.pin.sha256).toBe(digest(mutant));
    const direct = new Map(capture.historicalPopulation);
    direct.set(linearPath, mutant);
    expect(() => reconstructRuntimeProgramRelocationPopulation(direct, capture.receiptText)).toThrow(/length\/SHA256/);
  });
  it.each(["src/ir/identity.ts", "src/frontend/typescript.ts"])(
    "refuses a missing resolver-target probe response for %s",
    (path) => {
      reconstructC1CurrentSources(read, read);
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
      expect(() => reconstructC1CurrentSources(read, read, io)).toThrow(/resolver observation/);
      expect(reached).toBe(true);
      expect(reconstructC1CurrentSources(read, read).size).toBe(4);
    },
  );
  it("refuses a missing resolver-directory probe response", () => {
    reconstructC1CurrentSources(read, read);
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
    expect(() => reconstructC1CurrentSources(read, read, io)).toThrow(/resolver observation/);
    expect(reached).toBe(true);
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
  });
  it("refuses a package that disappears during resolver traversal after real setup validation", () => {
    reconstructC1CurrentSources(read, read);
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
    expect(() => reconstructC1CurrentSources(read, read, io)).toThrow(/resolver observation/);
    expect(reached).toBe(true);
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
  });
  it.each(["node_modules/typescript.ts", "node_modules/typescript.tsx", "node_modules/typescript.d.ts"])(
    "refuses a newly present earlier shadow target %s",
    (path) => {
      reconstructC1CurrentSources(read, read);
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
      expect(() => reconstructC1CurrentSources(read, read, io)).toThrow(/resolver observation/);
      expect(reached).toBe(true);
      expect(reconstructC1CurrentSources(read, read).size).toBe(4);
    },
  );
  it("rejects accessor IO without invoking it or accepting extra expected-proof fields", () => {
    reconstructC1CurrentSources(read, read);
    let getters = 0;
    const accessor = actualIO();
    Object.defineProperty(accessor, "fileExists", {
      enumerable: true,
      get: () => {
        getters++;
        return () => true;
      },
    });
    expect(() => reconstructC1CurrentSources(read, read, accessor)).toThrow(/resolver IO data-function/);
    expect(getters).toBe(0);
    expect(() =>
      reconstructC1CurrentSources(read, read, { ...actualIO(), observations: [] } as C1ResolverObservationIO),
    ).toThrow(/resolver IO key membership/);
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
  });
  it.each([Object(true), undefined, "yes"])("requires primitive boolean IO result %s", (value) => {
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
    const actual = actualIO();
    let reached = false;
    const io = {
      ...actual,
      fileExists: () => {
        reached = true;
        return value as never;
      },
    };
    expect(() => reconstructC1CurrentSources(read, read, io)).toThrow(/fileExists primitive boolean/);
    expect(reached).toBe(true);
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
  });
  it("requires an actual absolute primitive realpath result", () => {
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
    const actual = actualIO();
    let reached = false;
    const io = {
      ...actual,
      realpath: () => {
        reached = true;
        return "lib/typescript.d.ts";
      },
    };
    expect(() => reconstructC1CurrentSources(read, read, io)).toThrow(/realpath primitive absolute path/);
    expect(reached).toBe(true);
    expect(reconstructC1CurrentSources(read, read).size).toBe(4);
  });
  it.each([undefined, Object("source"), 1])("refuses nonprimitive live source %s", (value) => {
    expect(() =>
      reconstructC1CurrentSources((path) => (path === linearPath ? (value as never) : read(path)), read),
    ).toThrow(/primitive source/);
  });
  it("typechecks actual current and exact historical contracts in both assignment directions", async () => {
    const { expected } = manifest();
    const historical = captureC1HistoricalAuthority(read).readHistorical(linearPath);
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
    captureC1CurrentPopulation(
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
    for (const path of extras) expect(authority.filter((item) => item === path)).toHaveLength(1);
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
      captureC1CurrentPopulation(
        read,
        replaced("package.json", mutate(canonicalPreviousPackage(read("package.json")))),
        io,
      ),
    ).toThrow(/full pin mismatch: package.json/);
    expect(calls).toBe(0);
  });
  it.each(["tsconfig.json", "pnpm-lock.yaml"])("retains full current config refusal for %s", (path) => {
    expect(() => captureC1CurrentPopulation(read, replaced(path, read(path) + "\n"))).toThrow(/full pin mismatch/);
  });
  it("refuses a second operation after package mutation and freshly accepts restored actual input", () => {
    let packageSource = read("package.json");
    const authority = (path: string): string => (path === "package.json" ? packageSource : read(path));
    const first = captureC1CurrentPopulation(read, authority);
    packageSource = predecessor(canonicalPreviousPackage(packageSource));
    expect(() => captureC1CurrentPopulation(read, authority)).toThrow(/full pin mismatch: package.json/);
    packageSource = read("package.json");
    const restored = captureC1CurrentPopulation(read, authority);
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
    const capture = captureC1CurrentPopulation(read, read);
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
    expect(() =>
      captureC1CurrentPopulation(read, replaced(path, canonicalPreviousInput(path, read(path))), io),
    ).toThrow(/full pin mismatch/);
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
      expect(() => captureC1CurrentPopulation(read, replaced(path, mutant), io)).toThrow(/full pin mismatch/);
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
    expect(() => captureC1CurrentPopulation(read, replaced(path, mutant))).toThrow(/full pin mismatch/);
  });
  it.each(canonicalPaths)("refuses a fresh second-operation mutation and accepts actual restoration for %s", (path) => {
    let source = read(path);
    const reader = (input: string): string => (input === path ? source : read(input));
    const first = captureC1CurrentPopulation(read, reader);
    source += "\n";
    expect(() => captureC1CurrentPopulation(read, reader)).toThrow(/full pin mismatch/);
    source = read(path);
    const restored = captureC1CurrentPopulation(read, reader);
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
    expect(() => captureC1CurrentPopulation(populationPath ? inject : read, populationPath ? read : inject)).toThrow(
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
