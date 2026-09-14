// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const foundation = ["source-origin.ts", "ir-identity.ts", "identity-values.ts"].map(
  (name) => `src/shared/contracts/${name}`,
);
const core = "src/ir/core/binding-key-primitives.ts";
const program = ["src/ir/program/abi-inventory.ts", "src/ir/program/abi.ts"];
const clean = [...foundation, core, ...program];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-abi-seam-boundary-"));
  roots.push(root);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), content);
  };
  for (const path of clean) put(path, readFileSync(resolve(repository, path), "utf8"));
  const debt = ["src/ir/identity.ts", "src/ir/program-abi.ts"];
  put(debt[0], "export interface IrUnitInventory { readonly source: unknown; }\n");
  put(debt[1], 'export { ProgramAbiMap } from "./program/abi.js";\n');
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
        minModules: 3,
      },
      { id: "core", status: "active", roots: ["src/ir/core"], required: true, entries: [core], minModules: 1 },
      { id: "program", status: "active", roots: ["src/ir/program"], required: true, entries: program, minModules: 2 },
      { id: "legacy", status: "debt", roots: debt },
    ],
    files: [
      ...clean.map((path) => ({
        path,
        state: "clean",
        layer: foundation.includes(path) ? "foundation" : path === core ? "core" : "program",
      })),
      ...debt.map((path) => ({ path, state: "unmigrated", layer: "legacy" })),
    ],
    allowedEdges: {
      foundation: ["foundation"],
      core: ["foundation", "core"],
      program: ["foundation", "core", "program"],
      legacy: ["foundation", "core", "program", "legacy"],
    },
    nonModules: [],
    externalPackages: [],
    moves: [],
    evidence: [],
    activationHistory: [],
  };
  const run = (mode = "inventory") => {
    put("policy.json", JSON.stringify(policy));
    const child = spawnSync(
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
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    const report = JSON.parse(child.stdout);
    return { status: child.status, report };
  };
  const append = (path: string, content: string) =>
    put(path, readFileSync(resolve(root, path), "utf8") + "\n" + content);
  return { root, put, append, run, policy };
}

describe("program ABI seam boundaries", () => {
  it("loads only the canonical closure and executes a nonempty data-only ABI lifecycle in a fresh process", () => {
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      import { realpathSync } from 'node:fs';
      import { relative, resolve, sep } from 'node:path';
      const root = realpathSync(process.cwd());
      const allowed = new Set(${JSON.stringify(clean)});
      const visited = new Set();
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url.startsWith('data:')) return result;
        if (!result.url.startsWith('file:')) throw new Error('Forbidden ABI dependency: ' + result.url);
        const path = relative(root, realpathSync(fileURLToPath(result.url))).split(sep).join('/');
        if (!allowed.has(path)) throw new Error('Forbidden ABI dependency: ' + path);
        visited.add(path);
        return result;
      }});
      const { ProgramAbiMap, ProgramAbiInvariantError } = await import('./src/ir/program/abi.ts');
      const { irSourceGlobalBindingKey } = await import('./src/ir/core/binding-key-primitives.ts');
      const { createIrBindingId } = await import('./src/shared/contracts/identity-values.ts');
      const source = 'ir-source:v1:0000000000000000:entry:fixture.ts';
      const unit = 'ir-unit:v1:data-only-fixture';
      const inventory = { sources: [{ id: source, order: 0 }], allUnits: [{ id: unit, sourceId: source, terminalOwnerId: unit }], terminalUnits: [{ id: unit }], classes: [] };
      const fn = createIrBindingId({ ownerId: unit, domain: 'callable', role: 'body' });
      const global = createIrBindingId({ ownerId: source, domain: 'global', role: 'value' });
      const abi = new ProgramAbiMap(inventory);
      abi.plan({ id: fn, displayName: 'fn', order: { sourceOrder: 0, declarationOrder: 0 }, slotPolicy: 'required', slotSpace: 'function', intent: { kind: 'callable', origin: 'source', unitId: unit, signature: { params: [], results: ['f64'] } } });
      abi.plan({ id: global, displayName: 'global', order: { sourceOrder: 0, declarationOrder: 1 }, slotPolicy: 'required', slotSpace: 'global', structuralReferenceKey: irSourceGlobalBindingKey(global, 'dom'), intent: { kind: 'global', origin: 'source', capability: 'dom', sourceId: source, unitId: unit, valueType: 'externref', mutable: true } });
      assert.equal(abi.inventory, inventory);
      assert.throws(() => abi.finishBinding(), error => error instanceof ProgramAbiInvariantError && error.code === 'planning-not-sealed');
      abi.sealPlan();
      abi.bindFinalIndex(fn, { space: 'function', index: 3 });
      abi.bindFinalIndex(global, { space: 'global', index: 3 });
      abi.finishBinding();
      assert.equal(abi.entries().length, 2);
      assert.deepEqual(abi.resolveFinalIndex(fn), { space: 'function', index: 3 });
      for (const path of ['src/ir/identity.ts', 'src/ir/program-abi.ts', 'src/ir/abi-bindings.ts', 'src/ir/nodes.ts', 'src/ts-api.ts', 'src/compiler.ts']) {
        const url = pathToFileURL(resolve(root, path)).href;
        const injected = 'data:text/javascript,' + encodeURIComponent('import ' + JSON.stringify(url));
        await assert.rejects(import(injected), /Forbidden ABI dependency:/);
      }
      assert.ok(visited.has('src/ir/program/abi.ts'));
      assert.ok(visited.has('src/ir/core/binding-key-primitives.ts'));
      assert.ok(visited.has('src/shared/contracts/identity-values.ts'));
      console.log(JSON.stringify({ visited: [...visited].sort(), planned: abi.entries().length }));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: repository,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report.planned).toBe(2);
    expect(report.visited.length).toBeGreaterThanOrEqual(3);
    expect(report.visited.every((path: string) => clean.includes(path))).toBe(true);
  });

  it("checks six actual clean modules with D0 while retaining the legacy debt", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, JSON.stringify(result.report.errors)).toBe(0);
    expect(result.report.counts.total).toBe(8);
    expect(result.report.resolvedEdgeCount).toBeGreaterThanOrEqual(8);
    expect(result.report.unknownEdges).toEqual([]);
    expect(result.report.unresolvedEdges).toEqual([]);
    expect(result.report.activatedRoots).toEqual([
      expect.objectContaining({ layer: "foundation", modules: 3, visitedEntries: foundation }),
      expect.objectContaining({ layer: "core", modules: 1, visitedEntries: [core] }),
      expect.objectContaining({ layer: "program", modules: 2, visitedEntries: program }),
    ]);
    expect(result.report.architectureComplete).toBe(false);
    expect(f.run("complete").status).not.toBe(0);
  });

  it.each([
    ["type-only import", 'import type { IrUnitInventory } from "../identity.js";'],
    ["type query", 'type Hidden = import("../identity.js").IrUnitInventory;'],
    ["old ABI barrel", 'export { ProgramAbiMap as Old } from "../program-abi.js";'],
    ["path alias", 'import type { IrUnitInventory } from "@old/identity";'],
    ["dynamic import", 'const hidden = import("../program-abi.js");'],
  ])("D0 rejects a %s back edge from the actual ABI module", (_name, edge) => {
    const f = fixture();
    const positive = f.run();
    expect(positive.status, JSON.stringify(positive.report.errors)).toBe(0);
    expect(positive.report.counts.total).toBe(8);
    f.append(program[1], edge);
    const negative = f.run();
    expect(negative.status).not.toBe(0);
    expect(negative.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-clean-edge");
    expect(negative.report.forbiddenEdges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: program[1] })]),
    );
  });

  it("D0 follows a new barrel into the old compatibility module", () => {
    const f = fixture();
    const path = "src/ir/program/barrel.ts";
    f.put(path, 'export { ProgramAbiMap } from "../program-abi.js";');
    f.policy.files.push({ path, layer: "program", state: "clean" });
    f.append(program[1], 'export { ProgramAbiMap as Hidden } from "./barrel.js";');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.counts.total).toBe(9);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain("forbidden-transitive-path");
  });

  it("D0 resolves symlinks to their forbidden target", () => {
    const f = fixture();
    const path = "src/ir/program/alias.ts";
    symlinkSync(resolve(f.root, "src/ir/identity.ts"), resolve(f.root, path));
    f.policy.files.push({ path, layer: "program", state: "clean" });
    f.append(program[1], 'import type { IrUnitInventory } from "./alias.js";');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.forbiddenEdges).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: "src/ir/identity.ts" })]),
    );
  });

  it.each([
    ["nonliteral import", "declare const path: string; const hidden = import(path);", "unknown-clean-edge"],
    ["unresolved import", 'import type { Missing } from "./missing.js";', "unresolved-module"],
  ])("D0 cannot pass a %s", (_name, edge, code) => {
    const f = fixture();
    f.append(program[1], edge);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.report.errors.map((error: { code: string }) => error.code)).toContain(code);
  });
});
