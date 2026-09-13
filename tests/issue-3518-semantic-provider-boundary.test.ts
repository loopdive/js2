// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
// Fixed specification population, independent of discovered imports and policy.
const groups = {
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
const required = Object.values(groups).flat();
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
function assertNewActivations(history: unknown[]) {
  expect(history[0]).toEqual({ layer: "native-runtime", entries: groups["native-runtime"], minModules: 6 });
  expect(history.slice(1, 3)).toEqual(
    (["native-runtime", "wasm-physical"] as const).map((layer) => ({
      layer,
      entries: groups[layer].filter((path) => !delayCombinatorAdditions.includes(path)),
      minModules: groups[layer].filter((path) => !delayCombinatorAdditions.includes(path)).length,
    })),
  );
  expect(history.slice(3, 9)).toEqual(
    (["native-runtime", "wasm-model", "wasm-physical", "ir-core", "ir-analysis", "ir-runtime"] as const).map(
      (layer) => ({
        layer,
        entries: groups[layer].filter((path) => ![...frameAdditions, ...delayCombinatorAdditions].includes(path)),
        minModules: groups[layer].filter((path) => ![...frameAdditions, ...delayCombinatorAdditions].includes(path))
          .length,
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
  it("pins the original 63 modules plus two delay/combinator owners without relaxing historical policy", () => {
    expect(required).toHaveLength(65);
    expect(new Set(required).size).toBe(65);
    expect(delayCombinatorAdditions).toHaveLength(2);
    expect(frameAdditions).toHaveLength(3);
    expect(physicalAdditions).toHaveLength(3);
    expect(settlementAdditions).toHaveLength(1);
    expect(
      required.filter(
        (path) =>
          ![...physicalAdditions, ...settlementAdditions, ...frameAdditions, ...delayCombinatorAdditions].includes(
            path,
          ),
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
    ])
      expect(required).toContain(path);
    const p = policy();
    assertNewActivations(p.activationHistory);
    expect(p.activationHistory).toHaveLength(27);
    expect(digest(p.activationHistory.slice(3))).toBe(
      "3437a59aacf39df9dffcafa8099ac9f47c0f43a7a0ecc423df4c1fe3e638f002",
    );
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    // Exact full activation history at b4c116639a, not a selected subset.
    expect(digest(p.activationHistory.slice(9))).toBe(
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
    expect(r.report.counts.total).toBe(65);
    expect(r.report.errors).toEqual([]);
    for (const field of ["unknownEdges", "unresolvedEdges", "forbiddenEdges", "transitiveViolations"])
      expect(r.report[field]).toEqual([]);
    expect(r.report.resolvedEdgeCount).toBe(212);
    expect(r.report.counts.resolvedEdgesByType).toEqual({ typeOnly: 150, runtime: 62 });
  });

  it.each(["delete", "reorder", "layer", "entries", "minimum"] as const)(
    "rejects %s corruption of the new activation records",
    (mutation) => {
      const history = policy().activationHistory;
      if (mutation === "delete") history.splice(0, 1);
      if (mutation === "reorder") [history[0], history[1]] = [history[1], history[0]];
      if (mutation === "layer") history[0].layer = "ir-program";
      if (mutation === "entries") history[0].entries.pop();
      if (mutation === "minimum") history[0].minModules--;
      expect(() => assertNewActivations(history)).toThrow();
    },
  );

  it.each([...additions, ...physicalAdditions, ...settlementAdditions, ...frameAdditions, ...delayCombinatorAdditions])(
    "rejects deleting %s and its classification",
    (path) => {
      const f = fixture();
      rmSync(resolve(f.root, path));
      f.p.files = f.p.files.filter((row: { path: string }) => row.path !== path);
      for (const mode of ["inventory", "complete"]) {
        const r = f.run(mode);
        expect(r.status).not.toBe(0);
        expect(r.report.errors.map((e: { code: string }) => e.code)).toContain("missing-activated-root");
      }
    },
  );

  it.each([...additions, ...physicalAdditions, ...settlementAdditions, ...frameAdditions, ...delayCombinatorAdditions])(
    "rejects an aliased frontend type dependency from %s",
    (path) => {
      const f = fixture();
      f.put("src/forbidden.ts", "export interface Hidden { value: number }");
      f.p.files.push({ path: "src/forbidden.ts", layer: "frontend-ts", state: "unmigrated" });
      f.append(path, 'export type { Hidden } from "@forbidden";');
      const r = f.run();
      expect(r.status).toBe(1);
      expect(r.report.forbiddenEdges).toContainEqual(
        expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: true }),
      );
    },
  );

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
