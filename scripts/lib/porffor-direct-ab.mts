// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  PORFFOR_IR_COMMIT,
  PORFFOR_KIND_NAMES,
  PORFFOR_TYPE_ENTRIES,
  assertPorfforCommit,
  type PorfforFunctionRecord,
  type PorfforNode,
  type PorfforRendererInput,
} from "../../src/ir/backend/porffor/compat.js";

export const PORFFOR_DIRECT_AB_SCHEMA_VERSION = 1;
export const PORFFOR_DIRECT_AB_FUNCTION = "porfforSourceNativeCanary";
export const PORFFOR_DIRECT_AB_FIXTURE = "tests/fixtures/porffor-source-to-native-canary.ts";
export const PORFFOR_DIRECT_AB_ITERATIONS = 200_000;
export const PORFFOR_DIRECT_AB_SANITIZER_ITERATIONS = 20_000;
export const PORFFOR_DIRECT_AB_WARMUP_ROUNDS = 5;
export const PORFFOR_DIRECT_AB_MEASURED_ROUNDS = 21;
export const PORFFOR_DIRECT_AB_FIXED_SEEDS = [-7, 0, 4, 31] as const;
export const PORFFOR_DIRECT_AB_EXPECTED_FIXED = [-535, 235, 675, 3645] as const;
export const PORFFOR_DIRECT_AB_EXPECTED_CHECKSUM = 46_965_020;
export const PORFFOR_DIRECT_AB_EXPECTED_SANITIZER_CHECKSUM = 4_711_770;
export const PORFFOR_DIRECT_AB_GREEN_HEAD = "4c7e3a01d31275163ec9940e864c7292f6961b20";
export const PORFFOR_DIRECT_AB_VALIDATED_FIX = "559109b723d8c08c0469594db9591f40b1fdfad0";
export const PORFFOR_DIRECT_AB_SUPERSEDED_FIX = "2509181c33516ca1fe2462f7008650f2d99eb129";

export const PORFFOR_DIRECT_AB_ROWS = [
  "direct-porffor-gc",
  "direct-porffor-bump",
  "js2-porffor-arena-v1",
  "js2-porffor-analysis-stack-arena-v1",
] as const;

export type PorfforDirectAbRowId = (typeof PORFFOR_DIRECT_AB_ROWS)[number];
export type PorfforDirectAbMode = "optimized" | "sanitize";

export interface SourceDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source: string;
}

export interface CompilePhaseRecord {
  readonly porfforParseMs: number | null;
  readonly porfforCodegenMs: number | null;
  readonly js2SourceToLinearTelemetryMs: number | null;
  readonly js2IrToPorfforMs: number | null;
  readonly porfforLoadMs: number | null;
  readonly porfforRenderMs: number;
}

export interface WorkerArtifactRecord {
  readonly renderedCBytes: number;
  readonly wrapperBytes: number;
  readonly combinedCBytes: number;
  readonly cSha256: string;
  readonly renderedCSha256: string;
}

export interface DirectPorfforSafetyFinding {
  readonly kind: "misaligned-dynamic-object-f64";
  readonly objectEntryStrideBytes: 20;
  readonly payloadOffsetBytes: 8;
  readonly secondEntryPayloadOffsetBytes: 28;
  readonly requiredAlignmentBytes: 8;
  readonly rawAccessSites: {
    readonly gcLoads: number;
    readonly entryStores: 3;
    readonly entryLoads: 1;
  };
}

export interface WorkerManifest {
  readonly schemaVersion: 1;
  readonly rowId: PorfforDirectAbRowId;
  readonly mode: PorfforDirectAbMode;
  readonly source: Omit<SourceDescriptor, "source">;
  readonly function: {
    readonly name: typeof PORFFOR_DIRECT_AB_FUNCTION;
    readonly symbol: string;
    readonly sourceParameterCount: 1;
    readonly renderedParameterCount: number;
    readonly valueAbi: "boxed-jsval" | "raw-f64";
  };
  readonly allocation: {
    readonly policy: string;
    readonly scope: "global" | "per-site";
    readonly objectBytes: number;
    readonly objectBytesIsEstimate: boolean;
    readonly allocationIds: readonly number[];
    readonly allocationClasses: readonly string[];
  };
  readonly safety: {
    readonly generatedC: "plain-pinned-porffor" | "js2-porffor-ir";
    readonly generatedCMutations: readonly string[];
    readonly sanitizerExpectation: "misaligned-object-entry-ubsan" | "clean";
    readonly performanceAuthority: "ub-contaminated-non-authoritative" | "within-machine-informational";
    readonly finding: DirectPorfforSafetyFinding | null;
  };
  readonly compilePhasesMs: CompilePhaseRecord;
  readonly compilerPeakRssBytes: number;
  readonly artifacts: WorkerArtifactRecord;
  readonly commandProvenance: Readonly<Record<string, unknown>>;
  readonly outputFiles: {
    readonly renderedC: string;
    readonly wrapperC: string;
    readonly laneC: string;
  };
}

export function isPorfforDirectAbRowId(value: string): value is PorfforDirectAbRowId {
  return (PORFFOR_DIRECT_AB_ROWS as readonly string[]).includes(value);
}

export function readExactSource(path: string, expectedSha?: string): SourceDescriptor {
  const buffer = readFileSync(path);
  const source = buffer.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(buffer)) {
    throw new Error(`benchmark source ${path} is not an exact round-trippable UTF-8 byte sequence`);
  }
  const sha256 = sha256Hex(buffer);
  if (expectedSha && sha256 !== expectedSha) {
    throw new Error(`benchmark source SHA mismatch: expected ${expectedSha}, received ${sha256}`);
  }
  return { path, sha256, bytes: buffer.length, source };
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stressSeed(index: number): number {
  return ((index * 17) % 257) - 128;
}

export function expectedCanary(seed: number): number {
  return seed * 110 + 235;
}

export function checksumForIterations(iterations: number): number {
  let checksum = 0;
  for (let index = 0; index < iterations; index++) checksum += expectedCanary(stressSeed(index));
  return checksum;
}

export function normalizePinnedPorfforCForClang(rendered: string, actualCommit = PORFFOR_IR_COMMIT): string {
  assertPorfforCommit(actualCommit);
  const incompatible = 'snprintf(buf, sizeof buf, "%lld", (i64)d)';
  const portable = 'snprintf(buf, sizeof buf, "%lld", (long long)(i64)d)';
  const occurrences = rendered.split(incompatible).length - 1;
  if (occurrences !== 1) {
    throw new Error(`pinned Porffor i64 printf compatibility site count changed: expected 1, received ${occurrences}`);
  }
  return rendered.replace(incompatible, portable);
}

export function collectPorfforNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectPorfforNodes(node[3], out);
    collectPorfforNodes(node[4], out);
    collectPorfforNodes(node[5], out);
    return out;
  }
  for (const item of value) collectPorfforNodes(item, out);
  return out;
}

export function findExactFunction(
  input: PorfforRendererInput,
  name = PORFFOR_DIRECT_AB_FUNCTION,
): PorfforFunctionRecord {
  const matches = input.funcs.filter((func): func is PorfforFunctionRecord => func?.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Porffor function ${name}, received ${matches.length}`);
  }
  return matches[0]!;
}

export function porfforJsvalType(): number {
  return porfforType("jsval");
}

export function porfforType(name: string): number {
  const entry = PORFFOR_TYPE_ENTRIES.find(([candidate]) => candidate === name);
  if (!entry) throw new Error(`pinned Porffor type ${name} is absent`);
  return entry[1];
}

export function wrapperForDirectRow(options: {
  readonly gc: boolean;
  readonly functionSymbol: string;
  readonly entrySymbol: string;
}): string {
  const stackAnchor = options.gc
    ? `  if (stack_top == NULL) abort();\n  porf_c_stack_top = stack_top;`
    : "  (void)stack_top;";
  return `
void js2_ab_init(int argc, char **argv, void *stack_top) {
  porf_init(argc, argv);
  porf_data_init();
${stackAnchor}
  (void)${options.entrySymbol}();
}

double js2_ab_kernel(double seed) {
  jsval result = ${options.functionSymbol}(JV_UNDEFINED, JV_UNDEFINED, porf_box_num(seed));
  if (!porf_jv_is_num(result)) abort();
  return result.val;
}
`;
}

export function wrapperForJs2Row(functionSymbol: string): string {
  return `
void js2_ab_init(int argc, char **argv, void *stack_top) {
  porf_init(argc, argv);
  porf_data_init();
  (void)stack_top;
}

double js2_ab_kernel(double seed) {
  return ${functionSymbol}(seed);
}
`;
}

export function r7Quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("cannot summarize an empty sample set");
  if (!(probability >= 0 && probability <= 1)) throw new Error(`invalid quantile probability ${probability}`);
  const sorted = [...values].sort((left, right) => left - right);
  const h = (sorted.length - 1) * probability;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  const fraction = h - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

export function quartiles(values: readonly number[]): { q1: number; median: number; q3: number } {
  return { q1: r7Quantile(values, 0.25), median: r7Quantile(values, 0.5), q3: r7Quantile(values, 0.75) };
}
