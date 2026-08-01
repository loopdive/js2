---
id: 4022
title: "UMBRELLA: es5 standalone → 90% — census on fresh data (66.3%, not the published 59%), reachability ceiling 92.4%, and the prioritised lever list"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: umbrella
area: codegen, conformance
language_feature: n/a
goal: es5
related: [3892, 3626, 3628, 1906, 2992, 3251, 2928, 1387, 671, 3983]
origin: "2026-08-01, goal directive: 90% test262 standalone pass rate for es5-tagged tests. Census recomputed from baselines-repo run 20260801-090441 because the committed editions artifact is frozen (#3892)."
---

# #3977 — es5 standalone to 90%: census, ceiling, and lever list

## The number is 66.3%, not 59%

The published artifact
(`website/public/benchmarks/results/test262-standalone-editions.json`) reports
ES5 standalone at **5,273 / 8,931 = 59 %**, and `plan/goals/es5.md` quotes the
same figure. **Both are stale by a week** — this is #3892 (the editions artifact
is frozen since 2026-07-25 because `baseline-summary-sync` has no test262
submodule and `generate-editions` dies silently).

Recomputed on 2026-08-01 by running the authoritative classifier against the
fresh baseline (`loopdive/js2wasm-baselines` run `20260801-090441`, gitHash
`c601e89b`):

```bash
node scripts/claim-issue.mjs --help >/dev/null   # (unrelated)
git submodule update --init --depth 1 test262
npx tsx scripts/generate-editions.ts \
  --results .test262-cache/test262-standalone-current.jsonl \
  --target standalone --output /tmp/editions-standalone-fresh.json
```

| | pass | fail | ce | total | pct |
| --- | --- | --- | --- | --- | --- |
| published (2026-07-25) | 5,273 | 3,400 | 258 | 8,931 | 59 % |
| **fresh (2026-08-01)** | **5,924** | 2,797 | 210 | 8,931 | **66.3 %** |

Fixing #3892 is a **precondition for steering this goal** — nobody should drive
a conformance push against a frozen gauge.

## Reachability: 90 % is attainable, but with almost no slack

`eval` and `with` are out of reach for standalone today (`eval` → #2928, a
bytecode-interpreter programme; `with` → #1387 / #671). Partitioning the 3,007
ES5 standalone failures by whether the **test source** actually depends on them:

| Bucket | Tests |
| --- | --- |
| fail, eval-dependent | 501 |
| fail, with-dependent | 164 |
| fail, both | 11 |
| **fail, neither (reachable)** | **2,331** |

(272 eval-using and 45 with-using ES5 tests already pass, so the dependency is
not automatically fatal.)

```
90 % target      8,038 passes      (of 8,931)
today            5,924
gap              2,114 tests
reachable pool   2,331 tests
CEILING w/o eval+with = 8,255 / 8,931 = 92.4 %
```

**So 90 % is reachable — with 217 tests of headroom.** That is the load-bearing
fact for planning: it requires closing **2,114 of 2,331 = 91 % of every
reachable ES5 standalone failure**. There is no version of this that is a few
targeted fixes. Any single lever below is worth ≤ 15 % of the gap.

If `eval` (#2928) lands, the ceiling rises to ~98 % and the pressure comes off
entirely. **Landing #2928 is plausibly cheaper than closing the last 500 of the
long tail** — that trade should be evaluated explicitly before committing to the
grind.

## Lever list (reachable failures only, by directory)

| Lever | Tests | Share | Notes |
| --- | --- | --- | --- |
| **Property descriptors** — `Object/defineProperty` 331, `defineProperties` 264, `create` 142, `getOwnPropertyDescriptor` 35, `prototype` 22, `isExtensible` 16, `preventExtensions` 15, `Array/length` 18, `types/object` 14 | **857** | **37 %** | the one dominant theme |
| `built-ins/String/prototype` | 194 | 8 % | |
| `built-ins/Function/prototype` | 117 | 5 % | overlaps #3983 |
| annexB hoisting (`global-code` 111, `function-code` 96) | 207 | 9 % | B.3.3 semantics |
| `language/statements/function` | 58 | 2 % | |
| `built-ins/Array/prototype` | 53 | 2 % | |
| `built-ins/RegExp/prototype` | 46 | 2 % | + 44 `__module_init` null-derefs |
| everything else | ~799 | 34 % | genuine long tail |

Top single error signatures in the reachable set are all small — the largest is
132 (`Expected a TypeError to be thrown but no exception was thrown at all`, 6 %),
and the top 30 signatures together are only ~34 % cumulative. **This is a long
tail, not a few big rocks.**

### Property descriptors is the only lever worth a dedicated programme

37 % of the reachable gap sits behind one substrate. The current standalone
`Object.defineProperties` deliberately **fails loud** ("unsupported descriptor
shape in standalone mode (#1906)") whenever the receiver or the properties bag
is not a native `$Object` — see the comment at
`src/codegen/object-runtime-descriptors.ts:1281`, which is explicit that this is
a chosen refusal pending the exotic-receiver own-key MOP substrate
(**#2992 slice 2/5, #3251**). That refusal is correct — removing the gate turns
a loud failure into a silent no-op — so the path forward is the MOP substrate,
not deleting the guard.

**#2992 / #3251 are therefore the critical path for this goal.**

## Recommended sequencing

1. **#3892** — unfreeze the editions artifact. Without it the goal has no gauge.
2. **#2992 / #3251** — exotic-receiver own-key MOP; unlocks the 857-test
   property-descriptor family (37 % of the gap).
3. **#3983** — `this` receiver identity; 200-test family, lane-independent, so
   it pays into the ES5 *host* target too.
4. Decide explicitly: **#2928 (`eval`)** to lift the ceiling to ~98 %, versus
   grinding the last ~500 of the long tail against a 92.4 % ceiling.
5. Long tail: String.prototype, annexB B.3.3 hoisting, RegExp `__module_init`
   null-derefs.

## Honest status

At 66.3 % today, with a 92.4 % ceiling and a 91 %-of-reachable closure
requirement, **this is a multi-PR, multi-agent programme, not a single task.**
It should be tracked as an umbrella with the levers above as children. Anyone
picking it up should re-run the census first (the artifact is frozen, and these
numbers age).

### Reproducing the census

The scripts used are in the session scratchpad, not committed; they are ~40
lines each and re-derivable: classify every standalone JSONL record with
`parseFrontmatter` + `classifyEdition` from `scripts/generate-editions.ts`, keep
`classifyEdition() === 5`, apply the host-free pass rule
(`status === "pass" && !host_import_leak_class`, #2914), then bucket the
failures by `error_signature` and by directory. The eval/with partition greps
the **test source** for `eval(` / `with (` plus the `eval-code/` and `with/` path
segments.
