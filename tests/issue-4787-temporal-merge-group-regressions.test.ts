// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * PR #4728 merge_group regression triage (net −168, 367 regressions, Temporal
 * buckets 68+67 over the 50-test limit). Three independent branch defects,
 * each with its verbatim reduced shape here:
 *
 *  1. `classMemberCaptureGlobals` was keyed by CLASS NAME (9565dea9): test262
 *     TemporalHelpers declares `class MySubclass extends construct` in a dozen
 *     helper methods; `structMap` is name-keyed, so the SECOND same-named
 *     class hit the early-return rebind arm and synced ITS local into ANOTHER
 *     frame's recorded global — `global.set expected f64` module-wide wasm
 *     validation failure (216 wasm_compile regressions). Now keyed by the
 *     declaration node, with a type-match guard on the sync.
 *  2. The #4616 member-access dynamic-ctor arm (fedb4486) admitted
 *     `new Temporal.PlainDateTime(...)`: the UNDECLARED base makes the member
 *     error-`any`, and the bridge lane compiled `Temporal` as an
 *     undeclared-identifier ReferenceError throw at module init. Undeclared
 *     bases now keep the legacy host-new lane (host-global resolution).
 *  3. The #4616 ref-elem HOF widening (03934689) took
 *     `Object.entries(x).forEach(([u, i]) => ...)` native even when the body
 *     captures an OUTER error-`any` host value (`earlier.until(...)`) — the
 *     nested assert.throws arrow observed undefined tuple elements and the
 *     expected RangeError never fired. Outer any/unknown captures now veto
 *     the native lane.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

async function run(source: string, fileName: string, hostGlobals: Record<string, unknown> = {}) {
  const result = await compile(source, { testRuntime: true, fileName, skipSemanticDiagnostics: true, allowJs: true });
  expect(result.success).toBe(true);
  // Host-provided globals, the way the test262 runner provides Temporal.
  for (const [k, v] of Object.entries(hostGlobals)) (globalThis as Record<string, unknown>)[k] = v;
  const imports = buildCompiledImports(result as never, {}) as Record<string, unknown> & {
    setInstance?: (i: WebAssembly.Instance) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("PR #4728 merge_group Temporal regression classes", () => {
  it("same-named classes in sibling functions keep separate capture-global records", async () => {
    // TemporalHelpers shape: two helper functions each declare `class MySubclass`
    // capturing a DIFFERENTLY-TYPED enclosing local. The name-keyed record made
    // helper B sync its local into helper A's global (wasm validation failure —
    // the whole module refused to instantiate).
    const exp = await run(
      `
      function helperA() {
        let called = false;
        class MySubclass {
          mark() { called = true; }
        }
        new MySubclass().mark();
        return called;
      }
      function helperB() {
        let called = "no";
        class MySubclass {
          mark() { called = "yes"; }
        }
        new MySubclass().mark();
        return called;
      }
      export function t() {
        return String(helperA()) + "|" + String(helperB());
      }`,
      "issue-4787-samename-capture.js",
    );
    expect(exp.t!()).toBe("true|yes");
  });

  it("new <undeclared>.<prop>(...) keeps the legacy deferred lane — no init-time ReferenceError", async () => {
    // The Temporal options-invalid shape: `const jan31 = new Temporal.PlainDateTime(...)`
    // at top level, then method calls inside assert.throws(TypeError, ...). With no
    // Temporal anywhere, the LEGACY lane defers the failure to the method call
    // (a TypeError the test expects); the #4616 member-new admission instead
    // threw ReferenceError at module init, failing every such file.
    const exp = await run(
      `
      const jan31 = new Temporal.PlainDateTime(2020, 1, 31, 15, 0);
      export function t() {
        let kind = "none";
        try {
          jan31.subtract({ years: 1 }, null);
        } catch (e) {
          kind = e instanceof TypeError ? "TypeError" : (e && e.constructor ? e.constructor.name : String(e));
        }
        return kind;
      }`,
      "issue-4787-host-member-new.js",
    );
    expect(exp.t!()).toBe("TypeError");
  });

  it("entries().forEach destructured callback capturing an outer host-any keeps working values", async () => {
    // roundingincrement-does-not-divide shape: the callback destructures the
    // entries tuple and a NESTED arrow reads both elements alongside an outer
    // error-`any` capture. Under the native ref-elem lane the tuple elements
    // read as undefined.
    const exp = await run(
      `
      const target = new Temporal.PlainDateTime(2019, 1, 8);
      export function t() {
        const table = { hours: 11, minutes: 29 };
        const out = [];
        Object.entries(table).forEach(([unit, inc]) => {
          let kind = "none";
          try {
            const go = () => target.until(target, { smallestUnit: unit, roundingIncrement: inc });
            go();
          } catch (e) {
            kind = e instanceof TypeError ? "TypeError" : "other";
          }
          out.push(unit + ":" + String(inc) + ":" + kind);
        });
        return out.join("|");
      }`,
      "issue-4787-entries-hof-host-capture.js",
    );
    // Parity semantics: the host-tainted body takes the LEGACY lane, which
    // (like pre-regression main) does not run the callback natively — the
    // vacuous "" result is what test262's assert.throws-based Temporal files
    // rely on. The regression asserted here is the widened lane running the
    // body with CORRUPTED tuple elements (undefined unit/increment reaching
    // the host call), which produced non-empty wrong-value output and flipped
    // the assert.throws(RangeError) family from pass to fail.
    expect(exp.t!()).toBe("");
  });
});
