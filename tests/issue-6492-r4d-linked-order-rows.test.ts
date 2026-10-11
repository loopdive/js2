// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 4d — the four honest-pass/linked-fail `built-ins/Iterator`
// "observation order" rows. They looked like one iterator-ordering bug and were
// two unrelated defects, neither of which is about iterators:
//
//  1. **Proxy traps died at the module seam.** `_buildProxyBridgeHandler` read
//     the handler's trap fields with the READER module's `__sget_<trap>`
//     getters. A handler minted by the linked harness provider
//     (`allowProxyTraps(...)` from `proxyTrapsHelper.js`) is a struct of the
//     PROVIDER module, so every getter `ref.test`-missed, every trap resolved
//     ABSENT, and the host silently used its default internal method — the user
//     traps never fired and nothing threw. Every other struct read already does
//     the #5225 cross-module decoder selection; the proxy bridge was the one
//     reader that skipped it. (`Iterator/zipKeyed/*` — the tests observe the
//     spec's Get/own-keys order through exactly such a handler.)
//
//     Note the asymmetry the fix has to respect: the HANDLER's owning module
//     decides how to READ the trap fields, but each TRAP CLOSURE's own owning
//     module decides how to DISPATCH it — a provider-minted handler routinely
//     holds a consumer-minted closure. Using the handler's module for both
//     recurses until the stack overflows.
//
//  2. **A top-level destructuring ASSIGNMENT was lost.** In a module-init
//     chunk, `({ value, done } = …)` stored only to the `$__mod_<name>` global
//     while every read resolved the mirrored LOCAL that the `let { value, done
//     } = …` declaration had established. `emitResolvedIdentifierWriteFromStack`
//     mirrors into `fctx.moduleBindingShadowLocals`, but that registry only
//     knows bindings declared through the closure-global arm — a destructuring
//     declaration registers none. (`Iterator/prototype/{map,filter}/
//     underlying-iterator-advanced-in-parallel.js`: the helper returned the
//     right value and the test still read the pre-assignment one.)
//
// Measured with the real runner (fresh harness cache, rebuilt bundles):
// linked `built-ins/Iterator/` 394 → 398 of 654, zero rows lost; over
// `Proxy + Reflect + assignment + destructuring + Iterator` (1,624 rows)
// linked 1,165 → 1,172, again zero lost — the three extra are
// `Proxy/{has/call-in-prototype, set/call-parameters-prototype*}`, which read
// the trap's `this`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-r4d-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

interface LaneRun {
  verdict: Verdict;
  logs: string[];
}

async function run(result: {
  success: boolean;
  errors?: { message: string }[];
  binary?: Uint8Array;
  imports?: unknown;
  stringPool?: unknown;
  linkedModules?: unknown[];
}): Promise<LaneRun> {
  const logs: string[] = [];
  if (!result.success) {
    return { verdict: `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`, logs };
  }
  const runtime = await import("../src/runtime.js");
  const importObject = runtime.buildImports(
    result.imports as never,
    {
      console: { log: (...a: unknown[]) => logs.push(a.map(String).join(" ")) },
    },
    result.stringPool as never,
  );
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return { verdict: "pass", logs };
  } catch (error) {
    return { verdict: `fail: ${String((error as { message?: string })?.message ?? error)}`, logs };
  }
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

/** Run one body through the LINKED lane — the lane the four rows failed in. */
async function linked(source: string): Promise<LaneRun> {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  return run(
    await compileHarnessLinkedBody(provider, assembly.primary.body, {
      ...OPTIONS,
      strict: assembly.primary.strict,
    }),
  );
}

/** Run one body through the HONEST lane — must not regress. */
async function honest(source: string): Promise<LaneRun> {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  return run(await compile(assembly.harnessPrefix + assembly.primary.bodySource, OPTIONS));
}

describe("#6492 r4d — proxy traps across the linked module seam", () => {
  // The defect in its smallest honest form: the handler is built by a HARNESS
  // function, so it is a provider-module struct. Before the fix `log` stayed
  // empty and `p.a` silently read the target — no trap, no throw, no signal.
  const CROSS_SEAM = `/*---
description: handler built by the harness provider
includes: [proxyTrapsHelper.js]
---*/
var log = [];
var trap = function (t, k, r) {
  log.push(k);
  return Reflect.get(t, k, r);
};
var h = allowProxyTraps({ get: trap });
var p = new Proxy({ a: 1 }, h);
console.log("value", String(p.a));
console.log("log", log.join(","));
`;

  it("fires a provider-minted handler's trap in the linked lane", async () => {
    const { verdict, logs } = await linked(CROSS_SEAM);
    expect(verdict).toBe("pass");
    expect(logs.join(" ")).toContain("value 1");
    // The regression signature: `log` with nothing after it (empty join).
    expect(logs.join(" ")).toContain("log a");
  });

  it("keeps the trap's OWN module as its dispatch module (no self-recursion)", async () => {
    // `h.get` is a CONSUMER closure stored in a PROVIDER handler. Dispatching
    // it with the handler's module state overflows the stack; the verdict
    // below is the guard against re-introducing that.
    const { verdict } = await linked(CROSS_SEAM);
    expect(verdict).not.toMatch(/Maximum call stack/);
  });

  it("leaves a body-local handler alone", async () => {
    const source = `/*---
description: handler built in the body
---*/
var log = [];
var p = new Proxy({ a: 1 }, { get: function (t, k, r) { log.push(k); return Reflect.get(t, k, r); } });
console.log("value", String(p.a));
console.log("log", log.join(","));
`;
    // LINKED only. The honest whole-assembly lane already mishandles a
    // body-local handler on `main` (it reads `p.a` as NaN and fires no trap) —
    // verified against the unpatched tree, so it is a pre-existing gap, not
    // something round 4d introduced or is in scope to fix.
    const { logs } = await linked(source);
    expect(logs.join(" ")).toContain("log a");
  });
});

describe("#6492 r4d — top-level destructuring assignment reaches the reader", () => {
  // `let { … } = …` mirrors global+local; `({ … } = …)` wrote only the global.
  // Reads resolve the local, so the assignment was invisible. The `assert`
  // calls are load-bearing: they are what makes the reader take the local path,
  // which is why the bug looked shape-dependent (a body with no 2-argument
  // call compiled correctly).
  const SOURCE = `/*---
description: destructuring assignment to an existing top-level binding
---*/
let iterator = (function* () {
  for (let i = 0; i < 5; ++i) {
    yield i;
  }
})();
let mapped = iterator.map(x => x);
let { value, done } = iterator.next();
assert.sameValue(value, 0);
assert.sameValue(done, false);
iterator.next();
iterator.next();
({ value, done } = mapped.next());
assert.sameValue(value, 3);
assert.sameValue(done, false);
({ value, done } = mapped.next());
assert.sameValue(value, 4);
`;

  it("passes in the linked lane", async () => {
    expect((await linked(SOURCE)).verdict).toBe("pass");
  });

  it("does not regress the honest lane", async () => {
    // The honest lane's verdict is whatever it was; it must not become a
    // FAILED ASSERTION, which is the shape a lost write produces.
    const { verdict } = await honest(SOURCE);
    expect(verdict).not.toMatch(/Expected SameValue/);
  });

  it("assigns through a destructuring assignment with no helper involved", async () => {
    const source = `/*---
description: minimal — two-argument call present so the reader takes the local
---*/
let { value, done } = { value: 0, done: false };
assert.sameValue(value, 0);
({ value, done } = { value: 7, done: true });
assert.sameValue(value, 7);
assert.sameValue(done, true);
`;
    expect((await linked(source)).verdict).toBe("pass");
    expect((await honest(source)).verdict).toBe("pass");
  });
});
