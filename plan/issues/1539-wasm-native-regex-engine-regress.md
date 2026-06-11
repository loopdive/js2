---
id: 1539
title: "Standalone Wasm RegExp engine via regress (Phase 2 of #1474)"
status: done
created: 2026-05-20
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: regular expressions
goal: standalone-wasm
sprint: 61
depends_on: [1474]
related: [1474, 682, 1535]
claimed_by: codex-developer
claimed_at: 2026-06-06T09:31:52.475Z
pr: 1252
completed: 2026-06-06
---
# #1539 — Standalone Wasm RegExp engine via regress (Phase 2 of #1474)

## Decision

**Use `regress` (Rust crate) as the standalone regex engine. Close out #682 (libregexp).**

Rationale for rejecting QuickJS libregexp:
- `LRE_FLAG_INDICES` is explicitly marked `"Unused by libregexp, just recorded"` in `libregexp.h` — the `d` flag is silently accepted but `match.indices` is never populated. Silent wrong behavior, not a compile error.
- The "ES2023 compliant" claim in #682 is self-asserted; `regress` is tested against the test262 RegExp suite.
- `regress` is actively maintained (ridiculousfish), used in Boa and Hermes, with verified spec coverage.

**Scope**: `regress` is used **only in standalone mode** (`ctx.standalone === true`). JS-host mode continues using the existing `RegExp_new` host import — no change there.

## Problem

`#1474` Phase 1 landed refuse-and-document: standalone builds with regex fail at compile time. Phase 2 (this issue) replaces those refusals with real regex execution via `regress`.

In standalone mode today:
- `/\d+/.test(s)` → compile error (Phase 1 gate in `typeof-delete.ts`)
- `new RegExp(p, f)` → compile error (Phase 1 gate in `new-super.ts`)
- `s.match(re)`, `s.replace(re, f)`, `s.split(re)` → compile error (Phase 1 gate in `string-ops.ts`)

After this issue: all of the above work by routing through the regress side module.

## Library

- Crate: [`regress`](https://github.com/ridiculousfish/regress) (Apache-2.0 / MIT)
- Build: `cargo build --release --target wasm32-unknown-unknown --no-default-features --features utf16` + `wasm-opt -Os`
- Expected binary: ~250 KB (no Unicode property tables), ~400 KB (with full `\p{}` support). Pre-build and commit to `vendor/regress.wasm`; rebuild only when `vendor/regress-version.txt` changes.
- UTF-16 feature flag matches `--nativeStrings` representation — no re-encoding needed for that path.

## Design

No new CLI flag. Routing is purely on `ctx.standalone`:

```
ctx.standalone = false  →  existing JS host import (RegExp_new) — unchanged
ctx.standalone = true   →  regress side module
```

The Phase 1 `reportError` guards in `typeof-delete.ts`, `new-super.ts`, `string-ops.ts` are **replaced** by the regress codegen path.

## Implementation Plan

### Entry points

| File | Change |
|------|--------|
| `src/codegen/typeof-delete.ts` | Remove Phase 1 `reportError` in `compileRegExpLiteral`; when `ctx.standalone`, emit `regress_compile(pattern, flags)` instead of `RegExp_new` |
| `src/codegen/expressions/new-super.ts` | Same for `new RegExp(p, f)` |
| `src/codegen/string-ops.ts` | Replace Phase 1 error gates for `match`/`matchAll`/`search`/`replace`/`replaceAll`/`split` with regress-backed calls when `ctx.standalone` |
| `src/codegen/regex-link.ts` (new) | Side-module linker: embed `vendor/regress.wasm`, use Binaryen `wasmMerge` to link it into the output when `ctx.standalone`. Registers the regress import namespace. Only runs once per module (`ctx.regressLinked` guard). |
| `src/codegen/index.ts` | Add `ctx.regressLinked: boolean`; set on first regex site emitted in standalone mode. |
| `vendor/regress.wasm` | Pre-built artifact (committed). |
| `vendor/regress-version.txt` | Pin: crate version + feature flags. |
| `scripts/build-regress-wasm.sh` | Rebuild script (dev only; CI uses committed artifact). |

### ABI

Strings pass as `(ptr, len)` UTF-16 code-unit pairs into a shared linear memory slab:

```wat
(import "regress" "compile"     (func (param i32 i32 i32) (result i32)))
;; pattern_ptr, pattern_len, flags_bitfield -> re_handle (0 = compile error)

(import "regress" "exec"        (func (param i32 i32 i32 i32) (result i32)))
;; re_handle, str_ptr, str_len, start_idx -> match_handle (0 = no match)

(import "regress" "group"       (func (param i32 i32) (result i64)))
;; match_handle, group_idx -> start<<32|end  (-1,-1 = unmatched group)

(import "regress" "group_count" (func (param i32) (result i32)))
;; match_handle -> capture group count

(import "regress" "free"        (func (param i32)))
;; free re_handle

(import "regress" "free_match"  (func (param i32)))
;; free match_handle
```

### WasmGC types

```wat
(type $RegExp (sub (struct
  (field $tag        i32)                   ;; REGEXP_TAG
  (field $handle     (mut i32))             ;; regress re_handle
  (field $source     (ref $StringArr))      ;; pattern string
  (field $flags      i32)                   ;; bitfield: g=1 i=2 m=4 s=8 u=16 y=32 d=64 v=128
  (field $lastIndex  (mut f64))
)))

(type $MatchArray (struct
  (field $matched    (ref $StringArr))      ;; full match string
  (field $groups     (ref $vec_StringArr))  ;; capture groups (null = unmatched)
  (field $index      i32)                   ;; match start in input
  (field $input      (ref $StringArr))      ;; original input
  (field $indices    (ref extern))          ;; start/end pairs; populated only when d flag set
)))
```

### Edge cases

- **`d` flag (`match.indices`)** — regress returns group start/end positions via `group()`; populate `$indices` when `flags & 64`. This is the disqualifying gap for libregexp.
- **Empty match + `g` flag** — advance `lastIndex` by 1 after empty match; follow spec §22.2.7.2 step 8.c.
- **`y` sticky + non-zero `lastIndex`** — pass `lastIndex` as `start_idx`; discard match if `match.start !== lastIndex`.
- **`RegExp.prototype[Symbol.match/replace/split/search]`** — follow spec branching on `g`/`y` flags. Replace the `__extern_method_call` dispatch in `src/runtime.ts:4678-4744` with regress exec when `ctx.standalone`.
- **`RegExp.prototype.flags`** getter — recompute string from `$flags` bitfield.
- **`lastIndex` mutation** — `g` and `y` flags mutate `lastIndex` after each exec; write back via `struct.set $RegExp $lastIndex`.
- **GC / resource cleanup** — no WasmGC finalizers; call `regress.free(handle)` eagerly using the existing dispose-pattern in the runtime.
- **String encoding** — For `--nativeStrings` (`array i16`, already UTF-16): `array.copy` to slab. For externref strings: use `__extern_string_to_utf16` (already exists) then copy.
- **Named capture groups** — parse `(?<name>...)` at compile time, store name→index table in `$RegExp`; expose via `match.groups` object.

### Build script (`scripts/build-regress-wasm.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
VERSION=$(cat vendor/regress-version.txt)
cargo build --release --target wasm32-unknown-unknown \
  --no-default-features --features utf16 \
  --manifest-path scripts/regress-build/Cargo.toml
wasm-opt -Os \
  scripts/regress-build/target/wasm32-unknown-unknown/release/regress_shim.wasm \
  -o vendor/regress.wasm
```

Rust toolchain only needed to rebuild the artifact. CI uses the committed `vendor/regress.wasm`.

### Test262 paths

- `test/built-ins/RegExp/*` (~1,400 tests, run under `--target standalone`)
- `test/built-ins/String/prototype/{match,replace,replaceAll,search,split}/*`
- `test/language/literals/regexp/*` (~50 tests)

Acceptance: ≥80% pass when compiled with `--target standalone`.
`match.indices` (`d` flag) tests must pass — this was libregexp's disqualifying gap.

### Dependencies

- **#1474** Phase 1 must be merged (already landed); this issue replaces its `reportError` gates.
- #682 closed out — no further work on libregexp.

### Risks

- **Rust toolchain** — mitigated by committing prebuilt artifact; CI never runs `cargo`.
- **Binary size** — ~250–400 KB added to every standalone module. Acceptable for `--target standalone`; irrelevant for JS-host builds.
- **regress ABI stability** — pin version in `vendor/regress-version.txt`; review on upgrade.

---

## Architecture Plan (authoritative — 2026-05-24, supersedes the regress-first plan above)

Author: architect. Written after reading the **current** standalone
pipeline and the existing native-string helper layer end-to-end (HEAD
`92c7483a4`). **The "Implementation Plan" above (regress side-module via
`wasmMerge`) has a load-bearing flaw that blocks Phase 2a as written.** This
section re-sequences the work so a dev can build the smallest slice today
with **zero new toolchain**, and demotes the Rust `regress` side-module to a
*later, optional* phase whose entry condition is explicit.

### The flaw in the regress-first plan

The standalone target is **pure WasmGC** (`src/cli.ts:35`:
"`--standalone — pure WasmGC, no JS host`") and forces `nativeStrings`
(`index.ts:4829-4830`). Standalone strings are therefore **WasmGC `i16`
arrays** (`__str_data`), reachable directly by WasmGC code.

A Rust `regress` build is `wasm32-unknown-unknown` — a **linear-memory**
module. The plan proposes linking it with Binaryen `wasm-merge`. But:
- **`wasm-merge` cannot coherently fuse a linear-memory module and a WasmGC
  module into one instance.** They have separate memory models; there is no
  shared address space. The strings the matcher must read live in WasmGC
  `i16` arrays, which a linear-memory `regress` cannot address without an
  explicit copy across a boundary that does not exist in a single merged
  instance.
- The plan's ABI ("strings pass as `(ptr, len)` into a shared linear memory
  slab") presupposes that boundary and a marshalling layer (WasmGC `i16`
  array → linear slab → back) that is itself a substantial, unspecified
  piece of work — and it is pure overhead the standalone target should not
  pay when the data is already WasmGC.
- It also imports a Rust toolchain + a committed ~250-400 KB artifact + a
  version-pin/rebuild story **before any regex byte has matched**. That is a
  large irreversible commitment made on an unproven integration.

**Conclusion**: side-module linking is the wrong *first* move. It may be a
viable *later* move for full ES2023 coverage (`\p{}`, lookbehind,
backreferences) **iff** we adopt a second-instance model (two `WebAssembly.
Instance`s sharing an `externref`/copy ABI) rather than `wasm-merge` — that
is a separate design (see Phase 2d entry condition). It is not Phase 2a.

### The right Phase 2a: a pure-WasmGC matcher, self-hosted like the string layer

`src/codegen/native-strings.ts` (4,211 lines) already contains **hand-
authored WasmGC helper functions** that operate directly on `i16` string
arrays — `__str_indexOf`, `__str_substring`, `__str_compare`,
`__str_charAt`, `__str_slice`, `__str_includes`, … — each built as an
explicit `WasmFunction` body and registered in `ctx.nativeStrHelpers`
(emission sites listed at `native-strings.ts:285…2355+`). **This is the
exact pattern a standalone regex matcher should follow**: emit a family of
WasmGC helper functions that walk the `i16` array. No Rust, no
`wasm-merge`, no linear memory, no marshalling — the matcher reads the same
`i16` arrays everything else already uses.

Regex compilation is split cleanly:
- **Compile time (TS, in the compiler)**: parse the pattern string and flags
  into a small bytecode/NFA program. The pattern is *always a literal or a
  compile-time-known string* in the overwhelming majority of cases
  (`/\d+/`, `new RegExp("ab+c")`); only `new RegExp(dynamicStr)` is runtime.
  Phase 2a handles **literal/static patterns only** and refuses dynamic
  patterns in standalone (keep the Phase-1 `reportError` for the dynamic
  case, narrowed). The parser already exists in part: `parseRegExpLiteral`
  (imported in `typeof-delete.ts:14`) extracts `{pattern, flags}`.
- **Run time (emitted WasmGC)**: a generic `__regex_match` helper that
  interprets the compiled program against an `i16` array + start index,
  returning a match struct — OR, for the smallest slice, **specialised
  per-pattern matcher functions** emitted directly from the parsed AST (no
  interpreter), the way `native-strings.ts` emits one function per method.
  Specialised emission is simpler to land first (no bytecode format to
  design) and is the recommended Phase-2a form.

### Data structures (WasmGC, no linear memory)

Reuse the issue's `$RegExp` / `$MatchArray` struct shapes above **but drop
`$handle` (no foreign engine) and `$indices` externref** (use a WasmGC
`i32` pairs array instead). Concretely:

```wat
(type $RegExp (sub (struct
  (field $tag        i32)                ;; REGEXP_TAG
  (field $source     (ref $NativeString));; pattern (i16 array wrapper)
  (field $flags      i32)                ;; g=1 i=2 m=4 s=8 u=16 y=32 d=64
  (field $lastIndex  (mut f64))
  (field $progIdx    i32)                ;; index of the emitted matcher fn (funcref table) — Phase 2b+
)))

(type $MatchResult (struct
  (field $matched   i32)                 ;; 1 = matched, 0 = no match
  (field $start     i32)                 ;; match start (i16 index)
  (field $end       i32)                 ;; match end (exclusive)
  (field $groups    (ref $arr_i32))      ;; flat [g0s,g0e,g1s,g1e,…]; -1 = unmatched
)))
```

For Phase 2a (specialised per-pattern functions) the `$progIdx`/funcref
table is unnecessary — the call site calls the specialised function
directly, exactly as string methods do via `ctx.nativeStrHelpers`. Promote
to a funcref/bytecode model only when the number of distinct patterns or
the dynamic-pattern requirement forces it (Phase 2c).

### Codegen routing (replaces the Phase-1 gates — same entry points as the regress plan)

The entry points the regress plan lists are correct; only the target
changes (emit WasmGC matcher calls, not regress imports):

| File | Phase-1 gate (verified present) | Phase 2a change |
|------|----------------------------------|-----------------|
| `src/codegen/typeof-delete.ts` | `compileRegExpLiteral` @287, refuse @289-295 | when `ctx.standalone` and pattern is static-parseable: parse via `parseRegExpLiteral`, emit/return a `$RegExp` built by the WasmGC path; keep refuse only for unparseable/dynamic |
| `src/codegen/expressions/new-super.ts` | refuse @1998-2008 | same for `new RegExp(p,f)` when `p` is a compile-time string |
| `src/codegen/expressions/calls.ts` | refuse @1374 | same for `RegExp(p,f)` call form |
| `src/codegen/string-ops.ts` | refuse @1956-1970 (match/matchAll/search; replace/replaceAll/split w/ RegExp arg) | route to the WasmGC matcher helpers when `ctx.standalone` |
| `src/codegen/native-strings.ts` (or a new `src/codegen/native-regex.ts` sibling) | — | **new**: emit the matcher helper functions, registered in a `ctx.nativeRegexHelpers` map mirroring `ctx.nativeStrHelpers` |

Put the matcher emission in a **new `src/codegen/native-regex.ts`** that
mirrors `native-strings.ts`'s structure (one `WasmFunction` per primitive,
shift-maintained funcMap registration). Do **not** bloat `native-strings.ts`.

### Phased breakdown (smallest buildable slice first)

- **Phase 2a — literal & character-class matching, no JS, no Rust.**
  - Patterns: literal chars, `.`, char classes `[...]`/`[^...]`, anchors
    `^`/`$`, quantifiers `*`/`+`/`?`/`{n,m}` (greedy), alternation `|`,
    non-capturing groups `(?:…)`, the `i` and `g` flags.
  - Methods: `RegExp.prototype.test`, `RegExp.prototype.exec`,
    `String.prototype.match` (non-`g` returns first match struct; `g`
    returns all-matches array), `String.prototype.search`,
    `String.prototype.replace(re, string)` (no `$n` / function replacer
    yet — refuse those in standalone), `String.prototype.split(re)`.
  - Implementation: a backtracking matcher emitted as WasmGC helpers over
    `i16` arrays. Capturing groups `( … )` recorded into `$groups`.
  - **Refuse (keep Phase-1 error, narrowed)**: dynamic `new RegExp(var)`,
    backreferences `\1`, lookahead/lookbehind, `\p{}`, the `u`/`v`/`y`/`s`
    flags, and `replace` with a function/`$n` replacer. Each refusal cites
    "#1539 Phase 2b/2c/2d".
  - Smallest first PR within 2a: **`test` + literal/`.`/char-class/anchors
    only**, proving the parse→emit→match pipeline + the string-ops routing,
    with `tests/issue-1539-standalone-regex.test.ts` running under
    `--target standalone` (compile + run via the existing standalone test
    harness; see `tests/issue-1474-standalone-regex-refuse.test.ts` for the
    inverse-direction harness to adapt).
- **Phase 2b — capturing groups, `exec`/`match` group arrays, named groups
  `(?<name>…)`, `lastIndex`/sticky `y`, empty-match advance.** Add the
  funcref/bytecode model here if specialised emission becomes unwieldy.
- **Phase 2c — `replace` with `$1`/`$<name>`/function replacer,
  `matchAll`, `replaceAll`, multiline `m`, dotAll `s`, the `d`
  indices flag.**
- **Phase 2d (optional, entry-condition gated) — full ES2023 fancy
  features** (`\p{}` Unicode property escapes, lookbehind, backreferences).
  **Entry condition**: only if test262 RegExp pass-rate plateaus below
  target on these specific features AND a **two-instance** linking design
  (not `wasm-merge`) is specced and approved. This is where Rust `regress`
  *could* return — as a separate WasmGC↔linear instance pair with a defined
  copy ABI — but it is explicitly out of scope until 2a-2c land and the
  data justifies the toolchain cost.

### Test strategy

- **Equivalence tests** (`tests/issue-1539-standalone-regex.test.ts`):
  compile each pattern twice — once default (JS-host, `RegExp_new`) and once
  `--target standalone` — assert identical results on a fixed input corpus.
  This reuses the dual-run pattern already used for native strings
  (`ctx.testRuntime && ctx.nativeStrings`, index.ts:774). Per Phase 2a
  scope: literal, `.`, classes, anchors, quantifiers, alternation, `i`/`g`.
- **test262 under standalone**: run `test/built-ins/RegExp/*`,
  `test/built-ins/String/prototype/{match,replace,replaceAll,search,split}/*`,
  `test/language/literals/regexp/*` with `--target standalone`. **Do not
  promise ≥80% in 2a** — Phase 2a deliberately refuses fancy features;
  expect the *feature-subset* pass rate to climb in 2b/2c. Track the
  standalone-RegExp pass count as the metric, not a single threshold.
- **Refusal tests**: extend `tests/issue-1474-standalone-regex-refuse.test.ts`
  so the *narrowed* refusals (dynamic pattern, backrefs, lookaround, fancy
  flags) still produce clean compile errors citing the right phase.

### Edge cases (Phase 2a)

- **Empty match + `g`** (`/x*/g` on `"abc"`): advance position by 1 after a
  zero-width match (spec §22.2.7.2) to avoid an infinite loop.
- **Anchored `^`/`$` with/without `m`**: in 2a, `^`/`$` match only
  string start/end (multiline `m` is Phase 2c).
- **Case-insensitive `i`**: simple ASCII case-fold in 2a; full Unicode
  case-folding deferred (note in test file). Most test262 `i` tests are
  ASCII.
- **Greedy backtracking termination**: cap backtracking steps or use an
  explicit stack to guarantee termination (no JS stack to rely on in
  standalone). Document the cap.
- **`split(re)` with capturing groups**: spec interleaves captured groups
  into the result array — defer the capture-interleave to 2b; 2a `split`
  handles non-capturing separators only (refuse capturing-group split with
  a 2b citation).
- **Surrogate pairs / `u` flag**: 2a operates on UTF-16 code units (the
  `i16` array). The `u` flag (code-point semantics) is refused until 2c/2d.

### Why this de-risks the issue

- **Phase 2a ships with zero new toolchain or CI changes** — it is the same
  hand-authored-WasmGC-helper pattern already proven by `native-strings.ts`,
  reading the same `i16` arrays. No Rust, no `vendor/*.wasm`, no
  `wasm-merge`, no `build-regress-wasm.sh`.
- **The hard, irreversible bets** (Rust toolchain, prebuilt artifact, the
  unsolved WasmGC↔linear linking) are deferred to Phase 2d behind an
  explicit entry condition, instead of being prerequisites for the first
  matched byte.
- **Routing is proven first**: 2a's first PR validates the parse→emit→match
  pipeline + string-ops/literal routing on the simplest patterns, so 2b/2c
  are pure feature-addition on a known-good spine.

### Recommendation

Keep `status: ready`. Dispatch **Phase 2a, first PR** (test + literal/
class/anchor matcher in a new `src/codegen/native-regex.ts`, with the
narrowed refusals and a dual-run equivalence test) as the buildable slice.
The `regress` side-module sections above are retained as **possible Phase 2d
material only**, gated on the two-instance design + test262 data; they are
**not** the Phase 2a plan.

---

## Implementation Notes (sd-1539, 2026-06-03) — bytecode VM, not specialised emission

Author: senior-dev (sd-1539), built on the architect's pure-WasmGC plan.
**Mechanism decision recorded before writing code (feasibility:hard gate).**

### Why a compiled-bytecode + single generic interpreter, not per-pattern raw Wasm

The architect offered two run-time forms for Phase 2a: (a) "specialised
per-pattern matcher functions emitted directly from the parsed AST (no
interpreter)" — floated as "simpler to land first" — or (b) a generic
interpreter over a compiled program. I chose **(b)** after weighing the
control-flow cost:

- A backtracking matcher fundamentally needs an **explicit backtrack stack**
  in standalone (no JS call stack to recurse on — the architect flags this in
  the edge-cases section). Form (a) would therefore have to *generate*
  backtracking control flow — nested `block`/`loop`/`br` with a save/restore
  stack — **as raw `Instr[]`, recursively, per pattern**. That is the single
  hardest-to-verify thing to emit in raw Wasm, re-derived for every distinct
  regex AST shape; stack-balance / branch-depth bugs there are exactly the
  regression class this role exists to prevent.
- Form (b) writes that backtracking VM **once**, as one hand-authored Wasm
  function (`__regex_run`), debugged once. The per-pattern work becomes pure
  TypeScript: parse the pattern → emit an `i32[]` bytecode program — trivially
  unit-testable without Wasm. A bytecode bug is a data bug, not a
  codegen-control-flow bug.
- It is also exactly the `$progIdx`/bytecode model the architect names as the
  Phase-2b+ promotion target, so (b) builds 2a on the spine 2b/2c already
  need, avoiding a throwaway specialised emitter. (Mirrors #1584's own
  bytecode-VM conclusion.)

### Shapes

- Compile time: `src/codegen/regex/parse.ts` (pattern → AST) + `compile.ts`
  (AST → `number[]` program; backtracking VM opcodes `CHAR`, `ANY`, `CLASS`,
  `SPLIT`, `JMP`, `SAVE`, `BOL`, `EOL`, `MATCH`). Capture count at compile
  time. Pure TS, fully unit-tested.
- `$NativeRegExp` struct supersedes #682's `__StandaloneRegExp {pattern,
  flags}` — fields `{ prog: ref array<i32>, nGroups: i32, flags: i32,
  source: ref $NativeString, lastIndex: mut f64 }`. #682's literal-substring
  `.test` (`indexOf>=0`) becomes the `CHAR`-only degenerate path of the VM —
  subsumed, not deleted.
- Run time: one `__regex_run(prog, str, startIdx, caps) -> i32` Wasm helper
  in `src/codegen/native-regex.ts`, registered in `ctx.nativeRegexHelpers`
  (mirrors `ctx.nativeStrHelpers`). Backtrack stack = a WasmGC `i32` array;
  a bounded step counter guards catastrophic backtracking (documented cap).

### First-PR slice (within 2a)

`RegExp.prototype.test`/`.exec`, `String.prototype.search`/`match`; pattern
forms literal / `.` / `[...]` / `[^...]` / `^` / `$` / `* + ? {n,m}` greedy /
`|` / `(?:…)` / capturing `(…)`; flags `i` (ASCII fold) and `g`. Everything
the architect lists under "Refuse (narrowed)" stays a clean compile error
citing the right later phase. Dual-run equivalence test compiles each pattern
both JS-host and `--target standalone` and asserts identical results.

### LANDED — first PR (sd-1539, 2026-06-03)

Shipped the `RegExp.prototype.test` slice end-to-end:
- `regex/{bytecode,parse,compile,vm}.ts` + `native-regex.ts` (the Wasm VM)
  + `regexp-standalone.ts` rewired off the #682 `{pattern,flags}`/indexOf
  struct onto the new `$NativeRegExp {flags,nGroups,prog,classTable,source}`
  struct + `__regex_search`.
- Pattern forms: literal / `.` / `[...]`/`[^...]` / `^`/`$` / `*+?{n,m}`
  greedy & lazy / `|` / `(?:…)` / capturing `(…)`; flags `i` (ASCII fold),
  `g`, `y` (sticky-at-0). `.exec`/`.match`/`.search`/`.replace`/`.split` and
  fancy features (backrefs, lookaround, `\p{}`, `m`/`s`/`u`/`v`/`d`) stay
  narrowed refusals citing #1539 Phase 2b/2c/2d (or #1474 for the
  String-method gate).
- Tests: `tests/regex-bytecode.test.ts` (105 pure-TS vs native RegExp),
  `tests/issue-1539-standalone-regex.test.ts` (dual-run, real Wasm, empty
  import object), `#682`/`#1474` refusal tests narrowed.

**Field-ordering finding (load-bearing, documented in `regexp-standalone.ts`):**
`getArrTypeIdxFromVec` (registry/types.ts) is a *structural* heuristic that
classifies ANY struct whose **field[1] is a ref-to-array** as a "vec struct",
which makes `coerceType` ref→externref attach `__make_iterable` (a JS host
import) — breaking standalone purity for a `const re = /…/;` binding. The
`$NativeRegExp` field order therefore puts the i32 scalars (`flags`,
`nGroups`) at slots 0/1 and the array fields (`prog`, `classTable`) at 2/3, so
field[1] is `i32` and the struct stays off that heuristic. #682's struct
dodged this only incidentally (its field[1] was `flags:i32`).

Remaining (later slices): `.exec`/`.match` capture arrays + named groups
(2b); `.replace`/`.split`/`matchAll` + `m`/`s`/`d` (2c); `\p{}`/lookaround/
backrefs (2d).

## Implementation Notes (dev-1539-flags, 2026-06-04) — Phase 2c flags `m` + `s`

Landed the `m` (multiline) and `s` (dotAll) flags on the existing pure-WasmGC
bytecode VM. No new opcodes, no struct changes, no toolchain — the flags ride
existing instruction operands, so the change is small and self-contained.

- **`s` (dotAll)** — the `ANY` opcode already carries a `dotAll` flag in
  operand `a` (the VM excludes `\n \r U+2028 U+2029` when `a==0`). The compiler
  had hardcoded `0`; it now emits `a = (flags & RE_FLAG_S) ? 1 : 0`. Both the
  reference VM (`regex/vm.ts`) and the Wasm VM (`native-regex.ts` `anyArm`)
  already read operand `a`, so the run-time side needed no change for `s`.
- **`m` (multiline)** — `BOL`/`EOL` previously matched only at string
  start/end. The compiler now stores the multiline bit in their operand `a`.
  Both VMs gained the multiline branch (§22.2.2.6/§22.2.2.7): `^` also matches
  right after a line terminator (unit at `sp-1` is a LT), `$` also matches right
  before one (unit at `sp`). The neighbour read in the Wasm `anchorArm` is
  guarded by an in-bounds check (`sp>0` / `sp<slen`) so it can never trap.
  `\r\n` is two terminators, so an anchor between them still matches (matches
  native `RegExp`).
- **Gate** — `regexp-standalone.ts` flag refusal narrowed from
  `g|i|y` to `g|i|y|m|s`; `u`/`v` (code-point) and `d` (indices) stay refused
  citing #1539 Phase 2d.

Files: `src/codegen/regex/{compile,vm}.ts`, `src/codegen/native-regex.ts`
(`anchorArm` + new `multilineAnchorMatch`), `src/codegen/regexp-standalone.ts`.

Tests: `tests/regex-bytecode.test.ts` (141 pure-TS cases incl. new `m`/`s`/`ms`
rows vs native `RegExp`), `tests/issue-1539-standalone-regex.test.ts` (78
dual-run cases, real Wasm, empty import object — incl. `m`/`s`/`ms`), and the
narrowed-refusal tests flipped from "refuses `m`" to "refuses `u`/`d` (Phase
2d)".

Still open for #1539 (issue stays `in-progress`): Phase 2b capture
arrays/`.exec`/`.match`/named groups; Phase 2c `.replace`/`.split`/`matchAll`
and the `d` indices flag; Phase 2d `u`/`v` code-point semantics + fancy
features.

## Implementation Notes (dev-regex, 2026-06-05) — Phase 2b `String.prototype.search`

Landed `String.prototype.search(/re/)` in standalone mode on the existing
pure-WasmGC VM — the first **String-prototype** RegExp method to leave the
#1474 refusal gate (the prior slices were all `RegExp.prototype.*`). Returns
the match index (f64) or `-1`, matching ECMA-262 §22.1.3.13 + §22.2.6.13
(`RegExp.prototype[@@search]`): search runs from index 0, is unaffected by the
`g` flag, and never advances `lastIndex`. No new opcodes, no struct changes,
no new Wasm helper — it reuses `__regex_search` (which already fills the
capture-slots array) and reads `caps[0]` (whole-match start).

- Refactor: extracted the `.test` body's "load `$NativeRegExp` struct + flatten
  subject + alloc caps + compute sticky + call `__regex_search`" sequence into
  two shared helpers in `regexp-standalone.ts` — `loadStandaloneRegExpStruct`
  (narrows an externref backend-created RegExp back to the struct) and
  `emitRegexSearchCall` (leaves the i32 match flag on the stack, exposes the
  populated caps array). `.test` now returns that flag directly; `.search`
  branches on it: `matched ? f64(caps[0]) : -1`. This shared seam is the
  spine Phase 2b `.exec`/`.match` capture-array reads will build on.
- Routing: `tryCompileStandaloneStringSearch` hooks
  `compileNativeStringMethodCall` (string-ops.ts) *before* the #1474 refusal,
  fired only when the receiver is string-like and the argument is a static /
  backend-created RegExp (`/re/`, `new RegExp("…")`, or a `const re = /…/`
  binding). The string-coercion form (string argument the spec wraps in
  `new RegExp`) and JS-host mode are untouched — both still take the legacy
  host path.
- Flag/pattern subset: identical to the `.test` slice — literal / `.` /
  `[...]` / `^`/`$` / quantifiers / `|` / groups; flags `i`/`g`/`y`/`m`/`s`.
  `u`/`v`/`d` and fancy features stay narrowed refusals.

Files: `src/codegen/regexp-standalone.ts` (shared helpers + search hook),
`src/codegen/string-ops.ts` (route search before refusal).
Tests: `tests/issue-1539-standalone-regex.test.ts` (75 dual-run `.search`
cases vs native + var-bound/`new RegExp` arg forms), narrowed the `s.search`
refusal in `tests/issue-1474-standalone-regex-refuse.test.ts` to a
compiles-OK assertion.

## Implementation Notes (codex-developer, 2026-06-06) — Phase 2c non-capturing `String.prototype.split`

Landed `String.prototype.split(/re/)` in standalone mode for backend-created
static RegExp separators on the existing pure-WasmGC VM. The helper
`__regex_split` mirrors the native string split vec shape (`ref_<AnyString>`)
and uses `__regex_search` to find separator spans, returning a native
`string[]` without `env.RegExp_new`, `env.string_split`, or `env.__make_iterable`
imports.

- Scope: regex literal / trusted var-bound RegExp / `new RegExp("static")`,
  non-capturing separators only, no `limit` argument, and separators that cannot
  match the empty string. This avoids silently mis-modeling capture interleaving
  and zero-width split edge cases until the capture-array follow-up lands.
- Refactor: consolidated standalone regex flag/subset validation so literal
  struct emission and string-method routing share the same `g/i/y/m/s` support
  and `u/v/d` refusal diagnostics.
- Tests: extended `tests/issue-1539-standalone-regex.test.ts` with split
  equivalence cases vs native RegExp plus var-bound / constructor forms and
  narrowed refusals for capture groups, `limit`, and empty-match separators.
  Updated `tests/issue-1474-standalone-regex-refuse.test.ts` so the now-supported
  `split` and literal-replacement `replace` paths compile.

Still open for #1539: capture-array materialization for `.exec`/`.match` and
capture-interleaved `split`, `$`/function replacement semantics, `matchAll`, and
the `d`/`u`/`v` plus lookaround/backreference/property-escape work.

## Implementation Notes (codex-developer, 2026-06-06) — Phase 2b `.exec` + non-global `.match`

Landed standalone capture-array materialization for non-global/non-sticky
`RegExp.prototype.exec(str)` and `String.prototype.match(/re/)` on the existing
pure-WasmGC regex VM. Matches now return a nullable native string vec:
`null` for no match, otherwise `[fullMatch, cap1, cap2, ...]`, with unmatched
captures represented as null native strings so indexed reads observe
`undefined` without any JS host array bridge.

- Added `__regex_capture_array`, which consumes the populated `caps` slot array
  from `__regex_search` and slices the flattened subject via native string
  helpers. This keeps `.exec`/`.match` fully standalone and avoids
  `env.RegExp_new`, `env.string_match`, `env.__make_iterable`, and
  `env.__extern_get`.
- Routed static backend-created regex values through `.exec` and non-global
  `.match`; global/sticky paths remain narrowed refusals because observable
  `lastIndex` and all-match semantics need the next slice.
- Added local/global type inference for variables initialized from static
  `.exec`/non-global `.match` calls, including non-null assertions, so indexed
  result reads stay on the native vec path instead of coercing through
  `externref`.
- Tests: extended `tests/issue-1539-standalone-regex.test.ts` with dual-run
  capture cases for full matches, optional captures, alternation captures,
  `i`/`m` flags, no-match results, var-bound regexes, and `new RegExp(...)`;
  updated `tests/issue-1474-standalone-regex-refuse.test.ts` so non-global
  `.match` compiles while global `.match` remains refused.

Validation: `npm test -- tests/issue-1539-standalone-regex.test.ts
tests/issue-1474-standalone-regex-refuse.test.ts
tests/issue-1539-standalone-regex-replace.test.ts` passed
(3 files, 208 tests).

Still open for #1539: capture-interleaved `split`, `$`/function replacement
semantics, `matchAll`, named groups / `groups`, and the `d`/`u`/`v` plus
lookaround/backreference/property-escape work.
