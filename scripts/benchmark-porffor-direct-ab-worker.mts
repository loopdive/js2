// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { compile } from "../src/index.js";
import { getLastLinearIrReport, type LinearIrResult } from "../src/ir/backend/linear-integration.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import {
  PORFFOR_KIND_NAMES,
  porfforRendererOutputText,
  type PorfforRendererInput,
} from "../src/ir/backend/porffor/compat.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import {
  PORFFOR_DIRECT_AB_FUNCTION,
  PORFFOR_DIRECT_AB_SCHEMA_VERSION,
  collectPorfforNodes,
  findExactFunction,
  isPorfforDirectAbRowId,
  normalizePinnedPorfforCForClang,
  porfforJsvalType,
  porfforType,
  readExactSource,
  sha256Hex,
  wrapperForDirectRow,
  wrapperForJs2Row,
  type CompilePhaseRecord,
  type PorfforDirectAbMode,
  type PorfforDirectAbRowId,
  type WorkerManifest,
} from "./lib/porffor-direct-ab.mjs";
import { compileDirectPorfforSource } from "./lib/porffor-direct-source-adapter.mjs";

interface WorkerArguments {
  readonly rowId: PorfforDirectAbRowId;
  readonly sourcePath: string;
  readonly sourceSha: string;
  readonly outputDirectory: string;
  readonly mode: PorfforDirectAbMode;
}

const args = parseWorkerArguments(process.argv.slice(2));
await runWorker(args);

export function parseWorkerArguments(argv: readonly string[]): WorkerArguments {
  const allowed = new Set(["--row", "--source", "--source-sha", "--output", "--mode"]);
  if (argv.length !== 10) throw new Error(workerUsage());
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1]!;
    if (!allowed.has(flag) || values.has(flag) || value.startsWith("--")) throw new Error(workerUsage());
    values.set(flag, value);
  }
  const row = values.get("--row")!;
  const mode = values.get("--mode")!;
  if (!isPorfforDirectAbRowId(row)) throw new Error(`unknown benchmark row ${row}`);
  if (mode !== "optimized" && mode !== "sanitize") throw new Error(`unknown benchmark mode ${mode}`);
  if (!/^[0-9a-f]{64}$/.test(values.get("--source-sha")!)) throw new Error("source SHA must be 64 lowercase hex");
  return {
    rowId: row,
    sourcePath: resolve(values.get("--source")!),
    sourceSha: values.get("--source-sha")!,
    outputDirectory: resolve(values.get("--output")!),
    mode,
  };
}

async function runWorker(options: WorkerArguments): Promise<void> {
  mkdirSync(options.outputDirectory, { recursive: true });
  const source = readExactSource(options.sourcePath, options.sourceSha);
  const porfforRoot = resolve("vendor/Porffor");
  const renderedPath = join(options.outputDirectory, "rendered.c");
  const wrapperPath = join(options.outputDirectory, "wrapper.c");
  const lanePath = join(options.outputDirectory, "lane.c");

  let renderedC: string;
  let wrapperC: string;
  let functionSymbol: string;
  let renderedParameterCount: number;
  let valueAbi: "boxed-jsval" | "raw-f64";
  let allocation: WorkerManifest["allocation"];
  let safety: WorkerManifest["safety"];
  let compilePhasesMs: CompilePhaseRecord;
  let commandProvenance: Readonly<Record<string, unknown>>;

  if (options.rowId === "direct-porffor-gc" || options.rowId === "direct-porffor-bump") {
    const gc = options.rowId === "direct-porffor-gc";
    const direct = await compileDirectPorfforSource({
      sourcePath: source.path,
      source: source.source,
      porfforRoot,
      rawOutputPath: join(options.outputDirectory, "porffor-raw.c"),
      gc,
    });
    renderedC = direct.renderedC;
    functionSymbol = direct.functionSymbol;
    renderedParameterCount = direct.renderedParameterCount;
    valueAbi = "boxed-jsval";
    wrapperC = wrapperForDirectRow({ gc, functionSymbol, entrySymbol: direct.entrySymbol });
    allocation = {
      policy: gc ? "porffor-default-gc" : "porffor-gc-false-bump",
      scope: "global",
      objectBytes: 56,
      objectBytesIsEstimate: true,
      allocationIds: [],
      allocationClasses: [gc ? "gc" : "bump"],
    };
    compilePhasesMs = {
      porfforParseMs: direct.compilePhasesMs.porfforParseMs,
      porfforCodegenMs: direct.compilePhasesMs.porfforCodegenMs,
      js2SourceToLinearTelemetryMs: null,
      js2IrToPorfforMs: null,
      porfforLoadMs: null,
      porfforRenderMs: direct.compilePhasesMs.porfforRenderMs,
    };
    commandProvenance = {
      directPorfforArgumentModel: direct.commandModel,
      compatibilityNormalizations: direct.compatibilityNormalizations,
      plainGeneratedC:
        "entry suppressed before render; rendered C otherwise changes only at the disclosed pinned LP64 printf cast",
    };
    safety = {
      generatedC: "plain-pinned-porffor",
      generatedCMutations: ["entry suppression before render", ...direct.compatibilityNormalizations],
      sanitizerExpectation: "misaligned-object-entry-ubsan",
      performanceAuthority: "ub-contaminated-non-authoritative",
      finding: direct.safetyFinding,
    };
  } else {
    const allocator = options.rowId === "js2-porffor-arena-v1" ? "bump" : "analysis-stack";
    const policy = allocator === "bump" ? "arena-v1" : "analysis-stack-arena-v1";
    const sourceStart = performance.now();
    const compiled = await compile(source.source, { target: "linear", allocator, fileName: source.path });
    const sourceMs = performance.now() - sourceStart;
    if (!compiled.success || !compiled.binary) {
      throw new Error(`JS2 source compile failed: ${compiled.errors.map((error) => error.message).join("; ")}`);
    }
    const report = getLastLinearIrReport();
    if (!report) throw new Error(`missing source-derived linear IR report for ${allocator}`);
    const allocationIds = assertSourceDerivedReport(report, policy, allocator === "bump" ? "arena" : "stack");

    const loweringStart = performance.now();
    const input = lowerIrModuleToPorffor(report.irModule, {
      memoryPlan: report.memoryPlan,
      prefs: { gc: false },
    });
    const loweringMs = performance.now() - loweringStart;
    assertJs2PorfforInput(input, allocator === "bump" ? "arena" : "stack");

    const loadStart = performance.now();
    const porffor = await loadOptionalPorffor({ root: porfforRoot });
    const loadMs = performance.now() - loadStart;
    const renderStart = performance.now();
    renderedC = normalizePinnedPorfforCForClang(porfforRendererOutputText(porffor.render(input)), porffor.commit);
    const renderMs = performance.now() - renderStart;
    if (/(?:^|\n)int main\s*\(/.test(renderedC)) throw new Error("JS2 Porffor row unexpectedly rendered main");

    const func = findExactFunction(input);
    functionSymbol = `p${func.index}_${func.name}`;
    renderedParameterCount = func.params.length;
    valueAbi = "raw-f64";
    wrapperC = wrapperForJs2Row(functionSymbol);
    allocation = {
      policy,
      scope: "per-site",
      objectBytes: 24,
      objectBytesIsEstimate: false,
      allocationIds,
      allocationClasses: report.memoryPlan.allocations.map((entry) => entry.allocationClass),
    };
    compilePhasesMs = {
      porfforParseMs: null,
      porfforCodegenMs: null,
      js2SourceToLinearTelemetryMs: sourceMs,
      js2IrToPorfforMs: loweringMs,
      porfforLoadMs: loadMs,
      porfforRenderMs: renderMs,
    };
    commandProvenance = {
      js2CompileOptions: { target: "linear", allocator, fileName: source.path },
      telemetry: "getLastLinearIrReport captured immediately after the public compile",
      lowering: "lowerIrModuleToPorffor(report.irModule, { memoryPlan: report.memoryPlan, prefs: { gc: false } })",
    };
    safety = {
      generatedC: "js2-porffor-ir",
      generatedCMutations: ["single pinned LP64 i64 printf vararg cast"],
      sanitizerExpectation: "clean",
      performanceAuthority: "within-machine-informational",
      finding: null,
    };
  }

  const laneC = `${renderedC}${wrapperC}`;
  writeFileSync(renderedPath, renderedC);
  writeFileSync(wrapperPath, wrapperC);
  writeFileSync(lanePath, laneC);
  const manifest: WorkerManifest = {
    schemaVersion: PORFFOR_DIRECT_AB_SCHEMA_VERSION,
    rowId: options.rowId,
    mode: options.mode,
    source: { path: source.path, sha256: source.sha256, bytes: source.bytes },
    function: {
      name: PORFFOR_DIRECT_AB_FUNCTION,
      symbol: functionSymbol,
      sourceParameterCount: 1,
      renderedParameterCount,
      valueAbi,
    },
    allocation,
    safety,
    compilePhasesMs,
    compilerPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    artifacts: {
      renderedCBytes: Buffer.byteLength(renderedC),
      wrapperBytes: Buffer.byteLength(wrapperC),
      combinedCBytes: Buffer.byteLength(laneC),
      cSha256: sha256Hex(laneC),
      renderedCSha256: sha256Hex(renderedC),
    },
    commandProvenance,
    outputFiles: {
      renderedC: basename(renderedPath),
      wrapperC: basename(wrapperPath),
      laneC: basename(lanePath),
    },
  };
  const manifestPath = join(options.outputDirectory, "worker.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ rowId: options.rowId, manifestPath })}\n`);
}

function assertSourceDerivedReport(
  report: LinearIrResult,
  policy: "arena-v1" | "analysis-stack-arena-v1",
  allocationClass: "arena" | "stack",
): number[] {
  if (
    report.compiled.length !== 1 ||
    report.compiled[0] !== PORFFOR_DIRECT_AB_FUNCTION ||
    report.rejected.length !== 0
  ) {
    throw new Error(`source-derived report selection changed: ${JSON.stringify(report)}`);
  }
  if (report.irModule.functions.length !== 1 || report.irModule.functions[0]?.name !== PORFFOR_DIRECT_AB_FUNCTION) {
    throw new Error("source-derived report no longer contains exactly the benchmark function");
  }
  const instructions: IrInstr[] = [];
  for (const block of report.irModule.functions[0]!.blocks) {
    for (const instruction of block.instrs) forEachInstrDeep(instruction, (nested) => instructions.push(nested));
  }
  const objectNews = instructions.filter((instruction) => instruction.kind === "object.new");
  const allocationIds = objectNews.map((instruction) => instruction.alloc as number);
  if (
    objectNews.length !== 2 ||
    allocationIds.some((id) => !Number.isInteger(id)) ||
    new Set(allocationIds).size !== 2
  ) {
    throw new Error(`source-derived object sites changed: ${JSON.stringify(allocationIds)}`);
  }
  if (allocationIds[0] !== 0 || allocationIds[1] !== 1) {
    throw new Error(`source-derived allocation ids changed from [0,1]: ${JSON.stringify(allocationIds)}`);
  }
  if (report.memoryPlan.policy !== policy) throw new Error(`memory plan policy changed to ${report.memoryPlan.policy}`);
  const allocations = report.memoryPlan.allocations.filter(
    (allocation) => allocation.ownerFunction === PORFFOR_DIRECT_AB_FUNCTION,
  );
  if (
    allocations.length !== 2 ||
    allocations.some(
      (allocation, index) =>
        allocation.id !== allocationIds[index] ||
        allocation.allocationKind !== "object" ||
        allocation.size.kind !== "constant" ||
        allocation.size.bytes !== 24 ||
        allocation.ownership !== "owned" ||
        allocation.escape !== "local" ||
        !allocation.stackCandidate ||
        allocation.allocationClass !== allocationClass ||
        allocation.root.kind !== "none" ||
        allocation.safepoints.kind !== "none" ||
        allocation.barrier.kind !== "none",
    )
  ) {
    throw new Error(`source-derived allocation plan changed: ${JSON.stringify(allocations)}`);
  }
  const layouts = new Set(allocations.map((allocation) => allocation.layoutId));
  if (layouts.size !== 1) throw new Error("benchmark allocations no longer share one canonical layout");
  const layout = report.memoryPlan.layouts.find((candidate) => layouts.has(candidate.id));
  if (!layout || layout.kind !== "record" || layout.size.kind !== "constant" || layout.size.bytes !== 24) {
    throw new Error(`canonical fixed-record layout changed: ${JSON.stringify(layout)}`);
  }
  if (allocationClass === "stack") {
    for (const allocation of allocations) {
      const operations = allocation.operations.map((operation) => `${operation.family}:${operation.operation}`);
      for (const required of ["memory:allocate", "stack:mark", "stack:restore"]) {
        if (!operations.includes(required))
          throw new Error(`stack plan is missing ${required}: ${JSON.stringify(operations)}`);
      }
    }
  }
  return allocationIds;
}

function assertJs2PorfforInput(input: PorfforRendererInput, allocationClass: "arena" | "stack"): void {
  if (input.entry !== null || input.prefs.gc !== false)
    throw new Error("JS2 Porffor input entry/GC preference changed");
  const func = findExactFunction(input);
  const f64 = porfforType("f64");
  const jsval = porfforJsvalType();
  if (
    func.params.length !== 1 ||
    func.params[0]?.type !== f64 ||
    func.retType !== f64 ||
    Object.values(func.locals).some((local) => local.type === jsval)
  ) {
    throw new Error("JS2 benchmark function is no longer raw f64 -> f64 without jsval locals");
  }
  const nodes = collectPorfforNodes(func.body);
  if (nodes.some((node) => node[1] === jsval)) throw new Error("JS2 benchmark function contains a jsval node");
  const names = nodes.map((node) => nodeName(node));
  const calls = nodes.filter((node) => nodeName(node) === "Call").map((node) => node[3]);
  if (allocationClass === "arena") {
    if (names.filter((name) => name === "Alloc").length !== 2 || calls.includes("#js2_stack_allocate")) {
      throw new Error("JS2 arena row no longer contains exactly two direct Alloc nodes");
    }
  } else {
    if (
      names.includes("Alloc") ||
      calls.filter((target) => target === "#js2_stack_allocate").length !== 2 ||
      !calls.includes("#js2_stack_mark") ||
      !calls.includes("#js2_stack_restore")
    ) {
      throw new Error("JS2 stack row no longer contains mark/two allocate/restore calls");
    }
    const allocator = input.funcs.find((candidate) => candidate?.name === "#js2_stack_allocate");
    if (!allocator || !collectPorfforNodes(allocator.body).some((node) => nodeName(node) === "Alloc")) {
      throw new Error("JS2 stack allocator no longer retains its arena overflow fallback");
    }
  }
  for (const forbidden of ["GcBarrier", "ArrGet", "ArrSet", "ArrLenSet", "LenGet", "LenSet", "RawC"]) {
    if (names.includes(forbidden)) throw new Error(`JS2 benchmark function contains forbidden ${forbidden}`);
  }
}

function nodeName(node: readonly [number, ...unknown[]]): string {
  return PORFFOR_KIND_NAMES[node[0]] ?? `kind-${node[0]}`;
}

function workerUsage(): string {
  return "usage: benchmark-porffor-direct-ab-worker.mts --row <id> --source <path> --source-sha <sha> --output <dir> --mode <optimized|sanitize>";
}
