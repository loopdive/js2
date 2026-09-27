// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 — `e.constructor` read by a linked PROVIDER off a CONSUMER instance.
//
// `_classChainRead` is the runtime arm that makes a compiled class instance
// answer `constructor` with its class OBJECT rather than with `%Object%` (a
// struct-backed instance) or the synthetic `Sub` minted by
// `__set_subclass_proto` (an externref-backed `class E extends Error`). It was
// gated on `_classObjectOwnedBy`, i.e. "the module reading this value is the
// module that registered the class" — an assumption that is simply false for a
// #2527 linked graph, where the test262 harness PROVIDER reads instances whose
// class the test BODY declared. The arm bailed, the read fell through to the
// generic host path, and the provider got back an object that was NOT the one
// the consumer's own `C` crossed as. `assert.throws(C, fn)` then rejected an
// error it had just caught correctly.
//
// The assertions below are parity assertions on purpose: each one compares the
// LINKED answer against the answer the same source gives as a single module.
// The single-module answer is the specification of record here — the point of
// the linked lane is to agree with it, not to be independently plausible.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-cv-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

// A four-line stand-in for `assert.throws`: the provider catches the consumer's
// error and compares `thrown.constructor` against the constructor the consumer
// passed it. That comparison is the whole bug. The verdict is RETURNED rather
// than printed because a provider rebuilds its own `env` (#6475), so its
// `console` is not the probe this test installs on the consumer's.
const PREFIX = `
function throwsWith(C, fn) {
  try { fn(); return "NO-THROW"; }
  catch (e) { return "sameCtor=" + (e.constructor === C); }
}
function ctorOfIs(e, C) { return "sameCtor=" + (e.constructor === C); }
`;

let cachedProvider: HarnessProvider | undefined;
async function provider(): Promise<HarnessProvider> {
  cachedProvider ??= await buildHarnessProvider({
    harnessPrefix: PREFIX,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
  return cachedProvider;
}

/** The strings the program reported, or a `fail: …` marker. */
async function runLinked(body: string): Promise<string[]> {
  const result = await compileHarnessLinkedBody(await provider(), body, { ...OPTIONS, strict: false });
  if (!result.success) return [`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`];
  return instantiate(result, body);
}

async function runSingleModule(body: string): Promise<string[]> {
  const result = await compile(`${PREFIX}\n${body}`, OPTIONS as never);
  if (!result.success) return [`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`];
  return instantiate(result, body);
}

async function instantiate(result: Record<string, never>, _body: string): Promise<string[]> {
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
    await instantiateTest262Module(r.binary, importObject, {
      linkedModules: r.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
  } catch (error) {
    seen.push(`fail: ${String((error as { message?: string })?.message ?? error)}`);
  }
  return seen;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "an Error subclass caught by the provider keeps constructor identity",
    `class MyErr extends Error {}
     console.log(throwsWith(MyErr, function () { throw new MyErr("boom"); }));`,
  ],
  [
    "the same read outside a catch, through a second provider entry point",
    `class MyErr extends Error {}
     console.log(ctorOfIs(new MyErr("x"), MyErr));`,
  ],
  [
    "a NATIVE error is unaffected (regression guard on the arm that already worked)",
    `console.log(throwsWith(TypeError, function () { throw new TypeError("boom"); }));`,
  ],
];

describe("#6492 — a consumer class object crossing into a linked provider", () => {
  it.each(CASES)(
    "linked agrees with the single-module lane: %s",
    async (_label, body) => {
      const single = await runSingleModule(body);
      expect(single).toContain("sameCtor=true");
      expect(await runLinked(body)).toStrictEqual(single);
    },
    600_000,
  );
});
