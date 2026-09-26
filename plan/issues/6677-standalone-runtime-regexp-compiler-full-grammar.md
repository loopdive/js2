---
id: 6677
title: "standalone: the runtime `new RegExp(dynamic)` compiler covers only a literal/alternation subset — marked's `k()` rule builder throws `Unsupported dynamic regular expression pattern`"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-26
completed: 2026-09-26
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
goal: standalone
related: [1539, 2161, 4042, 4065, 4439, 6665, 6672, 6693, 6694]
assignee: ttraenkler/sendev-standalone
loc-budget-allow:
  # 2026-09-26 (#6677): the compiler itself is the NEW directory
  #   src/codegen/regex-runtime/ (seven modules, all under the file cap). What
  #   grows in the god-files is wiring that has to live where it is used:
  #   regexp-standalone.ts +14  the fallback call in the simple compiler's
  #     out-of-subset branch, its scratch local, the i/u flag gate, the import.
  #   index.ts +3  the per-source `\p{` scan next to the array-hole scan (single-
  #     and multi-source paths) that decides whether the category table links.
  - src/codegen/regexp-standalone.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-26 (#6677): the same three edits, inside the functions that own them.
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #6677 — runtime RegExp compilation is a subset; marked needs the full grammar

## Problem

Found by [#6672](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6672-standalone-exec-untyped-property-chain-null),
which moved marked's npm-compat **standalone-dynamic** lane past
`Infinite loop on byte: 35`. The lane now fails at the checksum call with:

```
TypeError: Unsupported dynamic regular expression pattern
```

marked builds ~25 of its rules at module init through a pattern builder:

```js
function k(l, e = "") {
  let t = typeof l == "string" ? l : l.source,
    n = { replace: (s, r) => { let i = typeof r == "string" ? r : r.source;
            return i = i.replace(m.caret, "$1"), t = t.replace(s, i), n; },
          getRegex: () => new RegExp(t, e) };
  return n;
}
// e.g. k(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, Q).getRegex()
```

The patterns reach `new RegExp` as run-time strings, so they go to the Wasm
runtime compiler `__regex_compile_dynamic_simple`
(`ensureDynamicStandaloneRegExpCompiler`, src/codegen/regexp-standalone.ts),
which only accepts literals, groups, alternation and a few escapes. Anything
else makes a poisoned struct that throws the TypeError above on first use.
Minimal repro (untyped `.js`, `target: "standalone"`):

```js
function mk(p) { return new RegExp(p); }
export function test() { return mk("^abc").test("abc") ? 1 : 0; } // standalone: throws; Node: 1
```

`"a+"` and `"[a]"` fail the same way. marked's rules also use lookahead,
`\p{…}` with the `u` flag, lazy quantifiers and character classes.

## Options

1. Extend the Wasm runtime compiler to the grammar the compile-time
   `compilePattern` (src/codegen/regex/compile.ts) already accepts, emitting
   the same bytecode for `__regex_run`. This is the general fix (#4042 tracks
   the test262 side of the same refusal).
2. Compile it away: when every `k()` input is a compile-time constant (true
   for marked: literal regexes and literal/constant `replace` arguments),
   fold the builder chain at compile time and emit a static `$NativeRegExp`.
   Narrower, and needs partial evaluation of a closure-returning builder.

## Acceptance criteria

- The repro answers 1 under `--target standalone`.
- marked's standalone-dynamic lane moves past
  `Unsupported dynamic regular expression pattern`.

## Implementation Plan

Option 1 (general fix), executed. A Wasm port of `regex/parse.ts` +
`regex/compile.ts` that runs at RUN time and emits the same `[op, a, b]`
bytecode `__regex_run` already interprets — no VM change.

1. `src/codegen/regex-runtime/dsl.ts` — a small builder for hand-authored
   `Instr[]`: named `block`/`loop` labels resolved to `br` depths once
   (`resolveLabels`), `whileLoop`/`brk`/`cont`, and a short-circuit `andThen`.
2. `env.ts` — one GC state struct (`$__RxState`, 32 fields) passed as local 0 to
   every helper; flat AST nodes `[kind, a, b, c, child, next]` in a growable
   i32 array; a range pool of `[lo, hi]` pairs; `bail()` throws the module tag
   after recording ERR_UNSUPPORTED / ERR_SYNTAX.
3. `parse.ts` — the grammar (ES2024 §22.2.1 + Annex B.1.2): pre-scan for the
   capture count and group names; alternatives, `* + ? {n,m}` (+ lazy),
   Annex B quantified lookahead, groups (capturing, `(?:`, named, lookahead,
   lookbehind, `(?ims-ims:`), escapes (`\d\w\s`, `\b`, decimal backrefs vs
   legacy octal, `\k<name>`, `\cX`, `\xHH`, `\uHHHH`, `\u{…}`, surrogate-pair
   escapes, u-mode strictness), classes with Annex B `-` rules. Case folding
   happens at parse time (the modifier-scoped `i` is the same there).
4. `core.ts` — growable arrays, node/bytecode/range appends, insertion
   sort + merge, complement over the unit / code-point space, ASCII case
   images (+ U+212A/U+017F under u+i).
5. `emit.ts` — `compileNode` ported: SPLIT/JMP chains, PROGRESS guards for
   nullable loops, CLEAR at iteration heads, `{n,m}` expansion, lookaround
   sub-programs queued after MATCH (lookbehind reversed, SAVE order swapped),
   code-point classes and astral literals, per-node class-table caching.
6. `unicode.ts` — `\p{…}` / `\P{…}` under `u`: the General_Category partition
   (≈4.1k spans, `start << 5 | category`) enumerated once at compile time from
   the host (same oracle and Unicode version as the static path) and linked
   only when a source file spells `\p{`/`\P{`. Any GC value (leaf or group,
   short/long names, `gc=`/`General_Category=`) plus `Any`/`ASCII`/`Assigned`.
7. `compiler.ts` — the driver `__regex_compile_dynamic_full(pattern, flags)`:
   `try_table` / `catch_all` around parse+emit; SyntaxError for definite errors, `null`
   (→ the existing #4439 poison) for what it cannot model; otherwise a normal
   `$NativeRegExp`. Wired into `__regex_compile_dynamic_simple`'s
   out-of-subset branch, standalone only; the simple compiler additionally
   hands every `i`/`u` pattern to the full compiler (its per-unit lowering was
   wrong for both: `/./u` took half a surrogate pair, `/é/i` missed `É`).

## Resolution

- Repro (`mk("^abc").test("abc")`) answers 1. Regression test
  `tests/issue-6677-runtime-regexp-full-grammar.test.ts`: 40 rows + marked's
  `k()` builder, each against Node as oracle — **parent 3/40 rows, builder ✗,
  refusal row ✗ (returned a wrong `null`); fix 40/40, builder ✓, refusal ✓**.
  A 420-row differential over marked's 42 runtime-built patterns × 10 markdown
  subjects matches Node 420/420.
- Scoped standalone test262 (565 rows: every `built-ins/RegExp`,
  `annexB/built-ins/RegExp` and `String.prototype.{match,matchAll,replace,
  replaceAll,search,split}` file calling `RegExp(`, plus all of
  `String.prototype.{match,matchAll,search,split}`) via
  `scripts/run-test262-paths.mts --standalone`: parent **470 pass / 56 fail /
  39 CE** → fix **477 / 49 / 39**; +7 (`unicode_restricted_identity_escape{,_alpha,_c}`,
  `RegExp-invalid-control-escape-character-class`, `compile/pattern-string-u`,
  `match/cstm-matcher-is-null`, `search/cstm-search-is-null`), no row lost.
- JS host: every change is gated on `noJsHost(ctx)` — three probe modules
  compiled `gc` are sha256-identical parent vs fix; marked JS-host dogfood
  suite 16/30 before and after.
- Cost: a standalone module that constructs a runtime RegExp now links the
  compiler helpers — +36 KB unoptimised on a small probe (164,392 → 200,490
  bytes), +58 KB when the source also spells `\p{` (category table). Modules
  without a dynamic RegExp are unchanged.
- Existing pins that asserted the OLD refusals were moved to patterns that are
  still refused (non-ASCII `i` folding): `tests/issue-4065.test.ts` (the eight
  "LOUD refusals" now compile and agree with Node, plus one refusal row),
  `tests/issue-4439.test.ts`, `tests/issue-4516-regexp.test.ts`,
  `tests/issue-4654.test.ts` (construction-time contract kept). Touching
  #4654's file ran its two stale `it.fails` residuals (`.global` / `.exec`
  through a dynamic receiver), which already PASS on main (parent measured the
  same) — flipped to `it`. The failures in issue-1474 / 2161-b1 /
  2161-tostring / 2161-undefined-sentinel / 3791 fail identically on the parent.
- The driver catches its internal bail with a standard `try_table`
  (`catch_all`), not legacy `try`: the rest of the module uses exnref EH, and
  Node 25 (CI) aborts compiling a module that mixes the two
  (`Check failed: !job->compile_imports_.empty()`); Node 22 accepted it.
- marked standalone-dynamic lane: parent
  `TypeError: Unsupported dynamic regular expression pattern` (checksum) → now
  past it; binary 877,563 → 921,521 bytes (compiler helpers + category table).
  Next blocker, verbatim: `TypeError: called value is not a function`
  (checksum phase) — a class method called with fewer arguments than it
  declares through an untyped receiver (marked's `this.parser.parseInline(e)`),
  filed as
  [#6693](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6693-standalone-method-call-fewer-args-untyped-receiver).
- Found on the way: the IR inliner does not re-zero an inlined callee's locals
  (a copy inside a caller loop sees the previous iteration's values); the new
  helpers zero their i32 locals explicitly; filed as
  [#6694](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6694-ir-inline-callee-locals-not-rezeroed).
- Residuals (refuse loudly, catchable TypeError on first use, as before):
  non-ASCII case folding under `i` (U+0080–U+2FFF, U+A640–U+ABFF,
  U+FF00–U+FFEF, astral); `\p{…}` under `i`, Script/Script_Extensions and
  binary properties other than Any/ASCII/Assigned; `v` mode; duplicate group
  names; escaped or non-ASCII group names; `{n,m}` bounds above 1000; `\b`
  and backreferences under u+i. Named groups compile, but `exec().groups`
  stays `undefined` for a runtime-built regexp (the struct carries no name
  table — same as the parent's named-group subset).
