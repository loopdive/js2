---
id: 2752
title: transpiled (type-stripped) nm_node_process.js fails to compile — process.stdin TS prelude parsed under .js grammar
area: codegen
related: [389, 2632, 2748, 2123]
feasibility: hard
status: done
completed: 2026-06-27
assignee: ttraenkler/sdev-2752-prelude-js
sprint: current
---

## Problem

External reporter (loopdive/js2#389): the `process.stdin` async-stream host
`examples/native-messaging/nm_node_process.ts` compiles + runs correctly directly
(`js2wasm nm_node_process.ts --target wasi`), but the reporter's pipeline transpiles
to JS first (`bun build → .js`, strips TS types) before compiling. The transpiled
`.js` FAILS TO COMPILE with **46 TS-grammar errors** (`8017`
signature-declarations-only-in-TS, `8009` `private` modifier, `8010`
type-annotations). This blocks loopdive/js2#389's reporter pipeline and the v0.57.0
publish.

## Root cause

`STDIN_READABLE_PRELUDE` in `src/process-stdin-prelude.ts` is raw TypeScript
(`declare function __wasiStdinReadByte(): number; … private chunk: string;
read(size?): string | null;`). `injectProcessStdinPrelude()` PREPENDS it to the
user source; the combined source is then parsed downstream (`src/compiler.ts`)
under the user file's extension. For a `.js`-named input the loose-JS grammar
checker hard-rejects the prelude's TS syntax → compile fails before codegen. The
DIRECT `.ts` path works because its callbacks are typed; the `.js` path was never
exercised (`nm_deno` injects no prelude, so #2748's `.js` fixes sufficed there).

A SECOND, latent bug surfaced once the `.js` parsed: a type-stripped consumer's
`.on("data", (chunk) => …)` arrow has an UNTYPED param. With the prelude's `on`
callback typed `any`, `chunk` lowered as externref; its closure-struct shape
((externref) => void) then differed from the `((c: string) => void)[]` slot it is
stored in, and the `emitChunk` call site (`ref.cast` to the (string)=>void closure
struct) nulled the mismatched value → `null reference` TRAP at runtime. (This is a
general closure-typing gap, reproducible on plain `.ts`, rooted in the standalone
any-typed native-string substrate — see `project_standalone_any_string_value_read_substrate`.)

## Fix

Two changes, both scoped to the prelude-injection path (byte-neutral elsewhere):

1. **Parse the prelude-injected unit under the TS grammar** even for a `.js` user
   file — `forceTsGrammar` option on `analyzeSource` (`src/checker/index.ts`) and
   the incremental language service (`src/checker/language-service.ts`), threaded
   from `src/compiler.ts` when `stdinResult.injected`. Flips ONLY the `ScriptKind`
   (TS vs JS); the `.js`-derived lenient semantics (`strict: false`,
   `allowJs`/`checkJs`) are left intact, so the user's `.js` code keeps its lenient
   checking while the prelude's TS syntax is accepted (option 1 from the diagnosis;
   validated to not regress loose-`.js` user code).

2. **Type the prelude's `.on()` callback as a UNION** `((c: string) => void) | (()
=> void)` instead of `any` (`src/process-stdin-prelude.ts`). This makes
   TypeScript contextually type the untyped `chunk` as `string`, so the stripped
   arrow lowers as a (string)=>void closure that MATCHES the slot — for both typed
   (.ts) and untyped (.js) callbacks — avoiding the trap WITHOUT weakening the
   load-bearing `.read(size?): string | null` return type (#2748 bug C). The
   contextual typing only takes effect because of fix #1. (`any[]` storage and
   method overloads were both tried and rejected: `any[]` routes through dynamic
   dispatch which corrupts native-string args; overloads regress the working typed
   case.)

## Acceptance — MET

- Type-stripped `nm_node_process.js` (esbuild/bun strip) compiles under `--target
wasi`: imports = `{wasi_snapshot_preview1}` only, no `env::*` leak, valid module.
- Under wasmtime with stdin held OPEN + the in-band zero-length shutdown frame:
  echoes byte-exact AND exits cleanly (exit 0) — at small and multi-KiB payloads.
  EOF-close path also green. The direct `.ts` stays working.
- Byte-neutral for programs that don't reference `process.stdin` (prelude only
  injects then; `forceTsGrammar` only set when injected).
- Regression test: `tests/issue-2752-stdin-prelude-js.test.ts`.

## Implementation notes (why, not just what)

- The TS parser builds type-annotation AST nodes regardless of `ScriptKind`;
  `.js` mode only ADDS the grammar-error diagnostics (8009/8010/8017). So forcing
  `ScriptKind.TS` for the prelude-injected unit is sufficient — no AST shape change,
  just suppression of the JS-only grammar diagnostics. `strictNullChecks` stays
  `true` regardless, so the prelude's `string | null` types are preserved.
- The runtime trap is genuinely a SEPARATE, deeper codegen gap (untyped closure →
  typed closure-array). Fix #2 sidesteps it at the prelude (library) level via
  contextual typing rather than a broad, risky closure-representation overhaul; the
  general gap remains for a future issue.
