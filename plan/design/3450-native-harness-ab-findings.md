# #3450 — JS-host native-harness (oracle v9 candidate): A/B findings + build/no-build recommendation

- **Type**: decision-support spike (SPEC + MEASURE FIRST). Measurement + design
  doc only. **No** oracle change, **no** `ORACLE_VERSION` bump, **no** production
  implementation.
- **Author**: senior-dev spike, 2026-07-19.
- **Status**: findings complete. Awaiting stakeholder build/no-build call.
- **Fold-in note**: the #3450 issue file is created in PR #3389
  (`plan-ci-accel-issues`), not yet on `origin/main`. This standalone doc should
  be folded into `plan/issues/3450-jshost-native-harness-oracle-v9-decision.md`
  once #3389 lands.

## TL;DR — recommendation: **NO-BUILD as a verdict-oracle change** (now)

The native-harness idea delivers the compile win the review predicted (**~4.5–5×**,
larger than the 2–4× estimate), but as a **verdict oracle** it is **net-negative
and honesty-diluting**:

- **Corpus-weighted net pass Δ ≈ −839 (−2.2 % of the in-scope corpus)** — it would
  *lose* passes, not gain them, because the dominant flip class (`assert.throws`
  error-identity) is a pure **regression** direction and high-frequency.
- **~24 % of in-scope verdicts flip.** The pass→fail half is **pure boundary
  noise** (error identity + MOP/marshaling fidelity), i.e. it *destroys* honest
  compiler signal — the opposite of what #3370/oracle-v8 bought. The fail→pass
  half is *not* "our compiler got better": it is compiled-harness-false-fail
  removal plus **host-delegated-builtin dilution** (the native harness reads V8's
  `Array.prototype.slice.length` etc., so the host lane increasingly measures
  **V8**, not js2wasm).
- The only *legitimate* upside (removing compiled-`propertyHelper` false-fails and
  a class of full-assembly compile bugs) is real but small in corpus weight and is
  better captured by keeping the harness **in wasm** (L4 linked-harness `.wasm`)
  or by the already-landed front-end speedups (#3374).

**The ~4.5× compile win is real, but it is not worth the rebase + honesty cost as a
verdict change.** Get the CI throughput from **L1** (promote push:main baseline
from the merge_group's own artifacts — zero honesty cost) and **L6** first; pursue
the honest structural dedup via **L4** (#1046 linked harness). Revisit native
harness **only** if, after L1/L6, host-lane *compile* is still the bottleneck
**and** realm-aware error construction lands first **and** the stakeholder
explicitly accepts host-builtin dilution.

---

## 1. What was measured, and how

A **throwaway** prototype (in `.tmp/spike-3450/`, gitignored) runs a stratified
sample **both ways** through a patched copy of the real `test262-worker.mjs`, so
**both lanes share 100 % of the production verdict logic** and differ only in the
boundary under test:

- **Way A (current oracle v8)**: compile the literal upstream assembly
  (`prefix + body`) to one wasm module; instantiate; verdict = did top-level
  (`__module_init`) run without throwing. This is byte-identical to production
  (`assembleOriginalHarness` replica validated **byte-for-byte on 400 tests**).
- **Way B (native-harness candidate)**: run the assembled harness prefix
  (`runtime shim + includes + assert.js + sta.js [+ doneprintHandle]`) as **native
  JS** in the existing per-test `vm` sandbox (`buildOriginalHarnessSandbox`);
  compile **only the test body** to wasm; instantiate against the
  harness-populated sandbox. Same verdict tail as Way A.

Sample: **252 tests**, 9 strata × 28, evenly sampled (deterministic). Strata are
assigned by priority so each test lands in exactly one bucket:
`negative-parse, negative-runtime, async, verifyProperty-MOP, propertyHelper,
assert.throws, compareArray, Test262Error-explicit, strict-rerun-plain`. Out of
scope (excluded): `raw` (no harness → no boundary), `module`, and the standard
skip-features (Proxy/Temporal/SharedArrayBuffer/…). In-scope corpus ≈ **38,776**.

### The bridge (and a prototype-artifact we had to correct for)

The enabling mechanism is `declared_global` (runtime.ts:13985): an undeclared
identifier in a body-only compile becomes a host import resolved against
`globalSandbox[name]`. So `assert(...)` (a **bare call**) resolves to the natively
executed `sandbox.assert` for free.

**But** a *member* call — `assert.sameValue(...)` — compiles to
`__throw_reference_error("assert")` (member-get on an undeclared global does **not**
consult the sandbox), so a naive body-only compile fails **every** `assert.*` /
`verifyProperty` test with `ReferenceError: assert is not defined` (the raw
prototype flipped **48 %**, mostly this artifact). This is a **plumbing gap of the
prototype**, not a fundamental boundary cost. A real native-harness design would
bind the harness API into body scope with a generated shim; the prototype models
that with a thin preamble (`var assert = globalThis.assert; …`) binding **only the
harness symbols the body references**. That is itself finding #3 below (no shared
script-global scope). All numbers in this doc are **with** the binding shim, so
they reflect *fundamental* boundary artifacts, not the plumbing gap.

---

## 2. Results

### 2.1 Raw stratified sample (over-weights flip-prone strata by design)

| metric | value |
|---|---|
| tested | 252 |
| flips | **71 (28.2 %)** |
| inflating (nonpass→pass) | 40 |
| deflating (pass→nonpass) | 18 |
| neutral (fail↔CE, no score change) | 13 |
| sample pass count | A=124 → B=146 |

### 2.2 Corpus-weighted projection (the honest estimate)

Reweighting each stratum's flip/pass-Δ rate by its true in-scope corpus size:

| metric | corpus projection |
|---|---|
| flips | ≈ 9,244 / 38,776 = **23.8 %** |
| nonpass→pass (inflate) | ≈ 2,994 (7.7 %) |
| pass→nonpass (deflate) | ≈ 3,832 (9.9 %) |
| **NET pass Δ** | **≈ −839 (−2.16 % of in-scope corpus)** |

Per-stratum (flip rate; pass-Δ per test; corpus weight):

| stratum | n | flip/n | passΔ/n | corpus wt | → corpus passΔ |
|---|---|---|---|---|---|
| negative-parse | 28 | 0.00 | 0.000 | 4,055 | 0 |
| negative-runtime | 28 | 0.00 | 0.000 | 29 | 0 |
| async | 28 | 0.07 | +0.071 | 4,937 | +353 |
| verifyProperty-MOP | 28 | 0.64 | +0.357 | 3,701 | +1,322 |
| propertyHelper | 28 | 0.86 | +0.750 | 173 | +130 |
| **assert.throws** | 28 | **0.75** | **−0.429** | **7,383** | **−3,164** |
| compareArray | 28 | 0.11 | 0.000 | 747 | 0 |
| Test262Error-explicit | 28 | 0.07 | 0.000 | 3,150 | 0 |
| strict-rerun-plain | 28 | 0.04 | +0.036 | 14,601 | +521 |

**The verdict is dominated by two facts:** (1) the bulk of the corpus
(`strict-rerun-plain`, 14,601 — plain `assert`/`assert.sameValue` tests) ports
**cleanly** (4 % flip); (2) `assert.throws` (7,383 in-scope, 75 % flip, pure
regression direction) single-handedly makes the net **negative**.

### 2.3 Flip causes (categorized)

**Deflating — pass→fail (boundary noise, destroys real signal):**
- **12/18 error-identity** (all `assert.throws`): the wasm body throws, and the
  native `assert.throws` receives either a raw `WebAssembly.Exception`
  (**5** cases — "Expected a TypeError but got a Exception") or a JS error whose
  `.constructor.name === "TypeError"` but `.constructor !== sandbox.TypeError`
  (**7** cases — "different error constructor with the same name").
- **6/18 MOP/marshaling fidelity**: native `verifyProperty` on a wasm-created
  object reads `obj['m']` as enumerable when spec requires non-enumerable
  (class private methods, ×4); a marshaled wasm array arrives empty in
  `compareArray` (×1); a `null` return marshals as `undefined` (×1).

**Inflating — nonpass→pass (not "compiler improved"):**
- **15** compiled-harness **MOP false-fail** removed (Way A's compiled
  `verifyProperty` crashes/mis-inspects; native reads the object correctly —
  frequently a **host-delegated builtin** like `Array.prototype.slice.length`,
  `BigInt.asIntN.length`, `Date.prototype.getUTCMilliseconds.name`, i.e. it now
  measures **V8**).
- **12** Way-A **compile bug** removed (`propertyHelper` full assembly →
  `compile_error`; body-only compiles → pass — a genuine compile-robustness win).
- **6** compiled-harness **crash** false-fail removed ("Cannot convert null to
  object" inside the compiled `verifyProperty`).
- **7** other (same MOP story).

**Neutral — 13**, all `CE→fail` (Way A can't compile the full assembly; Way B
compiles the smaller body but fails at runtime for a real reason). No score change.

### 2.4 Compile-time win (confirmed, larger than estimated)

| metric | Way A (full assembly) | Way B (body-only) | ratio |
|---|---|---|---|
| sample total compile | 80,596 ms | 16,851 ms | **4.78×** |
| median per-compile | 350 ms | 68 ms | **5.15×** |
| corpus-weighted mean per-compile | — | — | **4.46×** |

This confirms and **exceeds** the review's 250–511 ms vs 59–173 ms (2–4×) estimate.
Host-shard wall-clock is compile-dominated, so ~4.5× on the ~73k host-lane
compiles/run implies host shards from ~9 min → **~2–3 min** at constant shard
count, or **halving** the host shard count at constant wall — combined with L1/L6 a
per-merge total near ~40 shard jobs is plausible (as the review estimated). Note
the **strict-rerun 1.7× multiplier stays**: the body must still compile twice
(sloppy + `"use strict";`); the native harness is strict-neutral and does not help
there.

---

## 3. Root-cause of one representative flip per required class

1. **Test262Error / error cross-boundary identity** (`assert.throws`) — *dominant
   regression.* `assert.throws(TypeError, fn)` runs `fn()` (a wasm closure); when
   it throws, the native `assert.throws` sees a value whose constructor is **not**
   the per-test sandbox's `TypeError` — it is either an un-unwrapped
   `WebAssembly.Exception` or a `TypeError` from the **worker's realm**. In Way A
   this never happens: the harness's `TypeError` and the body's thrown `TypeError`
   are the **same compiled entity**. **Fixability**: partial and expensive —
   requires (a) unwrapping wasm-GC exceptions into JS errors at every wasm→JS catch
   boundary, and (b) constructing every runtime-thrown error from the **sandbox
   realm's** intrinsics. Even done, errors surfacing from host-delegated builtins
   carry the host realm's constructor. This is the single most important cost.

2. **verifyProperty-on-wasm-objects MOP** — native `verifyProperty` inspects a
   class instance's private method `m` and reports the descriptor **enumerable**
   where the spec requires non-enumerable (`obj['m'] descriptor should not be
   enumerable`, pass→fail ×4). The js2wasm JS-host representation of class/private
   members exposes descriptors differently than the compiled harness's own (lossy)
   introspection; the native read is a **different oracle** for wasm-created
   objects — not obviously more correct, and it flips honest Way-A passes to fails.

3. **Script-global sharing** — there is **no shared script-global scope** between
   the natively-run harness and the compiled body. Harness globals (`assert`,
   `Test262Error`, `verifyProperty`) are **not** visible to the body's scope by
   default (member-get on an undeclared global emits `__throw_reference_error`,
   ignoring the sandbox). The prototype had to **synthesize a binding shim**; a real
   design must generate one. Harness `var`s the body mutates (and body globals the
   harness reads) do **not** live in one realm. Representative: **without** the
   shim, *every* `assert.*`/`verifyProperty` test CE's with "assert is not defined"
   (the raw 48 %-flip run).

4. **Strict-rerun handling** — the split model still compiles the **body twice**
   (sloppy + `"use strict";` prepended); the native harness is strict-neutral, so
   it saves **only** the harness bytes, not the rerun. The 1.7× multiplier is
   unchanged. `strict-rerun-plain` is the cleanest stratum (4 % flip) precisely
   because plain `assert`-based bodies carry no cross-boundary objects.

---

## 4. Oracle-v9 / `ORACLE_REBASE` cost

This is a **verdict-policy change**, not a tightening of `classifyError`. It flips
thousands of rows in **both** directions:

- Requires `ORACLE_VERSION` 8→9, a single `ORACLE_REBASE=1` landing, and a
  `promote-baseline` force-refresh (per `tests/test262-oracle-version.ts` header).
- It is **host-lane only**. The standalone lane cannot host-execute the harness
  (oracle v6 / #2961 rejects host imports by definition). So the two lanes would
  **measure different things** and their baselines **diverge** — breaking the
  current single-`ORACLE_VERSION` cross-lane coherence. A reader could no longer
  compare host vs standalone pass rates as "the same test suite."
- Because it changes **what a verdict measures** (native-harness-over-host-builtins
  vs compiled-harness), it is exactly the class of change the #3433 roadmap flagged
  as needing a deliberate lane-owner + stakeholder sign-off, not a perf tweak.

---

## 5. Explicit answers to the brief's questions

- **How many verdicts flip?** ≈ **24 % of the in-scope corpus** (corpus-weighted;
  ~28 % on the flip-weighted stratified sample). ~7.7 % inflate, ~9.9 % deflate.
- **Are they boundary artifacts or real?** **Overwhelmingly boundary artifacts.**
  The pass→fail half is entirely error-identity + MOP/marshaling fidelity (no real
  compiler signal). The nonpass→pass half is compiled-harness-false-fail removal +
  host-delegated-builtin dilution + compile-robustness — **not** compiler
  conformance gains. Net pass Δ ≈ **−839** (a regression) as-is.
- **Is the ~2–4× win worth the rebase + honesty cost?** The win is actually
  **~4.5×** (bigger than estimated), but **no** — not as a verdict oracle. It would
  drop ~839 net passes, replace honest signal with boundary noise across ~24 % of
  the suite, dilute the host lane toward measuring V8, and permanently split the two
  lanes' oracle. The dominant regression (error-identity) is only partially fixable
  and only at substantial runtime cost that does **not** restore the honesty
  dilution.

## 6. Recommendation & sequencing

1. **NO-BUILD** the native-harness verdict oracle now.
2. Take the CI throughput from **L1** (promote push:main baseline from the
   merge_group's own artifacts — zero honesty cost; issue #3448) and **L6** (mg
   shard-constant re-derivation). These deliver the queue win without touching the
   oracle. #3374 already banked ~2.6–3.8× of per-compile cost honestly.
3. Pursue the **honest structural dedup** via **L4 / #1046** — a separately
   compiled, linked harness `.wasm`. It keeps the harness **in wasm** (no boundary,
   no error-identity/MOP artifacts, no honesty change, works for **both** lanes)
   and collapses ~73k prelude codegens to ~10² prelude compiles + ~73k body-only
   compiles. That is the principled version of this idea.
4. Revisit native harness **only** if, after L1/L6, host-lane *compile* is still
   the binding constraint, **and** realm-aware error construction + wasm-exception
   unwrapping land first (to kill the −3,164 `assert.throws` regression), **and**
   the stakeholder explicitly accepts host-delegated-builtin dilution of the host
   lane's conformance meaning.

## Appendix: reproduction

Throwaway spike (gitignored `.tmp/spike-3450/`, in the shared checkout):
`harness-lib.mjs` (byte-validated `assembleOriginalHarness`/`parseMeta` replica),
`native-harness-worker.mjs` (patched real worker: `+harnessPrefix` native-exec
mode), `driver.mjs` (`PER_STRATUM=28` A/B driver + binding-shim model),
`analyze.mjs` (flip categorizer). Run:
`PER_STRATUM=28 node --experimental-strip-types .tmp/spike-3450/driver.mjs`.
Compiler/runtime bundles built from the tree at spike time; test262 submodule
checked out. Numbers are one deterministic run on darwin/M-series; absolute ms are
machine-relative, ratios and flip categories are the load-bearing outputs.
