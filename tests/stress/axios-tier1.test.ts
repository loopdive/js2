// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1032 — axios Tier 1 stress test: minimal `axios.get()` smoke test.
//
// Goal: drive the axios module graph through `compileProject` and
// document — at the granularity of "compiles OK / validates OK /
// instantiates OK / runs OK" — what works on `main` today. Each `it`
// covers one rung of the ladder; the last passing rung tells us where
// the next fix lands.
//
// Methodology mirrors `tests/stress/eslint-tier1.test.ts` and
// `tests/stress/react-tier1.test.ts`: an inline entry source written to
// a tmp file, run through `compileProject`, optionally validated /
// instantiated / exercised. Every failing rung is `it.skip` with a
// pointer to the specific blocking issue so the test progressively
// unskips as those issues close.
//
// Survey reference: `plan/issues/backlog/axios-tier1-survey.md` —
// captures the three NEW blockers observed across 10 entry points
// (bare-package shim, CJS bundle, ESM aggregator, lib/utils, lib/core,
// lib/adapters). Tracking parent: `plan/issues/backlog/1032-compile-axios-to-wasm-node.md`.
//
// Blockers discovered while writing this test (pending sprint issue
// filing — placeholders #TBD-1..#TBD-3 until PO triages):
//
//   - #TBD-1 — `compileProject` hangs on every entry that pulls in the
//     full `lib/core/Axios.js` graph (4 of 10 entries: `index.js`,
//     `lib/axios.js`, `lib/core/Axios.js`, `lib/adapters/http.js`).
//     Non-termination, not a slow compile — kill-9 is the only escape.
//     This is the most severe blocker; gates four Tier 1 rungs.
//   - #TBD-2 — `AxiosHeaders_set` validation error:
//       `any.convert_extern[0] expected externref, found global.get of type (ref null N)`
//     Extern boxing missing for the WasmGC-struct → externref direction.
//     Seen on `dist/node/axios.cjs` and `lib/core/AxiosError.js`.
//   - #TBD-3 — `isBuffer` validation error:
//       `fallthru[0] expected i32, got f64`
//     `&&` chain mixes i32 short-circuit branches with an f64-typed
//     terminal extern call. Same family as ESLint #1558 (`f64.eq[0]`)
//     and the React-tier1 `mapIntoArray` finding — strong candidate
//     for an umbrella issue covering all three libraries.
//
// Existing related issues:
//
//   - #1032 — parent goal (Compile axios to Wasm — Node builtins host imports)
//   - #1042 — async/await state-machine lowering (gates real I/O smoke test)
//   - #1043 — process.env.NODE_ENV DCE (helps the CJS dispatch shim case)
//   - #1044 — Node-builtin host-import routing (gates Tier 4 adapter)
//   - #1287 / #1289 — sibling validation-error patterns in ESLint tier1
//   - #1558 — Linter_verifyAndFix `f64.eq[0]` — shared family with #TBD-3

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Tier 1 entry files live in `.tmp/` (gitignored). Each test writes its own
// fresh entry to avoid stale-cache surprises across vitest worker pools.
const TMP_DIR = resolve(__dirname, "../../.tmp/axios-tier1");

const AXIOS_INSTALLED = existsSync(resolve(__dirname, "../../node_modules/axios/package.json"));
const AXIOS_ROOT = resolve(__dirname, "../../node_modules/axios");
const runIfAxios = AXIOS_INSTALLED ? it : it.skip;

function writeEntry(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

describe("#1032 axios Tier 1 — minimal axios.get() smoke test", () => {
  /**
   * Tier 1a — `compileProject` accepts a TypeScript entry that
   * imports `axios` as the default export. The TypeScript checker
   * resolves the type via the bundled `index.d.ts`. Codegen falls
   * back to extern handling because the JS implementation graph
   * (rooted at `lib/core/Axios.js`) is gated on #TBD-1.
   *
   * What this rung asserts: compile-time success — the type checker
   * does not reject the import. Validation is the next rung.
   */
  runIfAxios('Tier 1a — entry with `import axios from "axios"` compiles', () => {
    const entry = writeEntry(
      "tier1a-entry.ts",
      `
import axios from "axios";
export function test(): number {
  return typeof axios === "function" ? 1 : 0;
}
`,
    );
    const r = compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.binary.byteLength).toBeGreaterThan(0);
    }
  });

  /**
   * Tier 1b — the binary produced by Tier 1a is structurally valid Wasm.
   * Asserts via `WebAssembly.validate` (does not require host imports
   * to be satisfied — those are tested in Tier 1e/1f). The bare-package
   * shim binary is small (~4 KB) because the type-only import does not
   * pull in axios source — the real-source rungs are 1c and 1e.
   */
  runIfAxios("Tier 1b — Tier 1a binary is structurally valid Wasm", () => {
    const entry = writeEntry(
      "tier1b-entry.ts",
      `
import axios from "axios";
export function test(): number {
  return typeof axios === "function" ? 1 : 0;
}
`,
    );
    const r = compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Tier 1c — `compileProject` accepts the bundled CJS distribution
   * `dist/node/axios.cjs` as a direct entry (bypasses the package
   * entry resolver). The 5 469 LOC CJS bundle compiles in ~30 s,
   * producing a ~502 KB binary. The internal CJS `require()` graph
   * is traced because the bundle is self-contained.
   *
   * What this rung asserts: compile-time success against the real
   * production CJS bundle. Validation is the next rung (1d).
   */
  runIfAxios("Tier 1c — `dist/node/axios.cjs` direct compile succeeds", () => {
    const r = compileProject(`${AXIOS_ROOT}/dist/node/axios.cjs`, { allowJs: true });
    expect(r.success).toBe(true);
    if (r.success) {
      // Bundle is ~502 KB on axios@1.16.1; assert lower bound to allow drift.
      expect(r.binary.byteLength).toBeGreaterThan(400_000);
    }
  });

  /**
   * Tier 1d — the binary from Tier 1c validates. Currently fails inside
   * `AxiosHeaders_set` with
   *   `any.convert_extern[0] expected externref, found global.get of type (ref null 555)`
   * — a typing gap on extern boxing when a WasmGC struct ref is written
   * into a host property. The codegen emits `any.convert_extern` for
   * the boxing step but the input value is still a typed struct ref,
   * not an `externref`.
   *
   * BLOCKED on #TBD-2.
   */
  it.skip("Tier 1d — `dist/node/axios.cjs` binary validates (#TBD-2 AxiosHeaders_set extern boxing)", () => {
    const r = compileProject(`${AXIOS_ROOT}/dist/node/axios.cjs`, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Tier 1e — `compileProject` accepts `lib/axios.js` (the ESM entry
   * that `index.js` re-exports) as a direct entry. This walks the
   * real source graph: `lib/core/Axios.js`, `InterceptorManager.js`,
   * `dispatchRequest.js`, `mergeConfig.js`, `AxiosHeaders.js`,
   * plus the helpers under `lib/helpers/`.
   *
   * Currently HANGS — `compileProject` never returns within 60-180 s,
   * burning ~100% CPU. The hang reproduces on four distinct entries
   * (`index.js`, `lib/axios.js`, `lib/core/Axios.js`, `lib/adapters/http.js`),
   * all of which transitively import `lib/core/Axios.js`. The two
   * non-hanging real-source entries (`lib/utils.js`, `lib/core/AxiosError.js`)
   * do NOT import it.
   *
   * BLOCKED on #TBD-1.
   */
  it.skip("Tier 1e — `lib/axios.js` direct compile succeeds (#TBD-1 compileProject hang on Axios.js graph)", () => {
    const r = compileProject(`${AXIOS_ROOT}/lib/axios.js`, { allowJs: true });
    expect(r.success).toBe(true);
  });

  /**
   * Tier 1f — full integration: `axios.get("https://httpbin.org/get")`
   * runs end-to-end and resolves with `status === 200`. Requires
   * Tiers 1a-1e plus Node host-import routing (#1044), real async/await
   * state-machine lowering (#1042), and the Buffer global registration
   * noted in the #1032 architect assessment.
   *
   * BLOCKED on #TBD-1, #TBD-2, #TBD-3, #1042, #1043, #1044.
   */
  it.skip("Tier 1f — `axios.get(httpbin)` resolves with status 200 (#TBD-1, #TBD-2, #TBD-3, #1042, #1043, #1044)", async () => {
    const entry = writeEntry(
      "tier1f-entry.ts",
      `
import axios from "axios";
export async function test(): Promise<number> {
  const res = await axios.get("https://httpbin.org/get");
  return res.status;
}
`,
    );
    const r = compileProject(entry, { allowJs: true });
    expect(r.success).toBe(true);
    // The actual instantiate + invoke path is gated on the dependency
    // chain in the doc comment above; we don't even attempt it here
    // until the upstream blockers land.
  });

  /**
   * Smoke probes — these are sub-targets within the Tier 1 ladder that
   * validate individual real-source files in isolation. They surface
   * the same blockers as 1d/1e but at smaller granularity, useful for
   * bisecting which fix unblocks which slice of the axios graph.
   *
   * Tier 1g — `lib/utils.js` validates. Currently fails inside
   * `isBuffer` with
   *   `fallthru[0] expected i32, got f64`
   * — the `&&` chain mixes i32 short-circuit branches with an
   * f64-typed terminal extern call (`val.constructor.isBuffer(val)`).
   * Same family as ESLint #1558 (`f64.eq[0]`) and the React-tier1
   * `mapIntoArray` finding. Strong candidate for a shared umbrella fix.
   *
   * BLOCKED on #TBD-3.
   */
  it.skip("Tier 1g — `lib/utils.js` validates (#TBD-3 isBuffer fallthru i32/f64)", () => {
    const r = compileProject(`${AXIOS_ROOT}/lib/utils.js`, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  /**
   * Tier 1h — `lib/core/AxiosError.js` validates. Currently fails
   * inside `AxiosHeaders_set` with the same extern-boxing error as
   * Tier 1d. Confirms #TBD-2 is structural (different struct type
   * index, same shape).
   *
   * BLOCKED on #TBD-2.
   */
  it.skip("Tier 1h — `lib/core/AxiosError.js` validates (#TBD-2 AxiosHeaders_set extern boxing)", () => {
    const r = compileProject(`${AXIOS_ROOT}/lib/core/AxiosError.js`, { allowJs: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
