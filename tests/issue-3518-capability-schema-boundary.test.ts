// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const checker = resolve(repository, "scripts/check-compiler-boundaries.mjs");
const schema = "src/runtime/contracts/host-capability-schema.ts";
const oldCatalog = "src/ir/runtime-host-capabilities.ts";
const foundation = "src/shared/contracts/boundary-probe.ts";
const wasmModel = "src/wasm/model/boundary-probe.ts";
const core = "src/ir/core/boundary-probe.ts";
const frontend = "src/frontend/ts/boundary-probe.ts";
const barrel = "src/runtime/contracts/boundary-probe.ts";
const runtimeEdges = ["runtime-contracts", "foundation", "wasm-model"];
// #5742 independently activates the already-approved pure Wasm-model edge.
// Neither base admits runtime contracts or implementation layers from core.
const permittedCoreEdges = ["ir-core", "foundation", "wasm-model"];
const probe = "export type Probe = number; export const probe = 1;";
const scratchRoots: string[] = [];

type Layer = {
  id: string;
  status: string;
  roots: string[];
  required?: boolean;
  entries?: string[];
  minModules?: number;
};
type Classification = { path: string; state: string; layer: string };
type Policy = {
  moduleExtensions: string[];
  layers: Layer[];
  allowedEdges: Record<string, string[]>;
  files: Classification[];
};
type Edge = { from: string; to?: string; specifier: string | null; syntax: string; typeOnly: boolean };
type Report = {
  inventoryValid: boolean;
  graphComplete: boolean;
  architectureComplete: boolean;
  errors: { code: string; detail: string }[];
  edges: Edge[];
  forbiddenEdges: Edge[];
  unknownEdges: Edge[];
  unresolvedEdges: Edge[];
  transitiveViolations: { from: string; path: string[]; typeOnly: boolean }[];
  activatedRoots: { layer: string; entries: string[]; visitedEntries: string[]; modules: number; minModules: number }[];
  modules: (Classification & { hash: string })[];
  counts: { total: number; byState: Record<string, number> };
  resolvedEdgeCount: number;
  debt: Classification[];
};

let source: string;
let productionPolicy: Policy;
beforeAll(() => {
  // Deliberately requires the composed source and policy. There is no old-path,
  // source-worker, exists/skip or synthetic-schema fallback for this suite.
  source = readFileSync(resolve(repository, schema), "utf8");
  productionPolicy = JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
});

function fixture() {
  const scratch = resolve(repository, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "issue-3518-capability-schema-boundary-"));
  scratchRoots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  const active = new Map([
    ["runtime-contracts", schema],
    ["foundation", foundation],
    ["wasm-model", wasmModel],
    ["ir-core", core],
    ["frontend-ts", frontend],
  ]);
  const policy = {
    schema: "compiler-boundaries-v1",
    sourceRoot: "src",
    tsconfig: "tsconfig.json",
    requireGitProvenance: false,
    moduleExtensions: productionPolicy.moduleExtensions,
    layers: productionPolicy.layers.map((layer): Layer => {
      const entry = active.get(layer.id);
      return entry
        ? {
            id: layer.id,
            status: "active",
            roots: layer.id === "runtime-contracts" ? [...layer.roots] : [entry],
            required: true,
            entries: [entry],
            minModules: 1,
          }
        : { id: layer.id, status: "debt", roots: layer.roots };
    }),
    // All production allowed-edge rules are retained, not widened for fixtures.
    allowedEdges: structuredClone(productionPolicy.allowedEdges),
    files: [
      ...Array.from(active, ([layer, path]) => ({ path, layer, state: "clean" })),
      { ...productionPolicy.files.find((file) => file.path === oldCatalog)! },
    ],
    nonModules: [],
    externalPackages: [],
    moves: [],
    evidence: [],
    activationHistory: [{ layer: "runtime-contracts", entries: [schema], minModules: 1 }],
  };
  put(schema, source);
  for (const path of [foundation, wasmModel, core, frontend, oldCatalog]) put(path, probe);
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
      include: ["src/**/*"],
    }),
  );
  const addBarrel = (text: string) => {
    put(barrel, text);
    // Classify only this synthetic helper inside the existing directory root.
    // The required entry remains the canonical schema, never the helper.
    policy.files.push({ path: barrel, layer: "runtime-contracts", state: "clean" });
  };
  const append = (text: string) => put(schema, source + "\n" + text + "\n");
  const run = (mode = "inventory") => {
    put("policy.json", JSON.stringify(policy));
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", checker, "--root", root, "--config", "policy.json", "--mode", mode, "--json"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: process.env },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect([0, 1], child.stderr + child.stdout).toContain(child.status);
    return { exit: child.status, report: JSON.parse(child.stdout) as Report };
  };
  return { root, policy, put, append, addBarrel, run };
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rejected(result: ReturnType<ReturnType<typeof fixture>["run"]>, code: string) {
  expect(result.exit).toBe(1);
  expect(result.report.inventoryValid).toBe(false);
  expect(result.report.architectureComplete).toBe(false);
  expect(result.report.errors.map((error) => error.code)).toContain(code);
}

const forbiddenTargets = [
  { target: oldCatalog, specifier: "../../ir/runtime-host-capabilities.js" },
  { target: core, specifier: "../../ir/core/boundary-probe.js" },
  { target: frontend, specifier: "../../frontend/ts/boundary-probe.js" },
];
const backEdges = [
  { text: 'import { probe } from "TARGET";', syntax: "import", typeOnly: false },
  { text: 'import type { Probe } from "TARGET";', syntax: "import", typeOnly: true },
  { text: 'type BackEdge = import("TARGET").Probe;', syntax: "import-type", typeOnly: true },
  { text: 'export type { Probe } from "TARGET";', syntax: "export-from", typeOnly: true },
  { text: 'export * from "TARGET";', syntax: "export-star", typeOnly: false },
  { text: 'void import("TARGET");', syntax: "dynamic-import", typeOnly: false },
  { text: 'const back = require("TARGET");', syntax: "require", typeOnly: false },
  { text: 'import back = require("TARGET");', syntax: "import-equals", typeOnly: false },
];

describe("#3518 capability schema compiler boundaries", () => {
  it("requires the one real leaf activation without widening policy or cleaning the old catalog", () => {
    expect(productionPolicy.layers.find((layer) => layer.id === "runtime-contracts")).toMatchObject({
      status: "active",
      roots: ["src/runtime/contracts"],
      required: true,
      entries: [schema],
      minModules: 1,
    });
    expect(productionPolicy.files.filter((file) => file.path === schema)).toEqual([
      expect.objectContaining({ state: "clean", layer: "runtime-contracts" }),
    ]);
    expect(productionPolicy.files.filter((file) => file.path === oldCatalog)).toEqual([
      expect.objectContaining({ state: "unmigrated", layer: "mixed-needs-split" }),
    ]);
    expect(productionPolicy.allowedEdges["runtime-contracts"]).toEqual(runtimeEdges);
    expect(productionPolicy.allowedEdges["ir-core"]).toEqual(expect.arrayContaining(["ir-core", "foundation"]));
    expect(productionPolicy.allowedEdges["ir-core"].filter((edge) => !permittedCoreEdges.includes(edge))).toEqual([]);
  });

  it("binds a nonempty 25-type/14-constant schema, with immutable constant initializers", () => {
    const tree = ts.createSourceFile(schema, source, ts.ScriptTarget.Latest, true);
    const types = tree.statements.filter((node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node));
    const variables = tree.statements.filter(ts.isVariableStatement);
    expect(types).toHaveLength(25);
    expect(variables).toHaveLength(14);
    expect(tree.statements).toHaveLength(39);
    for (const statement of variables) {
      expect(statement.declarationList.flags & ts.NodeFlags.Const).not.toBe(0);
      expect(statement.declarationList.declarations).toHaveLength(1);
      const declaration = statement.declarationList.declarations[0]!;
      const initializer = declaration.initializer!;
      if (declaration.name.getText(tree) === "HOST_CALLBACK_EXCEPTION_POLICY") {
        expect(initializer.getText(tree)).toBe('"module-tag-payload" as const');
      } else {
        expect(ts.isCallExpression(initializer)).toBe(true);
        if (ts.isCallExpression(initializer)) expect(initializer.expression.getText(tree)).toBe("Object.freeze");
      }
    }
  });

  it("visits the actual import-free schema and retains catalog debt, not a retirement verdict", () => {
    const f = fixture();
    const result = f.run();
    expect(result.exit).toBe(0);
    expect(result.report.errors).toEqual([]);
    expect(result.report.counts).toMatchObject({ total: 6, byState: { clean: 5, unmigrated: 1 } });
    expect(result.report.activatedRoots).toContainEqual({
      layer: "runtime-contracts",
      entries: [schema],
      visitedEntries: [schema],
      modules: 1,
      minModules: 1,
    });
    expect(result.report.modules).toContainEqual(
      expect.objectContaining({ path: schema, hash: createHash("sha256").update(source).digest("hex") }),
    );
    expect(result.report.edges).toEqual([]);
    expect(result.report.resolvedEdgeCount).toBe(0);
    expect(result.report.unknownEdges).toEqual([]);
    expect(result.report.unresolvedEdges).toEqual([]);
    expect(result.report.graphComplete).toBe(true);
    expect(result.report.architectureComplete).toBe(false);
    expect(result.report.debt).toEqual([expect.objectContaining({ path: oldCatalog, state: "unmigrated" })]);
    const complete = f.run("complete");
    expect(complete.exit).toBe(1);
    expect(complete.report.inventoryValid).toBe(true);
    expect(complete.report.architectureComplete).toBe(false);
  });

  it.each([
    { target: foundation, specifier: "../../shared/contracts/boundary-probe.js" },
    { target: wasmModel, specifier: "../../wasm/model/boundary-probe.js" },
    { target: barrel, specifier: "./boundary-probe.js" },
  ])("resolves allowed policy edges to $target without changing the real import-free leaf", ({ target, specifier }) => {
    const f = fixture();
    if (target === barrel) f.addBarrel(probe);
    f.append(`import type { Probe } from "${specifier}";`);
    const result = f.run();
    expect(result.exit).toBe(0);
    expect(result.report.errors).toEqual([]);
    expect(result.report.resolvedEdgeCount).toBe(1);
    expect(result.report.edges).toContainEqual(expect.objectContaining({ from: schema, to: target, typeOnly: true }));
  });

  it.each(forbiddenTargets.flatMap((target) => backEdges.map((edge) => ({ ...target, ...edge }))))(
    "rejects $syntax typeOnly=$typeOnly from the schema to $target",
    ({ target, specifier, text, syntax, typeOnly }) => {
      const f = fixture();
      f.append(text.replace("TARGET", specifier));
      const result = f.run();
      rejected(result, "forbidden-clean-edge");
      expect(result.report.unresolvedEdges).toEqual([]);
      expect(result.report.unknownEdges).toEqual([]);
      expect(result.report.forbiddenEdges).toContainEqual(
        expect.objectContaining({ from: schema, to: target, syntax, typeOnly }),
      );
    },
  );

  it.each(backEdges.filter((edge) => ["import", "export-from"].includes(edge.syntax) && edge.typeOnly))(
    "also forbids IR core $syntax from depending on the runtime schema",
    ({ text, syntax }) => {
      const f = fixture();
      f.put(
        core,
        text
          .replace("TARGET", "../../runtime/contracts/host-capability-schema.js")
          .replace("Probe", "RuntimeHostCapabilityId"),
      );
      const result = f.run();
      rejected(result, "forbidden-clean-edge");
      expect(result.report.forbiddenEdges).toContainEqual(
        expect.objectContaining({ from: core, to: schema, syntax, typeOnly: true }),
      );
    },
  );

  it.each(["dynamic-import", "require"])("reports a nonliteral %s as unknown, never an empty graph", (syntax) => {
    const f = fixture();
    f.append(`declare const target: string; void ${syntax === "dynamic-import" ? "import" : "require"}(target);`);
    const result = f.run();
    rejected(result, "unknown-clean-edge");
    expect(result.report.graphComplete).toBe(false);
    expect(result.report.unknownEdges).toEqual([
      expect.objectContaining({ from: schema, specifier: null, syntax, typeOnly: false }),
    ]);
  });

  it.each(backEdges.filter((edge) => edge.syntax !== "import" && edge.syntax !== "export-from"))(
    "fails closed for a missing literal $syntax target",
    ({ text, syntax, typeOnly }) => {
      const f = fixture();
      f.append(text.replace("TARGET", "./missing.js"));
      const result = f.run();
      rejected(result, "unresolved-module");
      expect(result.report.graphComplete).toBe(false);
      expect(result.report.unresolvedEdges).toEqual([
        expect.objectContaining({ from: schema, specifier: "./missing.js", syntax, typeOnly }),
      ]);
    },
  );

  it.each(["delete", "delete-and-unclassify", "rename"])("cannot satisfy the required leaf after %s", (operation) => {
    const f = fixture();
    if (operation === "rename") {
      const renamed = schema.replace("host-capability-schema.ts", "renamed-schema.ts");
      renameSync(resolve(f.root, schema), resolve(f.root, renamed));
      f.policy.files.find((file) => file.path === schema)!.path = renamed;
    } else {
      rmSync(resolve(f.root, schema));
      if (operation === "delete-and-unclassify") f.policy.files = f.policy.files.filter((file) => file.path !== schema);
    }
    const result = f.run();
    rejected(result, "missing-activated-root");
    expect(result.report.activatedRoots).toContainEqual(
      expect.objectContaining({
        layer: "runtime-contracts",
        visitedEntries: [],
        modules: operation === "rename" ? 1 : 0,
      }),
    );
  });

  it("rejects malformed canonical source instead of accepting a partial AST", () => {
    const f = fixture();
    f.append("export interface Broken { value: ;");
    const result = f.run();
    rejected(result, "parse-error");
    expect(result.report.errors).toContainEqual(
      expect.objectContaining({ code: "parse-error", detail: expect.stringContaining(schema) }),
    );
  });

  it.each([
    {
      text: 'export type { Probe } from "../../ir/runtime-host-capabilities.js";',
      terminal: oldCatalog,
      code: "forbidden-clean-edge",
    },
    {
      text: 'import type { Probe } from "../../ir/core/boundary-probe.js";',
      terminal: core,
      code: "forbidden-clean-edge",
    },
    { text: 'void import("../../frontend/ts/boundary-probe.js");', terminal: frontend, code: "forbidden-clean-edge" },
    {
      text: "declare const target: string; void import(target);",
      terminal: "<unknown dependency>",
      code: "unknown-clean-edge",
    },
    { text: 'const missing = require("./missing.js");', terminal: "./missing.js", code: "unresolved-module" },
  ])("follows a permitted peer barrel to forbidden or incomplete dependency $terminal", ({ text, terminal, code }) => {
    const f = fixture();
    f.append('export * from "./boundary-probe.js";');
    f.addBarrel(text);
    const result = f.run();
    rejected(result, code);
    expect(result.report.edges).toContainEqual(expect.objectContaining({ from: schema, to: barrel }));
    expect(result.report.transitiveViolations).toContainEqual(
      expect.objectContaining({ from: schema, path: [schema, barrel, terminal] }),
    );
  });

  it("does not let IR core reach runtime contracts through an otherwise allowed foundation barrel", () => {
    const f = fixture();
    f.put(core, 'export * from "../../shared/contracts/boundary-probe.js";');
    f.put(
      foundation,
      'export type { RuntimeHostCapabilityId } from "../../runtime/contracts/host-capability-schema.js";',
    );
    const result = f.run();
    rejected(result, "forbidden-transitive-path");
    expect(result.report.transitiveViolations).toContainEqual(
      expect.objectContaining({ from: core, path: [core, foundation, schema], typeOnly: true }),
    );
  });
});
