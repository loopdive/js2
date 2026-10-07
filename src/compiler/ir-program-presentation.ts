// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import { ts } from "../ts-api.js";
import type { PipelineOutputContext } from "../compiler.js";
import type { CompileResult } from "../index.js";
import type { IrWholeProgramPreparationInput } from "../ir/program-preparation.js";
import {
  freezePreparedIrValue,
  type PreparedIrBackendOptions,
  type PreparedIrProgram,
  type EmittedPreparedIrProgram,
} from "../ir/program.js";
import {
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
  emittedStartupAdapterIndex,
  emittedSupportFunctionReceipts,
} from "../ir/program-consumer.js";
import type { IrUnitId, IrBindingId } from "../shared/contracts/ir-identity.js";
import type { ValType, TypeDef, Instr, ExportSignature } from "../ir/types.js";
import type { PhysicalSetupPlan, PhysicalSignatureType } from "../ir/program-physical-plan.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import type { WasmModule } from "../ir/types.js";
import type { IrType } from "../ir/core/types.js";
import { runIrProgramDriver } from "./ir-program-driver.js";
import type { IrProgramDriverResult } from "./ir-program-result.js";
import type { PreparedWitExport, PreparedWitView } from "../wit-generator.js";
import {
  NUMBER_REMAINDER_RUNTIME_PROVIDERS,
  irNumberRemainderCallableDeclaration,
} from "../ir/runtime/number-remainder-callables.js";
import type { RuntimeProviderDefinition } from "../ir/runtime/contracts/manifest.js";

export interface IrProgramPresentationRequest {
  readonly preparation: IrWholeProgramPreparationInput;
  readonly backendOptions: PreparedIrBackendOptions;
  readonly output: PipelineOutputContext;
}
export interface IrProgramPresentationGap {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
  readonly sourceFile?: string;
  readonly unitId?: IrUnitId;
  readonly bindingId?: IrBindingId;
}
export type IrProgramPresentationStartup =
  | { readonly kind: "none"; readonly hasTopLevelStatements: false }
  | {
      readonly kind: "wasm-start";
      readonly hasTopLevelStatements: true;
      readonly adapterIndex: number;
      readonly unitIds: readonly IrUnitId[];
    }
  | {
      readonly kind: "deferred-export";
      readonly hasTopLevelStatements: true;
      readonly adapterIndex: number;
      readonly unitIds: readonly IrUnitId[];
      readonly exportName: "__module_init";
    };
export type IrProgramPresentationResult =
  | {
      readonly kind: "prepared-presentation";
      readonly program: PreparedIrProgram;
      readonly emission: EmittedPreparedIrProgram;
      readonly output: PipelineOutputContext;
      readonly startup: IrProgramPresentationStartup;
      readonly requiresDetachedFinalization?: true;
    }
  | Extract<IrProgramDriverResult, { kind: "unsupported" }>
  | { readonly kind: "presentation-unsupported"; readonly gaps: readonly IrProgramPresentationGap[] };
/** Actual finalizer products; deliberately excludes route/fallback telemetry. */
export type PreparedIrPresentationArtifacts = Pick<
  CompileResult,
  | "binary"
  | "wat"
  | "dts"
  | "importsHelper"
  | "success"
  | "errors"
  | "stringPool"
  | "sourceMap"
  | "imports"
  | "runtimeRecGroupFingerprint"
  | "targetProfile"
  | "hostImportInventory"
  | "hostImportSummary"
  | "capabilityRequirements"
  | "capabilityProviderDiagnostics"
  | "explanation"
  | "cHeader"
  | "wit"
  | "hasMain"
  | "hasTopLevelStatements"
  | "exportSignatures"
  | "exportBoundaryPolicies"
  | "adapterManifest"
>;
export type PreparedIrPipelinePresentationResult =
  | {
      readonly kind: "artifacts";
      readonly program: PreparedIrProgram;
      readonly emission: EmittedPreparedIrProgram;
      readonly startup: IrProgramPresentationStartup;
      readonly artifacts: PreparedIrPresentationArtifacts;
      readonly finalization?: PreparedPresentationFinalizationReceipt;
    }
  | {
      readonly kind: "output-failed";
      readonly errors: CompileResult["errors"];
      readonly artifacts: PreparedIrPresentationArtifacts;
    }
  | Exclude<IrProgramPresentationResult, { kind: "prepared-presentation" }>;

type PresentationSlot = "number" | "boolean" | "promise";
interface DeclarationCapture {
  readonly sourceFile: string;
  readonly start: number;
  readonly end: number;
  readonly params: readonly PresentationSlot[];
  readonly witParamNames?: readonly string[];
  readonly results: readonly PresentationSlot[];
  readonly synchronous: boolean;
  readonly name?: string;
  readonly exported: boolean;
  readonly fulfillment?: "number" | "boolean" | "void";
}
const numeric = (type: ValType): boolean => ["i32", "i64", "f32", "f64"].includes(type.kind);
function booleanCarrier(type: ValType): boolean {
  return type.kind === "i32" && type.boolean === true && type.symbol === undefined && type.int32 === undefined;
}
function sourceSlotMatches(slot: PresentationSlot, type: IrType | undefined): boolean {
  if (slot === "promise")
    return type?.kind === "val" && preparedIrDataMismatch(type.val, { kind: "externref" }) === undefined;
  if (!type || type.kind !== "val") return false;
  if (slot === "boolean") return type.typeRef === undefined && booleanCarrier(type.val);
  return numeric(type.val) && (type.val.kind !== "i32" || type.val.boolean !== true);
}
function physicalSlotMatches(slot: PresentationSlot, physical: ValType, logical: IrType | undefined): boolean {
  return (
    sourceSlotMatches(slot, logical) &&
    (slot === "promise"
      ? physical.kind === "externref"
      : logical?.kind === "val" && physical.kind === logical.val.kind) &&
    (slot !== "boolean" || booleanCarrier(physical))
  );
}
function booleanExportSignature(declaration: DeclarationCapture): ExportSignature | undefined {
  if (![...declaration.params, ...declaration.results].some((slot) => slot === "boolean" || slot === "promise"))
    return undefined;
  const signature: ExportSignature = {
    params: declaration.params.map((slot) => (slot === "boolean" ? "boolean" : "other")),
    result:
      declaration.results[0] === "promise" ? "promise" : declaration.results[0] === "boolean" ? "boolean" : "other",
  };
  Object.freeze(signature.params);
  return Object.freeze(signature);
}
function typeNeedsWidening(type: TypeDef): boolean {
  switch (type.kind) {
    case "func":
      return [...type.params, ...type.results].some((value) => value.kind === "ref");
    case "struct":
      return type.fields.some((field) => field.type.kind === "ref");
    case "array":
      return type.element.kind === "ref";
    case "rec":
      return type.types.some(typeNeedsWidening);
    case "sub":
      return typeNeedsWidening(type.type);
  }
}
function bodyNeedsWidening(body: readonly Instr[], visited = new Set<readonly Instr[]>()): boolean {
  if (visited.has(body)) return false;
  visited.add(body);
  for (const instruction of body) {
    if ("blockType" in instruction && instruction.blockType.kind === "val" && instruction.blockType.type.kind === "ref")
      return true;
    switch (instruction.op) {
      case "block":
      case "loop":
      case "try_table":
        if (bodyNeedsWidening(instruction.body, visited)) return true;
        break;
      case "if":
        if (
          bodyNeedsWidening(instruction.then, visited) ||
          (instruction.else && bodyNeedsWidening(instruction.else, visited))
        )
          return true;
        break;
      case "try":
        if (
          bodyNeedsWidening(instruction.body, visited) ||
          instruction.catches.some((row) => bodyNeedsWidening(row.body, visited)) ||
          (instruction.catchAll && bodyNeedsWidening(instruction.catchAll, visited))
        )
          return true;
        break;
    }
  }
  return false;
}
const unsupported = (gaps: readonly IrProgramPresentationGap[]): IrProgramPresentationResult =>
  Object.freeze({ kind: "presentation-unsupported", gaps: Object.freeze([...gaps]) });

/** One synchronous source-capture/driver transaction, never an emitted-packet input. */
type GapRecorder = (
  field: string,
  code: string,
  detail: string,
  association?: Partial<IrProgramPresentationGap>,
) => void;
interface GlobalCapture {
  sourceFile: string;
  start: number;
  end: number;
  name: string;
  numeric: boolean;
}
interface PresentationCapture {
  input: IrWholeProgramPreparationInput;
  backend: PreparedIrBackendOptions;
  context: PipelineOutputContext;
  names: Set<string>;
  declarations: DeclarationCapture[];
  globals: GlobalCapture[];
}
function capturePresentation(request: IrProgramPresentationRequest, gap: GapRecorder): PresentationCapture {
  const { preparation, output } = request;
  // Only plain option data is copied. Compiler-owned AST/checker/link identities stay intact.
  const backend = freezePreparedIrValue(request.backendOptions) as PreparedIrBackendOptions;
  const options = freezePreparedIrValue(output.options) as PipelineOutputContext["options"];
  const policy = freezePreparedIrValue(preparation.policy) as IrWholeProgramPreparationInput["policy"];
  const input = { ...preparation, policy, sourceFiles: Object.freeze([...preparation.sourceFiles]) };
  const context: PipelineOutputContext = {
    ...output,
    options,
    codegenOptions: Object.freeze({ link: output.codegenOptions.link }),
  };
  if (
    output.entryAst.sourceFile !== input.entrySource ||
    output.entryAst.checker !== input.checker ||
    output.diagnosticAnchor !== input.entrySource ||
    !input.sourceFiles.includes(input.entrySource)
  )
    gap(
      "source",
      "source-association",
      "entry AST, checker, diagnostic anchor and preparation source must be identical",
    );
  const names = new Set<string>();
  for (const source of input.sourceFiles) {
    if (names.has(source.fileName) || !output.entryAst.program.getSourceFiles().includes(source))
      gap("source", "source-association", "source graph contains a duplicate or foreign source", {
        sourceFile: source.fileName,
      });
    names.add(source.fileName);
    if (output.sourcesContent.get(source.fileName) !== source.text)
      gap("sourcesContent", "source-content", "captured source text does not match the analyzed source", {
        sourceFile: source.fileName,
      });
  }
  if (
    backend.target !== "host" ||
    policy.target !== backend.target ||
    policy.backend !== backend.backend ||
    (backend.backend !== "wasmgc" && backend.backend !== "linear")
  )
    gap("backend", "option-association", "only matching wasmgc:host or linear:host projections are admitted");
  if (
    (options.target === "linear" ? "linear" : "wasmgc") !== backend.backend ||
    (options.moduleName ?? "module") !== backend.moduleName ||
    (options.sharedExceptionTag === true) !== backend.sharedExceptionTag ||
    (options.utf8Storage === true) !== backend.utf8Storage ||
    (options.deferTopLevelInit === true) !== input.deferTopLevelInit
  )
    gap(
      "options",
      "option-association",
      "resolved backend/module/storage/startup options disagree with presentation options",
    );
  if (options.sourceMap || backend.sourceMap || options.abi === "c" || options.optimize)
    gap(
      "options",
      "unproved-output-option",
      "source maps, C ABI and optimization require a separate complete presentation contract",
    );
  if (output.errors.some((error) => error.severity === "error"))
    gap("errors", "frontend-errors", "analyzed frontend errors cannot become prepared artifacts");
  const expectedLinks = [...new Set(options.link ?? [])];
  if (
    expectedLinks.length !== (context.codegenOptions.link?.length ?? 0) ||
    expectedLinks.some((link, index) => link !== context.codegenOptions.link?.[index])
  )
    gap("codegenOptions.link", "option-association", "resolved link collection must agree with captured options");
  const declarations: DeclarationCapture[] = [];
  const globals: { sourceFile: string; start: number; end: number; name: string; numeric: boolean }[] = [];
  function classify(type: ts.Type): "number" | "boolean" | "void" | undefined {
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
    if ((type.flags & ts.TypeFlags.Void) !== 0) return "void";
    return undefined;
  }
  for (const source of input.sourceFiles) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          globals.push({
            sourceFile: source.fileName,
            start: declaration.getStart(source),
            end: declaration.end,
            name: declaration.name.text,
            numeric: classify(input.checker.getTypeAtLocation(declaration)) === "number",
          });
      }
    }
    for (const row of globals.filter((row) => row.sourceFile === source.fileName)) {
      if (!row.numeric)
        gap("declaration", "non-numeric-boundary", "top-level global storage needs a numeric source classification", {
          sourceFile: source.fileName,
        });
    }
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.body) {
        const signature = input.checker.getSignatureFromDeclaration(node);
        const params: PresentationSlot[] = [];
        let unsupportedParam = false;
        for (const param of node.parameters) {
          const kind = classify(input.checker.getTypeAtLocation(param));
          if (
            kind === "number" ||
            (kind === "boolean" && !param.questionToken && !param.dotDotDotToken && !param.initializer)
          )
            params.push(kind);
          else unsupportedParam = true;
        }
        const returnType = signature && input.checker.getReturnTypeOfSignature(signature);
        const fulfillmentType = returnType && sourcePromiseFulfillment(input.checker, returnType);
        const fulfillment = fulfillmentType && classify(fulfillmentType);
        const result: PresentationSlot | "void" | undefined = fulfillment
          ? "promise"
          : returnType && classify(returnType);
        const synchronous =
          !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && !node.asteriskToken;
        if (!signature || unsupportedParam || !result || (!synchronous && (result !== "promise" || node.asteriskToken)))
          gap(
            "declaration",
            "non-numeric-boundary",
            "complete synchronous numeric or Boolean function declarations are required",
            { sourceFile: source.fileName },
          );
        else
          declarations.push(
            Object.freeze({
              sourceFile: source.fileName,
              start: node.getStart(source),
              end: node.end,
              params: Object.freeze(params),
              ...(options.wit
                ? {
                    witParamNames: Object.freeze(
                      node.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : "")),
                    ),
                  }
                : {}),
              results: Object.freeze(result === "void" ? [] : [result]),
              synchronous,
              name: node.name?.text,
              exported: node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true,
              ...(fulfillment ? { fulfillment } : {}),
            }),
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { input, backend, context, names, declarations, globals };
}
function joinDeclarations(
  program: PreparedIrProgram,
  capture: PresentationCapture,
  gap: GapRecorder,
): Map<IrUnitId, DeclarationCapture> {
  const { input, names, declarations } = capture;
  if (
    program.inventory.sources.length !== input.sourceFiles.length ||
    program.inventory.sources.some((source) => !names.has(source.originalFileName))
  )
    gap("inventory.sources", "source-census", "prepared source population differs from captured analyzed graph");
  const captures = new Map<IrUnitId, DeclarationCapture>();
  for (const unit of program.inventory.terminalUnits) {
    if (unit.kind === "module-init") continue;
    const source = program.inventory.sources.find((row) => row.id === unit.sourceId);
    const matches = declarations.filter(
      (row) =>
        row.sourceFile === source?.originalFileName &&
        row.start === unit.declarationStart &&
        row.end === unit.declarationEnd,
    );
    if (matches.length !== 1)
      gap(
        "inventory.terminalUnits",
        "declaration-join",
        "terminal unit has no unique exact source/declaration capture",
        { unitId: unit.id, sourceFile: source?.originalFileName },
      );
    else captures.set(unit.id, matches[0]!);
  }
  return captures;
}
function checkAbiExports(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  capture: PresentationCapture,
  captures: Map<IrUnitId, DeclarationCapture>,
  gap: GapRecorder,
  signatures: Record<string, ExportSignature>,
  mixed: boolean,
  asyncNames: Set<string>,
  witExports?: PreparedWitExport[],
): Set<string> {
  const mod = emission.module;
  const { globals } = capture;
  const entries = new Map(program.abi.entries.map((entry) => [entry.plan.id, entry]));
  if (entries.size !== program.abi.entries.length)
    gap("abi", "duplicate-binding", "prepared ABI binding identities are not unique");
  const joinedExports = new Set<string>();
  for (const entry of program.abi.entries) {
    const { plan, contract } = entry;
    if (contract.kind === "callable") {
      if (
        !mixed &&
        (contract.promise ||
          [...contract.params, ...contract.results].some((type) => type.kind !== "val" || !numeric(type.val)))
      )
        gap(
          "abi.callable",
          "non-numeric-contract",
          "promise/reference callable contracts require an explicit boundary producer",
          { bindingId: plan.id },
        );
      if (
        plan.intent.kind === "callable" &&
        plan.intent.origin === "source" &&
        plan.intent.unitId &&
        captures.has(plan.intent.unitId)
      ) {
        const declaration = captures.get(plan.intent.unitId)!;
        if (
          contract.params.length !== declaration.params.length ||
          contract.results.length !== declaration.results.length ||
          declaration.params.some((slot, index) => !sourceSlotMatches(slot, contract.params[index])) ||
          declaration.results.some((slot, index) => !sourceSlotMatches(slot, contract.results[index])) ||
          !promiseContractMatches(declaration, contract.promise)
        )
          gap("abi.callable", "signature-join", "source declaration and prepared callable slots disagree", {
            unitId: plan.intent.unitId,
            bindingId: plan.id,
          });
      }
    }
    if (contract.kind === "global" && (contract.type.kind !== "val" || !numeric(contract.type.val)))
      gap("abi.global", "non-numeric-contract", "global resources require a primitive numeric contract", {
        bindingId: plan.id,
      });
    if (contract.kind !== "export") continue;
    if (joinedExports.has(contract.externalName))
      gap("exports", "duplicate-export", "export contract names must be unique", { bindingId: plan.id });
    joinedExports.add(contract.externalName);
    let target = entries.get(contract.targetId);
    const seen = new Set<IrBindingId>();
    while (target?.plan.slotPolicy === "alias") {
      if (seen.has(target.plan.id)) {
        target = undefined;
        break;
      }
      seen.add(target.plan.id);
      target = entries.get(target.plan.aliasOf);
    }
    if (target?.contract.kind === "global") {
      const targetId = target.plan.id;
      const bindings = program.startup.flatMap((row) =>
        row.bindings.filter((binding) => binding.globalBindingId === targetId).map((binding) => ({ row, binding })),
      );
      const slot = emittedProgramBindingIndex(emission, contract.targetId);
      const physical = mod.exports.filter((row) => row.name === contract.externalName);
      const binding = bindings.length === 1 ? bindings[0] : undefined;
      const source = binding && program.inventory.sources.find((row) => row.id === binding.row.sourceId);
      const witnesses =
        binding &&
        globals.filter(
          (row) =>
            row.sourceFile === source?.originalFileName &&
            row.start === binding.binding.start &&
            row.end === binding.binding.end &&
            binding.binding.names.length === 1 &&
            row.name === binding.binding.names[0] &&
            row.numeric,
        );
      const global =
        slot?.space === "global"
          ? mod.globals[slot.index - mod.imports.filter((row) => row.desc.kind === "global").length]
          : undefined;
      const type = target.contract.type;
      if (
        !binding ||
        witnesses?.length !== 1 ||
        !slot ||
        slot.space !== "global" ||
        !global ||
        physical.length !== 1 ||
        physical[0]!.desc.kind !== "global" ||
        physical[0]!.desc.index !== slot.index ||
        type.kind !== "val" ||
        !numeric(type.val) ||
        global.type.kind !== type.val.kind ||
        global.mutable !== target.contract.mutable
      )
        gap(
          "exports",
          "global-export-join",
          "primitive source binding, global ABI slot and physical export must join exactly",
          { bindingId: plan.id },
        );
      if (witExports)
        gap("wit.exports", "unmapped-wit-export", "public global exports have no scalar WIT callable mapping", {
          bindingId: plan.id,
          sourceFile: source?.originalFileName,
          unitId: binding?.row.unitId ?? undefined,
        });
      continue;
    }
    const unitId = target?.plan.intent.kind === "callable" ? target.plan.intent.unitId : undefined;
    const declaration = unitId && captures.get(unitId);
    const slot = emittedProgramBindingIndex(emission, contract.targetId);
    const exports = mod.exports.filter((row) => row.name === contract.externalName);
    if (
      !target ||
      target.contract.kind !== "callable" ||
      !declaration ||
      !slot ||
      slot.space !== "function" ||
      exports.length !== 1 ||
      exports[0]!.desc.kind !== "func" ||
      exports[0]!.desc.index !== slot.index
    )
      gap(
        "exports",
        "export-binding-join",
        "source unit, export ABI and actual function-space export must join exactly",
        { bindingId: plan.id, unitId },
      );
    else {
      const callable = target.contract;
      const fn = mod.functions[slot.index - functionImportCount(mod)];
      const signature = fn && mod.types[fn.typeIdx];
      if (
        !signature ||
        signature.kind !== "func" ||
        signature.params.length !== declaration.params.length ||
        signature.results.length !== declaration.results.length ||
        (!mixed && [...signature.params, ...signature.results].some((type) => !numeric(type))) ||
        signature.params.some(
          (type, index) => !physicalSlotMatches(declaration.params[index]!, type, callable.params[index]),
        ) ||
        signature.results.some(
          (type, index) => !physicalSlotMatches(declaration.results[index]!, type, callable.results[index]),
        )
      )
        gap(
          "exports",
          "physical-signature",
          "actual physical export signature disagrees with primitive source capture",
          {
            bindingId: plan.id,
            unitId,
          },
        );
      else {
        if (witExports) captureWitExport(contract.externalName, plan.id, unitId!, declaration, witExports, gap);
        const signature = booleanExportSignature(declaration);
        if (signature) signatures[contract.externalName] = signature;
        if (
          mixed &&
          declaration.fulfillment &&
          !declaration.synchronous &&
          declaration.exported &&
          declaration.name &&
          declaration.sourceFile === capture.input.entrySource.fileName
        )
          asyncNames.add(declaration.name);
      }
    }
  }
  return joinedExports;
}
function captureWitExport(
  externalName: string,
  bindingId: IrBindingId,
  unitId: IrUnitId,
  declaration: DeclarationCapture,
  exports: PreparedWitExport[],
  gap: GapRecorder,
): void {
  const association = { sourceFile: declaration.sourceFile, unitId, bindingId };
  if (
    !declaration.witParamNames ||
    declaration.witParamNames.length !== declaration.params.length ||
    declaration.witParamNames.some((name) => !name) ||
    declaration.params.some((kind) => kind === "promise") ||
    declaration.results.includes("promise")
  ) {
    gap(
      "wit.exports",
      "unmapped-wit-export",
      "complete source-owned scalar WIT callable signature is required",
      association,
    );
    return;
  }
  const params: PreparedWitExport["params"][number][] = [];
  for (const [index, kind] of declaration.params.entries()) {
    if (kind === "promise") return;
    params.push(Object.freeze({ sourceName: declaration.witParamNames[index]!, kind }));
  }
  const result = declaration.results[0];
  if (result === "promise") return;
  exports.push(Object.freeze({ externalName, params: Object.freeze(params), result: result ?? null, ...association }));
}
/** Numeric finalization admits only exact completed canonical remainder supports. */
function numberRemainderSupportMatches(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  providers: readonly RuntimeProviderDefinition[],
): boolean {
  const physical = emittedPhysicalSetupPlan(emission);
  const support = emittedSupportFunctionReceipts(emission);
  if (
    !physical ||
    physical.numberRemainders.length !== providers.length ||
    support.length !== providers.length ||
    new Set(physical.numberRemainders.map((row) => row.bindingId)).size !== providers.length ||
    new Set(providers.map((row) => row.id)).size !== providers.length ||
    new Set(support.map((row) => row.index)).size !== providers.length
  )
    return false;
  return providers.every((provider) => {
    const canonical = NUMBER_REMAINDER_RUNTIME_PROVIDERS.find((row) => row.id === provider.id);
    if (
      !canonical ||
      preparedIrDataMismatch(canonical, provider) !== undefined ||
      canonical.implementation.kind !== "runtime-callable" ||
      provider.dependencies.length ||
      provider.hostCapabilities.length
    )
      return false;
    const symbol = canonical.implementation.symbol;
    const resources = physical.numberRemainders.filter((row) => row.symbol === symbol);
    if (resources.length !== 1) return false;
    const resource = resources[0]!;
    const entry = program.abi.entries.find((row) => row.plan.id === resource.bindingId);
    if (!entry || entry.contract.kind !== "callable") return false;
    const declaration = irNumberRemainderCallableDeclaration(entry.contract.ref);
    const slot = emittedProgramBindingIndex(emission, resource.bindingId);
    return (
      declaration?.feature === provider.feature &&
      entry.plan.structuralReferenceKey === resource.referenceKey &&
      preparedIrDataMismatch(entry.contract.params, declaration.params) === undefined &&
      preparedIrDataMismatch(entry.contract.results, declaration.results) === undefined &&
      slot?.space === "function" &&
      support.some((row) => row.key === resource.bindingId && row.index === slot.index) &&
      physicalCallableMatches(emission, resource.bindingId, {
        params: [{ kind: "f64" }, { kind: "f64" }],
        results: [{ kind: "f64" }],
      })
    );
  });
}
function checkResourceDemand(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
  gap: GapRecorder,
): void {
  const mod = emission.module;
  const runtime = program.runtime.filter((row) => row.backend === backend.backend && row.target === backend.target);
  if (runtime.length !== 1) gap("runtime", "runtime-projection", "one genuine selected runtime projection is required");
  else {
    const manifest = runtime[0]!.prepared.manifest;
    if (
      manifest.hostCapabilities.length ||
      manifest.hostCapabilityRecords.length ||
      !numberRemainderSupportMatches(program, emission, manifest.providers) ||
      runtime[0]!.prepared.functions.some((fn) => fn.asyncPlan || fn.asyncRuntime)
    )
      gap("runtime", "runtime-demand", "host provider or async demand is outside this numeric presentation contract");
  }
  if (
    program.ir.functions.some((fn) => fn.asyncPlan || fn.asyncRuntime) ||
    program.runtimeSupport?.batches.length ||
    mod.asyncFunctions.size
  )
    gap("async", "async-demand", "source and prepared runtime must independently prove no async/support demand");
  if (
    mod.imports.length ||
    mod.stringPool.length ||
    mod.stringLiteralValues.size ||
    mod.externClasses.length ||
    mod.nodeBuiltinModules.size ||
    mod.jsxImportSource !== undefined
  )
    gap(
      "resources",
      "resource-demand",
      "live imports/string/extern/JSX resources require an explicit presentation contract",
    );
  if (mod.exportSignatures !== undefined)
    gap(
      "exportSignatures",
      "boundary-metadata",
      "numeric boundary absence must be preserved, not filled with all-other rows",
    );
  if (
    mod.functions.some((fn) => fn.locals.some((local) => local.type.kind === "ref") || bodyNeedsWidening(fn.body)) ||
    mod.types.some(typeNeedsWidening) ||
    mod.globals.some((global) => global.type.kind === "ref")
  )
    gap(
      "physical",
      "widening-demand",
      "nondefaultable reference widening needs a separately authenticated physical post-state",
    );
}
function joinStartup(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  input: IrWholeProgramPreparationInput,
  gap: GapRecorder,
): IrProgramPresentationStartup {
  const mod = emission.module;
  const executable = program.startup.filter((row) => row.executable);
  if (
    program.startup.length !== program.inventory.sources.length ||
    program.startup.some(
      (row, index) =>
        row.sourceId !== program.inventory.sources[index]?.id ||
        row.gaps.length ||
        row.invocation.target !== "host" ||
        row.executable !== (row.evaluations.length > 0 || row.liveSeeds.length > 0),
    )
  )
    gap(
      "startup",
      "startup-census",
      "source order, executable evaluations and startup policy must be complete and consistent",
    );
  const adapterIndex = emittedStartupAdapterIndex(emission);
  let startup: IrProgramPresentationStartup = Object.freeze({ kind: "none", hasTopLevelStatements: false });
  if (executable.length === 0) {
    if (
      adapterIndex !== undefined ||
      mod.startFuncIdx !== undefined ||
      program.startup.some((row) => row.invocation.kind !== "none")
    )
      gap(
        "startup",
        "unexpected-startup",
        "zero executable demand must have no authenticated startup adapter or Wasm start",
      );
  } else {
    const unitIds = Object.freeze(executable.flatMap((row) => (row.unitId ? [row.unitId] : [])));
    if (adapterIndex !== undefined) {
      const adapter = mod.functions[adapterIndex - functionImportCount(mod)];
      const signature = adapter && mod.types[adapter.typeIdx];
      const slots = unitIds.map((unitId) => {
        const matches = program.abi.entries.filter(
          (entry) =>
            entry.plan.intent.kind === "callable" &&
            entry.plan.intent.unitId === unitId &&
            entry.plan.slotPolicy === "required",
        );
        return matches.length === 1 ? emittedProgramBindingIndex(emission, matches[0]!.plan.id) : undefined;
      });
      if (
        !signature ||
        signature.kind !== "func" ||
        signature.params.length ||
        signature.results.length ||
        !adapter ||
        adapter.locals.length ||
        adapter.body.length !== unitIds.length ||
        adapter.body.some(
          (instruction, index) =>
            instruction.op !== "call" ||
            slots[index]?.space !== "function" ||
            absoluteFuncIndex(mod, instruction.funcIdx) !== slots[index]?.index,
        )
      )
        gap(
          "startup",
          "startup-call-order",
          "completed adapter must call each authenticated startup unit once in semantic order",
        );
    }
    if (
      unitIds.length !== executable.length ||
      adapterIndex === undefined ||
      !mod.functions[adapterIndex - functionImportCount(mod)]
    )
      gap("startup", "startup-adapter", "executable source units require a genuine completed physical startup adapter");
    else if (
      !input.deferTopLevelInit &&
      executable.every((row) => row.invocation.kind === "wasm-start") &&
      mod.startFuncIdx === adapterIndex
    )
      startup = Object.freeze({ kind: "wasm-start", hasTopLevelStatements: true, adapterIndex, unitIds });
    else if (
      input.deferTopLevelInit &&
      executable.every((row) => row.invocation.kind === "deferred-export") &&
      mod.startFuncIdx === undefined &&
      mod.exports.filter(
        (row) => row.name === "__module_init" && row.desc.kind === "func" && row.desc.index === adapterIndex,
      ).length === 1
    )
      startup = Object.freeze({
        kind: "deferred-export",
        hasTopLevelStatements: true,
        adapterIndex,
        unitIds,
        exportName: "__module_init",
      });
    else
      gap(
        "startup",
        "startup-disposition",
        "authenticated adapter and actual start/export disagree with captured invocation policy",
      );
  }
  return startup;
}
/** One synchronous source-capture/driver transaction, never an emitted-packet input. */
export function prepareIrProgramPresentation(request: IrProgramPresentationRequest): IrProgramPresentationResult {
  const gaps: IrProgramPresentationGap[] = [];
  const gap = (
    field: string,
    code: string,
    detail: string,
    association: Partial<IrProgramPresentationGap> = {},
  ): void => {
    gaps.push(Object.freeze({ ...association, field, code, detail }));
  };
  const capture = capturePresentation(request, gap);
  if (gaps.length) return unsupported(gaps);
  const result = runIrProgramDriver(capture.input, capture.backend);
  if (result.kind !== "emitted") return result;
  const { program, emission } = result;
  const mod = emission.module;
  emittedSupportFunctionReceipts(emission);
  const captures = joinDeclarations(program, capture, gap);
  const signatures: Record<string, ExportSignature> = Object.create(null);
  const mixed = [...captures.values()].some((row) => row.results.includes("promise"));
  const asyncNames = new Set<string>();
  const witExports: PreparedWitExport[] | undefined = capture.context.options.wit ? [] : undefined;
  const joinedExports = checkAbiExports(
    program,
    emission,
    capture,
    captures,
    gap,
    signatures,
    mixed,
    asyncNames,
    witExports,
  );
  if (witExports && (mixed || mod.imports.length)) {
    const promise = [...captures].find(([, declaration]) => declaration.results.includes("promise"));
    gap(
      "wit.resources",
      "unmapped-wit-resources",
      "requested scalar WIT requires no Promise, import or detached reference demand",
      {
        sourceFile: promise?.[1].sourceFile ?? capture.input.entrySource.fileName,
        unitId: promise?.[0],
      },
    );
  }
  if (mixed) checkMixedDemand(program, emission, capture.backend, captures, gap);
  else checkResourceDemand(program, emission, capture.backend, gap);
  const startup = joinStartup(program, emission, capture.input, gap);
  if (!mod.functions.length || !program.inventory.terminalUnits.length)
    gap("emission", "empty-population", "presentation requires genuine nonempty emitted and terminal populations");
  if (mixed)
    for (const row of emittedPhysicalSetupPlan(emission).asyncFrames?.frames ?? [])
      for (const callback of row.callbacks) joinedExports.add(callback.externalName);
  const physicalExportNames = new Set<string>();
  for (const row of mod.exports) {
    if (row.desc.kind !== "func" && row.desc.kind !== "global") continue;
    const duplicate = physicalExportNames.has(row.name);
    physicalExportNames.add(row.name);
    if (
      duplicate ||
      (!joinedExports.has(row.name) &&
        !(
          row.desc.kind === "func" &&
          startup.kind === "deferred-export" &&
          row.name === startup.exportName &&
          row.desc.index === startup.adapterIndex
        ))
    )
      gap(
        "exports",
        "unjoined-physical-export",
        "physical function/global exports require unique authenticated source or startup joins",
      );
  }
  if (gaps.length) return unsupported(gaps);
  if (Object.keys(signatures).length) mod.exportSignatures = Object.freeze(signatures);
  if (mixed) for (const name of asyncNames) mod.asyncFunctions.add(name);
  emittedSupportFunctionReceipts(emission);
  const presentation = Object.freeze({
    kind: "prepared-presentation" as const,
    program,
    emission,
    output: Object.freeze({ ...capture.context, preparedStartup: startup }),
    startup,
    ...(mixed ? { requiresDetachedFinalization: true as const } : {}),
  });
  if (mixed)
    mixedPresentations.set(presentation, {
      plan: emittedPhysicalSetupPlan(emission),
      original: observeModuleData(mod),
    });
  if (witExports)
    witPresentations.set(presentation, {
      emission,
      module: mod,
      plan: emittedPhysicalSetupPlan(emission),
      view: Object.freeze({ entryFile: capture.input.entrySource.fileName, exports: Object.freeze(witExports) }),
      original: observeModuleData(mod),
    });
  return presentation;
}

function sourcePromiseFulfillment(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const ambient = checker.resolveName("Promise", undefined, ts.SymbolFlags.Type, false);
  if (!ambient?.declarations?.length || !ambient.declarations.every((row) => row.getSourceFile().isDeclarationFile))
    return undefined;
  if (!(type.flags & ts.TypeFlags.Object) || type.getSymbol() !== ambient) return undefined;
  const args = checker.getTypeArguments(type as ts.TypeReference);
  return args.length === 1 ? args[0] : undefined;
}
function promiseContractMatches(
  declaration: DeclarationCapture,
  promise: Extract<PreparedIrProgram["abi"]["entries"][number]["contract"], { kind: "callable" }>["promise"],
): boolean {
  if (!declaration.fulfillment) return promise === undefined;
  return Boolean(
    promise &&
    promise.kind === "canonical-promise" &&
    promise.version === 1 &&
    promise.consumerContract === "promise-only" &&
    promise.settlementTiming === "always-async" &&
    promise.rejectionType === "dynamic" &&
    (declaration.fulfillment === "void"
      ? promise.fulfillmentType === null
      : sourceSlotMatches(declaration.fulfillment, promise.fulfillmentType ?? undefined)),
  );
}
function functionImportCount(mod: WasmModule): number {
  return mod.imports.filter((row) => row.desc.kind === "func").length;
}
function physicalTypes(
  emission: EmittedPreparedIrProgram,
  types: readonly PhysicalSignatureType[],
): readonly ValType[] | undefined {
  const result: ValType[] = [];
  for (const type of types) {
    if (type.kind === "support-ref") {
      const slot = emittedProgramBindingIndex(emission, type.ref.binding.bindingId);
      if (slot?.space !== "type") return undefined;
      result.push({ kind: type.nullable ? "ref_null" : "ref", typeIdx: slot.index });
    } else if (
      type.kind === "vec" ||
      type.kind === "string" ||
      type.kind === "closure" ||
      type.kind === "callable" ||
      type.kind === "boxed"
    )
      return undefined;
    else result.push(type);
  }
  return result;
}
function physicalCallableMatches(
  emission: EmittedPreparedIrProgram,
  id: IrBindingId,
  row: { readonly params: readonly PhysicalSignatureType[]; readonly results: readonly PhysicalSignatureType[] },
): boolean {
  const slot = emittedProgramBindingIndex(emission, id);
  if (slot?.space !== "function") return false;
  const mod = emission.module;
  const imports = mod.imports.filter((entry) => entry.desc.kind === "func");
  const typeIdx = slot.index < imports.length ? imports[slot.index]!.desc : mod.functions[slot.index - imports.length];
  const signature = typeIdx && "typeIdx" in typeIdx ? mod.types[typeIdx.typeIdx] : undefined;
  const params = physicalTypes(emission, row.params),
    results = physicalTypes(emission, row.results);
  return Boolean(
    signature?.kind === "func" &&
    params &&
    results &&
    preparedIrDataMismatch(params, signature.params) === undefined &&
    preparedIrDataMismatch(results, signature.results) === undefined,
  );
}
function checkMixedImports(emission: EmittedPreparedIrProgram, plan: PhysicalSetupPlan, gap: GapRecorder): void {
  const imports = emission.module.imports.filter((row) => row.desc.kind === "func");
  const ids = new Set<IrBindingId>();
  if (imports.length !== plan.importedFunctions.length)
    gap("runtime.imports", "provider-census", "complete function import population differs from authenticated plan");
  for (const row of plan.importedFunctions) {
    const slot = emittedProgramBindingIndex(emission, row.bindingId);
    const physical = slot?.space === "function" && imports[slot.index];
    if (
      ids.has(row.bindingId) ||
      !physical ||
      physical.module !== row.module ||
      physical.name !== row.field ||
      !physicalCallableMatches(emission, row.bindingId, row)
    )
      gap("runtime.imports", "provider-join", "binding, provider coordinate and exact physical signature must join", {
        bindingId: row.bindingId,
      });
    ids.add(row.bindingId);
  }
}
function mixedProviderMatches(
  program: PreparedIrProgram,
  imported: NonNullable<PhysicalSetupPlan["asyncFrames"]>["frames"][number]["imports"][number],
): boolean {
  const manifest = program.runtime.find((row) => row.backend === "wasmgc" && row.target === "host")?.prepared.manifest;
  const records = manifest?.hostCapabilityRecords.filter((row) => row.capability === imported.capability) ?? [];
  const record = records[0];
  return (
    records.length === 1 &&
    record?.kind === "func" &&
    record.module === imported.module &&
    record.field === imported.field &&
    preparedIrDataMismatch(
      record.params,
      imported.params.map((row) => row.kind),
    ) === undefined &&
    preparedIrDataMismatch(
      record.results,
      imported.results.map((row) => row.kind),
    ) === undefined &&
    Boolean(
      manifest?.hostCapabilities.includes(imported.capability) &&
      manifest.providers.some(
        (row) =>
          row.hostCapabilities.includes(imported.capability) &&
          row.supportedBackends.includes("wasmgc") &&
          row.supportedTargets.includes("host"),
      ),
    )
  );
}
function checkMixedResources(emission: EmittedPreparedIrProgram, plan: PhysicalSetupPlan, gap: GapRecorder): void {
  const mod = emission.module;
  if (
    mod.stringPool.length ||
    mod.stringLiteralValues.size ||
    mod.externClasses.length ||
    mod.nodeBuiltinModules.size ||
    mod.jsxImportSource !== undefined ||
    mod.asyncFunctions.size
  )
    gap(
      "resources",
      "unjoined-mixed-resource",
      "unrelated string, extern, node, JSX or async declaration metadata has no presentation owner",
    );
  const globals = mod.imports.filter((row) => row.desc.kind === "global");
  if (globals.length !== plan.importedGlobals.length)
    gap(
      "resources.globals",
      "global-import-census",
      "global import population differs from the completed physical plan",
    );
  for (const row of plan.importedGlobals) {
    const slot = emittedProgramBindingIndex(emission, row.bindingId);
    const imported = slot?.space === "global" && globals[slot.index];
    if (
      !imported ||
      imported.module !== row.module ||
      imported.name !== row.field ||
      imported.desc.kind !== "global" ||
      imported.desc.mutable !== row.mutable ||
      preparedIrDataMismatch(imported.desc.type, row.type) !== undefined
    )
      gap(
        "resources.globals",
        "global-import-join",
        "global imports retain their separate authenticated binding and type",
        { bindingId: row.bindingId },
      );
  }
  const tags = mod.imports.filter((row) => row.desc.kind === "tag");
  const expectedImport = Number(plan.exceptionTag.required && plan.exceptionTag.shared);
  const expectedDefined = Number(plan.exceptionTag.required && !plan.exceptionTag.shared);
  if (
    tags.length !== expectedImport ||
    mod.tags.length !== expectedDefined ||
    mod.imports.some((row) => !["func", "global", "tag"].includes(row.desc.kind))
  )
    gap(
      "resources.tags",
      "exception-tag-census",
      "only the completed exception tag and separately joined imports are admitted",
    );
  for (const row of [
    ...tags.map((entry) => ({ name: entry.name, module: entry.module, desc: entry.desc })),
    ...mod.tags.map((entry) => ({ name: entry.name, module: undefined, desc: entry })),
  ]) {
    const signature = "typeIdx" in row.desc ? mod.types[row.desc.typeIdx] : undefined;
    if (
      row.name !== "__exn" ||
      (row.module !== undefined && row.module !== "env") ||
      signature?.kind !== "func" ||
      preparedIrDataMismatch(signature.params, [{ kind: "externref" }]) !== undefined ||
      signature.results.length
    )
      gap("resources.tags", "exception-tag-join", "exception tag requires its authentic externref payload signature");
  }
}
function checkMixedFrames(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  plan: PhysicalSetupPlan,
  gap: GapRecorder,
): void {
  const setup = plan.asyncFrames;
  const projection = program.runtime.find((row) => row.backend === "wasmgc" && row.target === "host");
  const owners = projection?.prepared.functions.filter((fn) => fn.asyncPlan || fn.asyncRuntime) ?? [];
  const existing = new Set(program.abi.entries.map((row) => row.plan.id));
  const introduced = new Map(
    (setup?.frames.flatMap((frame) => frame.entries) ?? [])
      .filter((row) => !existing.has(row.id))
      .map((row) => [row.id, row]),
  );
  if (
    introduced.size !== setup?.entries.length ||
    setup?.entries.some((row) => preparedIrDataMismatch(introduced.get(row.id), row) !== undefined)
  )
    gap("async.entries", "frame-entry-census", "complete supplemental frame entries must join the same physical plan");
  const seen = new Set<IrUnitId>(),
    callbacks = new Set<string>(),
    callbackIds = new Set<number>();
  if (!setup?.frames.length || owners.length !== setup.frames.length)
    gap("async.frames", "frame-census", "selected real async owners and completed frames must match completely");
  for (const frame of setup?.frames ?? []) {
    const owner = owners.filter((fn) => fn.unitId === frame.owner);
    if (seen.has(frame.owner) || owner.length !== 1 || !owner[0]?.asyncPlan || !owner[0]?.asyncRuntime)
      gap("async.frames", "frame-owner", "frame must have a unique genuine prepared async attachment", {
        unitId: frame.owner,
      });
    seen.add(frame.owner);
    const primary = program.abi.entries.filter((row) => row.plan.id === frame.primary.bindingId);
    if (
      primary.length !== 1 ||
      primary[0]!.plan.intent.kind !== "callable" ||
      primary[0]!.plan.intent.unitId !== frame.owner ||
      preparedIrDataMismatch(primary[0]!.plan, frame.primary.entry) !== undefined
    )
      gap("async.frames", "primary-owner", "primary ABI binding and frame owner must be the same source callable", {
        unitId: frame.owner,
      });
    for (const callable of [frame.primary, ...Object.values(frame.auxiliaries)])
      if (!physicalCallableMatches(emission, callable.bindingId, callable))
        gap("async.frames", "frame-callable", "frame primary and auxiliaries require exact completed signatures", {
          bindingId: callable.bindingId,
        });
    for (const imported of frame.imports) {
      const matches = plan.importedFunctions.filter((row) => row.bindingId === imported.bindingId);
      if (
        matches.length !== 1 ||
        !mixedProviderMatches(program, imported) ||
        preparedIrDataMismatch(matches[0], {
          bindingId: imported.bindingId,
          referenceKey: imported.referenceKey,
          module: imported.module,
          field: imported.field,
          params: imported.params,
          results: imported.results,
        }) !== undefined
      )
        gap(
          "async.imports",
          "frame-provider",
          "frame import requires an authentic provider and complete matching physical plan row",
          { bindingId: imported.bindingId },
        );
    }
    for (const callback of frame.callbacks) {
      const entry = setup?.entries.filter((row) => row.id === callback.entry.id);
      const slot = emittedProgramBindingIndex(emission, callback.targetBindingId);
      const exports = emission.module.exports.filter((row) => row.name === callback.externalName);
      if (
        callbackIds.has(callback.id) ||
        callbacks.has(callback.externalName) ||
        entry?.length !== 1 ||
        preparedIrDataMismatch(entry[0], callback.entry) !== undefined ||
        callback.entry.slotPolicy !== "alias" ||
        callback.entry.aliasOf !== callback.targetBindingId ||
        callback.entry.intent.kind !== "export" ||
        callback.entry.intent.externalName !== callback.externalName ||
        callback.entry.intent.targetId !== callback.targetBindingId ||
        slot?.space !== "function" ||
        exports.length !== 1 ||
        exports[0]?.desc.kind !== "func" ||
        exports[0].desc.index !== slot.index
      )
        gap(
          "async.callbacks",
          "callback-join",
          "callback identity, alias, intent and absolute export must join uniquely",
          { bindingId: callback.entry.id },
        );
      callbacks.add(callback.externalName);
      callbackIds.add(callback.id);
    }
  }
}
function checkMixedDemand(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
  captures: Map<IrUnitId, DeclarationCapture>,
  gap: GapRecorder,
): void {
  const plan = emittedPhysicalSetupPlan(emission);
  const runtime = program.runtime.filter((row) => row.backend === backend.backend && row.target === backend.target);
  if (
    backend.backend !== "wasmgc" ||
    backend.target !== "host" ||
    plan.backend !== "wasmgc" ||
    plan.target !== "host" ||
    runtime.length !== 1
  )
    gap("runtime", "mixed-projection", "mixed presentation requires one authentic wasmgc:host projection");
  for (const [unitId, declaration] of captures)
    if (declaration.fulfillment && !plan.asyncFrames?.frames.some((row) => row.owner === unitId))
      gap("async.frames", "source-frame", "captured Promise callable must join a completed async owner", { unitId });
  if (emission.module.exportSignatures !== undefined)
    gap("exportSignatures", "boundary-metadata", "source boundary metadata must be derived after all joins");
  const capabilities = new Set<string>(
    plan.asyncFrames?.frames.flatMap((frame) => frame.imports.map((row) => row.capability)),
  );
  if (
    runtime.length === 1 &&
    (runtime[0]!.prepared.manifest.hostCapabilityRecords.some((row) => !capabilities.has(row.capability)) ||
      runtime[0]!.prepared.manifest.hostCapabilities.length !== capabilities.size)
  )
    gap("runtime.providers", "provider-census", "every selected host capability requires a completed frame import");
  checkMixedResources(emission, plan, gap);
  checkMixedImports(emission, plan, gap);
  checkMixedFrames(program, emission, plan, gap);
}

export interface PreparedPresentationFinalization {
  readonly outputModule: WasmModule;
}
export interface PreparedPresentationFinalizationReceipt {
  readonly kind: "prepared-presentation-finalization";
  readonly phase: "after-reference-widening";
  readonly widenedSlots: number;
  readonly originalEmissionUnchanged: true;
}
type MixedPresentation = Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>;
const mixedPresentations = new WeakMap<
  MixedPresentation,
  { readonly plan: PhysicalSetupPlan; readonly original: readonly DataObservation[] }
>();
interface DataObservation {
  readonly value: object;
  readonly prototype: object | null;
  readonly extensible: boolean;
  readonly descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>;
  readonly map?: readonly (readonly [unknown, unknown])[];
  readonly set?: readonly unknown[];
  readonly bytes?: Uint8Array;
  readonly buffer?: ArrayBufferLike;
  readonly byteOffset?: number;
  readonly byteLength?: number;
}
interface FinalizationObservation {
  readonly presentation: MixedPresentation;
  readonly plan: PhysicalSetupPlan;
  readonly original: readonly DataObservation[];
  readonly output: readonly DataObservation[];
  readonly widening: ReadonlyMap<object, ReadonlyMap<PropertyKey, ValType>>;
}
const finalizations = new WeakMap<PreparedPresentationFinalization, FinalizationObservation>();
function finalizationFailure(code: string): never {
  throw new Error(`prepared presentation finalization: ${code}`);
}
/** A finite data copy preserves graph identity and property descriptors, never invokes accessors. */
function copyModuleData(module: WasmModule): WasmModule {
  const memo = new Map<object, object>();
  const buffers = new Map<ArrayBuffer, ArrayBuffer>();
  const copy = (value: unknown): unknown => {
    if (typeof value === "function" || typeof value === "symbol") finalizationFailure("unsupported-data");
    if (value === null || typeof value !== "object") return value;
    const prior = memo.get(value);
    if (prior) return prior;
    const prototype = Object.getPrototypeOf(value);
    let result: object;
    if (prototype === Map.prototype) result = new Map();
    else if (prototype === Set.prototype) result = new Set();
    else if (prototype === Uint8Array.prototype) {
      const bytes = value as Uint8Array;
      if (!(bytes.buffer instanceof ArrayBuffer)) return finalizationFailure("unsupported-buffer");
      let buffer = buffers.get(bytes.buffer);
      if (!buffer) {
        buffer = bytes.buffer.slice(0);
        buffers.set(bytes.buffer, buffer);
      }
      result = new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
    } else if (Array.isArray(value) && prototype === Array.prototype) result = [];
    else if (prototype === Object.prototype || prototype === null) result = Object.create(prototype);
    else return finalizationFailure("unsupported-prototype");
    memo.set(value, result);
    if (value instanceof Map)
      for (const [key, entry] of Map.prototype.entries.call(value))
        (result as Map<unknown, unknown>).set(copy(key), copy(entry));
    if (value instanceof Set)
      for (const entry of Set.prototype.values.call(value)) (result as Set<unknown>).add(copy(entry));
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, "value")) finalizationFailure("unsupported-accessor");
      if (value instanceof Uint8Array && typeof key === "string" && /^\d+$/.test(key)) continue;
      Object.defineProperty(result, key, { ...descriptor, value: copy(descriptor.value) });
    }
    if (!Object.isExtensible(value)) Object.preventExtensions(result);
    return result;
  };
  return copy(module) as WasmModule;
}
function observeModuleData(module: WasmModule): readonly DataObservation[] {
  const observations: DataObservation[] = [],
    visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, "value")) finalizationFailure("unsupported-accessor");
      descriptors.set(key, { ...descriptor });
      visit(descriptor.value);
    }
    const map = value instanceof Map ? [...Map.prototype.entries.call(value)] : undefined;
    const set = value instanceof Set ? [...Set.prototype.values.call(value)] : undefined;
    for (const [key, entry] of map ?? []) {
      visit(key);
      visit(entry);
    }
    for (const entry of set ?? []) visit(entry);
    observations.push({
      value,
      prototype: Object.getPrototypeOf(value),
      extensible: Object.isExtensible(value),
      descriptors,
      ...(map ? { map } : {}),
      ...(set ? { set } : {}),
      ...(value instanceof Uint8Array
        ? {
            bytes: new Uint8Array(value.buffer).slice(),
            buffer: value.buffer,
            byteOffset: value.byteOffset,
            byteLength: value.byteLength,
          }
        : {}),
    });
  };
  visit(module);
  return observations;
}
function sameSequence(before: readonly unknown[], after: readonly unknown[]): boolean {
  return before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
}
function verifyDataObservation(
  observation: DataObservation,
  allowed?: ReadonlyMap<PropertyKey, ValType>,
  known?: ReadonlySet<object>,
  replacements?: Set<object>,
): void {
  const { value, descriptors } = observation;
  if (
    Object.getPrototypeOf(value) !== observation.prototype ||
    Object.isExtensible(value) !== observation.extensible ||
    !sameSequence([...descriptors.keys()], Reflect.ownKeys(value))
  )
    finalizationFailure("output-changed");
  for (const [key, before] of descriptors) {
    const after = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      !Object.hasOwn(after, "value") ||
      before.writable !== after.writable ||
      before.enumerable !== after.enumerable ||
      before.configurable !== after.configurable
    )
      finalizationFailure("output-changed");
    const type = allowed?.get(key);
    if (type?.kind === "ref") {
      const widened: unknown = after.value;
      if (
        !widened ||
        typeof widened !== "object" ||
        Object.getPrototypeOf(widened) !== Object.prototype ||
        !Object.isExtensible(widened) ||
        !sameSequence(Reflect.ownKeys(widened), ["kind", "typeIdx"])
      )
        finalizationFailure("output-changed");
      if (known?.has(widened) || replacements?.has(widened)) finalizationFailure("output-changed");
      replacements?.add(widened);
      const kind = Object.getOwnPropertyDescriptor(widened, "kind"),
        index = Object.getOwnPropertyDescriptor(widened, "typeIdx");
      if (
        !kind ||
        !index ||
        !Object.hasOwn(kind, "value") ||
        !Object.hasOwn(index, "value") ||
        !kind.writable ||
        !kind.enumerable ||
        !kind.configurable ||
        !index.writable ||
        !index.enumerable ||
        !index.configurable ||
        kind.value !== "ref_null" ||
        index.value !== type.typeIdx
      )
        finalizationFailure("output-changed");
    } else if (!Object.is(before.value, after.value)) finalizationFailure("output-changed");
  }
  if (
    observation.map &&
    (!(value instanceof Map) ||
      value.size !== observation.map.length ||
      observation.map.some(([key, entry], index) => {
        const current = [...Map.prototype.entries.call(value)][index]!;
        return !Object.is(key, current[0]) || !Object.is(entry, current[1]);
      }))
  )
    finalizationFailure("output-changed");
  if (
    observation.set &&
    (!(value instanceof Set) || !sameSequence(observation.set, [...Set.prototype.values.call(value)]))
  )
    finalizationFailure("output-changed");
  if (
    observation.bytes &&
    (!(value instanceof Uint8Array) ||
      value.buffer !== observation.buffer ||
      value.byteOffset !== observation.byteOffset ||
      value.byteLength !== observation.byteLength ||
      !sameSequence([...observation.bytes], [...new Uint8Array(value.buffer)]))
  )
    finalizationFailure("output-changed");
}
function wideningSlots(mod: WasmModule): ReadonlyMap<object, ReadonlyMap<PropertyKey, ValType>> {
  const result = new Map<object, Map<PropertyKey, ValType>>();
  const add = (parent: object, key: PropertyKey, type: ValType): void => {
    if (type.kind !== "ref") return;
    const slots = result.get(parent) ?? new Map<PropertyKey, ValType>();
    slots.set(key, type);
    result.set(parent, slots);
  };
  const type = (row: TypeDef): void => {
    switch (row.kind) {
      case "func":
        row.params.forEach((val, index) => add(row.params, String(index), val));
        row.results.forEach((val, index) => add(row.results, String(index), val));
        break;
      case "struct":
        row.fields.forEach((field) => add(field, "type", field.type));
        break;
      case "array":
        add(row, "element", row.element);
        break;
      case "rec":
        row.types.forEach(type);
        break;
      case "sub":
        type(row.type);
        break;
    }
  };
  const visited = new Set<Instr[]>();
  const body = (rows: Instr[]): void => {
    if (visited.has(rows)) return;
    visited.add(rows);
    for (const row of rows) {
      if ("blockType" in row && row.blockType.kind === "val") add(row.blockType, "type", row.blockType.type);
      switch (row.op) {
        case "block":
        case "loop":
        case "try_table":
          body(row.body);
          break;
        case "if":
          body(row.then);
          if (row.else) body(row.else);
          break;
        case "try":
          body(row.body);
          row.catches.forEach((entry) => body(entry.body));
          if (row.catchAll) body(row.catchAll);
          break;
      }
    }
  };
  mod.types.forEach(type);
  for (const fn of mod.functions) {
    fn.locals.forEach((local) => add(local, "type", local.type));
    body(fn.body);
  }
  mod.globals.forEach((row) => add(row, "type", row.type));
  for (const row of mod.imports) if (row.desc.kind === "global") add(row.desc, "type", row.desc.type);
  return result;
}
export function beginPreparedPresentationFinalization(
  presentation: MixedPresentation,
): PreparedPresentationFinalization {
  const record = mixedPresentations.get(presentation);
  if (!record || presentation.requiresDetachedFinalization !== true) finalizationFailure("invalid-presentation");
  mixedPresentations.delete(presentation);
  const { plan, original } = record;
  for (const row of original) verifyDataObservation(row);
  if (emittedPhysicalSetupPlan(presentation.emission) !== plan) finalizationFailure("invalid-presentation");
  const outputModule = copyModuleData(presentation.emission.module);
  const token = Object.freeze({ outputModule });
  finalizations.set(token, {
    presentation,
    plan,
    original,
    output: observeModuleData(outputModule),
    widening: wideningSlots(outputModule),
  });
  return token;
}
export function completePreparedPresentationFinalization(
  token: PreparedPresentationFinalization,
): PreparedPresentationFinalizationReceipt {
  const observation = finalizations.get(token);
  if (!observation) finalizationFailure("invalid-token");
  finalizations.delete(token);
  try {
    for (const row of observation.original) verifyDataObservation(row);
  } catch {
    finalizationFailure("original-changed");
  }
  const known = new Set([...observation.original, ...observation.output].map((row) => row.value)),
    replacements = new Set<object>();
  for (const row of observation.output)
    verifyDataObservation(row, observation.widening.get(row.value), known, replacements);
  if (emittedPhysicalSetupPlan(observation.presentation.emission) !== observation.plan)
    finalizationFailure("original-changed");
  return Object.freeze({
    kind: "prepared-presentation-finalization",
    phase: "after-reference-widening",
    widenedSlots: [...observation.widening.values()].reduce((total, slots) => total + slots.size, 0),
    originalEmissionUnchanged: true,
  });
}

interface WitPresentationObservation {
  readonly emission: EmittedPreparedIrProgram;
  readonly module: WasmModule;
  readonly plan: PhysicalSetupPlan;
  readonly view: PreparedWitView;
  readonly original: readonly DataObservation[];
}
const witPresentations = new WeakMap<object, WitPresentationObservation>();
/** Requested-only, authentic completed presentation view; never a caller data capability. */
export function preparedPresentationWitView(
  presentation: Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>,
  module: WasmModule,
): PreparedWitView {
  const observation = witPresentations.get(presentation);
  if (!observation) throw new Error("prepared presentation WIT: invalid presentation");
  if (module !== observation.module) throw new Error("prepared presentation WIT: foreign module");
  try {
    for (const row of observation.original) verifyDataObservation(row);
    emittedSupportFunctionReceipts(observation.emission);
    if (emittedPhysicalSetupPlan(observation.emission) !== observation.plan)
      throw new Error("prepared presentation WIT: physical plan changed");
  } catch (error) {
    witPresentations.delete(presentation);
    throw error;
  }
  return observation.view;
}
