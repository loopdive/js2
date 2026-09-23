// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as asyncSchema from "../src/runtime/contracts/async-provider-schema.js";
import * as hostSchema from "../src/runtime/contracts/host-capability-schema.js";
import * as policy from "../src/runtime/contracts/provider-policy.js";
import * as foundation from "../src/runtime/contracts/index.js";
import * as intrinsicSchema from "../src/ir/runtime/contracts/intrinsics.js";
import * as manifestSchema from "../src/ir/runtime/contracts/manifest.js";
import * as runtimeContracts from "../src/ir/runtime/index.js";
import type {
  CurrentPreparedIrAsyncRuntime,
  PreparedIrAsyncRuntime,
  PreparedIrAsyncRuntimeInput,
} from "../src/ir/runtime/contracts/prepared.js";
import * as oldAsync from "../src/ir/async-runtime-providers.js";
import * as oldIntrinsics from "../src/ir/intrinsics.js";
import * as oldManifest from "../src/ir/runtime-manifest.js";
import {
  asAsyncStateId,
  assertPreparedIrAsyncRuntimeCurrent,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  createPreparedIrAsyncRuntime,
  sealPreparedIrAsyncRuntimeContainers,
  serializeIrAsyncPlan,
} from "../src/ir/async-plan.js";
import { asValueId, irVal } from "../src/ir/core/nodes.js";
import type { IrTypeRef, IrVecLayoutRef } from "../src/ir/core/types.js";
import { createIrBindingId } from "../src/shared/contracts/identity-values.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import {
  acceptedHistoricalDeclarations,
  assertIntrinsicSpecialization,
  assertNamedForward,
  currentDeclarations,
  receiptRows,
} from "./helpers/ir-historical-runtime-reconstruction.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Measured from f95d8a0bf318e857d981863b1018a9d776483a46, source-qualified:
// the two distinct RuntimeFeature declarations must never share a name-only
// lookup. No historical Git object is needed when this suite runs.
// The parent-supplied host schema is mandatory; do not skip on this worker's
// deliberately uncomposed base. Full boundary and source replay gates are
// separately owned by the parent.

const movedReceipts = [
  {
    path: "src/runtime/contracts/async-provider-schema.ts",
    oldPath: "src/ir/async-runtime-providers.ts",
    names: [
      "ASYNC_HOST_CAPABILITY_IDS",
      "AsyncHostCapabilityId",
      "AsyncHostAdapterValueType",
      "ASYNC_CALLBACK_EXCEPTION_POLICY",
      "AsyncCallbackExceptionPolicy",
      "AsyncHostAdapter",
      "PreparedAsyncHostCapabilityId",
      "PreparedAsyncHostAdapter",
      "ASYNC_RUNTIME_PROVIDER_IDS",
      "AsyncRuntimeProviderId",
    ],
    types: 7,
    hash: "b7a151c5853157c9aa74a5f56b446ab30483cdfa9942b78f5964d795bb90afb3",
  },
  {
    path: "src/runtime/contracts/provider-policy.ts",
    oldPath: "src/ir/runtime-manifest.ts",
    names: [
      "RuntimeTarget",
      "RuntimeBackend",
      "NumberBoundaryPolicy",
      "NUMBER_BOUNDARY_POLICY_DISABLED",
      "BooleanBoundaryPolicy",
      "BOOLEAN_BOUNDARY_POLICY_DISABLED",
      "ExternIsUndefinedPolicy",
      "EXTERN_IS_UNDEFINED_POLICY_DISABLED",
      "GeneratorNumberBoxPolicy",
      "GENERATOR_NUMBER_BOX_POLICY_DISABLED",
      "StringComparePolicy",
      "STRING_COMPARE_POLICY_DISABLED",
      "StringEqPolicy",
      "STRING_EQ_POLICY_DISABLED",
      "StringLenPolicy",
      "STRING_LEN_POLICY_DISABLED",
      "StringConcatPolicy",
      "STRING_CONCAT_POLICY_DISABLED",
      "StringCharCodeAtPolicy",
      "STRING_CHAR_CODE_AT_POLICY_DISABLED",
      "StringConcatManyPolicy",
      "STRING_CONCAT_MANY_POLICY_DISABLED",
      "StringConstPolicy",
      "STRING_CONST_POLICY_DISABLED",
      "HostCallbackWrapPolicy",
      "HOST_CALLBACK_WRAP_POLICY_DISABLED",
      "FunctionPrototypeCallPolicy",
      "FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED",
      "RuntimeManifestPolicy",
      "FrozenRuntimeManifestPolicy",
    ],
    types: 17,
    hash: "427cef6e60b0e3328fc6ace4a66eabab7afa466ca917e389101f74b892f8c678",
  },
  {
    path: "src/ir/runtime/contracts/intrinsics.ts",
    oldPath: "src/ir/intrinsics.ts",
    names: [
      "PURE_MATH_RUNTIME_FEATURES",
      "NUMERIC_COERCION_RUNTIME_FEATURES",
      "NUMBER_BOUNDARY_RUNTIME_FEATURES",
      "BOOLEAN_BOUNDARY_RUNTIME_FEATURES",
      "EXTERN_BOUNDARY_RUNTIME_FEATURES",
      "INTRINSIC_RUNTIME_FEATURES",
      "PureMathRuntimeFeature",
      "NumericCoercionRuntimeFeature",
      "NumberBoundaryRuntimeFeature",
      "BooleanBoundaryRuntimeFeature",
      "ExternBoundaryRuntimeFeature",
      "RuntimeFeature",
      "PURE_MATH_HOST_CAPABILITIES",
      "HostCapability",
      "IntrinsicSignature",
      "IntrinsicSourceLocation",
      "IntrinsicUse",
      "IntrinsicDefinition",
      "IntrinsicVerificationCode",
      "IntrinsicVerificationFailure",
    ],
    types: 13,
    hash: "3e3c8fd145f03837dce98ce6b364fabddb88cc98bcc9281304a8a48da009b3f9",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    oldPath: "src/ir/runtime-manifest.ts",
    names: [
      "RuntimeFeature",
      "HostCapabilityId",
      "RUNTIME_BACKEND_REQUIREMENTS",
      "RuntimeBackendRequirement",
      "PURE_MATH_RUNTIME_PROVIDER_IDS",
      "MathRuntimeProviderId",
      "NUMERIC_COERCION_RUNTIME_PROVIDER_IDS",
      "NumericCoercionRuntimeProviderId",
      "NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS",
      "NumberBoundaryRuntimeProviderId",
      "BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS",
      "BooleanBoundaryRuntimeProviderId",
      "EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS",
      "ExternBoundaryRuntimeProviderId",
      "GENERATOR_NUMBER_BOX_RUNTIME_FEATURES",
      "GeneratorNumberBoxRuntimeFeature",
      "GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS",
      "GeneratorNumberBoxRuntimeProviderId",
      "STRING_COMPARE_RUNTIME_FEATURES",
      "StringCompareRuntimeFeature",
      "STRING_COMPARE_RUNTIME_PROVIDER_IDS",
      "StringCompareRuntimeProviderId",
      "STRING_EQ_RUNTIME_FEATURES",
      "StringEqRuntimeFeature",
      "STRING_EQ_RUNTIME_PROVIDER_IDS",
      "StringEqRuntimeProviderId",
      "STRING_LEN_RUNTIME_FEATURES",
      "StringLenRuntimeFeature",
      "STRING_LEN_RUNTIME_PROVIDER_IDS",
      "StringLenRuntimeProviderId",
      "STRING_CONCAT_RUNTIME_FEATURES",
      "StringConcatRuntimeFeature",
      "STRING_CONCAT_RUNTIME_PROVIDER_IDS",
      "StringConcatRuntimeProviderId",
      "STRING_CHAR_CODE_AT_RUNTIME_FEATURES",
      "StringCharCodeAtRuntimeFeature",
      "STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS",
      "StringCharCodeAtRuntimeProviderId",
      "STRING_CONCAT_MANY_RUNTIME_FEATURES",
      "StringConcatManyRuntimeFeature",
      "STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS",
      "StringConcatManyRuntimeProviderId",
      "STRING_CONCAT_MANY_NATIVE_ARITY",
      "STRING_CONST_RUNTIME_FEATURES",
      "StringConstRuntimeFeature",
      "STRING_CONST_RUNTIME_PROVIDER_IDS",
      "StringConstRuntimeProviderId",
      "HOST_CALLBACK_WRAP_RUNTIME_FEATURES",
      "HostCallbackWrapRuntimeFeature",
      "HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS",
      "HostCallbackWrapRuntimeProviderId",
      "FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES",
      "FunctionPrototypeCallRuntimeFeature",
      "FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS",
      "FunctionPrototypeCallRuntimeProviderId",
      "REFERENCE_ERROR_RUNTIME_FEATURES",
      "ReferenceErrorRuntimeFeature",
      "REFERENCE_ERROR_RUNTIME_PROVIDER_IDS",
      "ReferenceErrorRuntimeProviderId",
      "RuntimeProviderId",
      "RuntimeProviderImplementation",
      "MathRuntimeProviderImplementation",
      "IntrinsicRuntimeProviderImplementation",
      "RuntimeProviderDefinition",
      "RuntimeProviderPlan",
      "RuntimeProviderComponent",
      "FrozenRuntimeManifest",
    ],
    types: 38,
    hash: "e7d1bd5d610126b6dcf945ca5584114b21a779b2803139c357f146cb7a16841e",
  },
  {
    path: "src/ir/runtime/contracts/prepared.ts",
    oldPath: "src/ir/async-plan.ts",
    names: [
      "PreparedIrFunction",
      "PreparedIrModule",
      "PreparedIrAsyncHostAdapter",
      "PreparedIrAsyncRuntimeBase",
      "PreparedIrAsyncRuntime",
      "CurrentPreparedIrAsyncRuntime",
      "PreparedIrAsyncRuntimeInput",
      "PreparedIrRuntimeManifest",
    ],
    types: 8,
    hash: "0481da5a024eb65b509ee9d5e6bbf6325e2ad273e741dcfd4aa713859f6525fa",
  },
] as const;

const retainedReceipts = [
  {
    path: "src/ir/async-runtime-providers.ts",
    declarations: 26,
    functions: 12,
    hash: "e6c4a6e91bf4878715ef9b508342a42f7bd692c7bb8ca32fb33568be13635045",
  },
  {
    path: "src/ir/runtime-manifest.ts",
    declarations: 85,
    functions: 38,
    hash: "3abe53cac71f94ed08ab1c9de8f44bfcc6ca0c254f7d6963bb50e8b572a6f478",
  },
  {
    path: "src/ir/intrinsics.ts",
    declarations: 24,
    functions: 5,
    hash: "eee3f92b352fb705c5addda7f396ce665c329ab53e501cfe1f6d7e0fbd93291f",
  },
  {
    path: "src/ir/async-plan.ts",
    declarations: 48,
    functions: 39,
    hash: "a7aada275dcd9af1111649c58a4fcce678cd018d6b458f431edcf9eb6e61ab77",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    declarations: 41,
    functions: 24,
    hash: "eea4525b21f65d7334af27e6ee195dbbb7ca39b9dd57d5781345b80d60d2e8d7",
  },
] as const;

function parse(path: string, source = read(path)) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  expect((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  return file;
}

function declarationName(node: ts.Statement): string | undefined {
  if (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  )
    return node.name?.text;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText();
}

function declarationRows(file: ts.SourceFile, normalizePrepared = false) {
  return file.statements
    .filter((node) => declarationName(node))
    .map((node) => {
      const name = declarationName(node)!;
      let text = node.getText();
      if (normalizePrepared && name === "PreparedIrAsyncRuntimeInput") {
        // Explicitly approved module-only export for the retained implementation.
        expect(text.startsWith("export type ")).toBe(true);
        text = text.replace(/^export /, "");
      }
      if (normalizePrepared && name === "PreparedIrRuntimeManifest") {
        // The old IrFunction import already meant this exact prepared extension.
        expect(text).toContain("readonly functions: readonly PreparedIrFunction[];");
        text = text.replace("readonly PreparedIrFunction[]", "readonly IrFunction[]");
      }
      return [name, (node as ts.Statement & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.at(-1)?.getText() ?? "", text];
    });
}

const valueModules: Readonly<
  Record<
    string,
    {
      readonly canonical: Readonly<Record<string, unknown>>;
      readonly historical: Readonly<Record<string, unknown>>;
      readonly barrel: Readonly<Record<string, unknown>>;
    }
  >
> = {
  "src/runtime/contracts/async-provider-schema.ts": {
    canonical: asyncSchema,
    historical: oldAsync,
    barrel: foundation,
  },
  "src/runtime/contracts/provider-policy.ts": {
    canonical: policy,
    historical: oldManifest,
    barrel: foundation,
  },
  "src/ir/runtime/contracts/intrinsics.ts": {
    canonical: intrinsicSchema,
    historical: oldIntrinsics,
    barrel: runtimeContracts,
  },
  "src/ir/runtime/contracts/manifest.ts": {
    canonical: manifestSchema,
    historical: oldManifest,
    barrel: runtimeContracts,
  },
};
const valueCases = movedReceipts.flatMap((receipt) =>
  receipt.names.filter((name) => name === name.toUpperCase()).map((name) => ({ path: receipt.path, name })),
);

const identities = createTestIrFunctionIdentityFactory("runtime-data-contract-seam");
function authenticatedFixture() {
  const identity = identities.next("resolveNumber"),
    value = asValueId(0),
    f64 = irVal({ kind: "f64" });
  const plan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: identity.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(f64),
    entry: asAsyncStateId(0),
    params: [{ value, type: f64 }],
    values: [{ value, type: f64 }],
    spills: [],
    handlers: [],
    states: [{ id: asAsyncStateId(0), body: [], terminator: { kind: "resolve", value } }],
    runtimeIntents: oldAsync.ASYNC_RUNTIME_FEATURES,
  });
  const builder = new oldManifest.RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
  for (const feature of plan.runtimeIntents) builder.requestFeature(feature);
  const manifest = builder.freeze();
  const providers = Object.freeze(
    manifest.providers.filter((provider) => plan.runtimeIntents.some((intent) => intent === provider.feature)),
  );
  const input: PreparedIrAsyncRuntimeInput = {
    kind: "standalone-native-wasmgc",
    plan,
    manifest,
    providers,
    backendRequirements: oldManifest.projectRuntimeBackendRequirements(providers),
    states: plan.states,
    adapters: Object.freeze([] as const),
  };
  const runtime: CurrentPreparedIrAsyncRuntime = createPreparedIrAsyncRuntime(input);
  const current = (attachment: PreparedIrAsyncRuntime = runtime) =>
    assertPreparedIrAsyncRuntimeCurrent(identity.unitId, identity.name, plan, attachment);
  return { identity, plan, manifest, providers, input, runtime, current };
}

describe("#3518 canonical runtime data-contract seam", () => {
  it.each(movedReceipts)("checks historical $path receipt after checked extension reconstruction", (receipt) => {
    const reconstructed =
      receipt.path === "src/ir/runtime/contracts/intrinsics.ts" ||
      receipt.path === "src/ir/runtime/contracts/manifest.ts"
        ? acceptedHistoricalDeclarations(receipt.path, read)
        : undefined;
    const file = reconstructed
        ? parse(receipt.path, reconstructed.map((row) => (row.doc ? row.doc + "\n" : "") + row.text).join("\n\n"))
        : parse(receipt.path),
      rows = declarationRows(file, receipt.path.endsWith("/prepared.ts"));
    expect(rows.map(([name]) => name)).toEqual(receipt.names);
    expect(
      file.statements.filter((node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)),
    ).toHaveLength(receipt.types);
    expect(hash(rows)).toBe(receipt.hash);
    expect(file.statements.filter(ts.isFunctionDeclaration)).toHaveLength(0);
    // Real-row positive controls: removal, rename, text/field changes and
    // documentation changes all break the measured declaration receipt.
    expect(rows.length).toBeGreaterThan(0);
    expect(hash(rows.slice(1))).not.toBe(receipt.hash);
    expect(hash(rows.map((row, index) => (index ? row : ["renamed", ...row.slice(1)])))).not.toBe(receipt.hash);
    expect(hash(rows.map((row, index) => (index ? row : [row[0], row[1], row[2] + "\nchanged"])))).not.toBe(
      receipt.hash,
    );
    expect(hash(rows.map((row, index) => (index ? row : [row[0], row[1] + "\nchanged", row[2]])))).not.toBe(
      receipt.hash,
    );
  });

  it.each(retainedReceipts)(
    "checks historical retained $path receipt after checked extension reconstruction",
    (receipt) => {
      const records = acceptedHistoricalDeclarations(receipt.path, read),
        rows = receiptRows(records);
      expect(rows).toHaveLength(receipt.declarations);
      expect(records.filter((record) => ts.isFunctionDeclaration(record.node))).toHaveLength(receipt.functions);
      expect(hash(rows)).toBe(receipt.hash);
      expect(hash(rows.slice(1))).not.toBe(receipt.hash);
      expect(read(receipt.path).match(/Copyright \(c\) 2026 Loopdive/g)).toHaveLength(1);
    },
  );

  it("keeps the complete moved/retained denominators and the one currentness authority", () => {
    expect(movedReceipts.reduce((count, receipt) => count + receipt.names.length, 0)).toBe(135);
    expect(retainedReceipts.reduce((count, receipt) => count + receipt.declarations, 0)).toBe(224);
    expect(retainedReceipts.reduce((count, receipt) => count + receipt.functions, 0)).toBe(118);
    expect(valueCases).toHaveLength(52);
    const old = parse("src/ir/async-plan.ts");
    const historical = acceptedHistoricalDeclarations("src/ir/async-plan.ts", read);
    expect(historical.filter((row) => ts.isFunctionDeclaration(row.node))).toHaveLength(39);
    const authority = currentDeclarations("src/ir/runtime/async-attachment.ts", read);
    expect(authority.filter((row) => row.name === "preparedManifestByPlan")).toHaveLength(1);
    expect(read("src/ir/runtime/async-attachment.ts").match(/new WeakMap/g)).toHaveLength(1);
    for (const path of ["src/ir/async-plan.ts", "src/ir/analysis/async-plan.ts"]) {
      expect(read(path)).not.toContain("new WeakMap");
      expect(declarationRows(parse(path)).some(([name]) => name === "preparedManifestByPlan")).toBe(false);
    }
    expect(read("src/ir/analysis/async-plan.ts").match(/Backend-neutral async suspension plan\./g)).toHaveLength(1);
    expect(read("src/ir/runtime/manifest.ts").match(/Deterministic R6 semantic-runtime manifest/g)).toHaveLength(1);
    for (const receipt of movedReceipts) {
      expect(read(receipt.path)).not.toContain("new WeakMap");
    }
    const prepared = parse("src/ir/runtime/contracts/prepared.ts");
    const base = prepared.statements.find((node) => declarationName(node) === "PreparedIrAsyncRuntimeBase");
    expect(base && ts.isInterfaceDeclaration(base)).toBe(true);
    if (!base || !ts.isInterfaceDeclaration(base)) throw Error("missing private base");
    expect(base.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(false);
    const legacyExports = old.statements
      .filter(ts.isExportDeclaration)
      .flatMap((node) =>
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((entry) => entry.name.text)
          : [],
      );
    expect(legacyExports).not.toContain("PreparedIrAsyncRuntimeInput");
    expect(read("src/ir/runtime/index.ts")).not.toContain("PreparedIrAsyncRuntimeInput");
  });

  it.each(movedReceipts)("forwards each $path name only from its exact defining owner", (receipt) => {
    for (const name of receipt.names) {
      if (name === "PreparedIrAsyncRuntimeBase" || name === "PreparedIrAsyncRuntimeInput") continue;
      const oldPath = name === "PreparedIrRuntimeManifest" ? "src/ir/intrinsic-support.ts" : receipt.oldPath;
      const chain = [oldPath];
      if (oldPath === "src/ir/async-runtime-providers.ts") chain.push("src/ir/runtime/async-providers.ts");
      if (oldPath === "src/ir/runtime-manifest.ts") chain.push("src/ir/runtime/manifest.ts");
      chain.push(receipt.path);
      if (
        [
          "IntrinsicSignature",
          "IntrinsicSourceLocation",
          "IntrinsicUse",
          "IntrinsicVerificationCode",
          "IntrinsicVerificationFailure",
        ].includes(name)
      )
        chain.push("src/ir/core/intrinsic-contracts.ts");
      for (let hop = 0; hop < chain.length - 1; hop++)
        assertNamedForward(chain[hop]!, chain[hop + 1]!, name, name !== name.toUpperCase(), read);
      if (name === "IntrinsicDefinition") assertIntrinsicSpecialization(read);
    }
  });

  it.each(valueCases)("retains the same old/canonical/barrel $name object", ({ path, name }) => {
    const modules = valueModules[path];
    if (!modules) throw Error("missing value module " + path);
    const canonical = modules.canonical[name];
    expect(canonical).toBeDefined();
    expect(modules.historical[name]).toBe(canonical);
    expect(modules.barrel[name]).toBe(canonical);
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  it("reuses the canonical callback policy and exact capability/provider catalogs", () => {
    expect(asyncSchema.ASYNC_CALLBACK_EXCEPTION_POLICY).toBe(hostSchema.HOST_CALLBACK_EXCEPTION_POLICY);
    expect(foundation.HOST_CALLBACK_EXCEPTION_POLICY).toBe(hostSchema.HOST_CALLBACK_EXCEPTION_POLICY);
    expect(oldAsync.ASYNC_HOST_CAPABILITY_RECORDS.map((record) => record.capability)).toEqual([
      ...asyncSchema.ASYNC_HOST_CAPABILITY_IDS,
    ]);
    for (const record of oldAsync.ASYNC_HOST_CAPABILITY_RECORDS) {
      expect(oldAsync.resolveAsyncHostCapabilityRecord(oldAsync.ASYNC_HOST_CAPABILITY_RECORDS, record.capability)).toBe(
        record,
      );
    }
    expect(new Set(oldAsync.ASYNC_RUNTIME_PROVIDERS.map((provider) => provider.id))).toEqual(
      new Set(asyncSchema.ASYNC_RUNTIME_PROVIDER_IDS),
    );
    expect(intrinsicSchema.PURE_MATH_RUNTIME_FEATURES).not.toBe(manifestSchema.PURE_MATH_RUNTIME_PROVIDER_IDS);
    expect(manifestSchema.STRING_CONCAT_MANY_NATIVE_ARITY).toEqual({ min: 3, max: 8 });
  });

  it("keeps both barrels explicit and contract-only", () => {
    for (const path of ["src/runtime/contracts/index.ts", "src/ir/runtime/index.ts"]) {
      const file = parse(path);
      expect(file.statements.length).toBeGreaterThan(0);
      for (const node of file.statements) {
        expect(ts.isExportDeclaration(node)).toBe(true);
        if (!ts.isExportDeclaration(node)) throw Error("barrel contains implementation");
        expect(node.exportClause && ts.isNamedExports(node.exportClause)).toBe(true);
        expect(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
        if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) throw Error("missing barrel target");
        expect(node.moduleSpecifier.text.startsWith("./")).toBe(true);
        expect(node.moduleSpecifier.text).not.toMatch(/\.\.\/|async-plan|runtime-manifest|intrinsic-support/);
      }
    }
    expect(Object.keys(runtimeContracts).sort()).toEqual(
      valueCases
        .filter((entry) => entry.path.startsWith("src/ir/"))
        .map((entry) => entry.name)
        .sort(),
    );
    const foundationNames = [
      ...Object.keys(hostSchema),
      ...valueCases.filter((entry) => entry.path.startsWith("src/runtime/")).map((entry) => entry.name),
    ].sort();
    expect(Object.keys(foundation).sort()).toEqual(foundationNames);
    for (const receipt of movedReceipts) {
      const file = parse(receipt.path);
      for (const node of file.statements.filter(ts.isImportDeclaration)) {
        const module = node.moduleSpecifier;
        if (!ts.isStringLiteral(module)) throw Error("nonliteral static import");
        expect(module.text).not.toMatch(
          /async-runtime-providers|runtime-host-capabilities|runtime-manifest|intrinsic-support|program|codegen/,
        );
      }
    }
  });

  it("preserves standalone authentication, exact provider order and seal identity", () => {
    const { plan, manifest, providers, runtime, current } = authenticatedFixture();
    expect(providers).toHaveLength(7);
    expect(providers.every((provider) => manifest.providers.includes(provider))).toBe(true);
    expect(runtime.providers).toBe(providers);
    expect(runtime.plan).toBe(plan);
    expect(runtime.manifest).toBe(manifest);
    expect(current()).toBe(runtime);
    expect(sealPreparedIrAsyncRuntimeContainers(runtime)).toBe(runtime);
    expect(runtime.kind).toBe("standalone-native-wasmgc");
    expect(runtime.adapters).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    const serialized = serializeIrAsyncPlan(plan);
    expect(serializeIrAsyncPlan(plan)).toBe(serialized);
  });

  it("rejects a copied manifest or semantic plan instead of granting shape-based authority", () => {
    const { identity, plan, manifest, runtime, current } = authenticatedFixture();
    expect(() => current(Object.freeze({ ...runtime, manifest: Object.freeze({ ...manifest }) }))).toThrow(
      /authenticated frozen manifest/,
    );
    const copiedPlan = createIrAsyncPlan(plan);
    expect(copiedPlan).not.toBe(plan);
    expect(serializeIrAsyncPlan(copiedPlan)).toBe(serializeIrAsyncPlan(plan));
    expect(() =>
      assertPreparedIrAsyncRuntimeCurrent(
        identity.unitId,
        identity.name,
        copiedPlan,
        Object.freeze({ ...runtime, plan: copiedPlan }),
      ),
    ).toThrow(/authenticated frozen manifest/);
  });

  it("rejects copied/reordered providers and mutable layouts while retaining logical-type identity when sealed", () => {
    const { plan, runtime, current } = authenticatedFixture();
    const copiedProviders = Object.freeze(runtime.providers.map((provider) => Object.freeze({ ...provider })));
    expect(() => current(Object.freeze({ ...runtime, providers: copiedProviders }))).toThrow(/exact providers/);
    expect(() =>
      current(Object.freeze({ ...runtime, providers: Object.freeze([...runtime.providers].reverse()) })),
    ).toThrow(/exact providers/);
    // A copy-on-write envelope is not itself authority. The original plan /
    // manifest / provider joins remain the validator's source of truth.
    const logicalType = plan.values[0]!.type;
    const typeRef = (ordinal: number): IrTypeRef => ({
      kind: "type",
      name: "layout-" + ordinal,
      binding: {
        kind: "support",
        bindingId: createIrBindingId({
          ownerId: plan.ownerUnitId,
          domain: "type",
          role: "runtime-contract-layout",
          ordinal,
        }),
      },
    });
    const layout: IrVecLayoutRef = {
      carrierType: typeRef(0),
      dataType: typeRef(1),
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    };
    const updated = { ...runtime, typeLayouts: [{ logicalType, layout }] };
    expect(() => current(updated)).toThrow(/mutable attachment/);
    const sealed = sealPreparedIrAsyncRuntimeContainers(updated);
    expect(sealed.typeLayouts?.[0]?.logicalType).toBe(logicalType);
    expect(sealed.typeLayouts?.[0]?.layout).toBe(layout);
    expect(current(sealed)).toBe(sealed);
    expect(sealPreparedIrAsyncRuntimeContainers(sealed)).toBe(sealed);
  });

  it("retains failed-authentication rollback without publishing a second authority", () => {
    const { input } = authenticatedFixture();
    const plan = createIrAsyncPlan(input.plan);
    const valid: PreparedIrAsyncRuntimeInput = { ...input, plan };
    expect(() => createPreparedIrAsyncRuntime({ ...valid, providers: Object.freeze([]) })).toThrow(/exact providers/);
    const runtime = createPreparedIrAsyncRuntime(valid);
    expect(assertPreparedIrAsyncRuntimeCurrent(plan.ownerUnitId, "rollback", plan, runtime)).toBe(runtime);
    expect(() => createPreparedIrAsyncRuntime({ ...valid, manifest: Object.freeze({ ...valid.manifest }) })).toThrow(
      /already attached to another frozen manifest/,
    );
  });
});

describe("#3518 compiled runtime data joins", () => {
  it("resolves all 81 public old/new types, canonical joins and eleven negative controls", () => {
    const filename = resolve(root, ".tmp/runtime-data-type-contract.ts");
    const source = [
      "import type * as Prepared from '../src/ir/runtime/contracts/prepared.js';",
      "import type * as Runtime from '../src/ir/runtime/index.js';",
      "import type * as Core from '../src/ir/core/nodes.js';",
      "import type * as CoreTypes from '../src/ir/core/types.js';",
      "import type * as OldPrepared from '../src/ir/async-plan.js';",
      "import type * as OldSupport from '../src/ir/intrinsic-support.js';",
      "import type * as Host from '../src/runtime/contracts/host-capability-schema.js';",
      "import type * as Foundation from '../src/runtime/contracts/index.js';",
      "type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
      "type Check<T extends true> = T;",
      "import type * as Old0 from '../src/ir/async-runtime-providers.js';",
      "import type * as New0 from '../src/runtime/contracts/async-provider-schema.js';",
      "type Match0_AsyncHostCapabilityId = Check<Equal<Old0.AsyncHostCapabilityId, New0.AsyncHostCapabilityId>>;",
      "type Match0_AsyncHostAdapterValueType = Check<Equal<Old0.AsyncHostAdapterValueType, New0.AsyncHostAdapterValueType>>;",
      "type Match0_AsyncCallbackExceptionPolicy = Check<Equal<Old0.AsyncCallbackExceptionPolicy, New0.AsyncCallbackExceptionPolicy>>;",
      "type Match0_AsyncHostAdapter = Check<Equal<Old0.AsyncHostAdapter, New0.AsyncHostAdapter>>;",
      "type Match0_PreparedAsyncHostCapabilityId = Check<Equal<Old0.PreparedAsyncHostCapabilityId, New0.PreparedAsyncHostCapabilityId>>;",
      "type Match0_PreparedAsyncHostAdapter = Check<Equal<Old0.PreparedAsyncHostAdapter, New0.PreparedAsyncHostAdapter>>;",
      "type Match0_AsyncRuntimeProviderId = Check<Equal<Old0.AsyncRuntimeProviderId, New0.AsyncRuntimeProviderId>>;",
      "import type * as Old1 from '../src/ir/runtime-manifest.js';",
      "import type * as New1 from '../src/runtime/contracts/provider-policy.js';",
      "type Match1_RuntimeTarget = Check<Equal<Old1.RuntimeTarget, New1.RuntimeTarget>>;",
      "type Match1_RuntimeBackend = Check<Equal<Old1.RuntimeBackend, New1.RuntimeBackend>>;",
      "type Match1_NumberBoundaryPolicy = Check<Equal<Old1.NumberBoundaryPolicy, New1.NumberBoundaryPolicy>>;",
      "type Match1_BooleanBoundaryPolicy = Check<Equal<Old1.BooleanBoundaryPolicy, New1.BooleanBoundaryPolicy>>;",
      "type Match1_ExternIsUndefinedPolicy = Check<Equal<Old1.ExternIsUndefinedPolicy, New1.ExternIsUndefinedPolicy>>;",
      "type Match1_GeneratorNumberBoxPolicy = Check<Equal<Old1.GeneratorNumberBoxPolicy, New1.GeneratorNumberBoxPolicy>>;",
      "type Match1_StringComparePolicy = Check<Equal<Old1.StringComparePolicy, New1.StringComparePolicy>>;",
      "type Match1_StringEqPolicy = Check<Equal<Old1.StringEqPolicy, New1.StringEqPolicy>>;",
      "type Match1_StringLenPolicy = Check<Equal<Old1.StringLenPolicy, New1.StringLenPolicy>>;",
      "type Match1_StringConcatPolicy = Check<Equal<Old1.StringConcatPolicy, New1.StringConcatPolicy>>;",
      "type Match1_StringCharCodeAtPolicy = Check<Equal<Old1.StringCharCodeAtPolicy, New1.StringCharCodeAtPolicy>>;",
      "type Match1_StringConcatManyPolicy = Check<Equal<Old1.StringConcatManyPolicy, New1.StringConcatManyPolicy>>;",
      "type Match1_StringConstPolicy = Check<Equal<Old1.StringConstPolicy, New1.StringConstPolicy>>;",
      "type Match1_HostCallbackWrapPolicy = Check<Equal<Old1.HostCallbackWrapPolicy, New1.HostCallbackWrapPolicy>>;",
      "type Match1_FunctionPrototypeCallPolicy = Check<Equal<Old1.FunctionPrototypeCallPolicy, New1.FunctionPrototypeCallPolicy>>;",
      "type Match1_RuntimeManifestPolicy = Check<Equal<Old1.RuntimeManifestPolicy, New1.RuntimeManifestPolicy>>;",
      "type Match1_FrozenRuntimeManifestPolicy = Check<Equal<Old1.FrozenRuntimeManifestPolicy, New1.FrozenRuntimeManifestPolicy>>;",
      "import type * as Old2 from '../src/ir/intrinsics.js';",
      "import type * as New2 from '../src/ir/runtime/contracts/intrinsics.js';",
      "type Match2_PureMathRuntimeFeature = Check<Equal<Old2.PureMathRuntimeFeature, New2.PureMathRuntimeFeature>>;",
      "type Match2_NumericCoercionRuntimeFeature = Check<Equal<Old2.NumericCoercionRuntimeFeature, New2.NumericCoercionRuntimeFeature>>;",
      "type Match2_NumberBoundaryRuntimeFeature = Check<Equal<Old2.NumberBoundaryRuntimeFeature, New2.NumberBoundaryRuntimeFeature>>;",
      "type Match2_BooleanBoundaryRuntimeFeature = Check<Equal<Old2.BooleanBoundaryRuntimeFeature, New2.BooleanBoundaryRuntimeFeature>>;",
      "type Match2_ExternBoundaryRuntimeFeature = Check<Equal<Old2.ExternBoundaryRuntimeFeature, New2.ExternBoundaryRuntimeFeature>>;",
      "type Match2_RuntimeFeature = Check<Equal<Old2.RuntimeFeature, New2.RuntimeFeature>>;",
      "type Match2_HostCapability = Check<Equal<Old2.HostCapability, New2.HostCapability>>;",
      "type Match2_IntrinsicSignature = Check<Equal<Old2.IntrinsicSignature, New2.IntrinsicSignature>>;",
      "type Match2_IntrinsicSourceLocation = Check<Equal<Old2.IntrinsicSourceLocation, New2.IntrinsicSourceLocation>>;",
      "type Match2_IntrinsicUse = Check<Equal<Old2.IntrinsicUse, New2.IntrinsicUse>>;",
      "type Match2_IntrinsicDefinition = Check<Equal<Old2.IntrinsicDefinition, New2.IntrinsicDefinition>>;",
      "type Match2_IntrinsicVerificationCode = Check<Equal<Old2.IntrinsicVerificationCode, New2.IntrinsicVerificationCode>>;",
      "type Match2_IntrinsicVerificationFailure = Check<Equal<Old2.IntrinsicVerificationFailure, New2.IntrinsicVerificationFailure>>;",
      "import type * as Old3 from '../src/ir/runtime-manifest.js';",
      "import type * as New3 from '../src/ir/runtime/contracts/manifest.js';",
      "type Match3_RuntimeFeature = Check<Equal<Old3.RuntimeFeature, New3.RuntimeFeature>>;",
      "type Match3_HostCapabilityId = Check<Equal<Old3.HostCapabilityId, New3.HostCapabilityId>>;",
      "type Match3_RuntimeBackendRequirement = Check<Equal<Old3.RuntimeBackendRequirement, New3.RuntimeBackendRequirement>>;",
      "type Match3_MathRuntimeProviderId = Check<Equal<Old3.MathRuntimeProviderId, New3.MathRuntimeProviderId>>;",
      "type Match3_NumericCoercionRuntimeProviderId = Check<Equal<Old3.NumericCoercionRuntimeProviderId, New3.NumericCoercionRuntimeProviderId>>;",
      "type Match3_NumberBoundaryRuntimeProviderId = Check<Equal<Old3.NumberBoundaryRuntimeProviderId, New3.NumberBoundaryRuntimeProviderId>>;",
      "type Match3_BooleanBoundaryRuntimeProviderId = Check<Equal<Old3.BooleanBoundaryRuntimeProviderId, New3.BooleanBoundaryRuntimeProviderId>>;",
      "type Match3_ExternBoundaryRuntimeProviderId = Check<Equal<Old3.ExternBoundaryRuntimeProviderId, New3.ExternBoundaryRuntimeProviderId>>;",
      "type Match3_GeneratorNumberBoxRuntimeFeature = Check<Equal<Old3.GeneratorNumberBoxRuntimeFeature, New3.GeneratorNumberBoxRuntimeFeature>>;",
      "type Match3_GeneratorNumberBoxRuntimeProviderId = Check<Equal<Old3.GeneratorNumberBoxRuntimeProviderId, New3.GeneratorNumberBoxRuntimeProviderId>>;",
      "type Match3_StringCompareRuntimeFeature = Check<Equal<Old3.StringCompareRuntimeFeature, New3.StringCompareRuntimeFeature>>;",
      "type Match3_StringCompareRuntimeProviderId = Check<Equal<Old3.StringCompareRuntimeProviderId, New3.StringCompareRuntimeProviderId>>;",
      "type Match3_StringEqRuntimeFeature = Check<Equal<Old3.StringEqRuntimeFeature, New3.StringEqRuntimeFeature>>;",
      "type Match3_StringEqRuntimeProviderId = Check<Equal<Old3.StringEqRuntimeProviderId, New3.StringEqRuntimeProviderId>>;",
      "type Match3_StringLenRuntimeFeature = Check<Equal<Old3.StringLenRuntimeFeature, New3.StringLenRuntimeFeature>>;",
      "type Match3_StringLenRuntimeProviderId = Check<Equal<Old3.StringLenRuntimeProviderId, New3.StringLenRuntimeProviderId>>;",
      "type Match3_StringConcatRuntimeFeature = Check<Equal<Old3.StringConcatRuntimeFeature, New3.StringConcatRuntimeFeature>>;",
      "type Match3_StringConcatRuntimeProviderId = Check<Equal<Old3.StringConcatRuntimeProviderId, New3.StringConcatRuntimeProviderId>>;",
      "type Match3_StringCharCodeAtRuntimeFeature = Check<Equal<Old3.StringCharCodeAtRuntimeFeature, New3.StringCharCodeAtRuntimeFeature>>;",
      "type Match3_StringCharCodeAtRuntimeProviderId = Check<Equal<Old3.StringCharCodeAtRuntimeProviderId, New3.StringCharCodeAtRuntimeProviderId>>;",
      "type Match3_StringConcatManyRuntimeFeature = Check<Equal<Old3.StringConcatManyRuntimeFeature, New3.StringConcatManyRuntimeFeature>>;",
      "type Match3_StringConcatManyRuntimeProviderId = Check<Equal<Old3.StringConcatManyRuntimeProviderId, New3.StringConcatManyRuntimeProviderId>>;",
      "type Match3_StringConstRuntimeFeature = Check<Equal<Old3.StringConstRuntimeFeature, New3.StringConstRuntimeFeature>>;",
      "type Match3_StringConstRuntimeProviderId = Check<Equal<Old3.StringConstRuntimeProviderId, New3.StringConstRuntimeProviderId>>;",
      "type Match3_HostCallbackWrapRuntimeFeature = Check<Equal<Old3.HostCallbackWrapRuntimeFeature, New3.HostCallbackWrapRuntimeFeature>>;",
      "type Match3_HostCallbackWrapRuntimeProviderId = Check<Equal<Old3.HostCallbackWrapRuntimeProviderId, New3.HostCallbackWrapRuntimeProviderId>>;",
      "type Match3_FunctionPrototypeCallRuntimeFeature = Check<Equal<Old3.FunctionPrototypeCallRuntimeFeature, New3.FunctionPrototypeCallRuntimeFeature>>;",
      "type Match3_FunctionPrototypeCallRuntimeProviderId = Check<Equal<Old3.FunctionPrototypeCallRuntimeProviderId, New3.FunctionPrototypeCallRuntimeProviderId>>;",
      "type Match3_ReferenceErrorRuntimeFeature = Check<Equal<Old3.ReferenceErrorRuntimeFeature, New3.ReferenceErrorRuntimeFeature>>;",
      "type Match3_ReferenceErrorRuntimeProviderId = Check<Equal<Old3.ReferenceErrorRuntimeProviderId, New3.ReferenceErrorRuntimeProviderId>>;",
      "type Match3_RuntimeProviderId = Check<Equal<Old3.RuntimeProviderId, New3.RuntimeProviderId>>;",
      "type Match3_RuntimeProviderImplementation = Check<Equal<Old3.RuntimeProviderImplementation, New3.RuntimeProviderImplementation>>;",
      "type Match3_MathRuntimeProviderImplementation = Check<Equal<Old3.MathRuntimeProviderImplementation, New3.MathRuntimeProviderImplementation>>;",
      "type Match3_IntrinsicRuntimeProviderImplementation = Check<Equal<Old3.IntrinsicRuntimeProviderImplementation, New3.IntrinsicRuntimeProviderImplementation>>;",
      "type Match3_RuntimeProviderDefinition = Check<Equal<Old3.RuntimeProviderDefinition, New3.RuntimeProviderDefinition>>;",
      "type Match3_RuntimeProviderPlan = Check<Equal<Old3.RuntimeProviderPlan, New3.RuntimeProviderPlan>>;",
      "type Match3_RuntimeProviderComponent = Check<Equal<Old3.RuntimeProviderComponent, New3.RuntimeProviderComponent>>;",
      "type Match3_FrozenRuntimeManifest = Check<Equal<Old3.FrozenRuntimeManifest, New3.FrozenRuntimeManifest>>;",
      "import type * as Old4 from '../src/ir/async-plan.js';",
      "import type * as New4 from '../src/ir/runtime/contracts/prepared.js';",
      "type Match4_PreparedIrFunction = Check<Equal<Old4.PreparedIrFunction, New4.PreparedIrFunction>>;",
      "type Match4_PreparedIrModule = Check<Equal<Old4.PreparedIrModule, New4.PreparedIrModule>>;",
      "type Match4_PreparedIrAsyncHostAdapter = Check<Equal<Old4.PreparedIrAsyncHostAdapter, New4.PreparedIrAsyncHostAdapter>>;",
      "type Match4_PreparedIrAsyncRuntime = Check<Equal<Old4.PreparedIrAsyncRuntime, New4.PreparedIrAsyncRuntime>>;",
      "type Match4_CurrentPreparedIrAsyncRuntime = Check<Equal<Old4.CurrentPreparedIrAsyncRuntime, New4.CurrentPreparedIrAsyncRuntime>>;",
      "type Match4_PreparedIrRuntimeManifest = Check<Equal<OldSupport.PreparedIrRuntimeManifest, New4.PreparedIrRuntimeManifest>>;",
      "type PreparedFunctions = Check<Equal<Prepared.PreparedIrRuntimeManifest['functions'][number], Prepared.PreparedIrFunction>>;",
      "type PreparedModuleFunctions = Check<Equal<Prepared.PreparedIrModule['functions'][number], Prepared.PreparedIrFunction>>;",
      "type CoreModuleFunctions = Check<Equal<Core.IrModule['functions'][number], Core.IrFunction>>;",
      "type Attachment = Check<Equal<Prepared.PreparedIrFunction['asyncRuntime'], Prepared.PreparedIrAsyncRuntime | undefined>>;",
      "type LayoutIdentity = Check<Equal<NonNullable<Prepared.PreparedIrAsyncRuntime['typeLayouts']>[number]['logicalType'], CoreTypes.IrType>>;",
      "type RuntimeBarrel = Check<Equal<Runtime.PreparedIrRuntimeManifest, Prepared.PreparedIrRuntimeManifest>>;",
      "type IntrinsicFeatureAlias = Check<Equal<Runtime.IntrinsicRuntimeFeature, New2.RuntimeFeature>>;",
      "type CompleteFeatureAlias = Check<Equal<Runtime.RuntimeFeature, New3.RuntimeFeature>>;",
      "type FoundationPolicy = Check<Equal<Foundation.RuntimeManifestPolicy, New1.RuntimeManifestPolicy>>;",
      "type NarrowAsync = Check<Equal<New0.AsyncHostAdapterValueType, 'externref' | 'i32'>>;",
      "type EmptyMathCapabilities = Check<Equal<New2.HostCapability, never>>;",
      "type HostNeverGlobal = Check<Equal<Extract<Host.RuntimeHostCapabilityRecord<'number.box'>, {kind:'global'}>['capability'], never>>;",
      "type NativeAdapters = Check<Equal<Extract<Prepared.PreparedIrAsyncRuntime, {kind:'standalone-native-wasmgc'}>['adapters'], readonly []>>;",
      "declare const fn: Prepared.PreparedIrFunction;",
      "declare const manifest: New3.FrozenRuntimeManifest;",
      "declare const signature: New2.IntrinsicSignature;",
      "declare const input: Prepared.PreparedIrAsyncRuntimeInput;",
      "const optional: Prepared.PreparedIrFunction = {} as Core.IrFunction;",
      "const semantic: Core.IrFunction = fn;",
      "const maybeSignature: New2.IntrinsicSignature | undefined = ({} as New3.RuntimeProviderDefinition).signature;",
      "const currentPlan = input.plan;",
      "// @ts-expect-error semantic core cannot acquire a prepared attachment",
      "semantic.asyncRuntime;",
      "// @ts-expect-error historical API must not expose the formerly private input helper",
      "type HistoricalInputLeak = OldPrepared.PreparedIrAsyncRuntimeInput;",
      "// @ts-expect-error the private runtime base stays private",
      "type BaseLeak = Prepared.PreparedIrAsyncRuntimeBase;",
      "// @ts-expect-error input helper is not part of the contract barrel API",
      "type BarrelInputLeak = Runtime.PreparedIrAsyncRuntimeInput;",
      "// @ts-expect-error async projection cannot widen to f64",
      "const widened: New0.AsyncHostAdapterValueType = 'f64';",
      "// @ts-expect-error frozen provider population remains readonly",
      "manifest.providers.push({} as New3.RuntimeProviderDefinition);",
      "// @ts-expect-error signature result remains readonly",
      "signature.result = {} as CoreTypes.IrType;",
      "// @ts-expect-error signature params remain readonly",
      "signature.params.push({} as CoreTypes.IrType);",
      "// @ts-expect-error a function capability cannot occupy the global provider arm",
      "const badGlobal: New3.RuntimeProviderImplementation = {kind:'host-global', capability:'number.box'};",
      "// @ts-expect-error native runtime cannot acquire host adapters",
      "const badNative: Prepared.PreparedIrAsyncRuntime = {kind:'standalone-native-wasmgc', states:[], adapters:[{} as Prepared.PreparedIrAsyncHostAdapter]};",
      "// @ts-expect-error symbolic callable brands cannot become plain strings",
      "const badTarget: Prepared.PreparedIrAsyncHostAdapter['target'] = 'callable';",
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
      host.getSourceFile = (path, version, onError, fresh) =>
        path === filename
          ? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
          : original(path, version, onError, fresh);
      const program = ts.createProgram([filename], options, host);
      const file = program.getSourceFile(filename);
      if (!file) throw Error("missing checked type fixture");
      // Diagnose the actual imported canonical declarations too: a missing
      // import must not be hidden by a same-shaped historical type alias.
      const canonical = [
        ...movedReceipts.map((receipt) => receipt.path),
        "src/runtime/contracts/host-capability-schema.ts",
        "src/runtime/contracts/index.ts",
        "src/ir/runtime/index.ts",
      ].map((path) => {
        const file = program.getSourceFile(resolve(root, path));
        if (!file) throw Error("missing canonical source " + path);
        return file;
      });
      return [
        ...program.getOptionsDiagnostics(),
        ...[file, ...canonical].flatMap((file) => [
          ...program.getSyntacticDiagnostics(file),
          ...program.getSemanticDiagnostics(file),
        ]),
      ];
    };
    const diagnostics = check(source);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    const rejected = check(source.replaceAll("@ts-expect-error", "negative control"));
    expect(rejected).toHaveLength(11);
    expect(rejected.every((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)).toBe(true);
  }, 60_000);
});
