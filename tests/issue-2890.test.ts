// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2890 / #2879 §4 — the standalone regression guard must be host-free-aware.
//
// A leaky-baseline pass (one that only passed by leaning on a host `env::`
// import) that flips to a HOST-FREE fail under a carrier migration is NOT a
// standalone regression — `host_free_pass` is unchanged (the leaky pass never
// counted). It must be excused from the gated regression count. But a baseline
// that was ALREADY host-free flipping to fail is a genuine regression and must
// STILL trip the guard at full strength. These tests pin both directions.

import { describe, expect, it } from "vitest";

import {
  entryHasEnvImport,
  isHostFreeResult,
  isLeaky,
  isLeakyBaselineToHostFreeRegression,
} from "../scripts/diff-test262.js";

describe("#2890 — host-free-ness helpers", () => {
  it("entryHasEnvImport detects env:: imports only", () => {
    expect(entryHasEnvImport(["env::Promise_then", "wasm:js-string::concat"])).toBe(true);
    expect(entryHasEnvImport(["wasm:js-string::concat"])).toBe(false);
    expect(entryHasEnvImport([])).toBe(false);
    expect(entryHasEnvImport(undefined)).toBe(false);
    expect(entryHasEnvImport(null)).toBe(false);
  });

  it("isHostFreeResult: leak class OR env import ⇒ not host-free", () => {
    expect(isHostFreeResult({ host_import_leak_class: "host_import" })).toBe(false);
    expect(isHostFreeResult({ imports: ["env::Promise_then"] })).toBe(false);
    expect(isHostFreeResult({ host_import_leak_class: null, imports: [] })).toBe(true);
    expect(isHostFreeResult({ host_import_leak_class: null, imports: ["wasm:js-string::concat"] })).toBe(true);
    // absent on the new side (e.g. test removed) ⇒ no host dependency
    expect(isHostFreeResult(undefined)).toBe(true);
  });

  it("isLeaky: a recorded leak class or an env import ⇒ leaky", () => {
    expect(isLeaky({ host_import_leak_class: "iterator_protocol" })).toBe(true);
    expect(isLeaky({ imports: ["env::__make_callback"] })).toBe(true);
    expect(isLeaky({ host_import_leak_class: null, imports: [] })).toBe(false);
    expect(isLeaky(undefined)).toBe(false);
  });
});

describe("#2890 — isLeakyBaselineToHostFreeRegression (both directions)", () => {
  it("EXCUSES a leaky-baseline pass → host-free fail (carrier migration removed host dep)", () => {
    const base = {
      file: "t.js",
      status: "pass",
      host_import_leak_class: "host_import",
      imports: ["env::Promise_then"],
    };
    const cur = { file: "t.js", status: "fail", host_import_leak_class: null, imports: [] };
    expect(isLeakyBaselineToHostFreeRegression(base, cur)).toBe(true);
  });

  it("EXCUSES a leaky-baseline pass → host-free compile_error (incomplete native carrier)", () => {
    const base = { file: "t.js", status: "pass", host_import_leak_class: "host_import" };
    const cur = { file: "t.js", status: "compile_error" }; // no binary ⇒ host-free
    expect(isLeakyBaselineToHostFreeRegression(base, cur)).toBe(true);
  });

  it("DOES NOT excuse a genuine host-free baseline → fail (real regression, full strength)", () => {
    const base = { file: "t.js", status: "pass", host_import_leak_class: null, imports: [] };
    const cur = { file: "t.js", status: "fail", host_import_leak_class: null, imports: [] };
    expect(isLeakyBaselineToHostFreeRegression(base, cur)).toBe(false);
  });

  it("DOES NOT excuse a leaky-baseline pass → still-leaky fail (host dep retained)", () => {
    const base = { file: "t.js", status: "pass", imports: ["env::Promise_then"] };
    const cur = { file: "t.js", status: "fail", imports: ["env::Promise_then"] };
    expect(isLeakyBaselineToHostFreeRegression(base, cur)).toBe(false);
  });

  it("DOES NOT excuse when the baseline was not a pass", () => {
    const base = { file: "t.js", status: "fail", imports: ["env::Promise_then"] };
    const cur = { file: "t.js", status: "compile_error" };
    expect(isLeakyBaselineToHostFreeRegression(base, cur)).toBe(false);
  });
});
