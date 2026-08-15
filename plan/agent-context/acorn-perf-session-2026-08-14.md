# Session handoff — acorn perf program, 2026-08-14

Written at session end for whoever picks this up next (likely in a different
container — this one restarted 3+ times and destroyed unpushed work each time;
see **Environment hazards** at the bottom before doing anything).

---

## 1. What landed on `main` today

| PR | What | Perf effect |
| --- | --- | --- |
| **#4455** | **The tuned-11 defaults flip** + park-6 fix + wasm-opt 600 s timeout | **This is the one that matters** — see §2 |
| #4491 | Four next-gen levers (set-member IC, call devirt IC, flat-str IC, bool fusion) | **None** — all four default OFF by design |
| #4489 | auto-park variant-B runner-kill recognition | CI only |
| #4490 | merge-group shard rebalance 58/44 + #4157 entries 40–43 | CI only |

`src/perf-flags.ts` now exists on `main` and the eleven tuned flags are ON when
unset. The four lever flags are present but `unset ⇒ disabled`.

### #4455 took seven merge-queue attempts — the history is worth knowing

Parks 1–5 were **infrastructure**, not the change: a proven flake, then two
GitHub runner SIGTERM kill waves, then a shard slowdown (tuned emission made
standalone shards ~40 % slower, meeting a 512 MiB worker heap ceiling). Fixed
by: ir-inline copy-on-write + per-callee memoization (byte-identical), shard
`timeout-minutes` 25→40, worker heap 512 MiB→1 GiB, and #4469/#4489's
kill-wave classifiers.

**Park 6 was the first real verdict** and it was a genuine defect — but *not*
in the eleven flags. Standalone codegen emits a devirtualized method call as
`global.get $__mod_c` (a concrete GC struct) then `call $C_2` (a method with
ZERO params), so the receiver's real consumer is several instructions later and
its `extern.convert_any` comes from a *late* repair. Both late repairs attribute
operands **by position**: `fixCallArgTypesInBody` walks backward and stops at
any `if`/`block`/`loop`; `fixLocalSetCoercion` inspects only `body[i-1]`.
`smi-box-fast-path.ts` (an `if`) and `ir-inline.ts` (a `block`) each land in that
window *independently* — which is why single-flag bisection pointed in
contradictory directions. Fixed properly (`src/codegen/call-arg-producers.ts` +
`src/codegen/cross-hierarchy-operands.ts`), not gated away, so the win survives
whole. Full writeup: #4157 entry 46.

---

## 2. The measurements (all on a quiet box, `-O4` verified, no wasm-opt fallback)

### The flip is real: −13.3 %, order-reversed, clean separation

acorn standalone-dynamic lane, tuned (flags unset) vs legacy (all eleven `=0`,
byte-identical to pre-flip emission):

| leg | wasm µs | js µs |
| --- | ---: | ---: |
| 1 · tuned | 107,704 | 13,799 |
| 2 · legacy | 119,765 | 14,016 |
| 3 · legacy | 121,774 | 14,451 |
| 4 · tuned | **101,624** | 13,843 |

Tuned mean **104,664** vs legacy **120,769** → **−13.3 %** (the PR claimed
−12.0 %; independently reproduced). Both tuned legs sit below both legacy legs —
no overlap. Within-group spread 6 % / 1.7 %; between-group gap ~16,000 µs.
Node reference stable across all four legs. Ratio to Node: **8.6× → 7.5×**.

### The npm-compat dashboard CANNOT see this — do not trust it for <2× effects

`acorn · standalone · runtime dynamic` across today's CI refreshes, identical
code between several of them:

```
32,225 → 98,609 → 46,108 → 85,381 → 97,526 → 82,111
→ 82,740 → 99,826 → 103,604 → 97,719 → 71,984 → 99,622
```

A 3× swing between consecutive runs. It is one sample per merge on a shared
runner, no repetition, no order-reversal. The 71,984 → 99,622 step right after
#4455 merged **looks like a regression and is not** — it is inside the noise
this benchmark produces routinely. **Worth filing**: a CI perf lane with
repeated interleaved runs and reported variance. Until then, judge perf with a
local order-reversed A/B (~16 min for 4 legs), not the dashboard.

### Paired profile decomposition (fresh, post-flip)

wasm real work 4,245 ms vs node 750 ms = **5.7×**, after stripping profiler
overhead (`post node:inspector`, 597 ms wasm / 563 ms node — it inflates the
smaller profile far more, so never quote the raw ratio):

| bucket | wasm | vs node's ENTIRE runtime |
| --- | ---: | ---: |
| compiled user code (closures + typed-this twins) | 2,493 ms · 58.7 % | **3.32×** |
| runtime helpers | 1,490 ms · 35.1 % | 1.99× |
| object construction | 153 ms · 3.6 % | 0.20× |
| **garbage collection** | 199 ms | **0.76× — LESS than node absolutely** |

Independently reproduces entry 39 (3.19× / 2.17× / GC exonerated). **GC is not
the problem; stop looking there.** Helpers moved 2.17× → 1.99×, consistent with
the tuned set's call eliminations landing.

Bucket totals via `scripts/profile-buckets.mjs`: compiled 34.2 %, scanner
23.5 %, dynamic-lookup 14.5 % (led by `__extern_get` 4.0 %), call-dispatch
6.7 %, regexp 4.2 %, string-runtime 3.3 %, dynamic-eq 3.0 %, gc 3.4 %.

### Per-function targets (wasm vs node self-time)

| function | wasm | node | ratio |
| --- | ---: | ---: | ---: |
| `pp.fullCharCodeAt` | 120.0 ms | ~0 | **∞ (V8 inlines it away)** |
| `pp$3.currentVarScope` | 78.7 ms | ~0 | **∞** |
| `pp.readWord1` | 60.8 ms | 2.3 ms | 26.4× |
| `pp.next` | 211.7 ms | 17.0 ms | 12.5× |
| `pp$6.updateContext` | 67.2 ms | 5.6 ms | 12.0× |
| `pp.skipSpace` | 115.1 ms | 14.4 ms | 8.0× |
| `pp$5.parseSubscript` | 277.4 ms | 38.3 ms | 7.2× |
| `pp.getTokenFromCode` | 106.1 ms | 14.9 ms | 7.1× |
| `finishNodeAt` | 58.3 ms | 9.1 ms | 6.4× |
| `pp$5.parseMaybeAssign` | 117.6 ms | 34.4 ms | 3.4× |
| **`pp.nextToken`** | 108.6 ms | 60.5 ms | **1.8×** |

`pp.nextToken` at 1.8× is the load-bearing datum: same dynamic-dispatch
machinery as its neighbours, near parity. **The 7–26× ratios are missed
optimizations, not a structural wasm ceiling.**

### Why the two ∞ functions are not inlined — DIFFERENT causes

Call-graph parents, from the profile:

```
__closure_355__typed_this (pp.fullCharCodeAt, 105 ms)
    └── 100 % from __closure_686__typed_this (pp.fullCharCodeAtPos)  ← DIRECT call, still not inlined
__closure_248 (pp$3.currentVarScope, 69 ms)
    └── 98 % from __call_fn_method_0                                  ← GENERIC DISPATCHER, opaque
```

- `currentVarScope` is **unreachable to any inliner**: Binaryen can't see through
  an indirect dispatch, and `ir-inline` runs earlier, on IR, before that lowering
  exists. Called from the `inFunction`/`inGenerator`/`inAsync` getters, so every
  accessor read pays a full dynamic dispatch to run a loop that almost always
  returns on iteration 1.
- `fullCharCodeAt` is a **direct** call and still not inlined → size/budget, not
  dispatch. Hypothesis (unconfirmed): `this.input.charCodeAt(pos)` lowers to
  string-runtime helper calls that inflate the body past the inline budget.
  **Confirming this by disassembling the twin is the next concrete step.**

**Precedent that devirtualization-then-inline works here**: the acorn harness
records Binaryen worth **~0 % before #3683-S2 and 7.1 % after** — "the
monomorphic direct calls are what give it something to inline."

---

## 3. Open work

### In flight (two agents; their branches may or may not exist — CHECK FIRST)

- `impl-4405-receiver-spec` — #4405 Phases 0+1 (census, then proof coverage
  6.0 % → higher).
- `impl-post-devirt-inline` — second inlining pass after devirtualization.
  Instructed to FIRST measure whether Binaryen already handles it with
  `JS2WASM_CALL_DISPATCH_IC=1` before building anything.

Both were told to push immediately and append handoff notes to their issue
files. **Start by checking whether those branches exist on origin**; if they
don't, the work was lost to a restart and the prompts above are reproducible
from this document.

### Open PR

- **#4511** (docs) — the two architect specs + #4414. Checks were running at
  handoff.

### The specs re-scoped their issues — read them, not the issue bodies

- **#4405**: the `this`-receiver inference it asked for is ALREADY SHIPPED,
  default-ON, **97.9 % coverage** (488 twins, zero declines). Do not rebuild
  `analyzeProtoMethodWriteOnce`. The real residual is non-`this` receivers
  (4,064 asked → 244 proven → 88 inlined), 156 proven-then-declined dominated by
  `nofield:Node.*`, and **zero** write-side inlines (no emitter exists).
  Root cause of the 156: `__fnctor_Node` derives slots from constructor-body
  writes only, so acorn's whole AST payload lives in the `$resid` sidecar.
  Verdicts: per-site decline (not all-or-nothing); **keep the `ref.test` guard**
  (unguarded casts turn imprecision into traps) — get guard-free by *hoisting*.
- **#4406**: `booleanFunctionNames` already exists and its result is discarded;
  all 83 boolean fns are already swallowed into `numericFunctionNames`; the
  `__box_boolean < 100k` AC is unreachable via returns alone (`then_return = 0`).
- **#4414** (was mis-filed as #4407, which collided on main): devirtualized
  prototype-method call returns a boolean as a number.
  `("" + p.eat(5)).length` → **1**, want **4**, standalone, default flags.
  Only `JS2WASM_DIRECT_CALLS=0` fixes it — NOT typed-this, NOT numeric twins.
  **The originally-proposed `isBooleanish` veto was implemented and measured:
  repro byte-for-byte unchanged. Ruled out.** Next investigator: the result type
  chosen in the direct-call fill path (`recordDirectCallTwin` /
  `recordDirectCallGeneric` / `fillDirectCallTrampolines` in `typed-this.ts`).

### Suggested priority

1. **#4414** — a live correctness bug on `main`, small, and it sits in exactly
   the machinery both perf tracks touch.
2. **#4405 Phase 1** — `isConstLike` accepting `const` only while acorn's bundle
   is ES5 `var` is the prime suspect for the 6 % proof coverage.
3. **Post-devirt inlining** — measure Binaryen first; enabling the existing IC
   may beat writing a pass.
4. **CI perf lane with variance** — so the dashboard can resolve <2 % effects.

---

## 4. Environment hazards (these cost real work today)

- **Container restarts destroy unpushed worktrees.** Push after every meaningful
  commit. A completed, verified fix was lost this evening because it sat
  uncommitted for ~20 minutes.
- **Shell cwd resets to the repo root between every Bash call.** Heredocs land in
  the wrong directory unless you use absolute paths.
- **`git add A B` fails atomically** if any pathspec is missing — it stages
  NOTHING and a following commit silently captures only what was already staged.
- **`claim-issue --allocate` with a degraded PR scan collides.** That is how
  #4407 was double-issued; it warns, and the warning is real.
- **Azure blob storage (GitHub artifacts) is proxy-blocked here.** CI artifacts
  cannot be downloaded; recover data by re-running locally instead.
- **`compileStandaloneAcorn()` does NOT return the binary**, only `binaryBytes`.
  To disassemble, call `compile()` directly with
  `{fileName:"acorn.mjs", skipSemanticDiagnostics:true, target:"standalone", optimize:3}`.
- **An acorn compile is ~130 s.** Budget accordingly; a 4-leg A/B is ~16 min.
- **Always verify `wasmOptimized: true` / level 4** in the perf artifact before
  believing a number — a silent wasm-opt fallback (the reason for the 600 s
  timeout in #4455) invalidates any measurement.

## 5. Reproducing the measurements

```bash
# 4-leg order-reversed A/B (tuned vs all-eleven-off)
node --import tsx scripts/generate-npm-compat-report.mjs \
  --only acorn --perf-only --lane standalone-dynamic
# ...parse perfRows[].wasmUs from the JSON on stdout; repeat with the eleven =0

# paired profile + readable frame names
node --import tsx scripts/generate-npm-compat-report.mjs --only acorn --perf-only \
  --lane standalone-dynamic --preserve-debug-names --profile-runtime wasm \
  --profile-output .tmp/a.cpuprofile --profile-iterations 40
JS2WASM_CLOSURE_NAME_MAP=1 <same compile> 2> .tmp/map.log
node scripts/profile-buckets.mjs .tmp/a.cpuprofile .tmp/map.log 25
```

`scripts/profile-buckets.mjs` already buckets exactly as in §2 and accepts the
closure map, which is what makes `__closure_N` frames readable.
