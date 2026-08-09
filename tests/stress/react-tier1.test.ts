// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1033 — React Tier 1 stress test: bare-package import + direct CJS compile.
//
// Goal: drive React's `react` package through `compileProject` and document —
// at the granularity of "compiles OK / validates OK / instantiates OK / runs
// OK" — what works on `main` today. Each `it` covers one rung of the ladder;
// the last passing rung tells us where the next fix lands.
//
// Methodology mirrors `tests/stress/eslint-tier1.test.ts` and
// `tests/stress/lodash-tier1.test.ts`: an inline entry source written to a
// tmp file, run through `compileProject`, optionally instantiated and
// exercised. Failing rungs are `it.skip` with a pointer to the specific
// blocking issue so the test progressively unskips as those issues close.
//
// Companion survey: `plan/issues/backlog/react-tier1-survey.md` — captures
// the three NEW blockers discovered while writing this test:
//
//   1. `react.production.js`: `mapIntoArray` fallthru type mismatch
//      (i32 vs f64) — same family as ESLint #1558.
//   2. `react/index.js` CJS dispatch hits `process is not defined` at module
//      init — both branches of `if (process.env.NODE_ENV === ...)` should be
//      traced, or the runtime should stub `process.env`.
//   3. `react.development.js`: `"production" !== process.env.NODE_ENV && (IIFE)()`
//      silently drops the entire module body (binary validates with zero
//      exports). DCE over-eager on `&&`-short-circuit RHS.
//
// Related/upstream blockers:
//
//   - #1033 — Goal: compile React to Wasm (UI library stress test)
//   - #1043 — `process.env.NODE_ENV` DCE (gates 2 and 3 above)
//   - #1045 — DOM host imports (gates rung 1e — `React.createElement` runtime)
//   - #1559 — resolver: prefer impl over `.d.ts` for bare-package imports

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Tier 1 entry files live in `.tmp/` (gitignored). Each test writes its own
// fresh entry to avoid stale-cache surprises across vitest worker pools.
const TMP_DIR = resolve(__dirname, "../../.tmp/react-tier1");

const REACT_DEV_CJS = resolve(__dirname, "../../node_modules/react/cjs/react.development.js");
const REACT_PROD_CJS = resolve(__dirname, "../../node_modules/react/cjs/react.production.js");
const REACT_INDEX = resolve(__dirname, "../../node_modules/react/index.js");

const reactInstalled = existsSync(REACT_DEV_CJS) && existsSync(REACT_PROD_CJS) && existsSync(REACT_INDEX);
const itIfInstalled = reactInstalled ? it : it.skip;

function writeEntry(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

describe("#1033 React Tier 1 — bare-package import + direct CJS compile", () => {
  /**
   * Tier 1a — `compileProject` accepts a TypeScript entry that imports
   * `React` from the `"react"` bare package. The TypeScript checker
   * resolves the type via the bundled types (or treats it as `any` if
   * React 19's typings aren't installed). Codegen produces a valid binary;
   * `compileProject` succeeds.
   *
   * What this rung asserts: compile-time success — the type checker does
   * not reject the import, and a non-empty binary is emitted. Validation
   * is Tier 1b; the actual React body is NOT traced into this binary
   * (the resolver follows `react/index.js`'s CJS dispatch, which has its
   * own runtime-init blocker — see Tier 1f).
   */
  itIfInstalled('Tier 1a — entry with `import React from "react"` compiles', async () => {
    const entry = writeEntry(
      "tier1a-entry.ts",
      `
import React from "react";
export function test(): number {
  const el = React.createElement("div", null, "hello");
  return el ? 1 : 0;
}
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.binary.byteLength).toBeGreaterThan(0);
    }
  });

  /**
   * Tier 1b — the binary produced by Tier 1a is structurally valid Wasm.
   * Asserts via `WebAssembly.validate` (does not require host imports to
   * be satisfied — those are tested in Tier 1f). Today this passes because
   * the binary is essentially an empty shim around an unresolved
   * extern reference to `React.createElement`; the meat of React is not in
   * this binary yet.
   */
  itIfInstalled("Tier 1b — Tier 1a binary is structurally valid Wasm", async () => {
    const entry = writeEntry(
      "tier1b-entry.ts",
      `
import React from "react";
export function test(): number {
  const el = React.createElement("div", null, "hello");
  return el ? 1 : 0;
}
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Tier 1c — `compileProject` accepts the `react/cjs/react.development.js`
   * file as a direct entry. This is the full 1284-LOC dev build of React
   * core (Component, createElement, hooks, Children, createContext,
   * forwardRef, memo, lazy, Profiler).
   *
   * Current behavior: compile succeeds; the resulting binary is small
   * (~9 KB) because the entire module body lives inside
   * `"production" !== process.env.NODE_ENV && (IIFE)()` and the `&&`-RHS
   * IIFE is over-eagerly dead-code eliminated (see survey NEW issue 3).
   *
   * What this rung asserts: compile-time success against a real
   * single-file source. The binary-size and validation rungs are next.
   */
  itIfInstalled("Tier 1c — `react/cjs/react.development.js` direct compile succeeds", async () => {
    const r = await compileProject(REACT_DEV_CJS, { allowJs: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.binary.byteLength).toBeGreaterThan(0);
    }
  });

  /**
   * Tier 1d — the binary from Tier 1c instantiates without throwing.
   *
   * Today this passes BUT only because the binary is empty — the IIFE-DCE
   * bug drops the entire module body. Once survey NEW issue 3 lands and
   * the body is actually emitted (~84 KB), this rung will likely flip to
   * needing a runtime stub for `process` (survey NEW issue 2) and the
   * `mapIntoArray` codegen fix (survey NEW issue 1) before it instantiates
   * cleanly.
   *
   * Currently passing for the wrong reason; we keep it as a regression
   * canary so when the body re-enters the binary we get a loud failure
   * with a pointer to the next blocker.
   */
  itIfInstalled("Tier 1d — Tier 1c binary instantiates (currently empty — see survey NEW issue 3)", async () => {
    const r = await compileProject(REACT_DEV_CJS, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    await expect(WebAssembly.instantiate(r.binary, imps as never)).resolves.toBeDefined();
  });

  /**
   * Tier 1e — full integration: `React.createElement('div', null, 'hello')`
   * runs end-to-end and returns a non-null ReactElement-like value.
   *
   * BLOCKED on:
   *   - #1033 (overall goal — DOM host imports + reconciler)
   *   - #1045 (DOM host imports — `createElement` lives there)
   *   - survey NEW issue 1 (mapIntoArray fallthru type)
   *   - survey NEW issue 2 (process stub / both-branch resolver)
   *   - survey NEW issue 3 (`&&`-RHS IIFE DCE)
   *   - #1559 (resolver: bare-package import → impl over `.d.ts`)
   */
  it.skip("Tier 1e — `React.createElement('div', null, 'hello')` returns an element (#1033, #1045, NEW 1-3, #1559)", async () => {
    const entry = writeEntry(
      "tier1e-entry.ts",
      `
import React from "react";
export function test(): number {
  const el = React.createElement("div", null, "hello");
  return el ? 1 : 0;
}
`,
    );
    const r = await compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    const inst = await WebAssembly.instantiate(r.binary, imps as never);
    (imps as { setInstance?: Function }).setInstance?.(inst.instance);
    const ret = (inst.instance.exports as { test: () => number }).test();
    expect(ret).toBe(1);
  });

  /**
   * Tier 1f — sibling rung documenting the `react/index.js` CJS-shim
   * blocker. `index.js` is 5 lines:
   *
   *   if (process.env.NODE_ENV === 'production') {
   *     module.exports = require('./cjs/react.production.js');
   *   } else {
   *     module.exports = require('./cjs/react.development.js');
   *   }
   *
   * It compiles + validates fine but `WebAssembly.instantiate` throws at
   * module init: `ReferenceError: process is not defined`. The runtime's
   * `__extern_get("process")` faithfully re-throws because `globalThis.process`
   * isn't stubbed in `buildImports`. Resolver also does not trace into the
   * `if` branches, so neither dev nor prod body would be linked anyway.
   *
   * BLOCKED on survey NEW issue 2 (resolver + runtime stub).
   */
  it.skip("Tier 1f — `react/index.js` CJS shim instantiates (survey NEW issue 2)", async () => {
    const r = await compileProject(REACT_INDEX, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    await expect(WebAssembly.instantiate(r.binary, imps as never)).resolves.toBeDefined();
  });

  /**
   * Tier 1g — sibling rung documenting the `react.production.js` codegen
   * blocker. The full 542-LOC production module body compiles to a 31 KB
   * binary, but `WebAssembly.validate` returns `false`:
   *
   *   function #53 "mapIntoArray": fallthru[0] expected i32, got f64 @+15636
   *
   * Same i32/f64 mixed-return-type family as ESLint #1558. BLOCKED on
   * survey NEW issue 1 (return-type unification across branches with
   * mixed i32-literal and f64-arithmetic returns).
   */
  it.skip("Tier 1g — `react.production.js` direct compile validates (survey NEW issue 1)", async () => {
    const r = await compileProject(REACT_PROD_CJS, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
