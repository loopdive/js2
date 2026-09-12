// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import * as engine from "../src/runtime/wasmgc/async/frame-engine.js";
import * as native from "../src/runtime/wasmgc/async/native-await.js";
import * as eh from "../src/wasm/physical/exception-control.js";
import * as oldAwait from "../src/codegen/prepared-native-async-await.js";
import * as oldEh from "../src/ir/try-table.js";
// Bootstrap the historical graph before loading its context-bearing adapter.
import { compile } from "../src/index.js";
import { analyzeSource, analyzeMultiSource } from "../src/checker/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { buildAsyncFrameInfo, ensureAsyncResumeFunction } from "../src/codegen/async-frame.js";
import { analyzeAsyncBody, planAsyncCfg } from "../src/codegen/async-cps.js";
import { getOrRegisterPromiseType } from "../src/codegen/async-scheduler.js";
import * as shared from "../src/codegen/shared.js";
import { allocLocal } from "../src/codegen/context/locals.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareSuspendingIrFunction } from "../src/ir/async-prepare-ir.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { lowerPreparedIrAsyncFunction } from "../src/codegen/ir-async-frame.js";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const canonicalEdges = {
  "src/runtime/wasmgc/async/frame-engine.ts": [
    ["../../../wasm/model/instructions.js", true, ["FuncHandle", "Instr", "LocalDef"]],
    ["../../../wasm/physical/exception-control.js", false, ["buildTargetTaggedTry"]],
  ],
  "src/runtime/wasmgc/async/native-await.ts": [["../../../wasm/model/instructions.js", true, ["Instr"]]],
  "src/wasm/physical/exception-control.ts": [
    ["../model/instructions.js", true, ["BlockType", "Instr", "TryTableCatch", "ValType"]],
  ],
} as const;

function checkClosure(reader: (path: string) => string): void {
  for (const [path, expected] of Object.entries(canonicalEdges)) {
    const text = reader(path);
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    assert.equal((file as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0, path);
    const edges: unknown[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        assert(ts.isStringLiteral(node.moduleSpecifier), "literal import required");
        const clause = node.importClause;
        assert(clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings));
        edges.push([
          node.moduleSpecifier.text,
          clause.isTypeOnly,
          clause.namedBindings.elements.map((element) => {
            assert(!element.propertyName && !element.isTypeOnly, "no alternative binding route");
            return element.name.text;
          }),
        ]);
      }
      assert(!ts.isExportDeclaration(node), "no barrel or reexport in executable leaves");
      assert(!ts.isImportTypeNode(node) && !ts.isImportEqualsDeclaration(node), "no hidden module edge");
      if (ts.isCallExpression(node)) {
        assert(node.expression.kind !== ts.SyntaxKind.ImportKeyword, "no dynamic import");
        assert(!(ts.isIdentifier(node.expression) && node.expression.text === "require"), "no require");
      }
      if (ts.isIdentifier(node)) {
        assert(
          !["CodegenContext", "FunctionContext", "AsyncCfgPlan", "TypeChecker", "SourceFile"].includes(node.text),
          "upward contract",
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.deepEqual(edges, expected, `exact edges for ${path}`);
  }
}

function walk(body: readonly Instr[]): Instr[] {
  const result: Instr[] = [];
  for (const instruction of body) {
    result.push(instruction);
    const nested = instruction as Instr & {
      body?: Instr[];
      then?: Instr[];
      else?: Instr[];
      catches?: { body?: Instr[] }[];
      catchAll?: Instr[];
    };
    for (const child of [
      nested.body,
      nested.then,
      nested.else,
      nested.catchAll,
      ...(nested.catches ?? []).map((entry) => entry.body),
    ])
      if (child) result.push(...walk(child));
  }
  return result;
}

function dispatch(overrides: Partial<engine.AsyncFrameDispatchInput> = {}): engine.AsyncFrameDispatchInput {
  return {
    target: { wasi: false, standalone: false },
    stateTypeIdx: 41,
    stateField: 0,
    modeField: 2,
    nextMode: 0,
    frameLocal: 0,
    resultPromiseLocal: 1,
    reasonLocal: 2,
    handlerLocal: 3,
    exnTag: 4,
    settleRejectIdx: 500,
    chain: [{ op: "nop" }],
    handlers: [],
    ...overrides,
  };
}

describe("resolved async-frame ownership", () => {
  it("retains the exact existing public function objects", () => {
    for (const name of ["buildNativeAwaitClassification", "buildNativeAwaitSuspendArm"] as const) {
      expect(native[name]).toBeTypeOf("function");
      expect(oldAwait[name]).toBe(native[name]);
    }
    for (const name of ["buildStandardTryTable", "buildTargetTaggedTry"] as const) {
      expect(eh[name]).toBeTypeOf("function");
      expect(oldEh[name]).toBe(eh[name]);
    }
    expect(compile).toBeTypeOf("function");
  });
  it("requires all live canonical modules and their exact downward edges", () => checkClosure(read));
  for (const missing of Object.keys(canonicalEdges)) {
    it(`rejects missing canonical owner ${missing}`, () => {
      expect(() =>
        checkClosure((path) => {
          if (path === missing) throw new Error(`missing ${path}`);
          return read(path);
        }),
      ).toThrow("missing");
    });
  }
  for (const edge of [
    'import type { IrType } from "../../../ir/nodes.js";',
    'import { compile } from "../../../index.js";',
    'export * from "../../../codegen/async-frame.js";',
    'export type Hidden = import("../../../ir/nodes.js").IrType;',
    'void import("../../../codegen/async-frame.js");',
    "void import(provider);",
    "void require(provider);",
    'import x = require("../../../codegen/async-frame.js");',
    'import type { Missing } from "./missing.js";',
    "export const broken = ;",
  ]) {
    it(`rejects ${edge}`, () =>
      expect(() =>
        checkClosure((path) => read(path) + (path.endsWith("frame-engine.ts") ? `\n${edge}` : "")),
      ).toThrow());
  }
  for (const reject of [false, true]) {
    it(`builds the ${reject ? "reject" : "fulfill"} adapter with exact bound fields and handle`, () => {
      const resources: engine.AsyncFrameStepResources = {
        stateTypeIdx: 23,
        sentField: 8,
        errorField: 9,
        modeField: 10,
        throwMode: 2,
        resumeFuncIdx: 2 ** 21 + 17,
      };
      expect(engine.buildStepAdapterLocals(23)).toEqual([{ name: "$frame", type: { kind: "ref", typeIdx: 23 } }]);
      expect(engine.buildStepAdapterBody(resources, reject)).toEqual([
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: 23 },
        { op: "local.set", index: 2 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 1 },
        { op: "struct.set", typeIdx: 23, fieldIdx: 8 },
        ...(reject
          ? [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "struct.set", typeIdx: 23, fieldIdx: 9 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "struct.set", typeIdx: 23, fieldIdx: 10 },
            ]
          : []),
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: 2 ** 21 + 17 },
        { op: "ref.null.extern" },
      ]);
    });
  }
  it("retains ordered state arrays, including an empty state and completed arm", () => {
    const states: engine.AsyncFrameStateBody[] = [
      { id: 0, body: [] },
      { id: 1, body: [{ op: "call", funcIdx: 99 }] },
    ];
    const completed: engine.AsyncFrameStateBody = { id: 2, body: [{ op: "return" }] };
    const chain = engine.buildAsyncFrameStateChain({
      frameLocal: 0,
      stateTypeIdx: 11,
      stateField: 0,
      states,
      completed,
    });
    let arm = chain;
    for (const state of [...states, completed]) {
      expect(arm.slice(0, 4)).toEqual([
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: 11, fieldIdx: 0 },
        { op: "i32.const", value: state.id },
        { op: "i32.eq" },
      ]);
      const branch = arm[4]!;
      assert(branch.op === "if");
      expect(branch.then).toBe(state.body);
      arm = branch.else!;
    }
    expect(arm).toEqual([{ op: "unreachable" }]);
    const original = states[1]!.body[0]!;
    assert(original.op === "call");
    original.funcIdx++;
    expect(walk(chain)).toContain(original);
    expect(walk(chain)).toContainEqual({ op: "call", funcIdx: 100 });
  });
  it("keeps the absent completed arm as unreachable", () => {
    expect(engine.buildAsyncFrameStateChain({ frameLocal: 0, stateTypeIdx: 0, stateField: 0, states: [] })).toEqual([
      { op: "unreachable" },
    ]);
  });
  for (const routed of [false, true]) {
    it(`preserves ${routed ? "routed" : "plain"} host tagged/catch-all isolation and order`, () => {
      const finalizer: Instr[] = [{ op: "call", funcIdx: 601 }];
      const input = dispatch({
        hostGetCaughtIdx: 0,
        completedStateId: 0,
        handlers: [
          {
            id: 1,
            parent: 0,
            finalizerBody: finalizer,
            ...(routed ? { catchState: 0, catchBinding: { name: "reason", local: 0, spillField: 0 } } : {}),
          },
        ],
      });
      const result = engine.buildAsyncFrameDispatch(input);
      const attempt = walk([result]).find((instruction) => instruction.op === "try");
      assert(attempt?.op === "try");
      const tagged = attempt.catches![0]!.body;
      const foreign = attempt.catchAll!;
      expect(foreign.slice(0, 2)).toEqual([
        { op: "call", funcIdx: 0 },
        { op: "local.set", index: 2 },
      ]);
      expect(tagged[0]).toEqual({ op: "local.set", index: 2 });
      expect(foreign.slice(2)).toEqual(tagged.slice(1));
      const taggedObjects = new Set(walk(tagged));
      expect(walk(foreign).some((instruction) => taggedObjects.has(instruction))).toBe(false);
      const flat = walk(tagged);
      expect(flat.indexOf(finalizer[0]!)).toBeLessThan(
        flat.findIndex((instruction) => instruction.op === "call" && instruction.funcIdx === 500),
      );
      expect(flat.slice(-3)).toEqual([
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 0 },
        { op: "struct.set", typeIdx: 41, fieldIdx: 0 },
      ]);
      if (routed) {
        expect(flat).toContainEqual({ op: "local.set", index: 0 });
        expect(flat).toContainEqual({ op: "struct.set", typeIdx: 41, fieldIdx: 0 });
        expect(flat).toContainEqual({ op: "struct.set", typeIdx: 41, fieldIdx: 2 });
        expect(flat).toContainEqual({ op: "br", depth: 2 });
      } else expect(result.op).toBe("try");
    });
  }
  it("retains finally-only regions, empty finalizers and ordered equality guards", () => {
    const first: Instr[] = [],
      second: Instr[] = [{ op: "nop" }];
    const handlers = [
      { id: 1, parent: 0, finalizerBody: first },
      { id: 2, parent: 1, finalizerBody: second },
    ];
    const result = engine.buildAsyncFrameDispatch(dispatch({ handlers }));
    assert(result.op === "try");
    const body = result.catches![0]!.body;
    expect(body.slice(1, 4)).toEqual([{ op: "local.get", index: 3 }, { op: "i32.const", value: 1 }, { op: "i32.eq" }]);
    expect(body.slice(5, 8)).toEqual([{ op: "local.get", index: 3 }, { op: "i32.const", value: 2 }, { op: "i32.eq" }]);
    assert(body[4]!.op === "if" && body[8]!.op === "if");
    expect(body[4]!.then).toBe(first);
    expect(body[8]!.then).toBe(second);
    expect(handlers.map((handler) => handler.parent)).toEqual([0, 1]);
  });
  for (const target of [
    { wasi: true, standalone: false },
    { wasi: false, standalone: true },
  ]) {
    it(`uses unchanged standardized EH for ${JSON.stringify(target)}`, () => {
      const result = engine.buildAsyncFrameDispatch(dispatch({ target }));
      expect(walk([result]).filter((instruction) => instruction.op === "try_table")).toHaveLength(1);
      expect(walk([result]).some((instruction) => instruction.op === "try")).toBe(false);
    });
  }
});

// Fault injection exercises the real source planner and context adapter. It is
// not an alternative source/IR producer or physical acceptance fixture.
function planned(source: string) {
  const ast = analyzeSource(source, "frame-body-ownership.ts");
  const fn = ast.sourceFile.statements.find(ts.isFunctionDeclaration);
  assert(fn);
  const ctx = createCodegenContext(createEmptyModule(), ast.checker, { standalone: true });
  const plan = analyzeAsyncBody(ctx, fn);
  const cfg = planAsyncCfg(ctx, fn, plan, { allowLoops: true, allowTryCatch: true, allowReturnInTry: true });
  assert(cfg && cfg.states.length > 1);
  const info = buildAsyncFrameInfo(ctx, fn, plan, [], [], getOrRegisterPromiseType(ctx));
  return { ctx, info, plan, cfg };
}

// createCodegenContext owns a plain currentFunc data property. Observe its
// assignments without replacing contexts or body arrays. The resume body is
// already nonempty (frame hydration/result-Promise loads) before state swaps.
function observeContextAssignments(ctx: ReturnType<typeof createCodegenContext>) {
  const descriptor = Object.getOwnPropertyDescriptor(ctx, "currentFunc");
  assert(descriptor && "value" in descriptor && descriptor.writable && descriptor.configurable);
  let current = ctx.currentFunc;
  const entries: { context: FunctionContext; body: Instr[] }[] = [];
  Object.defineProperty(ctx, "currentFunc", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: () => current,
    set: (value: typeof current) => {
      current = value;
      if (value !== null) entries.push({ context: value, body: value.body });
    },
  });
  return {
    entries,
    restore() {
      // Preserve the actual terminal value: do not repair a failed production
      // currentFunc restoration while removing this test-only observation.
      Object.defineProperty(ctx, "currentFunc", { ...descriptor, value: current });
    },
  };
}

afterEach(() => vi.restoreAllMocks());
describe("original context and attachment lifecycle", () => {
  for (const present of [false, true])
    it(`restores the exact body, aliases, awaited binding and current context on state failure (existing=${present})`, () => {
      const f = planned("async function f(): Promise<void> { const value = await 1; value; }");
      const before = f.ctx.currentFunc;
      const sentinel = new Error("state failure");
      let resume: FunctionContext | undefined;
      let failedBody: Instr[] | undefined;
      const awaited = f.plan.awaitPoints[0]!;
      let priorLocal: number | undefined;
      let localMap: FunctionContext["localMap"] | undefined;
      let awaitMap: FunctionContext["asyncAwaitValueLocals"] | undefined;
      f.info.entryPrelude = (fctx) => {
        localMap = fctx.localMap;
        if (present) {
          priorLocal = allocLocal(fctx, "prior_binding", { kind: "externref" });
          fctx.localMap.set("alias", priorLocal);
          fctx.asyncAwaitValueLocals = new Map([[awaited, priorLocal]]);
          awaitMap = fctx.asyncAwaitValueLocals;
        }
      };
      const cfg = {
        ...f.cfg,
        states: f.cfg.states.map((state) =>
          state.id !== 1
            ? state
            : {
                ...state,
                resumeFrom: { ...state.resumeFrom!, binding: { ...state.resumeFrom!.binding!, awaitTarget: awaited } },
                lexicalAliases: [{ sourceName: "alias", targetName: "value" }],
                postDeliverEmit(_ctx: unknown, fctx: FunctionContext) {
                  resume = fctx;
                  failedBody = fctx.body;
                  expect(fctx.localMap.get("alias")).toBe(fctx.localMap.get("value"));
                  throw sentinel;
                },
              },
        ),
      };
      const observation = observeContextAssignments(f.ctx);
      let thrown: unknown;
      try {
        ensureAsyncResumeFunction(f.ctx, f.info, f.plan, cfg);
      } catch (error) {
        thrown = error;
      } finally {
        observation.restore();
      }
      expect(thrown).toBe(sentinel);
      expect(resume).toBeDefined();
      const entries = observation.entries.filter((entry) => entry.context === resume);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.body.length).toBeGreaterThan(0);
      expect(failedBody).toBeDefined();
      expect(failedBody).not.toBe(entries[0]!.body);
      expect(resume!.body).toBe(entries[0]!.body);
      expect(resume!.localMap).toBe(localMap);
      expect(resume!.localMap.has("alias")).toBe(present);
      expect(resume!.localMap.get("alias")).toBe(priorLocal);
      expect(resume!.asyncAwaitValueLocals?.has(awaited) ?? false).toBe(present);
      expect(resume!.asyncAwaitValueLocals?.get(awaited)).toBe(priorLocal);
      if (present) expect(resume!.asyncAwaitValueLocals).toBe(awaitMap);
      expect(f.ctx.currentFunc).toBe(before);
      expect(definedFuncAt(f.ctx, f.info.resumeFuncIdx!)!.body).toEqual([{ op: "unreachable" }]);
    });
  it("restores the exact context/body on finalizer failure without adding reservation rollback", () => {
    const f = planned("async function f(): Promise<void> { try { await 1; } finally { 77; } }");
    expect(f.cfg.handlers).toHaveLength(1);
    const before = f.ctx.currentFunc;
    const sentinel = new Error("finalizer failure");
    let resume: FunctionContext | undefined, failedBody: Instr[] | undefined;
    const chainSpy = vi.spyOn(engine, "buildAsyncFrameStateChain");
    const original = shared.compileStatement;
    vi.spyOn(shared, "compileStatement").mockImplementation((ctx, fctx, statement) => {
      if (chainSpy.mock.calls.length > 0 && f.cfg.handlers[0]!.finalizer.includes(statement)) {
        resume = fctx;
        failedBody = fctx.body;
        throw sentinel;
      }
      return original(ctx, fctx, statement);
    });
    const observation = observeContextAssignments(f.ctx);
    let thrown: unknown;
    try {
      ensureAsyncResumeFunction(f.ctx, f.info, f.plan, f.cfg);
    } catch (error) {
      thrown = error;
    } finally {
      observation.restore();
    }
    expect(thrown).toBe(sentinel);
    expect(chainSpy).toHaveBeenCalledOnce();
    expect(resume).toBeDefined();
    const entries = observation.entries.filter((entry) => entry.context === resume);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body.length).toBeGreaterThan(0);
    expect(failedBody).toBeDefined();
    expect(failedBody).not.toBe(entries[0]!.body);
    expect(resume!.body).toBe(entries[0]!.body);
    expect(f.ctx.currentFunc).toBe(before);
    expect(definedFuncAt(f.ctx, f.info.resumeFuncIdx!)!.body).toEqual([{ op: "unreachable" }]);
  });
  it("keeps earlier detached states visible to actual later helper registration", () => {
    const f = planned("async function f(): Promise<void> { await 1; await 2; }");
    let earlier: Instr[] | undefined;
    let call: Extract<Instr, { op: "call" }> | undefined;
    let before = -1;
    const cfg = {
      ...f.cfg,
      states: f.cfg.states.map((state) => ({
        ...state,
        postDeliverEmit(ctx: typeof f.ctx, fctx: FunctionContext) {
          if (state.id === 0) {
            // A deliberately live-regime handle in the old adapter, as in #2710.
            before = ctx.mod.imports.filter((entry) => entry.desc.kind === "func").length;
            call = { op: "call", funcIdx: before };
            fctx.body.push(call);
            earlier = fctx.body;
          } else if (state.id === 1) {
            expect(ctx.liveBodies.has(earlier!)).toBe(true);
            const registered = shared.ensureLateImport(
              ctx,
              "__timer_set_timeout",
              [{ kind: "f64" }, { kind: "i32" }],
              [],
              "env",
            );
            expect(registered).toBeDefined();
            shared.flushLateImportShifts(ctx, fctx);
            expect(ctx.mod.imports.filter((entry) => entry.desc.kind === "func").length).toBeGreaterThan(before);
            expect(call!.funcIdx).toBeGreaterThan(before);
          }
        },
      })),
    };
    const handle = ensureAsyncResumeFunction(f.ctx, f.info, f.plan, cfg);
    const published = definedFuncAt(f.ctx, handle)!;
    expect(walk(published.body)).toContain(call);
    expect(f.ctx.liveBodies.has(earlier!)).toBe(false);
  });
  it("rejects a corrupted source-produced prepared attachment before allocating a frame", () => {
    const ast = analyzeMultiSource(
      { "./entry.ts": "async function f(): Promise<number> { return await 99; }" },
      "./entry.ts",
    );
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { target: "standalone", backend: "wasmgc" },
      deferTopLevelInit: false,
    });
    assert(source.kind === "prepared");
    const functions = source.ir.functions.filter((fn) => fn.name === "f");
    expect(functions).toHaveLength(1);
    const prepared = prepareSuspendingIrFunction(functions[0]!);
    assert(prepared?.main.asyncPlan);
    const runtime = prepareIrRuntimeManifest({
      functions: [prepared.main],
      sourceFile: "./entry.ts",
      policy: { target: "standalone", backend: "wasmgc" },
      includeEmpty: true,
    });
    const authenticated = runtime.functions.find((fn) => fn.name === "f")!;
    expect(authenticated.asyncRuntime).toBeDefined();
    const fn = { ...authenticated, asyncRuntime: { ...authenticated.asyncRuntime!, states: [] } };
    const ctx = createCodegenContext(createEmptyModule(), ast.checker, { standalone: true });
    const module = ctx.mod;
    const before = { types: [...module.types], functions: [...module.functions], imports: [...module.imports] };
    const resolver = {
      resolveFunc: vi.fn(() => {
        throw new Error("must not resolve before authentication");
      }),
    };
    expect(() =>
      lowerPreparedIrAsyncFunction(ctx, fn, resolver, { name: "f", typeIdx: 0, locals: [], body: [], exported: false }),
    ).toThrow();
    expect(resolver.resolveFunc).not.toHaveBeenCalled();
    expect(module.types).toEqual(before.types);
    expect(module.functions).toEqual(before.functions);
    expect(module.imports).toEqual(before.imports);
  });
});
