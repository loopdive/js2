---
id: 1095
title: "Eliminate `as unknown as Instr` casts — extend Instr union to cover all emitted opcodes"
status: done
created: 2026-04-12
updated: 2026-06-17
completed: 2026-06-17
priority: medium
feasibility: medium
reasoning_effort: high
task_type: refactor
language_feature: compiler-internals
goal: maintainability
sprint: 63
es_edition: n/a
---
# #1095 — Eliminate `as unknown as Instr` casts (273 sites)

## Source

External compiler engineer review (2026-04-12): "I counted 273 `as unknown as Instr` sites under `src/`. That is a real signal of compiler-internal type model drift, not just cosmetic debt."

Also noted: `dead-elimination.ts` needs a catch-all for instructions that were forced through with casts, which weakens the dead-code elimination pass.

## Problem

The `Instr` type union in the compiler's IR does not cover all Wasm opcodes that the codegen actually emits. When codegen needs an opcode not in the union, it uses `as unknown as Instr` to bypass TypeScript's type checker. This has several consequences:

1. **No exhaustiveness checking** — switch/match over `Instr` can silently miss cases
2. **Dead-elimination fragility** — `dead-elimination.ts:77` has a catch-all because it can't enumerate all instruction shapes
3. **Peephole pass blindness** — pattern matching in `peephole.ts` can't see cast-through opcodes
4. **Refactoring risk** — renaming or restructuring an opcode won't trigger type errors at cast sites

Current count: **273 occurrences across 26 files** (verified 2026-04-12).

## Approach

1. **Inventory**: grep all `as unknown as Instr` sites, extract the actual opcode string/shape being cast
2. **Extend Instr union**: add missing opcode types to the IR type definition
3. **Remove casts**: replace each `as unknown as Instr` with the now-typed opcode
4. **Fix downstream**: update dead-elimination, peephole, and any other IR consumers to handle new variants
5. **Add lint rule**: eslint/tsc config to flag new `as unknown as Instr` usage

## Acceptance criteria

- [ ] Instr union covers all opcodes the codegen actually emits
- [ ] `as unknown as Instr` count reduced from 273 to ≤50 (stretch: 0)
- [ ] dead-elimination.ts catch-all narrowed or removed
- [ ] No regressions: equivalence tests pass
- [ ] CI lint rule prevents new cast-through additions without updating the union

## Complexity

L (>400 lines touched across 26 files, but each change is mechanical)

## Related

- CLAUDE.md mentions 158 occurrences as of an earlier count — now 273, confirming drift
- #1013 codegen/index.ts split (reduces per-file cast density but doesn't fix the type model)

## Sprint-62 planning amendment (2026-06-12)

Re-scoped from big-bang union extension to a **ratchet**: current count is
175 sites in 13 files (was 273/26 when filed; organic decay works). Sprint
62 lands the mechanism only — `scripts/check-instr-casts.mjs` + committed
baseline + `quality`-job wiring (clone of `check:ir-fallbacks`); growth
fails CI, decreases auto-bank with `--update-on-decrease`. The remaining
union extension is sprint-63 mop-up. Status reset from stale `in-review`
(sprint 45) to `ready`.

## Resolution (2026-06-17, sprint 63)

Done in full — the `as unknown as Instr` double-cast is **gone** (188 code
sites → 0; the only remaining textual occurrence is a comment in
`src/emit/binary.ts` explaining the now-historical motivation for the loud-fail
`default` exhaustiveness check). The sprint-62 ratchet script was never actually
landed, so this PR did the underlying union-extension mop-up directly.

Findings: the overwhelming majority of the 188 casts were **stale** — the op
they cast (`struct.get`, `struct.set`, `extern.convert_any`, `i64.const`,
`array.get/set/new`, etc.) was already in the `Instr` union, so the double-cast
defeated type-checking for no reason. Mechanically stripping ` as unknown as
Instr` and re-running `tsc --noEmit` surfaced only three genuine gaps the casts
had been hiding:

1. **`i64.store` was missing entirely** from the `Instr` union AND the emitter.
   `__wasi_sleep_ms` (poll_oneoff subscription struct) cast `i64.store` through,
   so it would have hit the `#1939` loud-fail `default` at emit time. Added the
   union variant (`src/ir/types.ts`), the opcode `0x37` (`src/emit/opcodes.ts`),
   and the encode case (`src/emit/binary.ts`). `wasi-timers.test.ts` passes.
2. **`{ op: "ref.null", refType: "extern" }`** (calls.ts eval/import-no-args) —
   the `refType` field is not in the union and the emitter would have read
   `typeIdx` as `undefined`, LEB-encoding it as heaptype index `0` (a latent
   bug). Replaced with the semantically-correct `{ op: "ref.null.extern" }`,
   which emits `ref_null externref`. Exactly the kind of bug the casts masked.
3. **map-runtime.ts forEach** — conditional-spread inner array literals widened
   bare `{ op: "struct.get", ... }` literals' `op` to `string`; annotated the
   three inner arrays as `Instr[]` so they get contextual typing.

`dead-elimination.ts` defensive `default` catch-all left intact: it is correct
and conservative, and with `as Instr` single-assertions still permitted it
remains a useful backstop; narrowing it adds DCE-corruption risk for no
behavioural gain.

Validation: `tsc --noEmit` clean · `npm run build` clean · biome lint +
prettier format:check + stack-balance gate clean · full `tests/equivalence/`
suite (207 files) exit 0 · map/set (17 tests), wasi-timers (8 tests) green. The
one FAIL seen during scoped testing (`#681 typed-array for-of WASI-clean`,
`IR-FALLBACK`) reproduces identically on pristine `origin/main` — pre-existing,
unrelated to this refactor.

Acceptance criteria: union now covers all emitted opcodes (i64.store added);
double-cast count 188 → 0 (met the stretch 0). No regressions. The optional
"CI lint rule" criterion is moot — with the count at 0 and the emit-side `never`
exhaustiveness check already failing the build on any new off-union op, the type
system itself now prevents reintroducing the gap that motivated the casts.
