// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const core = [
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
].map((name) => `src/ir/core/${name}.ts`);
const foundation = ["ir-identity", "source-origin", "identity-values", "ir-counted-string-identity"].map(
  (name) => `src/shared/contracts/${name}.ts`,
);
const model = "src/wasm/model/instructions.ts";
const clean = [...core, ...foundation, model];
const legacy = ["nodes", "async-plan", "async-runtime-providers", "types", "counted-string-append-provenance"].map(
  (name) => `src/ir/${name}.ts`,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-core-nodes-boundary-"));
  roots.push(root);
  const put = (file: string, source: string) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), source);
  };
  for (const file of clean) put(file, readFileSync(resolve(repository, file), "utf8"));
  for (const file of legacy) put(file, "export interface Hidden { readonly syntax: unknown; }");
  put("tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }));
  const layers = [
    { id: "ir-core", status: "active", roots: ["src/ir/core"], required: true, entries: core, minModules: 11 },
    {
      id: "foundation",
      status: "active",
      roots: ["src/shared/contracts"],
      required: true,
      entries: foundation,
      minModules: 4,
    },
    { id: "wasm-model", status: "active", roots: ["src/wasm/model"], required: true, entries: [model], minModules: 1 },
    { id: "legacy", status: "debt", roots: legacy },
  ];
  const policy = {
    schema: "compiler-boundaries-v1",
    sourceRoot: "src",
    tsconfig: "tsconfig.json",
    requireGitProvenance: false,
    moduleExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    layers,
    files: [
      ...core.map((path) => ({ path, state: "clean", layer: "ir-core" })),
      ...foundation.map((path) => ({ path, state: "clean", layer: "foundation" })),
      { path: model, state: "clean", layer: "wasm-model" },
      ...legacy.map((path) => ({ path, state: "unmigrated", layer: "legacy" })),
    ],
    allowedEdges: {
      "ir-core": ["ir-core", "foundation", "wasm-model"],
      foundation: ["foundation"],
      "wasm-model": ["wasm-model", "foundation"],
      legacy: ["legacy", "ir-core", "foundation", "wasm-model"],
    },
    activationHistory: layers
      .filter((layer) => layer.status === "active")
      .map((layer) => ({ layer: layer.id, entries: layer.entries, minModules: layer.minModules })),
    externalPackages: [],
    nonModules: [],
    moves: [],
    evidence: [],
  };
  function run(mode = "inventory") {
    put("policy.json", JSON.stringify(policy));
    const result = spawnSync(
      process.execPath,
      [
        resolve(repository, "scripts/check-compiler-boundaries.mjs"),
        "--root",
        root,
        "--config",
        "policy.json",
        "--mode",
        mode,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, report: JSON.parse(result.stdout) };
  }
  return {
    root,
    put,
    policy,
    run,
    append: (file: string, source: string) => put(file, `${readFileSync(resolve(root, file), "utf8")}\n${source}\n`),
  };
}

function positive(f: ReturnType<typeof fixture>) {
  const result = f.run();
  expect(result.status, JSON.stringify(result.report.errors)).toBe(0);
  expect(result.report.counts.total).toBe(21);
  expect(result.report.resolvedEdgeCount).toBe(40);
  expect(result.report.unknownEdges).toEqual([]);
  expect(result.report.unresolvedEdges).toEqual([]);
  expect(result.report.architectureComplete).toBe(false);
}

describe("#3518 complete semantic nodes has no prepared/provider dependency", () => {
  it("checks all sixteen real clean modules while complete migration remains failing", () => {
    const f = fixture();
    positive(f);
    expect(f.run("complete").status).toBe(1);
  });
  it.each(clean)("cannot silently lose canonical source %s", (file) => {
    const f = fixture();
    positive(f);
    rmSync(resolve(f.root, file));
    expect(f.run().status).toBe(1);
  });
  it.each(legacy)("forbids an inline type import of old %s", (file) => {
    const f = fixture();
    positive(f);
    f.append(
      "src/ir/core/nodes.ts",
      `type HiddenOld = import('../${file.split("/").at(-1)!.replace(".ts", ".js")}').Hidden;`,
    );
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-clean-edge");
  });
  it.each([
    "import type { Hidden } from '../async-plan.js';",
    "export type { Hidden } from '../async-runtime-providers.js';",
    "const hidden = import('../nodes.js');",
    "declare const target: string; const hidden = import(target);",
    "type Hidden = import('./missing.js').Missing;",
  ])("rejects forbidden or unprovable dependencies: %s", (source) => {
    const f = fixture();
    positive(f);
    f.append("src/ir/core/nodes.ts", source);
    expect(f.run().status).toBe(1);
  });
  it("cannot hide a facade dependency behind another clean core file", () => {
    const f = fixture();
    positive(f);
    f.append("src/ir/core/async-intents.ts", "export type { Hidden } from '../async-runtime-providers.js';");
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-transitive-path");
  });
  it("pins every production activation while preserving narrower historical receipts", () => {
    const policy = JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
    for (const [id, entries, minimum] of [
      ["ir-core", core, 11],
      ["foundation", foundation, 4],
    ] as const) {
      expect(policy.layers.find((layer: { id: string }) => layer.id === id)).toEqual(
        expect.objectContaining({ status: "active", entries: expect.arrayContaining(entries), minModules: minimum }),
      );
      expect(policy.activationHistory).toContainEqual(
        expect.objectContaining({ layer: id, entries: expect.arrayContaining(entries), minModules: minimum }),
      );
      for (const path of entries)
        expect(policy.files.find((file: { path: string }) => file.path === path)).toEqual({
          path,
          state: "clean",
          layer: id,
        });
    }
    expect(policy.activationHistory).toContainEqual(expect.objectContaining({ layer: "ir-core", minModules: 5 }));
    expect(policy.activationHistory).toContainEqual(expect.objectContaining({ layer: "foundation", minModules: 3 }));
    expect(policy.allowedEdges["ir-core"]).toEqual(["ir-core", "foundation", "wasm-model"]);
    expect(policy.allowedEdges.foundation).toEqual(["foundation"]);
    for (const path of ["src/ir/async-plan.ts", "src/ir/async-runtime-providers.ts", "src/ir/nodes.ts"])
      expect(policy.files.find((file: { path: string }) => file.path === path).state).toBe("unmigrated");
  });
});
