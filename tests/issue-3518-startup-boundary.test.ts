// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const startup = "src/ir/program/startup.ts";
const foundation = ["src/shared/contracts/ir-identity.ts", "src/shared/contracts/source-origin.ts"];
const clean = [...foundation, startup];
const old = "src/ir/module-init-plan.ts";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-startup-boundary-"));
  roots.push(root);
  const put = (path: string, source: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), source);
  };
  for (const path of clean) put(path, readFileSync(resolve(repository, path), "utf8"));
  put(old, "export interface AstInput { readonly syntax: unknown; }\n");
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@old/*": ["src/ir/*"] },
      },
      include: ["src"],
    }),
  );
  const policy = {
    schema: "compiler-boundaries-v1",
    sourceRoot: "src",
    tsconfig: "tsconfig.json",
    requireGitProvenance: false,
    moduleExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    layers: [
      {
        id: "foundation",
        status: "active",
        roots: ["src/shared/contracts"],
        required: true,
        entries: foundation,
        minModules: 2,
      },
      { id: "program", status: "active", roots: ["src/ir/program"], required: true, entries: [startup], minModules: 1 },
      { id: "legacy", status: "debt", roots: [old] },
    ],
    files: [
      ...clean.map((path) => ({ path, state: "clean", layer: path === startup ? "program" : "foundation" })),
      { path: old, state: "unmigrated", layer: "legacy" },
    ],
    allowedEdges: {
      foundation: ["foundation"],
      program: ["program", "foundation"],
      legacy: ["legacy", "program", "foundation"],
    },
    nonModules: [],
    externalPackages: [],
    moves: [],
    evidence: [],
    activationHistory: [{ layer: "program", entries: [startup], minModules: 1 }],
  };
  const run = (mode = "inventory") => {
    put("policy.json", JSON.stringify(policy));
    const result = spawnSync(
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
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  return {
    root,
    policy,
    put,
    run,
    append: (path: string, source: string) => put(path, `${readFileSync(resolve(root, path), "utf8")}\n${source}\n`),
  };
}

function positive(f: ReturnType<typeof fixture>) {
  const result = f.run();
  expect(result.status, JSON.stringify(result.report.errors)).toBe(0);
  expect(result.report.counts.total).toBe(4);
  expect(result.report.resolvedEdgeCount).toBe(2);
  expect(result.report.unknownEdges).toEqual([]);
  expect(result.report.unresolvedEdges).toEqual([]);
  expect(result.report.activatedRoots).toEqual([
    expect.objectContaining({ layer: "foundation", modules: 2, visitedEntries: foundation }),
    expect.objectContaining({ layer: "program", modules: 1, visitedEntries: [startup] }),
  ]);
  return result;
}

describe("#3518 startup contract: actual D0 boundary enforcement", () => {
  it("resolves the three real data modules without pretending the legacy producer is migrated", () => {
    const f = fixture();
    expect(positive(f).report.architectureComplete).toBe(false);
    expect(f.run("complete").status).not.toBe(0);
  });

  it.each([
    ["type import", 'import type { AstInput } from "../module-init-plan.js";'],
    ["type query", 'type Hidden = import("../module-init-plan.js").AstInput;'],
    ["alias", 'import type { AstInput } from "@old/module-init-plan";'],
    ["re-export", 'export type { AstInput } from "../module-init-plan.js";'],
    ["dynamic import", 'const hidden = import("../module-init-plan.js");'],
  ])("rejects a %s back edge in the canonical startup module", (_name, source) => {
    const f = fixture();
    positive(f);
    f.append(startup, source);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-clean-edge");
    expect(result.report.forbiddenEdges).toEqual(expect.arrayContaining([expect.objectContaining({ from: startup })]));
  });

  it("follows an added clean barrel to a forbidden old-path dependency", () => {
    const f = fixture();
    positive(f);
    const barrel = "src/ir/program/barrel.ts";
    f.put(barrel, 'export type { AstInput } from "../module-init-plan.js";');
    f.policy.files.push({ path: barrel, state: "clean", layer: "program" });
    f.append(startup, 'export type { AstInput } from "./barrel.js";');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.counts.total).toBe(5);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-transitive-path");
  });

  it.each([
    ["nonliteral import", "declare const target: string; const hidden = import(target);"],
    ["unresolved import", 'import type { Missing } from "./missing.js";'],
    ["parse failure", "export interface Broken {"],
  ])("does not treat %s as a closed dependency graph", (_name, source) => {
    const f = fixture();
    positive(f);
    f.append(startup, source);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.architectureComplete).toBe(false);
    expect(result.report.errors.length).toBeGreaterThan(0);
  });

  it("fails when the required startup entry is missing", () => {
    const f = fixture();
    positive(f);
    rmSync(resolve(f.root, startup));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("missing-activated-root");
  });

  it("keeps the real policy activation and pending full-schema obligation visible", () => {
    const policy = JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
    expect(policy.layers.find((layer: { id: string }) => layer.id === "ir-program")).toEqual(
      expect.objectContaining({ status: "active", entries: expect.arrayContaining([startup]) }),
    );
    expect(policy.activationHistory).toContainEqual(
      expect.objectContaining({ layer: "ir-program", entries: expect.arrayContaining([startup]) }),
    );
    expect(policy.files.find((file: { path: string }) => file.path === startup)).toEqual({
      path: startup,
      state: "clean",
      layer: "ir-program",
    });
    const program = policy.files.find((file: { path: string }) => file.path === "src/ir/program.ts");
    expect(program.state).toBe("unmigrated");
    expect(program.nextBoundary).toContain("src/ir/program/index.ts");
    expect(policy.files.find((file: { path: string }) => file.path === old).state).toBe("unmigrated");
  });
});
