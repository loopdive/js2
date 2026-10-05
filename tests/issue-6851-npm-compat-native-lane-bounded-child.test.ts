// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6851 — jsdom and webpack kept showing the opaque pre-#6661 "package entry
// did not produce a runnable Wasm module" on every npm-compat lane. #6661 had
// fixed the text, but neither package was ever re-measured: their JS-host
// package-entry gate times out, and the native-first JS-host lane then
// compiled the same graph IN the generator process — unbudgeted, sharing its
// ~4 GB heap — which ran out of memory ("FATAL ERROR: Ineffective
// mark-compacts near heap limit", exit 134). The measure job died without a
// partial report, so the refresh carried their 2026-09-08 rows forward as
// stale. The fix routes the native-first lane through the same bounded child
// the standalone lanes use when the host gate blocked, and names a child's
// heap exhaustion instead of quoting a native stack frame.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHILD_PERF_LANES,
  childLaneFailureDiagnostic,
  JS_HOST_NATIVE_PERF_LANE,
  resolveNativeFirstPerfLane,
  STANDALONE_PERF_LANES,
} from "../scripts/lib/npm-compat-perf.mjs";
import { laneBudgetOverrun } from "../scripts/lib/npm-compat-opt-budget.mjs";

// A real V8 heap exhaustion, the way a lane child dies on a graph too big for it.
function oomChild() {
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=16", "-e", "const keep = []; for (;;) keep.push(new Array(1e5).fill(keep.length));"],
    { encoding: "utf-8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  return { status: child.status, signal: child.signal, output: `${child.stderr ?? ""}${child.stdout ?? ""}` };
}

// The pre-#6851 diagnostic, verbatim in shape: the child's last output line.
function legacyChildDiagnostic(lane: string, child: { status: number | null; signal: string | null; output: string }) {
  const tail = child.output.trim().split("\n").filter(Boolean).at(-1);
  return `${lane} lane child exited ${child.status ?? child.signal ?? "abnormally"}: ${tail ?? "no output"}`;
}

describe("#6851 a host-blocked package's native-first lane runs in a bounded child", () => {
  it("host-blocked → the bounded child; unblocked → in process", async () => {
    const childLanes: string[] = [];
    const blocked = await resolveNativeFirstPerfLane({
      hostBlocked: true,
      inProcess: () => {
        throw new Error("a host-blocked graph must not be compiled in the generator's own process");
      },
      inChild: (lane: string) => {
        childLanes.push(lane);
        return { status: "compile-error", diagnostic: "js-host-native lane exceeded the 120000ms harness budget" };
      },
    });
    expect(childLanes).toEqual(["js-host-native"]);
    expect(blocked.diagnostic).toMatch(/^js-host-native lane exceeded/);

    let inProcess = 0;
    const unblocked = await resolveNativeFirstPerfLane({
      hostBlocked: false,
      inProcess: () => {
        inProcess++;
        return { status: "ok" };
      },
      inChild: () => {
        throw new Error("an unblocked package needs no child");
      },
    });
    expect(inProcess).toBe(1);
    expect(unblocked.status).toBe("ok");
  });

  it("the child lane table maps js-host-native to the jsHostNative record on the js-host placement", () => {
    expect(JS_HOST_NATIVE_PERF_LANE).toEqual({
      lane: "js-host-native",
      key: "jsHostNative",
      placement: "js-host",
      inputMode: "runtime-dynamic",
    });
    expect(CHILD_PERF_LANES.map((entry) => entry.lane)).toEqual([
      ...STANDALONE_PERF_LANES.map((entry) => entry.lane),
      "js-host-native",
    ]);
    for (const entry of CHILD_PERF_LANES.slice(0, STANDALONE_PERF_LANES.length)) {
      expect(entry.placement).toBe("standalone");
    }
  });

  it("names a child's heap exhaustion; the legacy tail quoted a native stack frame", () => {
    const child = oomChild();
    expect(child.output).toMatch(/heap out of memory|Reached heap limit/);
    // Anti-vacuity: the pre-fix text for a real OOM names nothing actionable.
    const legacy = legacyChildDiagnostic("js-host-native", child);
    expect(legacy).not.toMatch(/heap/i);

    const diagnostic = childLaneFailureDiagnostic("js-host-native", child);
    expect(diagnostic).toMatch(
      /^js-host-native lane ran out of JS heap compiling the package graph \(V8: JavaScript heap out of memory; child exit /,
    );
  });

  it("keeps the plain-exit text; a js-host-native overrun names its codegen phase", () => {
    expect(childLaneFailureDiagnostic("standalone-static", { status: 1, output: "boom\nError: real reason\n" })).toBe(
      "standalone-static lane child exited 1: Error: real reason",
    );
    expect(laneBudgetOverrun("js-host-native", 120_000, { phase: "codegen", atMs: 4100 }).diagnostic).toBe(
      "js-host-native lane exceeded the 120000ms harness budget during codegen (started at 4100 ms) (compile-budget)",
    );
  });

  it("the generator marks codegen for every lane child, not only standalone ones", () => {
    const source = readFileSync(join(__dirname, "..", "scripts", "generate-npm-compat-report.mjs"), "utf-8");
    const body = source.slice(source.indexOf("async function compileNpmCompatPerfLane("));
    const compileFn = body.slice(0, body.indexOf("\n}\n"));
    expect(compileFn).toMatch(/\n {2}markLanePhase\("codegen"\);/);
    expect(compileFn).not.toContain('if (target === "standalone") markLanePhase("codegen")');
  });

  it("the generator routes the native-first lane through the resolver with the bounded child", () => {
    const source = readFileSync(join(__dirname, "..", "scripts", "generate-npm-compat-report.mjs"), "utf-8");
    const body = source.slice(source.indexOf("async function perfNpmCompatPackage("));
    const perfFn = body.slice(0, body.indexOf("\n}\n"));
    expect(perfFn).toContain("resolveNativeFirstPerfLane(");
    expect(perfFn).toMatch(/inChild: \(lane\) => perfLaneInChild\(name, lane,/);
    expect(perfFn).not.toMatch(/nativeFirstPerfLane\(\(\) => runHost\("js-host-native"\)\)/);
  });
});
