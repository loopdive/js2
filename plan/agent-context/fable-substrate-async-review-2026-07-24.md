# Deep review: value-representation substrate + async implementation

Fable architect review, 2026-07-24/25, on main `7652f0337` (upstream tip, post
#2864-D4). Method: verify-first — every claim below was proven by a
differential probe (Node reference vs gc-host wasm vs standalone wasm) run
against current main; probe sources are quoted inline or in the referenced
issue files. Probe harness: esbuild bundle of `src/index.ts` +
`buildImports` from `src/runtime.ts`; probes lived in `.tmp/probes/`
(gitignored, reproducible from the snippets here).

**Companion review**: the parallel IR-boundary review (fable-ir-review) found
#3566/#3567/#3568; this review confirms the same hazard class from the other
two directions (async engine selection, generator backend selection).

---

## Part A — value-representation substrate

### Verified current state (do not trust older issue prose)

| Flag                    | Default on main                          | Where                   |
| ----------------------- | ---------------------------------------- | ----------------------- |
| `undefinedSingleton`    | **TRUE** (`?? env !== "0"`)              | `create-context.ts:311` |
| `tag5ValueEqClassifier` | **TRUE**                                 | `create-context.ts:302` |
| `honestAnyBoxing`       | **FALSE** (the remaining flip, #2141 S4) | `create-context.ts:291` |
| `unionAnyRep`           | opt-in                                   | `index.ts:353`          |

Note: `compiler.ts:770-778` comments still say "(default off)" for the two
flipped flags — stale; the effective default is set in `create-context.ts`.

### What was probed and found CORRECT (standalone + gc, vs Node)

- `$Object` dynamic reader with native-string values: `o["s"]` read through an
  any-typed helper returns the string, `typeof` and `===` both correct
  (probe s3 — the historical root-cause class is fixed on this shape).
- tag-5 value eq basics: boxed-string `===` by value, boxed-number `===`,
  NaN self-inequality through any, `undefined !== null` strict /
  `undefined == null` loose (probe s4, all 11111).
- Object identity: `a === arr[0]` after any[]-roundtrip; identity through
  any-typed aliasing (probe s2, the `===` legs).
- `Map.get` returning a correct, arithmetic-usable value when materialized
  into a local (probes s2c/s2g).

### Findings, ranked (silent miscompiles first)

**A1 (HIGH, silent) — `m.get(k) === lit` false in direct call-result
position; true via a local. An any-keyed Map poisons even typed Maps
module-wide.** → NEW issue **#3585**.
Standalone only. `if (m.get(a) === 7)` and `== 7` are FALSE while
`const g = m.get(a); g === 7` is TRUE in the same module. Worse: a typed
`Map<object, number>` gets the same wrong answer in direct position iff an
any-keyed Map exists anywhere in the module (in isolation it is correct) —
which reader/eq path a call site takes is decided by unrelated module
contents. This is the cleanest proof in this review of the representation-
coherence violation the #2773 epic exists to kill: the same value reaches the
same consumer in two reps depending on syntactic position and module
composition. Not IR-related (identical with `experimentalIR: false`).

**A2 (LOW likelihood / HIGH principle, silent) — the UNDEF_F64 sentinel
collides with a user-craftable NaN.** → NEW issue **#3588**.
Standalone: a DataView-minted f64 with bits `0x7FF00000DEADC0DE` answers
`typeof` = "number" and `x !== x` = true (a NaN), but **`x === undefined` and
`x == null` are TRUE**. The #2979 `$BoxedNumber`-carrying-UNDEF_F64 arm of
the is-undefined predicate (`any-helpers.ts:142`) treats the crafted payload
as the compiler's own sentinel. Bit-punning is the only mint path (computed
NaNs canonicalize), so real-world exposure is low — but it is a proven hole
in the #2106 design and should be either closed (canonicalize at the
DataView/TypedArray read boundary) or explicitly documented as accepted.

**A3 (assessment) — hybrid-divergence exposure is wider than IR-vs-legacy:
it is EVERY engine-selection boundary.** The #3566/#3567/#3568 class (IR vs
legacy claiming the same construct with different reps) is one instance of a
general pattern this review found in two more places:

| Boundary                                          | Selector                            | Proven divergence                                                    |
| ------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| IR vs legacy front-end                            | shape checks in `ir/select.ts`      | #3566/#3567/#3568 (parallel review)                                  |
| async host-drive vs legacy sync                   | `asyncFnNeedsHostDrive`             | **#3587** — declined shapes swallow rejections (Part B)              |
| native lazy generator vs eager buffer             | native claim gate + escape analysis | **#3586** / #2662 append — `s += yield` or factory-escape → silent 0 |
| standalone native carrier vs host-import fallback | per-shape carrier gates             | loud (env-import instantiate failure) — the GOOD failure mode        |

The structural fix direction is the same everywhere: a declined shape must
either (a) be claimed, or (b) fail loudly. The silent third option —
"declined → different semantics on the fallback engine" — is where all of
this review's worst findings live. The standalone lane's refusal behavior
(loud env-import failure) is the model; the host lane's silent fallbacks are
the anti-model.

**A4 (sentinels survey).** `-1` string-global sentinel: loud at emit time
(`global.get -1` rejected by the serializer) — recurring bug class but not a
silent-miscompile risk; guard pattern documented in memory/#51. tag-5 field-4
three-way classifier: no collision found in probing (s4 clean). UNDEF_F64:
collision proven (A2). undefined-singleton: no aliasing found in probes
(undefined vs null distinct through ===/==/typeof).

### Substrate recommendation (priority order)

1. Fix **#3585** (Map.get direct-position eq) — highest blast radius silent
   wrong answer; also a good forcing function to find the general
   "call-result-position rep ≠ local rep" seam, which likely affects more
   call sites than Map.get.
2. Adopt the loud-refusal invariant for engine-selection boundaries (A3) —
   cheapest systemic risk reduction; #3587's option (b) is the async
   instance.
3. Decide **#3588** (a/b/c options in the issue) — small, bounded.
4. `honestAnyBoxing` flip (#2141 S4): nothing in this review blocks it, but
   land #3585 first — the flip changes exactly the boxing paths #3585
   exercises, and a green flip on top of a silently-wrong eq path would mask
   the regression signal.

---

## Part B — async implementation

### Verified current state

- ONE async engine, two settle backends (#2967): `maybeActivateAsync` →
  `asyncFnNeedsDrive` (wasi native `$Promise` carrier) /
  `asyncGenConsumerNeedsDrive` (standalone, for-await-over-async-gen ONLY,
  #2980 carrier gate still narrow) / `asyncFnNeedsHostDrive` (gc host,
  LINEAR multi-await bodies only — `planLinearAwaits`; try/catch/finally
  across an await is declined). Everything declined → **legacy synchronous
  pass-through** (await = unwrap-or-identity, result = unwrapped value).
- IR async C-1 (#1373b) claims only what the engine declines AND only
  top-level declarations with explicit `Promise<T>` annotation passing
  Phase-1 shape checks — so the legacy sync population remains large.
- Generators, host lane: native lazy machine claims top-level (#3032 W6) and
  capturing-nested (#2662 slice 1) declarations; generator EXPRESSIONS,
  methods, `yield*`, exported/ESCAPING generators, and (new finding)
  non-canonical yield positions still fall to the eager buffer
  (`runtime.ts:~135`).
- Standalone async: an exported async fn compiles host-free but returns an
  opaque native carrier struct; the module exports `__drain_microtasks` +
  `__sget_state`/`__sget_value` accessors. A plain caller cannot observe the
  result (probe: state=1 after drain, value = boxed struct). This is the
  known #2895 PATH-B / #2865 gap — REAL, and silent from the caller's seat
  (you get `[Object: null prototype] {}` instead of your number).

### What was probed and found CORRECT

- Catch-across-yield (#2864 D4, the tip commit): `it.throw(v)` into a
  suspended try/catch — correct on gc AND standalone, including
  throw-on-not-started semantics (probe a3, 1111 everywhere).
- Generator sent values + return value, straight-line body (a4b) and
  loop bodies in canonical `const t = yield i` form, 1/2/3 iterations,
  multiple instances, post-loop reads (a4j/a4k/a4l/a4h/a4f/a4i) — correct on
  BOTH lanes (the #3032-W6 native host routing genuinely works).
- `it.return(v)` through a yield-suspended try/finally on the HOST lane:
  finally runs, `{value: 42, done: true}`, post-completion `next()` correct
  (a2b gc). (Standalone REFUSES this shape loudly — env-import failure; the
  silent variant of standalone finally-skipping is already filed as #3582.)
- Host lane finally-across-await incl. `await` INSIDE finally, and
  completion-value preservation (a1 gc, legacy sync path) — correct as long
  as nothing rejects.
- Rejection delivery on ENGINE-CLAIMED shapes: two-callback `.then` on a
  host-driven async fn's rejected result (a5d) — correct.

### Findings, ranked

**B1 (CRITICAL, silent, DEFAULT lane) — declined async shapes swallow
awaited rejections.** → NEW issue **#3587**.
`try { await Promise.reject(7); return -1; } catch (e) { return e; }` returns
**-1** on the default gc lane: the body CONTINUES past the rejected await,
the catch never runs, `.catch` handlers never run, and the rejection leaks as
a host unhandledRejection. Synchronous `throw` inside the same declined shape
DOES propagate — only promise-carried rejections are lost. The cruel part:
wrapping an await in try/catch — the construct that declares you care about
the rejection — is exactly what gets the function declined by
`planLinearAwaits` (non-linear body) onto the lane that cannot deliver
rejections. This is the most dangerous thing found in this review: common
code, default configuration, plausible-looking result, no diagnostic.

**B2 (HIGH, silent, DEFAULT lane) — `s += yield` returns 0.** → NEW issue
**#3586** (+ Review append on #2662).
A loop generator accumulating via compound assignment (`s += yield i`)
returns **0** instead of the accumulated sum on the host lane (eager buffer:
all sent values read as 0; the yielded values still look right, maximizing
stealth), while the de-sugared `const t = yield i; s = s + t` is claimed by
the native machine and fully correct. Standalone fails LOUDLY on the same
shape (emits env imports → instantiate error). Two spellings of the same
loop, two engines, two answers.

**B3 (HIGH, silent, host lane) — escaping generators lose sent values /
return value.** → Review append on **#2662** (known-eager residual, now with
a wrong-VALUE proof, not just wrong-timing).
The same correct-inline generator returned from a factory (`return g()`)
falls to the eager buffer: final value 0 instead of 60. Standalone is
CORRECT on this shape — a direct host-vs-standalone semantic divergence for
identical source.

**B4 (known, verified real) — standalone async is not consumable without
the PATH-B drive layer** (#2895/#2865): async exports return an opaque
carrier; `__drain_microtasks` + `__sget_*` exist but there is no documented
caller contract, so every naive standalone async consumer silently gets a
struct instead of a value. #3545 (microtask-job trap silently ends the
drain) remains open on top of this; not re-probed here (requires the
standalone stdout harness), no contradicting evidence found.

**B5 (spill-slot typing, #2873-class).** Not re-proven reachable in probing;
the `asyncClosureCellSpillHazard` guard (async-frame.ts) currently declines
the known-hazardous closure shapes into... the legacy sync lane — i.e. the
guard converts a loud wasm-validation failure into membership in B1's
silently-rejection-swallowing population. The declaration lane's latent
hazard flagged in memory (spill fields typed pre-body-compile diverging from
cell-boxed locals) still has no corpus instance; keep the guard, but note it
feeds B1.

### Async recommendation (priority order)

1. **#3587** — at minimum land the loud-refusal stopgap (compile
   error/diagnostic for await-inside-try on the declined lane) THIS window;
   the full fix is host-side #2906 Gap-3 (try-across-await states on the
   host settle backend).
2. **#3586** — small shape-gate fix (or pre-desugar `x op= yield e`); high
   stealth-to-cost ratio.
3. #2906 completion + #2980 carrier widen — every standalone async finding
   (B4, #3545, a2b refusal) is downstream of the carrier/drive gates; the
   loud failures are fine to leave until then, the silent ones are not.
4. #2662 Option-(ii) escaping-generator wrapper (B3) — epic-sized, already
   specced in the issue; until it lands, consider making ESCAPE fall
   loudly (refuse) rather than eagerly (wrong values), consistent with the
   A3/B1 loud-refusal invariant.

---

## The one-line summary

Both areas share a single systemic defect shape: **an invisible
engine/representation selector whose fallback lane has different semantics**.
Where the fallback fails loudly (standalone refusals), the system is honest;
where it falls back silently (host eager generators, host legacy-sync async,
call-result-position rep in standalone eq), it miscompiles common code with
no signal. The highest-leverage policy change is: **a declined shape must be
claimed or must refuse — never silently re-lane.**

## Probe index (repro sources)

All probes are inline in the issue files (#3585, #3586, #3587, #3588, #2662
append) or reconstructible from this doc: s1 sentinel, s2* identity/Map,
s3 dyn-reader, s4 tag5-eq, a1 finally-await, a2b finally-return, a3
catch-across-yield, a4* generator state machine, a5\* rejection paths.
Driver: compile via `src/index.ts` `compile()`; gc lane instantiated with
`buildImports(r.imports, {}, r.stringPool)` + `setExports`; standalone with
`{}` imports; Node reference via `ts.transpileModule` + data-URL import.
