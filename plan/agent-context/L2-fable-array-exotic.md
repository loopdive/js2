# L2 — array-exotic `[[DefineOwnProperty]]` (#3251 S2-residual + S3) — PR body

**Branch**: `issue-3251-s2-port` (pushed to origin = `loopdive/js2`). Open the
PR against `main` with the body below. Agent: `ttraenkler/L2-fable-array-exotic`
(fable senior-dev lane, 2026-08-06). Claim held on `origin/issue-assignments`.

---

## PR title

feat(#3251): S2-residual + S3 ArraySetLength — array-exotic `length` defines + accessor setter invoke (standalone)

## PR body

Ports the fork-validated #3251 S2/S3 (`issue-3251-s2-write-enforcement`
@`766af9b98`, implemented+validated 2026-07-18 but never merged — no common
ancestry with this repo's history, so this is a re-derivation against current
main, not a patch application).

### What main already had, and what this adds

The handoff's port map was partially stale — main's #4010 vec-bag work already
implements ~80% of the fork's S2 (an `__extern_set` write prologue with
non-writable drop + `__vec_dp_value` routing). Re-deriving found exactly two
real gaps:

1. **S2 residual — accessor setter invoke.** Main's `__extern_set` accessor arm
   silently `return`ed. Now: invoke `e.set` via `__call_accessor_set` with the
   vec receiver as `this`; null setter = sloppy no-op. (This is the
   `verifyWritable`-on-accessor-index cluster.)
2. **S3 — ArraySetLength (§10.4.2.1), previously a lenient no-op.** Implemented
   over the overlay companion at the three `lengthKeyGuard` bail sites
   (`__vec_dp_value` / `__vec_dp_accessor` / `__vec_gopd`):
   - RangeError on ToUint32/ToNumber mismatch (catchable, native ctor + exn tag);
   - §10.1.6.3 transition legality delegated to the $Object define natives
     against a seeded `{value: len, writable: true, e/c: false}` current
     (non-writable length → TypeError on value change; accessor length define →
     TypeError);
   - shrink walks indices down, **stopping at (and throwing TypeError on) a
     non-configurable companion entry** (step 15) with `length = k+1` sync;
   - growth via the per-carrier grow-with-default arms;
   - `gOPD("length")` synthesis — value ALWAYS from the live vec length field,
     only the writable bit from the companion (stale-copy hazard);
   - the `__extern_get` companion consult skips `"length"` (`notLengthWrap`).

### Deliberate divergences from the fork version (both measured)

- **Full ToNumber for the length value** (`__to_primitive` number-hint →
  `__str_to_number` for string primitives, else `__unbox_number`). The fork's
  raw `__unbox_number` spuriously RangeError'd `{value: "2"}` and
  `{value: {toString(){…}}}` — the `15.2.3.6-4-142..151` family (9 tests).
- **`maybeEmitVecLengthDefine` (the #2668 inline static ArraySetLength) is
  standalone-gated OFF** in `compileObjectDefineProperty`. It won for
  statically-typed array receivers with literal descriptors BEFORE the runtime
  native could run, and has no companion knowledge — it silently shrank past
  non-configurable indices (the whole static-lane TypeError cluster). Host mode
  unchanged.
- **Dropped**: the fork's `object-runtime-descriptors.ts` Type(O)-gate hunk
  (superseded by #4047) and its 177-line `__extern_set` prologue (superseded by
  #4010).

### Measured results (CI-aligned shimmed instrument, 162-file L2 lever list —
ES5-label standalone array-exotic `[[DefineOwnProperty]]` failures)

| build | pass | delta |
| --- | ---: | --- |
| main @83e7c4db3 (re-measured baseline) | 1/162 | |
| + setter invoke + S3 port | 20/162 | +19, 0 down |
| + full ToNumber for length values | 30/162 | +10, 0 down |
| + static-lane gate | **42/162** | +12, **0 down** |

Post-merge (origin/main @ffbadec76): 40-file sample re-run matches the full-run
statuses exactly; `tsc` clean; 39/39 issue-3251 suite tests green
(`issue-3251.test.ts` 18, `-s2` 7 — one expectation adapted to main's
strict-throw on non-writable writes — `-s3` 14 incl. the plural-defineProperties
and gOPD-length-liveness groups).

Host lane byte-identical (sha-verified on a defineProperty+length-define
module). LOC/func budget growth granted in the issue frontmatter
(`vec-overlay.ts` +426 / `fillVecOverlayHelpers` +425 — instruction-list
emission inside the existing standalone-gated subsystem module).

Pre-existing failures NOT regressed by this PR (verified identical on
unmodified main): `issue-1130` ×2, `issue-2668` ×2 (host-lane, fail on main).

### Residual failure roots on the lever (measured, out of scope here)

- **Runtime-eval mixed-type-ternary miscompile** (written up in this PR under
  `## RESIDUAL BLOCKER` in `plan/issues/3251-array-descriptor-overlay-substrate.md`; awaiting its own id, see the
  note there): runtime-eval-consumer mode miscompiles
  mixed-type ternaries into an incoherent box (`typeof`="string",
  `Number()`=NaN, concat="[object Object]") — caps EVERY propertyHelper
  `verifyProperty(arr, "length", {writable:…})` because `isWritable` writes
  exactly that box. Lane A (runtime-eval goal).
- **#4159**: typed-lane `array.get` reads bypass the overlay accessor.
- A pre-existing `illegal cast` trap reading `d.value` off a gOPD result in the
  JS static lane (traps identically on main; not yet filed).

Closes nothing (epic #3251 stays open — S4 for-in and the boundaries above
remain); sets the epic's S2/S3 slices done.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01HwZmzQKe9C1m3f2CDwaBKY
