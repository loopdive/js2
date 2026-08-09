# Context handoff — `dev-acorn-throughput` (Acorn parse-throughput lane)

Session 2026-07-31. Written at stand-down. Everything below is either
first-party measurement or an explicit citation of whose measurement it
is. Numbers I did not take myself are labelled with their issue id.

---

## 0. TL;DR for whoever picks this up

1. **Standalone compiled acorn is ~10x native node** on a real 226 KB
   parse. That is the number to work against — *not* the ~400x host-lane
   figure, which is bridge tax.
2. **The string-access axis (#3684 D2) is NOT the next lever.** I
   measured it at **2.10%** of the real parse. See §3 — this contradicts
   the earlier plan of record, including my own hand-off instructions.
3. **The lever is scaffolding inside typed-`this` twins (#3686), then
   widening twin admission (#3685).** 37.10% of the parse already runs
   inside twins; 19.80% is in generic bodies that never got one.
4. **Use `--inspect-binary` + `--reuse-standalone-binary`.** It turns a
   ~7-minute recompile into seconds. See §5.

---

## 1. What I was asked to do, and what happened

Lane: **#3756** (primary), then **#3675**, then **#3780**.

- **#3675 — STOP.** Gate blocker: #3673 (`in-progress`,
  `assignee: claude/acorn-performance`) owns it as one of its own
  slices. Not started.
- **#3780 — STOP.** Owner-pinned `assignee: ttraenkler/codex`, live
  claim, three documented optimization rounds. Not started. **Note for
  planners:** #3780's last open acceptance criterion is verbatim
  "standalone compiled Wasm median beats native Node", so any future
  "make standalone acorn beat node" task collides with it by
  construction. Route through codex or re-own it explicitly.
- **#3756 — taken, claimed, corrected.** The prior two
  `fix-3756-acorn-superlinear` PRs (#3735, #3776) were **docs/website
  only**; no code fix had ever landed despite the branch names.

---

## 2. #3756's stated root cause was aimed at the wrong lane

The issue proposed `this.<method>()` **method dispatch** as the driver of
a ~400-500x gap. Correct characterisation is **reframed, not refuted**:

- The ~400-500x is a **JS-host-lane** number and is **bridge tax**.
  Per **#3780's census (theirs)**: **17,669,965 Wasm→host calls** for one
  226 KB parse — `__box_number` 3.0M, `__extern_get` 1.85M,
  `__get_undefined` 1.72M, `__host_compare` 1.70M, `__unbox_number`
  1.56M, `__host_eq` 1.46M, `__typeof_number` 1.32M, `__is_truthy` 1.31M.
  `__get_undefined` is literally `() => undefined` (`src/runtime.ts`
  L9814) called 1.72M times per parse.
- Method dispatch **is** a real axis, but a single-digit one, and it
  lives in **standalone**. Per **#3684's harness (theirs)**, run 3:
  method dispatch **9.73x**, tokenizer shape **7.37x**; numeric
  **0.98x**, property r/w **1.00x**, allocation **1.00x** — already at
  V8 parity.

Both corrections are now written into `plan/issues/3756-…md` with
attribution, and its Scope/AC are rewritten to route (dispatch →
#3683/#3685) rather than duplicate.

---

## 3. First-party whole-parse decomposition — the important part

Standalone runtime-dynamic lane, tip `af7d6f875b35e5`, debug-named
binary, 30 profiled parse operations. **V8 profiler overhead
(`post [node:inspector]`, 3.84% of raw samples) excluded**; denominator
2,443.0 ms over 1,188 samples. **Load 12.8-13.9 on 10 cores** — reported
as *shares*, which are far more contention-robust than wall-clock.

| family | share |
| --- | ---: |
| **compiled parser body** | **56.90%** |
| property lookup (`__extern_get` 8.03%) | 10.10% |
| `__dc_*` direct-call trampolines + misc helpers | 7.66% |
| call dispatch (`__call_fn_method_*`) | 7.45% |
| value ops / coercion | 6.42% |
| regexp engine (`__regex_search` 4.13%) | 4.76% |
| GC | 4.31% |
| **string runtime** | **2.10%** |
| array runtime | 0.30% |

Parser body split by whether a typed-`this` twin was emitted:

| | share |
| --- | ---: |
| typed-`this` twins | **37.10%** |
| generic / no twin | **19.80%** |

Top single functions — note the **two hottest have no twin**:
`__closure_339` **3.38% (generic)**, `__closure_378__typed_this` 2.64%,
`__closure_184` **2.62% (generic)**, `__closure_352__typed_this` 2.33%,
`__fnctor_Node_new` **2.21% (generic)**, `__closure_543` **2.11%
(generic)**.

### Ranked levers (this supersedes reading #3684's axis table alone)

1. **Scaffolding inside existing twins (#3686)** — 37.10% share ×
   #3686's own repriced 23-29% ⇒ **~8-11% end-to-end**. Largest named
   lever.
2. **Widen twin admission (#3685)** — 19.80% is untwinned; #3685's S1
   admits only **150 of 2,363** (6.3%) non-`this` accesses and names the
   unproven shapes (`this.options.<x>`, RegExp-validator `state.<x>`).
3. **`__extern_get`** (#3669/#3671) — 8.03%, largest non-parser function.
4. String runtime **2.10%** — real, but not a parity lever.

### CORRECTION to my own hand-off instructions

I was told to record that **#3684 D2 (string element access, ~4.5x vs
V8) is "the next obvious target"**. **My measurement says it is not**,
and I am not going to write something I measured to be false. Zeroing
the entire out-of-line string runtime moves ~10x to ~9.8x. D2's 4.5x is
true *of an isolated 700 K-`charCodeAt` loop where string access is ~100%
of the work*; in a real parse the mix is dominated by everything else.
This is the axis-to-end-to-end extrapolation trap.

**Honest limit on that claim:** `charCodeAt` on a flat native string
lowers **inline** (`array.get_u` off a `struct.get` data pointer —
#3673 round 34), so inline character reads are attributed to the
*calling closure* and sit inside the 56.90% parser-body bucket. So
**2.10% is a floor on out-of-line string cost, not a ceiling on total
string cost.** What it does establish is that the rope/flatten/intern/
compare machinery D2 proposed to hoist is 2.10%. Settling the inline
half needs a paired A/B with the `i32→f64→i32` round trip removed, not a
profile.

---

## 4. Standalone whole-parse re-baseline (mine)

Tip `af7d6f875b35e5`, harness protocol (2 warm-up + **9 measured
rounds**, 5 iters/round), node control measured **in the same process**:

| | min | median | max | std |
| --- | ---: | ---: | ---: | ---: |
| standalone wasm | 60,542.9 µs | 96,888.1 µs | 145,689.7 µs | 25,691 (26.5%) |
| native node | 6,312.4 µs | 8,057.0 µs | 11,837.9 µs | 1,612 (20.0%) |

- **median/median → node 12.03x faster; min/min → node 9.59x faster.**
- Load **6.72 → 5.12** during this run. An earlier run at load
  **7.36 → 8.10** gave median ratio 11.04x.
- **Read the min pair on a contended box.** Node's own control moved
  from ~4,900 µs (uncontended, committed artifact) to 8,057 µs median
  here on identical source — contention lifts both sides but not
  equally. min/min = 9.59x is stable and matches the committed artifact's
  9.77x.
- **Do NOT quote 12.03x as a regression against the committed 9.77x** —
  that is a local-vs-CI diff across different hardware (phantom deltas).

*(An earlier hand-off note said min/median/max were never captured
because stdout was truncated. That was true of my first run; the second
run captured them and they are the table above.)*

---

## 5. Tooling that will save the next person an hour

The standalone acorn compile is **~7 minutes** at level 4 on this box.
You do not have to pay it per experiment:

```bash
# compile once, dump the binary (add --preserve-debug-names for profiling)
npx tsx scripts/generate-npm-compat-report.mjs --only acorn --no-write \
  --perf-only --lane standalone-dynamic \
  --preserve-debug-names --inspect-binary .tmp/acorn-sa-named.wasm

# then re-measure / profile in SECONDS, any number of times
npx tsx scripts/generate-npm-compat-report.mjs --only acorn --no-write \
  --perf-only --lane standalone-dynamic \
  --reuse-standalone-binary .tmp/acorn-sa-named.wasm \
  --profile-runtime wasm --profile-output .tmp/x.cpuprofile \
  --profile-iterations 30
```

- `--reuse-standalone-binary` **does** work for the `standalone-dynamic`
  lane (not only the static one).
- **Without `--preserve-debug-names` the profile is useless** — every
  frame reads `wasm-function[138]`. I burned one profiling round finding
  that out.
- **Do not pipe the run through `tail`.** The per-lane JSON with
  `wasmSamplesUs` / `nodeSamplesUs` is emitted before the history blob;
  truncating loses min/median/max. Redirect the whole thing to a file.
- Profile analysis scripts I used are throwaway (`.tmp/prof-analyze2.mjs`,
  `.tmp/prof-typed.mjs`); they just sum `timeDeltas` by
  `samples[i]` → node id → `callFrame.functionName`, exclude
  `post [node:inspector]` from the denominator, and bucket by name
  prefix. Trivial to rewrite.

---

## 6. Cycle-guard bug (#3686's stated prerequisite) — LATENT, NOT LIVE

#3686 says `class Node { left: Node }` "makes codegen recurse until stack
overflow" and calls it a hard prerequisite. **It does not reproduce on
tip.** Both spellings compile clean:

- `class Node { left: Node; v: number }` + `new Node(...)` + `b.left.v`
  → 53,068 B standalone, 961 ms.
- `interface TreeNode { left: TreeNode; v: number }` + `n.left.v`
  → 52,417 B, 760 ms.

**But the guard genuinely is missing.** In `src/codegen/index.ts`:
`objectIrTypeFromTsType` (L1103-1128) calls `tsTypeToFieldIr` (L1122);
`tsTypeToFieldIr` (L1136-1142) calls straight back at L1140
(`if (t.flags & ts.TypeFlags.Object) return objectIrTypeFromTsType(...)`).
Neither carries a seen-set.

**What actually saves the class case is a different guard**, in
`tsTypeToClassPositionIr` at **L1486**: `resolveIrClassShapeFromType`
returns `{kind:"class", shape}` *before* the `Object`-flag arm can
recurse. The interface case never reaches L997 because the IR selector
bails earlier.

**Correct characterisation: latent.** It becomes live the moment #3686
makes those shapes typed-and-reachable — which is exactly #3686's own
wording ("today's code survives *because* it is untyped"). I deliberately
**did not file it as a standalone issue**: there is no failing repro to
write a regression test against, and the #2093 gate hard-fails a `done`
flip with no probe/test reference, so it would create an issue nobody
could verify or close. **Recommendation: fold the 2-line seen-set guard
into #3686**, where the same PR that makes the shape reachable also
supplies the repro that proves the guard works.

---

## 7. Bearing on the new priority (standalone ES5 test262 score)

Being straight about this: **my work is standalone *speed*, not
*conformance*, so most of it does not move a test262 score.** What does
bear on it:

- **#3673's rounds 26/28 standalone correctness gaps are the relevant
  thread**, not the perf rounds. Its round-26 diagnosis lists concrete
  standalone-only divergences — `for…in` over a fnctor instance
  enumerating **0 keys**, `Object.keys` returning 0, and computed writes
  `n[k] = v` being a **no-op** on fnctor instances. That is a *general
  reflection hole in the fnctor/typed-this machinery*, not an acorn
  quirk, and reflection holes are exactly what ES5 test262 exercises
  heavily (`Object.keys`, `for-in`, property enumeration order,
  `hasOwnProperty`). I would start there.
- `BigInt(str)` has no native standalone implementation
  (`__bigint_ctor` defers string parsing) — bounded, and ES2020 rather
  than ES5.
- The `--inspect-binary` / `--reuse-standalone-binary` trick (§5) and the
  "shares survive contention, wall-clock does not" discipline (§4) both
  transfer to any standalone work on this box.

---

## 8. State at stand-down

- Branch **`issue-3756-acorn-standalone-parity`**, pushed to `fork`.
- Claim: `#3756` held by `ttraenkler/dev-acorn-throughput` (branch
  recorded as `issue-3756-host-lane-value-ops` from before the re-scope —
  cosmetic mismatch only). **Release it** on stand-down.
- Files changed: `plan/issues/3756-…md` (root-cause correction, scope
  rewrite), `plan/issues/3684-…md` (D3 discharged + whole-parse
  decomposition), this file.
- **No compiler source was changed.** Nothing to regress.
