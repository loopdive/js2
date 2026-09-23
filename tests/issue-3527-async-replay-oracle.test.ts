// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  compareExports,
  compareExportsAsync,
  oracleCallProblems,
  type OracleCall,
} from "./helpers/ir-whole-program-replay.js";

const ROOT = resolve(import.meta.dirname, "..");
const asyncCall: OracleCall = { export: "run", args: [], expected: 42, mode: "await-fulfill" };

function encode(files: Record<string, string>) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    runtimePolicies: [{ backend: "wasmgc", target: "host" }],
    deferTopLevelInit: false,
  });
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  return { program: result.program, encoded: encodePreparedIrProgram(result.program) };
}

function withChild(
  encoded: string,
  body: (
    run: (
      calls: readonly OracleCall[],
      forbidden?: boolean,
      missingProgram?: boolean,
    ) => { status: number | null; report: any; stderr: string },
  ) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "async-replay-oracle-"));
  const program = join(directory, "program.json");
  const oracle = join(directory, "oracle.json");
  writeFileSync(program, encoded);
  try {
    body((calls, forbidden = false, missingProgram = false) => {
      writeFileSync(oracle, JSON.stringify({ targets: [{ backend: "wasmgc", target: "host" }], calls }));
      const args = [
        "--import",
        "tsx",
        "scripts/ir-whole-program-replay.mjs",
        missingProgram ? join(directory, "absent.json") : program,
        oracle,
      ];
      if (forbidden) args.push("--probe-forbidden-import");
      const child = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
      expect(child.error).toBeUndefined();
      return {
        status: child.status,
        report: JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}"),
        stderr: child.stderr,
      };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("#3527 opt-in async replay oracle", () => {
  it("leaves synchronous comparison unchanged and checks fulfillment, rejection and exact phase timing", async () => {
    const sync = { answer: () => 42 };
    const calls = [{ export: "answer", args: [], expected: 42 }];
    expect(await compareExportsAsync(sync, calls)).toEqual(compareExports(sync, calls));
    let phase = 0;
    const exports = {
      phase: () => phase,
      run: async () => {
        phase = 1;
        await 0;
        phase = 2;
        await 0;
        phase = 3;
        return 42;
      },
      reject: async () => {
        throw null;
      },
    };
    const rows = await compareExportsAsync(exports, [
      { ...asyncCall, checkpoints: [1, 2, 3, 3].map((expected) => ({ export: "phase", expected })) },
      { export: "reject", args: [], mode: "await-reject", expected: null },
    ]);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.match)).toBe(true);
    expect(
      (await compareExportsAsync(exports, [{ ...asyncCall, mode: "await-reject" }])).every((row) => row.match),
    ).toBe(false);
    expect(
      (
        await compareExportsAsync(exports, [
          { ...asyncCall, checkpoints: [99, 3].map((expected) => ({ export: "phase", expected })) },
        ])
      ).every((row) => row.match),
    ).toBe(false);
  });

  it("refuses malformed async schema before invoking exports", async () => {
    expect(oracleCallProblems(asyncCall)).toEqual([]);
    const invalid = [
      { ...asyncCall, mode: "await" },
      { ...asyncCall, mode: null },
      {
        export: "run",
        args: [],
        expected: 42,
        checkpoints: [
          { export: "phase", expected: 1 },
          { export: "phase", expected: 3 },
        ],
      },
      ...[
        [],
        [{ export: "phase", expected: 1 }],
        Array.from({ length: 19 }, () => ({ export: "phase", expected: 1 })),
        [null, null],
        [
          { export: "", expected: 0 },
          { export: "phase", expected: 3 },
        ],
        [
          { export: "phase", expected: {} },
          { export: "phase", expected: 3 },
        ],
      ].map((checkpoints) => ({ ...asyncCall, checkpoints })),
    ];
    const run = vi.fn(async () => 42);
    for (const call of invalid) {
      expect(oracleCallProblems(call).length).toBeGreaterThan(0);
      await expect(compareExportsAsync({ run }, [call as OracleCall])).rejects.toThrow(/malformed oracle/);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a real Promise and bounds an unsettled result with a cleared timeout", async () => {
    await expect(compareExportsAsync({ run: () => 42 }, [asyncCall])).rejects.toThrow(/did not return a Promise/);
    vi.useFakeTimers();
    try {
      const comparison = compareExportsAsync({ run: () => new Promise(() => {}) }, [asyncCall]);
      const assertion = expect(comparison).rejects.toThrow(/timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      await compareExportsAsync({ run: async () => 42 }, [asyncCall]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const ORIGINAL_MIXED = {
    "./a.ts": "export let left: number = 1; left = left + 1;",
    "./b.ts": "export let right: number = 10; right = right + 2;",
    "./entry.ts":
      '\n    import { left } from "./a";\n    import { right } from "./b";\n    let phase: number = 0;\n    export function initial(): number { return left * 100 + right; }\n    export function readPhase(): number { return phase; }\n    function compute(seed: number): number {\n      let total = 0;\n      for (let i = 0; i < 4; i++) {\n        if (i % 2 === 0) total = total + Math.imul(seed, i + 1);\n        else total = total - i;\n      }\n      return total;\n    }\n    \n  export async function run(seed: number): Promise<number> {\n    phase = 1;\n    const first = await (seed + 1);\n    phase = 2;\n    const second = await compute(first);\n    phase = 3;\n    return second + initial();\n  }\n\n  ',
  };
  const ORIGINAL_MIXED_DIGEST = "236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb";

  it("replays the exact seven-terminal mixed application in a source-free child, with fail-closed controls", () => {
    expect(createHash("sha256").update(JSON.stringify(ORIGINAL_MIXED)).digest("hex")).toBe(ORIGINAL_MIXED_DIGEST);
    const prepared = encode(ORIGINAL_MIXED);
    expect(prepared.program.inventory.terminalUnits).toHaveLength(7);
    const calls: OracleCall[] = [
      { export: "initial", args: [], expected: 212 },
      ...[0, 7, -3].map(
        (seed): OracleCall => ({
          export: "run",
          args: [seed],
          expected: 4 * seed + 212,
          mode: "await-fulfill",
          checkpoints: [1, 2, 3, 3].map((expected) => ({ export: "readPhase", expected })),
        }),
      ),
    ];
    withChild(prepared.encoded, (run) => {
      const positive = run(calls);
      expect(positive.status, JSON.stringify(positive.report)).toBe(0);
      expect(positive.report.ok).toBe(true);
      expect(positive.report.reencodedIdentical).toBe(true);
      expect(positive.report.loadedModuleCount).toBeGreaterThan(10);
      expect(positive.report.frontendModules).toEqual([]);
      expect(positive.report.typescriptModules).toEqual([]);
      const target = positive.report.targets["wasmgc:host"];
      expect(target.kind).toBe("ran");
      expect(target.emittedUnits).toBe(14);
      expect(target.projectionUnits).toBe(14);
      expect(target.supportFunctions).toHaveLength(3);
      expect(new Set(target.supportFunctions.map((row: { index: number }) => row.index)).size).toBe(3);
      expect(target.startupAdapterIndex).toBeTypeOf("number");
      expect(target.supportFunctions.some((row: { index: number }) => row.index === target.startupAdapterIndex)).toBe(
        false,
      );
      expect(target.moduleFunctions).toBe(target.emittedUnits + target.supportFunctions.length + 1);
      expect(target.rows).toHaveLength(16);
      expect(target.rows.every((row: { match: boolean }) => row.match)).toBe(true);
      const mismatch = run([{ ...calls[1]!, expected: -1 }]);
      expect(mismatch.status).toBe(1);
      expect(mismatch.report.ok).toBe(false);
      const forbidden = run(calls, true);
      expect(forbidden.status).toBe(1);
      expect(forbidden.report.typescriptModules.length).toBeGreaterThan(0);
      expect(forbidden.report.failures.some((failure: string) => /TypeScript|typescript/.test(failure))).toBe(true);
      const malformed = run([{ ...asyncCall, checkpoints: [] }], false, true);
      expect(malformed.status).toBe(2);
      expect(malformed.report.decodeFailure).toBeUndefined();
    });
  }, 30_000);

  it("replays supported source null rejection in the child using canonical host adapters", () => {
    const prepared = encode({
      "./entry.ts":
        "function fail(): number { throw null; } export async function rejected(): Promise<number> { const value = await fail(); return value; }",
    });
    withChild(prepared.encoded, (run) => {
      const result = run([{ export: "rejected", args: [], mode: "await-reject", expected: null }]);
      expect(result.status, JSON.stringify(result.report)).toBe(0);
      expect(result.report.targets["wasmgc:host"].rows).toHaveLength(1);
      expect(result.report.targets["wasmgc:host"].rows[0].match).toBe(true);
      expect(result.report.frontendModules).toEqual([]);
      expect(result.report.typescriptModules).toEqual([]);
    });
  }, 30_000);
});
