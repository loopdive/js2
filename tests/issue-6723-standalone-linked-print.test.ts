// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6723 D4 (print slice) — on standalone, the linked harness provider's `print`
// must reach a sink the worker can drain.
//
// `print`/`$DONE` live in the PROVIDER. On standalone there is no host console:
// `print` appends to the module's in-wasm `__stdout_acc` rope and the worker
// reads it back through `__stdout_prepare`/`__stdout_char` (#3469). Those two
// exports are host-bridge exports, which standalone STRIPS unless the compile
// asks for `hostBridge: "always"` — and the worker's linked compile sites
// (provider + body) did not, unlike every other worker compile site
// (`HARNESS_HOST_BRIDGE`). So the marker was written to a sink with no reader
// and 18 of the P0 sample's async rows reported "async completion marker not
// observed". The fix is the option; this file pins both halves: with it the
// marker and a plain `print` are observed, without it the provider publishes no
// sink at all (the repro).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module, resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6723-print-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

type Bridge = "always" | undefined;

function options(hostBridge: Bridge) {
  return {
    allowJs: true,
    fileName: "test.js",
    emitWat: false,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone" as const,
    ...(hostBridge ? { hostBridge } : {}),
  };
}

const providers = new Map<string, HarnessProvider>();
async function providerFor(harnessPrefix: string, hostBridge: Bridge): Promise<HarnessProvider> {
  const key = `${hostBridge ?? "auto"}\u0000${harnessPrefix}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: options(hostBridge) });
    providers.set(key, provider);
  }
  return provider;
}

type Exports = Record<string, unknown>;

/** The worker's `drainAndCaptureNativeStdout` for a linked row, reduced. */
function drainAndRead(modules: Exports[]): string[] {
  for (let round = 0; round < 8; round++) {
    for (const exp of modules) {
      if (typeof exp.__drain_microtasks === "function") (exp.__drain_microtasks as () => void)();
    }
  }
  const lines: string[] = [];
  for (const exp of modules) {
    const prepare = exp.__stdout_prepare as (() => number) | undefined;
    const char = exp.__stdout_char as ((i: number) => number) | undefined;
    if (typeof prepare !== "function" || typeof char !== "function") continue;
    const len = prepare() | 0;
    let out = "";
    for (let i = 0; i < len; i++) out += String.fromCharCode(char(i) & 0xffff);
    for (const line of out.split("\n")) if (line.length > 0) lines.push(line);
  }
  return lines;
}

async function linkedStdout(
  header: string,
  body: string,
  hostBridge: Bridge,
): Promise<{ lines: string[]; providerSink: boolean; consumerImports: number }> {
  const source = header + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix, hostBridge);
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...options(hostBridge),
    strict: assembly.primary.strict,
  });
  if (!result.success) throw new Error(`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`);
  const importObject = buildImports(result.imports as never, undefined, result.stringPool as never) as Record<
    string,
    unknown
  >;
  // The provider imports the runtime-eval ABI (`$262.evalScript`); nothing
  // here calls it, so a refusing stub satisfies the link. Selecting no eval
  // engine keeps this test independent of a prebuilt provider artifact, which
  // the issue-tests CI job does not build (same pattern as the #6723 D2 test).
  const refuse = () => {
    throw new Error("runtime-eval not available in this test");
  };
  importObject["js2wasm:runtime-eval"] = new Proxy({}, { get: () => refuse });
  const previous = process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER;
  process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER = "1";
  resetTest262RuntimeEvalProviderForTest();
  let instance: WebAssembly.Instance;
  try {
    instance = (await instantiateTest262Module(result.binary, importObject, {
      target: "standalone",
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    })) as WebAssembly.Instance;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "TEST262_DISABLE_RUNTIME_EVAL_PROVIDER");
    else process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER = previous;
    resetTest262RuntimeEvalProviderForTest();
  }
  const peers = (result.linkedModules ?? [])
    .map((artifact) => importObject[artifact.namespace] as Exports | undefined)
    .filter((exp): exp is Exports => !!exp && typeof exp === "object");
  expect(peers.length).toBeGreaterThan(0);
  const providerSink = peers.some((exp) => typeof exp.__stdout_prepare === "function");
  return {
    lines: drainAndRead([instance.exports as Exports, ...peers]),
    providerSink,
    consumerImports: (result.imports ?? []).length,
  };
}

const ASYNC_HEADER = `/*---\nflags: [async]\nincludes: [asyncHelpers.js]\n---*/\n`;
// No `async` flag: `$DONE()` runs synchronously in the body, and its `print`
// runs in the provider before instantiation returns.
const SYNC_HEADER = `/*---\nincludes: [doneprintHandle.js]\n---*/\n`;
const RESOLVING = `Promise.resolve(1).then(function () { $DONE(); }, $DONE);`;

describe("#6723 D4 — the standalone linked provider's print reaches the drain", () => {
  it("an async body's $DONE completion marker is observed", async () => {
    const run = await linkedStdout(ASYNC_HEADER, RESOLVING, "always");
    expect(run.consumerImports).toBe(0);
    expect(run.providerSink).toBe(true);
    expect(run.lines).toContain("Test262:AsyncTestComplete");
  }, 300_000);

  it("a sync print from the provider reaches the drain", async () => {
    const run = await linkedStdout(SYNC_HEADER, `$DONE();`, "always");
    expect(run.consumerImports).toBe(0);
    expect(run.lines).toContain("Test262:AsyncTestComplete");
  }, 300_000);

  // The repro: standalone's default strips the sink exports from the provider,
  // so nothing the worker drains can ever carry the marker.
  it("without hostBridge the provider publishes no stdout sink", async () => {
    const run = await linkedStdout(ASYNC_HEADER, RESOLVING, undefined);
    expect(run.providerSink).toBe(false);
    expect(run.lines).not.toContain("Test262:AsyncTestComplete");
  }, 300_000);
});
