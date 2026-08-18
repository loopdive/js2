---
id: 4034
title: "the native-string runtime sets usesVecValue, cascading into 21 kB of unstrippable exports for standalone modules with no arrays"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [2083, 2962, 3469, 1950, 4035]
origin: "2026-08-01 investigation of the landing-page Module-size chart (21.8 kB for a 10-line fib)"
loc-budget-allow:
  # +10 lines in the god-file: the fix must wrap the prelude emission where the
  # emission order is defined (that order is load-bearing — each builder bakes in
  # sibling funcIdx values), so it cannot move to a subsystem module. 8 of the 10
  # lines are the rationale comment; the shared helper itself went into
  # src/codegen/registry/types.ts next to the flag it pins.
  - src/codegen/native-strings.ts
---

# #4034 — one unused `String.prototype.split` costs 21 kB

## Problem

The landing page's **Module size** chart reports **21.8 kB** for the fib
benchmark (`wasm-host-wasmtime-module-size-per-test.json`, rendered at
`website/index.html:3840`). The user program is a 10-line integer loop. The
same source in js-host mode compiles to **76 bytes**.

The floor is not fib-specific. In standalone/WASI mode with `-O3`:

| program | bytes |
| --- | --- |
| `export function run(n){return n;}` | 21,043 |
| `run` with a loop | 21,079 |
| fib (landing benchmark, incl. its `benchmark` metadata object) | 21,774 |

A program with no strings, no arrays and no `throw` pays ~21 kB.

### Where the bytes are (fib, -O3)

| section | bytes | % | contents |
| --- | --- | --- | --- |
| global | 12,833 | 59% | two Ryu tables — `array.new_fixed` of 582 and 652 `i64.const`s = `DOUBLE_POW5_INV_SPLIT` (291×2) + `DOUBLE_POW5_SPLIT` (326×2), `src/codegen/number-ryu.ts` |
| code | 7,944 | 36% | 34 funcs; the f64→string Ryu formatter and `__vec_push` dominate |
| export | 592 | 3% | ~35 host-bridge symbols |
| rest | ~400 | 2% | type/function/table/elem/memory/tag |

None of it is reachable from `run`. It is reachable from **exports**, which are
GC roots wasm-opt cannot strip. Measured by deleting export entries from the
disassembly and re-running `-O3`:

| exports kept | size after -O3 |
| --- | --- |
| as shipped | 21,774 |
| minus `__exn_render_*` | 4,758 (**−17.0 kB**) |
| minus `__vec_*` | 19,118 (−2.7 kB) |
| minus whole bridge (`__exn_render_*`, `__vec_*`, `__sget_*`/`__sset_*`, `_start`) | 462 |
| only `run` + `memory` | **90** |

## Root cause

A chain of individually-reasonable gates. Each link is sound; composed, they
emit a float formatter into a program that has no strings.

1. Standalone/WASI forces `nativeStrings`.
2. Any string literal at all makes `finalizeUnifiedCollector` call
   `ensureNativeStringHelpers` (`src/codegen/declarations/import-collector.ts:1479`).
   The trivial identity function qualifies — the compiler interns `"undefined"`
   for its own use, so `state.stringLiterals.size > 0` is true for essentially
   every module.
3. `ensureNativeStringHelpers` (`src/codegen/native-strings.ts:261`) emits the
   **entire** String runtime as one all-or-nothing block — flatten, utf8,
   concat, compare, slice/char, search, trim/pad/repeat, case, replace,
   **split**, construct, regex-escape, HTML wrappers. There is no per-method
   reachability gate.
4. `emitStrSplitHelper` calls `getOrRegisterVecType` (split returns an array),
   which sets **`ctx.usesVecValue = true`** (`src/codegen/registry/types.ts:155`).
   The program uses no arrays; `split` does.
5. `usesVecValue` is the gate for `emitVecAccessExports`
   (`src/codegen/vec-access-exports.ts:319`) → the six `__vec_*` host-bridge
   exports are emitted.
6. That calls `addUnionImports`; in standalone mode host imports become native
   in-module functions, one of which must be able to throw a TypeError →
   `throwNativeError` → `ensureExnTag` registers the `$exc` tag
   (`src/codegen/registry/imports.ts:209`).
7. The exception tag is precisely the gate for `emitExceptionRenderExports`
   (`(standalone || wasi) && nativeStrings && exnTagIdx >= 0`,
   `src/codegen/native-strings.ts:2091`) → `__exn_render_prepare` /
   `__exn_render_char` are exported → they pull `__any_to_string` → which
   force-emits `number_toString` (#2969) → **Ryu + its 12.6 kB of tables**.

Verified by stack trace at each hop, on `export function run(n){return n;}`.

Two aggravating properties:

- **The flag is set at emission time, not from final reachability.** `split`
  itself is removed by `-O3` (99 funcs → 21), but the exports its emission
  caused survive, and they pin everything else.
- **This is #2083 one level down.** #2083 fixed the same leak by replacing a
  `vecTypeMap.size === 0` gate (never true, because two vec types are
  pre-registered) with `usesVecValue`. That flag now has the same defect: it
  means "a vec type was registered", not "the user's program uses arrays".

## Fix direction

`usesVecValue` must track *user* array usage, not compiler-internal
registration. The existing `ctx.suppressVecUsageFlag` mechanism already exists
for exactly this (`src/codegen/array-object-proto.ts:1347` suppresses it around
reflective accessor emission).

Probe — suppressing the flag around `emitStrSplitHelper` only:

| program | before | after |
| --- | --- | --- |
| `export function run(n){return n;}` | 21,043 | **804** |
| fib (landing) | 21,774 | **1,545** |
| `const a=[1,2,3]; return a[n%3]` | 21,266 | 21,266 (unchanged) |
| `'a,b'.split(',').length` | 21,352 | 21,352 (unchanged) |

Programs that genuinely use arrays or `split` set the flag themselves and are
byte-identical. **This probe is unvalidated beyond these four programs** — it
has not been run against the equivalence suite or test262, and the same audit
should cover the other string helpers that register vec types, not just
`split`. Treat the numbers as the size opportunity, not as a finished patch.

Worth considering alongside, as separate follow-ups:

- Per-method reachability gating for the string runtime (step 3) — a module
  that never calls `split` should not emit it at all, independent of the flag.
- Gating `__exn_render_*` on a *user-visible* throw rather than on the tag
  being registered by internal runtime glue (step 6→7). The renderer exists for
  the test262 harness (#2962, #2877); it is not needed by a module whose only
  thrower is host-import replacement glue.

## Acceptance criteria

- A standalone/WASI module with no arrays, no `split`, and no `throw` compiles
  to < 1 kB at `-O3`.
- Modules that genuinely use arrays, `split`, or `throw` are byte-identical to
  today (no lost exports, no lost error rendering).
- Equivalence suite and test262 standalone lane show no regression — in
  particular the test262 harness can still render native exception messages
  (#2962) and read the host-free stdout marker (#3469).
- The landing-page Module-size chart reflects the new figure after the next
  benchmark refresh.

## Resolution (2026-08-01)

Fixed as diagnosed. `withSuppressedVecUsage` (new, `src/codegen/registry/types.ts`)
wraps the String-runtime prelude emission in `ensureNativeStringHelpers`
(`src/codegen/native-strings.ts`), so vec types registered by prelude emission
no longer read as user array usage. Type registration is unchanged — only the
flag is pinned — so no type index moves.

Measured (`-O3`), standalone/WASI:

| program | before | after |
| --- | --- | --- |
| `export function run(n){return n;}` | 21,043 | **804** |
| fib (landing benchmark) | 21,774 | **1,545** |
| `'a'+'b'` | 21,117 | **966** |
| `return {a:1}` | 21,179 | **940** |
| `JSON.stringify({a:1})` | 21,094 | **896** |
| `'a,b'.split(',')[0]` | 21,457 | **1,299** |
| `for (const c of 'abc')` | 21,292 | 18,563 |
| `return [1,2,3]` | 21,082 | 21,082 (unchanged) |
| `return 'a,b'.split(',')` | 21,356 | 21,356 (unchanged) |
| `'a,b'.split(',').length` | 21,351 | 21,351 (unchanged) |
| `const a=[]; a.push(n)` | 21,168 | 21,168 (unchanged) |

Every genuine array user keeps its `__vec_*` bridge. **js-host output is
byte-identical** across all 14 probed shapes (the cascade is standalone-only).

Guarded by `tests/issue-4034-standalone-prelude-size.test.ts`, which asserts
both directions — the no-array case shrinks AND the boundary-crossing cases
keep their exports.

**This is only half the size story.** Programs that genuinely use an array or
throw still pay ~20 kB, because the export suite they legitimately trigger is
still unconditional. That is #4035 (gate the host bridge behind an
inspect/debug option), which is the larger aggregate lever.

## Dupe check

- **#2083** (done) — same class, one level up: fixed the `vecTypeMap.size`
  gate by introducing `usesVecValue`. This issue is its successor; the
  replacement gate has the same false-positive defect. Not a dupe.
- **#2962 / #2877 / #3535** — introduced and hardened `__exn_render_*`. They
  establish *why* the renderer exists; none of them gate its emission on real
  throw-ability. Not a dupe.
- **#3469** — the analogous stdout sink; correctly gated on the sink actually
  being minted, and is not part of this cascade. Not a dupe.
- **#1950** (done) — default-on `-O`. Orthogonal: the optimizer already runs
  here and still cannot strip exports.

## Reproduction

```bash
# 21,043 bytes for a program with no strings, no arrays, no throws
cat > .tmp/size-repro.mts <<'SRC'
import { compile } from "../src/index.ts";
const r = await compile("export function run(n){return n;}", {
  fileName: "x.js", target: "wasi", nativeStrings: true, optimize: 3,
} as any);
console.log(r.binary.length);
SRC
npx tsx .tmp/size-repro.mts
```

Section and export attribution above were produced with
`wasm-dis --all-features --disable-custom-descriptors`, editing the export
list, then re-running `wasm-opt -O3`.
