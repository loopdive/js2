// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import type { AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { topAnnotation } from "../src/ir/analysis/lattice.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { findStackAllocCandidates } from "../src/ir/analysis/stack-alloc.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { JS_TAG_IDS } from "../src/ir/core/js-value-tag-identities.js";
import { type IrFunction, type IrModule, type IrValueId, forEachInstrDeep } from "../src/ir/core/nodes.js";
import { type IrType, irDynamic, irVal } from "../src/ir/core/types.js";
import { lowerNativeJsClassBodyToIr } from "../src/ir/from-ast.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { prepareSourceJsClassDefinitions } from "../src/ir/source-js-class-definition.js";
import { assertPreparedIrData } from "../src/shared/contracts/prepared-ir-data.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-6920-generic-structured-effects");
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const EXTERN = irVal({ kind: "externref" });
const DYNAMIC = irDynamic();
const NUMBER = irDynamic(JS_TAG_IDS.NumberF64);
const UNDEFINED = irDynamic(JS_TAG_IDS.Undefined);
const fixtureNamespace = "historical-private-ordinary-completion-diagnostic-v1";
const fixtureRaw = readFileSync(
  new URL("./fixtures/issue-6920-generic-structured-allocation-effects.json", import.meta.url),
  "utf8",
);
const fixtureSha256 = "bb26533d07e5ef98ffe01695bd94f7d41a0092e7e8045b0e0ffe1eb63fc5824d";

interface ModuleView {
  readonly ir: IrModule;
  readonly allocations: AllocRegistrySnapshot;
}
interface HistoricalRow {
  readonly namespace: string;
  readonly id: number;
  readonly sourceText: string;
  readonly source: ModuleView;
  readonly original: ModuleView | null;
  readonly selected: readonly (ModuleView & {
    readonly backend: string;
    readonly target: string;
  })[];
}
interface HistoricalFixture {
  readonly schema: string;
  readonly namespace: string;
  readonly census: {
    readonly rows: number;
    readonly wholeFunctionViews: number;
    readonly boxSitesAcrossViews: number;
    readonly ownUndefinedProperties: number;
  };
  readonly payload: { readonly rows: readonly HistoricalRow[] };
  readonly ownUndefinedPaths: readonly (readonly string[])[];
}
function restoreFixture(value: unknown): HistoricalFixture {
  assertPreparedIrData(value);
  const fixture = value as HistoricalFixture;
  if (
    fixture.schema !== "generic-structured-allocation-effects-historical-v1" ||
    fixture.namespace !== fixtureNamespace ||
    !Array.isArray(fixture.ownUndefinedPaths)
  )
    throw Error("historical fixture framing");
  const seen = new Set<string>();
  for (const path of fixture.ownUndefinedPaths) {
    if (
      !Array.isArray(path) ||
      path.some((part) => typeof part !== "string") ||
      path.at(-1) !== "origin" ||
      !["source", "original", "selected"].some((part) => path.includes(part))
    )
      throw Error("historical undefined path");
    const key = JSON.stringify(path);
    if (seen.has(key)) throw Error("duplicate historical undefined path");
    seen.add(key);
    let target: unknown = fixture.payload;
    for (const part of path.slice(0, -1)) {
      if (!target || typeof target !== "object") throw Error("missing historical path");
      const descriptor = Object.getOwnPropertyDescriptor(target, part);
      if (!descriptor || !("value" in descriptor)) throw Error("missing historical data property");
      target = descriptor.value;
    }
    if (!target || typeof target !== "object" || Object.hasOwn(target, "origin"))
      throw Error("historical undefined collision");
    Object.defineProperty(target, "origin", {
      value: undefined,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return fixture;
}
const history = () => restoreFixture(JSON.parse(fixtureRaw));
function instructions(fn: IrFunction) {
  const out: Parameters<Parameters<typeof forEachInstrDeep>[1]>[0][] = [];
  for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (instr) => out.push(instr));
  return out;
}
function box(b: IrFunctionBuilder, n = 4) {
  return b.emitBox(b.emitConst({ kind: "f64", value: n }, F64), NUMBER);
}
function allocOf(fn: IrFunction, value: IrValueId) {
  const instr = instructions(fn).find((entry) => entry.result === value);
  if (instr?.alloc === undefined) throw Error("expected genuine builder/captured allocation");
  return instr.alloc;
}
function registryOf(snapshot: AllocRegistrySnapshot) {
  const registry = new AllocSiteRegistry();
  for (const [index, entry] of snapshot.entries.entries()) {
    if (entry.state !== "live" || entry.site.id !== index) throw Error("historical live-site order changed");
    expect(registry.fresh(entry.site.kind, entry.site.type, entry.site.origin)).toBe(entry.site.id);
  }
  return registry;
}
function checkNonlocal(fn: IrFunction, registry: AllocSiteRegistry, values: readonly IrValueId[]) {
  expect(verifyIrFunction(fn)).toEqual([]);
  const ownership = analyzeOwnership(fn, registry),
    escapeResult = analyzeEscape(fn, registry, ownership);
  const candidates = findStackAllocCandidates(fn, undefined, ownership);
  for (const value of values) {
    const id = allocOf(fn, value),
      own = ownership.of(value),
      info = escapeResult.of(value);
    expect(own.ownership).toBe("escaped");
    expect(own.access.has("escape")).toBe(true);
    expect(info).toBeDefined();
    expect(info!.classification).not.toBe("local");
    expect(info!.stackAllocatable).toBe(false);
    expect(candidates.some((candidate) => candidate.allocId === id)).toBe(false);
    expect(registry.read(id, "ownership")).toEqual({
      state: own.ownership,
      ops: own.access.toArray(),
    });
    expect(registry.read(id, "escape")).toEqual(info);
  }
  return { ownership, escapeResult };
}
function corruptionChecks(view: ModuleView, snapshot: AllocRegistrySnapshot) {
  const id = snapshot.entries.findIndex((entry) => entry.state === "live" && entry.site.kind === "box");
  if (id < 0) throw Error("corruption floor: real box required");
  const mutations = [
    ["ownership", { state: "owned", ops: [] }],
    ["escape", { classification: "local", stackAllocatable: true }],
    ["ownership", { state: "escaped", ops: ["escape"], stackCandidate: true }],
  ] as const;
  for (const [namespace, forged] of mutations) {
    const clone = structuredClone(snapshot);
    const entry = clone.metadata.find((row) => row.id === id)!.entries.find(([key]) => key === namespace)!;
    (entry as unknown as [string, unknown])[1] = forged;
    expect(() => assertPreparedIrProgramAllocations({ ir: view.ir, allocations: clone })).toThrow(/evidence/);
  }
}
function built(
  emit: (b: IrFunctionBuilder, cond: IrValueId, external: IrValueId, vec: IrValueId, str: IrValueId) => void,
  results: readonly IrType[] = [DYNAMIC],
) {
  const registry = new AllocSiteRegistry(),
    b = new IrFunctionBuilder(identities.next("effects"), results, false, registry);
  const cond = b.addParam("condition", I32),
    external = b.addParam("external", EXTERN);
  const vec = b.addParam("vector", {
      kind: "vec",
      elementType: F64,
      nullable: false,
    }),
    str = b.addParam("string", { kind: "string" });
  b.openBlock();
  emit(b, cond, external, vec, str);
  const values = results.length ? [b.emitConst({ kind: "undefined" }, UNDEFINED)] : [];
  b.terminate({ kind: "return", values });
  return { fn: b.finish(), registry };
}

describe("historical generic structured effects DATA, never current frontend admission", () => {
  it("pins all eight records, twenty whole views, forty sites and forty own undefined properties", () => {
    expect(createHash("sha256").update(fixtureRaw).digest("hex")).toBe(fixtureSha256);
    const fixture = history();
    expect(fixture.payload.rows.map((row) => row.id)).toEqual([20, 21, 44, 45, 48, 49, 50, 51]);
    expect(fixture.census).toMatchObject({
      rows: 8,
      wholeFunctionViews: 20,
      boxSitesAcrossViews: 40,
      ownUndefinedProperties: 40,
    });
    expect(fixture.ownUndefinedPaths).toHaveLength(40);
    const views = fixture.payload.rows.flatMap((row) => [
      row.source,
      ...(row.original ? [row.original] : []),
      ...row.selected,
    ]);
    expect(views).toHaveLength(20);
    for (const view of views) {
      expect(view.ir.functions).toHaveLength(1);
      expect(view.allocations.size).toBe(2);
      for (const entry of view.allocations.entries) {
        expect(entry.state).toBe("live");
        if (entry.state === "live") {
          expect(Object.hasOwn(entry.site, "origin")).toBe(true);
          expect(entry.site.origin).toBeUndefined();
        }
      }
    }
    expect(fixture.payload.rows.filter((row) => row.original === null).map((row) => row.id)).toEqual([50, 51]);
  });
  it("refuses duplicate, missing and getter-bearing fixture framing", () => {
    const duplicate = JSON.parse(fixtureRaw) as HistoricalFixture;
    (duplicate.ownUndefinedPaths as string[][]).push([...duplicate.ownUndefinedPaths[0]!]);
    expect(() => restoreFixture(duplicate)).toThrow(/duplicate/);
    const missing = JSON.parse(fixtureRaw) as HistoricalFixture;
    (missing.ownUndefinedPaths as string[][])[0] = ["absent", "origin"];
    expect(() => restoreFixture(missing)).toThrow();
    let reads = 0;
    const getter = {
      schema: "x",
      get payload() {
        reads++;
        return {};
      },
    };
    expect(() => restoreFixture(getter)).toThrow();
    expect(reads).toBe(0);
  });
  for (const row of history().payload.rows)
    it(`replays historical row ${row.id} through actual whole function/registry DATA`, () => {
      expect(row.namespace).toBe(fixtureNamespace);
      for (const view of [row.source, ...(row.original ? [row.original] : []), ...row.selected]) {
        const registry = registryOf(view.allocations);
        for (const fn of view.ir.functions) {
          const all = instructions(fn),
            returned = all
              .filter((instr) => instr.kind === "early.return" && instr.value !== null)
              .map((instr) => {
                if (instr.kind !== "early.return" || instr.value === null) throw Error("return census");
                return instr.value;
              });
          expect(returned).toHaveLength(2);
          expect(returned.every((value) => all.some((instr) => instr.kind === "box" && instr.result === value))).toBe(
            true,
          );
          checkNonlocal(fn, registry, returned);
        }
        const current = registry.snapshot();
        expect(current.metadata).toHaveLength(2);
        assertPreparedIrProgramAllocations({
          ir: view.ir,
          allocations: current,
        });
        corruptionChecks(view, current);
      }
    });
});

describe("generic structures from genuine builders, not source or native profile permission", () => {
  it("marks an actual direct early-return box returned, never stack", () => {
    let value!: IrValueId;
    const result = built((b) => {
      value = box(b);
      b.emitEarlyReturn(value);
    });
    const checked = checkNonlocal(result.fn, result.registry, [value]);
    expect(checked.escapeResult.of(value)!.classification).toBe("returned");
  });
  it("keeps bare early return and a genuine owned-local positive distinct", () => {
    let value!: IrValueId;
    const result = built((b) => {
      value = box(b);
      b.emitEarlyReturn(null);
    }, []);
    expect(verifyIrFunction(result.fn)).toEqual([]);
    const ownership = analyzeOwnership(result.fn, result.registry),
      escapeResult = analyzeEscape(result.fn, result.registry, ownership);
    expect(ownership.ownershipOf(value)).toBe("owned");
    expect(escapeResult.classOf(value)).toBe("local");
    expect(findStackAllocCandidates(result.fn, undefined, ownership).map((row) => row.allocId)).toEqual([
      allocOf(result.fn, value),
    ]);
  });
  for (const kind of [
    "if",
    "if.stmt",
    "labeled.block",
    "switch",
    "while.loop",
    "for.loop",
    "try",
    "forof.vec",
    "forof.iter",
    "forof.string",
  ] as const)
    it(`visits genuine ${kind} child allocations and opaque-use effects`, () => {
      let value!: IrValueId;
      const result = built((b, cond, _external, vec, str) => {
        const body = b.collectBodyInstrs(() => {
          value = box(b);
          b.emitCoerceToExternref(value);
        });
        const slot = (type: "i32" | "f64" | "externref") => b.declareSlot("loop", { kind: type });
        switch (kind) {
          case "if": {
            let other!: IrValueId;
            const otherwise = b.collectBodyInstrs(() => {
              other = b.emitConst({ kind: "undefined" }, UNDEFINED);
            });
            b.emitIfElse({
              cond,
              then: body,
              thenValue: value,
              else: otherwise,
              elseValue: other,
              resultType: DYNAMIC,
            });
            break;
          }
          case "if.stmt":
            b.emitIfStmt({ cond, then: body, else: [] });
            break;
          case "labeled.block":
            b.emitLabeledBlock({ label: b.freshLoopLabel(), body });
            break;
          case "switch":
            b.emitSwitch({
              disc: cond,
              discSlot: slot("i32"),
              tests: [0, null],
              bodies: [[], body],
              breakLabel: b.freshLoopLabel(),
            });
            break;
          case "while.loop":
            b.emitWhileLoop({ cond: [], condValue: cond, body });
            break;
          case "for.loop":
            b.emitForLoop({
              cond: [],
              condValue: cond,
              body: [],
              update: body,
            });
            break;
          case "try":
            b.emitTry({ body: [], finallyBody: body });
            break;
          case "forof.vec":
            b.emitForOfVec({
              vec,
              elementType: F64,
              counterSlot: slot("i32"),
              lengthSlot: slot("i32"),
              vecSlot: slot("externref"),
              dataSlot: slot("externref"),
              elementSlot: slot("f64"),
              body,
            });
            break;
          case "forof.iter":
            b.emitForOfIter({
              iterable: _external,
              iterSlot: slot("externref"),
              resultSlot: slot("externref"),
              elementSlot: slot("externref"),
              body,
            });
            break;
          case "forof.string":
            b.emitForOfString({
              str,
              counterSlot: slot("i32"),
              lengthSlot: slot("i32"),
              strSlot: slot("externref"),
              elementSlot: slot("externref"),
              body,
            });
            break;
        }
      });
      expect(instructions(result.fn).filter((instr) => instr.alloc !== undefined)).toHaveLength(1);
      checkNonlocal(result.fn, result.registry, [value]);
      assertPreparedIrProgramAllocations({
        ir: { functions: [result.fn] },
        allocations: result.registry.snapshot(),
      });
    });
  it("joins two explicit actual select aliases into the returned-root escape", () => {
    let first!: IrValueId, second!: IrValueId;
    const result = built((b, cond) => {
      first = box(b, 4);
      second = box(b, 5);
      const selected = b.emitSelect(cond, first, second, DYNAMIC);
      b.emitEarlyReturn(selected);
    });
    checkNonlocal(result.fn, result.registry, [first, second]);
  });
  it("joins actual value-if alias roots without assuming one branch ran", () => {
    let first!: IrValueId, second!: IrValueId;
    const result = built((b, cond) => {
      const then = b.collectBodyInstrs(() => {
        first = box(b);
      });
      const otherwise = b.collectBodyInstrs(() => {
        second = box(b, 5);
      });
      const selected = b.emitIfElse({
        cond,
        then,
        thenValue: first,
        else: otherwise,
        elseValue: second,
        resultType: DYNAMIC,
      });
      b.emitEarlyReturn(selected);
    });
    checkNonlocal(result.fn, result.registry, [first, second]);
  });
  it("propagates actual CFG argument aliases to the real allocated root", () => {
    const registry = new AllocSiteRegistry(),
      b = new IrFunctionBuilder(identities.next("cfg"), [DYNAMIC], false, registry);
    const end = b.reserveBlockId();
    b.openBlock();
    const value = box(b);
    b.terminate({ kind: "br", branch: { target: end, args: [value] } });
    b.openReservedBlock(end, [DYNAMIC]);
    b.emitEarlyReturn(b.blockArg(0));
    const fallback = b.emitConst({ kind: "undefined" }, UNDEFINED);
    b.terminate({ kind: "return", values: [fallback] });
    checkNonlocal(b.finish(), registry, [value]);
  });
  it("serializes an actually unseen unreachable allocation as the same TOP the query returns", () => {
    const registry = new AllocSiteRegistry(),
      b = new IrFunctionBuilder(identities.next("unseen"), [], false, registry);
    b.openBlock();
    b.terminate({ kind: "return", values: [] });
    b.openBlock();
    const value = box(b);
    b.terminate({ kind: "unreachable" });
    const fn = b.finish();
    expect(verifyIrFunction(fn)).toEqual([]);
    const ownership = analyzeOwnership(fn, registry),
      escapeResult = analyzeEscape(fn, registry, ownership),
      top = topAnnotation();
    expect(ownership.of(value).ownership).toBe(top.ownership);
    expect(ownership.of(value).access.equals(top.access)).toBe(true);
    expect(registry.read(allocOf(fn, value), "ownership")).toEqual({
      state: top.ownership,
      ops: top.access.toArray(),
    });
    expect(escapeResult.classOf(value)).toBe("opaque");
    expect(findStackAllocCandidates(fn, undefined, ownership)).toEqual([]);
  });
  it("uses exact opaque extern operands instead of structural numeric fields", () => {
    let value!: IrValueId;
    const result = built((b, _cond, external) => {
      value = box(b);
      b.emitExternCall("OpaqueHost", "retain", external, [value], null);
    });
    checkNonlocal(result.fn, result.registry, [value]);
  });
});

describe("current class source through original member ownership, no ordinary completion option", () => {
  for (const sourceText of [
    "class C{m(flag:boolean){if(flag){return 4;}return 5;}}",
    "class C{m(flag:boolean){label:{if(flag){return 4;}}return 5;}}",
    "class C{m(n:number){switch(1){case 1:return 4;default:return 5;}}}",
  ])
    it(`keeps actual class-member return boxes nonlocal for ${sourceText}`, () => {
      const file = "/generic-class.ts",
        source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
      const options = {
          noLib: true,
          strict: true,
          target: ts.ScriptTarget.ES2022,
        },
        host = ts.createCompilerHost(options);
      host.getSourceFile = (name) => (name === file ? source : undefined);
      const program = ts.createProgram([file], options, host),
        inventory = buildIrUnitInventory([source], {
          entrySource: source,
          wholeProgramClassConstructors: true,
        });
      const identity = buildIrPlanningIdentityContext(inventory),
        plans = prepareSourceJsClassDefinitions(program.getTypeChecker(), identity),
        body = plans.definitions[0]!.members[0]!.body;
      plans.assertCurrent();
      const registry = new AllocSiteRegistry();
      const fn = lowerNativeJsClassBodyToIr(plans, body.unitId, {
        ownerUnitId: body.unitId,
        checker: program.getTypeChecker(),
        identityContext: identity,
        allocRegistry: registry,
      }).main;
      expect(fn.sourceClassBody?.classId).toBe(plans.definitions[0]!.sourceClassId);
      const values = instructions(fn)
        .filter((instr) => instr.kind === "box")
        .map((instr) => instr.result!);
      expect(values).toHaveLength(2);
      if (sourceText.includes("switch(1)")) {
        const switches = instructions(fn).filter((instr) => instr.kind === "switch");
        expect(switches).toHaveLength(1);
        const nested = switches[0]!.bodies.flat();
        expect(nested.filter((instr) => instr.kind === "box")).toHaveLength(2);
        expect(nested.filter((instr) => instr.kind === "early.return")).toHaveLength(2);
      }
      checkNonlocal(fn, registry, values);
      expect(fn.params).toHaveLength(5);
      expect(fn.blocks[0]!.instrs[0]!.kind).toBe("js.class.frame.new");
    });
  it("retains the genuine dynamic class-parameter switch source refusal before IR", () => {
    const file = "/generic-class.ts",
      source = ts.createSourceFile(
        file,
        "class C{m(n:number){switch(n){case 1:return 4;default:return 5;}}}",
        ts.ScriptTarget.Latest,
        true,
      );
    const options = { noLib: true, strict: true, target: ts.ScriptTarget.ES2022 },
      host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => (name === file ? source : undefined);
    const program = ts.createProgram([file], options, host),
      inventory = buildIrUnitInventory([source], {
        entrySource: source,
        wholeProgramClassConstructors: true,
      }),
      identity = buildIrPlanningIdentityContext(inventory),
      plans = prepareSourceJsClassDefinitions(program.getTypeChecker(), identity),
      body = plans.definitions[0]!.members[0]!.body;
    plans.assertCurrent();
    let failure: unknown;
    try {
      lowerNativeJsClassBodyToIr(plans, body.unitId, {
        ownerUnitId: body.unitId,
        checker: program.getTypeChecker(),
        identityContext: identity,
        allocRegistry: new AllocSiteRegistry(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      kind: "unsupported",
      stage: "build",
      code: "body-shape-rejected",
      message: "ir/from-ast: switch disc must lower to i32/f64 in C_m",
    });
  });
});
