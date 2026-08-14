// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// TypeScript API shim — single import boundary for the parser/checker frontend.
//
// All `src/**/*.ts` modules import the TypeScript namespace through this file
// (as `import * as ts from "./ts-api.js"`) instead of directly from
// `"typescript"`. This centralizes the dependency and gives us a place to swap
// implementations at module-load time.
//
// Default: `typescript@^5.7` (the canonical Microsoft TypeScript compiler).
//
// `JS2WASM_TS7=1` (set by the `--ts7` CLI flag): opt-in attempt to use
// TypeScript 7 (the Go-port, GA on npm as `typescript@7` since 7.0 — installed
// here under the `typescript7` npm alias so it can coexist with the
// typescript@5 runtime dependency). The shim detects the env var at module
// load time and exposes the active backend via `tsRuntime` and `isTs7`. The
// static re-export below (`export { ts }`) always points at typescript@5 so
// type-level access (`ts.Node`, `ts.SourceFile`, `ts.SyntaxKind`, …) keeps
// working in either mode — typescript@7's root export is a bare version
// string, not a typescript@5-shaped namespace.
//
// NOTE on TS7 compatibility (#1288, #1029 — re-audited against GA 7.0.2,
// 2026-08-13):
//   typescript@7 is NOT a drop-in replacement for typescript@5 at the JS API
//   level. Its public surface is split into `unstable/` subpath exports
//   (`typescript/unstable/sync`, `/async`, `/ast`, `/ast/factory`, `/ast/is`,
//   `/ast/utils`, `/ast/scanner`, `/ast/visitor`, `/ast/clone`) and the
//   parsing/checking work happens in a Go subprocess over IPC. GA news vs the
//   old native-preview audit:
//   - A synchronous Checker API now EXISTS (`typescript/unstable/sync`:
//     API → updateSnapshot({openProjects}) → Project.{program,checker}) with
//     batch overloads; measured ~0.12ms/call warm, ~70ms cold project load.
//   - `SyntaxKind` numeric values DIVERGED from typescript@5 at GA (195/396
//     members renumbered; e.g. `EndOfFileToken` is now `EndOfFile`,
//     `Identifier` 80→79). The preview-era "identical enums" finding no
//     longer holds: NEVER compare a node's `.kind` against the OTHER
//     backend's enum object — always resolve kinds symbolically through the
//     namespace that produced the node.
//
//   Under `JS2WASM_TS7=1` we synthesize a partial typescript@5-shaped object
//   from the TS7 subpaths (SyntaxKind, isXxx predicates, factory helpers)
//   and expose it via the `tsRuntime` named export. Call sites that need a
//   real Program/TypeChecker still go through the static `typescript`
//   namespace re-exported below — i.e. running `--ts7` today exercises the
//   shim plumbing but does not yet replace the parser/checker. Full
//   migration is tracked in #1029; the checker-independence work it needs
//   is #4218.

import { createRequire } from "node:module";

// Re-export the entire typescript@5 module under the named binding `ts` so
// consumers can do `import { ts } from "./ts-api.js"` and use `ts.SyntaxKind`,
// `ts.Node`, … in both value and type positions exactly as they did when
// importing from `"typescript"` directly. This export is static and always
// resolves to typescript@5; runtime swap happens via `tsRuntime` (below).
//
// We can't use `export * as ts from "typescript"` because typescript ships a
// `export = ts` declaration. The pattern below — default-import + named
// re-export — is the documented workaround and preserves both the value and
// the namespace at the type level (TS treats the typescript default import as
// both a value and a namespace via `export as namespace ts`).
import ts from "typescript";
export { ts };

type CjsRequire = (id: string) => unknown;

function isBrowserLikeRuntime(): boolean {
  return (
    typeof window !== "undefined" ||
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined"
  );
}

function getNodeRequire(): CjsRequire | null {
  if (isBrowserLikeRuntime()) return null;
  try {
    return createRequire(import.meta.url) as CjsRequire;
  } catch {
    return null;
  }
}

// ── Lane policy (project decision, 2026-08-14) ───────────────────────
//
// TypeScript 7 may back the parser/checker frontend **only in the Node
// lane**. Two lanes stay pinned to typescript@5 *permanently* — this is a
// settled architectural boundary, not work-in-progress:
//
//   - **browser** — TS7's programmatic API (`typescript7/unstable/sync`) is a
//     Go binary spoken to over IPC. A browser cannot spawn it. Compiling tsgo
//     to Wasm was evaluated and rejected (2026-08-14): the native binary is
//     24 MB (vs typescript@5's 8.7 MB of JS), Go's Wasm targets are
//     single-threaded so the parallelism behind tsgo's speed is lost, and the
//     playground would still bundle TypeScript regardless because Monaco
//     ships its own language service for editor IntelliSense.
//   - **runtime-eval** — `src/runtime-eval.ts` re-enters the pipeline
//     SYNCHRONOUSLY (`compileSourceSync`) when a compiled module calls
//     `__extern_eval` at runtime, and it must work in the browser too. A
//     subprocess round-trip cannot serve a synchronous in-process re-entry.
//
// Consumers must gate on {@link isTs7Active}, NOT on the raw {@link isTs7}
// flag: the runtime-eval carve-out is a *dynamic* scope (the process may be
// mid-eval while the outer compile legitimately used TS7), so it cannot be
// answered at module-load time. See #1029.
export type TsFrontendLane = "node" | "browser" | "runtime-eval";

/** The lane policy itself — pure, so it can be asserted in tests. */
export function ts7EligibleForLane(lane: TsFrontendLane): boolean {
  return lane === "node";
}

// Depth, not a boolean: eval can nest (an eval'd module may itself eval).
let runtimeEvalDepth = 0;

/**
 * Run `fn` with the frontend pinned to typescript@5 for its whole dynamic
 * extent. `src/runtime-eval.ts` wraps every pipeline re-entry in this, so the
 * eval carve-out holds no matter which backend the outer compile chose.
 */
export function runWithTs5Pinned<T>(fn: () => T): T {
  runtimeEvalDepth++;
  try {
    return fn();
  } finally {
    runtimeEvalDepth--;
  }
}

/** The lane this call is executing in, right now. */
export function currentTsFrontendLane(): TsFrontendLane {
  if (runtimeEvalDepth > 0) return "runtime-eval";
  return isBrowserLikeRuntime() ? "browser" : "node";
}

// Resolve which TypeScript implementation to use as the runtime backend. The
// CLI sets `process.env.JS2WASM_TS7` BEFORE this module is first imported (it
// parses argv synchronously and dynamically imports the rest of the compiler),
// so this single decision is stable for the lifetime of the process.
//
// NOTE: this is the *opt-in flag*, resolved once. It already excludes the
// browser (which is decided at load time), but it CANNOT see the
// runtime-eval scope — query `isTs7Active()` at the point of use instead.
export const isTs7: boolean =
  !isBrowserLikeRuntime() && typeof process !== "undefined" && !!process.env && process.env.JS2WASM_TS7 === "1";

/**
 * Is the TS7 frontend active for THIS call? The opt-in flag AND the lane
 * policy. Every site that would route parsing/checking through TS7 must gate
 * on this rather than on `isTs7`.
 */
export function isTs7Active(): boolean {
  return isTs7 && ts7EligibleForLane(currentTsFrontendLane());
}

function loadTs5Module(): typeof import("typescript") {
  // The default backend is already statically imported above. Returning it
  // directly keeps browser bundles away from the Node-only createRequire stub.
  return ts;
}

function loadTs7Module(): typeof import("typescript") {
  // TypeScript 7 GA is a devDependency under the `typescript7` npm alias
  // (`typescript7@npm:typescript@^7`). If the user opted in via --ts7 but the
  // package isn't installed, surface a clear error.
  const require = getNodeRequire();
  if (!require) {
    throw new Error("--ts7: Node.js module loading is not available in this runtime.");
  }
  let astMod: Record<string, unknown>;
  let factoryMod: Record<string, unknown>;
  let isMod: Record<string, unknown>;
  try {
    astMod = require("typescript7/unstable/ast") as Record<string, unknown>;
    factoryMod = require("typescript7/unstable/ast/factory") as Record<string, unknown>;
    isMod = require("typescript7/unstable/ast/is") as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--ts7: failed to load TypeScript 7. Install it as a devDependency under the alias: ` +
        `\`pnpm add -D typescript7@npm:typescript@^7\`. Original error: ${msg}`,
    );
  }

  // Synthesize a typescript@5-shaped object from the TS7 subpaths
  // we can reach synchronously: SyntaxKind/NodeFlags enums, the `is*`
  // predicates, factory helpers. The synthesized object is INTENTIONALLY
  // incomplete — entry points that need a running Go subprocess (createProgram,
  // TypeChecker, …) throw a helpful TS7-divergence error pointing to #1029.
  const synthesized: Record<string, unknown> = {
    ...astMod,
    ...isMod,
    factory: factoryMod,
    __js2wasmTs7: true,
    createProgram() {
      throw new Error(
        "TS7 backend (#1288): ts.createProgram has no in-process TS7 equivalent — " +
          "use the subprocess API (typescript7/unstable/sync). Full migration tracked in #1029.",
      );
    },
    createSourceFile() {
      throw new Error(
        "TS7 backend (#1288): ts.createSourceFile has no in-process TS7 equivalent — " +
          "use the subprocess API (typescript7/unstable/sync). Full migration tracked in #1029.",
      );
    },
    createCompilerHost() {
      throw new Error(
        "TS7 backend (#1288): ts.createCompilerHost has no in-process TS7 equivalent — " +
          "use the subprocess API (typescript7/unstable/sync). Full migration tracked in #1029.",
      );
    },
  };

  return synthesized as unknown as typeof import("typescript");
}

/**
 * Active runtime TypeScript backend. Same shape as `import * as ts from
 * "typescript"` but possibly swapped to TypeScript 7 (`typescript7` alias) under
 * `--ts7`. Use this when you need behaviour that should follow the flag (e.g.
 * `tsRuntime.createProgram(...)` at the compile entry point).
 *
 * Most call sites should keep using the static `import * as ts from
 * "./ts-api.js"` form — that always points at typescript@5 and is safe for
 * type-level access. Only swap to `tsRuntime` for code paths we explicitly
 * want the flag to control.
 */
export const tsRuntime: typeof import("typescript") = isTs7 ? loadTs7Module() : loadTs5Module();

/**
 * Backend-agnostic `forEachChild` helper (#1290).
 *
 * `typescript@5` exposes `forEachChild` as a static function: `ts.forEachChild(node, cb)`.
 * TypeScript 7 exposes it as an instance method on every AST node:
 * `node.forEachChild(cb)`. The two forms accept the same signature.
 *
 * This helper dispatches automatically: if `node` carries an instance method
 * (TS7 native-preview), call it; otherwise fall back to the static TS5 form.
 *
 * All src tree modules should import this helper instead of calling
 * `ts.forEachChild` directly so that codegen can iterate over either backend's
 * AST without per-call-site changes.
 */
// (#3437) Opt-in compile-work meter. The oracle-v8 harness switch tanked CI via
// an O(call-sites × file-size) per-file AST scan (#3433); that scan work flows
// through this shared traversal helper, so counting its invocations is a
// DETERMINISTIC, runner-load-independent proxy for source-scan compile cost.
// Off by default (a single boolean check per call — negligible), enabled only by
// the budget gate (scripts/check-harness-compile-budget.ts). Zero behavioural
// effect. NOTE: ts.forEachChild is a getter-only export (not monkey-patchable),
// and direct `ts.forEachChild` call sites are NOT counted — the meter covers the
// shared-helper traversal class only (see the gate for scope).
let forEachChildMeterOn = false;
let forEachChildCalls = 0;
export function enableForEachChildMeter(): void {
  forEachChildMeterOn = true;
  forEachChildCalls = 0;
}
export function disableForEachChildMeter(): void {
  forEachChildMeterOn = false;
}
export function readForEachChildCalls(): number {
  return forEachChildCalls;
}

export function forEachChild<T>(
  node: ts.Node,
  cbNode: (node: ts.Node) => T | undefined,
  cbNodeArray?: (nodes: ts.NodeArray<ts.Node>) => T | undefined,
): T | undefined {
  if (forEachChildMeterOn) forEachChildCalls++;
  // TS7 native-preview AST nodes carry `forEachChild` as a prototype method.
  // typescript@5 nodes do NOT have this method on the prototype, so this check
  // distinguishes the two without a backend-detection round-trip.
  const inst = (node as unknown as { forEachChild?: (cb: (n: ts.Node) => T | undefined) => T | undefined })
    .forEachChild;
  if (typeof inst === "function") {
    return inst.call(node, cbNode);
  }
  return ts.forEachChild(node, cbNode, cbNodeArray);
}

const BOUNDED_UNKNOWN_TYPE = { flags: ts.TypeFlags.Unknown } as ts.Type;

/** Query a checker type without letting one recursive shape abort a compile. */
export function getTypeAtLocationBounded(checker: ts.TypeChecker, node: ts.Node): ts.Type {
  try {
    return checker.getTypeAtLocation(node);
  } catch (error) {
    if (error instanceof RangeError && /Maximum call stack/i.test(error.message)) return BOUNDED_UNKNOWN_TYPE;
    throw error;
  }
}
