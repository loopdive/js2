// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import * as old from "../src/ir/identity.js";
import * as compatibility from "../src/ir/identity-values.js";
import * as shared from "../src/shared/contracts/identity-values.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";

const root = resolve(import.meta.dirname, "..");
const foundation = ["source-origin.ts", "ir-identity.ts", "identity-values.ts"];

describe("identity foundation extraction", () => {
  it("preserves the single implementation and exact pre-extraction serialized IDs", () => {
    expect(old.createIrBindingId).toBe(shared.createIrBindingId);
    expect(old.createDerivedIrUnitId).toBe(shared.createDerivedIrUnitId);
    for (const key of Object.keys(shared) as (keyof typeof shared)[]) expect(compatibility[key]).toBe(shared[key]);
    const source = old.createIrSourceId({ kind: "entry", order: 0, sourceKey: "entry.ts" });
    const unit = old.createIrUnitId({ sourceId: source, lexicalOwnerId: null, kind: "top-level-function", ordinal: 2 });
    expect(source).toBe("ir-source:v1:0000000000000000:entry:entry.ts");
    expect(unit).toBe(
      "ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aentry.ts:root:top-level-function:0000000000000002",
    );
    expect(shared.createDerivedIrUnitId({ parentId: unit, role: "ir-async-state", ordinal: 7 })).toBe(
      "ir-unit:v1:derived:ir-unit%3Av1%3Air-source%253Av1%253A0000000000000000%253Aentry%253Aentry.ts%3Aroot%3Atop-level-function%3A0000000000000002:ir-async-state:0000000000000007",
    );
    expect(
      JSON.stringify(shared.createIrBindingId({ ownerId: source, domain: "support", role: "a/☃", ordinal: 3 })),
    ).toBe(
      '"ir-binding:v1:support:ir-source%3Av1%3A0000000000000000%3Aentry%3Aentry.ts:a%2F%E2%98%83:0000000000000003"',
    );
    for (const [input, encoded] of [
      ["", ""],
      ["a/☃:%", "a%2F%E2%98%83%3A%25"],
      ["😀", "%F0%9F%98%80"],
    ])
      expect(shared.irIdentityComponent(input!)).toBe(encoded);
    for (const [value, encoded] of [
      [0, "0000000000000000"],
      [-0, "0000000000000000"],
      [Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ] as const) {
      expect(shared.canonicalIrIdentityNumber(value, "ordinal")).toBe(encoded);
      expect(
        shared.createDerivedIrUnitId({ parentId: "owner" as old.IrUnitId, role: "lifted-closure", ordinal: value }),
      ).toBe(`ir-unit:v1:derived:owner:lifted-closure:${encoded}`);
      expect(
        shared.createIrBindingId({ ownerId: "owner" as old.IrUnitId, domain: "type", role: "frame", ordinal: value }),
      ).toBe(`ir-binding:v1:type:owner:frame:${encoded}`);
    }
    expect(shared.createIrBindingId({ ownerId: "owner" as old.IrUnitId, domain: "global", role: "value" })).toBe(
      "ir-binding:v1:global:owner:value:0000000000000000",
    );
  });

  it("retains invalid ordinal refusals through both import paths", () => {
    const parentId = "ir-unit:v1:test" as old.IrUnitId;
    for (const ordinal of [-1, 0.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => shared.canonicalIrIdentityNumber(ordinal, "ordinal")).toThrow(RangeError);
      for (const api of [old, shared]) {
        expect(() => api.createDerivedIrUnitId({ parentId, role: "lifted-closure", ordinal })).toThrow(RangeError);
        expect(() => api.createIrBindingId({ ownerId: parentId, domain: "support", role: "frame", ordinal })).toThrow(
          RangeError,
        );
      }
    }
  });

  it("uses the compatibility identities in real inventory, IR builder and prepared ABI consumers", () => {
    const source = ts.createSourceFile(
      "/repo/entry.ts",
      "export function value(): number { return 4; }",
      ts.ScriptTarget.Latest,
      true,
    );
    const inventory = old.buildIrUnitInventory([source], { entrySource: source });
    const unit = inventory.terminalUnits.find((row) => row.displayName === "value")!;
    expect(unit).toBeDefined();
    const f64 = { kind: "val", val: { kind: "f64" } } as const;
    const builder = new IrFunctionBuilder({ unitId: unit.id, name: unit.displayName }, [f64], true);
    builder.openBlock();
    const value = builder.emitConst({ kind: "f64", value: 4 }, f64);
    builder.terminate({ kind: "return", values: [value] });
    const entries = prepareIrProgramAbiEntries({
      inventory,
      ir: { functions: [builder.finish()] },
      derivedUnits: [],
      globals: [],
      startup: [],
      callables: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.plan.id).toBe(irUnitCallableBindingId(unit.id));
    expect(entries[0]!.plan.id).toBe(shared.createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" }));
  });

  it("keeps distinct brands rejected by the actual TypeScript checker", () => {
    const file = resolve(root, "src/shared/contracts/__brand_probe.ts");
    const content = `import type { IrSourceId, IrUnitId, IrClassId, IrBindingId } from './ir-identity.js';
      declare const unit: IrUnitId;
      const same: IrUnitId = unit;
      const source: IrSourceId = unit;
      const cls: IrClassId = unit;
      const binding: IrBindingId = unit;`;
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      noLib: true,
      types: [],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host),
      exists = host.fileExists.bind(host);
    host.readFile = (path) => (path === file ? content : read(path));
    host.fileExists = (path) => path === file || exists(path);
    const program = ts.createProgram([file], options, host);
    const errors = ts.getPreEmitDiagnostics(program).filter((row) => row.file?.fileName === file);
    expect(errors.map((row) => row.code)).toEqual([2322, 2322, 2322]);
  });

  it("checks the real nonempty foundation and rejects a type-only edge back to old identity", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "js2-f0-boundary-"));
    const put = (path: string, text: string) => {
      const full = resolve(fixture, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    try {
      for (const file of foundation)
        put(`src/shared/contracts/${file}`, readFileSync(resolve(root, `src/shared/contracts/${file}`), "utf8"));
      put("src/ir/identity.ts", "export interface IrUnitInventory { readonly units: readonly string[]; }\n");
      put(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }),
      );
      put(
        "policy.json",
        JSON.stringify({
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
              entries: foundation.map((file) => `src/shared/contracts/${file}`),
              minModules: 3,
            },
            { id: "frontend", status: "debt", roots: ["src/ir"] },
          ],
          files: [
            ...foundation.map((file) => ({
              path: `src/shared/contracts/${file}`,
              layer: "foundation",
              state: "clean",
            })),
            { path: "src/ir/identity.ts", layer: "frontend", state: "unmigrated" },
          ],
          allowedEdges: { foundation: ["foundation"], frontend: ["foundation", "frontend"] },
          nonModules: [],
          externalPackages: [],
          moves: [],
          evidence: [],
          activationHistory: [],
        }),
      );
      const run = () =>
        spawnSync(
          process.execPath,
          [
            resolve(root, "scripts/check-compiler-boundaries.mjs"),
            "--root",
            fixture,
            "--config",
            "policy.json",
            "--mode",
            "inventory",
          ],
          { encoding: "utf8" },
        );
      const positive = run();
      expect(positive.status, positive.stderr + positive.stdout).toBe(0);
      expect(positive.stdout).toContain('"architectureComplete": false');
      const report = JSON.parse(positive.stdout);
      expect(report.counts.total).toBe(4);
      expect(report.resolvedEdgeCount).toBe(2);
      expect(report.activatedRoots).toEqual([
        expect.objectContaining({ layer: "foundation", modules: 3, minModules: 3 }),
      ]);
      put(
        "src/shared/contracts/source-origin.ts",
        readFileSync(resolve(root, "src/shared/contracts/source-origin.ts"), "utf8") +
          '\nexport type { IrUnitInventory } from "../../ir/identity.js";\n',
      );
      const negative = run();
      expect(negative.status).not.toBe(0);
      expect(negative.stdout).toContain("src/ir/identity.ts");
      expect(negative.stdout).toContain("forbidden");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
