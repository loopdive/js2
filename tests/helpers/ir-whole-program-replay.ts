// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — shared "accept → emit → instantiate → compare" path used by
// the vitest suite and by the fresh-process replay runner. Emission is the
// consumer's own one-argument `emitAcceptedIrProgram`; this helper supplies no
// resolver, assembler or reservation. There is no source, checker, AST or
// frontend context on this path.

import { emitBinary } from "../../src/emit/binary.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../../src/ir/program-consumer.js";
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
  for (const entry of emitted.module.imports) {
    if (entry.desc.kind === "tag") {
      (imports[entry.module] ??= {})[entry.name] = new WebAssembly.Tag({ parameters: ["externref"] });
    }
  }
  const { instance } = await WebAssembly.instantiate(binary, imports);
  return { kind: "ran", run: { accepted: acceptance, emitted, bytes: binary.byteLength, exports: instance.exports } };
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
