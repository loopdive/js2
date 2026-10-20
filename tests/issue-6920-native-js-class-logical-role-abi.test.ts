// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareIrProgramRuntimeCallables } from "../src/ir/program/runtime-abi.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { nativeJsClassEvidenceDomainFromProgram } from "../src/ir/program/native-js-class-allocation-validation.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { analyzeNativeJsClass } from "../src/ir/analysis/allocation-evidence/native-js-class-producer.js";
import { verifyNativeJsClassEvidence } from "../src/ir/runtime/native-js-class-profile.js";
import { ProgramAbiMap } from "../src/ir/program/abi.js";

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
function genuine(policy: (typeof policies)[number] = policies[0]) {
  const ast = analyzeMultiSource(
    { "./entry.ts": "class C{x:number=3;}export function run():number{return new C().x===undefined?1:0;}" },
    "./entry.ts",
  );
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
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
  const ids = Object.values(domain.definitions[0]!.definition.roles).map((ref) => ref.binding.bindingId);
  expect(analyzeNativeJsClass(input.ir, restored.allocations, domain)).toBe(true);
  const registry = restored.allocations.snapshot();
  expect(verifyNativeJsClassEvidence(input.ir, registry, domain)?.kind).toBe("verified");
  return { context, ids, domain, registry };
}
it.each(policies)("logical roles have no fabricated Wasm slots $backend:$target", (policy) => {
  const { context, ids } = genuine(policy);
  const roles = context.abi.entries.filter((entry) => ids.includes(entry.plan.id));
  expect(roles).toHaveLength(7);
  const abi = new ProgramAbiMap(context.inventory);
  for (const role of roles) {
    expect(role.plan.slotPolicy).toBe("none");
    expect(Object.hasOwn(role.plan, "slotSpace")).toBe(false);
    expect(Object.hasOwn(role.plan, "aliasOf")).toBe(false);
    abi.plan(role.plan);
  }
  abi.sealPlan();
  for (const role of roles) {
    expect(() => abi.bindFinalIndex(role.plan.id, { space: "type", index: 0 })).toThrow(/slotless/);
    expect(abi.resolveFinalIndex(role.plan.id)).toBeUndefined();
  }
  abi.finishBinding();
});
it.each(["required", "alias", "space", "present-undefined-space", "alias-target", "key", "shape", "type", "ref"])(
  "canonical evidence rejects a forged logical role %s",
  (mutation) => {
    const { context, ids, domain, registry } = genuine();
    const changed: typeof context = JSON.parse(JSON.stringify(context));
    const role = changed.abi.entries.find((entry) => entry.plan.id === ids[0])!;
    if (role.contract.kind !== "type" || role.plan.intent.kind !== "type") throw Error("unexpected role");
    if (mutation === "required") Object.assign(role.plan, { slotPolicy: "required", slotSpace: "type" });
    if (mutation === "alias") Object.assign(role.plan, { slotPolicy: "alias", aliasOf: ids[1] });
    if (mutation === "space") Object.assign(role.plan, { slotSpace: "type" });
    if (mutation === "present-undefined-space") Object.assign(role.plan, { slotSpace: undefined });
    if (mutation === "alias-target") Object.assign(role.plan, { aliasOf: ids[1] });
    if (mutation === "key") Object.assign(role.plan, { structuralReferenceKey: "foreign" });
    if (mutation === "shape") Object.assign(role.plan.intent, { shapeKey: "foreign" });
    if (mutation === "type") Object.assign(role.contract, { type: { kind: "val", val: { kind: "i32" } } });
    if (mutation === "ref") Object.assign(role.contract, { ref: { ...role.contract.ref, name: "foreign" } });
    expect(() => nativeJsClassEvidenceDomainFromProgram(changed, changed.ir)).toThrow(/genuine logical type ABI/);
    const forgedDomain = { ...domain, programData: { ...domain.programData!, abiEntries: changed.abi.entries } };
    expect(verifyNativeJsClassEvidence(changed.ir, registry, forgedDomain)).toMatchObject({
      kind: "invalid",
      code: "lexical-definition",
    });
  },
);
