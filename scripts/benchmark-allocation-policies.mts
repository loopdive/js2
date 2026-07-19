// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildAllocationPolicyProof, LINEAR_ALLOCATION_POLICY_SOURCE } from "../benchmarks/allocation-policy-proof.js";
import { compile } from "../src/index.js";
import {
  ANALYSIS_STACK_ARENA_POLICY,
  DEFAULT_ARENA_POLICY,
  planLinearMemory,
  type LinearAllocatorPolicy,
} from "../src/ir/analysis/linear-memory-plan.js";
import { PORFFOR_IR_COMMIT, porfforRendererOutputText } from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";

const WARMUP_ROUNDS = 5;
const MEASURED_ROUNDS = 21;
const ITERATIONS = 200_000;
const policies = [DEFAULT_ARENA_POLICY, ANALYSIS_STACK_ARENA_POLICY] as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measureLinear(policy: LinearAllocatorPolicy) {
  const allocator = policy === DEFAULT_ARENA_POLICY ? "bump" : "analysis-stack";
  const compiled = await compile(LINEAR_ALLOCATION_POLICY_SOURCE, { target: "linear", allocator });
  if (!compiled.success || !compiled.binary) {
    throw new Error(
      `linear compile failed for ${policy.id}: ${compiled.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const samplesMs: number[] = [];
  let peakBytes = 0;
  let checksum = 0;
  for (let round = 0; round < WARMUP_ROUNDS + MEASURED_ROUNDS; round++) {
    const { instance } = await WebAssembly.instantiate(compiled.binary, {});
    const exports = instance.exports as unknown as {
      objectPolicyProof(seed: number): number;
      memory: WebAssembly.Memory;
    };
    let current = 0;
    const start = process.cpuUsage();
    for (let index = 0; index < ITERATIONS; index++) current += exports.objectPolicyProof(index);
    const elapsedCpu = process.cpuUsage(start);
    const elapsed = (elapsedCpu.user + elapsedCpu.system) / 1_000;
    if (round >= WARMUP_ROUNDS) samplesMs.push(elapsed);
    peakBytes = Math.max(peakBytes, exports.memory.buffer.byteLength);
    checksum = current;
  }
  return {
    supported: true,
    artifactBytes: compiled.binary.length,
    runtimeMedianMs: median(samplesMs),
    peakLinearMemoryBytes: peakBytes,
    logicalAllocations: ITERATIONS * 2,
    backingArenaAllocations: policy === DEFAULT_ARENA_POLICY ? ITERATIONS * 2 : 1,
    checksum,
  };
}

function findCCompiler(): string | null {
  for (const candidate of [process.env.CC, "cc", "clang", "gcc"].filter((value): value is string => !!value)) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

function compilerVersion(compiler: string): string {
  return (spawnSync(compiler, ["--version"], { encoding: "utf8" }).stdout || "").split("\n")[0]!.trim();
}

function peakRss(binaryPath: string): { stdout: string; stderr: string; peakRssBytes: number | null } {
  const darwin = process.platform === "darwin";
  const result = spawnSync("/usr/bin/time", darwin ? ["-l", binaryPath] : ["-v", binaryPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Porffor benchmark failed:\n${result.stdout}\n${result.stderr}`);
  const match = darwin
    ? /\s*(\d+)\s+maximum resident set size/.exec(result.stderr)
    : /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(result.stderr);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    peakRssBytes: match ? Number(match[1]) * (darwin ? 1 : 1024) : null,
  };
}

async function measurePorffor(policy: LinearAllocatorPolicy, compiler: string) {
  const fixture = buildAllocationPolicyProof();
  const plan = planLinearMemory(fixture.module, fixture.registry, policy);
  const input = lowerIrModuleToPorffor(fixture.module, { memoryPlan: plan });
  const porffor = await loadOptionalPorffor({ root: join(process.cwd(), "vendor/Porffor") });
  const rendered = porfforRendererOutputText(porffor.render(input));
  const object = input.funcs.find((func) => func?.name === "objectPolicyProof");
  if (!object) throw new Error("Porffor benchmark function is absent");
  const harness = `
#include <time.h>
static unsigned long long js2_now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts);
  return (unsigned long long)ts.tv_sec * 1000000000ull + (unsigned long long)ts.tv_nsec;
}
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
  volatile double checksum = 0;
  unsigned long long start = js2_now_ns();
  for (int i = 0; i < ${ITERATIONS}; i++) checksum += p${object.index}_objectPolicyProof((double)i);
  unsigned long long elapsed = js2_now_ns() - start;
  printf("sample:%llu\\n", elapsed);
  fprintf(stderr, "checksum:%.17g\\n", checksum);
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-allocation-policy-"));
  const sourcePath = join(directory, `${policy.id}.c`);
  const binaryPath = join(directory, `${policy.id}.out`);
  try {
    writeFileSync(sourcePath, rendered + harness);
    const build = spawnSync(
      compiler,
      ["-std=gnu11", "-O2", "-Werror", "-Wno-unused-function", sourcePath, "-lm", "-o", binaryPath],
      { encoding: "utf8" },
    );
    if (build.status !== 0) throw new Error(`C compile failed:\n${build.stdout}\n${build.stderr}`);
    const samplesNs: number[] = [];
    let peakRssBytes: number | null = null;
    let checksum: string | null = null;
    for (let round = 0; round < WARMUP_ROUNDS + MEASURED_ROUNDS; round++) {
      const run = peakRss(binaryPath);
      const sample = run.stdout
        .trim()
        .split("\n")
        .find((line) => line.startsWith("sample:"));
      if (!sample) throw new Error(`Porffor benchmark did not print a runtime sample: ${run.stdout}`);
      const checksumMatch = /(?:^|\n)checksum:([^\n]+)/.exec(run.stderr);
      if (!checksumMatch) throw new Error(`Porffor benchmark did not print a checksum: ${run.stderr}`);
      if (checksum !== null && checksum !== checksumMatch[1]) {
        throw new Error(`Porffor benchmark checksum changed from ${checksum} to ${checksumMatch[1]}`);
      }
      checksum = checksumMatch[1]!;
      if (round >= WARMUP_ROUNDS) samplesNs.push(Number(sample.slice("sample:".length)));
      if (run.peakRssBytes !== null) peakRssBytes = Math.max(peakRssBytes ?? 0, run.peakRssBytes);
    }
    return {
      supported: true,
      cSourceBytes: Buffer.byteLength(rendered),
      nativeArtifactBytes: statSync(binaryPath).size,
      runtimeMedianMs: median(samplesNs) / 1_000_000,
      peakRssBytes,
      logicalAllocations: ITERATIONS * 2,
      backingArenaAllocations: policy === DEFAULT_ARENA_POLICY ? ITERATIONS * 2 : 1,
      checksum,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const compiler = findCCompiler();
const results: Record<string, unknown> = {};
for (const policy of policies) {
  results[policy.id] = {
    linearWasm: await measureLinear(policy),
    porfforC: compiler
      ? await measurePorffor(policy, compiler)
      : { supported: false, reason: "no cc/clang/gcc executable found" },
  };
}

const porfforCommit = spawnSync("git", ["-C", "vendor/Porffor", "rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const output = {
  generatedAt: new Date().toISOString(),
  methodology: { warmupRounds: WARMUP_ROUNDS, measuredRounds: MEASURED_ROUNDS, iterationsPerRound: ITERATIONS },
  supportedIrFamilies: ["fixed numeric object", "dense f64 vector fallback"],
  porffor: { expectedCommit: PORFFOR_IR_COMMIT, actualCommit: porfforCommit || null },
  compiler: compiler ? compilerVersion(compiler) : null,
  results,
};
console.log(JSON.stringify(output, null, 2));
