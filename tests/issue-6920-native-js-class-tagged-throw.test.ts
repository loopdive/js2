// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import { prepareIrProgramRuntimeCallables } from "../src/ir/program/runtime-abi.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { nativeJsClassEvidenceDomainFromProgram } from "../src/ir/program/native-js-class-allocation-validation.js";
import { analyzeNativeJsClass } from "../src/ir/analysis/allocation-evidence/native-js-class-producer.js";
import { inspectNativeJsClassNamespaces } from "../src/ir/analysis/allocation-evidence/native-js-class-profile.js";
import { verifyNativeJsClassEvidence } from "../src/ir/runtime/native-js-class-profile.js";

const fixtures = [
  {
    name: "method Number",
    source: "class C{m(){throw 7;}}export function run():number{new C().m();return 0;}",
    expected: {
      kind: "number",
      value: 7,
    },
  },
  {
    name: "method Boolean",
    source: "class C{m(){throw true;}}export function run():number{new C().m();return 0;}",
    expected: {
      kind: "boolean",
      value: true,
    },
  },
  {
    name: "method Undefined",
    source: "class C{m(){throw undefined;}}export function run():number{new C().m();return 0;}",
    expected: {
      kind: "undefined",
    },
  },
  {
    name: "constructor Number",
    source: "class C{constructor(){throw 7;}}export function run():number{new C();return 0;}",
    expected: {
      kind: "number",
      value: 7,
    },
  },
  {
    name: "method actual property",
    source: "class C{x:number=4;m(){throw this.x;}}export function run():number{new C().m();return 0;}",
    expected: {
      kind: "number",
      value: 4,
    },
  },
];
const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
function genuine(fixture = fixtures[0]!, policy: (typeof policies)[number] = policies[0]) {
  const ast = analyzeMultiSource({ "./entry.ts": fixture.source }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const captured = captureTypedIrProgramInput(source);
  const restored = AllocSiteRegistry.restorePreparationData(captured.allocations, captured);
  const input = restored.data;
  const runtime = prepareIrProgramRuntimeCallables(input);
  if (runtime.kind !== "prepared") throw Error(JSON.stringify(runtime));
  const context = { ...input, abi: { entries: prepareIrProgramAbiEntries(input, runtime.declarations) } };
  const domain = nativeJsClassEvidenceDomainFromProgram(context, input.ir);
  if (!domain) throw Error("missing genuine class domain");
  expect(analyzeNativeJsClass(input.ir, restored.allocations, domain)).toBe(true);
  const registry = restored.allocations.snapshot();
  expect(inspectNativeJsClassNamespaces(input.ir, registry, domain)?.kind).toBe("representable");
  expect(verifyNativeJsClassEvidence(input.ir, registry, domain)?.kind).toBe("verified");
  const instructions: IrInstr[] = [];
  const fn = input.ir.functions.find((item) => item.name === (fixture.name === "constructor Number" ? "C_new" : "C_m"));
  expect(fn).toBeDefined();
  for (const block of fn!.blocks)
    for (const root of block.instrs) forEachInstrDeep(root, (item) => instructions.push(item));
  const conversions = instructions.filter(
    (item): item is Extract<IrInstr, { kind: "coerce.to_externref" }> =>
      item.kind === "coerce.to_externref" &&
      instructions.some((definition) => definition.result === item.value && definition.resultType?.kind === "dynamic"),
  );
  expect(conversions).toHaveLength(1);
  const conversion = conversions[0]!;
  expect(conversion).toBeDefined();
  const thrown = instructions.find(
    (item): item is Extract<IrInstr, { kind: "throw" }> => item.kind === "throw" && item.value === conversion.result,
  )!;
  expect(thrown).toBeDefined();
  const operand = instructions.find((item) => item.result === conversion.value)!;
  expect(operand.resultType?.kind).toBe("dynamic");
  expect(conversion.resultType).toEqual({ kind: "val", val: { kind: "externref" } });
  return { source, input, restored, domain, registry, instructions, conversion, thrown, operand };
}
it.each(fixtures.flatMap((fixture) => policies.map((policy) => ({ fixture, policy }))))(
  "preserves $fixture.name exception on $policy.backend:$policy.target",
  ({ fixture, policy }) => {
    const exports: { run?: () => unknown } = {};
    const js = ts.transpileModule(fixture.source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("exports", js)(exports);
    let observed: unknown = { kind: "normal" };
    try {
      exports.run!();
    } catch (value) {
      observed = value === undefined ? { kind: "undefined" } : { kind: typeof value, value };
    }
    expect(observed).toEqual(fixture.expected);
    const { source } = genuine(fixture, policy);
    const result = prepareTypedIrProgram(captureTypedIrProgramInput(source), {
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
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const encoded = encodePreparedIrProgram(result.program);
    expect(encodePreparedIrProgram(decodePreparedIrProgram(encoded))).toBe(encoded);
  },
);
it.each(["scalar-input", "unknown-input", "wrong-result", "bypass-conversion"])(
  "rejects forged exception transport %s",
  (mutation) => {
    const { input, restored, domain, registry, conversion, thrown, operand } = genuine();
    if (operand.kind !== "box") throw Error("expected genuine Number box");
    if (mutation === "scalar-input") Object.assign(conversion, { value: operand.value });
    if (mutation === "unknown-input")
      Object.assign(conversion, { value: input.ir.functions.find((fn) => fn.name === "C_m")!.valueCount + 10 });
    if (mutation === "wrong-result") Object.assign(conversion, { resultType: { kind: "dynamic" } });
    if (mutation === "bypass-conversion") Object.assign(thrown, { value: operand.result });
    expect(() => analyzeNativeJsClass(input.ir, restored.allocations, domain)).toThrow();
    expect(inspectNativeJsClassNamespaces(input.ir, registry, domain)?.kind).not.toBe("representable");
    expect(verifyNativeJsClassEvidence(input.ir, registry, domain)?.kind).not.toBe("verified");
  },
);
it.each([0, 1])("cannot erase actual thrown box escape for fixture %s", (index) => {
  const { input, domain, registry, operand } = genuine(fixtures[index]!);
  if (operand.kind !== "box" || operand.alloc === undefined) throw Error("expected real thrown primitive allocation");
  const metadata = registry.metadata.find((row) => row.id === operand.alloc)!;
  expect(metadata.entries.find(([namespace]) => namespace === ALLOC_NAMESPACES.escape)?.[1]).toEqual({
    classification: "opaque",
    stackAllocatable: false,
  });
  const changed: typeof registry = JSON.parse(JSON.stringify(registry));
  const row = changed.metadata.find((row) => row.id === operand.alloc)!;
  Object.assign(row, {
    entries: row.entries.map(([namespace, value]) =>
      namespace === ALLOC_NAMESPACES.escape
        ? [namespace, { classification: "local", stackAllocatable: true }]
        : [namespace, value],
    ),
  });
  expect(inspectNativeJsClassNamespaces(input.ir, changed, domain)).toMatchObject({
    kind: "invalid",
    code: "namespace-value",
  });
  expect(verifyNativeJsClassEvidence(input.ir, changed, domain)).toMatchObject({
    kind: "invalid",
    code: "namespace-value",
  });
});
