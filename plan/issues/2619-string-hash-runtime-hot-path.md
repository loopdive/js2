---
id: 2619
title: "string-hash runtime hot-path improvement (follow-up to #1580)"
status: done
completed: 2026-06-22
assignee: ttraenkler/dev-symbol-2610
sprint: 65
created: 2026-06-22
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: performance
area: codegen
related: [1580, 2621]
goal: performance
language_feature: strings, map-set
---

# #2619 — string-hash runtime hot-path improvement (follow-up to #1580)

Sprint-65 follow-up to #1580. The runtime string-hash helper feeds Map/Set/
object string-keyed lookups, on the benchmark hot path.

## Profiling (2026-06-22, wasmtime 44.0.0, --invoke warm, GC+FR+EH+TC flags)

### Runtime hash helper

`__hash_anyref` — `src/codegen/map-runtime.ts:350`. Used by every Map/Set/object
string-keyed `set`/`get`/`has`. String arm = FNV-1a over UTF-16 code units, one
`array.get_u` + `xor` + `mul` per code unit (lines 432-457). Hash output is
**never observable** — it only selects a bucket; key equality is the
`ref.eq` / `__same_value_zero` chain walk. So the mixing can change freely as
long as it stays internally consistent.

### Measured cost (isolated, pre-built keys, no concat in the timed loop)

| Workload                            | Result                                        |
| ----------------------------------- | --------------------------------------------- |
| short keys (~5 ch), 500k lookups    | ~33-45 ms → ~70-90 ns/lookup                  |
| long keys (~30 ch), 500k lookups    | ~48-51 ms → ~96-102 ns/lookup                 |
| full Map set+get (concat keys), 20k | ~78-112 ms                                    |
| lookups-only (concat keys), 200k    | ~380-580 ms (~2 µs/lookup — concat-dominated) |

**Per-code-unit FNV cost ≈ 1 ns** (the +25-char delta adds only ~25 ns). The
inner loop is already cheap. The ~70-90 ns/lookup fixed overhead is dominated by
**correctness-required** work: `typeof_number`→`typeof_string` dispatch
(`extern.convert_any` + two calls), `__str_flatten`, `ref.cast`, `struct.get`,
bucket read, and the `ref.eq`/`__same_value_zero` chain walk.

### The landing-page "string-hash" benchmark does NOT use `__hash_anyref`

`website/public/benchmarks/competitive/programs/string-hash.js` hashes with a
**userland** `hash = hash*31 + charCodeAt(i)` loop, not the runtime helper.
That benchmark is already ~1 ms warm AOT (build-loop ~250-300 µs, hash-loop
~680-700 µs) — competitive (StarlingMonkey 14.2 ms, Javy 36 ms). Changing
`__hash_anyref` moves the headline by **0 %**.

## Conclusion

A safe FNV unroll / word-at-a-time would shave only the ~1 ns/char inner loop:
~2-3 ns on a typical 7-char key = **~3 % on a Map lookup, 0 % on the named
benchmark** — while adding remainder-loop complexity to a hot path exercised by
every Map/Set/object string-keyed test262 case (an off-by-one would silently
corrupt hashing → broad regression). Marginal win, real correctness risk.

The **real** string hot-path cost in a realistic Map workload is the key string
**concatenation** (each `"key_"+n` allocates a `$NativeString`; full set+get
78-112 ms vs pre-built-key lookups 33-45 ms) — i.e. the string-builder/concat
"build loop" #1580 already flagged as the remaining gap. That is a different,
larger effort (string-builder/concat codegen), not "string-hash."

## JIT-gap attempt (user-directed, 2026-06-22)

The user directed: CHASE THE JIT-GAP — attempt the codegen optimization to
narrow the ~3× vs the JS-JIT/vm lane. Did a real, measured attempt against the
**landing-page** `string-hash` program (userland `charCodeAt` hash, not
`__hash_anyref`). Isolated wasmtime measurements (n=20000, 4 warmups,
`--invoke`):

### Phase split (current main, optimize:3)

| Phase                              | warm µs                                     |
| ---------------------------------- | ------------------------------------------- |
| full (build + hash)                | ~915 (median ~973 over 11 samples; min 909) |
| hash phase only (over flat string) | ~675                                        |
| build phase (`text += charAt`)     | ~240                                        |

### Root-cause probes

1. **FLOOR — hash over a pre-extracted `number[]` (zero string access):**
   ~600-737 µs ≈ **same** as hash-over-string (~675 µs). ⇒ `charCodeAt` string
   access is NOT the bottleneck; an inline `array.get_u` would barely move the
   needle. The loop is f64-arithmetic-latency-bound, so the per-char
   bounds-check + `length` call in the `charCodeAt` lowering is hidden under the
   arithmetic latency.
2. **f64-number hash vs native-i32-typed hash over the same codes:** ~600 µs
   **both**. ⇒ `wasm-opt` already narrows `(h*31+cc)|0` to i32 arithmetic;
   there is no f64→i32 narrowing win to capture.

### Conclusion

The ~675 µs hash phase is dominated by per-element loop work (GC-array
bounds-check + arithmetic + loop overhead) that is **already optimized**. The
residual ~2-3× vs the JS-JIT/vm lane (~330 µs) is **Cranelift-AOT-vs-V8-JIT**
(bounds-check elimination, regalloc, loop specialization) — NOT something a
front-end codegen change addresses. No safe, semantics-preserving codegen edit
meaningfully narrows it (eliminating the build phase entirely still leaves
~675 µs, still 2× the JIT lane). This is the "real attempt → no safe win →
refresh-JSON-and-close" outcome.

## Part 2 — string-builder / concat hot-path scope (epic-vs-bounded gate)

The realistic Map-key workload's cost is the key `"key_"+n` concatenation
(full set+get 78-112 ms vs pre-built-key lookups 33-45 ms). Scoped the two
concat sites that matter:

- **Build loop (`text += charAt`)** — **already optimized**. Presize (#1761)
  fires for this exact loop shape (INIT=0, `i<n` invariant, `i++`, 3
  unconditional 1-unit appends): one `array.new_default(n*3)` up front, no
  doubling growth. Confirmed: presize-on binary 3614 B vs presize-off 3771 B
  (the growth path is elided). Materialized read is cached in `text$mat`
  (#1580). Nothing bounded left here.
- **One-shot `"key_"+n` (number→string + ConsString)** — inherently allocates
  a `$NativeString` per call; the key string MUST be materialised to hash/store
  it. No safe codegen avoids that allocation.

### Verdict: EPIC → STOP (documented as follow-up #2621)

There is **no bounded, semantics-preserving front-end codegen win** that narrows
the ~2-3× JS-JIT gap. Every lever is already optimized (presize, mat-cache,
i32-narrowing) or inherent (f64 = JS numbers; key concat must allocate;
GC-array bounds-checks vs JIT elimination). The sole remaining lever —
per-element GC-array bounds-check elimination in counted loops — is epic /
out-of-repo (whole-program range analysis with a linear-backend-only payoff, a
Cranelift upstream concern, or a SIMD/linear-memory string representation). See
**#2621** for the full epic writeup; deferred to backlog for user
prioritisation.

## Resolution

1. **JSON refresh (bounded, landed in this PR):** the committed
   `wasm-host-wasmtime-hot-runtime.json` string-hash WARM `wasmUs` was
   **3930 µs** — 4.3× too pessimistic (stale from the #1580-era measurement).
   Reproduced the generator's EXACT warm driver (5 warmup + 40 measured,
   min-per-call, optimize:3, real `string-hash.js`): **~920 µs** (910-984 µs
   over 7 outer samples). Refreshed the warm row + provenance.
   - **Cold `wasmUs` left as-is** — a faithful refresh needs the Rust cold-host
     (`pnpm run refresh:benchmarks:wasmtime`, cargo not on this container) and
     a wasmtime build where `gc=y,function-references=y` alone suffices (this
     container's wasmtime 44.0.0 needs `+exceptions,+tail-call` to precompile
     current output). Overwriting cold with a mismatched-method number would be
     worse than leaving it; documented in the cold row's `wasmProvenance`.
   - **Cold-row follow-up:** regen the cold `wasmUs` on a cargo-equipped runner
     via `pnpm run refresh:benchmarks:wasmtime`; the `benchmark-refresh` CI on
     push-to-main may also cover it. Not blocking this bounded warm fix.
2. **Epic follow-up #2621** filed for the bounds-check-elimination lever.

Probe artifacts: `$CLAUDE_JOB_DIR/tmp/{variants,floor,i32hash,gen-warm,presize-check,hashbench*}.mts`.
No codegen change made — JSON + issue-file only.
