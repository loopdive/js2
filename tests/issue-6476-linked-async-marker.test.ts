// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6476 — the async completion marker must cross the provider boundary.
//
// `$DONE` lives in `doneprintHandle.js`, which in the linked lane is compiled
// into the PROVIDER. Its body is `print(msg)` → `console.log(...)`, and the
// worker's completion poll scans the row's capturing console proxy
// (`harnessOutput` in `scripts/test262-worker.mjs`). The provider's `env` was
// rebuilt with no host deps, so its `console` was the REAL one: the marker was
// printed, to a sink nobody was watching, and every async row reported
// "async completion marker not observed" (49 rows, the largest residual class
// of the #3451 slice-3 sample).
//
// Same root cause as #6475 and the same fix (`linkedHost`), so this file is the
// verification the issue asks for rather than a second mechanism: resolving and
// rejecting bodies, marker asserted to reach the capture WITH the host context
// and asserted NOT to reach it without.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
// @ts-expect-error -- untyped runner helper
import { SANDBOX_GLOBAL_NAMES } from "../scripts/test262-sandbox-globals.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6476-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

/** The worker's per-row console proxy, reduced to the sink the poll reads. */
function captureConsole(sink: string[]): { log: (...v: unknown[]) => void; error: (...v: unknown[]) => void } {
  const append = (...values: unknown[]): void => {
    sink.push(values.map(String).join(" "));
  };
  return { log: append, error: append };
}

function buildSandbox(consoleProxy: unknown): Record<string, unknown> {
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const context = createContext(sandbox);
  for (const name of SANDBOX_GLOBAL_NAMES as readonly string[]) {
    try {
      sandbox[name] = runInContext(name, context);
    } catch {
      /* a name this Node build does not have */
    }
  }
  sandbox.console = consoleProxy;
  sandbox.globalThis = sandbox;
  // (#3428) `asyncHelpers.js` guards on `hasOwnProperty(globalThis, "$DONE")`;
  // the real, module-local `$DONE` is what actually runs.
  sandbox.$DONE = () => {};
  return sandbox;
}

const providers = new Map<string, HarnessProvider>();
async function providerFor(harnessPrefix: string): Promise<HarnessProvider> {
  let provider = providers.get(harnessPrefix);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: OPTIONS });
    providers.set(harnessPrefix, provider);
  }
  return provider;
}

const ASYNC_HEADER = `/*---\nflags: [async]\nincludes: [asyncHelpers.js]\n---*/\n`;

/**
 * Run an `async`-flagged body linked and return everything the row's console
 * proxy saw — which is exactly what the worker's marker poll scans.
 */
async function linkedOutput(body: string, withHost: boolean): Promise<string[]> {
  const source = ASYNC_HEADER + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  expect(assembly.async).toBe(true);
  const provider = await providerFor(assembly.harnessPrefix);
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) throw new Error(`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`);
  const sink: string[] = [];
  const consoleProxy = captureConsole(sink);
  const sandbox = buildSandbox(consoleProxy);
  const importObject = buildImports(result.imports as never, { console: consoleProxy }, result.stringPool as never, {
    globalSandbox: sandbox,
  });
  await instantiateTest262Module(result.binary, importObject, {
    linkedModules: result.linkedModules ?? [],
    runDeferredInit: true,
    linkedRuntime,
    linkedHost: withHost ? { deps: { console: consoleProxy }, options: { globalSandbox: sandbox } } : undefined,
  });
  // The worker polls with a 1s deadline; a handful of macrotask turns is the
  // same wait without the wall-clock cost.
  for (let turn = 0; turn < 20 && !sink.some((line) => line.includes("Test262:Async")); turn++) {
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 5));
  }
  return sink;
}

const RESOLVING = `Promise.resolve(1).then(function () { $DONE(); }, $DONE);`;
const REJECTING = `Promise.reject(new Test262Error("boom")).then(function () { $DONE("resolved unexpectedly"); }, $DONE);`;

describe("#6476 — the async completion marker crosses the provider boundary", () => {
  beforeAll(async () => {
    const source = ASYNC_HEADER + RESOLVING;
    await providerFor(assembleLinkedHarness(source, parseMeta(source)).harnessPrefix);
  }, 300_000);

  it("a resolving async body reaches the row's console with the completion marker", async () => {
    const output = await linkedOutput(RESOLVING, true);
    expect(output.join("\n")).toContain("Test262:AsyncTestComplete");
  }, 300_000);

  it("a rejecting async body reports the failure marker, carrying the error text", async () => {
    const output = await linkedOutput(REJECTING, true);
    const failure = output.find((line) => line.includes("Test262:AsyncTestFailure"));
    expect(failure).toBeDefined();
    expect(failure).toContain("Test262Error");
    expect(failure).toContain("boom");
    expect(output.join("\n")).not.toContain("Test262:AsyncTestComplete");
  }, 300_000);

  // The repro. Without the host context the provider's `print` goes to the real
  // console, so the row's sink stays empty and the worker reports "async
  // completion marker not observed" — the 49-row class. Asserting the negative
  // is what makes the two passing cases evidence of this fix rather than of the
  // marker happening to work.
  it("without linkedHost the marker never reaches the row's console", async () => {
    const output = await linkedOutput(RESOLVING, false);
    expect(output.join("\n")).not.toContain("Test262:AsyncTestComplete");
  }, 300_000);
});
