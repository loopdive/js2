// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";

const repository = resolve(import.meta.dirname, "..");
// Fixed specification population, independent of discovered imports and policy.
const historicalGroups = {
  foundation: [
    "source-origin",
    "ir-identity",
    "identity-values",
    "ir-counted-string-identity",
    "ir-preparation-failure",
    "ir-unit-inventory",
  ].map((x) => `src/shared/contracts/${x}.ts`),
  "wasm-model": ["src/wasm/model/instructions.ts", "src/wasm/model/module-records.ts"],
  "wasm-physical": [
    "src/wasm/physical/function-handles.ts",
    "src/wasm/physical/function-types.ts",
    "src/wasm/physical/module-reservations.ts",
    "src/wasm/physical/exception-control.ts",
    "src/wasm/physical/type-layout.ts",
  ],
  "native-runtime": [
    "src/runtime/wasmgc/async/microtask-queue-bodies.ts",
    "src/runtime/wasmgc/promise/settlement-bodies.ts",
    "src/runtime/wasmgc/async/frame-engine.ts",
    "src/runtime/wasmgc/async/native-await.ts",
    "src/runtime/wasmgc/promise/delay-bodies.ts",
    "src/runtime/wasmgc/promise/combinator-bodies.ts",
  ],
  "ir-core": [
    "types",
    "fnctor-shapes",
    "value-references",
    "capability-provenance",
    "tag-refinement",
    "nodes",
    "dialect/js",
    "async-plan",
    "intrinsic-vocabulary",
    "async-intents",
    "string-types",
    "binding-key-primitives",
    "intrinsic-contracts",
    "intrinsics",
    "callable-bindings",
    "async-callables",
    "vector-runtime",
  ].map((x) => `src/ir/core/${x}.ts`),
  "ir-analysis": ["contracts/allocations", "alloc-registry", "effects", "intrinsics", "async-plan"].map(
    (x) => `src/ir/analysis/${x}.ts`,
  ),
  "ir-passes": ["src/ir/passes/contracts/gvn.ts"],
  "ir-runtime": [
    "index",
    "contracts/intrinsics",
    "contracts/manifest",
    "contracts/prepared",
    "host-capabilities",
    "async-providers",
    "callable-declarations",
    "manifest",
    "async-attachment",
    "intrinsic-verification",
    "native-async-callables",
    "vector-callables",
  ].map((x) => `src/ir/runtime/${x}.ts`),
  "ir-program": [
    "abi-inventory",
    "abi",
    "startup",
    "abi-lookup",
    "callable-bindings",
    "controls",
    "index",
    "input-contracts",
    "prepared-contracts",
    "errors",
    "data",
    "input",
  ].map((x) => `src/ir/program/${x}.ts`),
  "runtime-contracts": ["host-capability-schema", "async-provider-schema", "provider-policy", "index"].map(
    (x) => `src/runtime/contracts/${x}.ts`,
  ),
};
const physicalVectorAdditions = [
  "src/ir/program/native-vector-resources.ts",
  "src/runtime/wasmgc/values/vector-grow-store.ts",
  "src/backend/wasmgc/resources/native-vectors.ts",
];
const vectorGroups = {
  ...historicalGroups,
  "ir-program": [...historicalGroups["ir-program"], physicalVectorAdditions[0]!],
  "native-runtime": [...historicalGroups["native-runtime"], physicalVectorAdditions[1]!],
  "backend-wasmgc": [physicalVectorAdditions[2]!],
};
const resolutionAdditions = [
  "src/runtime/wasmgc/promise/resolution-bodies.ts",
  "src/runtime/wasmgc/promise/thenable-bodies.ts",
];
const resolutionGroups = {
  ...vectorGroups,
  "native-runtime": [...vectorGroups["native-runtime"], ...resolutionAdditions],
};
const promiseResourceAdditions = [
  "src/ir/program/native-promise-resources.ts",
  "src/backend/wasmgc/resources/native-promises.ts",
];
const promiseGroups = {
  ...resolutionGroups,
  "ir-program": [...resolutionGroups["ir-program"], promiseResourceAdditions[0]!],
  "backend-wasmgc": [...resolutionGroups["backend-wasmgc"], promiseResourceAdditions[1]!],
};
const stringErrorAdditions = [
  "src/runtime/wasmgc/values/string-layouts.ts",
  "src/runtime/wasmgc/values/string-literal-bodies.ts",
  "src/runtime/wasmgc/values/error-bodies.ts",
  "src/backend/wasmgc/resources/native-string-literals.ts",
  "src/backend/wasmgc/resources/native-errors.ts",
];
const stringErrorGroups = {
  ...promiseGroups,
  "native-runtime": [...promiseGroups["native-runtime"], ...stringErrorAdditions.slice(0, 3)],
  "backend-wasmgc": [...promiseGroups["backend-wasmgc"], ...stringErrorAdditions.slice(3)],
};
const nativeValueAdditions = [
  "src/ir/program/native-value-resources.ts",
  "src/runtime/wasmgc/values/primitive-layouts.ts",
  "src/runtime/wasmgc/values/number-bodies.ts",
  "src/backend/wasmgc/resources/native-values.ts",
];
const nativeValueGroups = {
  ...stringErrorGroups,
  "ir-program": [...stringErrorGroups["ir-program"], nativeValueAdditions[0]!],
  "native-runtime": [...stringErrorGroups["native-runtime"], ...nativeValueAdditions.slice(1, 3)],
  "backend-wasmgc": [...stringErrorGroups["backend-wasmgc"], nativeValueAdditions[3]!],
};
const scannerAdditions = [
  "src/wasm/model/instruction-walk.ts",
  "src/runtime/wasmgc/values/string-number-grammar.ts",
  "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
  "src/runtime/wasmgc/values/string-number-bodies.ts",
  "src/runtime/wasmgc/values/string-flatten-bodies.ts",
  "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
  "src/backend/wasmgc/resources/native-string-number.ts",
  "src/backend/wasmgc/resources/native-string-flatten.ts",
];
const scannerGroups = {
  ...nativeValueGroups,
  "wasm-model": [...nativeValueGroups["wasm-model"], scannerAdditions[0]!],
  "native-runtime": [...nativeValueGroups["native-runtime"], ...scannerAdditions.slice(1, 6)],
  "backend-wasmgc": [...nativeValueGroups["backend-wasmgc"], ...scannerAdditions.slice(6)],
};
const argumentVectorAdditions = [
  "src/runtime/wasmgc/values/argument-vector-bodies.ts",
  "src/backend/wasmgc/resources/native-argument-vectors.ts",
];
const argumentVectorGroups = {
  ...nativeValueGroups,
  "native-runtime": [...nativeValueGroups["native-runtime"], argumentVectorAdditions[0]!],
  "backend-wasmgc": [...nativeValueGroups["backend-wasmgc"], argumentVectorAdditions[1]!],
};
const closureAdditions = [
  "src/runtime/wasmgc/values/closure-layouts.ts",
  "src/backend/wasmgc/resources/native-closures.ts",
];
const closureGroups = {
  ...argumentVectorGroups,
  "native-runtime": [...argumentVectorGroups["native-runtime"], closureAdditions[0]!],
  "backend-wasmgc": [...argumentVectorGroups["backend-wasmgc"], closureAdditions[1]!],
};
const demandAdditions = ["src/ir/program/native-string-value-demands.ts"];
const priorGroups = {
  ...scannerGroups,
  "ir-program": [...scannerGroups["ir-program"], ...demandAdditions],
  "native-runtime": [...scannerGroups["native-runtime"], argumentVectorAdditions[0]!, closureAdditions[0]!],
  "backend-wasmgc": [...scannerGroups["backend-wasmgc"], argumentVectorAdditions[1]!, closureAdditions[1]!],
};
const declarationAdditions = [
  "src/runtime/wasmgc/values/native-resource-declaration-types.ts",
  "src/backend/wasmgc/resources/native-resource-declarations.ts",
];
const publishedDeclarationGroups = {
  ...scannerGroups,
  "native-runtime": [...scannerGroups["native-runtime"], declarationAdditions[0]!],
  "backend-wasmgc": [...scannerGroups["backend-wasmgc"], declarationAdditions[1]!],
};
const declarationGroups = {
  ...priorGroups,
  "native-runtime": [...priorGroups["native-runtime"], declarationAdditions[0]!],
  "backend-wasmgc": [...priorGroups["backend-wasmgc"], declarationAdditions[1]!],
};
const aggregateAdditions = ["src/backend/wasmgc/program/native-string-values.ts"];
const mainGroups = {
  ...declarationGroups,
  "backend-wasmgc": [...declarationGroups["backend-wasmgc"], ...aggregateAdditions],
};
const formatterGroups = {
  "frontend-ts": ["src/frontend/builtins/contracts.ts"],
  "ir-core": ["src/ir/core/type-references.ts"],
  "ir-program": ["src/ir/program/runtime-support.ts", "src/ir/program/formatter-support.ts"],
};
const formatterAdditions = Object.values(formatterGroups).flat();
const groups = {
  ...mainGroups,
  "frontend-ts": formatterGroups["frontend-ts"],
  "ir-core": [...mainGroups["ir-core"], ...formatterGroups["ir-core"]],
  "ir-program": [...mainGroups["ir-program"], ...formatterGroups["ir-program"]],
};
const required = Object.values(groups).flat();
const callableAdditions = ["src/ir/core/async-callables.ts", "src/ir/runtime/native-async-callables.ts"];
const vectorAdditions = ["src/ir/core/vector-runtime.ts", "src/ir/runtime/vector-callables.ts"];
const typeLayoutAdditions = ["src/wasm/physical/type-layout.ts"];
const delayCombinatorAdditions = [
  "src/runtime/wasmgc/promise/delay-bodies.ts",
  "src/runtime/wasmgc/promise/combinator-bodies.ts",
];
const settlementAdditions = ["src/runtime/wasmgc/promise/settlement-bodies.ts"];
const frameAdditions = [
  "src/runtime/wasmgc/async/frame-engine.ts",
  "src/runtime/wasmgc/async/native-await.ts",
  "src/wasm/physical/exception-control.ts",
];
const physicalAdditions = [
  "src/wasm/model/module-records.ts",
  "src/wasm/physical/function-types.ts",
  "src/wasm/physical/module-reservations.ts",
];
const additions = [
  "src/ir/core/intrinsic-contracts.ts",
  "src/ir/core/intrinsics.ts",
  "src/ir/core/callable-bindings.ts",
  "src/ir/analysis/effects.ts",
  "src/ir/analysis/intrinsics.ts",
  "src/ir/analysis/async-plan.ts",
  "src/ir/runtime/host-capabilities.ts",
  "src/ir/runtime/async-providers.ts",
  "src/ir/runtime/callable-declarations.ts",
  "src/ir/runtime/manifest.ts",
  "src/ir/runtime/async-attachment.ts",
  "src/ir/runtime/intrinsic-verification.ts",
];
const policy = () => JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Preserve the exact published prerequisite composition as an ordered subsequence,
// alongside the complete delivered-main history. The first two records retain
// their original entry ordering, even where the active populations now agree.
const originalCompositionOffsets = [
  0, 1, 3, 4, 7, 8, 10, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
  38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62,
];
function assertOriginalComposition(history: unknown[]) {
  const original = originalCompositionOffsets.map((index) => history[index]);
  expect(digest(original)).toBe("4aa271504137eac71e91ef4956fc1b3fe6ced60bd3262c3375046c11d9f0b329");
  expect(digest([...original.slice(2, 9), ...original.slice(13)])).toBe(
    "4040a7108cfae3cc4746d38c1f68167d51556ba84d9a8f2f6fb44534ccb08680",
  );
  expect(digest([...original.slice(9, 13), ...original.slice(13)])).toBe(
    "dfd3286a35182705e7d692244e756c3b592803831013232a5c0f2f71cdf8e9ac",
  );
}
function assertNewActivations(history: unknown[]) {
  expect(history.slice(0, 3)).toEqual(
    Object.entries(formatterGroups).map(([layer, entries]) => ({ layer, entries, minModules: entries.length })),
  );
  // Keep the full delivered main history and all its original digest checks.
  history = history.slice(3);
  assertOriginalComposition(history);
  history = history.slice(2);
  // The combined declaration and both published 9ccad45c additions precede
  // the exact complete activation history independently read from eac9f741.
  expect(history[0]).toEqual({
    layer: "backend-wasmgc",
    entries: mainGroups["backend-wasmgc"],
    minModules: mainGroups["backend-wasmgc"].length,
  });
  expect(history[1]).toEqual({
    layer: "backend-wasmgc",
    entries: [...publishedDeclarationGroups["backend-wasmgc"], ...aggregateAdditions],
    minModules: publishedDeclarationGroups["backend-wasmgc"].length + aggregateAdditions.length,
  });
  expect(history[2]).toEqual({
    layer: "ir-program",
    entries: mainGroups["ir-program"],
    minModules: mainGroups["ir-program"].length,
  });
  expect(digest(history.slice(1, 3))).toBe("025f946401a0b57c22705361d4b69f314cad7e0c2aa856dcf0834fe74858ea3a");
  history = history.slice(3);
  expect(digest(history)).toBe("476fd97c07cd737123d32db1a0e4c7647e4993d5aa44b5726ebf35ca073bca47");
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: declarationGroups[layer],
      minModules: declarationGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: publishedDeclarationGroups[layer],
      minModules: publishedDeclarationGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history[0]).toEqual({
    layer: "ir-program",
    entries: priorGroups["ir-program"],
    minModules: priorGroups["ir-program"].length,
  });
  history = history.slice(1);
  expect(history.slice(0, 3)).toEqual(
    (["wasm-model", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: priorGroups[layer],
      minModules: priorGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 3)).toEqual(
    (["wasm-model", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: scannerGroups[layer],
      minModules: scannerGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: closureGroups[layer],
      minModules: closureGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: argumentVectorGroups[layer],
      minModules: argumentVectorGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 3)).toEqual(
    (["ir-program", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: nativeValueGroups[layer],
      minModules: nativeValueGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: stringErrorGroups[layer],
      minModules: stringErrorGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["ir-program", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: promiseGroups[layer],
      minModules: promiseGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history[0]).toEqual({
    layer: "native-runtime",
    entries: resolutionGroups["native-runtime"],
    minModules: 9,
  });
  history = history.slice(1);
  expect(history.slice(0, 3)).toEqual(
    (["ir-program", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: vectorGroups[layer],
      minModules: vectorGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 2)).toEqual(
    (["ir-core", "ir-runtime"] as const).map((layer) => ({
      layer,
      entries: historicalGroups[layer],
      minModules: historicalGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["ir-core", "ir-runtime"] as const).map((layer) => ({
      layer,
      entries: historicalGroups[layer].filter((path) => !vectorAdditions.includes(path)),
      minModules: historicalGroups[layer].length - 1,
    })),
  );
  history = history.slice(2);
  expect(history[0]).toEqual({ layer: "wasm-physical", entries: historicalGroups["wasm-physical"], minModules: 5 });
  expect(history[1]).toEqual({ layer: "native-runtime", entries: historicalGroups["native-runtime"], minModules: 6 });
  expect(history.slice(2, 4)).toEqual(
    (["native-runtime", "wasm-physical"] as const).map((layer) => ({
      layer,
      entries: historicalGroups[layer].filter(
        (path) =>
          ![...delayCombinatorAdditions, ...typeLayoutAdditions, ...callableAdditions, ...vectorAdditions].includes(
            path,
          ),
      ),
      minModules: historicalGroups[layer].filter(
        (path) =>
          ![...delayCombinatorAdditions, ...typeLayoutAdditions, ...callableAdditions, ...vectorAdditions].includes(
            path,
          ),
      ).length,
    })),
  );
  expect(history.slice(4, 10)).toEqual(
    (["native-runtime", "wasm-model", "wasm-physical", "ir-core", "ir-analysis", "ir-runtime"] as const).map(
      (layer) => ({
        layer,
        entries: historicalGroups[layer].filter(
          (path) =>
            ![
              ...frameAdditions,
              ...delayCombinatorAdditions,
              ...typeLayoutAdditions,
              ...callableAdditions,
              ...vectorAdditions,
            ].includes(path),
        ),
        minModules: historicalGroups[layer].filter(
          (path) =>
            ![
              ...frameAdditions,
              ...delayCombinatorAdditions,
              ...typeLayoutAdditions,
              ...callableAdditions,
              ...vectorAdditions,
            ].includes(path),
        ).length,
      }),
    ),
  );
}
const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
  // Each detector invocation is synchronous. Let worker result acknowledgments
  // drain between controls instead of starving RPC for the entire population.
  await setImmediate();
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-semantic-provider-boundary-"));
  scratch.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  const p = policy();
  p.requireGitProvenance = false;
  p.layers = p.layers.map((layer: { id: string; roots: string[] }) => {
    const entries = groups[layer.id as keyof typeof groups];
    return entries
      ? { ...layer, status: "active", required: true, entries, minModules: entries.length }
      : { id: layer.id, roots: layer.roots, status: "debt" };
  });
  p.files = Object.entries(groups).flatMap(([layer, paths]) => paths.map((path) => ({ path, layer, state: "clean" })));
  p.activationHistory = Object.entries(groups).map(([layer, entries]) => ({
    layer,
    entries,
    minModules: entries.length,
  }));
  p.moves = [];
  p.evidence = [];
  p.nonModules = [];
  p.externalPackages = [];
  p.externalAssets = [];
  for (const path of required) put(path, readFileSync(resolve(repository, path), "utf8"));
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@forbidden": ["src/forbidden.ts"] },
      },
      include: ["src"],
    }),
  );
  const run = (mode = "inventory") => {
    put("policy.json", JSON.stringify(p));
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=2048",
        resolve(repository, "scripts/check-compiler-boundaries.mjs"),
        "--root",
        root,
        "--config",
        "policy.json",
        "--mode",
        mode,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    return { status: child.status, report: JSON.parse(child.stdout) };
  };
  const append = (path: string, text: string) => put(path, readFileSync(resolve(root, path), "utf8") + "\n" + text);
  return { root, p, put, append, run };
}

describe("semantic verification and provider ownership boundary", () => {
  it("pins the original 70 modules plus seven Promise/vector and five string/error owners without relaxing historical policy", () => {
    expect(required).toHaveLength(106);
    expect(new Set(required).size).toBe(106);
    expect(callableAdditions).toHaveLength(2);
    expect(vectorAdditions).toHaveLength(2);
    expect(typeLayoutAdditions).toHaveLength(1);
    expect(delayCombinatorAdditions).toHaveLength(2);
    expect(frameAdditions).toHaveLength(3);
    expect(physicalAdditions).toHaveLength(3);
    expect(settlementAdditions).toHaveLength(1);
    expect(
      required.filter(
        (path) =>
          ![
            ...physicalAdditions,
            ...settlementAdditions,
            ...frameAdditions,
            ...delayCombinatorAdditions,
            ...typeLayoutAdditions,
            ...callableAdditions,
            ...vectorAdditions,
            ...physicalVectorAdditions,
            ...resolutionAdditions,
            ...promiseResourceAdditions,
            ...stringErrorAdditions,
            ...nativeValueAdditions,
            ...scannerAdditions,
            ...demandAdditions,
            ...argumentVectorAdditions,
            ...closureAdditions,
            ...declarationAdditions,
            ...aggregateAdditions,
            ...formatterAdditions,
          ].includes(path),
      ),
    ).toHaveLength(56);
    expect(additions).toHaveLength(12);
    expect(new Set(additions).size).toBe(12);
    for (const path of [
      ...additions,
      ...physicalAdditions,
      ...settlementAdditions,
      ...frameAdditions,
      ...delayCombinatorAdditions,
      ...typeLayoutAdditions,
      ...callableAdditions,
      ...vectorAdditions,
      ...physicalVectorAdditions,
      ...resolutionAdditions,
      ...promiseResourceAdditions,
      ...stringErrorAdditions,
      ...nativeValueAdditions,
      ...scannerAdditions,
      ...demandAdditions,
      ...argumentVectorAdditions,
      ...closureAdditions,
      ...declarationAdditions,
      ...aggregateAdditions,
      ...formatterAdditions,
    ])
      expect(required).toContain(path);
    const p = policy();
    assertNewActivations(p.activationHistory);
    expect(p.activationHistory).toHaveLength(66);
    expect(digest(p.activationHistory.slice(42))).toBe(
      "3437a59aacf39df9dffcafa8099ac9f47c0f43a7a0ecc423df4c1fe3e638f002",
    );
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    // Exact full activation history at b4c116639a, not a selected subset.
    expect(digest(p.activationHistory.slice(48))).toBe(
      "a6d07b900b0837832707ce083202ab6ffa40f0bbe6bfce25f3062270882b26da",
    );
    for (const [id, entries] of Object.entries(groups)) {
      const layer = p.layers.find((row: { id: string }) => row.id === id);
      expect(layer).toMatchObject({ status: "active", required: true, minModules: entries.length });
      expect([...layer.entries].sort()).toEqual([...entries].sort());
      for (const path of entries)
        expect(p.files.filter((row: { path: string }) => row.path === path)).toEqual([
          { path, state: "clean", layer: id },
        ]);
    }
  });

  it("loads the complete actual canonical type-and-value closure", () => {
    const r = fixture().run();
    expect(r.status, JSON.stringify(r.report.errors)).toBe(0);
    expect(r.report.counts.total).toBe(106);
    expect(r.report.errors).toEqual([]);
    for (const field of ["unknownEdges", "unresolvedEdges", "forbiddenEdges", "transitiveViolations"])
      expect(r.report[field]).toEqual([]);
    // Formatter support adds four canonical modules and 26 imports to the
    // delivered-main closure: 11 type-only and 15 runtime. The original
    // September 14 missing-module and history-offset failures are retained.
    // Historical parent and published activation records remain unchanged.
    expect({ edges: r.report.resolvedEdgeCount, ...r.report.counts.resolvedEdgesByType }).toEqual({
      edges: 425,
      typeOnly: 262,
      runtime: 163,
    });
  });

  function assertModelOnlyDeclarations(text: string) {
    const source = ts.createSourceFile("declarations.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        expect(statement.importClause?.isTypeOnly).toBe(true);
        expect(ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
        imports.push((statement.moduleSpecifier as ts.StringLiteral).text);
      } else {
        expect(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)).toBe(true);
      }
    }
    expect(imports).toEqual(["../../../wasm/model/instructions.js", "../../../wasm/model/module-records.js"]);
    const visit = (node: ts.Node): void => {
      expect(ts.isImportTypeNode(node)).toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  it("keeps the actual declaration contract erased and model-only", () => {
    assertModelOnlyDeclarations(readFileSync(resolve(repository, declarationAdditions[0]!), "utf8"));
  });

  it.each([
    'import { extra } from "../../../wasm/model/instructions.js";',
    'import type { Extra } from "../../../wasm/physical/module-reservations.js";',
    'export type Extra = import("../../../wasm/physical/module-reservations.js").TypeReservation;',
    "export const runtimeValue = 1;",
  ])("rejects declaration-contract coupling: %s", (mutation) => {
    const text = readFileSync(resolve(repository, declarationAdditions[0]!), "utf8");
    assertModelOnlyDeclarations(text);
    expect(() => assertModelOnlyDeclarations(text + "\n" + mutation)).toThrow();
  });

  it.each(
    [0, 1, 2].flatMap((index) =>
      (["delete", "reorder", "layer", "entries", "minimum"] as const).map((mutation) => ({ index, mutation })),
    ),
  )("rejects $mutation corruption of formatter activation record $index", ({ index, mutation }) => {
    const history = policy().activationHistory;
    assertNewActivations(history);
    const before = digest(history);
    if (mutation === "delete") history.splice(index, 1);
    if (mutation === "reorder") [history[index], history[index + 1]] = [history[index + 1], history[index]];
    if (mutation === "layer") history[index].layer = "ir-analysis";
    if (mutation === "entries") history[index].entries.pop();
    if (mutation === "minimum") history[index].minModules--;
    expect(digest(history), "mutation must alter the formatter activation record").not.toBe(before);
    expect(() => assertNewActivations(history)).toThrow();
  });

  it.each(["delete", "reorder", "layer", "entries", "minimum"] as const)(
    "rejects %s corruption of the new activation records",
    (mutation) => {
      const history = policy().activationHistory;
      assertNewActivations(history);
      const before = digest(history);
      if (mutation === "delete") history.splice(5, 1);
      if (mutation === "reorder") [history[5], history[6]] = [history[6], history[5]];
      if (mutation === "layer") history[5].layer = "ir-core";
      if (mutation === "entries") history[5].entries.pop();
      if (mutation === "minimum") history[5].minModules--;
      expect(digest(history), "mutation must alter the accepted activation records").not.toBe(before);
      expect(() => assertNewActivations(history)).toThrow();
    },
  );

  it.each(
    (
      [
        ["published backend", 6],
        ["published demand", 7],
        ["refreshed parent", 8],
      ] as const
    ).flatMap(([owner, index]) =>
      (["delete", "reorder", "layer", "entries", "minimum"] as const).map((mutation) => ({
        owner,
        index,
        mutation,
      })),
    ),
  )("rejects $mutation corruption of the $owner activation record", ({ index, mutation }) => {
    const history = policy().activationHistory;
    assertNewActivations(history);
    const before = digest(history);
    if (mutation === "delete") history.splice(index, 1);
    if (mutation === "reorder") [history[index], history[index + 1]] = [history[index + 1], history[index]];
    if (mutation === "layer") history[index].layer = "ir-core";
    if (mutation === "entries") history[index].entries.pop();
    if (mutation === "minimum") history[index].minModules--;
    expect(digest(history), "mutation must alter the authenticated parent record").not.toBe(before);
    expect(() => assertNewActivations(history)).toThrow();
  });

  it.each(
    [0, 2, 9].flatMap((offset) =>
      (["delete", "reorder", "layer", "entries", "minimum"] as const).map((mutation) => ({ offset, mutation })),
    ),
  )("rejects $mutation corruption of original prerequisite activation records at $offset", ({ offset, mutation }) => {
    const history = policy().activationHistory;
    assertNewActivations(history);
    const index = 3 + originalCompositionOffsets[offset]!;
    const next = 3 + originalCompositionOffsets[offset + 1]!;
    const before = digest(history);
    if (mutation === "delete") history.splice(index, 1);
    if (mutation === "reorder") [history[index], history[next]] = [history[next], history[index]];
    if (mutation === "layer") history[index].layer = "ir-core";
    if (mutation === "entries") history[index].entries.pop();
    if (mutation === "minimum") history[index].minModules--;
    expect(digest(history), "mutation must alter the original prerequisite record").not.toBe(before);
    expect(() => assertNewActivations(history)).toThrow();
  });

  it("rejects an upward runtime dependency from the native string/value aggregate", () => {
    const f = fixture();
    const path = aggregateAdditions[0]!;
    f.put("src/forbidden.ts", "export const hidden = 1;");
    f.p.files.push({ path: "src/forbidden.ts", layer: "frontend-ts", state: "unmigrated" });
    f.append(path, 'import { hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: false }),
    );
  });

  it.each([
    ...additions,
    ...physicalAdditions,
    ...settlementAdditions,
    ...frameAdditions,
    ...delayCombinatorAdditions,
    ...typeLayoutAdditions,
    ...callableAdditions,
    ...vectorAdditions,
    ...physicalVectorAdditions,
    ...resolutionAdditions,
    ...promiseResourceAdditions,
    ...stringErrorAdditions,
    ...nativeValueAdditions,
    ...scannerAdditions,
    ...demandAdditions,
    ...argumentVectorAdditions,
    ...closureAdditions,
    ...declarationAdditions,
    ...aggregateAdditions,
    ...formatterAdditions,
  ])("rejects deleting %s and its classification", (path) => {
    const f = fixture();
    rmSync(resolve(f.root, path));
    f.p.files = f.p.files.filter((row: { path: string }) => row.path !== path);
    for (const mode of ["inventory", "complete"]) {
      const r = f.run(mode);
      expect(r.status).not.toBe(0);
      expect(r.report.errors.map((e: { code: string }) => e.code)).toContain("missing-activated-root");
    }
  });

  it.each([
    ...additions,
    ...physicalAdditions,
    ...settlementAdditions,
    ...frameAdditions,
    ...delayCombinatorAdditions,
    ...typeLayoutAdditions,
    ...callableAdditions,
    ...vectorAdditions,
    ...physicalVectorAdditions,
    ...resolutionAdditions,
    ...promiseResourceAdditions,
    ...stringErrorAdditions,
    ...nativeValueAdditions,
    ...scannerAdditions,
    ...demandAdditions,
    ...argumentVectorAdditions,
    ...closureAdditions,
    ...declarationAdditions,
    ...aggregateAdditions,
    ...formatterGroups["ir-core"],
    ...formatterGroups["ir-program"],
  ])("rejects an aliased frontend type dependency from %s", (path) => {
    const f = fixture();
    f.put("src/forbidden.ts", "export interface Hidden { value: number }");
    f.p.files.push({ path: "src/forbidden.ts", layer: "frontend-ts", state: "unmigrated" });
    f.append(path, 'export type { Hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: true }),
    );
  });

  it("rejects a backend implementation dependency from the frontend formatter contract", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const path = formatterGroups["frontend-ts"][0]!;
    f.put("src/forbidden.ts", "export interface Hidden { value: number }");
    f.p.files.push({ path: "src/forbidden.ts", layer: "backend-wasmgc", state: "unmigrated" });
    f.append(path, 'export type { Hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: true }),
    );
  });

  for (const [source, field] of [
    ["const target = globalThis.toString(); import(target);", "unknownEdges"],
    ['export type { Missing } from "./missing-owner.js";', "unresolvedEdges"],
  ] as const) {
    it.each([
      ...additions,
      ...physicalAdditions,
      ...settlementAdditions,
      ...frameAdditions,
      ...delayCombinatorAdditions,
      ...typeLayoutAdditions,
      ...callableAdditions,
      ...vectorAdditions,
      ...physicalVectorAdditions,
      ...resolutionAdditions,
      ...promiseResourceAdditions,
      ...stringErrorAdditions,
      ...nativeValueAdditions,
      ...scannerAdditions,
      ...demandAdditions,
      ...argumentVectorAdditions,
      ...closureAdditions,
      ...declarationAdditions,
      ...aggregateAdditions,
      ...formatterAdditions,
    ])(`reports ${field} from %s instead of treating it as closed`, (path) => {
      const f = fixture();
      f.append(path, source);
      const r = f.run();
      expect(r.status).toBe(1);
      expect(r.report[field]).toContainEqual(expect.objectContaining({ from: path }));
    });
  }

  it.each(additions)("rejects a runtime dependency on the historical facade from %s", (path) => {
    const f = fixture();
    const facade = "src/ir/intrinsics.ts";
    f.put(facade, readFileSync(resolve(repository, facade), "utf8"));
    const classification = policy().files.filter((row: { path: string }) => row.path === facade);
    expect(classification).toHaveLength(1);
    f.p.files.push(classification[0]);
    f.append(path, 'import "../intrinsics.js";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: facade, typeOnly: false }),
    );
  });

  for (const [layer, source, typeOnly] of [
    ["compiler", 'import { hidden } from "@forbidden";', false],
    ["backend-wasmgc", 'export * from "@forbidden";', false],
    ["wasm-physical", 'type HiddenPhysical = typeof import("@forbidden").hidden;', true],
    ["ir-program", 'export { hidden } from "@forbidden";', false],
  ] as const) {
    it.each(["src/ir/core/intrinsics.ts", "src/ir/analysis/intrinsics.ts", "src/ir/runtime/intrinsic-verification.ts"])(
      `rejects ${layer} dependency syntax from %s`,
      (path) => {
        const f = fixture();
        f.put("src/forbidden.ts", "export const hidden = 1;");
        f.p.files.push({ path: "src/forbidden.ts", layer, state: "unmigrated" });
        f.append(path, source);
        const r = f.run();
        expect(r.status).toBe(1);
        expect(r.report.forbiddenEdges).toContainEqual(
          expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly }),
        );
      },
    );
  }

  it.each(["effects", "intrinsics", "async-plan"])(
    "rejects runtime provider dependencies from semantic analysis/%s",
    (name) => {
      const f = fixture();
      const path = `src/ir/analysis/${name}.ts`;
      f.append(path, 'export { RUNTIME_PROVIDERS } from "../runtime/manifest.js";');
      const r = f.run();
      expect(r.status).toBe(1);
      expect(r.report.forbiddenEdges).toContainEqual(
        expect.objectContaining({ from: path, to: "src/ir/runtime/manifest.ts", typeOnly: false }),
      );
    },
  );

  it.each(["ir-core", "ir-analysis", "ir-runtime"] as const)(
    "rejects whole-group deletion of %s despite policy demotion",
    (id) => {
      const f = fixture();
      for (const path of groups[id]) rmSync(resolve(f.root, path));
      f.p.files = f.p.files.filter((row: { layer: string }) => row.layer !== id);
      const layer = f.p.layers.find((row: { id: string }) => row.id === id);
      layer.status = "debt";
      layer.required = false;
      layer.entries = [];
      layer.minModules = 0;
      for (const mode of ["inventory", "complete"]) {
        const r = f.run(mode);
        expect(r.status).not.toBe(0);
        expect(r.report.errors).toContainEqual({ code: "activation-demoted", detail: id });
      }
    },
  );
});
