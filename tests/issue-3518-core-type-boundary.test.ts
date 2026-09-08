// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const core = ["types", "fnctor-shapes", "value-references", "capability-provenance", "tag-refinement"].map(
  (name) => `src/ir/core/${name}.ts`,
);
const foundation = ["src/shared/contracts/ir-identity.ts", "src/shared/contracts/source-origin.ts"];
const model = "src/wasm/model/instructions.ts";
const clean = [...core, ...foundation, model];
const old = "src/ir/nodes.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-core-type-boundary-"));
  roots.push(root);
  const put = (file: string, source: string) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), source);
  };
  for (const file of clean) put(file, readFileSync(resolve(repository, file), "utf8"));
  put(old, "export interface AstInput { readonly syntax: unknown; }");
  put("tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }));
  const policy = {
    schema: "compiler-boundaries-v1",
    sourceRoot: "src",
    tsconfig: "tsconfig.json",
    requireGitProvenance: false,
    moduleExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    layers: [
      { id: "ir-core", status: "active", roots: ["src/ir/core"], required: true, entries: core, minModules: 5 },
      {
        id: "foundation",
        status: "active",
        roots: ["src/shared/contracts"],
        required: true,
        entries: foundation,
        minModules: 2,
      },
      {
        id: "wasm-model",
        status: "active",
        roots: ["src/wasm/model"],
        required: true,
        entries: [model],
        minModules: 1,
      },
      { id: "legacy", status: "debt", roots: [old] },
    ],
    files: [
      ...core.map((path) => ({ path, state: "clean", layer: "ir-core" })),
      ...foundation.map((path) => ({ path, state: "clean", layer: "foundation" })),
      { path: model, state: "clean", layer: "wasm-model" },
      { path: old, state: "unmigrated", layer: "legacy" },
    ],
    allowedEdges: {
      "ir-core": ["ir-core", "foundation", "wasm-model"],
      foundation: ["foundation"],
      "wasm-model": ["wasm-model", "foundation"],
      legacy: ["legacy", "ir-core"],
    },
    activationHistory: [{ layer: "ir-core", entries: core, minModules: 5 }],
    externalPackages: [],
    nonModules: [],
    moves: [],
    evidence: [],
  };
  const run = (mode = "inventory") => {
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
  };
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
  expect(result.report.counts.total).toBe(9);
  expect(result.report.resolvedEdgeCount).toBe(12);
  expect(result.report.unknownEdges).toEqual([]);
  expect(result.report.unresolvedEdges).toEqual([]);
  return result;
}

describe("#3518 core types retain an enforced dependency boundary", () => {
  it("resolves the eight real clean modules while retaining unfinished nodes debt", () => {
    const f = fixture();
    expect(positive(f).report.architectureComplete).toBe(false);
    expect(f.run("complete").status).toBe(1);
  });

  it.each([
    ["type import", 'import type { AstInput } from "../nodes.js";'],
    ["type query", 'type Hidden = import("../nodes.js").AstInput;'],
    ["re-export", 'export type { AstInput } from "../nodes.js";'],
    ["dynamic import", 'const hidden = import("../nodes.js");'],
  ])("rejects a %s back edge into the old nodes module", (_kind, source) => {
    const f = fixture();
    positive(f);
    f.append(core[0]!, source);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-clean-edge");
  });

  it.each(core)("cannot lose required canonical entry %s", (file) => {
    const f = fixture();
    positive(f);
    rmSync(resolve(f.root, file));
    expect(f.run().status).toBe(1);
  });

  it.each([
    ["unknown target", "declare const target: string; const hidden = import(target);"],
    ["missing module", 'import type { Missing } from "./missing.js";'],
    ["invalid syntax", "export interface Broken {"],
  ])("rejects %s without claiming closure", (_kind, source) => {
    const f = fixture();
    positive(f);
    f.append(core[0]!, source);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.report.architectureComplete).toBe(false);
  });

  it("follows a clean intermediate barrel to the forbidden legacy dependency", () => {
    const f = fixture();
    positive(f);
    const barrel = "src/ir/core/barrel.ts";
    f.put(barrel, 'export type { AstInput } from "../nodes.js";');
    f.policy.files.push({ path: barrel, state: "clean", layer: "ir-core" });
    f.append(core[0]!, 'export type { AstInput } from "./barrel.js";');
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-transitive-path");
  });

  it("pins five actual activations, narrow model access and the unfinished full-node destination", () => {
    const policy = JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
    expect(policy.layers.find((layer: { id: string }) => layer.id === "ir-core")).toEqual(
      expect.objectContaining({ status: "active", entries: expect.arrayContaining(core), minModules: 11 }),
    );
    expect(policy.activationHistory).toContainEqual(
      expect.objectContaining({ layer: "ir-core", entries: core, minModules: 5 }),
    );
    expect(policy.allowedEdges["ir-core"]).toEqual(["ir-core", "foundation", "wasm-model"]);
    for (const path of core)
      expect(policy.files.find((file: { path: string }) => file.path === path)).toEqual({
        path,
        state: "clean",
        layer: "ir-core",
      });
    const nodes = policy.files.find((file: { path: string }) => file.path === old);
    expect(nodes.state).toBe("unmigrated");
    expect(nodes.nextBoundary).toContain("src/ir/core/nodes.ts");
  });
});
