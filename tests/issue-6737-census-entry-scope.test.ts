// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #6737 / #6741: the module-init census currentness check runs once per module
// body and once per module overlay. It used to re-derive every source's AST
// syntax, terminal denominator and legacy parity on each of those entries —
// O(sources x program), 61 % of the lodash-es compile and ~70 % of jsdom's
// (which never finished). The entry check now re-derives only the entered
// source; the whole program is re-derived at every phase boundary. These tests
// seed real inconsistencies and prove the invariant still fires: at the entry
// of the drifted source, and at the next boundary for a source already entered.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource, type MultiTypedAST } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  assertMultiPreparedModuleInitCensusCurrent,
  assertMultiPreparedModuleInitCensusSourceCurrent,
  buildMultiPreparedModuleInitCensus,
  reconcileMultiPreparedModuleInitCensus,
} from "../src/codegen/multi-prepared-module-init-census.js";
import { MultiPreparedProgramOwner } from "../src/codegen/multi-prepared-program.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import type { CodegenContext, CodegenOptions } from "../src/codegen/context/types.js";
import { collectModuleInitPopulation } from "../src/ir/module-init.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createEmptyModule, type WasmModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

import "../src/codegen/expressions.js";

const OPTIONS: CodegenOptions = {
  experimentalIR: true,
  nativeStrings: true,
  target: "standalone",
  trackIrOutcomes: true,
};

// Type-only sources: the owner's body visits exercise only its phase cursor
// and the census check, never a route-specific codegen obligation.
const TYPE_ONLY_FILES = {
  "./dep.ts": `export interface DepMarker { readonly tag: "dep"; }`,
  "./entry.ts": `import type { DepMarker } from "./dep"; export interface EntryMarker { readonly tag: "entry"; }`,
} as const;

interface Fixture {
  readonly ast: MultiTypedAST;
  readonly identity: IrPlanningIdentityContext;
  readonly module: WasmModule;
  readonly session: ProgramAbiSession;
  readonly ctx: CodegenContext;
}

function fixture(files: Record<string, string>): Fixture {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const inventory = buildIrUnitInventory(ast.sourceFiles, { checker: ast.checker, entrySource: ast.entryFile });
  const identity = buildIrPlanningIdentityContext(inventory);
  const module = createEmptyModule();
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, ast.checker, OPTIONS, session, identity);
  return { ast, identity, module, session, ctx };
}

function census(value: Fixture) {
  return buildMultiPreparedModuleInitCensus({
    multiAst: value.ast,
    identityContext: value.identity,
    target: "standalone",
    deferTopLevelInit: !!value.ctx.deferTopLevelInit,
  });
}

function source(value: Fixture, fileName: string): ts.SourceFile {
  const sourceFile = value.ast.sourceFiles.find((candidate) => candidate.fileName === fileName);
  if (!sourceFile) throw new Error(`missing source ${fileName}`);
  return sourceFile;
}

/** The first string literal of a source: a parser field the census snapshots. */
function firstStringLiteral(sourceFile: ts.SourceFile): ts.StringLiteral & { text: string } {
  let found: ts.StringLiteral | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isStringLiteral(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`no string literal in ${sourceFile.fileName}`);
  return found as ts.StringLiteral & { text: string };
}

function owner(value: Fixture): MultiPreparedProgramOwner {
  return new MultiPreparedProgramOwner({
    multiAst: value.ast,
    identityContext: value.identity,
    programAbiSession: value.session,
    ctx: value.ctx,
    overlayEnabled: false,
  });
}

const SYNTAX_CHANGED = /multi-prepared-module-init-census:syntax-changed/;

describe("#6737/#6741 census currentness is re-derived per entered source, whole program at boundaries", () => {
  it("fires on a seeded AST drift at the drifted source's entry and at the whole-program check", () => {
    const value = fixture(TYPE_ONLY_FILES);
    const retained = census(value);
    const dep = source(value, "dep.ts");
    const entry = source(value, "entry.ts");
    const literal = firstStringLiteral(dep);
    literal.text = "drifted";
    expect(() => assertMultiPreparedModuleInitCensusSourceCurrent(retained, dep)).toThrow(SYNTAX_CHANGED);
    expect(() => assertMultiPreparedModuleInitCensusCurrent(retained)).toThrow(SYNTAX_CHANGED);
    // Entering another source does not re-walk dep.ts: that is the whole fix.
    expect(() => assertMultiPreparedModuleInitCensusSourceCurrent(retained, entry)).not.toThrow();
    literal.text = "dep";
    expect(() => assertMultiPreparedModuleInitCensusSourceCurrent(retained, dep)).not.toThrow();
    expect(() => assertMultiPreparedModuleInitCensusCurrent(retained)).not.toThrow();
  });

  it("rejects an entered source that is not a census source", () => {
    const value = fixture(TYPE_ONLY_FILES);
    const foreign = fixture(TYPE_ONLY_FILES);
    expect(() => assertMultiPreparedModuleInitCensusSourceCurrent(census(value), source(foreign, "dep.ts"))).toThrow(
      /multi-prepared-module-init-census:source-join/,
    );
  });

  it("still checks the whole legacy queue on every entry", () => {
    const value = fixture({
      "./dep.ts": `let value: number = 40;`,
      "./entry.ts": `export interface Entry { readonly tag: "entry"; }`,
    });
    const retained = census(value);
    value.ctx.moduleInitStatements = retained.sourcePlans.flatMap((plan) =>
      collectModuleInitPopulation(plan.sourceFile),
    );
    value.ctx.staticInitExprs = [];
    const observed = reconcileMultiPreparedModuleInitCensus(retained, { ctx: value.ctx });
    const entry = source(value, "entry.ts");
    expect(() => assertMultiPreparedModuleInitCensusSourceCurrent(observed, entry)).not.toThrow();
    // Drift the whole-program queue: still caught at this entry, whichever
    // source the dropped statement belonged to.
    value.ctx.moduleInitStatements.pop();
    expect(() => assertMultiPreparedModuleInitCensusSourceCurrent(observed, entry)).toThrow(
      /multi-prepared-module-init-census:parity-changed/,
    );
  });

  it("owner: a drift in a not-yet-entered source fires when that source is entered", () => {
    const value = fixture(TYPE_ONLY_FILES);
    const program = owner(value);
    program.sealBodyBoundary();
    const [first, second] = value.ast.sourceFiles as readonly ts.SourceFile[];
    firstStringLiteral(second!).text = "drifted";
    // Before #6737 this entry re-walked every source and failed here already.
    expect(() => program.compileBodySource(first!, "discover")).not.toThrow();
    expect(() => program.compileBodySource(second!, "full")).toThrow(SYNTAX_CHANGED);
    expect(program.state).toBe("failed");
  });

  it("owner: a drift in an already-entered source fires at the routes-complete boundary", () => {
    const value = fixture(TYPE_ONLY_FILES);
    const program = owner(value);
    program.sealBodyBoundary();
    const [first, second] = value.ast.sourceFiles as readonly ts.SourceFile[];
    program.compileBodySource(first!, "discover");
    firstStringLiteral(first!).text = "drifted";
    expect(() => program.compileBodySource(second!, "full")).not.toThrow();
    expect(() => program.sealRoutesComplete()).toThrow(SYNTAX_CHANGED);
    expect(program.state).toBe("failed");
  });

  it("owner: an undrifted program completes with every source visited", () => {
    const value = fixture(TYPE_ONLY_FILES);
    const program = owner(value);
    program.sealBodyBoundary();
    for (const [index, sourceFile] of value.ast.sourceFiles.entries()) {
      program.compileBodySource(sourceFile, index === value.ast.sourceFiles.length - 1 ? "full" : "discover");
    }
    program.sealRoutesComplete();
    const audit = program.complete(value.session.publish(value.module));
    expect(audit.bodySourceIds).toHaveLength(value.ast.sourceFiles.length);
  });
});
