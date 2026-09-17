// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — shared "accept → emit → instantiate → compare" path used by
// the vitest suite and by the fresh-process replay runner. Emission is the
// consumer's own one-argument `emitAcceptedIrProgram`; this helper supplies no
// resolver, assembler or reservation. There is no source, checker, AST or
// frontend context on this path.

import { emitBinary } from "../../src/emit/binary.js";
import {
  acceptedPhysicalSetupPlan,
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
} from "../../src/ir/program-consumer.js";
import { assertCanonicalRuntimeHostCapabilityRecord } from "../../src/ir/runtime/host-capabilities.js";
import {
  createScalarHostAsyncImportAdapters,
  type HostAsyncImportAdapters,
} from "../../src/runtime/host-async-imports.js";
import { createHostImportCallState, type HostImportCallDescriptor } from "../../src/runtime/host-import-call-state.js";
import type {
  AcceptedPreparedIrProgram,
  EmittedPreparedIrProgram,
  PreparedIrBackendAcceptance,
  PreparedIrBackendOptions,
  PreparedIrProgram,
} from "../../src/ir/program.js";

export type ReplayBackend = PreparedIrBackendOptions["backend"];

/** The actual RuntimeTarget set (src/ir/runtime-manifest.ts); artifact target labels are a different domain. */
export const RUNTIME_TARGETS: readonly PreparedIrBackendOptions["target"][] = [
  "host",
  "strict-no-host",
  "standalone",
  "wasi",
];
export const RUNTIME_BACKENDS: readonly ReplayBackend[] = ["wasmgc", "linear"];

export function replayOptions(
  backend: ReplayBackend,
  target: PreparedIrBackendOptions["target"] = "host",
): PreparedIrBackendOptions {
  return {
    backend,
    target,
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "ir-whole-program-replay",
  };
}

export interface ReplayRun {
  readonly accepted: AcceptedPreparedIrProgram;
  readonly emitted: EmittedPreparedIrProgram;
  readonly bytes: number;
  readonly exports: WebAssembly.Exports;
}

export type ReplayOutcome =
  | { readonly kind: "ran"; readonly run: ReplayRun }
  | {
      readonly kind: "not-accepted";
      readonly failure: Exclude<PreparedIrBackendAcceptance, AcceptedPreparedIrProgram>;
    };

/** Accept, emit, instantiate. A not-accepted program is an outcome, never a silent skip. */
export async function replayProgram(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
): Promise<ReplayOutcome> {
  const acceptance = acceptPreparedIrProgram(program, options);
  if (acceptance.kind !== "accepted") return { kind: "not-accepted", failure: acceptance };
  const emitted = emitAcceptedIrProgram(acceptance);
  const binary = emitBinary(emitted.module);
  const imports: WebAssembly.Imports = {};
  const plan = acceptedPhysicalSetupPlan(acceptance);
  const callState = createHostImportCallState();
  const instanceState: { exports?: Record<string, Function> } = {};
  const adapters = createScalarHostAsyncImportAdapters(
    { getExports: () => instanceState.exports },
    callState.getCaughtException,
  );
  const records = acceptance.runtime.prepared.manifest.hostCapabilityRecords;
  for (const entry of emitted.module.imports) {
    if (entry.desc.kind === "tag") {
      if (!plan.exceptionTag.required || !plan.exceptionTag.shared)
        throw new Error("replay tag has no accepted reservation");
      (imports[entry.module] ??= {})[entry.name] = new WebAssembly.Tag({ parameters: ["externref"] });
      continue;
    }
    if (entry.desc.kind !== "func") throw new Error(`replay cannot materialize import ${entry.module}.${entry.name}`);
    const selected = records.filter(
      (record) => record.kind === "func" && record.module === entry.module && record.field === entry.name,
    );
    if (selected.length !== 1)
      throw new Error(`replay import ${entry.module}.${entry.name} lacks a unique canonical capability`);
    const record = selected[0]!;
    assertCanonicalRuntimeHostCapabilityRecord(record);
    if (record.kind !== "func") throw new Error("replay capability is not callable");
    const physical = plan.importedFunctions.filter((row) => row.module === entry.module && row.field === entry.name);
    const signature = emitted.module.types[entry.desc.typeIdx];
    if (
      physical.length !== 1 ||
      signature?.kind !== "func" ||
      JSON.stringify(signature.params.map((value) => value.kind)) !== JSON.stringify(record.params) ||
      JSON.stringify(signature.results.map((value) => value.kind)) !== JSON.stringify(record.results) ||
      JSON.stringify(physical[0]!.params.map((value) => value.kind)) !== JSON.stringify(record.params) ||
      JSON.stringify(physical[0]!.results.map((value) => value.kind)) !== JSON.stringify(record.results)
    )
      throw new Error(`replay import ${entry.name} contradicts the accepted capability signature`);
    const resolved = scalarAdapter(adapters, record.capability);
    const descriptor = { name: entry.name, paramCount: record.params.length, intent: resolved.intent };
    const guarded = callState.wrap(descriptor, resolved.fn, callState.registerImport(entry.name));
    (imports[entry.module] ??= {})[entry.name] = guarded.fn;
  }
  const { instance } = await WebAssembly.instantiate(binary, imports);
  instanceState.exports = instance.exports as Record<string, Function>;
  return { kind: "ran", run: { accepted: acceptance, emitted, bytes: binary.byteLength, exports: instance.exports } };
}

/** Capability IDs select shared production factories; import spellings never invent semantics. */
function scalarAdapter(
  adapters: HostAsyncImportAdapters,
  capability: string,
): { fn: Function; intent: HostImportCallDescriptor["intent"] } {
  switch (capability) {
    case "async.callback.wrap":
      return { fn: adapters.callbackMaker(), intent: { type: "callback_maker" } };
    case "async.exception.caught":
      return { fn: adapters.caughtException(), intent: { type: "caught_exception" } };
    case "number.box":
      return { fn: adapters.boxNumber(), intent: { type: "box", targetType: "number" } };
    case "number.unbox":
      return { fn: adapters.unboxNumber(), intent: { type: "unbox", targetType: "number" } };
    case "async.value.undefined":
      return { fn: adapters.undefinedValue(), intent: { type: "builtin", name: "__get_undefined" } };
    case "async.promise.capability.create":
      return {
        fn: adapters.promiseBuiltin("Promise_new_pending"),
        intent: { type: "builtin", name: "Promise_new_pending" },
      };
    case "async.promise.resolve":
      return { fn: adapters.promiseBuiltin("Promise_resolve"), intent: { type: "builtin", name: "Promise_resolve" } };
    case "async.promise.react":
      return { fn: adapters.promiseBuiltin("Promise_then2"), intent: { type: "builtin", name: "Promise_then2" } };
    case "async.promise.settle.fulfill":
      return {
        fn: adapters.promiseBuiltin("Promise_settle_resolve"),
        intent: { type: "builtin", name: "Promise_settle_resolve" },
      };
    case "async.promise.settle.reject":
      return {
        fn: adapters.promiseBuiltin("Promise_settle_reject"),
        intent: { type: "builtin", name: "Promise_settle_reject" },
      };
    default:
      throw new Error(`replay host capability ${capability} is not supported`);
  }
}

// ---------------------------------------------------------------------------
// Oracle comparison shared with the runner
// ---------------------------------------------------------------------------

/** JSON-safe expected value: plain JSON, or a codec-style tag for bigint / non-finite numbers. */
export type OracleValue =
  | number
  | boolean
  | string
  | null
  | { readonly $bigint: string }
  | { readonly $number: string };

export interface OracleCall {
  readonly export: string;
  readonly args: readonly number[];
  readonly expected: OracleValue;
  readonly mode?: "await-fulfill" | "await-reject";
  /** Immediate sample, zero to sixteen microtask samples, then settlement sample. */
  readonly checkpoints?: readonly { readonly export: string; readonly expected: OracleValue }[];
}

export interface OracleReport {
  readonly export: string;
  readonly args: readonly number[];
  readonly expected: string;
  readonly actual: string;
  readonly match: boolean;
}

const NUMBER_SPELLINGS = new Set(["-0", "NaN", "Infinity", "-Infinity"]);

/** Exact accepted oracle-value domain; anything else is malformed input, never a mismatch. */
export function oracleValueProblem(value: unknown): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : "non-finite or -0 numbers must use a $number tag";
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return "expected must be JSON null/boolean/string/number or a single-key tag";
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) return "a tagged expected value must have exactly one key";
  const payload = (value as Record<string, unknown>)[keys[0]!];
  if (keys[0] === "$bigint") {
    return typeof payload === "string" && /^-?(0|[1-9][0-9]*)$/.test(payload) && payload !== "-0"
      ? undefined
      : "$bigint payload must be a canonical decimal integer string";
  }
  if (keys[0] === "$number") {
    return typeof payload === "string" && NUMBER_SPELLINGS.has(payload)
      ? undefined
      : "$number payload must be one of -0, NaN, Infinity, -Infinity";
  }
  return `unknown expected-value tag ${keys[0]}`;
}

function decodeOracleValue(value: OracleValue): unknown {
  if (value !== null && typeof value === "object") {
    if ("$bigint" in value) return BigInt(value.$bigint);
    const spelled = value.$number;
    return spelled === "-0" ? -0 : Number(spelled);
  }
  return value;
}

function show(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  return JSON.stringify(value);
}

/** Compare declared exports: functions are called, globals are read. Values are validated first. */
export function compareExports(exports: WebAssembly.Exports, calls: readonly OracleCall[]): readonly OracleReport[] {
  return calls.map((call) => {
    const problem = oracleValueProblem(call.expected);
    if (problem) throw new Error(`malformed oracle value for ${call.export}: ${problem}`);
    const target = exports[call.export];
    const expected = decodeOracleValue(call.expected);
    if (typeof target === "function") {
      const actual = (target as (...args: number[]) => unknown)(...call.args);
      return {
        export: call.export,
        args: call.args,
        expected: show(expected),
        actual: show(actual),
        match: Object.is(actual, expected),
      };
    }
    if (target instanceof WebAssembly.Global) {
      if (call.args.length > 0) {
        return {
          export: call.export,
          args: call.args,
          expected: show(expected),
          actual: "<global takes no args>",
          match: false,
        };
      }
      const actual = target.value as unknown;
      return {
        export: call.export,
        args: call.args,
        expected: show(expected),
        actual: show(actual),
        match: Object.is(actual, expected),
      };
    }
    return { export: call.export, args: call.args, expected: show(expected), actual: "<missing export>", match: false };
  });
}

/** Additive call schema shared by the child and async comparator; sync extra fields remain compatible. */
export function oracleCallProblems(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["must be an object"];
  const call = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof call.export !== "string" || call.export.length === 0) problems.push("export must be a nonempty string");
  if (!Array.isArray(call.args) || !call.args.every((arg) => typeof arg === "number" && Number.isFinite(arg)))
    problems.push("args must be an array of finite numbers");
  if (!Object.hasOwn(call, "expected")) problems.push("lacks an expected value");
  else {
    const problem = oracleValueProblem(call.expected);
    if (problem) problems.push(`expected is malformed: ${problem}`);
  }
  if (Object.hasOwn(call, "mode") && call.mode !== "await-fulfill" && call.mode !== "await-reject")
    problems.push("mode must be await-fulfill or await-reject when present");
  if (Object.hasOwn(call, "checkpoints")) {
    if (call.mode !== "await-fulfill" && call.mode !== "await-reject")
      problems.push("checkpoints require an async mode");
    if (!Array.isArray(call.checkpoints) || call.checkpoints.length < 2 || call.checkpoints.length > 18)
      problems.push("checkpoints must contain 2 to 18 samples");
    else
      call.checkpoints.forEach((checkpoint, index) => {
        if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
          problems.push(`checkpoints[${index}] must be an object`);
          return;
        }
        if (typeof checkpoint.export !== "string" || checkpoint.export.length === 0)
          problems.push(`checkpoints[${index}].export must be a nonempty string`);
        const problem = oracleValueProblem(checkpoint.expected);
        if (!Object.hasOwn(checkpoint, "expected") || problem)
          problems.push(`checkpoints[${index}].expected is malformed: ${problem ?? "missing"}`);
      });
  }
  return problems;
}

const ASYNC_ORACLE_TIMEOUT_MS = 5000;

async function compareAwaitedExport(exports: WebAssembly.Exports, call: OracleCall): Promise<OracleReport[]> {
  const target = exports[call.export];
  if (typeof target !== "function") throw new Error(`async oracle export ${call.export} is not a function`);
  const result = target(...call.args);
  if (!(result instanceof Promise)) throw new Error(`async oracle export ${call.export} did not return a Promise`);
  // Attach both reactions before taking any checkpoint, including the immediate one.
  const settled = result.then(
    (value: unknown) => ({ mode: "await-fulfill", value }),
    (value: unknown) => ({ mode: "await-reject", value }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`async oracle ${call.export} timed out after ${ASYNC_ORACLE_TIMEOUT_MS}ms`)),
      ASYNC_ORACLE_TIMEOUT_MS,
    );
  });
  // Install timeout rejection handling immediately, even if a checkpoint throws.
  const outcome = Promise.race([settled, timeout]);
  void outcome.catch(() => {});
  const rows: OracleReport[] = [];
  const sample = (checkpoint: NonNullable<OracleCall["checkpoints"]>[number], index: number) => {
    const getter = exports[checkpoint.export];
    if (typeof getter !== "function")
      throw new Error(`async oracle checkpoint ${index} export ${checkpoint.export} is not a function`);
    const value = getter();
    rows.push({
      export: `${checkpoint.export} [checkpoint ${index}]`,
      args: [],
      expected: show(decodeOracleValue(checkpoint.expected)),
      actual: show(value),
      match: Object.is(value, decodeOracleValue(checkpoint.expected)),
    });
  };
  try {
    const checkpoints = call.checkpoints;
    if (checkpoints) {
      sample(checkpoints[0]!, 0);
      for (let index = 1; index < checkpoints.length - 1; index++) {
        await Promise.resolve();
        sample(checkpoints[index]!, index);
      }
    }
    const actual = await outcome;
    if (checkpoints) sample(checkpoints.at(-1)!, checkpoints.length - 1);
    const expected = decodeOracleValue(call.expected);
    rows.push({
      export: call.export,
      args: call.args,
      expected: `${call.mode}: ${show(expected)}`,
      actual: `${actual.mode}: ${show(actual.value)}`,
      match: actual.mode === call.mode && Object.is(actual.value, expected),
    });
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

/** Async replay is opt-in; existing synchronous comparison retains its exact behavior. */
export async function compareExportsAsync(
  exports: WebAssembly.Exports,
  calls: readonly OracleCall[],
): Promise<readonly OracleReport[]> {
  const problems = calls.flatMap((call, index) =>
    oracleCallProblems(call).map((problem) => `calls[${index}]: ${problem}`),
  );
  if (problems.length) throw new Error(`malformed oracle: ${problems.join("; ")}`);
  const rows: OracleReport[] = [];
  for (const call of calls) {
    if (call.mode === undefined) rows.push(...compareExports(exports, [call]));
    else rows.push(...(await compareAwaitedExport(exports, call)));
  }
  return rows;
}
