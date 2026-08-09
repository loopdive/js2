---
id: 3716
title: "Add marked as a second pinned-tarball dogfood package (differential HTML-output testing, alongside acorn)"
status: done
sprint: 77
created: 2026-07-27
updated: 2026-07-30
completed: 2026-07-27
priority: medium
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: npm-library-support
related: [3715, 1710]
---

# #3716 — Add marked as a second dogfood package

## Problem

`tests/dogfood/` has exactly one real npm package (acorn, #1710) exercised
by a pinned-tarball, differential-testing harness: compile the actual
package, run it, diff its output against the same package running natively
under Node. That's a different (and complementary) kind of coverage from
the `compileProject`-based multi-file npm-library-support effort (lodash,
axios, react, hono, eslint, prettier, ...) already tracked separately under
the `npm-library-support` goal — the acorn-style harness specifically tests
a **single pre-bundled dist file**, differentially, with zero version skew
(same tarball is both the compiled source and the oracle).

That pattern was never extended to a second package, so the "is this
harness shape acorn-specific or general" question was untested.

## What changed

Added `marked@18.0.2` (a markdown-to-HTML renderer) as a second entry,
following the exact same acquisition/verification discipline as acorn:

- `tests/dogfood/marked-pin.json` — pinned npm-pack tarball metadata
  (canonical sha1/sha512 from `npm view`), mirrors `acorn-pin.json`
- `tests/dogfood/fixtures/marked-18.0.2.tgz` — the committed, integrity-checked tarball
- `tests/dogfood/setup-marked.mjs` — acquisition + sha1 integrity gate + extraction, mirrors `setup-acorn.mjs`
- `tests/dogfood/fixtures/marked-inputs/*.md` — 8 markdown fixtures (headings, emphasis/inline, lists incl. nested/tasks, code blocks indented+fenced, blockquote/hr, table, images/html/reference-links, a realistic README-shaped mixed document)
- `tests/dogfood/marked-harness.mjs` — compile → validate → run+diff loop, mirrors `acorn-harness.mjs` structure/phases exactly
- `pnpm run dogfood:marked` script

**Deliberately scoped down from acorn's full feature set**: no AST diffing
(marked's observable surface is a single HTML string, so plain string
comparison replaces `ast-diff.mjs`'s structural diff — much simpler), no
in-Wasm probe layer, no standalone/WASI variant, no test262 cross-check.
This is the equivalent of acorn's original #1710 slice only — the
differential-corpus + gap-map + probe layers acorn later grew (#1711/#1712)
are not replicated here; a future pass can add them the same way if this
harness earns its keep.

**Why marked specifically**: same "single self-contained pre-bundled dist
file" shape as acorn's `dist/acorn.mjs` (`lib/marked.esm.js`, 42 KB
minified, zero imports) — same reason that shape was chosen for acorn (no
multi-file module resolution needed, so the harness stays about the
compiler, not about `compileProject`'s import graph). Different code
character than acorn (string/regex-heavy tokenizing + template-driven HTML
generation, vs. acorn's AST-object-graph construction) — genuinely
different compiler stress than the existing package, not a duplicate.
Already a project devDependency, so no new dependency was introduced by
choosing it.

## Findings (first run, 2026-07-27)

marked **fails to compile at all**: `compile()` returns `success: false`,
0 binary bytes — the run+diff phase never gets a chance to execute (`8/8`
fixtures recorded as `skipped`, per the harness's "robust to a red
surface" design, matching acorn's own first-run experience).

Root-caused the entire 64-diagnostic surface to ONE recurring pattern —
TypeScript's "evolving array type" inference (an array initialized `[]`
with no annotation, later populated via `.push()`, should have its element
type inferred from what's pushed) is not implemented in js2wasm's checker,
so every array of this shape stays typed `never[]` forever and every
downstream `.push()`/element-property-read hard-fails. Filed as **#3715**
with a minimal, `tsc`-verified repro and a 3-way shape bisection (bare
local / object property / class field — all three fail identically, so
it's a checker-level gap, not narrow to marked's specific code shape).

## Acceptance criteria

- [x] `pnpm run dogfood:marked` acquires the pinned tarball, passes the
      integrity gate, and emits a structured JSON report even though the
      compile surface is currently red (mirrors acorn's #1710 acceptance
      bar exactly).
- [x] Harness is robust to the red surface: run+diff is recorded as
      `skipped` with a reason, not crashed.
- [x] Root cause of the compile failure identified and filed as a separate,
      properly-scoped issue (#3715) rather than guess-patched here.
- [ ] (follow-up, tracked at #3715) Once #3715 lands, re-run
      `pnpm run dogfood:marked` and expect `compile.success: true`; the
      run+diff phase will then produce real per-fixture equal/divergent
      data for the first time — worth a fresh triage pass at that point.
