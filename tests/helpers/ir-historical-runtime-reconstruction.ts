// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";

export type SourceReader = (path: string) => string;
export const liveSourceReader =
  (root: string): SourceReader =>
  (path) =>
    readFileSync(resolve(root, path), "utf8");

// Current source-qualified census, independently pinned before reconstruction.
// Overloads are records too: kind/name/occurrence and source order must agree.
// No discovery, sorting, name search, Git fallback or existence-based omission.
const ownerOrder: Readonly<Record<string, readonly string[]>> = {
  "src/ir/runtime/contracts/intrinsics.ts": [
    "var:PURE_MATH_RUNTIME_FEATURES#0",
    "var:NUMERIC_COERCION_RUNTIME_FEATURES#0",
    "var:NUMBER_BOUNDARY_RUNTIME_FEATURES#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_FEATURES#0",
    "var:EXTERN_BOUNDARY_RUNTIME_FEATURES#0",
    "var:INTRINSIC_RUNTIME_FEATURES#0",
    "type:PureMathRuntimeFeature#0",
    "type:NumericCoercionRuntimeFeature#0",
    "type:NumberBoundaryRuntimeFeature#0",
    "type:BooleanBoundaryRuntimeFeature#0",
    "type:ExternBoundaryRuntimeFeature#0",
    "type:RuntimeFeature#0",
    "var:PURE_MATH_HOST_CAPABILITIES#0",
    "type:HostCapability#0",
    "type:IntrinsicDefinition#0",
  ],
  "src/ir/core/intrinsic-contracts.ts": [
    "interface:IntrinsicSignature#0",
    "interface:IntrinsicSourceLocation#0",
    "interface:IntrinsicUse#0",
    "interface:IntrinsicDefinition#0",
    "type:IntrinsicVerificationCode#0",
    "interface:IntrinsicVerificationFailure#0",
  ],
  "src/ir/core/intrinsics.ts": [
    "var:F64_TYPE#0",
    "var:I32_TYPE#0",
    "var:U32_TYPE#0",
    "var:EXTERNREF_TYPE#0",
    "var:F64_TO_EXTERNREF_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_TO_F64_INTRINSIC_SIGNATURE#0",
    "var:I32_TO_EXTERNREF_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_TO_I32_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE#0",
    "var:REF_EXTERN_TYPE#0",
    "var:EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE#0",
    "var:F64_TO_U32_INTRINSIC_SIGNATURE#0",
    "var:F64_UNARY_INTRINSIC_SIGNATURE#0",
    "var:F64_BINARY_INTRINSIC_SIGNATURE#0",
    "function:definition#0",
    "var:INTRINSIC_DEFINITIONS#0",
    "var:INTRINSIC_ID_SET#0",
    "function:isIntrinsicId#0",
  ],
  "src/ir/analysis/intrinsics.ts": [
    "class:IntrinsicEffectEvidence#0",
    "function:intrinsicEffectEvidence#0",
    "function:signatureMismatch#0",
    "function:verifyIntrinsicUse#0",
    "function:verifyIrIntrinsicSignature#0",
  ],
  "src/ir/core/async-intents.ts": [
    "var:ASYNC_RUNTIME_FEATURES#0",
    "var:ASYNC_OPTIONAL_RUNTIME_FEATURES#0",
    "type:AsyncRuntimeFeature#0",
    "var:ASYNC_RUNTIME_FEATURE_SET#0",
    "function:isAsyncRuntimeFeature#0",
  ],
  "src/ir/runtime/async-providers.ts": [
    "var:ASYNC_HOST_CAPABILITY_ID_SET#0",
    "function:isAsyncHostCapabilityId#0",
    "function:asAsyncHostAdapter#0",
    "var:ASYNC_HOST_CAPABILITY_RECORDS#0",
    "function:assertAsyncHostCapabilityRecord#0",
    "function:assertCanonicalAsyncHostCapabilityRecord#0",
    "function:resolveAsyncHostCapabilityRecord#0",
    "function:isPreparedAsyncHostCapabilityId#0",
    "function:asPreparedAsyncHostAdapter#0",
    "function:assertCanonicalPreparedAsyncHostCapabilityRecord#0",
    "var:ASYNC_HOST_ADAPTERS#0",
    "var:ASYNC_OPTIONAL_HOST_ADAPTERS#0",
    "function:capabilities#0",
    "var:HOST_TARGET#0",
    "var:STANDALONE_TARGET#0",
    "var:WASMGC_BACKEND#0",
    "var:NO_DEPENDENCIES#0",
    "var:NO_HOST_CAPABILITIES#0",
    "var:HOST_CAPABILITY_IMPLEMENTATION#0",
    "var:HOST_MANAGED_IMPLEMENTATION#0",
    "var:NATIVE_MANAGED_IMPLEMENTATION#0",
    "function:provider#0",
    "function:nativeProvider#0",
    "var:ASYNC_RUNTIME_PROVIDERS#0",
  ],
  "src/ir/runtime/manifest.ts": [
    "function:projectRuntimeBackendRequirements#0",
    "type:RuntimeManifestInvariantCode#0",
    "class:RuntimeManifestInvariantError#0",
    "var:ALL_TARGETS#0",
    "var:ALL_BACKENDS#0",
    "var:REFERENCE_ERROR_DECLARATION#0",
    "var:REFERENCE_ERROR_SIGNATURE#0",
    "var:RUNTIME_FEATURE_SIGNATURES#0",
    "function:provider#0",
    "var:NUMERIC_COERCION_RUNTIME_PROVIDERS#0",
    "function:numberBoundaryProvider#0",
    "var:NUMBER_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:EXTERN_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS#0",
    "var:STRING_COMPARE_RUNTIME_PROVIDERS#0",
    "function:stringCompareProviderId#0",
    "var:STRING_COMPARE_FEATURE_SET#0",
    "function:isStringCompareFeature#0",
    "var:STRING_EQ_RUNTIME_PROVIDERS#0",
    "function:stringEqProviderId#0",
    "var:STRING_EQ_FEATURE_SET#0",
    "function:isStringEqFeature#0",
    "var:STRING_LEN_RUNTIME_PROVIDERS#0",
    "function:stringLenProviderId#0",
    "var:STRING_LEN_FEATURE_SET#0",
    "function:isStringLenFeature#0",
    "var:STRING_CONCAT_RUNTIME_PROVIDERS#0",
    "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
    "function:stringConcatProviderId#0",
    "var:STRING_CONCAT_FEATURE_SET#0",
    "function:isStringConcatFeature#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS#0",
    "var:STRING_CONCAT_MANY_RUNTIME_PROVIDERS#0",
    "function:stringCharCodeAtProviderId#0",
    "var:STRING_CHAR_CODE_AT_FEATURE_SET#0",
    "function:isStringCharCodeAtFeature#0",
    "function:stringConcatManyProviderId#0",
    "var:STRING_CONST_RUNTIME_PROVIDERS#0",
    "function:stringConstProviderId#0",
    "var:STRING_CONST_FEATURE_SET#0",
    "function:isStringConstFeature#0",
    "var:STRING_CONCAT_MANY_FEATURE_SET#0",
    "function:isStringConcatManyFeature#0",
    "function:stringConcatManyArityCap#0",
    "function:generatorNumberBoxProviderId#0",
    "var:GENERATOR_NUMBER_BOX_FEATURE_SET#0",
    "function:isGeneratorNumberBoxFeature#0",
    "function:booleanBoundaryProviderId#0",
    "var:BOOLEAN_BOUNDARY_FEATURE_SET#0",
    "function:isBooleanBoundaryFeature#0",
    "function:externIsUndefinedProviderId#0",
    "var:EXTERN_BOUNDARY_FEATURE_SET#0",
    "function:isExternBoundaryFeature#0",
    "function:numberBoundaryProviderId#0",
    "var:NUMBER_BOUNDARY_FEATURE_SET#0",
    "function:isNumberBoundaryFeature#0",
    "var:PROVIDERS_BY_FEATURE#0",
    "var:PURE_MATH_RUNTIME_PROVIDERS#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS#0",
    "function:hostCallbackWrapProviderId#0",
    "var:HOST_CALLBACK_WRAP_FEATURE_SET#0",
    "function:isHostCallbackWrapFeature#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS#0",
    "function:functionPrototypeCallProviderId#0",
    "var:FUNCTION_PROTOTYPE_CALL_FEATURE_SET#0",
    "function:isFunctionPrototypeCallFeature#0",
    "var:REFERENCE_ERROR_RUNTIME_PROVIDERS#0",
    "var:RUNTIME_PROVIDERS#0",
    "var:FEATURE_SET#0",
    "var:PROVIDER_ID_SET#0",
    "var:HOST_CAPABILITY_ID_SET#0",
    "var:TARGET_SET#0",
    "var:BACKEND_SET#0",
    "function:isRuntimeFeature#0",
    "function:compareStrings#0",
    "function:signatureEquals#0",
    "function:cloneProvider#0",
    "function:cycleKey#0",
    "function:useOrder#0",
    "function:stronglyConnectedComponents#0",
    "function:buildProviderComponents#0",
    "interface:RuntimeManifestBuilderOptions#0",
    "type:BuilderState#0",
    "class:RuntimeManifestBuilder#0",
  ],
  "src/ir/analysis/async-plan.ts": [
    "function:asAsyncStateId#0",
    "function:asAsyncHandlerId#0",
    "function:canonicalPromiseAbi#0",
    "type:IrAsyncPlanInvariantCode#0",
    "interface:IrAsyncPlanVerifyError#0",
    "class:IrAsyncPlanInvariantError#0",
    "interface:StateLiveness#0",
    "interface:StateEdge#0",
    "var:runtimeIntentOrder#0",
    "var:runtimeIntentRank#0",
    "function:isNonNegativeSafeInteger#0",
    "function:compareNumber#0",
    "function:sameValueSet#0",
    "function:describeValues#0",
    "function:terminatorUses#0",
    "function:stateUpdates#0",
    "function:updateMap#0",
    "function:stateEdges#0",
    "function:stateLiveness#0",
    "function:addPurityError#0",
    "function:verifyPureData#0",
    "function:addError#0",
    "type:AsyncValueChecker#0",
    "function:verifyResumeIncomingEdges#0",
    "function:verifySpillUpdates#0",
    "function:verifyCanonicalPromiseAbi#0",
    "function:irAsyncPlanNeedsNumberBridge#0",
    "function:requiredRuntimeIntents#0",
    "function:verifyIrAsyncPlan#0",
    "function:assertIrAsyncPlan#0",
    "function:clonePlanData#0",
    "function:canonicalPlanInput#0",
    "function:createIrAsyncPlan#0",
    "function:canonicalJson#0",
    "function:serializeIrAsyncPlan#0",
    "function:hashIrAsyncPlan#0",
  ],
  "src/ir/runtime/async-attachment.ts": [
    "var:preparedManifestByPlan#0",
    "function:runtimeAttachmentError#0",
    "function:sameOrderedStrings#0",
    "function:expectedAsyncProviders#0",
    "function:assertFrozenProvider#0",
    "function:freezePreparedIrAsyncStateBody#0",
    "function:isPreparedIrAsyncStateBodyFrozen#0",
    "function:sealPreparedIrAsyncStates#0",
    "function:assertPreparedIrAsyncRuntimeCurrent#0",
    "function:createPreparedIrAsyncRuntime#0",
    "function:sealPreparedIrAsyncRuntimeContainers#0",
    "function:preparedIrAsyncFrameCapabilityFailure#0",
  ],
  "src/ir/intrinsic-support.ts": [
    "function:projectStandaloneAsyncStateInstr#0",
    "function:mapArray#0",
    "function:valueTypesOf#0",
    "function:providerAttachment#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURE#0",
    "function:preparedGeneratorNumberBoxProvider#0",
    "var:STRING_COMPARE_RUNTIME_FEATURE#0",
    "function:preparedStringCompareProvider#0",
    "var:STRING_EQ_RUNTIME_FEATURE#0",
    "function:preparedStringEqProvider#0",
    "var:STRING_LEN_RUNTIME_FEATURE#0",
    "function:preparedStringLenProvider#0",
    "var:STRING_CONCAT_RUNTIME_FEATURE#0",
    "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
    "function:stringConcatFeatureFor#0",
    "function:preparedStringConcatProvider#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURE#0",
    "function:preparedStringCharCodeAtProvider#0",
    "var:STRING_CONCAT_MANY_RUNTIME_FEATURE#0",
    "function:preparedStringConcatManyProvider#0",
    "var:STRING_CONST_RUNTIME_FEATURE#0",
    "var:STRING_CONST_UTF16_RUNTIME_FEATURE#0",
    "function:stringConstFeatureFor#0",
    "function:preparedStringConstProvider#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURE#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE#0",
    "function:preparedHostCallbackWrapProvider#0",
    "function:preparedFunctionPrototypeCallProvider#0",
    "function:sameProvider#0",
    "function:attachProvidersToBuffer#0",
    "function:attachProviders#0",
    "interface:IrRuntimeManifestDemands#0",
    "interface:PrepareIrRuntimeManifestInput#0",
    "class:IrRuntimeFunctionPreparationError#0",
    "function:prepareIrRuntimeManifest#0",
    "function:prepareIrRuntimeManifest#1",
    "function:prepareIrRuntimeManifest#2",
  ],
  "src/ir/runtime/intrinsic-verification.ts": [
    "var:BACKEND_COMPOSITE_BY_INTRINSIC#0",
    "function:callableBindingKey#0",
    "var:ADMITTED_CALLABLE_TARGETS#0",
    "function:verifyIrIntrinsicInstruction#0",
  ],
  "src/ir/runtime/host-capabilities.ts": [
    "var:RUNTIME_HOST_CAPABILITY_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_EXPORT_ID_SET#0",
    "function:isRuntimeHostCapabilityId#0",
    "function:isRuntimeHostCapabilityFuncId#0",
    "function:isRuntimeHostCapabilityFuncFamilyId#0",
    "function:isRuntimeHostCapabilityGlobalId#0",
    "function:isRuntimeHostCapabilityExportId#0",
    "var:RUNTIME_HOST_CAPABILITY_VALUE_TYPES#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_MODULE_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_GLOBAL_MODULE_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_KIND_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FIELD_SCHEME_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEME_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATION_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VAR_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_HOST_SELECTION_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_MIN_ARITY#0",
    "interface:RuntimeHostCapabilityFuncOptions#0",
    "function:funcRecord#0",
    "function:freezeHostSelection#0",
    "function:record#0",
    "function:funcFamilyRecord#0",
    "function:exportRecord#0",
    "function:globalRecord#0",
    "var:RUNTIME_HOST_CAPABILITY_RECORDS#0",
    "var:RECORD_BY_ID#0",
    "var:CANONICAL_RECORDS#0",
    "function:compareCapabilityRecords#0",
    "function:describeRecord#0",
    "function:assertExactKeys#0",
    "function:assertValueTypes#0",
    "function:assertRuntimeHostCapabilityRecord#0",
    "function:assertHostSelection#0",
    "function:assertExportCapabilityRecord#0",
    "function:assertFuncFamilyCapabilityRecord#0",
    "function:assertGlobalCapabilityRecord#0",
    "function:assertCanonicalRuntimeHostCapabilityRecord#0",
    "function:asCallableRuntimeHostCapabilityRecord#0",
    "function:canonicalizeRuntimeHostCapabilityCatalog#0",
    "function:resolveRuntimeHostCapabilityRecord#0",
    "function:resolveRuntimeHostCapabilityFuncFamilyRecord#0",
    "function:resolveRuntimeHostCapabilityGlobalRecord#0",
    "function:resolveRuntimeHostCapabilityExportRecord#0",
    "function:resolveRuntimeHostCapabilityFuncRecord#0",
    "var:HOST_CALLBACK_WRAP_CAPABILITY_RECORD#0",
  ],
  "src/ir/runtime/callable-declarations.ts": [
    "interface:IrRuntimeCallableDeclaration#0",
    "function:semanticTypes#0",
    "var:referenceError#0",
    "var:REFERENCE_ERROR_DECLARATION#0",
    "function:irRuntimeCallableDeclaration#0",
  ],
};

export interface HistoricalDeclaration {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly file: ts.SourceFile;
  readonly node: ts.Statement;
  readonly doc: string;
  readonly text: string;
}

function requireCondition(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error("historical reconstruction: " + detail);
}

export function parseLive(path: string, read: SourceReader): ts.SourceFile {
  const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  requireCondition(
    !(file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length,
    "syntax in " + path,
  );
  return file;
}

function identity(node: ts.Statement): { name: string; kind: string } {
  if (ts.isVariableStatement(node)) {
    requireCondition(node.declarationList.declarations.length === 1, "multiple variable bindings");
    const binding = node.declarationList.declarations[0]!.name;
    requireCondition(ts.isIdentifier(binding), "non-identifier binding");
    return { name: binding.text, kind: "var" };
  }
  const kind = ts.isFunctionDeclaration(node)
    ? "function"
    : ts.isInterfaceDeclaration(node)
      ? "interface"
      : ts.isTypeAliasDeclaration(node)
        ? "type"
        : ts.isClassDeclaration(node)
          ? "class"
          : undefined;
  requireCondition(
    kind && "name" in node && node.name && ts.isIdentifier(node.name as ts.Node),
    "unexpected declaration syntax",
  );
  return { name: (node.name as ts.Identifier).text, kind };
}

export function declarationDoc(node: ts.Statement): string {
  const docs = (node as ts.Statement & { jsDoc?: readonly ts.JSDoc[] }).jsDoc;
  requireCondition(!docs || docs.length <= 1, "unexpected multiple declaration documentation blocks");
  return docs?.at(-1)?.getText() ?? "";
}

export function currentDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  const file = parseLive(path, read),
    occurrences = new Map<string, number>();
  const records = file.statements
    .filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map((node) => {
      const { name, kind } = identity(node),
        key = kind + ":" + name;
      const ordinal = occurrences.get(key) ?? 0;
      occurrences.set(key, ordinal + 1);
      return { path, name, kind, ordinal, node, file, doc: declarationDoc(node), text: node.getText(file) };
    });
  const expected = ownerOrder[path];
  requireCondition(expected, "unreviewed current owner " + path);
  requireCondition(
    JSON.stringify(records.map((r) => r.kind + ":" + r.name + "#" + r.ordinal)) === JSON.stringify(expected),
    "current declaration order/identity in " + path,
  );
  return records;
}

const runtimeContract = "src/ir/runtime/contracts/intrinsics.ts";
const coreContract = "src/ir/core/intrinsic-contracts.ts";
const coreIntrinsics = "src/ir/core/intrinsics.ts";
const analysisIntrinsics = "src/ir/analysis/intrinsics.ts";

function modulePath(from: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(from), specifier.replace(/\.js$/, ".ts")));
}

export function assertNamedForward(
  from: string,
  to: string,
  name: string,
  typeOnly: boolean,
  read: SourceReader,
): void {
  const file = parseLive(from, read);
  const matches: { target: string; original: string; typeOnly: boolean }[] = [];
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node)) continue;
    if (!ts.isExportDeclaration(node)) {
      requireCondition(identity(node).name !== name, from + " locally replaces " + name);
      continue;
    }
    requireCondition(node.exportClause && ts.isNamedExports(node.exportClause), "non-explicit forwarding in " + from);
    requireCondition(
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier),
      "missing forwarding target in " + from,
    );
    for (const entry of node.exportClause.elements)
      if (entry.name.text === name)
        matches.push({
          target: modulePath(from, node.moduleSpecifier.text),
          original: entry.propertyName?.text ?? entry.name.text,
          typeOnly: node.isTypeOnly || entry.isTypeOnly,
        });
  }
  requireCondition(
    JSON.stringify(matches) === JSON.stringify([{ target: to, original: name, typeOnly }]),
    "exact forwarding " + from + "#" + name + " -> " + to,
  );
}

function exactImports(
  file: ts.SourceFile,
  expected: readonly { target: string; bindings: readonly string[] }[],
): ts.ImportDeclaration[] {
  const imports = file.statements.filter(ts.isImportDeclaration);
  const actual = imports.map((node) => {
    const clause = node.importClause;
    requireCondition(
      clause?.isTypeOnly &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.attributes,
      "unexpected type import in " + file.fileName,
    );
    return {
      target: node.moduleSpecifier.text,
      bindings: clause.namedBindings.elements.map((entry) => {
        requireCondition(!entry.isTypeOnly, "unexpected per-binding modifier");
        return entry.propertyName ? entry.propertyName.text + " as " + entry.name.text : entry.name.text;
      }),
    };
  });
  requireCondition(JSON.stringify(actual) === JSON.stringify(expected), "exact imports in " + file.fileName);
  return imports;
}

export function assertIntrinsicSpecialization(read: SourceReader): void {
  const runtime = currentDeclarations(runtimeContract, read),
    file = runtime[0]!.file;
  exactImports(file, [
    { target: "../../core/intrinsic-contracts.js", bindings: ["IntrinsicDefinition as CoreIntrinsicDefinition"] },
  ]);
  const exports = file.statements.filter(ts.isExportDeclaration);
  requireCondition(exports.length === 1, "unexpected runtime contract exports");
  const names = [
    "IntrinsicSignature",
    "IntrinsicSourceLocation",
    "IntrinsicUse",
    "IntrinsicVerificationCode",
    "IntrinsicVerificationFailure",
  ];
  const forward = exports[0]!;
  requireCondition(
    forward.isTypeOnly &&
      forward.exportClause &&
      ts.isNamedExports(forward.exportClause) &&
      ts.isStringLiteral(forward.moduleSpecifier!) &&
      forward.moduleSpecifier.text === "../../core/intrinsic-contracts.js" &&
      JSON.stringify(
        forward.exportClause.elements.map((entry) => [entry.name.text, entry.propertyName?.text, entry.isTypeOnly]),
      ) === JSON.stringify(names.map((name) => [name, undefined, false])),
    "runtime core-contract forwarding",
  );
  const alias = runtime[14]!;
  requireCondition(
    alias.doc === "" && alias.text === "export type IntrinsicDefinition = CoreIntrinsicDefinition<RuntimeFeature>;",
    "exact runtime specialization",
  );
}

export function historicalIntrinsicDeclarations(read: SourceReader): HistoricalDeclaration[] {
  assertIntrinsicSpecialization(read);
  const runtime = currentDeclarations(runtimeContract, read),
    core = currentDeclarations(coreContract, read);
  exactImports(core[0]!.file, [
    { target: "./intrinsic-vocabulary.js", bindings: ["IntrinsicId", "IntrinsicSignatureVersion"] },
    { target: "./types.js", bindings: ["IrType"] },
  ]);
  requireCondition(!core[0]!.file.statements.some(ts.isExportDeclaration), "unexpected core contract export");
  const definition = core[3]!,
    node = definition.node;
  requireCondition(
    ts.isInterfaceDeclaration(node) &&
      node.typeParameters?.length === 1 &&
      node.typeParameters[0]!.getText() === "Feature extends string" &&
      node.members.length === 3 &&
      !node.heritageClauses &&
      node.modifiers?.length === 1 &&
      node.modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword,
    "exact generic IntrinsicDefinition<Feature extends string>",
  );
  const memberTexts = [
    "readonly id: IntrinsicId;",
    "readonly signature: IntrinsicSignature;",
    "readonly feature: Feature;",
  ];
  requireCondition(
    JSON.stringify(node.members.map((member) => member.getText())) === JSON.stringify(memberTexts),
    "mandatory readonly intrinsic definition members",
  );
  const feature = node.members[2] as ts.PropertySignature;
  requireCondition(feature.type, "missing feature type");
  // Only the approved generic parameter and feature-type tokens are removed.
  const start = node.getStart();
  const text =
    definition.text.slice(0, node.name.end - start) +
    definition.text.slice(node.typeParameters.end + 1 - start, feature.type.getStart() - start) +
    "RuntimeFeature" +
    definition.text.slice(feature.type.end - start);
  return [...runtime.slice(0, 14), ...core.map((row, index) => (index === 3 ? { ...row, text } : row))];
}

export const receiptRows = (records: readonly HistoricalDeclaration[]): string[][] =>
  records.map(({ name, doc, text }) => [name, doc, text]);

export function historicalIntrinsicSource(read: SourceReader): string {
  const rows = acceptedHistoricalDeclarations(runtimeContract, read);
  const file = parseLive(coreContract, read);
  // Validate first, then rebase the two live imports; no synthetic dependencies.
  const imports = file.statements
    .filter(ts.isImportDeclaration)
    .map((node) =>
      node
        .getText(file)
        .replace('"./intrinsic-vocabulary.js"', '"../../core/intrinsic-vocabulary.js"')
        .replace('"./types.js"', '"../../core/types.js"'),
    );
  return imports.join("\n") + "\n\n" + rows.map((r) => (r.doc ? r.doc + "\n" : "") + r.text).join("\n\n") + "\n";
}

function normalizeIntrinsicImplementations(read: SourceReader): HistoricalDeclaration[] {
  const rows = currentDeclarations(coreIntrinsics, read);
  const definition = rows[16]!,
    node = definition.node;
  requireCondition(
    ts.isFunctionDeclaration(node) &&
      node.body &&
      !node.asteriskToken &&
      !node.modifiers &&
      !node.typeParameters &&
      node.parameters.length === 3 &&
      node.parameters[0]!.getText() === "id: IntrinsicId" &&
      node.parameters[1]!.getText() === "signature: IntrinsicSignature" &&
      node.parameters[2]!.getText() === "feature: IntrinsicId = id" &&
      node.type?.getText() === "IntrinsicDefinition<IntrinsicId>",
    "exact live definition signature",
  );
  // Historical layout is one line. Body/default expression/documentation stay live.
  const text =
    "function definition(" +
    node.parameters
      .slice(0, 2)
      .map((p) => p.getText())
      .join(", ") +
    ", feature: RuntimeFeature = " +
    node.parameters[2]!.initializer!.getText() +
    "): IntrinsicDefinition " +
    node.body.getText();
  const table = rows[17]!;
  requireCondition(ts.isVariableStatement(table.node), "missing canonical intrinsic table");
  const tableDecl = table.node.declarationList.declarations[0]!;
  requireCondition(
    tableDecl.type?.getText() === "Readonly<Record<IntrinsicId, IntrinsicDefinition<IntrinsicId>>>" &&
      tableDecl.initializer,
    "exact canonical table annotation",
  );
  const tableText =
    table.text.slice(0, tableDecl.type.getStart() - table.node.getStart()) +
    "Readonly<Record<IntrinsicId, IntrinsicDefinition>>" +
    table.text.slice(tableDecl.type.end - table.node.getStart());
  const facade = parseLive("src/ir/intrinsics.ts", read);
  const aliases = facade.statements.filter((entry) => !ts.isImportDeclaration(entry) && !ts.isExportDeclaration(entry));
  requireCondition(
    aliases.length === 1 &&
      aliases[0]!.getText() ===
        "export const INTRINSIC_DEFINITIONS: Readonly<Record<IntrinsicId, IntrinsicDefinition>> = canonicalIntrinsicDefinitions;" &&
      declarationDoc(aliases[0]!) === "/** Historical runtime-feature view of the single canonical semantic table. */",
    "live canonical table compatibility alias",
  );
  const tableImports = facade.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (entry) =>
        entry.importClause?.namedBindings &&
        ts.isNamedImports(entry.importClause.namedBindings) &&
        entry.importClause.namedBindings.elements.some(
          (binding) => binding.name.text === "canonicalIntrinsicDefinitions",
        ),
    );
  requireCondition(
    tableImports.length === 1 &&
      tableImports[0]!.getText() ===
        'import { INTRINSIC_DEFINITIONS as canonicalIntrinsicDefinitions } from "./core/intrinsics.js";',
    "canonical table alias import",
  );
  return rows.map((row, index) => (index === 16 ? { ...row, text } : index === 17 ? { ...row, text: tableText } : row));
}

export function historicalIntrinsicVerifier(read: SourceReader): HistoricalDeclaration {
  const semantic = currentDeclarations(analysisIntrinsics, read)[4]!;
  const combined = currentDeclarations("src/ir/runtime/intrinsic-verification.ts", read)[3]!;
  const a = semantic.node,
    b = combined.node;
  requireCondition(
    ts.isFunctionDeclaration(a) && a.body && ts.isFunctionDeclaration(b) && b.body,
    "missing split verifier bodies",
  );
  requireCondition(
    a.body.statements.length === 7 &&
      b.body.statements.length === 4 &&
      a.body.statements.at(-1)!.getText() === "return errors;" &&
      b.body.statements[0]!.getText() === "const errors = [...verifyIrIntrinsicSignature(instr, typeOf)];" &&
      b.body.statements.at(-1)!.getText() === "return errors;",
    "exact semantic prefix and provider suffix",
  );
  const parameters = ["instr: IrInstrIntrinsic", "typeOf: ReadonlyMap<IrValueId, IrType>"];
  requireCondition(
    JSON.stringify(a.parameters.map((p) => p.getText())) === JSON.stringify(parameters) &&
      JSON.stringify(b.parameters.map((p) => p.getText())) === JSON.stringify(parameters) &&
      a.type?.getText() === "readonly string[]" &&
      b.type?.getText() === "readonly string[]" &&
      !a.typeParameters &&
      !b.typeParameters &&
      !a.asteriskToken &&
      a.modifiers?.length === 1 &&
      a.modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword,
    "split verifier parameter forwarding",
  );
  requireCondition(
    semantic.doc === "/** Verify the closed semantic signature before runtime provider authentication. */" &&
      combined.doc === "/** Verify the closed semantic signature and any post-freeze provider binding. */",
    "explicit split verifier documentation",
  );
  const first = b.body.statements[0]!,
    last = a.body.statements.at(-1)!;
  const prefix = a.getSourceFile().text.slice(a.body.statements[0]!.getFullStart(), last.getFullStart());
  const text =
    combined.text.slice(0, first.getFullStart() - b.getStart()) +
    prefix +
    combined.text.slice(first.end - b.getStart());
  // The original tuple included this exact documentation as well as the body.
  return { ...combined, text };
}

export function historicalRuntimeDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  switch (path) {
    case "src/ir/async-runtime-providers.ts":
      return [
        ...currentDeclarations("src/ir/core/async-intents.ts", read).slice(3),
        ...currentDeclarations("src/ir/runtime/async-providers.ts", read),
      ];
    case "src/ir/runtime-manifest.ts":
      return currentDeclarations("src/ir/runtime/manifest.ts", read);
    case "src/ir/async-plan.ts": {
      const semantic = currentDeclarations("src/ir/analysis/async-plan.ts", read);
      const runtime = currentDeclarations("src/ir/runtime/async-attachment.ts", read);
      return [
        ...semantic.slice(0, 3),
        ...runtime.slice(0, 11),
        ...semantic.slice(3, 26),
        runtime[11]!,
        ...semantic.slice(26),
      ];
    }
    case "src/ir/intrinsics.ts":
      return [...normalizeIntrinsicImplementations(read), ...currentDeclarations(analysisIntrinsics, read).slice(0, 4)];
    case "src/ir/intrinsic-support.ts": {
      const retained = currentDeclarations(path, read);
      const runtime = currentDeclarations("src/ir/runtime/intrinsic-verification.ts", read);
      return [...runtime.slice(0, 3), retained[0]!, historicalIntrinsicVerifier(read), ...retained.slice(1)];
    }
    default:
      throw new Error("unreviewed historical runtime owner " + path);
  }
}

// Original receipts, not newly measured baselines. A live-source mutation must
// fail the accepted reconstruction before any fixture can use its output.
const historicalHashes: Readonly<Record<string, string>> = {
  [runtimeContract]: "3e3c8fd145f03837dce98ce6b364fabddb88cc98bcc9281304a8a48da009b3f9",
  "src/ir/async-runtime-providers.ts": "e6c4a6e91bf4878715ef9b508342a42f7bd692c7bb8ca32fb33568be13635045",
  "src/ir/runtime-manifest.ts": "3abe53cac71f94ed08ab1c9de8f44bfcc6ca0c254f7d6963bb50e8b572a6f478",
  "src/ir/intrinsics.ts": "eee3f92b352fb705c5addda7f396ce665c329ab53e501cfe1f6d7e0fbd93291f",
  "src/ir/async-plan.ts": "a7aada275dcd9af1111649c58a4fcce678cd018d6b458f431edcf9eb6e61ab77",
  "src/ir/intrinsic-support.ts": "eea4525b21f65d7334af27e6ee195dbbb7ca39b9dd57d5781345b80d60d2e8d7",
};

export function acceptedHistoricalDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  const records =
    path === runtimeContract ? historicalIntrinsicDeclarations(read) : historicalRuntimeDeclarations(path, read);
  requireCondition(
    createHash("sha256")
      .update(JSON.stringify(receiptRows(records)))
      .digest("hex") === historicalHashes[path],
    "unchanged historical declaration receipt " + path,
  );
  return records;
}
