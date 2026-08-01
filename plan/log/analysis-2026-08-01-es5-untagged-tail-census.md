# ES5 + untagged standalone tail census (2026-08-01)

**Produced by** `L-tail`. **Landed by** the tech lead — the authoring subagent was
blocked by a harness guard from writing report `.md` files, so the content was
returned as text and committed here verbatim in substance.

> **Headline: 100 % is not reachable on this scope without `eval`/`Function` and
> `with`. The measured ceiling excluding dynamic code is 95.4 %, and that is an
> UPPER BOUND** — it assumes every non-dynamic failure is fixable, which this
> census does not establish (202 files are unpriced).

## Provenance — quote this with every number taken from here

| | |
| --- | --- |
| Baselines repo commit | `d8c30f3b7df0` (2026-08-01T17:14:04Z) |
| js2 `main` SHA scored | `bc54c09daf2d1b2000c3961e3c89914544affdd6` |
| Standalone row timestamps | `1.8.2026, 19:01:54` → `19:07:32` (UTC+2) |
| `oracle_version` | 12, lane `honest` |

**A census without this stamp is unusable within a day.** The stale-vs-fresh delta
measured today was **2,541 → 2,369 non-pass — 172 files (7 %) in 16 hours.**
Re-cut before acting on anything older than ~a day; see
`.claude/memory` note on the cached baseline being a snapshot, not a feed.

### Instrument validation (run BEFORE any claim below)

48,088 rows / 0 bad JSON / 0 duplicate `file` keys. `scope_official === true`
→ **43,106**, pass **25,755 (59.7 %)**. Goal scope **8,545 run / 6,176 pass
(72.3 %) / 2,369 non-pass**. **0 corpus files failed to open** — floored and
printed. 16 KB frontmatter window, 0 truncated.

Positive control, both directions: `S8.5_A1.js` {es5id} = in ✓ ·
`15.2.3.6-1-1.js` {es5id} = in ✓ · `Symbol.toStringTag.js` {es6id} = out ✓ ·
`Proxy/apply/call-parameters.js` {esid} = out ✓.

Denominator audit — the id-key histogram sums to 43,106:
`esid 31571 · es5id 7690 · es6id 2449 · es6id+esid 541 · es5id+esid 391 ·
<none> 430 · es5id+es6id 17 · es5id+es6id+esid 17`.
Goal scope = 7690 + 391 + 17 + 17 + 430 = **8,545**.

## Six refutations of the framing this census was commissioned under

1. **"1,532 uncharacterised" was a COMPLEMENT, and it was wrong.** Cross-tabbing
   the two coverages: BOTH 808 · signature-only 230 · path-lever-only 688 ·
   **NEITHER 815** · sum 2,541 ✓. The named path levers cover 688 files the
   top-22 signatures never touch. The honest figure was 815, not 1,532 — and
   with a real mechanism classifier on fresh data it is **202**.
2. **Named lever counts OVERLAP and must never be summed.** Gross 1,561 vs. net
   partition 1,496 on stale data (65 double-counted; 44 `Function/prototype`
   files were actually runtime-eval failures). Fresh: gross 1,416, net 1,355.
3. **The `js2wasm:runtime-eval` bucket did NOT go to zero in goal scope.** The
   *link* failure is gone, but the same files now throw a refusal whose text
   still contains `js2wasm:runtime-eval`, so a naive regex re-matches all 118 and
   reports the old bucket intact. Fresh goal scope: 101 + 26 + 17 = **144
   dynamic-code refusals**. This is "a vanished bucket usually MOVED", one level
   deeper — the *string* survived the fix.
4. **`with` and compound-assignment are ONE mechanism, and a path filter misses
   most of it.** `language/expressions/compound-assignment/S11.13.2_A5.*`
   (45 files) fail *inside* a `with` block. By body, `with` reaches **175**
   files; by path only **106**.
5. **The descriptor lever is mis-framed as a standalone-substrate problem.**
   **508 of 795 (64 %) also fail in the HOST lane; 379 with a byte-identical
   assertion.** Sizing #2992/#3251 as "unlocks the descriptor family" overstates
   it **~2.8×**.
6. **The ES5 census in the `es5-standalone-90pct` issue uses a DIFFERENT
   denominator** (`classifyEdition() === 5`, 8,931) from the goal scope
   (`es5id` or untagged, 8,545). The percentages are not interchangeable.

Also confirmed as predicted: the 42-file `'this' had incorrect value!` family is
**≥3 mechanisms** — `10.4.3-1-11gs` strict `this` = undefined; `-99gs` `bind`
receiver vs global identity; `-60gs` accessor receiver installed by
`defineProperty`.

## The census — 2,369 files, 2,167 named (91.5 %), 202 unexplained (8.5 %)

Ordered, first-match-wins partition, verified to sum. Tier 1 = the compiler names
the mechanism (conclusive) · Tier 2 = subject matter read from the body ·
Tier 3 = crash class · Tier 4 = explicitly unclassified.

| Mechanism | Files | SA-only | Both lanes |
| --- | ---: | ---: | ---: |
| **Property-descriptor MOP** (attributes + accessors not first-class) | **795** | 287 (36 %) | 508 |
| *(unclassified)* | **202** | 70 | 132 |
| `with`-statement scope object | **173** | 6 (3 %) | 167 |
| Dynamic-code refusal (`eval`/`Function`) — T1 | **144** | 63 | 81 |
| Strict-mode `this` / receiver identity | **119** | 8 (7 %) | 111 |
| `String.prototype` methods | **104** | 69 (66 %) | 35 |
| `instanceof` / error-ctor identity | **95** | 33 | 62 |
| Prototype-chain / `constructor` identity | **93** | 62 (67 %) | 31 |
| Explicit "not supported in standalone" refusal — T1 | **77** | 57 (74 %) | 20 |
| Compound assignment / inc-dec | **77** | 22 | 55 |
| Property attributes on BUILT-IN objects | **73** | 64 (88 %) | 9 |
| RegExp engine semantics | **68** | 39 | 29 |
| Host-import leak — T1 | **63** | 39 | 24 |
| `arguments` object (incl. `callee`/`caller`) | **59** | 8 (14 %) | 51 |
| Extensibility / integrity MOP | **50** | 48 (96 %) | 2 |
| Descriptor-shape refusal (#1906 fail-loud) — T1 | **49** | 16 | 33 |
| `Array` length/index exotic | **22** | 2 | 20 |
| RegExp unsupported pattern/arity — T1 | **21** | 16 | 5 |
| Crash: null deref | **17** | 10 | 7 |
| `delete` operator | **14** | 7 | 7 |
| for-in enumeration | **13** | 8 | 5 |
| Compile timeout — T1 | **11** | 7 | 4 |
| Crash: illegal cast | **10** | 9 | 1 |
| Own-key enumeration MOP | **9** | 5 | 4 |
| Crash: OOB 6 · internal 3 · TypedArray 1 · invalid Wasm 1 | **11** | 1 | 10 |
| **TOTAL** | **2,369** | 956 | 1,411 |

Partition check: 2,167 + 202 = 2,369 ✓. Two files are absent from the host
baseline entirely and are tracked as their own third-lane category, never folded
in silently.

> **The single most actionable fact: 1,411 of 2,369 (59.6 %) of this
> *standalone* gap is NOT standalone-specific — the host lane fails it too.**
> Most of this work pays into ES5 conformance generally, not into the standalone
> lane alone.

## Descriptor family — 795 is a SUBSTRATE, not a defect

Control that the both-lanes finding is real: across all 2,393 host rows in the
four descriptor directories the host lane passes **1,702 (71.1 %)** — it
demonstrably *can* pass these.

Receiver × failure-class grid sums to 795 ✓. Marginals:

- **Receiver**: plain object literal 305 · Array-via-var 179 · variable/plain 110
  · built-in prototype 66 · other-init 36 · unresolvable 33 · `arguments` 29 ·
  Function object 20 · wrapper instance 17
- **Failure class**: wrong value 544 · descriptor attributes wrong 115 ·
  missing `TypeError` 68 · property absent/not-own 45 · wasm crash 11 ·
  engine TypeError 5 · other 7

Sub-clustered on the test262 `description:` field — a far better mechanism proxy
than the error string:

| Sub-mechanism | Files | SA-only |
| --- | ---: | ---: |
| S1 descriptor field read via `[[Get]]` on a user descriptor object | 156 | 62 |
| S3 attribute enforcement on an **Array** (index/`length` exotic) | 127 | 9 |
| S2 descriptor field type coercion | 93 | 30 |
| S4 attribute enforcement on **`arguments`** | 53 | 33 |
| S5 attribute enforcement on **Function/built-in** | 51 | 0 |
| S9 enumerability / own-key ordering | 38 | 19 |
| S8/S7/S6 creation / update / validation | 38 | 18 |
| **S0 unmatched** | **239** | 116 |

⚠ **Honesty flag: the S-rules are keyword rules over prose and they leak.**
S0 = 239 is large, and spot-reading shows S6/S7 misassignment. **Size work from
the mechanical receiver × failure grid, not from the S-table.**

Three files that all land in "plain object literal / wrong value" are three
*different* defects — proof that even this grid is a proxy:
`Object/create/15.2.3.5-4-157.js` (the descriptor object's own `value` is an
inherited accessor, so descriptor fields must be read via `[[Get]]`) ·
`Object/defineProperty/15.2.3.6-4-280.js` (Array receiver attribute enforcement) ·
`Object/create/15.2.3.5-4-315.js` (accessor properties via the `create`
properties bag).

## Two overlays — NOT buckets; they overlap the partition

**A. "Engine did not throw where the spec requires": 155 (6.5 %)** — 70 SA-only /
85 both-lanes. Spread: descriptor 71 · unclassified 46 · `arguments` 17 ·
strict-`this` 7 · `with` 4 · other 10. Control: the detector says NO to 2,214
rows, so it is not vacuous. This is a coherent **error-model programme** cutting
across five mechanisms — not a sixth mechanism.

**B. "Built-in static/prototype property is not an OWN property": 30, all 30
standalone-only.** The smallest clean win in the census.

## Decline-by-dependency, and the ceiling

Body partition, sums to 2,369 ✓: `eval`/`Function` only 220 · `with` only 162 ·
both 13 · neither 1,974 → **395 dynamic-code-dependent (16.7 %)**, of which
**144 are conclusively refused by the engine** and 251 died of something else
first (so they are *not* necessarily gated on eval).

**Non-circularity control:** the same detector run over the 6,176 goal-scope
**passes** finds **248 files that use `eval`/`with`/`Function` and pass anyway**
(0 unopenable). Dynamic code is not automatically fatal.

> **Ceiling without dynamic code = (6,176 + 1,974) / 8,545 = 95.4 %.**
> UPPER BOUND ONLY — it assumes every non-dynamic failure is fixable, which this
> census does not establish. **100 % is unreachable without `eval` and `with`.**
> 317 files (13.4 %) are decline-by-dependency on #2928 and #1387/#671 and
> should be excluded from any tail plan.

## The honest remainder: 202 files nobody can yet name

Areas (**areas, not mechanisms**): `language/expressions` 42 ·
`built-ins/Function` 28 · `language/statements` 26 · `built-ins/Array` 19 ·
`language/function-code` 15 · `built-ins/Number` 15 · `built-ins/Object` 13 ·
`language/eval-code` 11 · rest singletons.

The signature distribution is **flat** — the largest group is 16
(`Expected SameValue(«…», «…») to be true`, which carries zero information),
then 13, then 7. Visible but sub-threshold themes: missing throws (46, already
counted in Overlay A) · `Function.prototype.toString` output shape (4) ·
built-in `hasOwnProperty` (9, Overlay B) · `Number`/`Boolean`/`Error` prototype
`toString`/`valueOf` (~10).

**Pricing these needs individual reading — roughly a day. Diffuse usually means
expensive per file, not cheap.**

## Dispatch table

**File counts are POPULATIONS, not flip ceilings.** The measured reference point
is 103 reachable gated → 34 flipped (33 %). Expect a similar discount.

| # | Work | Population | Lane | Character |
| --- | --- | ---: | --- | --- |
| 1 | Shared object model: attributes + accessors first-class | 508 of 795 | **both lanes** | Expensive; pays into ES5 host *and* standalone. NOT the standalone MOP substrate. |
| 2 | Standalone exotic-receiver MOP (#2992/#3251) | ≤287 of 795 | SA-only | Real, but **2.8× smaller than advertised**. |
| 3 | Descriptor S1 — fields read via `[[Get]]` | 156 | mixed | Self-contained first slice of #1. |
| 4 | Descriptor S3 — Array index/`length` enforcement | 127 | **118 both-lanes** | Shared defect; cheap relative to substrate work. |
| 5 | Strict `this` / receiver identity | 119 | 111 both-lanes | Front-end. **Split first — ≥3 mechanisms.** |
| 6 | `String.prototype` methods | 104 | 69 SA-only | Conventional built-in work. |
| 7 | Error model — throw where the spec requires | 155 (overlay) | 70 SA-only | Cross-cutting; partly closes #1, `arguments`, and the tail. |
| 8 | Prototype-chain / `constructor` identity | 93 | 62 SA-only | |
| 9 | Extensibility/integrity MOP on built-ins | 50 | **48 SA-only** | Clean. `Object.isExtensible(Array.prototype)`, `isSealed(Error.prototype)` — built-ins lack an `[[Extensible]]` slot. |
| 10 | Built-in props as real own properties (Overlay B) | 30 | **30 SA-only** | Smallest clean win. |
| — | **Do not schedule**: dynamic-code (144) + `with` (173) | 317 | | ⚠ **See the correction below — these are TWO separate blockers, not one.** |
| — | **Unpriced**: unclassified tail | 202 | 70 SA-only | Needs individual reading. |

## Tooling note for the next census

`claim-issue.mjs` exits **6** with "Author identity unknown" unless
`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_*` are **exported** — a
worktree-local `git config user.email` is not enough. `CLAIM_ASSIGN_REMOTE=upstream`
is required in this checkout because `origin` is the fork.

The classifier scripts (~40 lines each, reusable) were left in the authoring
agent's worktree under `.tmp/`: row/pass validation, scope classifier with
controls and a miss floor, body-shape features, host-lane join, dependency
partition with the non-circularity control, the ordered mechanism classifier,
descriptor decomposition, lane controls, and the overlays/ceiling computation.

---

## ⚠ CORRECTION (2026-08-01, later the same day) — `with` is NOT blocked on eval

Measured by `L-strwith` **by body**, on both fresh baselines (standalone
43,106/25,755; host 43,489/30,581 @21:13), 0 corpus files unreadable, detector
carrying one positive control (`statements/with/12.10-0-1.js`) and two negative
controls (`String.prototype.startsWith`, `Array.prototype.with` — a naive
`with\s*\(` regex false-positives on both).

**The table above files `with` under "Blocked on #2928, #1387/#671", which reads
as "blocked on eval". That is wrong.** Only **13 of 175** `with` files are also
eval/Function-dependent. **162 are attributable to `with` alone.**

**So the decision is TWO investments, not one:**

| | files | needs |
| --- | ---: | --- |
| eval / `Function` (#2928) | ~144 | real eval capability — the Acorn interpreter provider, minutes to compile, currently unaffordable per shard. A packaging/perf problem (#2527) as much as semantics. |
| object environment records with first-class Reference identity | ~162 | a **front-end substrate**, on the same footing as the 795-file descriptor MOP |

Funding the first does **not** deliver the second.

**Why the second is genuinely a substrate — probed, not inferred.** Plain
`with (scope) { out = x; }` **already works** in standalone (returns 42,
correct), so `with` is neither refused wholesale nor a no-op — which is what
"blocked" implied on first read. The largest sub-mechanism is **45 files**
(`scope.x === N. Actual: NaN` 30 + `innerScope.x === N` 15), all
`compound-assignment/S11.13.2_A5.*`; their bodies assert that **PutValue uses the
initially-created Reference even after a getter side effect deletes the
binding**, with the surrounding function environment record unchanged. A partial
`with` cannot pass those — they are precisely the tests that distinguish a
shortcut from a real environment record.

**The by-path undercount, confirming §4 of the refutations above:**

| cut | run | non-pass |
| --- | ---: | ---: |
| by path (`language/statements/with/`) | 146 | **107** |
| by **body** | 217 | **175** |

A directory census undercounts by **39 % — 68 files**, living in
`compound-assignment` (33), `statements/function` (12), prefix/postfix inc-dec
(12), `identifier-resolution` (3), `assignment` (2), `try` (1).

**168 of 175 also fail in the HOST lane** (7 standalone-only) — matching this
census's 173/6/167 within rounding. This is a shared front-end defect, not
standalone codegen.

**Recommendation (unchanged in direction, corrected in basis): do not fund `with`
as a conformance lever.** 175 files for an environment-record substrate is a
worse ratio than the descriptor MOP, and 96 % of it also fails in host — so if it
is ever funded it should be scoped as shared front-end scope-analysis work owned
by whoever owns environment records, not as a standalone-gap item.

**Split out separately:** the **16 `null_deref` crashes** inside the 175 (13 of
them `__str_concat` ← `__module_init`). A crash is not a semantics gap, and this
may be the same compile-stage family as the 15 `String/prototype` `_A10` files.

Remaining shape of the 175 (49 distinct normalised signatures, so a long tail):
45 Reference/PutValue identity · 15 an explicit refusal (*"with statement
requires a proven closed object-literal shape before codegen"*) · 16 `null_deref`
· ~10 `p1 === null` binding resolution · 5 "Scope chain disturbed" · rest tail.

**The ceiling of 95.4 % is UNCHANGED.** What changed is that reaching it requires
two funded programmes rather than one.
