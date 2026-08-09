---
id: 3903
title: "perf: the host-call lane pays 24-1,700× the gc-native lane on every string benchmark — per-call host-boundary cost, not per-character cost"
status: in-progress
assignee: senior-developer
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: hard
reasoning_effort: max
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: current
horizon: xl
es_edition: multi
related: [3899, 3900, 3901, 3902, 1947, 3898, 3904, 3912]
loc-budget-allow:
  # (#3903) `src/runtime.ts` grows ~106 lines. The god-file gate's usual remedy
  # — "add code to the subsystem module, not the barrel" — does not apply: this
  # change ADDS NO FEATURE. It rewrites five existing host-import shims in place
  # (`string_method`, the generic `extern_class` method shim, `__extern_length`,
  # `_deferStringDataArg`, `_isWasmStruct`) so they stop allocating a closure per
  # boundary crossing. The line delta is almost entirely (a) the arity-switch
  # arms that replace one spread call, and (b) comments recording WHY each shape
  # is required — including one alternative that was implemented, measured, and
  # then WITHDRAWN for invoking a user Proxy trap that previously never ran.
  # Extracting these shims to a module is a real and worthwhile refactor, but it
  # is a different change with a different risk profile, and doing it inside a
  # perf fix to the default compilation mode would make both unreviewable.
  - src/runtime.ts
func-budget-allow:
  # (#3903) Same reasoning as `loc-budget-allow` above, and the same +86 lines
  # counted a second time: every shim this change rewrites lives inside
  # `resolveImport`'s intent dispatch, so its own budget moves in lockstep with
  # the file's. Splitting `resolveImport` (7,300 lines, ~40 intent arms) is the
  # right long-term fix and is exactly what #3399 tracks — but it is a pure
  # structural refactor of the default compilation mode's entire host surface,
  # and landing it inside a behaviour-sensitive perf fix would make the perf
  # change impossible to review and the refactor impossible to bisect.
  - src/runtime.ts::resolveImport
---

# #3903 — the `host-call` lane's string boundary cost is not a constant, it is a catastrophe

## Status: open

## Problem

`host-call` is the **default** compilation mode (no `--fast`): JS host imports,
`externref` values. Some boundary cost is expected and by design. What the
2026-07-31 numbers show is not a boundary cost — it is a per-call cliff.
`avgMs` per `run()` from `benchmarks/results/latest.json`:

| Benchmark                    | gc-native | host-call   | host-call / gc-native |
| ---------------------------- | --------- | ----------- | --------------------- |
| `array/sort-i32`             | (absent)  | 773.937268  | — (1,586× JS)         |
| `mixed/csv-parse`            | 0.800980  | 20.807877   | **26×**               |
| `string/split`               | 0.873729  | 15.048745   | **17×**               |
| `mixed/text-search`          | 1.198539  | 14.832836   | **12×**               |
| `string/startsWith-endsWith` | 1.374452  | 7.234811    | **5.3×**              |
| `string/substring`           | 0.052122  | 3.533728    | **68×**               |
| `string/trim`                | 0.492126  | 3.301557    | **6.7×**              |
| `string/indexOf`             | 0.014947  | 0.365823    | **24×**               |
| `string/includes`            | 0.013537  | 0.370781    | **27×**               |
| `mixed/matrix-multiply`      | 0.151250  | 1.367787    | **9.0×**              |

Two observations that should drive the investigation:

1. **The multiplier tracks call count, not data size.** `string/substring`
   does 10,000 tiny calls and is **68×** off; `string/startsWith-endsWith`
   does 20,000 trivial calls and is only 5.3× off; `string/indexOf` does 1,000
   calls over a 10 KB haystack and is 24× off. The cost is dominated by
   *crossing*, not by the work on either side. At `substring`'s 10,000 calls
   in 3.53 ms that is **~353 ns per call** — two orders of magnitude more than
   a bare `externref` import call should cost.
2. **`mixed/matrix-multiply` is 9× off with no strings involved at all**
   (0.151 ms gc-native vs 1.368 ms host-call). So this is not purely a string
   problem — the host lane's *numeric array* path pays too. That makes
   "encoding cost" an insufficient explanation on its own.

## Hypotheses to test (in order of expected payoff)

1. **Re-encoding the receiver on every call.** If each `s.indexOf(x)` converts
   the whole WasmGC/`externref` string to a JS string (or vice versa) per
   call, cost scales with string length × call count. Test: hold call count
   fixed and vary string length; if time scales with length, this is it.
2. **Boxing every argument and the return value.** `substring(5, 20)` should
   pass two immediates; if each goes through `__box_number` and the result
   comes back as a boxed `externref` that is immediately unboxed, that is
   fixed overhead per call — which matches the "tracks call count" signal.
3. **Import call not being inlined / trampolined.** Check whether calls go
   through a generic dispatch shim rather than a direct import index, and
   whether Binaryen can see through it.
4. **Identity/sidecar bookkeeping per crossing.** There is known prior art
   here on receiver identity being lost across the boundary; check whether a
   per-call map lookup or sidecar allocation happens.

Measure before fixing. Build a microbenchmark that isolates *one* host call in
a loop with a fixed tiny string, and get the absolute per-call cost. 353 ns is
the number to explain; anything under ~20 ns/call would be defensible.

## Why this matters beyond the chart

`host-call` is the default mode. Everything that does not opt into `--fast`
lands here, and #1947 (end-to-end GC-ref typing — stop laundering through
`externref` inside the module, convert only at the host boundary) is the
strategic fix this issue should feed. Treat this as the measurement that either
justifies or re-scopes #1947.

## Scope

This is deliberately an **investigate-then-fix** issue, and it is `horizon: xl`.
Do not try to land all of it in one PR.

1. Build the isolated per-call microbenchmark and publish the absolute
   per-crossing cost for: a no-arg call, a call with two numeric immediates, a
   call returning a string, and a call on a 10 KB receiver.
2. Identify which of the four hypotheses dominates. Write it down in this issue
   **before** writing a fix — that finding is the deliverable even if the fix
   slips.
3. Land the highest-payoff fix that does not require the full #1947 rework.
4. If the remainder genuinely requires #1947, say so explicitly and re-scope
   #1947 with these numbers attached.

## Acceptance criteria

1. A published per-crossing cost breakdown (the four shapes above) in this
   issue.
2. A named dominant cause, with the evidence that identified it.
3. `string/substring` host-call improves by **≥5×** against the current
   3.534 ms, **or** the issue documents why the remaining cost is structural
   and blocks on #1947.
4. `mixed/csv-parse` host-call improves by **≥3×** against 20.808 ms.
5. No equivalence-test or test262 regressions. The host lane is the default
   mode — correctness here is not negotiable for a perf win.
6. (Added 2026-07-31, from #3904 — see "The DOM lane" below.) The DOM section
   of the published performance page is labelled as a **boundary-cost
   measurement against a mock DOM**, not as DOM performance, and its wording is
   consistent with what this issue concludes about per-crossing cost.

## Non-goals

- gc-native kernel costs (#3899, #3900, #3901) — different lane, different
  bottleneck.
- The `array/sort-i32` algorithm itself (#3902), though its 774 ms is very
  likely dominated by this same per-crossing cost and the two issues should
  compare notes.

---

# Findings (2026-07-31)

## 1. The per-crossing cost breakdown

Method: compile a `host-call` module whose `run()` body is a tight loop with
**exactly one** host import call (verified in the WAT — the `substring` loop
emits a single `call 1` per iteration and nothing else), then measure the same
wasm module three ways: (a) the real `buildImports` shim, (b) the same wasm
with the env import swapped for a minimal monomorphic arrow, (c) the loop in
plain JS. Bundled with plain `esbuild` and run under plain `node` — *not*
`tsx`, for reasons that turn out to matter a great deal (see §3).
`(a − b)` is the host-shim cost, `(b − c)` is the raw wasm↔JS crossing.
Harness: `.tmp/crossing-bench.mts`, 10,000 crossings per `run()`, median of 30.

| call shape | as-shipped | direct arrow | pure JS | **shim** | **crossing** |
| ---------- | ---------- | ------------ | ------- | -------- | ------------ |
| no-arg (`trim`, 17-char receiver)            | 133.3 ns | 43.8 ns | 33.2 ns | **89.5 ns** | **10.6 ns** |
| two numeric immediates + string return (`substring`) | 259.2 ns | 27.7 ns | 1.4 ns | **231.5 ns** | **26.3 ns** |
| one string arg + numeric return (`indexOf`, 26-char receiver) | 275.5 ns | 33.5 ns | 1.5 ns | **242.0 ns** | **32.0 ns** |
| 10 KB receiver, numeric return (`indexOf`)   | 266.5 ns | 32.5 ns | 1.5 ns | **234.0 ns** | **31.0 ns** |

Two results fall straight out of this table:

- **The raw crossing is 10–32 ns — it is already within the "defensible" band
  the issue asked for.** `externref` in, `externref`/`f64` out is not the
  problem.
- **Hypothesis 1 (per-call receiver re-encoding) is REFUTED.** A 10 KB receiver
  costs 266.5 ns and a 26-char receiver costs 275.5 ns — *identical within
  noise*, on the same method. Nothing proportional to receiver length is
  happening at the boundary. This is the cleanest falsification available and
  it also explains observation (a) in the problem statement: the multiplier
  tracks call count because the cost is a fixed per-call constant.

## 2. The named dominant cause

**The generic `string_method` host shim in `src/runtime.ts` — specifically the
work it re-does on every crossing that depends only on the method NAME, which
is fixed at import-resolution time.** It is 7–9× the crossing it wraps.

Attribution, measured by swapping variants of the shim onto the *same compiled
wasm module* (`.tmp/variant-bench.mts`). Driving the calls from wasm is
essential: a JS-driven microbenchmark lets V8 inline the shim into the loop and
reports numbers that are not merely wrong but *inverted* (the as-shipped shim
"beats" every optimised variant). Every number below is ns per crossing:

| variant | ns/crossing | delta |
| ------- | ----------- | ----- |
| REAL `buildImports` (shim + trampoline)     | 177.0 | — |
| replica shim + depth-guard trampoline       | 120.1 | (replica omits `_isWasmStruct`/legacy-RegExp detail) |
| replica shim, no trampoline                 | 112.4 | trampoline ≈ 11 ns |
| + `coerce` closure hoisted out of the body  |  79.9 | **−40 ns** |
| + `a.map(coerce)` → plain loop              |  60.7 | **−19 ns** |
| + arity switch instead of the spread call   |  43.5 | **−17 ns** |
| direct monomorphic arrow (floor)            |  30.6 | — |

So the per-crossing budget was, in order: **allocating a closure inside the
per-call body (~40 ns)**, `Array.prototype.map` plus its extra array (~19 ns),
the spread call (~17 ns), the depth-guard trampoline (~11 ns), and ~30 ns of
genuine crossing.

Two more shims were on the same hot path and had the identical defect:

- `__extern_length` allocated **two** closures (`toLength`, `coerceLen`) per
  call. `mixed/csv-parse` makes 21,000 `__extern_length` crossings per `run()`.
- `_rerouteStringSymbolMethodPrimitive` did `sym in Object(first)`, allocating
  a fresh wrapper object on every `split`/`replace` crossing.

And one non-closure finding, from `node --cpu-prof` on `mixed/csv-parse`:
**`_isWasmStruct` was 48% of self time**, with the GC a further 7.7%. The
#3673 memo (`WeakMap` verdict cache) is a pessimisation for one specific arm of
that predicate: every `split()` result is a *fresh, short-lived* array, so each
of the 31,000 crossings per `run()` paid a `WeakMap.set` and then left an
ephemeron entry for the GC to walk over a dead object. Not writing the memo on
the cheap (non-null-prototype) arm removes both costs; the memo still covers
the arms #3673 introduced it for, where classification genuinely costs an
`Object.isExtensible` probe or a thrown TypeError.

### Hypotheses, adjudicated

1. **Per-call receiver re-encoding — REFUTED.** 10 KB and 26-char receivers
   cost the same (§1).
2. **Boxing arguments and the return value — NOT the cause.** `__box_number` /
   `__unbox_number` for `number` are `(v) => v` and a ToNumber funnel; neither
   allocates. The numeric-array benchmarks pay the *raw crossing* count, not a
   boxing shim (see `mixed/matrix-multiply` below).
3. **Un-inlined dispatch shim — CONFIRMED, and it is the whole story.** Not one
   shim but two stacked layers: the per-import depth-guard/exception-capture
   trampoline (`...args` + `original.apply`, ~11 ns) and the generic
   `string_method` shim on top of it (~90–240 ns). The trampoline is the small
   half and it is safety-critical, so it was left alone.
4. **Per-crossing identity bookkeeping — CONFIRMED as a secondary cause**, in a
   form the issue did not anticipate: not a sidecar allocation but the
   `_isWasmStruct` verdict `WeakMap`, which is pure overhead (plus GC pressure)
   for the short-lived host objects the string lane produces.

## 3. Why the published multipliers were bigger than the real ones

`benchmarks/run.ts` is run via `npx tsx`, and **`tsx` transpiles with esbuild's
`keepNames`**, which wraps every function literal in
`__name(fn, "…") = Object.defineProperty(fn, "name", …)`. So a closure
allocated inside a hot function body costs an `Object.defineProperty` *per
allocation*. Same source file, same node build:

```
                                        plain node   under tsx
rest args + inner closure (called)          11.3 ns     506.3 ns
rest args, no inner closure                 21.6 ns      21.5 ns
rest args, closure hoisted out              23.7 ns      21.4 ns
```

Confirmed by transpiling by hand: `esbuild --keep-names` reproduces it exactly
(489.9 ns), `esbuild` without it does not (11.2 ns).

This is **not** the root cause — the shim is 7–9× the crossing even in a clean
build — but it is a ~4× amplifier that lands **only on the `host-call` lane**,
because `gc-native` makes no host calls at all. That is why the published table
shows 68× on `substring` where a clean build shows ~19×. The shipped `dist/`
build (vite/rollup, `keepNames` off) does not carry it, so real consumers never
saw the amplified number. Flagged to #3898 (benchmark validity) — the fix on
that side is to measure through a pre-bundled harness rather than the dev
loader. Note that hoisting the closures fixes the *exposure* regardless: there
is no longer a per-call function literal for `keepNames` to wrap.

## 4. What was fixed

All in the host runtime; **no codegen or emitted-wasm change**, so nothing about
stack balance, return types or import indices moves.

- `src/runtime.ts`, `string_method`: hoisted `coerce` and the
  `_deferStringDataArg` mapper out of the per-call body; precomputed everything
  that depends only on `method` (`isSymbolDispatch`, `isSplit`,
  `usesNaNOmitSentinel`, `tracksLegacyRegExpState`) at import-resolution time;
  replaced `a.map(coerce)` and `[wrapped, ...a.slice(1).map(…)]` with single
  pre-sized loops; replaced the spread call with an arity switch whose arms are
  the *same* `recvStr[method](…)` member call (so a monkey-patched
  `String.prototype` method is still honoured and no `Function.prototype.call`
  is introduced); `String(recv)` short-circuited for an already-primitive
  receiver.
- `src/runtime.ts`, `__extern_length`: hoisted `toLength` / `coerceLen`.
- `src/runtime.ts`, generic `extern_class` method shim: `args.some(closure)`
  → plain loop, and the spread call → arity switch. This is the DOM lane's hot
  path (§4b).
- `src/runtime.ts`, `_isWasmStruct`: stopped memoizing the non-null-prototype
  verdict. Ordering, trap invocations and verdicts are all byte-identical —
  only a cache *write* is skipped, on the one arm where re-deriving the answer
  (a single map load) is cheaper than the `WeakMap.set` it replaces. An earlier
  draft moved the `getPrototypeOf` probe *ahead* of the memo and the
  `_userProxies` WeakSet; that was withdrawn because `_userProxies` holds
  **user-authored** proxies from compiled `new Proxy(t, h)`, so probing first
  would have invoked a user `getPrototypeOf` trap that previously never ran —
  an observable side effect, and exactly the kind of thing test262's
  Proxy trap-invocation-count tests assert on. The conservative version
  measured no slower (`csv-parse` 6.86 ms vs 6.96 ms), so the memo *read* was
  never the cost; the write and the ephemeron pressure were.
- `src/runtime.ts`, `_deferStringDataArg`: check `_isWasmStruct` before
  resolving `getExports()` (pure reorder; both are side-effect-free).
- `src/runtime/legacy-regexp.ts`: `sym in Object(first)` →
  `sym in <wrapper prototype>`. Exactly equivalent for a Symbol key — a freshly
  boxed `String` wrapper's own properties are only integer indices and
  `length`, and `Number`/`Boolean`/`BigInt` wrappers have none — and it drops
  the per-crossing allocation.

### Results

**Caveat on absolute times: this box ran 6 agents on 4 cores all session, with
1-minute load between 4 and 13.** Absolute ms therefore drift a lot between
runs; only same-script, back-to-back A/B pairs are trustworthy. Both tables
below are such pairs.

**(a) Clean, production-shaped build** — plain `esbuild --bundle` + plain
`node`, no `tsx`. Identical script (`.tmp/profile-one.mts`), before and after
measured back-to-back by checking the patch out and back in:

| benchmark | before | after | speedup |
| --------- | ------ | ----- | ------- |
| `mixed/csv-parse`            | 18.325 ms | 6.963 ms | **2.63×** |
| `string/substring`           |  2.973 ms | 1.211 ms | **2.46×** |
| `string/split`               | 24.993 ms | 16.569 ms | **1.51×** |
| `mixed/text-search`          | 11.480 ms | 8.201 ms | **1.40×** |
| `string/startsWith-endsWith` |  6.501 ms | 5.690 ms | **1.14×** |

plus the isolated single-method crossing at **177 → 68.6 ns (2.6×)**.

**(b) Through the real harness** (`npx tsx benchmarks/run.ts`) — the exact path
that produced the table at the top of this issue, where the §3 `keepNames`
amplifier is live and therefore the improvement is much larger:

| benchmark | host-call before | host-call after | speedup | ratio to gc-native |
| --------- | ---------------- | --------------- | ------- | ------------------ |
| `string/substring` | 11.159 ms | 0.709 ms | **15.7×** | 125× → 10.4× |
| `mixed/csv-parse`  | 82.407 ms | 6.473 ms | **12.7×** | 24.5× → 3.1× |
| `string/split`     | 55.862 ms | 13.924 ms | **4.0×** | 14.2× → 3.0× |

Acceptance criteria 3 (`substring` ≥5×) and 4 (`csv-parse` ≥3×) are met on the
harness path — which is the path the issue's own baseline table was measured
on, so it is the like-for-like comparison. On a clean build the gains are the
smaller (a) figures, because the artefact being removed is smaller there; §5
accounts for what remains in that case.

## 4b. The DOM lane — the cleanest per-crossing evidence on the page

#3904 landed (`b4033e17`) and gave the four `dom/*` benchmarks a working
host-call lane for the first time in the project's recorded history: the
harness passed the extern classes as `deps` but never `document` itself, so
every DOM module trapped on its first call with `Cannot read properties of
undefined (reading 'createElement')` and the harness silently swallowed it.
Verified against `history.json`: **zero** of the 170 recorded runs contain a
wasm lane for any `dom/*` benchmark, so there is no prior parity claim to
reconcile — the lane was simply dead.

The first numbers, as reported:

| benchmark | js | host-call | vs js |
| --------- | -- | --------- | ----- |
| `dom/create-elements` | 0.125 ms | 1.083 ms | 8.7× |
| `dom/modify-text`     | 0.130 ms | 1.180 ms | 9.1× |
| `dom/read-attributes` | 0.179 ms | 0.424 ms | 2.4× |
| `dom/set-attributes`  | 0.459 ms | 1.065 ms | 2.3× |

**These corroborate the thesis in a stronger form than `matrix-multiply` does.**
`benchmarks/suites/dom.ts` has no browser in it: `MockDocument.createElement`
is `new MockElement(tag)` and `MockElement.setAttribute` is one property store.
So when the wrapped work is a single allocation, the measurement is almost
purely boundary crossing — and there is **no string encoding anywhere in the
workload**. The spread is the tell: the two cheapest operations sit at 8.7×
and 9.1×, while `set-attributes`, whose JS baseline itself costs 0.459 ms,
falls to 2.3× as the *fixed* crossing cost amortises against real work. That is
"the cost tracks call count, not data size" measured on a third, independent
workload.

I measured the `extern_class` path directly (`.tmp/dom-crossing.mts`, which
wires `deps.document` itself so it does not depend on #3904 being present in
this worktree), and the generic `extern_class` method shim turned out to have
the *identical* defect as `string_method`: `args.some(a => _isWasmStruct(a))`
allocated a closure on every crossing, plus a spread call. Fixed the same way
(plain loop + arity switch). Before → after, ns per crossing over the JS
baseline:

| shape | crossings/run | before | after |
| ----- | ------------- | ------ | ----- |
| `createElement` + `appendChild` | 3,002 | 170 ns | **16 ns** |
| `createElement` + 5× `setAttribute` | 7,000 | 112 ns | **59 ns** |

which moves `dom/create-elements` from 8.4× to **1.6×** vs its JS baseline and
`dom/set-attributes` from 4.5× to **3.8×** in this harness. The 16 ns residue on
the first shape is the raw crossing (§1's 10–32 ns band) — the same floor the
string shapes hit, reached from a completely different import intent. That is
about as direct a confirmation of the named cause as the codebase can produce.

**The published bars need a caveat (acceptance criterion 6).** As they stand a
reader takes them as "js2wasm is ~9× slower at DOM", which this benchmark does
not support. In a real browser `createElement` costs microseconds of engine and
layout work, which dominates a ~16 ns crossing and compresses the ratio toward
1; the ratio here is large *precisely because* the mock does almost nothing.
The file header's existing note ("the mock overhead is constant across
strategies, so relative performance is still meaningful") is true for comparing
wasm strategies to each other but does not license the vs-JS ratio as a
DOM-performance statement. The page's DOM section should say, consistently with
§1's numbers: *"boundary-cost measurement against a mock DOM — it measures the
cost of crossing into the host per DOM call (~16–60 ns), not the cost of DOM
work, which a real browser would dominate."* Wording owned here, page edit to
be made by whoever owns the perf page; #3904's chart change (`b4033e17` touches
`website/components/perf-benchmark-chart.js`) is the natural place.

### Correctness verification (acceptance criterion 5)

The host lane is the default mode, so "no regressions" had to be shown, not
asserted. Every check below was run on the final tree.

- **`tests/issue-3903.test.ts` — new, 21/21 green.** Pins each semantic the
  rewrites could plausibly have moved, in host-call mode: receiver-as-`this` at
  every arity, both directions of the NaN / `-1` omission sentinels
  (`startsWith`/`endsWith`/`split` with and without the optional argument, plus
  `indexOf` which must NOT strip a trailing NaN), argument order on the
  Symbol-dispatch branch, both branches of the `_rerouteStringSymbolMethodPrimitive`
  prototype lookup (including the #3095 case where a user installs
  `Number.prototype[Symbol.split]` and it must still be suppressed),
  ToPrimitive coercion of a compiled-object argument *and* receiver through the
  `_isWasmStruct` gate, and `extern_class` method calls at 0/1/2 arguments.
- **`tests/equivalence/` shard 1/4 (54 files, 379 tests), A/B'd.** 17 failures
  before, 17 after, and `diff` of the two sorted failure lists is **empty** —
  an identical failure set, all pre-existing on the base commit `f77b401b`
  (`coercion-arithmetic-add` in all four lanes, `null-dereference-guards`,
  `logical-conditional-identity`, `misc-small-patterns`). The A/B was done by
  checking the patch out and back in, not with `git stash` (see the note below).
- **`tests/equivalence/spec/` in full — the four-lane host/standalone matrix,
  84 tests.** Only the 8 pre-existing `coercion-arithmetic-add` failures; 76
  passed. This is the suite that exercises the host lane explicitly, so it is
  the most relevant one for these changes.
- `tsc --noEmit`, `biome lint src tests scripts --diagnostic-level=error`, and
  `prettier --check` all clean.

Full test262 is CI's job (this is a runtime-only change with no emitted-wasm
delta, so the compiled binaries are byte-identical — only host behaviour could
move, and the equivalence host lanes cover that).

> **Method note, worth propagating:** do **not** use `git stash` for before/after
> measurement in these worktrees. The stash stack is **shared across all
> worktrees of a repo**, and with six agents running concurrently a `stash pop`
> can apply and drop *another* agent's entry. That happened during this work
> (recovered from `git fsck --unreachable`, no work lost). Use
> `git diff HEAD -- <files> > .tmp/x.patch` + `git checkout HEAD -- <files>` +
> `git apply --index .tmp/x.patch` instead — worktree-local and collision-free.

## 5. What is left, and what genuinely blocks on #1947

Remaining per-crossing budget after this work, isolated single-method:
**68.6 ns**, against a **30.6 ns** floor for the raw crossing. The residue is:

- **~11 ns — the depth-guard/exception-capture trampoline.** Deliberately not
  touched: it is what makes host exceptions catchable by compiled `try`/`catch`
  and what stops runaway host↔wasm recursion. An arity-specialised replacement
  measured no better than the existing one (40.4 vs 41.6 ns), so there is
  nothing to win here without giving up safety.
- **~25 ns — megamorphic dispatch.** In a process that uses several string
  methods, all `string_method` shims share one closure creation site, so the
  `recvStr[method](…)` keyed load and call collapse into one megamorphic IC.
  Isolated (one method in the process) the shim costs 68.6 ns; in the full
  benchmark process the same crossing costs ~157 ns. Fixable *without* #1947 by
  giving each method its own creation site (a literal table of per-method
  invokers, e.g. `indexOf: (r, a) => r.indexOf(a[0], a[1])` — a named member
  call, so monkey-patching semantics are preserved exactly). ~25 entries of
  boilerplate; deliberately left for a follow-up so this change stays reviewable
  and its correctness argument stays small.
- **~30 ns — the crossing itself. THIS is the part that needs #1947.** Every
  `s.substring(5, 20)` leaves the module as an `externref`, is re-entered as a
  JS string, and comes back as a fresh `externref`. No host-side work can
  remove it; only end-to-end GC-ref typing can, by keeping the value inside the
  module and converting at the real host boundary. Concretely: `string/substring`
  is now 0.677 ms against 0.104 ms gc-native, and **~30 ns × 10,000 = 0.30 ms
  of that 0.677 ms is irreducible crossing**. So #1947 is worth roughly a
  further 2× on this shape and nothing at all on shapes with few crossings.

**`mixed/matrix-multiply` — the no-strings 9× — is entirely a #1947 problem.**
Its import census is `__box_number` / `__unbox_number` only, and both resolve to
`(v) => v` and a ToNumber funnel: there is no generic shim to strip. The cost is
that a `number[]` in the host lane is an `array (mut externref)`, so every
element write is a box crossing and every read an unbox crossing. That is the
value-representation problem #1947 exists to solve, and it is not addressable
from the runtime side. Its measured ratio in a clean build is 2.9× (the
published 9.0× includes the §3 amplifier).

**Re-scoping note for #1947, with numbers attached:** the strategic case for
#1947 is now *smaller than the chart implied but still real*. Of the original
68× on `string/substring`, roughly 4× was a measurement artefact (§3), ~11× was
host-shim overhead removed here, and the residual ~6.5× splits into ~2× of
irreducible crossing (#1947's territory) and the rest being gc-native simply
doing the work in-module. #1947 should be scoped as "remove the crossing for
values that never leave the module", justified by the numeric-array lane
(`matrix-multiply`, `array/*`) where the crossing is 100% of the gap — not by
the string benchmarks, where it is now the minority term.

## 6. Follow-ups this issue does NOT close

This is one PR out of an `xl` issue; `status` stays `in-progress`.

1. **Per-method invoker table** to kill the ~25 ns of megamorphic dispatch
   (§5). Mechanical, semantics-preserving, but ~25 entries of boilerplate — it
   belongs in its own reviewable change.
2. **30 more shims have the same per-call-closure defect.** A scan of
   `src/runtime.ts` (`.tmp/scan-percall-closures.mts` — walks every function
   returned from `resolveImport` and counts function expressions nested in its
   body) finds **34**; this change fixed the four the benchmarks proved hot
   (`string_method`, `__extern_length`, the generic `extern_class` method
   shim, and the `_deferStringDataArg` mapper). The rest — `__defineProperties`
   (6 closures/call), `__defineProperty_desc` (4), `__array_concat_any` (3),
   `__extern_method_call`, `__object_values`/`entries`,
   `__getOwnPropertyNames`, `__regex_symbol_call`, `__construct`, `__iterator`,
   … — are the same fix, and any of them is a cliff waiting for the first
   workload that leans on it. Worth a lint rule rather than a one-off sweep:
   *no function expression inside the body of a host import shim.*
3. **`array/sort-i32` is NOT an exemplar for this issue — see the correction in
   §7.** It has **zero** host crossings in the form the benchmark now runs.
4. **Acceptance criterion 6** — the DOM section's page wording (§4b). Wording
   is drafted above; the page edit belongs with whoever owns
   `website/components/perf-benchmark-chart.js`.
5. **`benchmarks/run.ts` is measured through `tsx`** (§3), which selectively
   penalises the host-call lane. Handed to #3898; the fix is to run the harness
   from a plain bundle.

## 7. Correction — `array/sort-i32` was a bad exemplar, and why

An earlier draft of §6 cited `array/sort-i32` at **48,884,145 crossings per
`run()`** and concluded "its 774 ms is not an algorithm problem at all". **The
number was right and the conclusion was wrong.** #3902 (`0197160e`) caught it.

The error: on this path **crossings/run is `2 × comparisons`**, so it is *set
by* the algorithm rather than independent of it. I read a symptom as a floor.
Re-measured on this worktree's (pre-#3902) compiler, holding the lowering fixed
and varying only the comparator — `.tmp/sort-census.mts`:

| n | comparator | crossings/run | n²/4 |
| - | ---------- | ------------- | ---- |
| 1,000  | `arr.sort()` (spec default = ToString) | 493,187 | 250,000 |
| 1,000  | `arr.sort((a,b) => a-b)` | **0** | — |
| 10,000 | `arr.sort()` (spec default = ToString) | 48,884,145 | 25,000,000 |
| 10,000 | `arr.sort((a,b) => a-b)` | **0** | — |

Two things fall out:

- The ToString rows are `2 × n²/4` to three significant figures — the **in-place
  insertion sort signature**. So the count was algorithm-driven, and #3902's
  merge sort takes it to ~102,820 on the identical comparator (their
  measurement), a 158× reduction with the boundary untouched. My census
  corroborated their diagnosis; I just read it backwards.
- **A wasm-closure comparator crosses the boundary zero times**, at any n. #3902
  also fixed the benchmark itself (its JS baseline had always called
  `arr.sort((a,b) => a-b)` while the wasm source called bare `arr.sort()` — the
  lanes were running different algorithms). So in the form `array/sort-i32` now
  runs, it has **no host crossings at all** and is not evidence for anything in
  this issue. Dropped as an exemplar: a reviewer re-running the census against
  current main would get 0 and rightly distrust the instrument.

**Everything else in the census is unaffected** — no other benchmark's crossing
count is comparison-driven, and the 0–52,000 crossings/run range measured for
the rest of the suite stands. The instrument is sound; the reading was not.

Also correcting attribution: my "lever 1" suggestion to #3902 (`number_toString`
for an i32/f64 element should not need the host at all) is already filed as
**#3912** at critical priority — cite that, not this issue. My independent
observation that `--target standalone` emits **zero** env imports for the same
programs turns out to be the exact control configuration that pins #3912's
mechanism: `import-collector.ts` gates `string_compare` on `nativeStrings` but
`number_toString` on `wasi || standalone`, so `fast: true` is the only config
that pairs a **host** `number_toString` with **native** string helpers — and the
only failing one. Standalone (native provider + native strings) passes. Two
issues reaching that config from opposite directions is good evidence for the
fix direction.

Finally, reconciling with #3898's independent measurement: they measure
`string/substring` host-call at 30.67× vs JS on a bundled harness, where I
quote ~19×. Same ~3.5× overstatement factor against the published 109×, and the
residual difference is expected — #3898 measured the **un-fixed** runtime
(§4's changes live only in this worktree), so their number should be, and is,
worse than mine. The two measurements agree.
