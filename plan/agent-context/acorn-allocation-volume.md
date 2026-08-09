# Context handoff — acorn standalone parse, allocation-volume lane (#3780 round 4)

Session 2026-07-31, branch `claude/acorn-performance-optimization-hagjht`.
Everything below is first-party measurement on **one** box unless labelled
otherwise. Numbers I did not take myself are attributed.

---

## 0. TL;DR

1. **Allocation volume is a first-class axis and nobody had measured it.**
   The standalone module allocates **58.0 MB per 226 KB parse** — ~257 bytes
   per source byte — and the AST it returns accounts for only ~10 MB.
2. Two generic lowerings landed and took it to **43.6 MB (−24.8%)**, worth
   **≈7%** wall clock. Both ship paired controls.
3. **34 MB per parse is still unexplained transient garbage** (~810 bytes per
   token). That is the largest single unexplained cost in the lane.
4. **Build the per-type allocation census before optimizing further.** The two
   obvious off-the-shelf tools do not work — see §4. Guessing from static
   `struct.new` site counts is exactly the extrapolation trap §3 of
   `dev-acorn-throughput.md` warns about.

---

## 1. Read the box caveat before quoting anything

Rounds 1–3 of #3780 were taken on Node 24.4.1 / arm64 macOS. This round is a
**4-core / 16 GB Linux container on Node 22.22.2**, and the profile is a
different shape: a debug-named 30-parse profile puts **36.7%** of the parse in
`(garbage collector)`, against the **4.3%** and **1.5%** the two round-3-era
profiles recorded. I do not know whether that is the V8 version, the heap
sizing, or the container.

So: **cross-machine wall-clock is not compared here, and no local number is
diffed against a committed CI baseline.** Everything argued below is either a
same-process paired A/B or a deterministic allocation counter.

Local scale for orientation only (not a regression claim): standalone wasm
~104–126 ms/parse against a same-process node control of ~12 ms, i.e. node
roughly an order of magnitude ahead.

---

## 2. What landed

Commit `perf(#3780): cut standalone acorn parse allocation 24.8%`.

| build | allocated / parse | vs baseline |
| --- | ---: | ---: |
| baseline (both controls off) | 58.0 MB | — |
| packed presence only | 50.0 MB | −13.8% |
| interned booleans only | 52.0 MB | −10.3% |
| **both** | **43.6 MB** | **−24.8%** |

- **Packed presence flags** (`src/codegen/fnctor-presence-bits.ts`). #2847's
  `$has_<name>` own-presence slot was one `i32` per conditionally-assigned
  property. Acorn's `Node` has 63 → 252 bytes of a 536-byte node. Now bits in
  `$presence_<w>` words: **130 fields / 536 B → 69 fields / 292 B**.
  Control: `JS2WASM_PACKED_PRESENCE_BITS=0` strides the bit assignment by a
  full word, so each flag lands alone in its own slot and the old footprint
  comes back through the *identical* read/write lowering — the A/B isolates
  layout from instruction mix.
- **Interned boolean carriers** (`src/codegen/interned-boolean-boxes.ts`). Two
  module-level carriers instead of an allocation. `wasm-opt` inlines
  `__box_boolean` everywhere, so this is **742 static `struct.new` sites → 2**.
  Control: `JS2WASM_INTERNED_BOOL_BOXES=0`.

Additive to within 0.4 MB (58.0 − 8.0 − 6.0 = 44.0, measured 43.6) — the
cross-check that they are independent effects. Wall clock, four builds in ONE
process, rotating order, 45 rounds: **−5.4% min / −6.3% p25 / −7.4% median**.
Independent `--trace-gc` accounting agrees: GC **30.1 → 22.5 ms** per parse.

Correctness: checksum 422 with zero imports; official Acorn suite unchanged at
**3,507/3,518**; `tests/equivalence/` shows **32 failures in 12 files both
before and after** (verified by re-running those 12 files against `HEAD~1`'s
`src/`) — all pre-existing.

---

## 3. The 34 MB question — what is and is not known

Per-parse budget, from native-acorn object counts × our measured struct sizes:

| | count / parse | our size | total |
| --- | ---: | ---: | ---: |
| AST `Node` structs | 32,487 | 292 B (was 536 B) | 9.5 MB |
| AST arrays | 4,275 (8,285 elements) | ~56 B empty | ~0.24 MB |
| token string values | 41,889 tokens / 126 KB of chars | 2 B/char + header | <1 MB |
| **accounted** | | | **~10 MB** |
| **measured total** | | | **43.6 MB** |

So **~34 MB per parse — ~810 bytes per token — is transient**. It is *not* the
result, and it is the dominant remaining cost in a lane where GC is 24–37% of
the time.

**Do not read the static site counts below as volume.** They say where
allocation *can* happen, not how often. Recorded only as census candidates:

- `$__vec_<T>` array carriers: **1,137** `struct.new` sites, backing arrays
  default to capacity 8 (~56 B for an empty `[]`).
- native string carrier: **1,926** sites. The second-hottest function in the
  whole parse (`__closure_352__typed_this`, 1.97% self) allocates one.
- `$AnyValue`: only 25 sites.
- boxed `f64`: 1 site (inside `__box_number`) — and its i31 fast path already
  makes every integral value in ±2^30 allocation-free, so acorn's positions and
  char codes are already free.

---

## 4. Tooling — what works, what does not

**Allocation volume, deterministic and contention-proof.** Sum inter-GC heap
growth out of `--trace-gc`: `allocated += before_i − after_{i−1}` over the
`X (Y) -> Z (W) MB` fields, divided by the parse count. The scripts I used were
throwaway (`.tmp/acornperf/`, gitignored and gone with the container) and are a
few lines each — regex the trace, sum the deltas.
This metric does not move with box load and was what made the two lowerings
attributable at all — it caught an 8.0 MB effect whose predicted value was
7.93 MB.

**Paired A/B.** Instantiate every variant binary in ONE process and run them in
rotating order, so contention drift hits all variants alike.
Wall-clock medians on this box swing ±20% between processes; interleaved
p25/median deltas are stable.

**Binary reuse.** `--inspect-binary <out.wasm>` then
`--reuse-standalone-binary <out.wasm>` — the standalone acorn compile is ~80 s
here (not the ~7 min the previous handoff saw), and reuse makes re-measurement
seconds. `--preserve-debug-names` is mandatory for a readable profile.

**Two things that do NOT work — do not spend a round rediscovering them:**

- **V8's sampling heap profiler does not see WasmGC `struct.new`.**
  `HeapProfiler.startSampling` over a 58 MB parse sampled **0.2 MB**, all of it
  attributed to a single `js-to-wasm` frame.
- **`--trace-gc-object-stats` is not available** on this Node build (accepted
  silently, prints nothing).

**So the census needs emitter support** — filed as **#3921**, which carries the
proposed shape (env-gated finalize pass inserting a stack-neutral counter after
every `struct.new*` / `array.new*`, one exported mutable global per type, since
exported globals survive `wasm-opt`'s type renumbering where a typeIdx-keyed
reader would not).

---

## 5. Recommended next steps, in order

1. **Build the per-type allocation census — #3921** (§4). Everything else in
   this lane is guesswork without it, and 34 MB is too large a number to guess
   at.
2. Only then pick the next lowering. Candidates the census would rank:
   transient vec/backing-array allocation, string carriers in the tokenizer,
   argument vectors on generic dispatch.
3. **Not a parity lever, but worth knowing:** even zeroing *all* remaining
   allocation and *all* GC would leave this lane several-fold short of node on
   this box. Allocation is the largest single named cost, not the whole gap.

## 6. Unrelated pre-existing bug found along the way

`"prop" in fnctorInstance` answers **false** in the standalone lane where the
JS-host lane answers **true** (fixture in
`tests/issue-3780-allocation-lowerings.test.ts`; 10,660 vs 830,660 on the same
program, with the value read-back half identical). It reproduces byte-for-byte
with the presence packing disabled, so it is not round 4's. This is the same
reflection hole `dev-acorn-throughput.md` §7 records for
`for…in` / `Object.keys` over fnctor instances, now with a concrete `in`
repro — which is what a bug report for it would need. **Filed as #3920**, with
the reduced two-line repro (standalone `7` vs host `1007`) verified separately
from the test fixture.
