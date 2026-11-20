// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as core from "../src/ir/core/nodes.js";
import * as old from "../src/ir/nodes.js";
import {
  asAsyncStateId,
  assertPreparedIrAsyncRuntimeCurrent,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  serializeIrAsyncPlan,
  type PreparedIrAsyncRuntime,
  type PreparedIrFunction,
  type PreparedIrModule,
} from "../src/ir/async-plan.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const movedFunctions = [
  "asValueId",
  "asLabelId",
  "asAllocSiteId",
  "asBlockId",
  "forEachNestedBuffer",
  "forEachInstrDeep",
  "mapNestedBuffers",
  "directUses",
  "collectUses",
] as const;
const asyncNames = [
  "IrAsyncStateId",
  "IrAsyncHandlerId",
  "IrCanonicalPromiseAbi",
  "IrAsyncRuntimeIntent",
  "IrAsyncPlanValue",
  "IrAsyncSpillStorage",
  "IrAsyncSpill",
  "IrAsyncResumeValue",
  "IrAsyncSpillUpdate",
  "IrAsyncState",
  "IrAsyncHandler",
  "IrAsyncSuspendTerminator",
  "IrAsyncGotoTerminator",
  "IrAsyncBranchTerminator",
  "IrAsyncResolveTerminator",
  "IrAsyncRejectTerminator",
  "IrAsyncCompleteTerminator",
  "IrAsyncTerminator",
  "IrAsyncPlan",
] as const;
const dialectNames = [
  "IrInstrAwait",
  "IrInstrAsyncReturn",
  "IrInstrAsyncThrow",
  "IrInstrDynTruthy",
  "IrInstrDynToNumber",
  "IrInstrDynEq",
  "IrInstrDynMemberGet",
  "IrInstrDynMemberSet",
  "IrInstrGenPush",
  "IrInstrIterNew",
  "IrInstrIterNext",
  "IrInstrIterDone",
  "IrInstrIterValue",
  "IrInstrIterReturn",
  "IrInstrForOfIter",
  "IrInstrGenEpilogue",
  "IrInstrGenYieldStar",
  "IrInstrGenSetReturn",
  "IrInstrExternNew",
  "IrInstrExternCall",
  "IrInstrExternProp",
  "IrInstrExternPropSet",
  "IrInstrRegExpLiteral",
  "IrInstrStringRepeat",
  "IrInstrStringCharAt",
  "IrInstrStringCharCodeAt",
  "IrInstrForOfString",
] as const;
const identities = createTestIrFunctionIdentityFactory("core-nodes-seam");
const value = core.asValueId;
const f64 = core.irVal({ kind: "f64" });
const emptyResult = { result: null, resultType: null };
const leaf = (operand: number): core.IrInstr => ({
  kind: "slot.write",
  slot: 0,
  value: value(operand),
  ...emptyResult,
});
const buffers = [[leaf(20)], [leaf(21)], [leaf(22)]] as const;
const [a, b, c] = buffers;

const nestedCases: readonly {
  name: string;
  instruction: core.IrInstr;
  buffers: readonly (readonly core.IrInstr[])[];
  direct: readonly core.IrValueId[];
}[] = [
  {
    name: "if",
    instruction: {
      kind: "if",
      cond: value(1),
      then: a,
      thenValue: value(2),
      else: b,
      elseValue: value(3),
      ...emptyResult,
    },
    buffers: [a, b],
    direct: [value(1), value(2), value(3)],
  },
  {
    name: "if.stmt",
    instruction: { kind: "if.stmt", cond: value(1), then: a, else: b, ...emptyResult },
    buffers: [a, b],
    direct: [value(1)],
  },
  {
    name: "while.loop",
    instruction: { kind: "while.loop", cond: a, condValue: value(1), body: b, ...emptyResult },
    buffers: [a, b],
    direct: [value(1)],
  },
  {
    name: "post-condition loop",
    instruction: { kind: "while.loop", cond: a, condValue: value(1), body: b, postCond: true, ...emptyResult },
    buffers: [a, b],
    direct: [value(1)],
  },
  {
    name: "for.loop",
    instruction: { kind: "for.loop", cond: a, condValue: value(1), body: b, update: c, ...emptyResult },
    buffers: [a, b, c],
    direct: [value(1)],
  },
  {
    name: "forof.vec",
    instruction: {
      kind: "forof.vec",
      vec: value(1),
      elementType: f64,
      counterSlot: 0,
      lengthSlot: 1,
      vecSlot: 2,
      dataSlot: 3,
      elementSlot: 4,
      body: a,
      ...emptyResult,
    },
    buffers: [a],
    direct: [value(1)],
  },
  {
    name: "forof.iter",
    instruction: {
      kind: "forof.iter",
      iterable: value(1),
      iterSlot: 0,
      resultSlot: 1,
      elementSlot: 2,
      body: a,
      ...emptyResult,
    },
    buffers: [a],
    direct: [value(1)],
  },
  {
    name: "forof.string",
    instruction: {
      kind: "forof.string",
      str: value(1),
      counterSlot: 0,
      lengthSlot: 1,
      strSlot: 2,
      elementSlot: 3,
      body: a,
      ...emptyResult,
    },
    buffers: [a],
    direct: [value(1)],
  },
  {
    name: "try/catch/finally",
    instruction: { kind: "try", body: a, catchClause: { payloadSlot: 0, body: b }, finallyBody: c, ...emptyResult },
    buffers: [a, b, c],
    direct: [],
  },
  {
    name: "try/catch",
    instruction: { kind: "try", body: a, catchClause: { payloadSlot: -1, body: b }, ...emptyResult },
    buffers: [a, b],
    direct: [],
  },
  {
    name: "try/finally",
    instruction: { kind: "try", body: a, finallyBody: b, ...emptyResult },
    buffers: [a, b],
    direct: [],
  },
  {
    name: "labeled.block",
    instruction: { kind: "labeled.block", label: core.asLabelId(2), body: a, ...emptyResult },
    buffers: [a],
    direct: [],
  },
  {
    name: "switch",
    instruction: {
      kind: "switch",
      disc: value(1),
      discSlot: 0,
      tests: [0, null, 2],
      bodies: [a, b, c],
      breakLabel: core.asLabelId(2),
      ...emptyResult,
    },
    buffers: [a, b, c],
    direct: [value(1)],
  },
];

describe("complete canonical IR node seam", () => {
  it.each(movedFunctions)("preserves the exact old/new %s function object", (name) => {
    expect(old[name]).toBe(core[name]);
  });

  it("shares the allocator constructor, prototype, private counter and getter", () => {
    expect(old.IrValueIdAllocator).toBe(core.IrValueIdAllocator);
    expect(old.IrValueIdAllocator.prototype).toBe(core.IrValueIdAllocator.prototype);
    const first = new old.IrValueIdAllocator(),
      second = new core.IrValueIdAllocator();
    expect(first).toBeInstanceOf(core.IrValueIdAllocator);
    expect(second).toBeInstanceOf(old.IrValueIdAllocator);
    expect([first.count, second.count]).toEqual([0, 0]);
    expect([first.fresh(), first.fresh(), second.fresh()]).toEqual([0, 1, 0]);
    expect([first.count, second.count]).toEqual([2, 1]);
  });

  it.each(nestedCases)(
    "preserves $name buffer order, direct/deep uses, and map identity",
    ({ instruction, buffers: expected, direct }) => {
      const observed: (readonly core.IrInstr[])[] = [];
      old.forEachNestedBuffer(instruction, (buffer) => observed.push(buffer));
      expect(observed).toHaveLength(expected.length);
      observed.forEach((buffer, index) => expect(buffer).toBe(expected[index]));
      expect(core.directUses(instruction)).toEqual(direct);
      expect(old.collectUses(instruction)).toEqual(direct);
      expect(core.collectUses(instruction, { deep: false })).toEqual(direct);
      const nestedUses = expected.flatMap((buffer) => buffer.flatMap((entry) => core.directUses(entry)));
      expect(old.collectUses(instruction, { deep: true })).toEqual([...direct, ...nestedUses]);
      const visited: core.IrInstr[] = [];
      core.forEachInstrDeep(instruction, (entry) => visited.push(entry));
      expect(visited).toEqual([instruction, ...expected.flat()]);
      expect(core.mapNestedBuffers(instruction, (buffer) => buffer)).toBe(instruction);
      const copied = expected.map((buffer) => [...buffer]);
      let index = 0;
      const mapped = old.mapNestedBuffers(instruction, () => copied[index++]);
      expect(index).toBe(expected.length);
      expect(mapped).not.toBe(instruction);
      const mappedBuffers: (readonly core.IrInstr[])[] = [];
      core.forEachNestedBuffer(mapped, (buffer) => mappedBuffers.push(buffer));
      mappedBuffers.forEach((buffer, index) => expect(buffer).toBe(copied[index]));
      expect(mapped).toEqual(instruction);
    },
  );

  it("recurses through three levels without flattening, deduplicating or mutating shared buffers", () => {
    const inner: core.IrInstr = { kind: "if.stmt", cond: value(7), then: [leaf(8)], else: [], ...emptyResult };
    const middle: core.IrInstr = { kind: "try", body: [inner], finallyBody: [leaf(8)], ...emptyResult };
    const outer: core.IrInstr = { kind: "labeled.block", label: core.asLabelId(0), body: [middle], ...emptyResult };
    const visited: core.IrInstr[] = [];
    core.forEachInstrDeep(outer, (instruction) => visited.push(instruction));
    expect(visited.map((instruction) => instruction.kind)).toEqual([
      "labeled.block",
      "try",
      "if.stmt",
      "slot.write",
      "slot.write",
    ]);
    expect(core.collectUses(outer)).toEqual([]);
    expect(core.collectUses(outer, { deep: true })).toEqual([7, 8, 8]);
    expect(core.mapNestedBuffers(outer, (buffer) => buffer)).toBe(outer);
    expect(
      core.mapNestedBuffers(leaf(1), () => {
        throw Error("leaf visited a buffer");
      }),
    ).toEqual(leaf(1));
    expect(core.directUses({ kind: "early.return", value: null, ...emptyResult })).toEqual([]);
    expect(core.directUses({ kind: "early.return", value: value(9), ...emptyResult })).toEqual([9]);
  });

  it("uses the canonical allocator's fresh and count in a real nonempty builder/verifier flow", () => {
    const fresh = vi.spyOn(core.IrValueIdAllocator.prototype, "fresh");
    const count = vi.spyOn(core.IrValueIdAllocator.prototype, "count", "get");
    try {
      const builder = new IrFunctionBuilder(identities.next("read"), [f64]);
      const input = builder.addParam("input", f64);
      builder.openBlock();
      const one = builder.emitConst({ kind: "f64", value: 1 }, f64);
      builder.terminate({ kind: "return", values: [one] });
      const fn = builder.finish();
      expect(input).toBe(0);
      expect(one).toBe(1);
      expect(fn.valueCount).toBe(2);
      expect(fn.blocks[0].instrs).toHaveLength(1);
      expect(verifyIrFunction(fn)).toEqual([]);
      expect(fresh).toHaveBeenCalledTimes(2);
      expect(count).toHaveBeenCalledTimes(1);
    } finally {
      fresh.mockRestore();
      count.mockRestore();
    }
  });

  it("preserves a nonempty semantic plan and legacy optional prepared attachment without authenticating the placeholder", () => {
    const identity = identities.next("asyncRead"),
      input = value(0);
    const plan = createIrAsyncPlan({
      schemaVersion: 1,
      ownerUnitId: identity.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(f64),
      entry: asAsyncStateId(0),
      params: [{ value: input, type: f64 }],
      values: [{ value: input, type: f64 }],
      spills: [],
      handlers: [],
      states: [{ id: asAsyncStateId(0), body: [], terminator: { kind: "resolve", value: input } }],
      runtimeIntents: ["promise.capability.create", "promise.settle.fulfill"],
    });
    const semantic: core.IrFunction = {
      ...identity,
      params: [{ value: input, type: f64, name: "input" }],
      resultTypes: [f64],
      blocks: [
        {
          id: core.asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "return", values: [input] },
        },
      ],
      exported: true,
      valueCount: 1,
      funcKind: "async",
      asyncPlan: plan,
    };
    const snapshot = serializeIrAsyncPlan(plan);
    const runtime: PreparedIrAsyncRuntime = { kind: "standalone-native-wasmgc", adapters: [], states: plan.states };
    const prepared: PreparedIrFunction = { ...semantic, asyncRuntime: runtime };
    const module: PreparedIrModule = { functions: [prepared] };
    const oldModule: old.IrModule = module;
    expect(oldModule.functions[0]).toBe(prepared);
    expect(oldModule.functions[0].asyncRuntime).toBe(runtime);
    expect(prepared.asyncPlan).toBe(plan);
    expect(runtime.states).toBe(plan.states);
    expect(serializeIrAsyncPlan(plan)).toBe(snapshot);
    expect(() => assertPreparedIrAsyncRuntimeCurrent(identity.unitId, identity.name, plan, runtime)).toThrow(
      "exact semantic plan owner",
    );
    expect(semantic).not.toHaveProperty("asyncRuntime");
  });

  it("keeps actual prepared aliases and canonical type joins precise under the TypeScript checker", () => {
    const required = [
      "src/ir/core/intrinsic-vocabulary.ts",
      "src/ir/core/async-intents.ts",
      "src/ir/core/string-types.ts",
      "src/shared/contracts/ir-counted-string-identity.ts",
    ];
    required.forEach((path) => expect(read(path).length).toBeGreaterThan(0));
    const filename = resolve(root, ".tmp/core-nodes-type-contract.ts");
    const source = [
      "import type * as Core from '../src/ir/core/nodes.js';",
      "import type * as Old from '../src/ir/nodes.js';",
      "import type * as Async from '../src/ir/async-plan.js';",
      "import type * as SemanticAsync from '../src/ir/core/async-plan.js';",
      "import type * as Dialect from '../src/ir/dialect/js.js';",
      "import type * as CoreDialect from '../src/ir/core/dialect/js.js';",
      "type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
      "type Check<T extends true> = T;",
      "type FunctionAlias = Check<Equal<Old.IrFunction, Async.PreparedIrFunction>>;",
      "type ModuleAlias = Check<Equal<Old.IrModule, Async.PreparedIrModule>>;",
      "type PreparedMember = Check<Equal<Old.IrModule['functions'][number], Async.PreparedIrFunction>>;",
      "type CoreMember = Check<Equal<Core.IrModule['functions'][number], Core.IrFunction>>;",
      "type Attachment = Check<Equal<Old.IrFunction['asyncRuntime'], Async.PreparedIrAsyncRuntime | undefined>>;",
      ...asyncNames.map(
        (name) => "type Async_" + name + " = Check<Equal<Async." + name + ", SemanticAsync." + name + ">>;",
      ),
      ...dialectNames.map(
        (name) => "type Dialect_" + name + " = Check<Equal<Dialect." + name + ", CoreDialect." + name + ">>;",
      ),
      "declare let semantic: Core.IrFunction; declare let prepared: Old.IrFunction;",
      "semantic = prepared; prepared = semantic;", // Optional attachment still permits legacy fixtures.
      "let oldAllocator!: Old.IrValueIdAllocator; let allocator: Core.IrValueIdAllocator = oldAllocator; oldAllocator = allocator;",
      "// @ts-expect-error prepared attachment must not leak into core",
      "semantic.asyncRuntime;",
      "// @ts-expect-error semantic module members must not expose prepared state",
      "declare const leaked: Core.IrModule['functions'][number]['asyncRuntime'];",
      "// @ts-expect-error prepared attachment remains the exact closed runtime union",
      "const bad: Old.IrFunction = { ...prepared, asyncRuntime: { kind: 'standalone-native-wasmgc', adapters: [] } };",
    ].join("\n");
    const check = (text: string) => {
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
      };
      const host = ts.createCompilerHost(options),
        original = host.getSourceFile.bind(host);
      host.getSourceFile = (path, languageVersion, onError, fresh) =>
        path === filename
          ? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
          : original(path, languageVersion, onError, fresh);
      const program = ts.createProgram([filename], options, host);
      const file = program.getSourceFile(filename);
      if (!file) throw Error("missing checked type fixture");
      // Actual imported declarations are resolved. Whole-tree typecheck is a
      // separate parent gate; this diagnostic population is the focused join.
      return [
        ...program.getOptionsDiagnostics(),
        ...program.getSyntacticDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
      ];
    };
    expect(check(source).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual(
      [],
    );
    const rejected = check(source.replaceAll("@ts-expect-error", "negative control"));
    expect(rejected).toHaveLength(3);
    expect(rejected.every((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)).toBe(true);
  }, 60_000);
});
