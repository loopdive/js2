// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "./helpers.js";

// #6996 — `await <settled>` must yield one microtask turn (§27.7.5.3): the code
// after the CALL SITE runs before the continuation. The gc (JS-host) lane does
// this since #6780. Standalone/WASI do NOT yet: the drive gate still elides an
// all-settled body in a host-free environment (#6982 kept that fast path on
// purpose), and lifting it re-pins ~25 host-free tests whose drain contract
// relies on synchronous settlement — measured in the #6996 issue file.
//
// The standalone cases are `it.fails`: they document the open bug and flip to
// failures (i.e. start passing) the moment #6996 lands — turn them into `it`.

async function runWasm(src: string, target: "standalone" | "gc"): Promise<string[]> {
  const result = await compile(src, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
    ...(target === "standalone" ? { target: "standalone" as const } : { semanticProviders: "host-assisted" as const }),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const out: string[] = [];
  let imports: WebAssembly.Imports = {};
  if (target === "gc") {
    imports = result.importObject as WebAssembly.Imports;
    const env = ((imports as Record<string, unknown>).env ?? {}) as Record<string, unknown>;
    for (const k of ["console_log_number", "console_log_string", "console_log_bool"]) {
      env[k] = (v: unknown) => out.push(String(v));
    }
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  const exp = instance.exports as Record<string, (...a: number[]) => number>;
  exp.__module_init?.();
  exp.__drain_microtasks?.();
  // gc lane: host microtasks (the JS Promise queue) run after this turn.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  if (typeof exp.__stdout_prepare === "function") {
    const len = exp.__stdout_prepare() | 0;
    let sink = "";
    for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
    for (const line of sink.split("\n")) if (line.length > 0) out.push(line);
  }
  return out;
}

async function runNode(src: string): Promise<string[]> {
  const out: string[] = [];
  new Function("console", src)({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  return out;
}

const LOG = `function log(v) { console.log(String(v)); }\n`;

const REPROS: Record<string, { src: string; expected: string[] }> = {
  "await null": {
    src: `async function a() { log(1); await null; log(3); } a(); log(2);`,
    expected: ["1", "2", "3"],
  },
  "await Promise.resolve()": {
    src: `async function a() { log(1); await Promise.resolve(); log(3); } a(); log(2);`,
    expected: ["1", "2", "3"],
  },
  "await of a synchronously-returning async fn": {
    src: `async function inner() { return 1; } async function a() { log(1); await inner(); log(3); } a(); log(2);`,
    expected: ["1", "2", "3"],
  },
  "chain interleaving": {
    src: `async function a() { log("a1"); await null; log("a2"); }
      Promise.resolve().then(() => log("t1")).then(() => log("t2")).then(() => log("t3"));
      a();
      Promise.resolve().then(() => log("x1"));`,
    expected: ["a1", "t1", "a2", "x1", "t2", "t3"],
  },
};

describe("#6996 await of a settled operand yields a microtask turn", () => {
  for (const [name, { src, expected }] of Object.entries(REPROS)) {
    it(`node reference: ${name}`, async () => {
      expect(await runNode(LOG + src)).toEqual(expected);
    });

    it(`host-assisted gc control matches node: ${name}`, async () => {
      expect(await runWasm(LOG + src, "gc")).toEqual(expected);
    });

    it.fails(`standalone matches node (OPEN, #6996): ${name}`, async () => {
      expect(await runWasm(LOG + src, "standalone")).toEqual(expected);
    });
  }
});
