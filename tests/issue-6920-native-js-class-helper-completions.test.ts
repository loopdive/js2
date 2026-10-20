// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  captureTypedIrProgramInput,
  prepareIrProgramSources,
  createPreparedSourceMapProjector,
} from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { analyzeNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { JS_TAG_IDS } from "../src/ir/core/js-value-tag-identities.js";

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
type Policy = (typeof policies)[number];
type Fixture = {
  name: string;
  files: Record<string, string>;
  expected: unknown;
  families: readonly string[];
  helperNames?: readonly string[];
  abrupt?: true;
};
function method(
  helper: string,
  expression = "effect()",
  observation = "new C().m()===undefined?1:0",
): Record<string, string> {
  return {
    "./entry.ts": `${helper}class C{m(){return ${expression};}}export function run():number{return ${observation};}`,
  };
}
const fixtures: readonly Fixture[] = [
  {
    name: "actual Number despite void",
    files: method("function effect():void{return 4 as never;}"),
    expected: 0,
    families: ["Number"],
  },
  { name: "empty body", files: method("function effect():void{}"), expected: 1, families: ["Undefined"] },
  { name: "bare return", files: method("function effect():void{return;}"), expected: 1, families: ["Undefined"] },
  {
    name: "fallthrough after effects",
    files: method("function effect():void{let x:number=1;x=x+1;}"),
    expected: 1,
    families: ["Undefined"],
  },
  {
    name: "mixed normal completion",
    files: method("function effect(x:number):void{if(x)return 4 as never;return;}", "effect(0)"),
    expected: 1,
    families: ["Number", "Undefined"],
  },
  {
    name: "actual Boolean despite void",
    files: method("function effect():void{return true as never;}"),
    expected: 0,
    families: ["Boolean"],
  },
  {
    name: "NaN payload",
    files: method("function effect():void{return (0/0) as never;}"),
    expected: 0,
    families: ["Number"],
  },
  {
    name: "negative zero payload",
    files: method("function effect():void{return -0 as never;}"),
    expected: 0,
    families: ["Number"],
  },
  {
    name: "ordinary helper chain",
    files: method("function leaf():void{return 4 as never;}function effect():void{return leaf();}"),
    expected: 0,
    families: ["Number"],
    helperNames: ["leaf", "effect"],
  },
  {
    name: "imported alias",
    files: {
      "./entry.ts":
        'import {effect as h} from "./helper.js";class C{m(){return h();}}export function run():number{return new C().m()===undefined?1:0;}',
      "./helper.ts": "export function effect():void{return 4 as never;}",
    },
    expected: 0,
    families: ["Number"],
  },
  {
    name: "discarded completion evaluates once",
    files: {
      "./entry.ts":
        "let count:number=0;function effect():void{count=count+1;return 4 as never;}class C{m(){effect();return;}}export function run():number{new C().m();return count;}",
    },
    expected: 1,
    families: ["Number"],
  },
  {
    name: "actual abrupt completion",
    files: {
      "./entry.ts":
        "function effect():void{throw 7;}class C{m(){return effect();}}export function run():number{new C().m();return 0;}",
    },
    expected: 7,
    families: [],
    abrupt: true,
  },
];
function reference(fixture: Fixture): unknown {
  const cache = new Map<string, Record<string, unknown>>();
  const load = (path: string): Record<string, unknown> => {
    const existing = cache.get(path);
    if (existing) return existing;
    const exports: Record<string, unknown> = {};
    cache.set(path, exports);
    const js = ts.transpileModule(fixture.files[path]!, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("exports", "require", js)(exports, (id: string) => load(id.replace(/\.js$/, ".ts")));
    return exports;
  };
  try {
    const value = (load("./entry.ts").run as () => unknown)();
    if (fixture.abrupt) throw new Error("reference did not throw");
    return value;
  } catch (error) {
    if (!fixture.abrupt) throw error;
    return error;
  }
}
function prepare(files: Record<string, string>, policy: Policy, mapped = false) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
    ...(mapped
      ? {
          sourceMap: {
            kind: "capture-source-map" as const,
            sources: ast.sourceFiles.map((sourceFile) => ({
              sourceFile,
              projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
            })),
          },
        }
      : {}),
  });
  if (source.kind !== "prepared") throw new Error(JSON.stringify(source));
  return { ast, source, input: captureTypedIrProgramInput(source) };
}
function instructions(fn: IrFunction): IrInstr[] {
  const output: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs) forEachInstrDeep(root, (instruction) => output.push(instruction));
  return output;
}
function typed(input: ReturnType<typeof captureTypedIrProgramInput>, policy: Policy) {
  const result = prepareTypedIrProgram(input, {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: false,
      escape: false,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: true,
    },
  });
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return result.program;
}
function assertNumericPayload(fn: IrFunction, negativeZero: boolean): void {
  const ops = instructions(fn);
  const returned = ops.find((instruction) => instruction.kind === "early.return");
  if (returned?.kind !== "early.return") throw new Error("missing actual payload return");
  const box = ops.find((instruction) => instruction.result === returned.value);
  if (box?.kind !== "box") throw new Error("return did not use its actual box");
  expect(box.toType).toEqual({ kind: "dynamic", tag: JS_TAG_IDS.NumberF64 });
  const value = ops.find((instruction) => instruction.result === box.value);
  const constant = (id: number): number => {
    const definition = ops.find((instruction) => instruction.result === id);
    if (definition?.kind !== "const" || definition.value.kind !== "f64")
      throw new Error("payload operand is not its genuine f64 constant");
    return definition.value.value;
  };
  if (value?.kind === "const" && value.value.kind === "f64") {
    expect(negativeZero ? Object.is(value.value.value, -0) : Number.isNaN(value.value.value)).toBe(true);
  } else if (negativeZero) {
    if (value?.kind !== "unary") throw new Error("missing original negative-zero operation");
    expect(value.op).toBe("f64.neg");
    expect(Object.is(constant(value.rand), 0)).toBe(true);
    expect(Object.is(-constant(value.rand), -0)).toBe(true);
  } else {
    if (value?.kind !== "binary") throw new Error("missing original NaN operation");
    expect(value.op).toBe("f64.div");
    expect(constant(value.lhs)).toBe(0);
    expect(constant(value.rhs)).toBe(0);
    expect(Number.isNaN(constant(value.lhs) / constant(value.rhs))).toBe(true);
  }
}
it.each(fixtures.flatMap((fixture) => policies.map((policy) => ({ fixture, policy }))))(
  "retains $fixture.name completion on $policy.backend:$policy.target",
  async ({ fixture, policy }) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reference(fixture)).toBe(fixture.expected);
    const { source, input } = prepare(fixture.files, policy);
    const helpers = source.ir.functions.filter((fn) => (fixture.helperNames ?? ["effect"]).includes(fn.name));
    expect(helpers).toHaveLength((fixture.helperNames ?? ["effect"]).length);
    for (const fn of helpers) {
      expect(fn.resultTypes).toEqual([{ kind: "dynamic" }]);
      expect(fn.sourceClassBody).toBeUndefined();
      expect(source.inventory.allUnits.find((unit) => unit.id === fn.unitId)?.kind).toBe("top-level-function");
      expect(
        fn.blocks.every((block) => block.terminator.kind !== "return" || block.terminator.values.length === 1),
      ).toBe(true);
    }
    const actual = { ...input, abi: { entries: prepareIrProgramAbiEntries(input) } };
    const normalized = normalizeNativeClassValues(actual, input.ir, "original");
    if (normalized.kind !== "normalized") throw new Error(JSON.stringify(normalized));
    const report = analyzeNativeJsClassValueDomains(normalized.input);
    expect(replayNativeJsClassValueDomains(normalized.input, report)).toEqual([]);
    const summary = report.functions.find((row) => row.unitId === helpers.find((fn) => fn.name === "effect")!.unitId)!;
    expect(summary.normalCompletion).toBe(!fixture.abrupt);
    const domain = summary.normalResultDomains[0]!;
    if (fixture.abrupt) expect(domain.kind).toBe("bottom");
    else {
      expect(domain.kind).toBe("known");
      if (domain.kind !== "known") throw new Error(JSON.stringify(domain));
      expect([...domain.families].sort()).toEqual([...fixture.families].sort());
    }
    const program = typed(input, policy);
    const encoded = encodePreparedIrProgram(program);
    const decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    for (const ir of [input.ir, decoded.ir]) {
      const effect = ir.functions.find((fn) => fn.name === "effect")!;
      if (fixture.name === "NaN payload" || fixture.name === "negative zero payload")
        assertNumericPayload(effect, fixture.name === "negative zero payload");
      if (fixture.name === "discarded completion evaluates once") {
        const caller = ir.functions.find((fn) => fn.name === "C_m")!;
        const calls = instructions(caller).filter((instruction) => instruction.kind === "call");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.target.binding).toEqual({ kind: "unit", unitId: effect.unitId });
        const ops = instructions(effect);
        const writes = ops.filter((instruction) => instruction.kind === "global.set");
        expect(writes).toHaveLength(1);
        const additions = ops.filter((instruction) => instruction.kind === "binary" && instruction.op === "f64.add");
        expect(additions).toHaveLength(1);
        expect(writes[0]!.value).toBe(additions[0]!.result);
      }
    }
    const returned = instructions(helpers[0]!).find((instruction) => instruction.kind === "early.return");
    if (fixture.name === "actual Number despite void" || fixture.name === "actual Boolean despite void") {
      expect(returned?.kind).toBe("early.return");
      const box = instructions(helpers[0]!).find((instruction) => instruction.kind === "box");
      expect(box?.kind).toBe("box");
      if (box?.kind !== "box") throw new Error("missing genuine return box");
      expect(box.toType).toEqual({
        kind: "dynamic",
        tag: fixture.families[0] === "Number" ? JS_TAG_IDS.NumberF64 : JS_TAG_IDS.Boolean,
      });
      expect(box.alloc).toBeDefined();
      const constant = instructions(helpers[0]!).find((instruction) => instruction.result === box.value);
      expect(constant?.kind).toBe("const");
      if (constant?.kind !== "const") throw new Error("missing original payload");
      expect(constant.value).toEqual(
        fixture.families[0] === "Number" ? { kind: "f64", value: 4 } : { kind: "bool", value: true },
      );
    }
  },
);
it.each(policies)("retains mapped return and implicit completion on $backend:$target", (policy) => {
  const { ast, source, input } = prepare(fixtures[0]!.files, policy, true);
  expect(input.sourceMap).toBeDefined();
  const declaration = ast.entryFile.statements.find(ts.isClassDeclaration)!;
  const ctorBody = input.ir.functions.find((fn) => fn.sourceClassBody?.sourceBodyKind === "constructor")!;
  const module = input.ir.functions.find((fn) => fn.name === "<module-init>")!;
  const definition = instructions(module).find((instruction) => instruction.kind === "js.class.define")!;
  const frame = instructions(ctorBody).find((instruction) => instruction.kind === "js.class.frame.new")!;
  if (definition.site?.origin?.kind !== "source" || frame.site?.origin?.kind !== "source")
    throw new Error("genuine class occurrence origins missing");
  expect(definition.site.origin.point.donorUnitId).toBe(module.unitId);
  expect(frame.site.origin.point.donorUnitId).toBe(ctorBody.unitId);
  expect(definition.site.origin.point.analyzed).toEqual(frame.site.origin.point.analyzed);
  expect(definition.site.origin.point.analyzed).toEqual({ start: declaration.getStart(), end: declaration.getEnd() });
  const projector = createPreparedSourceMapProjector(ast.sourceFiles, source.inventory, {
    kind: "capture-source-map",
    sources: ast.sourceFiles.map((sourceFile) => ({
      sourceFile,
      projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
    })),
  });
  expect(Object.keys(projector).sort()).toEqual(["project", "sourceMap"]);
  const defaultProjection = projector.project(declaration);
  if (defaultProjection.kind !== "source") throw new Error("original public projection missing");
  expect(defaultProjection.site.origin.point.donorUnitId).toBe(ctorBody.unitId);
  for (const sourceFile of ast.sourceFiles)
    for (const key of ["text", "statements"])
      Object.defineProperty(sourceFile, key, {
        get() {
          throw new Error("post-capture AST access");
        },
      });
  const program = typed(input, policy);
  const bytes = encodePreparedIrProgram(program);
  expect(encodePreparedIrProgram(decodePreparedIrProgram(bytes))).toBe(bytes);
});
it.each(["constructor", "method"] as const)("refuses a %s donor forged onto the startup occurrence", (role) => {
  const { input } = prepare(fixtures[0]!.files, policies[0], true);
  const program = typed(input, policies[0]);
  const changed = structuredClone(program.ir);
  const module = changed.functions.find((fn) => fn.name === "<module-init>")!;
  const foreign = changed.functions.find((fn) => fn.sourceClassBody?.sourceBodyKind === role)!;
  const definition = instructions(module).find((instruction) => instruction.kind === "js.class.define")!;
  if (definition.site?.origin?.kind !== "source") throw new Error("startup origin missing");
  Object.assign(definition.site.origin.point, { donorUnitId: foreign.unitId });
  expect(() => assertPreparedIrProgram({ ...program, ir: changed })).toThrow();
});
it.each(["body result", "return operand", "call result"] as const)("rejects changed actual helper %s", (change) => {
  const { input } = prepare(fixtures[0]!.files, policies[0]);
  const program = typed(input, policies[0]);
  const changed = structuredClone(program.ir);
  const helper = changed.functions.find((fn) => fn.name === "effect")!;
  if (change === "body result") Object.assign(helper, { resultTypes: [] });
  else if (change === "return operand") {
    const actual = instructions(helper).find((instruction) => instruction.kind === "early.return")!;
    Object.assign(actual, { value: 987654 });
  } else {
    const caller = changed.functions.find((fn) => fn.name === "C_m")!;
    const call = instructions(caller).find((instruction) => instruction.kind === "call")!;
    Object.assign(call, { resultType: null, result: null });
  }
  expect(() => assertPreparedIrProgram({ ...program, ir: changed })).toThrow();
});
it("keeps explicit scalar helper ABI and the class-free void source path unchanged", () => {
  const scalar = prepare(method("function effect():number{return 4;}"), policies[0]);
  expect(scalar.input.ir.functions.find((fn) => fn.name === "effect")!.resultTypes).toEqual([
    { kind: "val", val: { kind: "f64" } },
  ]);
  const old = prepare(
    { "./entry.ts": "function effect():void{}export function run():void{effect();return;}" },
    policies[0],
  );
  expect(old.input.ir.functions.every((fn) => fn.resultTypes.length === 0)).toBe(true);
});
it("keeps return cleanup unsupported rather than skipping finally", () => {
  const ast = analyzeMultiSource(
    method("function effect():void{try{return 4 as never;}finally{let x=1;}}"),
    "./entry.ts",
  );
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: [policies[0]],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  expect(source.kind).toBe("unsupported");
  if (source.kind !== "unsupported") throw new Error(JSON.stringify(source));
  expect(source.code).toBe("return-type-legacy-coupling");
});
