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
  emittedProgramBindingIndex,
  emittedStartupAdapterIndex,
  emittedSupportFunctionReceipts,
} from "../ir/program-consumer.js";
import type { IrUnitId, IrBindingId } from "../shared/contracts/ir-identity.js";
import type { ValType, TypeDef, Instr } from "../ir/types.js";
import { runIrProgramDriver } from "./ir-program-driver.js";
import type { IrProgramDriverResult } from "./ir-program-result.js";

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
    }
  | {
      readonly kind: "output-failed";
      readonly errors: CompileResult["errors"];
      readonly artifacts: PreparedIrPresentationArtifacts;
    }
  | Exclude<IrProgramPresentationResult, { kind: "prepared-presentation" }>;

interface DeclarationCapture {
  readonly sourceFile: string;
  readonly start: number;
  readonly end: number;
  readonly params: readonly string[];
  readonly results: readonly string[];
  readonly synchronous: boolean;
}
const numeric = (type: ValType): boolean => ["i32", "i64", "f32", "f64"].includes(type.kind);
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
  function classify(type: ts.Type): string | undefined {
    if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
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
        const params = node.parameters.map((param) => classify(input.checker.getTypeAtLocation(param)));
        const result = signature && classify(input.checker.getReturnTypeOfSignature(signature));
        const synchronous =
          !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && !node.asteriskToken;
        if (!signature || params.some((param) => param !== "number") || !result || !synchronous)
          gap(
            "declaration",
            "non-numeric-boundary",
            "complete synchronous numeric function declarations are required",
            { sourceFile: source.fileName },
          );
        else
          declarations.push(
            Object.freeze({
              sourceFile: source.fileName,
              start: node.getStart(source),
              end: node.end,
              params: Object.freeze(params as string[]),
              results: Object.freeze(result === "void" ? [] : [result]),
              synchronous,
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
        contract.promise ||
        [...contract.params, ...contract.results].some((type) => type.kind !== "val" || !numeric(type.val))
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
          contract.results.length !== declaration.results.length
        )
          gap("abi.callable", "signature-join", "source declaration and prepared callable arity disagree", {
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
      const global = slot?.space === "global" ? mod.globals[slot.index] : undefined;
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
      const fn = mod.functions[slot.index]; // zero imported functions is proved below
      const signature = fn && mod.types[fn.typeIdx];
      if (
        !signature ||
        signature.kind !== "func" ||
        signature.params.length !== declaration.params.length ||
        signature.results.length !== declaration.results.length ||
        [...signature.params, ...signature.results].some((type) => !numeric(type)) ||
        signature.params.some((type, index) => {
          const expected = target.contract.kind === "callable" && target.contract.params[index];
          return !expected || expected.kind !== "val" || expected.val.kind !== type.kind;
        }) ||
        signature.results.some((type, index) => {
          const expected = target.contract.kind === "callable" && target.contract.results[index];
          return !expected || expected.kind !== "val" || expected.val.kind !== type.kind;
        })
      )
        gap("exports", "physical-signature", "actual physical export signature disagrees with numeric source capture", {
          bindingId: plan.id,
          unitId,
        });
    }
  }
  return joinedExports;
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
      manifest.providers.length ||
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
      const adapter = mod.functions[adapterIndex];
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
    if (unitIds.length !== executable.length || adapterIndex === undefined || !mod.functions[adapterIndex])
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
  const joinedExports = checkAbiExports(program, emission, capture, captures, gap);
  checkResourceDemand(program, emission, capture.backend, gap);
  const startup = joinStartup(program, emission, capture.input, gap);
  if (!mod.functions.length || !program.inventory.terminalUnits.length)
    gap("emission", "empty-population", "presentation requires genuine nonempty emitted and terminal populations");
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
  return Object.freeze({
    kind: "prepared-presentation",
    program,
    emission,
    output: Object.freeze({ ...capture.context, preparedStartup: startup }),
    startup,
  });
}
