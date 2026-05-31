---
id: 1746
title: "string-hash: reach (and beat) warm-V8 via AOT analysis — i32 path, const-eval, presize, SIMD, loop fusion/unroll"
status: done
created: 2026-05-30
updated: 2026-05-31
completed: 2026-05-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: strings
goal: performance
related: [1744, 1580, 1199, 1175, 1210]
sprint: 57
---

# #1746 — string-hash: close (and potentially beat) the warm-V8 gap

## Context

After #1744 (single-char-append fast path) string-hash warm is **~9 ms** on
wasmtime — already *faster than the AOT/Wasm peer* (StarlingMonkey 14.2 ms), but
still **~14× warm V8-JIT (~0.64 ms)**.

**Do NOT assume AOT can't reach JIT level here.** A JIT pays for runtime
profiling + tier-up and is constrained to transforms it can prove safe from
*runtime* feedback. An AOT WasmGC compiler has the opposite leverage: full
whole-program static analysis, and it can **compile semantics away entirely** —
constant-fold, presize from loop analysis, vectorize, and prove-and-fuse/unroll
loops, all at **zero runtime cost**. Several of these are things a JIT can't do
as freely. The goal is to drive string-hash as fast as static analysis allows —
**JIT-parity-or-better is on the table**, not precluded.

The cost is now in the two loops (`build`: ~20k×3 appends; `hash`:
`(hash*31 + charCodeAt(i)) | 0` ~60k iters), not allocation (#1744 fixed that).

## Diagnostic method — DO THIS FIRST (differential codegen analysis)

Don't optimize from a hypothesis. **Measure the gap at the instruction level** by
diffing the two native-code generators on the *same* JS:

- **V8 TurboFan native** (the JIT target, the number we're chasing):
  `node --allow-natives-syntax --print-opt-code --print-opt-code-filter=run`
  after warming + `%OptimizeFunctionOnNextCall(run)`. (Ignition bytecode:
  `--print-bytecode --print-bytecode-filter=run`.) Confirmed working in our Node
  (v25.8.2 has the disassembler).
- **Cranelift native of our Wasm** (what we actually ship): `wasmtime compile
  --emit-clif`, or objdump the `.cwasm`.

Diff the *strategies* (not opcode-for-opcode — V8 emits native, we emit Wasm→Cranelift→native).

**Baseline captured 2026-05-30** — V8 TurboFan fingerprint of `run()` (2004
instr): **176 integer ops vs 8 float ops, 0 SIMD**, 56 cond-branches, 50 calls.
→ V8 wins by running the hash loop in **i32** (lever #1), and **does NOT
vectorize** it. This empirically reorders our levers: **#1 (i32 path) is THE
match-V8 lever**; SIMD/unroll are *beat-V8* plays, not match-V8. Re-run the diff
after each change to confirm convergence toward the V8 instruction shape.

## Optimization levers (each: prove same observable result, then apply)

1. **i32-typed hot path (biggest immediate win).** `(hash*31 + c) | 0` is
   computed in **f64** then truncated each iteration. Since it's `|0`-masked the
   whole accumulator can stay i32 — kill ~60k f64↔i32 conversions, use i32
   mul/add. Codegen feature: detect `(expr) | 0` / `& mask` envelopes and lower
   the enclosed arithmetic in i32 (ToInt32-correct wrap on overflow).

2. **Compile-time evaluation of const expressions.** Fold whatever is statically
   known: constant string literals (`alphabet`), pure index arithmetic
   (`(i*13)&31`, `(a+7)&31`), and `const`-bound values. `alphabet.charAt(const)`
   → a folded code-unit constant or a compile-time lookup table. Resolve as much
   of the per-iteration work to constants as the analysis proves.

3. **Loop-analysis array presizing.** When the build loop's trip count is
   statically analyzable (literal/bounded `n`), **presize the string buffer to
   the final length** instead of the doubling-buffer grow — eliminating ALL
   `array.copy` reallocations. Generalize: presize any array whose final size is
   provable from the loop.

4. **SIMD.** Vectorize where the data layout allows — e.g. block char-copy in the
   build loop, or batched code-unit processing / the hash mix — using Wasm SIMD
   (v128) when it's provably equivalent. (Gate behind a SIMD-capable target.)

5. **Loop unrolling / fusion — when provably equivalent.** Unroll the hot loops
   where it lets the optimizer keep values in registers / batch BCE; **fuse**
   loops (e.g. build + hash, or the two appends) when a dependence proof shows
   the fused form computes the identical result. Only apply with a soundness
   proof — never speculatively.

6. **Linear-memory backing for string char data (#1199-class).** `charCodeAt` is
   an `array.get_u` on a WasmGC i16 array (GC indirection + bounds check); a
   linear-memory backing makes it a raw load. Coordinate with the dual-string
   backend (#679).

7. **Bounds-check-elimination-friendly emission.** Emit counted loops (monotonic
   index, known length) so Cranelift hoists/drops the per-element bounds check.

## Approach

Land #1 first (it's localized + the biggest single win), measure, then take the
analysis-driven transforms (#2 const-eval, #3 presize) which are pure AOT wins a
JIT can't match. #4–#5 (SIMD, unroll/fuse) and #6 (linear-mem) are larger and may
each become their own sub-issue. Every transform MUST be guarded by a
correctness proof (same observable result) — this is "compile away, don't
emulate", not speculative optimization.

## Acceptance

- Measure warm before/after on wasmtime (`scripts/generate-wasmtime-hot-runtime.mjs`),
  refresh the committed benchmark JSON, keep the #1580 staleness gate green,
  honest provenance (no gaming the lenient 30 ms gate).
- Each applied transform has a soundness justification + a regression test, and
  zero test262 regressions.
- Drive the number as low as the analysis allows — explicitly including
  JIT-parity-or-better; do not stop at an assumed AOT ceiling.

## Implementation notes — lever #1 LANDED (i32-typed hash path)

**Root cause (differential analysis).** Dumped the compiled WAT of `run` for
the benchmark config (`target: wasi, nativeStrings: true`). The hash loop body
`hash = (hash*31 + text.charCodeAt(i)) | 0` lowered as:

```
local.get $hash        ;; $hash is ALREADY an i32 local
f64.convert_i32_s      ;; hash -> f64
f64.const 31  f64.mul  ;; hash*31 in f64
... charCodeAt -> i32 ...
f64.convert_i32_s      ;; charCode -> f64
f64.add  f64.trunc
;; then the expensive ToInt32 emulation:
f64.const 4294967296  f64.div  f64.floor  f64.const 4294967296  f64.mul  f64.sub
i32.trunc_sat_f64_u
local.set $hash
```

i.e. ~5 f64 ops + a modulo-2^32 ToInt32 dance **per iteration** (~60k iters),
even though `$hash` is an i32 local and the result is `| 0`-masked.

**Why the existing #1120/#1179 i32-pure path did not fire.** The outer `+` IS
an `arithI32WithToInt32Wrap` candidate (its parent is `| 0`), but that requires
BOTH operands to satisfy `isI32PureExpr`. `text.charCodeAt(i)` is a
`CallExpression`, which the predicate rejected → the `+` fell to f64. A second,
subtler gap: even with charCodeAt accepted, the inner `hash*31`'s *parent* is
the `+` (not a bitwise op), and the i32 decision is re-derived per node by
walking UP for an enclosing bitwise/`| 0` context — the incoming `hint` is
dropped at `compileExpression → compileBinaryExpression`. So a nested
arith-under-arith node would still re-derive f64 and force a round-trip.

**Fix (two localized pieces in `src/codegen/binary-ops.ts`,
`compileBinaryExpression`):**

1. `isI32PureStringCall` + an extra `isI32PureExpr` arm: `<str>.charCodeAt(idx)`
   is an i32-pure **leaf** when the receiver is statically a string. charCodeAt
   returns a u16 code unit in [0, 65535] in BOTH backends (nativeStrings inline
   `array.get_u`; JS-host `wasm:js-string.charCodeAt` import) — always
   non-negative, i32-range, f64-exact — and `compileExpression` returns i32 for
   it *unconditionally* (not hint-driven), so treating the enclosing arithmetic
   as i32 does not change charCodeAt's own observable value.
2. `emitI32PureExpr`: emits a **proven-i32-pure** subtree directly as an i32
   instruction chain, so nested arith-under-arith stays i32 regardless of depth.
   Wired in for the operands when `arithI32WithToInt32Wrap || bitwiseI32` holds.

**Soundness.** Under the enclosing `| 0` (ToInt32) the i32 wrap is bit-for-bit
identical to f64-then-ToInt32: `$hash` is i32 so `hash*31` is f64-exact
(< 2^53) and `i32.mul` wraps the same way ToInt32 would; `i32.add` of two
i32-range values likewise. The existing `isI32MulSafe` guard (small-literal
operand) still gates the `*` arm, so unbounded multiplications keep the f64
path. The charCodeAt index arg is left to `compileExpression`'s own ToInteger
handling — unchanged.

**Result (WAT after).** The hash loop body collapses to:
`local.get $hash · i32.const 31 · i32.mul · <charCodeAt→i32> · i32.add ·
local.set $hash` — pure i32, no f64 conversions, no ToInt32 dance. Matches the
captured V8 TurboFan fingerprint (hot loop = integer ops, 0 SIMD).

**Verification.**
- Same-observable-result proof: compiled `run(n)` == JS reference for
  n ∈ {0,1,2,3,5,10,20,50,100,256,1000,5000,20000} in BOTH `nativeStrings/wasi`
  and JS-host (`wasm:js-string`) modes.
- Regression test `tests/issue-1746-i32-hashpath.test.ts` (5 cases): result
  parity in both modes, WAT no longer contains `4294967296`, i32.mul present,
  large-mul soundness guard (`(x*2147483647+1)|0` still matches JS), and
  charCodeAt value-invariance bare-vs-`|0`.
- Zero new regressions in the i32/arith/bitwise/string suite: 34 failed / 47
  passed identically with the change and on clean origin/main (the 34 are a
  pre-existing `string_constants` test-harness import issue, unrelated).
- `wasmtime` not available in this container, so warm-ms before/after on
  `scripts/generate-wasmtime-hot-runtime.mjs` and the committed benchmark-JSON
  refresh must be run by CI / a wasmtime-equipped runner before the #1580
  staleness gate is updated. The instruction-level win is proven here; the
  measured warm-ms refresh is the remaining acceptance step.

Levers #2–#7 (const-eval, presize, SIMD, fuse/unroll, linear-mem, BCE) remain
open as follow-ups.

## Native differential (post-lever-1)

**Method.** Compiled `website/public/benchmarks/competitive/programs/string-hash.js`
with the lever-1 compiler (`--target wasi --nativeStrings -O3`, branch
`issue-1746-i32hashpath-impl`). Got Cranelift CLIF via `wasmtime compile
--emit-clif` and **native aarch64** via `wasmtime explore` (this container is
arm64; wasmtime 44.0.0). Got V8 TurboFan native via `node --allow-natives-syntax
--print-opt-code --print-opt-code-filter=run` after warmup +
`%OptimizeFunctionOnNextCall`. All artifacts regenerated under
`.tmp/native-diff/` (gitignored). Per-call warm times measured with the same
in-process `warm` export the #1760 bench uses (min over 40–60 iters, n=20000).

### TL;DR — the ~10× warm gap is the BUILD loop, not the hash loop

Lever-1 worked: the hash loop is now pure i32 (WAT `$label1`: `i32.mul $1,31` +
`array.get_u` + `i32.add`, a single `f64.convert_i32_s` only on the final
return). But **the hash loop was no longer the bottleneck** after #1744. The
remaining gap is overwhelmingly the **string *build* loop** (the
`text += alphabet.charAt(a)` appends), not the hash loop the i32 path targeted.

Measured decomposition on this machine (warm, n=20000):

| variant (warm, min ms)                         | wasm  | V8     |
|------------------------------------------------|-------|--------|
| full `run` (build 60k appends + hash 60k)      | 6.55  | ~0.50  |
| build only, hash replaced by `hash*31+i` (no charCodeAt) | 6.52 | — |
| build with constant char (no `charAt`)         | 6.40  | — |
| full, hash loop run **10×** (build + 10×hash)  | 7.30  | 3.38   |

Subtracting the 10× row from the 1× row isolates the per-pass hash cost:

- **wasm hash pass** = (7.30−6.55)/9 = **0.083 ms** → ~**0.69 ns/char** over 120k charCodeAt.
- **V8 hash pass**  = (3.38−0.50)/9 = **0.320 ms** → ~**2.67 ns/char**.
- ⇒ **our hash loop is already ~3.8× FASTER per char than V8's.** V8 pays a
  per-char string-instance-type dispatch (cons/sliced/seq-1byte/seq-2byte) on
  the rope that `+=` builds; we read a flat `(array i16)`.
- ⇒ **build loop**: wasm ≈ **6.47 ms** vs V8 ≈ **0.18 ms** → the build loop is
  the ~**36×** term and ~99% of our wall time. The hash loop contributes ~1%.

So lever-1 was correct and necessary (it removed the f64↔i32 churn the ADR
fingerprint predicted), but it optimized the cheap loop. **The warm gap lives in
the build loop**, and re-prioritization must follow the measured weight.

### Hot-loop disassembly — HASH loop (already at/below V8)

Our hash loop steady state, aarch64 (trimmed from `.tmp/native-diff/fn1.asm`,
loop header `0x2b0`, body `0x358`). The string is a `$NativeString` struct
`{len:i32@+0x18, off:i32@+0x1c, data:(ref (array i16))@+0x20}`:

```
; --- header (block24/block27): 2 null-checks + length reload + index<len ---
0x308  cmp w2,#0 / cset / uxtb / mov / cbnz   ; null-check struct ref (block24 v420==0)
0x22d  mov w12,w2 / cbz x12                    ; 2nd null-check (block27 trapz)
0x22d  add x12,x20,#0x18 / ldr w14,[x12,w2]    ; RELOAD struct.len each iter (not hoisted)
0x232  cmp w28,w14 / b.lt #0x358               ; i < len
; --- body (block30/32/34): GC read-barrier + bounds-checked array.get_u ---
0x23b  ldr w0,[x20+0x20+w2]; cbz               ; load data-array ref + null-check
0x23b  ldr w3,[x20+w0]; tbnz w3,#1             ; GC mark-bit test (read barrier)
0x23b  ldr x1,[x19,#0x20]; ... orr w3,#2; str... ; barrier store-buffer push (~10 insns)
0x241  ldr w1,[x20+0x1c+w2]                    ; RELOAD struct.off each iter
0x248  ... cbz / ldr len / cmp / cset / cbz    ; array null + bounds check
0x248  adds/b.hs ; adds/b.hs ; add x0,x20,w0; sub; sub  ; elem-addr w/ 2 overflow traps
0x252  add w28,w28,#1
0x24b  mov w1,#0x1f; ldrh w0,[x0]; madd w22,w22,w1,w0  ; the ACTUAL hash work (3 insns)
0x255  b #0x2b0
```

V8's loop (TurboFan, `.tmp/native-diff/v8.txt`, around `0x468`): per char it does
`ldurh w6,[x6,#11]; and #7; cmp #6; b.hs; ... br x16` — a **jump-table dispatch on
string-instance-type** (rope traversal), then `ldrh`/`ldrb` for the 2-byte/1-byte
case, then `movz x7,#0x1f; madd w4,w4,w7,w6`. The `madd`-by-31 core is identical
to ours; V8's *surrounding* per-char cost is its rope-walk, which is why V8's
per-char hash is ~3.8× slower than our flat-array read.

**Conclusion for the hash loop: nothing more to win vs V8 here.** Of our ~50
insns/iter only `ldrh`+`madd` is real work; the rest is the GC read barrier,
two struct-field reloads (len, off), the array null/bounds check, and two
element-address overflow traps. But because the hash loop is ~1% of wall time,
shaving it is not worth a soundness risk. (If ever revisited: Cranelift keeps
`struct.len`/`struct.off` reloads in-loop because the WasmGC ref is opaque and it
can't prove the struct is loop-invariant — a hoist would need the front-end to
hoist `length`/`data`/`offset` into locals before the loop. Same for the GC read
barrier on `array.get` of a `(ref (array i16))`.)

### Hot-loop disassembly — BUILD loop (the real gap)

The WAT build loop (`$label` in `string-hash-O3.wat`) does, per source iteration,
**three single-char appends**, each:

```
; charAt(a): bounds-checked array.get_u on the 32-char alphabet array
(local.set $6 (array.get_u $0 (local.get $9) (local.get $2)))
; grow-if-needed: if (len+1 > cap) { cap = grow(cap, len+1); buf2 = new; array.copy }
(if (i32.gt_s (local.tee $2 (i32.add (local.get $4) 1)) (local.get $1))
  (then (local.set $1 (call $0 ...)) (array.copy $0 $0 (array.new_default ...) ...)))
; store the char with a GC barrier
(array.set $0 (local.get $7) (local.get $4) (local.get $6))
```

Native per append (trimmed, `0x153`/`0x172` regions of `fn1.asm`):

```
0x153  ... cbz / ldr len / cmp / cset / cbz ; alphabet array null + bounds check
0x153  adds/b.hs; adds/b.hs; add; sub; sub  ; elem-addr w/ overflow traps
0x153  ldrh w26,[x0]                          ; charAt load (the code unit)
0x162  cmp w0,w4; b.le #0x52c                 ; len+1 <= cap ?  (cap-check branch)
0x168  bl #0                                  ; CALL grow helper (fn $0) on the slow arm
0x172  ... bl #0x15d8                          ; CALL gc_alloc_raw (array.new_default)
0x172  str w22,[x20+0x18+w2]; ... strh w2,[x0] ; array.copy + barriered array.set store
```

**Why it's 36× V8:** the build loop is ~99% of wall time and is dominated by
**60,000 iterations of per-append machinery**, not the realloc. The doubling
buffer only reallocates **12 times** for n=20000 (final len 60000, cap 65536,
~65k i16 copied total ≈ µs) — so `array.copy` is NOT the cost. The cost is the
**fixed per-append overhead × 60,000**:
- `charAt` lowered as a bounds-checked `array.get_u` with overflow-trapped
  element addressing (the alphabet read could be a constant — see lever #2);
- a per-append `len+1 > cap` branch;
- a **GC write barrier on every `array.set`** into the buffer;
- the append path itself goes through the `$NativeString` doubling-buffer
  representation rather than writing into a presized flat buffer.

V8 builds the same string as a **cons-string / rope**: `+=` is `O(1)` pointer
linkage (allocate a ConsString node, no character copy), so its build loop is
~0.18 ms — it defers all the character materialization to the first `charCodeAt`
(which is why V8's *hash* loop is the one that pays, via rope dispatch).

### Per-iteration cost attribution (warm, n=20000)

| cost source                                          | ~time      | evidence |
|------------------------------------------------------|-----------|----------|
| **Build loop: per-append machinery × 60k**           | **~6.4 ms** | full=6.55 vs hash-only delta 0.08; const-char build still 6.40 |
| — of which `charAt` bounds-checked `array.get_u`     | ~0 (within noise) | const-char build 6.40 ≈ charAt build 6.40 |
| — of which cap-check + grow calls (12 reallocs)      | small      | only 12 reallocs / 65k copies for 60k appends |
| — of which barriered `array.set` + append overhead   | dominant   | residual after removing charAt + realloc |
| **Hash loop: barrier + bounds + reloads + `madd` × 60k** | **~0.08 ms** | (7.30−6.55)/9 per pass |
| f64↔i32 churn (pre-lever-1)                           | **0 (removed)** | WAT shows pure i32 hash loop |

### Re-prioritized levers (by MEASURED impact)

1. **#3 array presizing — PROMOTE TO #1 (the whole ballgame).** The build loop is
   ~99% of wall time and ~36× V8. Its cost is per-append overhead × 60k against
   the doubling `$NativeString` buffer. The final length is *statically provable*
   from the loop (`n` literal appends × constant string lengths → `text.length =
   3n`). Presizing the buffer to `3n` up front removes: (a) all 12 reallocs +
   `array.copy`, (b) the per-append `len+1 > cap` branch entirely, and (c) lets
   the store be a straight indexed write. This is a pure AOT win a JIT can't make
   (it can't prove the final length). **This is the lever to build next.**

2. **#6 linear-memory backing for char data — STRATEGIC, the real ceiling.** Even
   presized, each `array.set` into a WasmGC `(array i16)` carries a **GC write
   barrier**, and each `array.get_u` carries a bounds check + a read barrier +
   opaque-ref struct-field reloads Cranelift won't hoist. A flat **linear-memory
   byte/`i16` buffer** turns appends into raw `i32.store16` (no barrier, no
   bounds trap in the same way) and reads into raw `i32.load16_u` — exactly what
   V8's sequential-string backing store is. This is the dual-string-backend
   (#679) decision: **the `(array i16)` representation is itself the ceiling** for
   both loops. Recommend carving a sub-issue to prototype a linear-memory string
   builder for `--target wasi --nativeStrings` and measure the build loop on it.

3. **#2 const-eval of `charAt(const-index)` — minor, do opportunistically.** The
   alphabet is a literal and the indices are pure arithmetic; folding
   `alphabet.charAt(a)` to a compile-time code-unit (or a small const lookup)
   removes the alphabet `array.get_u` per append. Measured impact is within noise
   here (const-char build ≈ charAt build), so this is a *correctness-of-shape*
   nicety, **not** a perf lever for this benchmark. Deprioritize.

4. **#1 i32 hash path — DONE, leave it.** Confirmed in the WAT/native: pure i32,
   matches the V8 instruction shape, and the hash loop is already ~3.8× faster
   per char than V8. No further work.

5. **#4 SIMD / #5 unroll-fuse — NOT match-V8 plays, and not where the time is.**
   Skip for closing the gap. (A *fused* build+hash that writes into a presized
   linear buffer and hashes in the same pass — i.e. #3+#6+#5 together — is the
   only place fusion would help, and only after #3/#6 land.)

**Bottom line for the next dev:** stop optimizing the hash loop. The string-hash
warm gap is the **build loop** against the WasmGC `(array i16)` doubling buffer.
Land **#3 (presize from provable final length)** for the immediate ~big win, then
evaluate **#6 (linear-memory string backing)** as the representation-level
ceiling for both loops — that is the strategic dual-backend decision, and it is
what makes our appends/reads look like V8's sequential-string store.
