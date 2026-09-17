// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6491 — a linked PROVIDER calling a CONSUMER function with FEWER arguments
// than it declares.
//
// `__call_fn_N` matches only closures whose declared arity is N, so the host
// bridge's free-function arm — which dispatched at the CALL SITE's argument
// count — selected `__call_fn_0` for a 0-argument call of a 1-parameter
// closure, matched nothing, and returned `undefined`. The body never ran: no
// default-parameter initializer, no throw the callee owed its caller.
//
// In a single module that call is compiled in Wasm and never reaches the
// bridge, which is why the defect is invisible until caller and callee live in
// DIFFERENT modules — the #3451 linked test262 lane, where the harness calls
// the test body's functions (`assert.throws(SyntaxError, f)` over 14
// `language/eval-code/direct` rows scored "no exception was thrown at all").
//
// Every assertion below is a PARITY assertion: the single-module answer is the
// specification of record, and the linked lane must agree with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6491-ua-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  hostBridge: "always",
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  deferTopLevelInit: true,
} as const;

// The provider half: it calls the consumer's function with NO arguments and
// reports what it observed. `callIt` is the shape `assert.throws` has.
const PREFIX = `
function callIt(fn) {
  try { fn(); return "NO-THROW"; }
  catch (e) { return "THREW:" + (e && e.name); }
}
function valueOfCall(fn) {
  try { return "VAL:" + String(fn()); }
  catch (e) { return "THREW:" + (e && e.name); }
}
`;

let cachedProvider: HarnessProvider | undefined;
async function provider(): Promise<HarnessProvider> {
  cachedProvider ??= await buildHarnessProvider({
    harnessPrefix: PREFIX,
    cacheDir: CACHE,
    compileOptions: { allowJs: true, emitWat: false, skipSemanticDiagnostics: true },
  });
  return cachedProvider;
}

async function instantiate(result: Record<string, never>): Promise<string[]> {
  const seen: string[] = [];
  const r = result as unknown as {
    imports: never;
    stringPool: never;
    binary: Uint8Array;
    linkedModules?: unknown[];
  };
  const probeConsole = { log: (s: unknown) => seen.push(String(s)), error: () => {}, warn: () => {} };
  const importObject = buildImports(r.imports, { console: probeConsole }, r.stringPool);
  try {
    const instance = (await instantiateTest262Module(r.binary, importObject, {
      linkedModules: r.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    })) as unknown as { exports?: Record<string, unknown> };
    // The single-module lane is compiled with `deferTopLevelInit` too, but the
    // helper only runs `__module_init` on the linked arm (its `runDeferredInit`
    // lives inside the linked branch), so this lane calls it itself.
    if (!(r.linkedModules ?? []).length && typeof instance?.exports?.__module_init === "function") {
      (instance.exports.__module_init as () => void)();
    }
  } catch (error) {
    seen.push(`fail: ${String((error as { message?: string })?.message ?? error)}`);
  }
  return seen;
}

async function runLinked(body: string): Promise<string[]> {
  const result = await compileHarnessLinkedBody(await provider(), body, {
    ...OPTIONS,
    strictJsSyntax: true,
    strict: false,
  } as never);
  if (!result.success) return [`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`];
  return instantiate(result as never);
}

async function runSingleModule(body: string): Promise<string[]> {
  const result = await compile(`${PREFIX}${body}`, OPTIONS as never);
  if (!result.success) return [`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`];
  return instantiate(result as never);
}

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "an under-applied consumer function still runs its body",
    `function g(a) { console.log("RAN"); return 1; }\nconsole.log(valueOfCall(g));`,
    "VAL:1",
  ],
  [
    "a default-parameter initializer runs when the argument is missing",
    `function g(a = 9) { return a; }\nconsole.log(valueOfCall(g));`,
    "VAL:9",
  ],
  [
    "a throw raised by a default-parameter initializer reaches the provider",
    `function g(a, p = eval("var arguments")) {}\nconsole.log(callIt(g));`,
    "THREW:SyntaxError",
  ],
  [
    "the exactly-applied call is unchanged (regression guard)",
    `function g(a) { return a === undefined ? "undef" : "got"; }\nconsole.log(valueOfCall(g));`,
    "VAL:undef",
  ],
  [
    "a zero-parameter consumer function is unchanged (regression guard)",
    `function g() { return 7; }\nconsole.log(valueOfCall(g));`,
    "VAL:7",
  ],
];

describe("#6491 — under-applied cross-module call of a consumer function", () => {
  it.each(CASES)(
    "linked agrees with the single-module lane: %s",
    async (_label, body, expected) => {
      const single = await runSingleModule(body);
      expect(single).toContain(expected);
      expect(await runLinked(body)).toStrictEqual(single);
    },
    600_000,
  );
});
