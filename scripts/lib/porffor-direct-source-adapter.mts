// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PORFFOR_IR_COMMIT,
  assertPorfforCommit,
  assertPorfforRendererInput,
  porfforRendererOutputText,
  type PorfforRendererInput,
} from "../../src/ir/backend/porffor/compat.js";
import {
  PORFFOR_DIRECT_AB_FUNCTION,
  findExactFunction,
  normalizePinnedPorfforCForClang,
  porfforJsvalType,
  type DirectPorfforSafetyFinding,
} from "./porffor-direct-ab.mjs";

interface MutableRendererInput extends Omit<PorfforRendererInput, "entry"> {
  entry: string | null;
}

interface PorfforCompilerResult extends PorfforRendererInput {
  readonly times: readonly number[];
}

interface PorfforCompilerModule {
  readonly default: (source: string, module: boolean, run: boolean) => unknown;
}

interface PorfforGlobals {
  Prefs?: Record<string, unknown>;
  file?: string;
  compileCallback?: (input: unknown) => void;
  onProgress?: (message: string, elapsedMs: number) => void;
}

export interface DirectSourceAdapterOptions {
  readonly sourcePath: string;
  readonly source: string;
  readonly porfforRoot: string;
  readonly rawOutputPath: string;
  readonly gc: boolean;
}

/**
 * Additive generic form of the #3482 adapter. The source and Porffor command
 * model are unchanged; callers only identify the exported unary function that
 * the common native boundary should invoke. Keeping this API here prevents
 * benchmark-specific copies of Porffor's process-global callback protocol.
 */
export interface DirectProgramAdapterOptions extends DirectSourceAdapterOptions {
  readonly functionName: string;
  readonly sourceParameterName: string;
}

export interface DirectProgramAdapterResult {
  readonly renderedC: string;
  readonly input: PorfforRendererInput;
  readonly functionIndex: number;
  readonly functionSymbol: string;
  readonly entrySymbol: "p0__23main";
  readonly renderedParameterCount: 3;
  readonly compilePhasesMs: {
    readonly porfforParseMs: number;
    readonly porfforCodegenMs: number;
    readonly porfforRenderMs: number;
  };
  readonly commandModel: readonly string[];
  readonly compatibilityNormalizations: readonly string[];
}

export interface DirectSourceAdapterResult {
  readonly renderedC: string;
  readonly input: PorfforRendererInput;
  readonly functionIndex: 1;
  readonly functionSymbol: string;
  readonly entrySymbol: "p0__23main";
  readonly renderedParameterCount: 3;
  readonly compilePhasesMs: {
    readonly porfforParseMs: number;
    readonly porfforCodegenMs: number;
    readonly porfforRenderMs: number;
  };
  readonly commandModel: readonly string[];
  readonly compatibilityNormalizations: readonly string[];
  readonly safetyFinding: DirectPorfforSafetyFinding;
}

export async function compileDirectPorfforSource(
  options: DirectSourceAdapterOptions,
): Promise<DirectSourceAdapterResult> {
  const generic = await compileDirectPorfforProgram({
    ...options,
    functionName: PORFFOR_DIRECT_AB_FUNCTION,
    sourceParameterName: "seed",
  });
  if (generic.functionIndex !== 1) {
    throw new Error(`direct Porffor canary function index changed: received ${generic.functionIndex}`);
  }
  const safetyFinding = assertPinnedDirectObjectEntries(generic.renderedC, options.gc, PORFFOR_IR_COMMIT);
  assertPinnedCanaryC(generic.renderedC);
  return {
    ...generic,
    functionIndex: 1,
    safetyFinding,
  };
}

export async function compileDirectPorfforProgram(
  options: DirectProgramAdapterOptions,
): Promise<DirectProgramAdapterResult> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.functionName)) {
    throw new Error(`direct Porffor function name is not a pinned-safe C identifier: ${options.functionName}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.sourceParameterName)) {
    throw new Error(`direct Porffor parameter name is not a pinned-safe identifier: ${options.sourceParameterName}`);
  }
  const actualCommit = execFileSync("git", ["-C", options.porfforRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assertPorfforCommit(actualCommit);

  const commandModel = [
    "porf",
    "c",
    "--module",
    "-O1",
    ...(options.gc ? [] : ["--no-gc"]),
    options.sourcePath,
    options.rawOutputPath,
  ] as const;
  if (commandModel.includes("native") || commandModel.some((arg) => arg.startsWith("--gc="))) {
    throw new Error("direct Porffor command model must use C output and boolean --no-gc only");
  }

  const globals = globalThis as unknown as PorfforGlobals;
  const savedArgv = process.argv;
  const savedFile = globals.file;
  const savedCallback = globals.compileCallback;
  const savedProgress = globals.onProgress;
  process.argv = [process.execPath, join(options.porfforRoot, "porf"), ...commandModel.slice(1)];
  globals.file = options.sourcePath;

  let callbackCount = 0;
  let captured: MutableRendererInput | undefined;
  const progress = new Map<string, number>();
  globals.onProgress = (message, elapsedMs) => {
    if (progress.has(message) || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new Error(`invalid pinned Porffor progress event ${JSON.stringify({ message, elapsedMs })}`);
    }
    progress.set(message, elapsedMs);
  };
  globals.compileCallback = (candidate) => {
    callbackCount++;
    if (callbackCount !== 1) throw new Error(`pinned Porffor compileCallback ran ${callbackCount} times`);
    assertPorfforRendererInput(candidate, actualCommit);
    const input = candidate as MutableRendererInput;
    if (input.entry !== "#main") throw new Error(`direct Porffor entry changed: received ${String(input.entry)}`);
    const entry = input.funcs.find((func) => func?.name === "#main");
    if (!entry || entry.index !== 0 || entry.params.length !== 0 || entry.retType !== porfforJsvalType()) {
      throw new Error("direct Porffor top-level entry ABI changed from pinned #main index 0 / () -> jsval");
    }

    const func = findExactFunction(input, options.functionName);
    const jsval = porfforJsvalType();
    const parameterNames = func.params.map((param) => param.name);
    if (
      func.index <= 0 ||
      func.retType !== jsval ||
      func.params.length !== 3 ||
      parameterNames[0] !== "#newtarget" ||
      parameterNames[1] !== "#this" ||
      parameterNames[2] !== options.sourceParameterName ||
      !func.params.every((param) => param.type === jsval)
    ) {
      throw new Error(
        `direct Porffor benchmark ABI changed: expected positive index (#newtarget,#this,${options.sourceParameterName}) jsval -> jsval, received ${JSON.stringify(
          {
            index: func.index,
            parameterNames,
            parameterTypes: func.params.map((param) => param.type),
            retType: func.retType,
          },
        )}`,
      );
    }
    if (input.prefs.gc !== (options.gc ? undefined : false)) {
      throw new Error(`direct Porffor GC preference changed: received ${String(input.prefs.gc)}`);
    }

    input.entry = null;
    assertPorfforRendererInput(input, actualCommit);
    captured = input;
  };

  try {
    const compilerPath = join(options.porfforRoot, "compiler", "index.js");
    const namespace = (await import(pathToFileURL(compilerPath).href)) as unknown as Partial<PorfforCompilerModule>;
    if (typeof namespace.default !== "function" || namespace.default.length !== 1) {
      throw new Error("pinned Porffor compiler/index.js default export arity changed from one required argument");
    }
    const prefs = globals.Prefs;
    if (!prefs || prefs.module !== true || prefs.gc !== (options.gc ? undefined : false)) {
      throw new Error(`pinned Porffor preference parser changed: ${JSON.stringify(prefs)}`);
    }
    prefs.target = "c";
    prefs.o = options.rawOutputPath;

    const returned = namespace.default(options.source, true, false);
    if (!captured || returned !== captured) {
      throw new Error("pinned Porffor compiler did not return the exact compileCallback renderer record");
    }
    const result = returned as PorfforCompilerResult;
    if (
      !Array.isArray(result.times) ||
      result.times.length !== 3 ||
      !result.times.every(Number.isFinite) ||
      !(result.times[0]! <= result.times[1]! && result.times[1]! <= result.times[2]!)
    ) {
      throw new Error(`pinned Porffor cg.times changed: ${JSON.stringify(result.times)}`);
    }
    for (const phase of ["parsed", "generated IR", "rendered C"]) {
      if (!progress.has(phase)) throw new Error(`pinned Porffor progress phase ${phase} was not observed`);
    }

    const rawC = porfforRendererOutputText(readFileSync(options.rawOutputPath, "utf8"));
    const renderedC = normalizePinnedPorfforCForClang(rawC, actualCommit);
    const capturedFunction = findExactFunction(captured, options.functionName);
    const functionSymbol = `p${capturedFunction.index}_${options.functionName}`;
    assertPinnedRenderedC(renderedC, functionSymbol);
    return {
      renderedC,
      input: captured,
      functionIndex: capturedFunction.index,
      functionSymbol,
      entrySymbol: "p0__23main",
      renderedParameterCount: 3,
      compilePhasesMs: {
        porfforParseMs: result.times[1]! - result.times[0]!,
        porfforCodegenMs: result.times[2]! - result.times[1]!,
        porfforRenderMs: progress.get("rendered C")!,
      },
      commandModel,
      compatibilityNormalizations: ["single pinned LP64 i64 printf vararg cast"],
    };
  } finally {
    process.argv = savedArgv;
    globals.file = savedFile;
    globals.compileCallback = savedCallback;
    globals.onProgress = savedProgress;
  }
}

function assertPinnedDirectObjectEntries(
  renderedC: string,
  gc: boolean,
  actualCommit: string,
): DirectPorfforSafetyFinding {
  assertPorfforCommit(actualCommit);
  const gcLoad = "*(f64*)(MEM + entry + 8)";
  const entryStore = "*(f64*)(MEM + entryPtr + 8u) = (value.val);";
  const entryLoad = "*(f64*)(MEM + entryPtr + 8u)";
  const gcLoadCount = renderedC.split(gcLoad).length - 1;
  const entryStoreCount = renderedC.split(entryStore).length - 1;
  const entryLoadCount = renderedC.split(entryLoad).length - 1 - entryStoreCount;
  if (gcLoadCount !== (gc ? 2 : 0) || entryStoreCount !== 3 || entryLoadCount !== 1) {
    throw new Error(
      `pinned direct-object f64 access sites changed: ${JSON.stringify({ gcLoadCount, entryStoreCount, entryLoadCount })}`,
    );
  }
  return {
    kind: "misaligned-dynamic-object-f64",
    objectEntryStrideBytes: 20,
    payloadOffsetBytes: 8,
    secondEntryPayloadOffsetBytes: 28,
    requiredAlignmentBytes: 8,
    rawAccessSites: { gcLoads: gcLoadCount, entryStores: 3, entryLoads: 1 },
  };
}

function assertPinnedRenderedC(renderedC: string, functionSymbol: string): void {
  const assertions = [
    [!/(?:^|\n)int main\s*\(/.test(renderedC), "generated main was not suppressed"],
    [renderedC.includes("static void porf_init(int argc, char** argv)"), "porf_init declaration changed"],
    [renderedC.includes("static void porf_data_init(void)"), "porf_data_init declaration changed"],
    [renderedC.includes("static void* porf_c_stack_top = NULL;"), "GC stack anchor declaration changed"],
    [renderedC.includes("static inline jsval porf_box_num(f64 d)"), "number boxing helper changed"],
    [renderedC.includes("static inline int porf_jv_is_num(jsval v)"), "number predicate helper changed"],
    [renderedC.includes("jsval p0__23main(void);"), "suppressed entry symbol changed"],
    [renderedC.includes(`jsval ${functionSymbol}(jsval, jsval, jsval);`), "benchmark C declaration changed"],
  ] as const;
  for (const [condition, message] of assertions) if (!condition) throw new Error(message);
}

function assertPinnedCanaryC(renderedC: string): void {
  const assertions = [
    [
      renderedC.includes("obj = porf_box(porf_alloc((i32)(16u + (u32)capacity * 20u), 7u), 7);"),
      "pinned approximately-56-byte dynamic object allocation changed",
    ],
    [
      renderedC.includes(`jsval p1_${PORFFOR_DIRECT_AB_FUNCTION}(jsval, jsval, jsval);`),
      "canary C declaration changed",
    ],
  ] as const;
  for (const [condition, message] of assertions) if (!condition) throw new Error(message);
}
