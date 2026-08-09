# dev-verifyprop — verifyProperty vacuity root cause (2026-07-25)

Senior-dev session context. Successor to `dev-floor-truth.md` (which handed over
the `verifyProperty` question after refuting the arity hypothesis for it).

Everything below is MEASURED on `origin/main` @ `ab69ad9d20ceec`, not inferred.

## Deliverables

| artefact                                  | where                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Root cause + measurement write-up         | `plan/issues/3603-verifyproperty-vacuous-both-lanes.md`                |
| Probe + measurement harness, raw verdicts | `plan/probes/3603/` (+ `results/`), `NOTES.txt` has the run order      |
| PR                                        | **loopdive/js2#3598**, branch `issue-3596-verifyproperty-vacuity`      |

> The branch NAME still says 3596 — the issue is **#3603**. `--allocate`
> reserved 3596, another lane landed `3596-trap-ratchet-per-pr-reclassification-valve.md`
> on main mid-flight, and `check:issue-ids --against-main` rejected the branch.
> Same #2531 race that hit #3592/#3585. Renaming the branch would have meant
> re-opening the PR.

## The answer, in one paragraph

`verifyProperty` is vacuous on **both** lanes, by **two different root causes**.
**Standalone**: a plain object literal lowers to a typed WasmGC struct with no
`$Object` own-property table, so every RUNTIME (untyped-receiver) MOP query
reports zero own properties — `hasOwnProperty`, `getOwnPropertyDescriptor`,
`getOwnPropertyNames`, `Object.keys` and `for-in` all fail *together*. All four
of `verifyProperty`'s checks are guarded by `__hasOwnProperty(desc, <field>)`,
`desc` is an object literal at 6,308 / 6,470 call sites, so none of them runs and
the function returns `true` for any expectation. Site: `emitHasOwn`'s
`ref.test $Object → return 0` arm, `src/codegen/object-runtime.ts:2630-2677`.
**Host**: the checks DO run, but the uncurried `__push` silently fails to append,
so `failures.length === 0` and the terminal `assert(false, __join(failures))`
never fires. The handed-down `__push`/`__join` lead is therefore **correct for
host, refuted for standalone** (where `__push` is never reached, and would trap
if it were).

**Consequence the lead has already relayed upward: the public HOST conformance
number is inflated too.** That was true of the arity bug only for standalone
(host got the equivalent fix at #2623 P-7); it is NOT true of `verifyProperty`.

## Numbers (denominators, honest split)

- Census, **exact**: 5,067 files call `verifyProperty` over **6,470** call sites;
  6,310 pass an object literal, 6,308 of those with ≥1 checkable field; 2 are
  `{}`; 0 accessor-only; 25 pass `undefined`; 135 pass an identifier.
  **`5,067` is an UPPER BOUND** — the regex matches `// TODO: … verifyProperty()`
  comments, and some calls sit behind an `if` that is false for root cause A.
- Standalone, 600-file uniform sample (mulberry32, seed `20260725`):
  arm A stock = **161 pass** / 381 fail / 53 skip / 5 CE.
  arm B (detector) over those 161 = **158 fail / 3 pass / 0 CE**.
  arm A2 (attribution control: all structural edits, throws removed) = **161/161
  pass**, identical to arm A.
  The 3 survivors execute no `verifyProperty` call at all → **158/158** of
  executed calls are vacuous. **NOT scaled to 1,190 or any corpus figure.**
- Host magnitude: **NOT MEASURED.** A run was started and abandoned at ~350/600
  (box at 2.4× the concurrency ceiling; branch committed to twice mid-run, so its
  provenance would not match the standalone numbers'). No partial output kept.
  Three-command recipe is in the issue; the detector is already calibrated for
  the host lane.

## Method notes worth reusing

**The attribution control is the part that made the number defensible.** "The
instrumented harness fails 158 tests" is not evidence the *detector* fired — the
instrumentation could have broken something. Arm A2 runs every structural edit
with the detector `throw`s removed; it reproducing arm A exactly is what turns
the claim into a measurement. Add an A2 to any future instrumented-harness A/B.

**Calibrate before sampling, and calibrate BOTH directions.** A positive control
that must fire and a negative control that must stay silent — on each lane. A
third control (`{}` + `Object.defineProperty`, correct descriptor) fired on host
and was *excluded* as contaminated rather than explained away; it is recorded as
a separate observation instead.

**One arm per PROCESS.** `tests/test262-original-harness.ts` caches harness
sources in a module-level Map, so swapping the file mid-process silently reuses
the first arm's text.

**Harness isolation.** `ab.mts` swaps only *its own worktree's* `test262/harness`
symlink for a private real copy, so the shared `/workspace/test262` other agents
read is never touched. Restore is on `process.on("exit")` — which a **SIGKILL
bypasses**. This happened here; the symlink had to be restored by hand
(`rm -rf test262/harness && ln -s /workspace/test262/harness test262/harness`).
Check `ls -la test262/ | grep harness` after any killed run. (Note: a
self-referential `harness -> /workspace/test262/harness` link inside the shared
harness dir is PRE-EXISTING, dated Jun 3 — not damage.)

## Traps that cost real time (all measured, none hypothetical)

1. **Do NOT use `Object.keys(desc)` / `getOwnPropertyNames(desc)` as a detector
   yardstick.** On a directly-named module global `Object.keys(DESC).length` is
   **4** (compile-time fold); on the SAME object through an `any` parameter it is
   **0**. A detector comparing "checks performed" against it computes
   `0 < 0 === false`, never fires, and returns a clean bill of health that is
   entirely false. This was caught *before* the sample run, on advice.
2. **`export` is required** on a probe accessor — a plain top-level function
   declaration is not auto-exported and reads back as undefined.
3. **`/** @param {number} i */` is required** on the accessor's parameter or the
   compile fails on implicit `any`.
4. **Never compare an untyped export parameter to a numeric literal directly.**
   `p(i)` with `if (i === 0)` never matches on standalone (boxed-`any` strict-eq).
   Coerce first: `var j = i + 0;`. Without this EVERY observation reads
   "branch not taken" and the probe looks totally broken.
5. **A Wasm trap is not catchable by the compiled `try/catch`** — catch around
   the accessor call on the JS side.
6. **Host-lane probes need the real import object**; `WebAssembly.instantiate(bin, {})`
   only works for standalone (where `result.imports` is `[]`). Use `runTest262File`.
7. **`verifyProperty` is destructive** (`isConfigurable` does `delete obj[name]`)
   and the host lane shares real host builtins across in-process runs — probing
   `Math.abs` twice in one process without `{restore:true}` contaminates the
   second probe. Use a fresh subject per case.

## Measured NON-findings (do not re-derive)

- **`transformVerifyPropertyCalls` (`tests/test262-runner.ts:1410`) is NOT the
  cause.** That legacy source-rewrite belongs to the retired rewritten-harness
  path; `runTest262File` and `scripts/test262-worker.mjs` both go through
  `assembleOriginalHarness` / `originalHarness: true` and compile the untouched
  upstream `propertyHelper.js`.
- **Not the `__apply_closure` arity bug** (#3592 RC2) — refuted by the previous
  session with the widening ON and OFF, re-confirmed here by mechanism.
- **`Object.defineProperty` does not promote a typed-struct object** to a
  queryable `$Object` either — a separate, small, self-contained defect (S3).
- **`__builtinfn_gopd` returns a wrong `value`** for `Math.abs.name` (descriptor
  is non-undefined and `writable === false` is right, but `value === "abs"` is
  false), so the `name`/`length` family flips to honest FAIL once the guards fire.
  This is a floor-DOWN expectation, not a pass-preserving cleanup.

## Where the fix boundary is (the lever for S2)

A **promotion path to `$Object` already exists** — measured. `{}` then
`o["a"] = 1` (computed key), `new Object()`, `Object.create(null)`, `JSON.parse`
and `{...spread}` all produce fully queryable objects. Only the literal /
static-key-assignment path stays a blind typed struct. The narrow high-leverage
S2 case is therefore: **an object literal passed as an argument to a function
with an untyped parameter** — exactly the `verifyProperty(obj, name, desc)`
situation. The full boundary table is in the issue.

## Plan of record

S1 uncurryThis repair (M, FIRST — also the only slice that can prove itself
today, because host vacuity is entirely S1's fault and the detector is already
calibrated for it) → S2 object-literal promotion (L/XL) → S3 `defineProperty`
promotion (S/M) → S4 re-measure + land the honest floor (down), per
`.claude/memory/reference_f1_honest_floor_deinflation_landing_recipe.md`.
