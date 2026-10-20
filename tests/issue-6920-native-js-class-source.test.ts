// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { preparedIrJsClassDefinitions } from "../src/ir/program/js-class-definition.js";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  prepareSourceJsClassDefinitions,
  assertSourceJsClassDefinitionsCurrent,
} from "../src/ir/source-js-class-definition.js";
import { irSourceGlobalRef, irModuleGlobalBindingId, irModuleTdzGlobalBindingId } from "../src/ir/abi-bindings.js";
import { irVal } from "../src/ir/core/types.js";
import { buildIrModuleInitPlan } from "../src/ir/module-init-plan.js";
import { assertPreparedIrJsClassStartup } from "../src/ir/program/js-class-startup.js";
import { lowerNativeJsClassModuleToIr, lowerFunctionAstToIr, lowerNativeJsClassBodyToIr } from "../src/ir/from-ast.js";
import { assertPreparedIrProgramPopulation } from "../src/ir/program/population.js";
import {
  inferNativeModuleInitializerArrayTypes,
  assertNativeModuleInitializerArrayTypesCurrent,
} from "../src/ir/array-element-inference.js";
import { collectNativeClassModuleInitPopulation } from "../src/ir/module-init.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { assertPreparedIrJsClassDefinitions } from "../src/ir/program/js-class-definition.js";
import type { TypedIrProgramGlobal } from "../src/ir/program/input-contracts.js";

function fixture(text: string) {
  const file = "/native-class.ts",
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const options = { noLib: true, strict: true, target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file ? source : undefined);
  const program = ts.createProgram([file], options, host);
  expect(program.getSyntacticDiagnostics()).toEqual([]);
  const inventory = buildIrUnitInventory([source], { entrySource: source, wholeProgramClassConstructors: true });
  const identity = buildIrPlanningIdentityContext(inventory);
  return {
    source,
    program,
    inventory,
    identity,
    prepare: () => prepareSourceJsClassDefinitions(program.getTypeChecker(), identity),
  };
}
describe("genuine original native JS class source census (preparation only)", () => {
  it("records a real module owner and Undefined-capable own field, without a body or runtime claim", () => {
    const f = fixture(
      "class C{x:number;read():number{return this.x===undefined?1:0;}}export function run():number{return new C().read();}",
    );
    const p = f.prepare(),
      d = p.definitions[0]!;
    expect(f.inventory.classes).toHaveLength(1);
    expect(f.inventory.allUnits).toHaveLength(4);
    expect(f.identity.moduleInitPopulationBySourceFile.get(f.source)?.[0]).toBe(f.source.statements[0]);
    expect(d.instanceElements).toMatchObject([
      { name: "x", valueType: { kind: "dynamic" }, defaultIntent: "undefined", initializer: null },
    ]);
    expect(d.constructor.params).toEqual([]);
    expect(d.members[0]!.body.params).toEqual([]);
    expect(d.constructor.lexicalOwnerId).toBe(f.inventory.classes[0]!.id);
    expect(d.evaluationOwnerUnitId).toBe(f.identity.moduleInitUnitIdBySourceFile.get(f.source));
    expect(Object.isFrozen(d)).toBe(true);
    p.assertCurrent();
  });
  it("preserves ordered defaults/initializers and genuine zero USER initializer signature", () => {
    const f = fixture("class C{a:number=3;b:number;constructor(x:number){} read():number{return 7;}}");
    const d = f.prepare().definitions[0]!;
    expect(d.instanceElements.map((x) => [x.sourceOrdinal, x.name, x.defaultIntent])).toEqual([
      [0, "a", "initializer"],
      [1, "b", "undefined"],
    ]);
    expect(d.instanceElements[0]!.initializer!.params).toEqual([]);
    expect(d.instanceElements[0]!.initializer!.result).toEqual({ kind: "dynamic" });
    expect(d.constructor.params).toEqual([{ kind: "dynamic" }]);
  });
  it("keeps initializer module x distinct from constructor USER x", () => {
    const f = fixture("let x:number=3;class C{y:number=x;constructor(x:number){}}");
    const declaration = (f.source.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
    const sourceId = f.inventory.sources[0]!.id;
    const storage: TypedIrProgramGlobal = {
      identity: { sourceId, storageOwnerUnitId: f.identity.moduleInitUnitIdBySourceId.get(sourceId)! },
      binding: {
        globalRef: irSourceGlobalRef(irModuleGlobalBindingId(sourceId, 0), "x"),
        tdzGlobalRef: irSourceGlobalRef(irModuleTdzGlobalBindingId(sourceId, 0), "x_tdz"),
        type: irVal({ kind: "f64" }),
      },
    };
    const p = prepareSourceJsClassDefinitions(
      f.program.getTypeChecker(),
      f.identity,
      new Map([[declaration, storage]]),
    );
    const d = p.definitions[0]!;
    expect(d.instanceElements[0]!.initializer!.params).toEqual([]);
    expect(d.captures).toMatchObject([{ mode: "live-global", bindingId: storage.binding.globalRef.binding.bindingId }]);
    expect(d.constructor.params).toHaveLength(1);
    expect(d.instanceElements[0]!.initializer!.frame.captures[0]!.valueGlobal).toEqual(storage.binding.globalRef);
  });
  it.each([
    ["default parameter", "class C{a:number=3;constructor(x:number=7){}}", "default/rest"],
    ["accessor", "class C{get x(){return 3;}}", "accessor/static/private"],
    ["derived", "class A{}class C extends A{}", "derived/super"],
    ["array", "class C{x:number[]=[];}", "field value/reference/array"],
    [
      "local capture",
      "function run(){let x:number=3;class C{y:number=x;}return 7;}",
      "live outer lexical cell capture",
    ],
    ["unowned global capture", "let x:number=3;class C{y:number=x;}", "authentic original storage plan"],
  ])("refuses %s at original source before class IR", (label, source, detail) => {
    const f = fixture(source);
    expect(() => f.prepare()).toThrow(detail);
    expect(() => f.prepare()).toThrow(/native JS class \/native-class.ts:\d+:\d+/);
  });
  it("rejects reordered original members before lowering", () => {
    const f = fixture("class C{a:number=3;b:number=4;}"),
      p = f.prepare();
    const declaration = f.source.statements[0] as ts.ClassDeclaration;
    const original = declaration.members;
    Object.defineProperty(declaration, "members", {
      value: ts.factory.createNodeArray([...original].reverse()),
      configurable: true,
    });
    try {
      expect(() => assertSourceJsClassDefinitionsCurrent(p)).toThrow("child order/value changed");
    } finally {
      Object.defineProperty(declaration, "members", { value: original, configurable: true });
    }
    p.assertCurrent();
  });
  it("rejects changed original identifier value with unchanged source text", () => {
    const f = fixture("class C{a:number=3;}"),
      p = f.prepare();
    const property = (f.source.statements[0] as ts.ClassDeclaration).members[0] as ts.PropertyDeclaration;
    const name = property.name as ts.Identifier;
    const previous = name.escapedText;
    Object.defineProperty(name, "escapedText", { value: "other", configurable: true });
    try {
      expect(() => p.assertCurrent()).toThrow("child order/value changed");
    } finally {
      Object.defineProperty(name, "escapedText", { value: previous, configurable: true });
    }
    p.assertCurrent();
  });
  it("does not accept an outsider currentness callback", () => {
    expect(() =>
      assertSourceJsClassDefinitionsCurrent({ plans: [], definitions: [], byClassId: new Map(), assertCurrent() {} }),
    ).toThrow("untracked original");
  });
});

describe("original native class body production (unsealed IR only)", () => {
  it("produces genuine implicit constructor and dynamic field read without folding Undefined to false", () => {
    const f = fixture("class C{x:number;read():number{return this.x===undefined?1:0;}}"),
      plans = f.prepare(),
      d = plans.definitions[0]!,
      registry = new AllocSiteRegistry();
    const functions = [d.constructor, d.members[0]!.body].map(
      (body) =>
        lowerNativeJsClassBodyToIr(plans, body.unitId, {
          ownerUnitId: body.unitId,
          checker: f.program.getTypeChecker(),
          allocRegistry: registry,
          identityContext: f.identity,
        }).main,
    );
    expect(functions.map((fn) => fn.params.length)).toEqual([4, 4]);
    expect(functions.every((fn) => fn.blocks[0]!.instrs[0]!.kind === "js.class.frame.new")).toBe(true);
    expect(functions[0]!.sourceClassBody).toMatchObject({ classId: d.sourceClassId, sourceBodyKind: "constructor" });
    expect(functions[1]!.blocks.flatMap((block) => block.instrs).map((instr) => instr.kind)).toContain(
      "js.class.property.get",
    );
    expect(functions[1]!.blocks.flatMap((block) => block.instrs).map((instr) => instr.kind)).toContain("tag.test");
    expect(registry.snapshot().entries).toHaveLength(3); // two real frames plus the actual Number return box
    assertPreparedIrJsClassDefinitions(f.inventory, [d], { functions });
    expect(d.instanceElements[0]!.defaultIntent).toBe("undefined");
  });
  it("rejects a mutable outsider body map before an IR allocation is minted", () => {
    const f = fixture("class C{x:number=3;}"),
      plans = f.prepare(),
      registry = new AllocSiteRegistry();
    (plans.plans[0]!.bodies as unknown as Map<string, ts.Node>).clear();
    expect(() =>
      lowerNativeJsClassBodyToIr(plans, plans.definitions[0]!.constructor.unitId, {
        ownerUnitId: plans.definitions[0]!.constructor.unitId,
        checker: f.program.getTypeChecker(),
        allocRegistry: registry,
      }),
    ).toThrow(/map changed/);
    expect(registry.snapshot().entries).toHaveLength(0);
  });
});

describe("original class-only module definition projection (DATA only)", () => {
  it.each(["standalone", "wasi"] as const)(
    "owns a genuine executable class-only module under %s without legacy evaluation rows",
    (target) => {
      const f = fixture("class C{x:number;}class D{}"),
        definitions = f.prepare().definitions;
      const plan = buildIrModuleInitPlan({
        sourceFile: f.source,
        checker: f.program.getTypeChecker(),
        identityContext: f.identity,
        target,
        deferTopLevelInit: false,
        jsClassDefinitions: definitions,
      });
      expect(plan.evaluations).toEqual([]);
      expect(plan.executable).toBe(true);
      expect(plan.invocation.kind).toBe(target === "wasi" ? "wasi-start-export" : "wasm-start");
      expect(plan.jsClassStartup!.definitions.map((row) => row.statementOrdinal)).toEqual([0, 1]);
      assertPreparedIrJsClassStartup([plan], definitions, f.inventory);
      const missing = {
        ...plan,
        jsClassStartup: { ...plan.jsClassStartup!, definitions: plan.jsClassStartup!.definitions.slice(1) },
      };
      expect(() => assertPreparedIrJsClassStartup([missing], definitions, f.inventory)).toThrow(/missing|omitted/);
      const reversed = {
        ...plan,
        jsClassStartup: { ...plan.jsClassStartup!, definitions: [...plan.jsClassStartup!.definitions].reverse() },
      };
      expect(() => assertPreparedIrJsClassStartup([reversed], definitions, f.inventory)).toThrow(/order/);
    },
  );
  it("rejects a startup projection getter without invoking it", () => {
    const f = fixture("class C{}"),
      definitions = f.prepare().definitions;
    const plan = buildIrModuleInitPlan({
      sourceFile: f.source,
      checker: f.program.getTypeChecker(),
      identityContext: f.identity,
      target: "standalone",
      deferTopLevelInit: false,
      jsClassDefinitions: definitions,
    });
    let calls = 0;
    const bad = { ...plan };
    Object.defineProperty(bad, "jsClassStartup", {
      get() {
        calls++;
        return plan.jsClassStartup;
      },
    });
    expect(() => assertPreparedIrJsClassStartup([bad], definitions, f.inventory)).toThrow(/own DATA/);
    expect(calls).toBe(0);
  });
});

describe("genuine whole original source class IR population (not PreparedIR/runtime)", () => {
  it("builds the real module plus original constructor/method/run units without a fabricated FunctionDeclaration", () => {
    const text =
      "class C{x:number;read():number{return this.x===undefined?1:0;}}function run():number{return new C().x===undefined?1:0;}";
    const f = fixture(text),
      plans = f.prepare(),
      d = plans.definitions[0]!,
      registry = new AllocSiteRegistry(),
      checker = f.program.getTypeChecker();
    const module = lowerNativeJsClassModuleToIr(f.source, plans, {
      ownerUnitId: f.identity.moduleInitUnitIdBySourceFile.get(f.source)!,
      checker,
      identityContext: f.identity,
      allocRegistry: registry,
    }).main;
    const run = f.source.statements.find(ts.isFunctionDeclaration)!;
    const runBody = lowerFunctionAstToIr(run, {
      ownerUnitId: f.identity.unitIdByDeclaration.get(run)!,
      checker,
      identityContext: f.identity,
      allocRegistry: registry,
      nativeJsClassDefinitions: plans,
    }).main;
    const functions = [
      module,
      runBody,
      ...[d.constructor, d.members[0]!.body].map(
        (body) =>
          lowerNativeJsClassBodyToIr(plans, body.unitId, {
            ownerUnitId: body.unitId,
            checker,
            identityContext: f.identity,
            allocRegistry: registry,
          }).main,
      ),
    ];
    assertPreparedIrProgramPopulation({ inventory: f.inventory, ir: { functions }, derivedUnits: [] });
    assertPreparedIrJsClassDefinitions(f.inventory, [d], { functions });
    expect(module.params).toEqual([]);
    expect(module.blocks[0]!.instrs.map((instr) => instr.kind)).toEqual(["js.class.define", "js.class.binding.init"]);
    expect(runBody.blocks[0]!.instrs.map((instr) => instr.kind)).toEqual([
      "js.class.binding.read",
      "js.class.construct",
      "js.class.property.get",
      "tag.test",
      "if",
    ]);
    expect(registry.snapshot().entries).toHaveLength(5); // actual method Number completion has its own box site
    const js = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    expect(new Function(js + ";return run();")()).toBe(1); // actual JS value control only
  });
  it.each(["let a:number[]=[];", "let a:any=3;", "let a:unknown=3;", "function a():number[]{return [];}let b=a();"])(
    "refuses unproved original module no-array closure: %s",
    (text) => {
      const f = fixture(text),
        population = collectNativeClassModuleInitPopulation(f.source);
      expect(() => inferNativeModuleInitializerArrayTypes(f.source, population, f.program.getTypeChecker())).toThrow(
        /array|unknown|reference/,
      );
    },
  );
  it("brands the exact original population/checker and rejects reordered/mutated/foreign inputs", () => {
    const f = fixture("let a:number=3;class C{}"),
      population = collectNativeClassModuleInitPopulation(f.source),
      checker = f.program.getTypeChecker();
    const owned = inferNativeModuleInitializerArrayTypes(f.source, population, checker);
    assertNativeModuleInitializerArrayTypesCurrent(owned, f.source, population, checker);
    expect(() => inferNativeModuleInitializerArrayTypes(f.source, [...population].reverse(), checker)).toThrow(
      /reordered/,
    );
    expect(() => inferNativeModuleInitializerArrayTypes(f.source, population.slice(1), checker)).toThrow(/omitted/);
    expect(() =>
      assertNativeModuleInitializerArrayTypesCurrent(
        owned,
        f.source,
        population,
        fixture("let a=3;").program.getTypeChecker(),
      ),
    ).toThrow(/foreign/);
    const old = f.source.text;
    f.source.text += " ";
    expect(() => assertNativeModuleInitializerArrayTypesCurrent(owned, f.source, population, checker)).toThrow(
      /text changed/,
    );
    f.source.text = old;
    assertNativeModuleInitializerArrayTypesCurrent(owned, f.source, population, checker);
  });
});

describe("actual native class original source pipeline (unsealed preparation)", () => {
  it.each([
    { backend: "wasmgc", target: "standalone" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "linear", target: "standalone" },
    { backend: "linear", target: "wasi" },
  ] as const)("prepares original module/body/startup/realm DATA on $backend:$target", (policy) => {
    const text =
      "class C{x:number;read():number{return this.x===undefined?1:0;}}export function run():number{return new C().x===undefined?1:0;}";
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(source.kind).toBe("prepared");
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const typed = captureTypedIrProgramInput(source);
    expect(typed.ir.functions).toHaveLength(4);
    expect(typed.jsClassDefinitions).toHaveLength(1);
    assertPreparedIrProgramPopulation(typed);
    assertPreparedIrJsClassDefinitions(typed.inventory, typed.jsClassDefinitions!, typed.ir);
    assertPreparedIrJsClassStartup(typed.startup, typed.jsClassDefinitions!, typed.inventory);
    const entries = prepareIrProgramAbiEntries(typed, []),
      definitions = preparedIrJsClassDefinitions(entries);
    expect(definitions).toHaveLength(1);
    for (const id of Object.values(definitions[0]!.definition.realm))
      expect(entries.find((entry) => entry.plan.id === id)?.contract).toMatchObject({ kind: "global", mutable: false });
    expect(typed.allocations.size).toBe(5); // genuine module/instance/two frames/return box; no runtime credit
  });
  it("returns a genuinely allocated tagged Number field initializer with zero USER args despite constructor x", () => {
    const ast = analyzeMultiSource(
        {
          "./entry.ts":
            "let x:number=3;class C{y:number=x;constructor(x:number){}}export function run():number{return 7;}",
        },
        "./entry.ts",
      ),
      policy = { backend: "wasmgc", target: "standalone" } as const;
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(source.kind).toBe("prepared");
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const typed = captureTypedIrProgramInput(source),
      d = typed.jsClassDefinitions![0]!,
      initializer = typed.ir.functions.find((fn) => fn.unitId === d.instanceElements[0]!.initializer!.unitId)!;
    expect(initializer.params).toHaveLength(4);
    expect(d.constructor.params).toHaveLength(1);
    const read = initializer.blocks[0]!.instrs.find((instr) => instr.kind === "js.class.frame.get");
    expect(read).toMatchObject({ access: { kind: "capture", index: 0 } });
    const box = initializer.blocks[0]!.instrs.find((instr) => instr.kind === "box");
    expect(box?.alloc).toBeDefined();
    expect(box?.resultType?.kind).toBe("dynamic");
    expect(initializer.resultTypes).toEqual([{ kind: "dynamic" }]);
    expect(d.instanceElements[0]!.initializer!.params).toEqual([]);
  });
});

it("refuses nullable new.target/Undefined comparison rather than folding absence to false", () => {
  const f = fixture("class C{read():number{return new.target===undefined?1:0;}}"),
    plans = f.prepare(),
    body = plans.definitions[0]!.members[0]!.body;
  expect(() =>
    lowerNativeJsClassBodyToIr(plans, body.unitId, {
      ownerUnitId: body.unitId,
      checker: f.program.getTypeChecker(),
      identityContext: f.identity,
      allocRegistry: new AllocSiteRegistry(),
    }),
  ).toThrow(/actual Undefined projection/);
});
it("refuses erased this-parameter adaptation before inventing a USER argument", () => {
  expect(() => fixture("class C{read(this:C):number{return 7;}}").prepare()).toThrow(/parameter/);
});

describe("actual current property observations and pending dynamic calls", () => {
  it.each([
    "class C{m(){return 1;}}function run():number{const c=new C();c.m=undefined;return c.m===undefined?1:0;}",
    "class C{m:number; m(){return 1;}}function run():number{const c=new C();return c.m===undefined?1:0;}",
  ])("does not refine a current method property from its declaration: %s", (text) => {
    const f = fixture(text),
      plans = f.prepare(),
      run = f.source.statements.find(ts.isFunctionDeclaration)!;
    const fn = lowerFunctionAstToIr(run, {
      ownerUnitId: f.identity.unitIdByDeclaration.get(run)!,
      checker: f.program.getTypeChecker(),
      identityContext: f.identity,
      allocRegistry: new AllocSiteRegistry(),
      nativeJsClassDefinitions: plans,
    }).main;
    const instructions = fn.blocks.flatMap((block) => block.instrs);
    expect(instructions.find((instr) => instr.kind === "js.class.property.get")?.resultType).toEqual({
      kind: "dynamic",
    });
    expect(instructions.some((instr) => instr.kind === "tag.test")).toBe(true);
    const js = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    expect(new Function(js + ";return run();")()).toBe(1); // JS control; no native runtime credit
  });
  it("retains actual helper completion and argument-before-callability source ordering", () => {
    const text =
      "class C{m(x:number){return x;}}function effect(){throw 7;}function run():void{const c=new C();c.m=undefined;c.m(effect());}";
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const policy = { backend: "wasmgc", target: "standalone" } as const;
    const result = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const effect = result.ir.functions.find((fn) => fn.name === "effect")!;
    expect(effect.resultTypes).toEqual([{ kind: "dynamic" }]);
    const run = result.ir.functions.find((fn) => fn.name === "run")!;
    const ops = run.blocks[0]!.instrs;
    const getter = ops.find((instruction) => instruction.kind === "js.class.property.get")!;
    const argument = ops.find((instruction) => instruction.kind === "call")!;
    const invoke = ops.find((instruction) => instruction.kind === "js.class.invoke")!;
    if (getter.kind !== "js.class.property.get" || argument.kind !== "call" || invoke.kind !== "js.class.invoke")
      throw Error("actual getter/argument/invoke source population missing");
    expect(ops.indexOf(getter)).toBeLessThan(ops.indexOf(argument));
    expect(ops.indexOf(argument)).toBeLessThan(ops.indexOf(invoke));
    expect(argument.target.binding).toEqual({ kind: "unit", unitId: effect.unitId });
    expect(invoke.callable).toBe(getter.result);
    expect(invoke.receiver).toBe(getter.receiver);
    expect(invoke.args).toEqual([argument.result]);
    const js = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    let thrown: unknown;
    try {
      new Function(js + ";return run();")();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(7);
  });
  it("does not send a shadowed undefined value to builtin Undefined comparison", () => {
    const f = fixture("class C{read(undefined:number):number{return 3===undefined?1:0;}}"),
      plans = f.prepare(),
      body = plans.definitions[0]!.members[0]!.body;
    expect(() =>
      lowerNativeJsClassBodyToIr(plans, body.unitId, {
        ownerUnitId: body.unitId,
        checker: f.program.getTypeChecker(),
        identityContext: f.identity,
        allocRegistry: new AllocSiteRegistry(),
      }),
    ).toThrow(/shadowed Undefined equality/);
  });
});

describe("authentic same-checker source custody phase join", () => {
  it.each([
    { backend: "wasmgc", target: "standalone" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "linear", target: "standalone" },
    { backend: "linear", target: "wasi" },
  ] as const)("prepares the original empty-member class/local alias on $backend:$target", (policy) => {
    const text = "class C{x:number;}export function run():number{const c=new C();return c.x===undefined?1:0;}";
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(source.kind).toBe("prepared");
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const typed = captureTypedIrProgramInput(source);
    expect(typed.ir.functions).toHaveLength(3);
    expect(typed.allocations.size).toBe(3);
    assertPreparedIrProgramPopulation(typed);
    assertPreparedIrJsClassDefinitions(typed.inventory, typed.jsClassDefinitions!, typed.ir);
    assertPreparedIrJsClassStartup(typed.startup, typed.jsClassDefinitions!, typed.inventory);
    const run = typed.ir.functions.find((fn) => fn.name === "run")!;
    expect(run.blocks.flatMap((block) => block.instrs).some((instr) => instr.kind === "tag.test")).toBe(true);
    const js = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports: { run?: () => number } = {};
    new Function("exports", js)(exports);
    expect(exports.run!()).toBe(1); // JS control only; no native runtime credit
  });
  it("keeps exact semantic and checker cache flags in the frozen original tree", () => {
    const f = fixture("class C{x:number;}function run():number{const c=new C();return c.x===undefined?1:0;}"),
      plans = f.prepare();
    const expressions: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isExpression(node)) expressions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(f.source);
    for (const node of expressions) f.program.getTypeChecker().getTypeAtLocation(node);
    plans.assertCurrent();
    const run = f.source.statements.find(ts.isFunctionDeclaration)!,
      declarationList = (run.body!.statements[0] as ts.VariableStatement).declarationList;
    const flags = declarationList.flags;
    expect(Reflect.set(declarationList, "flags", flags ^ ts.NodeFlags.Const)).toBe(true);
    try {
      expect(() => plans.assertCurrent()).toThrow(/child order\/value changed/);
    } finally {
      expect(Reflect.set(declarationList, "flags", flags)).toBe(true);
    }
    const conditional = expressions.find(ts.isConditionalExpression)!;
    const cached = conditional.flags;
    expect((cached & 268435456) !== 0).toBe(true);
    expect(Reflect.set(conditional, "flags", cached ^ 268435456)).toBe(true);
    try {
      expect(() => plans.assertCurrent()).toThrow(/child order\/value changed/);
    } finally {
      expect(Reflect.set(conditional, "flags", cached)).toBe(true);
    }
    plans.assertCurrent();
  });
});

describe("actual captured method invocation source protocol (unsealed; no native runtime credit)", () => {
  const profiles = [
    { backend: "wasmgc", target: "standalone" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "linear", target: "standalone" },
    { backend: "linear", target: "wasi" },
  ] as const;
  it.each(profiles)(
    "refuses annotated scalar public return until actual normal-domain projection on $backend:$target",
    (policy) => {
      const text = "class C{m():number{return 1;}}export function run():number{return new C().m();}";
      const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
      const result = prepareIrProgramSources({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy,
        runtimePolicies: [policy],
        deferTopLevelInit: false,
        linearVectorProjection: "native-f64",
      });
      expect(result.kind).toBe("unsupported");
      if (result.kind !== "unsupported") throw Error(JSON.stringify(result));
      expect(result.detail).toMatch(/genuine tagged value ABI/);
      expect(result).toMatchObject({ code: "class-member-unsupported", stage: "build" });
    },
  );
  const cases = [
    {
      name: "Number argument and actual addition",
      source: "class C{m(x:number):number{return x+1;}}export function run():number{const c=new C();c.m(3);return 7;}",
      expected: 7,
    },
    {
      name: "Boolean identity without annotation coercion",
      source:
        "class C{m(x:boolean):boolean{return x;}}export function run():number{const c=new C();return c.m(true)===undefined?1:0;}",
      expected: 0,
    },
    {
      name: "void normal completion is genuine Undefined",
      source: "class C{m():void{}}export function run():number{return new C().m()===undefined?1:0;}",
      expected: 1,
    },
    {
      name: "argument throws before noncallable check",
      source:
        "class C{m(x:number){return x;}}function effect():number{throw 7;}export function run():number{const c=new C();c.m=undefined;c.m(effect());return 7;}",
      thrown: 7,
    },
    {
      name: "getter snapshot survives argument reassignment and retains this",
      source:
        "class C{x:number=5;m(y:number){return this.x+y;}}export function run():number{const c=new C();return c.m((c.m=undefined,2))===undefined?1:0;}",
      expected: 0,
    },
  ];
  for (const test of cases)
    it.each(profiles)(`${test.name} on $backend:$target`, (policy) => {
      const ast = analyzeMultiSource({ "./entry.ts": test.source }, "./entry.ts");
      const source = prepareIrProgramSources({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy,
        runtimePolicies: [policy],
        deferTopLevelInit: false,
        linearVectorProjection: "native-f64",
      });
      expect(source.kind).toBe("prepared");
      if (source.kind !== "prepared") throw Error(JSON.stringify(source));
      const typed = captureTypedIrProgramInput(source);
      assertPreparedIrProgramPopulation(typed);
      assertPreparedIrJsClassDefinitions(typed.inventory, typed.jsClassDefinitions!, typed.ir);
      const body = typed.jsClassDefinitions![0]!.members[0]!.body;
      expect(body.params.every((param) => param.kind === "dynamic" && param.tag === undefined)).toBe(true);
      expect(body.result).toEqual({ kind: "dynamic" });
      const method = typed.ir.functions.find((fn) => fn.unitId === body.unitId)!;
      expect(method.params.slice(4).map((p) => p.type)).toEqual(body.params);
      expect(method.resultTypes).toEqual([{ kind: "dynamic" }]);
      const run = typed.ir.functions.find((fn) => fn.name === "run")!;
      const instructions = run.blocks.flatMap((block) => block.instrs);
      const callIndex = instructions.findIndex((instr) => instr.kind === "js.class.invoke");
      const invoke = instructions[callIndex]!;
      if (invoke.kind !== "js.class.invoke") throw Error("actual invoke missing");
      const getterIndex = instructions.findIndex(
        (instr) => instr.kind === "js.class.property.get" && instr.result === invoke.callable,
      );
      expect(getterIndex).toBeGreaterThanOrEqual(0);
      expect(getterIndex).toBeLessThan(callIndex);
      const getter = instructions[getterIndex]!;
      if (getter.kind !== "js.class.property.get") throw Error("actual getter missing");
      expect(getter.receiver).toBe(invoke.receiver);
      expect(getter.resultType).toEqual({ kind: "dynamic" });
      expect(invoke.resultType).toEqual({ kind: "dynamic" });
      expect(invoke.signature.result).toEqual({ kind: "dynamic" });
      for (const arg of invoke.args) {
        const instruction = instructions.find((instr) => instr.result === arg)!;
        expect(instruction).toBeDefined();
        expect(instruction.resultType?.kind).toBe("dynamic");
      }
      if (test.name.startsWith("argument throws")) {
        const effectIndex = instructions.findIndex((instr) => instr.kind === "call" && instr.target.name === "effect");
        expect(effectIndex).toBeGreaterThan(getterIndex);
        expect(effectIndex).toBeLessThan(callIndex);
      }
      if (test.name.startsWith("getter snapshot")) {
        const writeIndex = instructions.findIndex((instr) => instr.kind === "js.class.property.set");
        expect(writeIndex).toBeGreaterThan(getterIndex);
        expect(writeIndex).toBeLessThan(callIndex);
      }
      const js = ts.transpileModule(test.source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
      const evaluate = () => new Function("exports", js + ";return run();")({});
      if ("thrown" in test) {
        let thrown: unknown;
        try {
          evaluate();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(test.thrown);
      } else expect(evaluate()).toBe(test.expected);
    });
  it.each([
    "class C{m(){return;}}",
    "class C{m(){let x:number=3;}}",
    "class C{m(x:boolean){if(x)return 3;return undefined;}}",
  ])("produces actual tagged returns and normal Undefined for %s", (text) => {
    const f = fixture(text),
      plans = f.prepare(),
      body = plans.definitions[0]!.members[0]!.body;
    const fn = lowerNativeJsClassBodyToIr(plans, body.unitId, {
      ownerUnitId: body.unitId,
      checker: f.program.getTypeChecker(),
      identityContext: f.identity,
      allocRegistry: new AllocSiteRegistry(),
    }).main;
    expect(fn.resultTypes).toEqual([{ kind: "dynamic" }]);
    expect(fn.blocks.at(-1)!.terminator.kind).toBe("return");
    expect(fn.blocks.at(-1)!.instrs.at(-1)).toMatchObject({ kind: "const", value: { kind: "undefined" } });
  });
});
