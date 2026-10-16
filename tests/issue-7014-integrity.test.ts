// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeToRel, runFiles, unaccountedRunErrors } from "../scripts/known-failures-gate.mjs";
import { resultsToIds } from "../scripts/lib/issue-tests-ids.mjs";
import KnownFailuresReporter from "../scripts/lib/known-failures-reporter.mjs";

const ROOT = join(import.meta.dirname, "..");
const file = "tests/control.test.ts";
const pass = { fullName: "original assertion", status: "passed", failureMessages: [] };
const fail = { fullName: "red assertion", status: "failed", failureMessages: ["assertion failed"] };
const entry = (assertions: unknown[], message = "", fileFailureMessages: string[] = []) => ({
  status: "failed",
  assertionResults: assertions,
  message,
  fileFailureMessages,
});
const run = (overrides = {}) => ({
  ended: new Map([[file, { status: "passed" }]]),
  started: new Set([file]),
  code: 0,
  timedOut: false,
  runEnd: "passed",
  runErrors: [],
  ...overrides,
});
const scratch = () => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  return mkdtempSync(join(ROOT, ".tmp", "issue-7014-integrity-"));
};

describe("#7014 detector integrity beyond assertion verdicts", () => {
  it("retains a passing assertion AND its failed file without a hook message", () => {
    const r = resultsToIds([file], new Map([[file, { entry: entry([pass]) }]]));
    expect([...r.passing]).toEqual([`${file} :: original assertion`]);
    expect([...r.failing]).toEqual([`${file} :: <file>`]);
  });

  it("retains a file hook error alongside an ordinary assertion failure", () => {
    const r = resultsToIds([file], new Map([[file, { entry: entry([pass, fail], "afterAll broke") }]]));
    expect([...r.failing]).toEqual([`${file} :: <file>`, `${file} :: red assertion`]);
    expect(r.messages[`${file} :: <file>`]).toBe("afterAll broke");
    expect([...r.passing]).toEqual([`${file} :: original assertion`]);
  });

  it("retains a nested suite hook error even without a file message", () => {
    const r = resultsToIds([file], new Map([[file, { entry: entry([fail], "", ["nested afterAll broke"]) }]]));
    expect(r.messages[`${file} :: <file>`]).toBe("nested afterAll broke");
    expect(r.failing.has(`${file} :: red assertion`)).toBe(true);
  });

  it("does not duplicate an ordinary assertion-only failure as a file failure", () => {
    const r = resultsToIds([file], new Map([[file, { entry: entry([fail]) }]]));
    expect([...r.failing]).toEqual([`${file} :: red assertion`]);
  });

  it("keeps unexpected passes non-bankable while retaining an independent file error", () => {
    const sentinel = { fullName: "sentinel", status: "failed", failureMessages: ["Expect test to fail"] };
    const r = resultsToIds([file], new Map([[file, { entry: entry([sentinel], "afterAll broke") }]]));
    expect([...r.unexpectedPasses]).toEqual([`${file} :: sentinel`]);
    expect([...r.failing]).toEqual([`${file} :: <file>`]);
  });

  it("an attributed assertion failure accounts for the normal Vitest exit 1", () => {
    expect(
      unaccountedRunErrors(
        run({
          ended: new Map([[file, entry([fail])]]),
          code: 1,
          runEnd: "failed",
        }),
        [file],
      ),
    ).toEqual([]);
  });

  it("rejects a nonzero terminal after all passing file results", () => {
    expect(unaccountedRunErrors(run({ code: 1, runEnd: "failed" }), [file]).join("\n")).toMatch(/exited 1/);
  });

  it("retains an unhandled error even when the terminal exit is zero", () => {
    expect(unaccountedRunErrors(run({ runErrors: ["unhandled rejection"] }), [file])).toEqual(["unhandled rejection"]);
  });

  it("does not turn recoverable in-flight loss into an unaccounted terminal", () => {
    expect(
      unaccountedRunErrors(run({ ended: new Map(), code: null, runEnd: undefined, timedOut: true }), [file]),
    ).toEqual([]);
  });

  it("does not discard actual unhandled errors from an incomplete batch", () => {
    expect(unaccountedRunErrors(run({ ended: new Map(), runErrors: ["unhandled rejection"] }), [file])).toEqual([
      "unhandled rejection",
    ]);
  });

  it("rejects missing completion and interruption after every file ended", () => {
    expect(unaccountedRunErrors(run({ runEnd: undefined }), [file]).join("\n")).toMatch(/completion record/);
    expect(unaccountedRunErrors(run({ runEnd: "interrupted" }), [file]).join("\n")).toMatch(/interrupted/);
  });

  it("the pinned reporter preserves unhandled errors and nested suite errors", () => {
    const rows: any[] = [];
    const reporter = new KnownFailuresReporter();
    reporter.write = (row: any) => rows.push(row);
    const task = {
      filepath: file,
      result: { state: "pass" },
      tasks: [
        {
          type: "suite",
          result: { state: "fail", errors: [{ message: "suite hook failed" }] },
          tasks: [{ type: "test", name: "works", result: { state: "pass" } }],
        },
      ],
    };
    reporter.onTestRunEnd([{ moduleId: file, task }], [{ message: "unhandled rejection" }], "failed");
    expect(rows[0].entry.status).toBe("failed");
    expect(rows[0].entry.fileFailureMessages).toEqual(["suite hook failed"]);
    expect(rows[1]).toEqual({ event: "run-end", reason: "failed", errors: ["unhandled rejection"] });
  });

  it("real Vitest file hooks and unhandled errors survive the crash-safe runner", async () => {
    const root = scratch();
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(
      join(root, "vitest.config.mjs"),
      'export default { test: { include: ["*.test.js"], pool: "forks" } };\n',
    );
    writeFileSync(
      join(root, "hook.test.js"),
      `import {it,expect,afterAll} from "vitest";
it("passing assertion",()=>expect(1).toBe(1));
afterAll(()=>{throw new Error("real afterAll failed")});\n`,
    );
    writeFileSync(
      join(root, "both.test.js"),
      `import {it,expect,afterAll,describe} from "vitest";
describe("nested",()=>{it("failed assertion",()=>expect(1).toBe(2));
afterAll(()=>{throw new Error("real nested afterAll failed")})});\n`,
    );
    writeFileSync(
      join(root, "unhandled.test.js"),
      `import {it,expect} from "vitest";
it("passing with unhandled error",async()=>{setTimeout(()=>{throw new Error("real unhandled error")},0);
await new Promise(r=>setTimeout(r,20));expect(1).toBe(1)});\n`,
    );
    const files = ["hook.test.js", "both.test.js", "unhandled.test.js"];
    const errors: string[] = [];
    const results = await runFiles(root, makeToRel(root), files, {
      label: "detector integrity controls",
      serial: true,
      onRunIntegrity: (e: string) => errors.push(e),
    });
    expect(results.size).toBe(3);
    const ids = resultsToIds(files, results);
    expect([...ids.passing].some((id: string) => id.includes("passing assertion"))).toBe(true);
    expect(ids.failing.has("hook.test.js :: <file>")).toBe(true);
    expect(ids.messages["both.test.js :: <file>"]).toMatch(/real nested afterAll failed/);
    expect([...ids.failing].some((id: string) => id.includes("failed assertion"))).toBe(true);
    expect(errors.join("\n")).toMatch(/real unhandled error/);
  });

  for (const mode of ["gate", "update", "bootstrap", "ratchet"]) {
    it(`merged run integrity refuses ${mode} without writing a baseline`, () => {
      const root = scratch();
      const partials = join(root, "partials");
      mkdirSync(partials);
      const baseline = join(root, "baseline.json");
      const original = JSON.stringify({ knownFailures: [`${file} :: formerly red`] });
      if (mode !== "bootstrap") writeFileSync(baseline, original);
      writeFileSync(
        join(partials, "one.json"),
        JSON.stringify({
          failing: [],
          passing: [`${file} :: formerly red`],
          unexpectedPasses: [],
          messages: {},
          runIntegrityErrors: ["unhandled rejection despite exit zero"],
        }),
      );
      const args = [
        join(ROOT, "scripts/issue-tests-gate.mjs"),
        ...(mode === "update" ? ["--update"] : mode === "ratchet" ? ["--update-on-decrease"] : []),
      ];
      const result = spawnSync(process.execPath, args, {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          SHARD: "",
          MERGE_PARTIALS_DIR: partials,
          ISSUE_TESTS_BASELINE: baseline,
          ALLOW_BOOTSTRAP: mode === "bootstrap" ? "1" : "0",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/RUN ERROR: one.json: unhandled rejection despite exit zero/);
      if (mode === "bootstrap") expect(existsSync(baseline)).toBe(false);
      else expect(readFileSync(baseline, "utf8")).toBe(original);
    });
  }
});
