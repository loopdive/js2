// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bisectUntaggedErrors, makeToRel, runFiles, unaccountedRunErrors } from "../scripts/known-failures-gate.mjs";
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
    // (#7501) The worker's uncaughtException handler tags the error; the record names its file.
    expect(errors.join("\n")).toContain("[raised while running unhandled.test.js] Error: real unhandled error");
  });

  describe("bisection names the file behind each unattributed run error (#7518)", () => {
    // A stand-in for vitestOnce: every file finishes, and a file in `raises` raises its own unattributed error.
    const fakeRun =
      (raises: Record<string, string>, calls: string[][]) => async (_root: string, _toRel: unknown, part: string[]) => {
        calls.push(part);
        return {
          ended: new Map(part.map((file) => [file, { status: "passed" }])),
          started: new Set(part),
          timedOut: false,
          code: 0,
          runEnd: "passed",
          runErrors: part.filter((file) => raises[file]).map((file) => raises[file]),
        };
      };
    const files = ["a.test.js", "b.test.js", "c.test.js", "d.test.js"];
    const options = { serial: false, heapMb: 1024, timeoutMs: 60_000 };
    const runOf = (errors: string[]) => ({ ended: new Map(), timedOut: false, runErrors: errors });

    it("labels each error with its own file, not the batch's", async () => {
      const raises = { "b.test.js": "Error: from b\n    at x", "d.test.js": "Error: from d\n    at y" };
      const errors = Object.values(raises);
      const calls: string[][] = [];
      const bisection = { deadline: Date.now() + 60_000, label: "t", runOnce: fakeRun(raises, calls) };
      const labels = await bisectUntaggedErrors(
        "/r",
        null,
        files,
        errors,
        runOf(errors),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(labels.get(errors[0])).toBe("(#7518 bisection: reproduces alone in: b.test.js)");
      expect(labels.get(errors[1])).toBe("(#7518 bisection: reproduces alone in: d.test.js)");
      expect(calls.length).toBeLessThanOrEqual(6);
    });

    it("stops at its deadline and says so", async () => {
      const errors = ["Error: from b"];
      const calls: string[][] = [];
      const bisection = { deadline: Date.now() - 1, label: "t", runOnce: fakeRun({ "b.test.js": errors[0] }, calls) };
      const labels = await bisectUntaggedErrors(
        "/r",
        null,
        files,
        errors,
        runOf(errors),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(calls).toEqual([]);
      expect(labels.get(errors[0])).toBe("(#7518 bisection: budget spent before it was located)");
    });

    it("skips tagged errors and batches that hit their timeout", async () => {
      const calls: string[][] = [];
      const bisection = { deadline: Date.now() + 60_000, label: "t", runOnce: fakeRun({}, calls) };
      const tagged = ["[raised while running a.test.js] Error: x"];
      expect(
        (await bisectUntaggedErrors("/r", null, files, tagged, runOf(tagged), options, bisection, bisection.runOnce))
          .size,
      ).toBe(0);
      const timedOut = { ...runOf(["Error: y"]), timedOut: true };
      expect(
        (await bisectUntaggedErrors("/r", null, files, ["Error: y"], timedOut, options, bisection, bisection.runOnce))
          .size,
      ).toBe(0);
      expect(calls).toEqual([]);
    });

    it("starts its deadline at the first bisection run, not before", async () => {
      const errors = ["Error: from b"];
      const bisection = {
        budgetMs: 60_000,
        deadline: undefined as number | undefined,
        label: "t",
        runOnce: fakeRun({ "b.test.js": errors[0] }, []),
      };
      const before = Date.now();
      const labels = await bisectUntaggedErrors(
        "/r",
        null,
        files,
        errors,
        runOf(errors),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(labels.get(errors[0])).toBe("(#7518 bisection: reproduces alone in: b.test.js)");
      expect(bisection.deadline).toBeGreaterThanOrEqual(before + 60_000);
    });

    it("caps every bisection run's timeout at the time left", async () => {
      const timeouts: number[] = [];
      const run = fakeRun({ "b.test.js": "Error: from b" }, []);
      const bisection = {
        deadline: Date.now() + 5_000,
        label: "t",
        runOnce: (root: string, toRel: unknown, part: string[], opts: { timeoutMs: number }) => {
          timeouts.push(opts.timeoutMs);
          return run(root, toRel, part);
        },
      };
      await bisectUntaggedErrors(
        "/r",
        null,
        files,
        ["Error: from b"],
        runOf(["Error: from b"]),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(timeouts.length).toBeGreaterThan(0);
      for (const timeout of timeouts) expect(timeout).toBeLessThanOrEqual(5_000);
    });

    it("reports a last run that timed out at the deadline as a spent budget", async () => {
      // Two files: the first half runs clean, the second (and last) times out at the deadline. No later deadline
      // check follows, so only the timed-out run itself can mark the budget spent.
      const errors = ["Error: from b"];
      let calls = 0;
      const bisection = {
        deadline: Date.now() + 200,
        label: "t",
        runOnce: async (_root: string, _toRel: unknown, part: string[]) => {
          if (calls++ === 0)
            return {
              ended: new Map(part.map((f) => [f, { status: "passed" }])),
              started: new Set(part),
              timedOut: false,
              code: 0,
              runEnd: "passed",
              runErrors: [],
            };
          await new Promise((resolve) => setTimeout(resolve, 300));
          return {
            ended: new Map(),
            started: new Set(part),
            timedOut: true,
            code: null,
            runEnd: undefined,
            runErrors: [],
          };
        },
      };
      const labels = await bisectUntaggedErrors(
        "/r",
        null,
        ["a.test.js", "b.test.js"],
        errors,
        runOf(errors),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(calls).toBe(2);
      expect(labels.get(errors[0])).toBe("(#7518 bisection: budget spent before it was located)");
    });

    it("follows only the batch's own errors, not new ones a smaller run raises", async () => {
      // c.test.js raises "Error: noise" in smaller runs only; the batch's one error comes from b.test.js.
      const calls: string[][] = [];
      const raises = { "b.test.js": "Error: from b", "c.test.js": "Error: noise" };
      const bisection = { deadline: Date.now() + 60_000, label: "t", runOnce: fakeRun(raises, calls) };
      const errors = ["Error: from b"];
      const labels = await bisectUntaggedErrors(
        "/r",
        null,
        files,
        errors,
        runOf(errors),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(labels.get(errors[0])).toBe("(#7518 bisection: reproduces alone in: b.test.js)");
      expect(calls).not.toContainEqual(["c.test.js"]);
    });

    it("says so when errors that share a first line reproduce in more than one file", async () => {
      const same = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
      const raises = { "a.test.js": same, "c.test.js": same };
      const bisection = { deadline: Date.now() + 60_000, label: "t", runOnce: fakeRun(raises, []) };
      const labels = await bisectUntaggedErrors(
        "/r",
        null,
        files,
        [same, same],
        runOf([same, same]),
        options,
        bisection,
        bisection.runOnce,
      );
      expect(labels.get(same)).toBe(
        "(#7518 bisection: reproduces alone in: a.test.js, c.test.js (same first line, not told apart))",
      );
    });

    it("traces a real untagged run error to its file through runFiles", async () => {
      const root = scratch();
      symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(
        join(root, "vitest.config.mjs"),
        'export default { test: { include: ["*.test.js"], pool: "forks" } };\n',
      );
      for (const name of ["one", "two", "three"]) {
        writeFileSync(
          join(root, `${name}.test.js`),
          'import {it,expect} from "vitest";\nit("ok",()=>expect(1).toBe(1));\n',
        );
      }
      writeFileSync(
        join(root, "leaks.test.js"),
        `import {it,expect} from "vitest";
it("leaks",async()=>{setTimeout(()=>{throw new Error("leaked")},0);await new Promise(r=>setTimeout(r,20));expect(1).toBe(1)});\n`,
      );
      const errors: string[] = [];
      await runFiles(root, makeToRel(root), ["one.test.js", "two.test.js", "leaks.test.js", "three.test.js"], {
        label: "bisection",
        onRunIntegrity: (e: string) => errors.push(e),
      });
      // The leak itself is tagged by the reporter; the run's unattributed exit 1 is located by bisection.
      expect(errors.some((e) => e.startsWith("[raised while running leaks.test.js] Error: leaked"))).toBe(true);
      const exit = errors.find((e) => e.startsWith("vitest exited 1"));
      expect(exit).toContain("(#7518 bisection: reproduces alone in: leaks.test.js)");
    });
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
