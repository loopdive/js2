// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
// Independent, fixed population: never derive required files from discovered
// imports, the production policy, or an existence-filtered directory listing.
const groups = {
  foundation: [
    "source-origin",
    "ir-identity",
    "identity-values",
    "ir-counted-string-identity",
    "ir-preparation-failure",
    "ir-unit-inventory",
  ].map((x) => `src/shared/contracts/${x}.ts`),
  "wasm-model": ["src/wasm/model/instructions.ts"],
  "wasm-physical": ["src/wasm/physical/function-handles.ts"],
  "native-runtime": ["src/runtime/wasmgc/async/microtask-queue-bodies.ts"],
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
  ].map((x) => `src/ir/core/${x}.ts`),
  "ir-analysis": ["src/ir/analysis/contracts/allocations.ts"],
  "ir-passes": ["src/ir/passes/contracts/gvn.ts"],
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
  ].map((x) => `src/ir/program/${x}.ts`),
  "runtime-contracts": ["host-capability-schema", "async-provider-schema", "provider-policy", "index"].map(
    (x) => `src/runtime/contracts/${x}.ts`,
  ),
  "ir-runtime": ["index", "contracts/intrinsics", "contracts/manifest", "contracts/prepared"].map(
    (x) => `src/ir/runtime/${x}.ts`,
  ),
};
const clean = Object.values(groups).flat();
const ownershipModules = [
  "src/ir/analysis/alloc-registry.ts",
  "src/ir/program/errors.ts",
  "src/ir/program/data.ts",
  "src/ir/program/input.ts",
];
const currentGroups = {
  ...groups,
  "ir-analysis": [...groups["ir-analysis"], "src/ir/analysis/alloc-registry.ts"],
  "ir-program": [
    ...groups["ir-program"],
    "src/ir/program/errors.ts",
    "src/ir/program/data.ts",
    "src/ir/program/input.ts",
  ],
};
const allocation = groups["ir-analysis"][0]!;
const newModules = [
  ...groups.foundation.slice(4),
  ...groups["ir-analysis"],
  ...groups["ir-passes"],
  ...groups["ir-program"].slice(3),
  ...groups["runtime-contracts"].slice(1),
  ...groups["ir-runtime"],
];
const policy = () => JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-program-data-boundary-"));
  scratch.push(root);
  const put = (path: string, source: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), source);
  };
  const p = policy();
  p.requireGitProvenance = false;
  p.layers = p.layers.map((layer: { id: string; roots: string[] }) => {
    const entries = groups[layer.id as keyof typeof groups];
    return entries
      ? { ...layer, status: "active", required: true, entries, minModules: entries.length }
      : { id: layer.id, roots: layer.roots, status: "debt" };
  });
  // This fixture is the historical forty-module contract checkpoint.
  p.layers.find((layer: { id: string }) => layer.id === "ir-analysis").roots = ["src/ir/analysis/contracts"];
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
  for (const path of clean) put(path, readFileSync(resolve(repository, path), "utf8"));
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
    const r = spawnSync(
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
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
    );
    expect(r.error).toBeUndefined();
    expect(r.signal).toBeNull();
    return { status: r.status, report: JSON.parse(r.stdout) };
  };
  const append = (path: string, text: string) => put(path, readFileSync(resolve(root, path), "utf8") + "\n" + text);
  const forbidden = (layer: string) => {
    put("src/forbidden.ts", "export interface Hidden { value: number } export const hidden = 1;");
    p.files.push({ path: "src/forbidden.ts", layer, state: "unmigrated" });
  };
  return { root, p, put, run, append, forbidden };
}

function ownershipFixture() {
  const f = fixture();
  for (const path of ownershipModules) {
    f.put(path, readFileSync(resolve(repository, path), "utf8"));
    const layer = path.startsWith("src/ir/analysis/") ? "ir-analysis" : "ir-program";
    f.p.files.push({ path, layer, state: "clean" });
  }
  for (const id of ["ir-analysis", "ir-program"] as const) {
    const entries = currentGroups[id];
    const layer = f.p.layers.find((row: { id: string }) => row.id === id);
    layer.entries = entries;
    layer.minModules = entries.length;
    if (id === "ir-analysis") layer.roots = ["src/ir/analysis/contracts", "src/ir/analysis/alloc-registry.ts"];
    f.p.activationHistory.push({ layer: id, entries, minModules: entries.length });
  }
  return f;
}

describe("canonical executable ownership boundary", () => {
  it("pins the exact four additions independently of discovered imports", () => {
    const current = Object.values(currentGroups).flat();
    const added = current.filter((path) => !clean.includes(path));
    expect(added.sort()).toEqual([...ownershipModules].sort());
    expect(added.sort()).toEqual([
      "src/ir/analysis/alloc-registry.ts",
      "src/ir/program/data.ts",
      "src/ir/program/errors.ts",
      "src/ir/program/input.ts",
    ]);
  });

  it("checks all forty-four actual modules without changing earlier policy edges", () => {
    const r = ownershipFixture().run();
    expect(r.status, JSON.stringify(r.report.errors)).toBe(0);
    expect(r.report.counts.total).toBe(44);
    expect(r.report.resolvedEdgeCount).toBe(119);
    expect(r.report.counts.edgesBySyntax).toEqual({ import: 98, "export-from": 20, "import-type": 1 });
    expect(r.report.counts.resolvedEdgesBySyntax).toEqual({ import: 98, "export-from": 20, "import-type": 1 });
    expect(r.report.counts.edgesByType).toEqual({ typeOnly: 102, runtime: 17 });
    expect(r.report.counts.resolvedEdgesByType).toEqual({ typeOnly: 102, runtime: 17 });
    expect(r.report.unknownEdges).toEqual([]);
    expect(r.report.unresolvedEdges).toEqual([]);
    expect(r.report.forbiddenEdges).toEqual([]);
    expect(r.report.transitiveViolations).toEqual([]);
    for (const [path, count] of [
      ["src/ir/analysis/alloc-registry.ts", 4],
      ["src/ir/program/errors.ts", 0],
      ["src/ir/program/data.ts", 2],
      ["src/ir/program/input.ts", 4],
    ] as const)
      expect(r.report.edges.filter((edge: { from: string }) => edge.from === path)).toHaveLength(count);
  });

  it.each(ownershipModules)("rejects removal of runtime owner %s and its classification", (path) => {
    const f = ownershipFixture();
    rmSync(resolve(f.root, path));
    f.p.files = f.p.files.filter((row: { path: string }) => row.path !== path);
    for (const mode of ["inventory", "complete"]) {
      const r = f.run(mode);
      expect(r.status).not.toBe(0);
      expect(r.report.errors.map((e: { code: string }) => e.code)).toContain("missing-activated-root");
    }
  });

  it.each(ownershipModules)("rejects forbidden dependencies in runtime owner %s", (path) => {
    const f = ownershipFixture();
    f.forbidden("frontend-ts");
    f.append(path, 'export type { Hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: true }),
    );
  });

  it.each([
    ["import(globalThis.toString());", "unknownEdges"],
    ['export * from "./missing-owner.js";', "unresolvedEdges"],
  ])("rejects unprovable executable owner dependency %s", (source, field) => {
    const f = ownershipFixture();
    const path = "src/ir/program/input.ts";
    f.append(path, source);
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report[field].some((edge: { from: string }) => edge.from === path)).toBe(true);
  });
});

describe("complete canonical program-data dependency boundary", () => {
  it("preserves every earlier policy edge and historical activation receipt", () => {
    const p = policy();
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(p.allowedEdges["ir-analysis"]).toEqual(["ir-analysis", "foundation", "ir-core", "wasm-model"]);
    const originalEdges = structuredClone(p.allowedEdges);
    originalEdges["ir-analysis"] = ["ir-analysis", "foundation", "ir-core"];
    // Exact e90f2a14 prerequisite policy, before the reviewed single edge.
    expect(digest(originalEdges)).toBe("fdfc33f2fc49568e81e2563c48551bd26c753d749d123615b98e89adfc4d7bac");
    const keys = [
      "ir-program:3",
      "runtime-contracts:1",
      "ir-core:11",
      "foundation:4",
      "ir-core:5",
      "foundation:3",
      "wasm-model:1",
      "wasm-physical:1",
      "native-runtime:1",
    ];
    const historical = keys.map((key) => {
      const matches = p.activationHistory.filter(
        (row: { layer: string; minModules: number }) => `${row.layer}:${row.minModules}` === key,
      );
      expect(matches).toHaveLength(1);
      return matches[0];
    });
    expect(digest(historical)).toBe("820a39c3d3b05a1a20d030ae10b1e19621802cfed5cf9a29ccb5dccb80b3d6ee");
    for (const [layer, minModules] of [
      ["ir-analysis", 1],
      ["ir-program", 9],
    ] as const) {
      const matches = p.activationHistory.filter(
        (row: { layer: string; minModules: number }) => row.layer === layer && row.minModules === minModules,
      );
      expect(matches).toHaveLength(1);
      expect([...matches[0].entries].sort()).toEqual([...groups[layer]].sort());
      expect(matches[0].entries).toHaveLength(minModules);
    }
    for (const [path, destination] of [
      ["src/ir/analysis/dominance.ts", "ir-analysis"],
      ["src/ir/passes/constant-fold.ts", "ir-passes"],
      ["src/ir/runtime-program-producers.ts", "ir-program"],
      ["src/ir/runtime-program-manifest.ts", "ir-program"],
    ]) {
      expect(p.files.find((row: { path: string }) => row.path === path)).toMatchObject({
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination,
      });
    }
  });
  it("pins all forty required modules and history floors independently", () => {
    expect(clean).toHaveLength(40);
    expect(new Set(clean).size).toBe(40);
    expect(newModules).toHaveLength(17);
    expect(new Set(newModules).size).toBe(17);
    expect([...newModules].sort()).toEqual(
      [
        "src/shared/contracts/ir-preparation-failure.ts",
        "src/shared/contracts/ir-unit-inventory.ts",
        "src/ir/analysis/contracts/allocations.ts",
        "src/ir/passes/contracts/gvn.ts",
        "src/ir/program/abi-lookup.ts",
        "src/ir/program/callable-bindings.ts",
        "src/ir/program/controls.ts",
        "src/ir/program/index.ts",
        "src/ir/program/input-contracts.ts",
        "src/ir/program/prepared-contracts.ts",
        "src/runtime/contracts/async-provider-schema.ts",
        "src/runtime/contracts/provider-policy.ts",
        "src/runtime/contracts/index.ts",
        "src/ir/runtime/index.ts",
        "src/ir/runtime/contracts/intrinsics.ts",
        "src/ir/runtime/contracts/manifest.ts",
        "src/ir/runtime/contracts/prepared.ts",
      ].sort(),
    );
    const p = policy();
    expect(Object.values(currentGroups).flat()).toHaveLength(44);
    expect(new Set(Object.values(currentGroups).flat()).size).toBe(44);
    expect(ownershipModules).toHaveLength(4);
    expect(new Set(ownershipModules).size).toBe(4);
    for (const [id, entries] of Object.entries(currentGroups)) {
      const layer = p.layers.find((x: { id: string }) => x.id === id);
      expect(layer).toMatchObject({ status: "active", required: true, minModules: entries.length });
      expect([...layer.entries].sort()).toEqual([...entries].sort());
      expect(p.activationHistory).toContainEqual(
        expect.objectContaining({ layer: id, minModules: entries.length, entries: expect.arrayContaining(entries) }),
      );
      for (const path of entries)
        expect(p.files.filter((x: { path: string }) => x.path === path)).toEqual([{ path, layer: id, state: "clean" }]);
    }
    expect(p.layers.find((x: { id: string }) => x.id === "ir-analysis").roots).toEqual([
      "src/ir/analysis/contracts",
      "src/ir/analysis/alloc-registry.ts",
    ]);
    expect(p.layers.find((x: { id: string }) => x.id === "ir-passes").roots).toEqual(["src/ir/passes/contracts"]);
  });

  it("checks the actual forty-module type-and-value closure", () => {
    const result = fixture().run();
    expect(result.status, JSON.stringify(result.report.errors)).toBe(0);
    expect(result.report.counts.total).toBe(40);
    expect(result.report.resolvedEdgeCount).toBe(109);
    expect(result.report.counts.edgesBySyntax).toEqual({ import: 89, "export-from": 19, "import-type": 1 });
    expect(result.report.counts.resolvedEdgesBySyntax).toEqual({ import: 89, "export-from": 19, "import-type": 1 });
    expect(result.report.counts.edgesByType).toEqual({ typeOnly: 99, runtime: 10 });
    expect(result.report.counts.resolvedEdgesByType).toEqual({ typeOnly: 99, runtime: 10 });
    expect(result.report.unknownEdges).toEqual([]);
    expect(result.report.unresolvedEdges).toEqual([]);
    expect(result.report.forbiddenEdges).toEqual([]);
    expect(result.report.transitiveViolations).toEqual([]);
  });

  it("reproduces the original analysis error without changing source or population", () => {
    const f = fixture();
    f.p.allowedEdges["ir-analysis"] = ["ir-analysis", "foundation", "ir-core"];
    const before = f.run();
    expect(before.status).toBe(1);
    expect(before.report.errors).toHaveLength(3);
    expect(
      before.report.errors.every(
        (e: { code: string; detail: string }) =>
          e.code === "forbidden-transitive-path" &&
          e.detail.startsWith(allocation + " -> ") &&
          e.detail.endsWith("src/wasm/model/instructions.ts"),
      ),
    ).toBe(true);
    f.p.allowedEdges["ir-analysis"].push("wasm-model");
    const after = f.run();
    expect(after.status, JSON.stringify(after.report.errors)).toBe(0);
    expect(after.report.modules).toEqual(before.report.modules);
    expect(after.report.edges).toEqual(before.report.edges);
    expect(before.report.errors.map((e: { detail: string }) => e.detail).sort()).toEqual(
      [
        `${allocation} -> src/ir/core/nodes.ts -> src/wasm/model/instructions.ts`,
        `${allocation} -> src/ir/core/nodes.ts -> src/wasm/model/instructions.ts`,
        `${allocation} -> src/ir/core/types.ts -> src/wasm/model/instructions.ts`,
      ].sort(),
    );
  });

  it.each(clean)("rejects removal of mandatory module %s even with its classification", (path) => {
    const f = fixture();
    rmSync(resolve(f.root, path));
    f.p.files = f.p.files.filter((x: { path: string }) => x.path !== path);
    for (const mode of ["inventory", "complete"]) {
      const r = f.run(mode);
      expect(r.status).not.toBe(0);
      expect(r.report.errors.map((e: { code: string }) => e.code)).toContain("missing-activated-root");
    }
  });

  it.each([
    "ir-program",
    "ir-runtime",
    "backend-wasmgc",
    "wasm-physical",
    "wasm-emit",
    "frontend-ts",
    "legacy-ir-bridge",
  ])("keeps analysis forbidden from %s through a model intermediary", (layer) => {
    const f = fixture();
    f.forbidden(layer);
    f.append("src/wasm/model/instructions.ts", 'export type { Hidden as ForbiddenHidden } from "../../forbidden.js";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(
      r.report.transitiveViolations.some(
        (x: { from: string; path: string[] }) => x.from === allocation && x.path.includes("src/forbidden.ts"),
      ),
    ).toBe(true);
  });

  it.each([
    ["ir-program", "src/ir/program/controls.ts", "../../ir/program/controls.js"],
    ["ir-runtime", "src/ir/runtime/contracts/prepared.ts", "../../ir/runtime/contracts/prepared.js"],
    ["wasm-physical", "src/wasm/physical/function-handles.ts", "../physical/function-handles.js"],
  ])("rejects the actual clean %s dependency, independently of migration debt", (layer, target, specifier) => {
    const f = fixture();
    const model = "src/wasm/model/instructions.ts";
    expect(f.p.files.find((x: { path: string }) => x.path === target)).toMatchObject({ state: "clean", layer });
    f.append(model, `export * from ${JSON.stringify(specifier)};`);
    // Permit this test intermediary's edge so only analysis's transitive
    // direction, not debt or the model's own direct rule, is under test.
    f.p.allowedEdges["wasm-model"].push(layer);
    const r = f.run();
    expect(r.status).toBe(1);
    expect(
      r.report.transitiveViolations.some(
        (x: { from: string; path: string[] }) =>
          x.from === allocation && x.path.includes(model) && x.path.at(-1) === target,
      ),
    ).toBe(true);
  });

  it.each([
    ['import { hidden } from "@forbidden";', "import", false],
    ['import type { Hidden } from "@forbidden";', "import", true],
    ['import { type Hidden } from "@forbidden";', "import", true],
    ['export type { Hidden } from "@forbidden";', "export-from", true],
    ['export * from "@forbidden";', "export-star", false],
    ['type Hidden = import("@forbidden").Hidden;', "import-type", true],
    ['type Hidden = typeof import("@forbidden");', "import-type", true],
    ['import * as hidden from "@forbidden"; type Hidden = typeof hidden;', "import", false],
    ['import hidden = require("@forbidden");', "import-equals", false],
    ['const hidden = require("@forbidden");', "require", false],
    ['const hidden = import("@forbidden");', "dynamic-import", false],
  ] as const)("resolves and rejects forbidden import syntax: %s", (source, syntax, typeOnly) => {
    const f = fixture();
    f.forbidden("frontend-ts");
    f.append("src/ir/program/index.ts", source);
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: "src/ir/program/index.ts", to: "src/forbidden.ts", syntax, typeOnly }),
    );
  });

  it.each(newModules)("enforces the newly activated owner %s", (path) => {
    const f = fixture();
    f.forbidden("frontend-ts");
    f.append(path, 'import type { Hidden as ForbiddenHidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", syntax: "import", typeOnly: true }),
    );
  });

  it.each([
    ["const target = globalThis.toString(); import(target);", "unknownEdges"],
    ["const target = globalThis.toString(); require(target);", "unknownEdges"],
    ['export type { Missing } from "./missing.js";', "unresolvedEdges"],
  ])("rejects unprovable new-owner dependencies: %s", (source, field) => {
    const f = fixture();
    const path = "src/ir/program/index.ts";
    f.append(path, source);
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report[field].some((edge: { from: string }) => edge.from === path)).toBe(true);
  });

  it("rejects malformed new-owner syntax", () => {
    const f = fixture();
    f.append("src/ir/program/controls.ts", "export interface Broken {");
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.errors.map((e: { code: string }) => e.code)).toContain("parse-error");
  });

  it.each(["ir-program", "ir-runtime", "runtime-contracts"] as const)("rejects whole-group removal of %s", (layer) => {
    const f = fixture();
    const paths = groups[layer];
    for (const path of paths) rmSync(resolve(f.root, path));
    f.p.files = f.p.files.filter((row: { path: string }) => !paths.includes(row.path));
    for (const mode of ["inventory", "complete"]) {
      const r = f.run(mode);
      expect(r.status).not.toBe(0);
      expect(r.report.errors).toContainEqual(
        expect.objectContaining({ code: "missing-activated-root", detail: layer }),
      );
    }
  });

  it.each(["status", "entries", "minimum", "roots"])("rejects activation demotion through %s", (change) => {
    const f = fixture();
    const layer = f.p.layers.find((x: { id: string }) => x.id === "ir-program");
    if (change === "status") layer.status = "planned";
    if (change === "entries") layer.entries = layer.entries.slice(1);
    if (change === "minimum") layer.minModules--;
    if (change === "roots") layer.roots = ["src/ir/program/not-the-contracts"];
    const r = f.run();
    expect(r.status).not.toBe(0);
    expect(
      r.report.errors.some((e: { code: string }) =>
        ["activation-demoted", "missing-activated-root", "clean-outside-active-layer"].includes(e.code),
      ),
    ).toBe(true);
  });
});
