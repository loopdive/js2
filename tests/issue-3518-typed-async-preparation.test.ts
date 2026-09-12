// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as legacy from "../src/ir/async-prepare.js";
import * as canonical from "../src/ir/async-prepare-ir.js";
import { verifyIrAsyncPlan } from "../src/ir/async-plan.js";
import { prepareWholeProgramAsyncFunctions } from "../src/ir/runtime-program-producers.js";
import { asValueId, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import { INTRINSIC_SIGNATURE_VERSION } from "../src/ir/intrinsics.js";
import { irImportFuncRef } from "../src/ir/callable-bindings.js";
import { NUMBER_BOUNDARY_POLICY_DISABLED, type NumberBoundaryPolicy } from "../src/ir/runtime-manifest.js";
import { createDerivedIrUnitId } from "../src/shared/contracts/identity-values.js";
import { ts } from "../src/ts-api.js";
import {
  externref,
  f64,
  identityFunction,
  oneAwaitFunction,
  producerInput,
  sourceId,
} from "./helpers/typed-middleend-fixtures.js";

const root = resolve(import.meta.dirname, "..");
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

describe("IR-only async preparation extraction", () => {
  it.each([
    "prepareSequentialCountedLoopIrFunction",
    "prepareFinalMainIrFunction",
    "prepareSuspendingIrFunction",
    "prepareSingleAwaitIrFunction",
  ] as const)("compatibility exports the identical %s function object", (name) => {
    expect(legacy[name]).toBe(canonical[name]);
  });

  // Exact declaration text (including docs), measured from the pinned base
  // 6ff05f6b. These are relocation receipts, not a claim of closed type layers.
  it.each([
    ["src/ir/async-prepare-ir.ts", 18, "7248b1647d852640982a7453b344ed0025c25a5947f8e6f14cfae9b38daad0b0"],
    ["src/ir/async-prepare.ts", 1, "0c7963b14d199a55087de9388d1497358c8208898011691bc3a9ecd0a2e87ae9"],
    ["src/ir/async-linear-prepare.ts", 16, "ad6c626fb058d6b2771cd68ca4ad9d1668ea1270dc75a886714db5b8e12ecb8f"],
    ["src/ir/passes/monomorphize.ts", 22, "ae9b7b3d2efe29a83b8cafa983c8aa96d3b267d30a7b5db6b1b52f38c475a0e5"],
  ] as const)("retains %s's %s exact declarations and docs", (path, count, digest) => {
    const declarations = source(path).statements.filter(
      (node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node),
    );
    expect(declarations).toHaveLength(count);
    expect(
      createHash("sha256")
        .update(declarations.map((node) => node.getFullText().trim()).join("\n"))
        .digest("hex"),
    ).toBe(digest);
  });

  it.each([
    "src/ir/async-prepare-ir.ts",
    "src/ir/runtime-program-producers.ts",
    "src/ir/async-linear-prepare.ts",
    "src/ir/passes/monomorphize.ts",
  ])("%s constructs derived IDs only through canonical F0 values", (path) => {
    const imports = source(path).statements.filter(ts.isImportDeclaration);
    const creators = imports.filter(
      (node) =>
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (element) => (element.propertyName ?? element.name).text === "createDerivedIrUnitId",
        ),
    );
    expect(creators).toHaveLength(1);
    expect(ts.isStringLiteral(creators[0]!.moduleSpecifier) && creators[0]!.moduleSpecifier.text).toBe(
      path.includes("/passes/")
        ? "../../shared/contracts/identity-values.js"
        : "../shared/contracts/identity-values.js",
    );
    expect(creators[0]!.importClause!.isTypeOnly).toBe(false);
    const oldImports = imports.filter(
      (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith("/identity.js"),
    );
    expect(oldImports.every((node) => node.importClause?.isTypeOnly)).toBe(true);
  });

  it("prepares a real single await without changing its owner or inventing runtime attachments", () => {
    const fn = oneAwaitFunction();
    const before = structuredClone(fn);
    const prepared = canonical.prepareSuspendingIrFunction(fn)!;
    expect(prepared).not.toBeNull();
    expect(prepared.main.unitId).toBe(fn.unitId);
    expect(prepared.main.asyncPlan!.states.map((state) => state.terminator.kind)).toEqual(["suspend", "resolve"]);
    expect(verifyIrAsyncPlan(prepared.main.asyncPlan!)).toEqual([]);
    expect(prepared.stateFunctions).toHaveLength(1);
    expect(prepared.provenance).toEqual([
      {
        id: createDerivedIrUnitId({ parentId: fn.unitId, role: "ir-async-state", ordinal: 0 }),
        parentId: fn.unitId,
        role: "ir-async-state",
        ordinal: 0,
      },
    ]);
    expect(prepared.stateFunctions[0]!.unitId).toBe(prepared.provenance[0]!.id);
    expect(prepared.stateFunctions[0]!.blocks[0]!.terminator).toEqual({ kind: "return", values: [asValueId(0)] });
    expect(prepared.main.asyncRuntime).toBeUndefined();
    expect(fn).toEqual(before);
    expect(legacy.prepareSuspendingIrFunction(fn)).toEqual(prepared);
  });

  it("preserves generic sequential fallback and both live awaits", () => {
    const fn = oneAwaitFunction();
    const two: IrFunction = {
      ...fn,
      valueCount: 4,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [
            ...fn.blocks[0]!.instrs,
            { kind: "await", operand: asValueId(0), result: asValueId(2), resultType: f64 },
            {
              kind: "binary",
              op: "f64.add",
              lhs: asValueId(1),
              rhs: asValueId(2),
              result: asValueId(3),
              resultType: f64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(3)] },
        },
      ],
    };
    expect(canonical.prepareSingleAwaitIrFunction(two)).toBeNull();
    const prepared = canonical.prepareSuspendingIrFunction(two)!;
    expect(prepared).not.toBeNull();
    // The two empty suspension bodies need no lifted instruction helper;
    // only the final add is lifted. State count and helper count differ.
    expect(prepared.stateFunctions).toHaveLength(1);
    expect(prepared.main.asyncPlan!.states.map((state) => state.terminator.kind)).toEqual([
      "suspend",
      "suspend",
      "resolve",
    ]);
    expect(verifyIrAsyncPlan(prepared.main.asyncPlan!)).toEqual([]);
    expect(prepared.main.asyncPlan!.states.map((state) => state.body.length)).toEqual([0, 0, 1]);
    expect(prepared.stateFunctions[0]!.blocks[0]!.instrs).toEqual([two.blocks[0]!.instrs[2]]);
    expect(prepared.main.asyncPlan!.spills.map((spill) => spill.value)).toContain(asValueId(1));
    expect(prepared.provenance.map((record) => record.id)).toEqual([
      createDerivedIrUnitId({ parentId: fn.unitId, role: "ir-async-state", ordinal: 0 }),
    ]);
  });

  // Existing host elision is preserved, not extended. The standalone/default
  // policy continues to retain its numeric continuation and derived unit.
  it.each([
    ["host", { box: "host", unbox: "host" }, 1],
    ["native", { box: "unsupported", unbox: "native" }, 2],
    ["disabled", NUMBER_BOUNDARY_POLICY_DISABLED, 2],
    ["omitted", undefined, 2],
  ] as const)("preserves intrinsic unbox continuation under %s policy", (_name, policy, helpers) => {
    const fn = oneAwaitFunction();
    const instrs: IrInstr[] = [
      { kind: "await", operand: asValueId(0), result: asValueId(1), resultType: externref },
      {
        kind: "intrinsic",
        id: "js.number.unbox",
        version: INTRINSIC_SIGNATURE_VERSION,
        args: [asValueId(1)],
        result: asValueId(2),
        resultType: f64,
      },
    ];
    const roundTrip: IrFunction = {
      ...fn,
      valueCount: 3,
      blocks: [{ ...fn.blocks[0]!, instrs, terminator: { kind: "return", values: [asValueId(2)] } }],
    };
    expect(
      canonical.prepareSingleAwaitIrFunction(roundTrip, policy as NumberBoundaryPolicy | undefined)!.stateFunctions,
    ).toHaveLength(helpers);
    const raw: IrInstr = {
      kind: "call",
      target: irImportFuncRef("env", "__unbox_number", "__unbox_number"),
      args: [asValueId(1)],
      result: asValueId(2),
      resultType: f64,
    };
    const legacyImport = { ...roundTrip, blocks: [{ ...roundTrip.blocks[0]!, instrs: [instrs[0]!, raw] }] };
    expect(
      canonical.prepareSingleAwaitIrFunction(legacyImport, policy as NumberBoundaryPolicy | undefined)!.stateFunctions,
    ).toHaveLength(1);
  });

  it("whole-program async production retains every ordinary owner and exact derived ownership", () => {
    const async = oneAwaitFunction(),
      ordinary = identityFunction(1);
    const result = prepareWholeProgramAsyncFunctions(producerInput([async, ordinary]));
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    expect(result.functions).toHaveLength(3);
    expect(result.functions[2]).toBe(ordinary);
    expect(result.functions[0]!.unitId).toBe(async.unitId);
    expect(result.derivedUnits).toHaveLength(1);
    expect(result.derivedUnits[0]).toEqual({
      id: result.functions[1]!.unitId,
      parentId: async.unitId,
      role: "ir-async-state",
      ordinal: 0,
      terminalOwnerId: async.unitId,
      sourceId,
    });
    expect(result.functions[0]!.asyncPlan!.runtimeIntents).toContain("promise.number.bridge");
    expect(Object.isFrozen(result.functions)).toBe(true);
  });

  it("keeps a located refusal for an ordinary owner carrying await", () => {
    const fn = { ...oneAwaitFunction(), funcKind: "regular" as const };
    const result = prepareWholeProgramAsyncFunctions(producerInput([fn]));
    expect(result.kind).toBe("invariant");
    expect(result).toMatchObject({ unitId: fn.unitId, location: { sourceId }, code: "verifier-failure" });
  });

  it.each([
    ["async function f(p: Promise<number>) { const n = await p; return n; }", true],
    ["function f(p: number) { const n = p; return n; }", false],
    ["async function f(p: Promise<number>) { const n = await p; return p; }", false],
    ["async function f(p: Promise<number>) { const n = await p; n; return n; }", false],
    ["async function* f(p: Promise<number>) { const n = await p; return n; }", false],
  ] as const)("retains the AST-only predicate for %s", (text, expected) => {
    const ast = ts.createSourceFile("predicate.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fn = ast.statements[0]!;
    expect(ts.isFunctionDeclaration(fn)).toBe(true);
    if (!ts.isFunctionDeclaration(fn)) throw new Error("missing fixture declaration");
    expect(legacy.isSingleAwaitReturnAsyncCandidate(fn)).toBe(expected);
  });

  it("runs nonempty async production with frontend/legacy identity loads actively forbidden", () => {
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const blocked = ['/src/ts-api.ts', '/src/ir/identity.ts', '/src/ir/from-ast.ts', '/src/ir/async-prepare.ts', '/src/ir/passes/gvn.ts'];
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (blocked.some(path => result.url.endsWith(path)) || result.url.includes('/src/checker/') || result.url.includes('/src/codegen/')) throw Error('blocked source service: ' + result.url);
        return result;
      }});
      const { oneAwaitFunction, identityFunction, producerInput } = await import('./tests/helpers/typed-middleend-fixtures.ts');
      const { prepareWholeProgramAsyncFunctions } = await import('./src/ir/runtime-program-producers.ts');
      const { monomorphize } = await import('./src/ir/passes/monomorphize.ts');
      const result = prepareWholeProgramAsyncFunctions(producerInput([oneAwaitFunction(), identityFunction(1)]));
      assert.equal(result.kind, 'prepared'); assert.equal(result.functions.length, 3);
      assert.equal(result.derivedUnits.length, 1);
      assert.equal(result.functions[0].asyncPlan.states.length, 2);
      const ordinary = identityFunction(2), module = { functions: [ordinary] };
      assert.equal(monomorphize(module).module, module);
      for (const path of blocked) await assert.rejects(import('.' + path), /blocked source service/);
    `;
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, JS2WASM_IR_GVN_DEBUG: "1" } },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toBe("");
  });
});
