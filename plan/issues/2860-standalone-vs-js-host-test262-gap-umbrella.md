---
id: 2860
title: "Umbrella: close the standalone-vs-js-host test262 gap (~20,500 host-free, honest metric #2879/#2360)"
status: in-progress
created: 2026-06-30
updated: 2026-07-23
priority: high
feasibility: hard
model: fable
fable_role: spec
task_type: epic
area: codegen
goal: standalone
sprint: current
horizon: xl
assignee: ttraenkler/fable-2860
related:
  [
    2861,
    2862,
    2863,
    2864,
    2865,
    2866,
    2867,
    2868,
    2872,
    2873,
    2874,
    2875,
    2876,
    2877,
    2878,
    2879,
    3027,
    3169,
    3170,
    3171,
    3172,
    3173,
    3174,
    3175,
    3176,
    3177,
    3535,
  ]
---

# Umbrella: close the standalone-vs-js-host test262 gap

> **THE SPRINT FOCUS (stakeholder directive, 2026-06-30).** Closing the
> standalone-vs-js-host gap is the top priority for the current budget window.
> Every child issue here is `priority: high` + `sprint: current` and sorts to
> the TOP of the auto-synced TaskList. Non-standalone `sprint: current` work
> (acorn remnants #2850/#2853, IR-migration #2855–#2859, and the other ES/spec
> umbrellas #2669/#2803/#1042) is demoted to `priority: low` — kept claimable
> as tail-filler but sorting under the standalone work.

## The gap (honest metric, #2879 via #2360)

The metric was made **honest** in #2879/#2360: a standalone pass is only
credited when it is **host-free** (no leaked host imports), not when a leaky
binary is host-satisfied. On the honest metric:

- **js-host** passes **~34,052** official tests.
- **host-free standalone** passes **~12,883**.
- The honest **standalone gap is ~20,500 tests** — roughly double the earlier
  ~9,177 figure, which counted host-satisfied leaky passes as standalone wins.

The gap decomposes into two halves:

1. **The carriers (~architecture-scale half).** Whole language features that
   leak host imports because there is no Wasm-native carrier yet:
   generators **#2864** (697), async-generators **#2865** (986), Promise/
   microtask **#2867** (375), Symbol **#2866** (418). These are the biggest
   single lever and warrant an architect frame-substrate design pass.
2. **The substrate + de-masked real-failure clusters (the other half).** The
   dynamic-object substrate, the proto-glue / CE clusters (**#2861** remaining,
   **#2863**), and the de-masked real-failure clusters that surfaced once the
   metric stopped masking them behind #2862: TypedArray **#2872** (294),
   language/expressions **#2873** (276), String **#2875** (159), RegExp
   **#2876** (125), tooling/triage **#2877**, plus the invalid-Wasm residual
   **#2878**.

Measured 2026-06-30 from the two lane baselines in `loopdive/js2wasm-baselines`
(`test262-current.jsonl` vs `test262-standalone-current.jsonl`, official-scope,
matched by file+strict). The standalone baseline tags each row with
`host_import_leak_class` and the leaked `imports` set, which drives the
clustering below. (The legacy per-cluster counts in the table below are from
the pre-honest measure and are kept as the relative root-cause breakdown; the
absolute total is now ~20,500 per the honest metric.)

## Clusters (by root cause → est. tests → issue)

Counts are **overlapping** for the cross-cutting substrate signatures (a test
can leak a host import AND fail at ToPrimitive); the "pure" column is the count
where that cluster is the sole blocker (no host-import leak), i.e. the count a
single fix flips directly.

| #   | Cluster                                                                               | total | pure | tractability                     | issue                            |
| --- | ------------------------------------------------------------------------------------- | ----- | ---- | -------------------------------- | -------------------------------- |
| 1   | built-in static/proto value read refused (CE)                                         | 882   | 882  | mechanical (glue pattern)        | **2861 — done**                  |
| 2   | ToPrimitive over built-in exotics + inherited valueOf/toString                        | 2,039 | 728  | medium (extend `__to_primitive`) | **2862 — wont-fix (superseded)** |
| 3   | dynamic-shape object/property codegen (`__get_builtin`, `__extern_toLocaleString`) CE | 365   | 365  | medium codegen                   | **2863 — done**                  |
| 4   | sync generators — no standalone carrier (`__gen_*`/`__create_generator`)              | 697   | —    | hard (new carrier)               | **2864 — in-progress**           |
| 5   | async generators — no standalone carrier (`__create_async_generator`)                 | 986   | —    | hard (dep #2864)                 | **2865 — in-progress**           |
| 6   | Symbol — standalone carrier (`__box_symbol`)                                          | 418   | —    | medium-hard                      | **2866 — in-progress**           |
| 7   | Promise / async microtask — standalone carrier (`Promise_*`, `__make_callback`)       | 375   | —    | hard                             | **2867 — in-progress**           |
| 8   | invalid Wasm binary emitted in standalone (correctness)                               | 523   | 118  | triage-then-fix                  | **2868 — done**                  |

### Not-yet-issued follow-ons (tracked here)

**Groomed 2026-07-16 (PO pass): every bullet below now has an owning issue —
none of this section is actually un-issued anymore.** $Object reader → #3027
(done); TypedArray internals → #3177 (ready); gOPD 124 → MOP lineage #2884/
#2885/#2896/#2965 (done), #2984/#2992 (in-progress), #2874/#3250 (done);
eval/Function → #3005 (done) / #3017 (ready); spread/`Array.from(iter,n)`
~321 → #2904/#2995/#3206/#3100 (all done); namespace static reads ~120 →
#2933 (ready); illegal-cast → folded into #2863/#2868 (both done); null-deref
`__str_flatten`/RegExp ~185 → #2935 (ready). This umbrella is fully groomed —
no new child issues needed; #3178 (the generator/async/Promise host-machinery
deep-dive within cluster rows 4/5/7 above) is the one active sub-umbrella
still carving new slices (see #3178 itself, and #3302 spun from it).

- **$Object dynamic-object-property reader** — **[#3027](3027-standalone-dynamic-object-property-reader-residual.md)
  is `done` (2026-07-05)**, superseding this note. Re-measurement found the
  originally-hypothesized root cause
  (`project_standalone_any_string_value_read_substrate`, the dynamic `any`
  reader dropping native-string VALUES) was already fixed by #2861/#2863 — it
  is NOT why the residual read 1,552. That residual is a **heterogeneous
  long tail**, not one root cause: TypedArray(Constructors) internals/
  prototype (~350), `Temporal` (~230+, a whole deferred feature area, not a
  codegen bug), `Object.getOwnPropertyDescriptor` (124, itself 3 unrelated
  shapes — built-in/global descriptors, `ToPropertyKey` coercion, array-
  element descriptors), the already-tracked eval/Function-shim gaps
  (#3005/#3017), and many smaller one-off gaps. #3027 fixed the one
  genuinely-addressable codegen bug found during the trace (computed/
  bracket string property+method access never dispatching to the native
  string engine in `--nativeStrings` mode — ~5-9 tests) and recommends the
  PO/tech-lead triage the remaining clusters into separately-sized follow-on
  issues (TypedArray internals, ~350, is the next-largest single slice).
- **spread / `Array.from(iter, n)`** (`__array_from_iter_n`) — ~321 tests.
  Depends on the iterator-protocol carrier (#2864).
- **Namespace static reads** (`Math.PI`, `JSON.stringify`, `Reflect.get`,
  `Atomics.add`) — ~120 tests. Split out of #2861 (different mechanism: not
  `.prototype` proto-glue). Updated 2026-07-02 (#2861 closed; #2863 remeasure):
  namespace static **data constants** (`Math.PI`/`E`/`LN2`,
  `Number.MAX_SAFE_INTEGER`) now fold, and static-method **calls**
  (`Math.max(…)`, `JSON.stringify(…)`) compile. The live residual is
  static-method **value reads** (`const f = JSON.stringify; f(x)`,
  `Math.max` as a value — the #1907/#1888 S6-b refusal) plus reflective
  correctness bugs (`Math[computedKey]` → 0, `globalThis.Math.PI` traps).
- **illegal cast** — 1,177 total but only ~102 pure; the rest are inside the
  generator/iterator machinery and clear when #2864/#2865 land. The ~102 pure
  ref.test-before-cast misses fold into #2863/#2868 triage.
- **null deref in `__str_flatten`/RegExp** — ~185, mostly `String.prototype.split`
  with a RegExp arg + RegExp character-class escapes; standalone-native string/regex
  bug. File separately if it doesn't clear with #2863.

## Sequencing (carriers are the biggest lever)

**Carrier track (architecture-scale — the dominant lever, ~2,476 combined).**
The carriers share a common need: a Wasm-native suspendable-**frame substrate**
(the arch-frame design). Build that once, then layer the carriers on it:

1. **Frame substrate** — the suspendable activation-frame ABI shared by
   generators, async-generators and the Promise/microtask scheduler. Architect
   frame-substrate spec lives in **#2860 / #2864** (`architect_spec: candidate`).
2. **#2864** sync generator carrier (697) — first carrier on the frame; proves
   the substrate end-to-end.
3. **#2867** Promise / microtask carrier (375) — the microtask scheduler the
   async machinery needs; independent enough to land in parallel once the frame
   exists.
4. **#2865** async-generator / for-await carrier (986) — composes the generator
   frame (#2864) with the microtask scheduler (#2867); `depends_on: [2864, 2867]`.

**#2866** Symbol carrier (418) is independent of the frame substrate and can run
in parallel on its own track.

**Substrate + cluster track (runs in parallel with carriers).**

5. **#2861** built-in static/proto value-read glue (mechanical, ~882 remaining) —
   dev-standalone, start now.
6. **#2863** dynamic-shape `__get_builtin` / reflective read codegen.
7. **#2878** invalid-Wasm residual (`__str_flatten` + user-body shapes) — broken
   binaries are worst-class correctness; follows the #2868 URI-carrier fix.
8. De-masked real-failure clusters (surfaced once the honest metric stopped
   masking them behind #2862): **#2872** TypedArray (294), **#2873**
   language/expressions (276), **#2875** String (159), **#2876** RegExp (125).
9. **#2877** standalone exception message readability — tooling/triage enabler
   (lower lever; unblocks message-level triage of the residual).

**Done / blocked children (no longer queued):**

- **#2868** invalid-Wasm emission (URI/str_flatten carrier) — **done** (via #2350).
- **#2874** getOwnPropertyDescriptor numeric-key coercion — **done** (via #2354).
- **#2879** honest host-free metric — **done** (via #2360); this is what
  re-based the gap to ~20,500.
- **#2862** ToPrimitive over built-in exotics — **blocked** (superseded; the
  de-masked clusters #2872/#2873/#2875/#2876 carry the tractable residual).

## 2026-07-12 groom — fresh method-family slices (PO, lane-baseline remeasure)

Remeasured from the two lane baselines (fetched 2026-07-12): the honest gap
(host `pass` ∧ standalone NOT host-free pass, official scope, file+strict
match) is **12,801** rows. After mapping every existing sub-front, nine
genuinely-uncovered method-family clusters were sliced (all `sprint: current`,
`priority: high`, `umbrella: 2860`):

| issue    | cluster                                                                    |                   measured gap | horizon |
| -------- | -------------------------------------------------------------------------- | -----------------------------: | ------- |
| **3169** | Array.prototype callback HOFs over array-like receivers                    |                            519 | l       |
| **3170** | Array.prototype indexOf/lastIndexOf/includes as-value + array-likes        |                            125 | m       |
| **3171** | Map/Set/WeakMap/WeakSet receiver brand-check protocol                      | ~142 (+ share of 113 residual) | m       |
| **3172** | Set-algebra set-like protocol + getOrInsert(Computed)                      |                            120 | m       |
| **3173** | DataView.prototype get\*/set\* spec semantics                              |                            230 | l       |
| **3174** | Date brand checks + ToPrimitive coercion order                             |                            107 | m       |
| **3175** | Number.prototype toString(radix)/toFixed/valueOf                           |                             74 | m       |
| **3176** | JSON.parse/stringify residual (reviver array walk, strictness)             |                             67 | m       |
| **3177** | TypedArrayConstructors internals + ctor protocols (the #3027 "~350" slice) |                            356 | l       |

Deliberately NOT sliced (covered or in-flight): `Object/defineProperty(-ies)`

- `Object/create` (492 — routes through the in-progress #2992 defineProperties
  MOP + #2984 lane), `Object` statics order/spread (#3155 ready),
  `Function.prototype.bind` residual (63 — fnctor lane #3138/#3139),
  `Array/fromAsync` (#2967 blocked on #3134), Atomics (#3145),
  `Iterator.*` (#3146/#3049), DisposableStack (needs the #2866 Symbol carrier),
  `language/*` (carriers #2864/#2865/#2867 + #2873), annexB residual (~180,
  follow-on candidate after #3069's pattern).

## Definition of done (umbrella)

Standalone official_pass climbs from 24,656 toward the 33,032 host figure.
Each child issue's test plan = its cluster's standalone-CE/fail tests flip to
pass under full `merge_group` + the standalone high-water floor
(`check-standalone-highwater.mjs`), with zero host-mode regression (all changes
`ctx.standalone`-gated).

## 2026-07-18 re-measurement (fable-dev-4) — the gap HALVED; the frontier SHIFTED

Fresh honest re-measure from tonight's promoted lane baselines
(`test262-standalone-current.jsonl` @ 2026-07-18 01:08Z vs `test262-current.jsonl`,
official scope, matched by `file|strict`):

| metric                                       | 2026-06-30 | 2026-07-12 | **2026-07-18** |
| -------------------------------------------- | ---------: | ---------: | -------------: |
| host-free standalone official pass           |     12,883 |     ~13.0k |     **24,726** |
| honest gap (host pass ∧ standalone not-pass) |    ~20,500 |     12,801 |      **8,228** |

The carrier + method-family work (#3132/#3164/#3302/#3386, #3169–#3177, #3173/#3181,
#2861/#2863/#2868, …) landed a **~12k-row swing**. The gap is now **8,228**.

### The structural shift: `assertion_fail` now DOMINATES `host_import_leak`

Break the 8,228 gap by `error_category` (from the standalone JSONL rows):

| error_category                                 |      rows | note                                                                        |
| ---------------------------------------------- | --------: | --------------------------------------------------------------------------- |
| **assertion_fail**                             | **4,079** | host-free binary, WRONG runtime value — the new frontier                    |
| host_import_leak                               |     2,991 | of which `iterator_protocol` = 2,309 → **#3178** sub-umbrella (#3386–#3391) |
| type_error                                     |       677 | standalone throws / mis-throws TypeError                                    |
| other                                          |       180 |                                                                             |
| illegal_cast                                   |       112 | ref.test-before-cast misses (fold into #2863/#2868 triage)                  |
| null_deref                                     |        66 | mostly `__str_flatten`/RegExp (#2935)                                       |
| wasm_compile                                   |        58 | invalid binary residual (#2878/#3024)                                       |
| runtime_error / oob / syntax / range / promise |        65 | long tail                                                                   |

**Read this:** the carriers largely WORKED — `host_import_leak` (2,991, and
2,309 of it is the already-carved #3178 generator/iterator territory) is no
longer the dominant blocker. The new #1 lever is **`assertion_fail` (4,079):
tests that compile host-free in standalone but compute the WRONG VALUE at
runtime** — standalone-lane runtime _semantic fidelity_, not carrier existence.

### assertion_fail (4,079) cluster → owning-issue map (coverage is ~complete)

Bucketed by test family; every material cluster already has an owner — the
counts are LARGER than each issue's original estimate (scope grew as the metric
de-masked runtime failures), so this is a **re-scope + re-prioritise** signal,
not a new-issue signal:

| cluster (assertion_fail rows)                                                                                               | owner                                                | status      | orig. est → now   |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------- | ----------------- |
| Object/defineProperty+defineProperties (389)                                                                                | #3022 (default, done) · #2984/#2992 (standalone MOP) | in-progress | 728 → 389 std     |
| TypedArray/prototype (532)                                                                                                  | **#2872**                                            | in-progress | 294 → **532**     |
| Array/prototype (418)                                                                                                       | #3180 (std HOF) · #3185 (default generics)           | ready       | ~300 → 418        |
| String/prototype (282)                                                                                                      | **#2875**                                            | in-progress | 159 → **282**     |
| language/expressions+statements (580)                                                                                       | #2873 + carriers                                     | mixed       | —                 |
| RegExp (223)                                                                                                                | #2876 · #2935 (null-deref)                           | —           | 125 → 223         |
| Iterator/prototype (182)                                                                                                    | #3049/#3146 **done** — see NEW-1 below               | —           | helper _residual_ |
| TypedArrayConstructors (111)                                                                                                | **#3177**                                            | in-progress | 356 → refresh     |
| Promise (110)                                                                                                               | #2867 · #3198 (blocked)                              | in-progress | —                 |
| Function (94) · Proxy (63, mostly deferred) · Number (52) · Date (51) · JSON (44) · DataView (36→#3173 done) · Reflect (28) | assorted (see 07-12 groom)                           | —           | —                 |

**Action for tech-lead/PO:** bump the fresh counts into #2872 (→532), #2875
(→282), #3177, #2984/#2992; #2872 + #2875 are now the two single largest
tractable standalone levers and should sort to the TOP of the standalone queue.

### host_import_leak non-iterator residual (682 after removing the 2,309 #3178 rows)

Top leaked imports (occurrence count across gap rows): `SharedArrayBuffer_new`
(125, **deferred** — SAB skip-class), `__js_array_new`/`__js_array_push` (138 —
64 are Promise combinators #2867/#3198, 60 are `language/*/class` array-build),
`Promise_all*/any/race` (77 → #2867/#3198), `__instanceof_check` (30 → #2916),
`__array_from_async` (24 → #2967 done/refresh), `decode/encodeURI*` (48 —
**NEW-2 below**), `AsyncDisposableStack_new` (14 — #2866 Symbol-carrier dep).

### type_error (677) map

`annexB/language/eval-code` + `eval-code/direct` (136 — **deferred**, eval
#3005/#3017), Array/proto (94 → #3180/#3185), TypedArray/proto (63 → #2872),
Iterator/proto (41 → NEW-1), TypedArrayConstructors (68 → #3177),
defineProperties (27 → #2992), String/proto (20 → #2875), String.raw (12 → #3147 done).

### Genuinely-NEW findings this pass (not covered by an open child)

- **NEW-1 — Iterator.prototype helper OBSERVABLE-SEMANTICS residual (~223).**
  #3049 (map/filter/take/drop/flatMap) and #3146 (zip/concat/from) both landed
  as `done`, yet `built-ins/Iterator/prototype` still shows 182 `assertion_fail`
  - 41 `type_error` in the gap — the helpers EXIST but diverge on spec
    observables (abrupt-completion IteratorClose ordering, `this`/brand
    TypeErrors, counter/limit edge values). A spec-fidelity follow-on, distinct
    from helper existence. Recommend a `#31xx` child once #2872/#2875 land (Symbol
    `@@iterator`/`@@toStringTag` fidelity may share root cause with #2866).
- **NEW-2 — URI carrier ROUTING regression → filed as #3401.** #2500 (native
  `decodeURI`/`encodeURI`/`decodeURIComponent`/`encodeURIComponent`) is `done`,
  yet **48 official `built-ins/{decode,encode}URI*` conformance tests still leak
  `env::decodeURI…`** — the native carrier exists but is not dispatched for
  these call shapes. Clean, verified, self-contained slice. See
  `3401-standalone-uri-carrier-routing-regression.md`.

### Umbrella status after this pass

Still `sprint: current`, `priority: high`. Decomposition remains essentially
COMPLETE — this pass re-grounded the numbers (gap 20,500 → 8,228), flagged the
`assertion_fail`-dominant shift, banked fresh counts onto the four grown-scope
levers (#2872/#2875/#3177/#2984-2992), and carved exactly one genuinely-new
slice (#3401). No duplicate children were minted (verified each cluster's
pointer against an existing owner first — the `avoid-code-bloat-deduplicate`
memory applied to issues).

## Implementation Plan (Fable, 2026-07-18) — fresh census @ main 9d216ada + the priority ladder

> Measured from the 2026-07-18 baselines-repo refresh (commit `5c6d3092`,
> compiler @ `9d216ada`): host official pass **32,178**, standalone official
> pass **24,726** (24,723 headline ± scope rows). Honest gap (host `pass` ∧
> standalone not-pass, official scope, file+strict match): **8,231** — down
> from 12,801 (07-12 groom) and ~20,500 (06-30). The window closed ~4,570
> rows. The decomposition below is the current scoreboard; census script
> shape: parse both jsonl lanes, key `file|strict`, group the gap rows by
> `status:error_category`, leak-import name, and 2/3-level test dir.

### The gap, by mechanism (2026-07-18)

|     Rows | Mechanism                           | Owner(s)                                |
| -------: | ----------------------------------- | --------------------------------------- |
|    2,991 | `compile_error: host_import_leak`   | the carrier track (below)               |
|    4,079 | `fail: assertion_fail`              | behavioral clusters (below)             |
|      677 | `fail: type_error`                  | behavioral clusters                     |
| 112 / 66 | `illegal_cast` / `null_deref`       | mostly inside carrier machinery + #2935 |
|      261 | `compile_error: other/wasm/runtime` | #2878-class triage residual             |
|       45 | timeout/syntax/oob/misc             | long tail                               |

**Leak half (2,991), by leaked import:** generator family
(`__create_generator` 1,672 + `__gen_next` 106 + `__create_async_generator`
72 + async-gen proto 16) ≈ **1,866** → #2864/#2865 via the #3178 retirement
umbrella. Promise family (`_reject` 367 + `_new` 158 + `_all` 81 +
`_allSettled` 23 + `_catch` 16 + `_any` 14 + misc) ≈ **~680** → #2867/#3178.
`__dynamic_import` **107** → NO owner (decision below). Small tails:
`__array_from_async` 25 (#2967/#3134), `__instanceof_check` 24 (#2916
Slice B — spec'd 2026-07-18), `Set_constructor` 17, misc ≤17 each.

**Behavioral half, by cluster (assertion_fail + type_error combined):**

| Rows | Cluster                                                                                                           | Owner                                                                              |
| ---: | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ~960 | TypedArray (`TypedArray/prototype` 532+63, `TypedArrayConstructors` 68+38+30, DataView 33+, ArrayBuffer 40)       | #3177 / #3173 / #2872                                                              |
| ~550 | property model (`Object/defineProperty` 247 + `defineProperties` 142+27 + `create` 55+14 + `Object/prototype` 62) | #3251 S2/S3 (PR #3327 in flight) + #739 + #2992/#2984                              |
| ~512 | `Array/prototype` behavioral (418+94)                                                                             | #3169 / #3170 + #3251 read-side                                                    |
| ~350 | String (`String/prototype` 282+20 + annexB/String 46)                                                             | #2875                                                                              |
| ~223 | `Iterator/prototype` (182+41)                                                                                     | #3146 / #3049                                                                      |
| ~212 | class semantics (`language/*/class` 106+106)                                                                      | #2873 + the #2963/#3037 method-identity residue                                    |
| ~169 | `RegExp/prototype`                                                                                                | #2876 / #2935                                                                      |
| ~136 | annexB eval-code type_errors (123) + direct eval (13)                                                             | eval Tier-0 sound-bail residue (#1102-adjacent; see the ladder doc §2 bail list)   |
|  ~76 | `Function/prototype` (61+15)                                                                                      | #3138 / #3139 bind residual                                                        |
| ~109 | `assert.sameValue(rest.a, undefined)`-signature family (44+31+33 shapes)                                          | the value-rep trio — #2106 numeric-carrier leg + #745 (see their 2026-07-18 plans) |

### Priority ladder (order of expected yield per unit work)

1. **#3178 carrier retirement (generators + Promise)** — 2,546 leak rows,
   ~31% of the whole gap, single-theme. Stays rank 1; #3178 is actively
   carving slices (#3302 etc.) — feed it, don't fork it.
2. **TypedArray family** (#3177 → #3173 → #2872) — ~960 rows; #3177's 356
   estimate from 07-12 has GROWN in share as other clusters closed.
3. **Property model** — ~550 rows riding the in-flight #3251 (S2 write-side
   - S3 ArraySetLength are the spec'd next slices) + #739.
4. **Array behavioral** (#3169/#3170) — ~512; partially overlaps 3 (many
   defineProperty-on-array rows count in both — de-dup at claim time).
5. **String** (#2875) ~350, **Iterator** (#3146/#3049) ~223, **class**
   (#2873) ~212, **RegExp** (#2876/#2935) ~169 — parallel dev-lane tracks.
6. **Value-rep signature family** (~109) — falls out of the #2106/#745
   plans; do not staff separately.
7. **annexB eval-code** (~136) — bounded; only after the ladder-doc bail
   list is re-reviewed (routing rule 2: broadening Tier-0 needs a semantics
   proof).

### Decisions needed (PO/lead — the only actions this census adds)

- **`__dynamic_import` (107 rows) has no owning child.** Options:
  (a) route to #1046 (separate ES-module compilation — dynamic import is a
  module-loading feature, and a standalone story needs module linking
  #2527); (b) declare deferred-feature (join eval/Proxy/with in the skip
  rationale) and re-tag the rows out of the honest gap. Recommendation:
  **(a) as a documented later phase of #1046**, keep counting the rows —
  they are honest misses, not wont-fixes.
- The 07-12 groom's nine method-family slices (#3169–#3177) remain the
  right cut — no new child issues are warranted by this census; counts
  above re-weight their priority only (notably #3177 up, #3171/#3172 down —
  Set/Map rows shrank to ~95 combined).

### Census reproducibility

Fetch both lanes from `loopdive/js2wasm-baselines` (fetch helper or raw at
a pinned commit), filter `scope_official`, key `file|strict`, and group as
above. Re-run at each window boundary; the ladder re-orders on measured
counts, never on stale estimates (this census corrected three of the 07-12
weights).

## 2026-07-23 — F3 observability unblocker landed (#3535, fable-2860)

The 2026-07-19 lane-parity investigation (Cluster B, `.tmp/parity-findings.md`)
found the single biggest triage blocker was not a feature gap but MASKING:
under the standalone lane's `(start)`-init model every top-level throw — i.e.
every runtime failure in original-harness mode — surfaced from
`WebAssembly.instantiate` with `instance === null`, making the #2962 native
exception render unreachable and collapsing **8,610 baseline rows** onto the
opaque `wasm exception during module init` label.

**#3535 (done)** makes the standalone lane join the host lane's
`deferTopLevelInit` rule (worker + both local-runner arms). Measured
(verify-first, main @ aa203fdc): 152-row stratified masked sample → 0 verdict
flips, 152/152 un-masked; all 7 runtime-negative masked rows probed
exhaustively → 6 honest fail→pass; 101-row stratified pass sample → 0
pass→fail (floor-safe). Un-masked signatures now route the residual to real
owners — top revealed clusters: Temporal deferred-feature refs (~15%),
`Test262Error: obj should have an own property …` (the #3468 function-object
own-property residual, ~11%), `TypeError: Cannot convert undefined or null to
object`, positional null-deref TypeErrors, eval-shim #2928 refusals.

**Next for this umbrella**: after the next baseline promote re-labels the
8,610 rows, re-run the error-signature census on the standalone lane and
re-weight the priority ladder — the de-masked buckets land in the EXISTING
children (no new slices expected beyond what the ladder already tracks).

## 2026-07-23 — routed de-masked census (fable-2860; lead-steered weighting)

1,077-row stride-8 census of the 8,610 masked rows, run locally against the
fixed compile path, **weighted by addressable fail→PASS potential** (lead
steer: fail→skip is landing-%-NEUTRAL, so skip-features are an explicit
zero-value bucket; #3468 own-property rows route to the fable-exposed
clustering effort; async rows route to fable-3417's ladder — never sum the
two ladders):

| bucket (sampled → extrapolated)                                                                    |         rows | routing                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | -----------: | --------------------------------------------------------------------------------------------------------------------------- |
| addressable                                                                                        | 516 → ~4,125 | the ladder below                                                                                                            |
| zero-value skip-feature (Temporal, eval #2928, `with`/annexB eval-code, SAB, ShadowRealm, $262.\*) | 299 → ~2,390 | none (%-neutral)                                                                                                            |
| #3468 own-property family                                                                          | 199 → ~1,591 | HANDED to fable-exposed (`.tmp/handover-3468-ownprop.txt`)                                                                  |
| async-flagged                                                                                      |    60 → ~480 | fable-3417's async cohort (do NOT double-count vs their 88-row module-init-trap bucket — different measures of one surface) |
| already-pass drift                                                                                 |      3 → ~24 | clears on promote                                                                                                           |

**Addressable, by family (the re-weighted ladder):** Array/prototype ~664
(#3169/#3170/#3180/#3185) · TypedArray/prototype ~520 (#2872/#3177) ·
RegExp/property-escapes ~311 exact (#3536 → #3541) · TypedArrayCtors/internals
~168 (#3177) · defineProperty ~160 + defineProperties ~144 + create ~64
(#3251/#2984/#2992) · String/prototype ~104 (#2875) · Iterator/prototype ~80
(NEW-1 residual) · class ~128 (#2873). The "Cannot convert undefined or null
to object" (~368) cluster is PARKED: its majority shape (prop-desc/name/length
method-as-value reads) converts, if fixed alone, into the #3468 own-property
signature — fail→fail, %-neutral — so it waits on the fable-exposed outcome.

## 2026-07-23 — #3536 landed, #3541 carved (the property-escapes chain)

**#3536 (done)** fixed the biggest single addressable signature's cleanest
sub-family at its root: standalone call boundaries for declared functions
with object-literal arguments (silent-null param via the dynamic-$Object /
narrowed-struct mismatch, plus the IR overlay's post-hoc ABI replacement
emitting invalid wasm — the patch-time typeIdx parity guard now covers
top-level functions). Measured: 8/8 repro shapes fixed, 0 regressions across
the full battery, but only **2/198 direct census flips** — the naive
~1,190-row extrapolation for the signature was ~600× optimistic (the lead's
measure-don't-extrapolate steer, vindicated). The 311-row property-escapes
family now blocks on exactly ONE pre-existing defect — **#3541**
(`String.fromCodePoint.apply(null, vec)` → null → `__str_concat` null-deref,
plus an illegal-cast sibling in the same `buildString` harness function).
All 311 rows run that one function, so #3541 is the measured gate on the
family; the remaining 138 re-measured null-deref rows distribute over
TypedArray-internals-class defects (#2872/#3177 territory).
