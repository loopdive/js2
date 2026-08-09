---
id: 4273
title: "UMBRELLA: exact ES2015 → 90% — pinned two-lane census, root-cause map, and IR lever plan"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: umbrella
area: ir, conformance
language_feature: es2015
es_edition: 2015
goal: es6
assignee: "ttraenkler/codex-es6-census"
test262_count: 11691
related: [680, 869, 1355, 1430, 1645, 1691, 1750, 2046, 2566, 2662, 2669, 2864, 2866, 2872, 3031, 3177, 3371, 3488, 3523, 3531, 3575, 3783, 3949, 3975, 4167, 4259, 4274, 4275, 4277]
origin: "2026-08-09 exact-edition ES2015 audit against frozen oracle-v13 two-lane JSONLs and the committed per-file edition map; requested target is 90% and all implementation work must be IR-path work"
---

# #4273 — Exact ES2015 to 90%: census, root causes, and IR lever plan

## Scope and pinned authority

This issue tracks **exact-edition ES2015**, not every test cumulatively through
ES2015 and not every untagged legacy test. The authoritative cohort is the
intersection of:

1. paths present in the frozen baseline JSONLs;
2. paths mapped to `ES2015` by
   `website/public/benchmarks/results/test262-file-editions.json`; and
3. the official standard or Annex B scopes already admitted by the baseline.

Audit pin:

- compiler baseline SHA: `fba37d2df54a742b853cff3b69fc66adc752903a`;
- Test262 gitlink: `b363f29d3c43c626dc852744ad64a0b48a003693`;
- baseline-repository snapshot: `3add20464a7353eefb17f2a34af2710bcf57d7e6`;
- oracle: v13, generated `2026-08-09T06:31:03Z`; and
- population: **11,691 files per lane** — 11,523 standard plus 168 Annex B.

The two JSONLs each contain 48,619 unique rows, have identical file sets, have
zero missing edition mappings, and reproduce their published report totals.
They are therefore the status authority for this census. The checked-in
aggregate edition reports are not substituted for their JSONL rows.

## Current score and target gap

Ninety percent of 11,691 requires at least **10,522 passing files**.

| Lane | Pass | Fail | Compile error | Timeout | Skip | Pass rate | Passes needed for 90% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GC/host | 8,768 | 2,799 | 63 | 60 | 1 | 74.9979% | **+1,754** |
| Standalone | 7,311 | 3,479 | 886 | 14 | 1 | 62.5353% | **+3,211** |

The cross-lane matrix is:

| Outcome | Files |
| --- | ---: |
| pass in both lanes | 7,004 |
| non-pass in both lanes | 2,616 |
| GC pass / standalone non-pass | 1,764 |
| GC non-pass / standalone pass | 307 |

The website's cumulative “through ES2015” view is a separate 20,622-file
denominator. On that view GC is 15,923/20,622 (77.2137%, +2,637 to 90%) and
standalone is 15,246/20,622 (73.9308%, +3,314). Work on this issue is scored
against the exact-edition denominator above; cumulative movement may be
reported additionally but must not replace it.

## Why an earlier fresh count said 11,736

The 11,736 result was not a new cohort. It classified July baseline paths using
a stale March Test262 checkout at `63829c6`, while the baseline and repository
gitlink both use `b363f29`. Exactly 179 relevant paths were absent from the
stale checkout, so missing frontmatter fell into path heuristics:

- 112 later-edition files incorrectly entered ES2015: Promise `allKeyed` (39),
  `allSettledKeyed` (38), ArrayBuffer prototype (25), and TypedArray (10);
- 67 genuine ES2015 files fell out: Iterator.prototype (54), Error.prototype
  (11), and module namespace internals (2).

The net error was `112 - 67 = +45`. All future reruns must first assert that
the Test262 checkout is exactly the gitlink SHA and refuse to score a stale or
missing source tree.

## Measured feature cohorts

These cohorts overlap heavily. They are useful prioritisation signals, but
their counts **must never be summed**.

| Rank | Feature cohort | Files | GC pass/fail/CE/timeout/skip | Standalone pass/fail/CE/timeout/skip | Non-pass in both |
| ---: | --- | ---: | --- | --- | ---: |
| 1 | generators | 2,485 | 1915/541/15/14/0 | 1746/428/308/3/0 | 487 |
| 2 | destructuring-binding | 4,153 | 3562/548/1/42/0 | 3476/522/153/2/0 | 502 |
| 3 | TypedArray | 1,047 | 742/302/1/2/0 | 243/600/203/1/0 | 290 |
| 4 | Symbol.iterator | 795 | 446/304/3/41/1 | 338/327/128/1/1 | 336 |
| 5 | Proxy | 431 | 186/242/1/2/0 | 74/279/78/0/0 | 226 |
| 6 | Symbol | 600 | 430/170/0/0/0 | 254/311/35/0/0 | 162 |
| 7 | default-parameters | 1,552 | 1376/157/4/15/0 | 1322/170/58/2/0 | 144 |
| 8 | class | 410 | 224/171/14/1/0 | 227/155/28/0/0 | 175 |
| 9 | Reflect | 330 | 191/138/1/0/0 | 110/129/89/2/0 | 130 |
| 10 | Symbol.species | 185 | 86/98/0/1/0 | 34/129/22/0/0 | 94 |

Their unique union covers 2,054 of 2,923 GC non-passes and 3,039 of 4,380
standalone non-passes. The largest strategic union is generators plus
destructuring: 4,941 files, 910 GC non-passes, 1,089 standalone non-passes, and
816 same-file non-passes. Its most measurable directory slice is
`test/language/statements/for-of/dstr/`: 524 files, 201 GC non-passes, 204
standalone non-passes, and 193 same-file non-passes.

Generator-backed members of that directory require real suspension and must be
kept separate from direct custom-iterator, default, elision, rest, and
IteratorClose work. Crediting the entire 524-file directory to a local binder
fix would be a false projection.

## Root-cause ownership map

Status below is the repository status at this audit, not an assertion that the
historic issue's old counts remain current.

| Cohort | Dominant measured mechanism | Repository Markdown owner(s) |
| --- | --- | --- |
| generators | eager host buffering breaks suspension; standalone rejects or leaks general state-machine and `yield*` shapes | #680 ready; #2662 blocked; #2864 in-progress |
| destructuring | IteratorClose, undefined-only defaults, elision stepping, rest draining, generator over-consumption; literal-harness top-level loops also hit whole-module-init ownership | #2669 and #1430 ready; exact IR assignment-pattern child #4275 in-progress behind #3783/#3523; #2566 blocked |
| TypedArray | callback observation, descriptors, detached buffers, dynamic constructors, standalone concat imports | #2872, #3177, #1645, #3531, #3975, #3488 ready |
| Symbol.iterator | custom iterator dispatch, spread argument formation, IteratorClose, generator overlap | #2669 and #1750 ready; #1691 blocked |
| Proxy | ordinary forwarding, descriptor invariants, dynamic MOP/trap dispatch | #1355 in-progress; #3031 ready |
| Symbol | native symbol carrier, symbol-key property storage, agent-wide registry and cross-realm identity | #2866 ready; true realms now #4274 |
| default parameters | omitted versus explicit `undefined`, dynamic value identity, argument presence, TDZ, method lowering | exact IR child #4277 ready; legacy #869 ready; #3949 in-progress; patterns also #2669 |
| classes | captured outer binding writes from accessor setters were dropped at the class/module-init boundary | #4259 on ready PR #4290 |
| Reflect | receiver/prototype semantics, descriptors, arbitrary distinct NewTarget | #2046 in-progress; #1355 in-progress; residual after done #3371 |
| species | observable constructor/`@@species`, returned object validation, realm/prototype identity | #3575, #3177, #2623 ready |
| cross-realm | `$262.createRealm` is an empty pseudo-realm, not a realm with distinct intrinsics | #4274 ready |

## IR-first execution order

Every implementation credited to this programme must have a genuine prepared
IR owner for the affected source terminal. A direct-codegen special case, a
Test262 filename check, or a legacy-only fallback improvement is useful only as
diagnosis and does not satisfy this issue.

1. **Bank the contained class-accessor writeback family.** #4259 / ready PR
   #4290 moves exactly 72 files per lane and proves each targeted accessor body
   is emitted once by prepared IR with no legacy body.
2. **Preserve Promise rejection identity at the IR async callback boundary.**
   #4167's contained ES2015 Promise slice has 28 host failures exposing raw
   module-tag `WebAssembly.Exception` wrappers. The fix belongs under the
   `async.callback.wrap` provider contract and must unwrap only this module's
   tagged payload, not foreign Wasm exceptions or `WebAssembly.RuntimeError`.
3. **Represent default-argument presence in the function IR ABI.** #4277
   partitions the exact cohort's 144 pinned same-file non-passes and freezes a
   15-file dynamic-carrier slice (eight non-generator forms). Add a callee-side
   undefined-only plan; do not carry the legacy signalling-NaN sentinel into
   IR.
4. **Build the direct-iterator `for-of` destructuring substrate, then unlock
   its literal-harness terminal.** #4275 isolates 45 top-level
   assignment-pattern files behind one indexed-array impostor. Its measured
   16-file fixed-pattern slice fails in both lanes, but an authentic prepared
   report now proves all of those loops live inside the one literal-harness
   `<module-init>` terminal, which first rejects at `vardecl-var-kind` and emits
   no IR body. Repair `forof.iter` completion and the structured inner iterator
   operation without score credit, then use #3783/#3523's genuine module-global
   and ordered module-init ownership before claiming the 15 resolved-target
   rows. Exclude generator sources until suspension is real.
5. **Work runtime/MOP families through explicit IR providers.** Reflect
   descriptor/get/set subsets, TypedArray callback observation, and the
   standalone concat/import boundary are contained before Proxy, species, or
   complete realms.
6. **Build the broad substrates deliberately.** Real generator suspension,
   native Symbol/property keys, Proxy MOP, and true realms are large but needed
   for the remaining ceiling. #4274 records the exact realm floor.

After every landed slice, rerun the exact frozen cohort in both lanes, report
file-by-file flips and regressions, refresh this issue's score table, and then
re-rank from the residual rather than continuing from stale projections.

## Acceptance criteria

- [ ] Both lanes reach at least 10,522/11,691 passing exact-ES2015 files on one
      pinned compiler/Test262/oracle tuple.
- [ ] Every credited PR reports exact before/after file rows in both lanes and
      distinguishes fail, compile error, timeout, and skip.
- [ ] Overlapping feature tags are never added as if they were disjoint.
- [ ] Every new root-cause cluster has a `plan/issues/<id>-<slug>.md` owner;
      root causes are not tracked as GitHub Issues.
- [ ] New conformance ownership is prepared IR ownership. Any transitional
      boundary is named explicitly and no targeted source terminal is emitted
      by both IR and legacy codegen.
- [ ] The Test262 source checkout is verified at the repository gitlink before
      classification, and a missing/stale source tree fails the census loudly.
