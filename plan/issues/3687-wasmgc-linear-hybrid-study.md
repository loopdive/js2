---
id: 3687
title: "DON'T BUILD IT: a WasmGC/linear-memory hybrid buys nothing — there is no stable backend advantage to hybridise"
status: wont-fix
created: 2026-07-27
updated: 2026-07-27
completed: 2026-07-27
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: analysis
area: codegen
language_feature: compiler-internals
goal: performance
related: [3673, 3686, 1584, 1852, 3685]
---

# #3687 — WasmGC / linear-memory hybrid: measured, and the answer is no

## Verdict

**Do not build a hybrid — not the general one, not the narrow one.**

The argument is *not* "#3686 dissolves linear's advantage" (it doesn't, on
its own — priced below at ~10–25 %). The argument is stronger and better
supported:

> **There is no stable backend advantage to hybridise.** The sign of
> `linear − GC` on parser-shaped work flips — in both directions, three
> times — under one-word source changes that touch no memory-model
> property. A hybrid needs a durable per-representation advantage to
> allocate work across. Measured, that advantage does not exist; what
> exists is per-construct **lowering quality**, which differs between the
> two lanes almost arbitrarily and is fixable in place on either.

Everything below is measured on this branch, `-O3`, interleaved lanes,
rotating order, deep warm, min-of-batches, checksums asserted identical.
Two independent reproductions of every headline number.

## Headline corrections to #3673's "Linear memory vs WasmGC (measured)"

Two of the three published rows do not survive contact with a corrected
workload. Both corrections point the same way: **against** the hybrid.

### Correction 1 — the 5.9x parse win was measured on a workload that allocates ELEVEN nodes

#3673's W3 ("parse + AST build", linear 5.9x faster) feeds a
recursive-descent expression parser an input built from

```
a0 + b0 * (c0 - d0 / 2) + fn0(x0, y0 * 3, (z0 + 1))
```

The toy grammar has **no call syntax**. After `fn0` is taken as a primary,
the following `(` is neither `*`/`/` nor `+`/`-`, so `parseAdd` returns.
Instrumented (`.tmp/w3-sanity.mjs`):

```
tokens=431   nodes allocated per parse = 11   cursor stopped at token 11/431
```

**420 of 431 tokens are never visited.** The workload that was used to
conclude "bump allocation vs `struct.new` is ~1:1" allocates 11 objects; it
cannot have tested an allocator, a tree walk, or a working set. At that
size the measurement is dominated by per-call fixed costs.

Removing the call syntax so the grammar consumes the whole stream
(`.tmp/w3-fixed-bench.mjs`, everything else identical) gives a completely
different and *stable* picture:

| N | chars | tokens | nodes/parse | node | GC | linear | linear ÷ GC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 169 | 79 | 63 | 0.00113 | 0.00637 | 0.00400 | 0.63x |
| 16 | 727 | 319 | 255 | 0.00510 | 0.02574 | 0.01567 | 0.61x |
| 64 | 3127 | 1279 | 1023 | 0.02329 | 0.11223 | 0.07396 | 0.66x |
| 256 | 13819 | 5119 | 4095 | — | — | **TRAP** | — |

Per allocated-and-traversed node the cost is flat across a 16x size sweep:
**node ~18–23 ns, linear ~62–72 ns, GC ~101–110 ns.**

So linear's parse advantage is **1.5x, not 5.9x** — and the 5.9x figure
should be treated as retracted. (N=256 also reconfirms the round-37 arena
ceiling exactly on prediction: 409,500 allocations → `memory access out of
bounds`.)

### Correction 2 — even that 1.5x is not a memory-model property. It inverts on a one-word change.

Same corrected workload at N=64 (1023 nodes), three variants that keep the
algorithm, the traversal and the allocation count identical and change only
which *construct* carries the parser state (`.tmp/w3-ablate2.mjs`, two runs):

| variant | GC | linear | linear ÷ GC |
| --- | --- | --- | --- |
| **V0** `class St` cursor + `class Node` (the published shape) | 0.1059 / 0.1094 | 0.0694 / 0.0741 | **0.66x / 0.68x** — linear faster |
| **V1** `number[]` cursor + `class Node` | 0.1084 / 0.1103 | 0.1152 / 0.1366 | **1.06x / 1.24x** — GC faster |
| **V2** `number[]` cursor + `number[]` node arena | 0.0934 / 0.0566 | 0.3123 / 0.2000 | **3.35x / 3.53x** — GC faster |

Read down the columns. As constructs move from classes to arrays the
**linear lane degrades monotonically** (0.069 → 0.115 → 0.312) while the
**GC lane improves** (0.106 → 0.108 → 0.093). Linear is good at class field
access and bad at array element access; WasmGC is the reverse. Neither
ordering is a property of "objects on a managed heap" versus "bytes at an
offset" — both lanes lower a class field to a static-offset load and an
array element to a bounds-checked indexed load. These are **lowering
quality** differences, and they are fixable in place, on whichever lane
has them.

A hybrid would have to decide, per value, which backend to place it on.
The evidence says that decision has no stable answer: it depends on which
lowering path each backend's front end happens to take for the exact
source construct, which changes as either lane is improved.

## 1. Where does the GC lane's parse cost actually go? (deliverable 1)

### Priced directly with a hand-written WasmGC control

`.tmp/ast-scaffold.wat` + `.tmp/ast-scaffold-bench.mjs` — three hand-written
lanes over one identical algorithm (build a 2^d−1 `$Node` tree, then walk it
reading 4 fields per node), differing **only** in how a field read is
spelled:

- `bare` — `struct.get` on a statically typed `(ref null $Node)`. The #3686
  end state.
- `cast` — plus `ref.test` / `ref.cast` re-narrowing and the class-tag check
  (#3686 items 1+2).
- `scaf` — plus the `extern.convert_any` / `any.convert_extern` round trip
  and the null-check-throw block, i.e. the **full** shape our `-O3` module
  emits (#1947 item 1 / #3686 item 3). Op mix per read matches the census of
  our real `checksum`: `ref.cast` ×2, `ref.test` ×1, `extern.convert_any` ×3,
  `any.convert_extern` ×1, `ref.is_null` ×1, throw-block ×2.

At 1023 nodes, all four lanes returning checksum 18423 / 6141:

| lane | build+walk ms | ns/node | walk-only ms | vs bare |
| --- | --- | --- | --- | --- |
| hand WasmGC **bare** | 0.0186 | 18.2 | 0.00762 | 1.00x |
| hand WasmGC **cast** | 0.0206 | 20.1 | 0.00980 | 1.29x |
| hand WasmGC **scaf** | 0.0204 | 19.9 | 0.00940 | 1.23x |
| build-only control | 0.0109 | 10.7 | — | 0.59x |
| node (same algorithm) | 0.0306 | 29.9 | 0.01529 | 2.01x |

**Total scaffolding: 0.45–0.53 ns per field read**, consistent at depth 9
and depth 10. The externref round trip measures at ~0 (−0.05 to +0.30
ns/read across runs) — on V8 `extern.convert_any` / `any.convert_extern` are
representation no-ops. Allocation is 59 % of the bare lane.

**This is a genuinely uncomfortable result for #3686's framing and it should
be recorded as such:** the op *counts* are real (38 `ref.cast` + 45
`ref.test` + 25 `throw` + 71 extern conversions in one `parsePrimary`), but
V8 executes them cheaply. Priced in isolation the whole cast/null/extern
scaffolding is worth **+10–16 % on build+walk** and **+23–29 % on a pure
walk** — not a multiple. Two hand-written WasmGC lanes, one of them carrying
the *complete* scaffolding, both beat V8 on the same algorithm (19.9 vs 29.9
ns/node).

### So what is the other 5x?

Our GC lane runs the corrected W3 at 103.5 ns/node against the hand-written
bare lane's 18.2. The scaffolding accounts for ~2 ns of that. The call
census of the `-O3` `parsePrimary` says where the rest is:

```
calls in parsePrimary: $9 ×4  $19 ×4  $10 ×4  $11 ×4  $2 ×2  $0 ×4  $5 ×1
  $9  (f64)      -> (ref extern)     __box_number
  $10 (externref)-> f64              __unbox_number
  $11 (externref)-> i64              bigint arm
  $19 (externref)-> i32              truthiness arm
  $0  (ref null $1) -> (ref $3)      object -> STRING
  $2  (ref $3, ref $3) -> i32        STRING equality
  $5                                 parseAdd (recursion)
```

`$3` is the string struct type. Reading the surrounding wat, this is the
**generic `===` ladder**: `tk[st.i] === 40`, where both operands are
statically `number`, lowers to box-both-to-externref then a dispatch chain
that tests the bigint arm, then the *object→string→string-compare* arm, then
`ref.eq`, and so on. Four boxes, four unboxes and two string comparisons per
parsed token.

That — dynamic re-dispatch of an operator on values that have been laundered
through `externref` — is the GC lane's real 5x, and it is the
**typed-value-flow** programme (#3685 / #1584 / #1852 / #1947 item 1), not a
memory-model question. The linear lane does not pay it (it pays its own
`f64.gt(f64.abs …)` truthiness dance instead, which is cheaper).

### Estimate: where does GC land once #3686 lands?

Honest bounds, not a single number:

- The scaffolding #3686 names is worth **~10–25 %** of the parse+AST half,
  measured. That moves the GC lane from ~0.106 ms to ~0.085–0.095 ms at
  N=64.
- Linear's V0 figure is 0.069 ms. **#3686 alone does NOT cross it.** Say so
  plainly: the hybrid case does not collapse *because of #3686*.
- It collapses for a different and more robust reason — V1/V2 above. Change
  the cursor from a class to an array, with **no compiler change at all**,
  and GC already wins. The 1.5x is not a property either side owns.
- The bigger GC lever is the `===`/box/unbox ladder, worth several-fold and
  entirely inside the GC lane's own front end.

## 2. What a hybrid would actually cost (deliverable 2)

Even if the numbers had come out the other way, the engineering bill is not
"pick a representation per type".

**How does a GC `$Node` hold a pointer into linear memory?**
As `(field $src i32)` — a raw byte offset. Wasm permits this and enforces
nothing about it. The collector will not trace it, will not keep the target
alive, and will not update it. You have re-introduced an untraced raw
pointer inside a managed object, which is precisely the invariant WasmGC
exists to provide. There is no `ref`-typed handle to linear memory; the type
system stops at the boundary.

**Who owns and frees the buffer?**
The linear backend's allocator is a **bump arena that never reclaims**
(`__malloc`, `src/codegen-linear/runtime.ts:95-105`), memory is capped at
`{ min: 1, max: 256 }` = **16 MiB** (`runtime.ts:64`), and a `memory.grow`
returning −1 is *deliberately* not branched on (`runtime.ts:101-102`) —
the subsequent store traps. Measured here at N=256: trap at ~409,500
allocations, no diagnostic. So:

- with `allocator: "bump"`, a long-lived GC object outliving the arena's
  16 MiB is a guaranteed trap;
- with `allocator: "arena-reset"` — the *right* mode for parse-then-discard —
  every reset invalidates every outstanding `i32` **and there is no way to
  find the GC objects holding them.** Reset makes dangling certain rather
  than possible.

Fixing that needs either (a) a GC-visible root set over linear blocks — i.e.
re-implementing tracing for the region WasmGC was adopted to avoid tracing
by hand — or (b) a pinning/ownership discipline with explicit lifetimes,
which is a **language-level** change (ownership annotations in the source),
not a codegen change. As the task framing put it: a hybrid that needs a
pinning/ownership discipline is a categorically different proposition from
one that picks a representation per type. This one needs the discipline.

**What happens at the boundary — copy, view, or pin?**

- *Copy* defeats the purpose and is already measured: the linear lane
  re-copies its 909-byte literal from the data segment into a fresh arena
  block byte-by-byte on every call (#3673's W2 mechanism note).
- *View* needs `(ptr, len)` fat pointers plus a liveness guarantee — i.e.
  the pinning problem again, now on every value that crosses.
- *Pin* is the ownership discipline above.

**Host / JS-string interop.**
`wasm:js-string` values live in V8's heap and are reachable as `externref`;
a linear-memory string is bytes we must marshal in and out on every host
call. The dual string backend (#679) resolves this by picking **one**
representation per target. A hybrid puts **two** string representations in
one module, so every `string`-typed value needs a discriminator and every
operation in `string-ops.ts` needs two arms — combinatorial, on the file
that is already the largest string surface.

**The `imports: ZERO` standalone guarantee.**
Technically preserved: both lanes are already zero-import (verified —
the standalone W3 module has no import section and *no memory at all*; the
linear module has a memory and no imports). But the size cost is **additive,
not `min()`**: a hybrid links the WasmGC string/number runtime *and* the
linear arena plus UTF-8 codecs. Today, same workload: GC W1 21,134 B vs
linear 322 B; GC W3 63,664 B vs linear 34,702 B. The hybrid is the sum.

**What it does to `docs/architecture/codegen-axes.md`.**
The doc's claim is that WasmGC vs linear is a **target-driven alternative**
decided *below* the IR, behind the `BackendEmitter` trait (#1713/#1714) —
two implementations of each emitter intent. A hybrid is not a blend of those
two; it is a **third** backend (`HybridEmitter`) that needs its own
implementation of every intent, and each of those implementations must first
answer a question neither existing backend has to ask: *which side of the
boundary does this value live on?* That is whole-program representation
selection — escape analysis plus region inference — a strictly larger
programme than either backend it would sit between. The two-alternatives
framing in codegen-axes.md is not weakened by this study; it is confirmed,
and should stay as written.

**Capability asymmetry makes the general hybrid moot anyway.**
Per #3673's capability probe, the linear lane cannot compile class methods
containing `charCodeAt` (the IR overlay covers only top-level function
declarations; the direct path has no `charCodeAt` arm), `s[i]` string
indexing, `this.inner.method()`, or module-level string constants (a
module-level `S.length` silently returns **0**), and `type i32 = number`
emits invalid wasm. So in practice any hybrid buildable today is "WasmGC
everywhere, plus linear for the handful of shapes linear supports" — which
is the narrow hybrid, priced next.

## 3. Is any NARROW hybrid worth it? (deliverable 3)

The canonical narrow proposal is the one that needs **no ownership
protocol**: keep only the **immutable source-text buffer** in linear memory
(single owner, outlives the parse, never mutated), everything else WasmGC.

**Priced, and it is negative.** All it changes is the character read: from
`array.get_u` off a `struct.get`'d i16 array (what the GC lane emits today)
to `i32.load8_u` at `base + i`. Two independent measurements of exactly
that swap:

| source | WasmGC indexed read | linear-memory indexed read | winner |
| --- | --- | --- | --- |
| #3673 round 35, **hand-written** tokenizers, 7517 chars | 0.0148 ms | 0.0221 ms | **GC 1.49x faster** |
| this study, **our compiler**, same tokenizer control flow, `number[]` source (S2 below) | 0.0324 / 0.0324 ms | 0.0379 / 0.0376 ms | **GC 1.16x faster** |

V8 hoists a WasmGC array's bounds check against a known `array.len` better
than it hoists a linear-memory bound plus `shl` addressing. The narrow
hybrid therefore *loses* the read it exists to win, and on top of that
costs: a memory + data segments added to the GC module, a second string
representation in the same module, and the UTF-8 vs UTF-16 index mismatch
that is the direct cause of linear's `charCodeAt` being O(i) in the first
place.

**What would have to be true to revisit it.** Exactly one mechanism could
make linear win the read: **byte density** — a UTF-8/Latin-1 buffer is 1
byte per ASCII char against the GC lane's i16 array's 2, so a source large
enough to be cache-bound could favour it. That needs measuring at working
sets well past L2 with a bulk scan; note the other half of that idea (SIMD
over the buffer) was already measured dead in #3673 round 35 — the best SIMD
design lost to plain scalar WasmGC by 1.9x because this grammar averages
~2.2 chars per token. Until someone produces a cache-bound measurement where
1-byte storage wins by more than the ~1.2–1.5x the indexed read currently
loses by, there is nothing here.

## 4. Fixing linear's `charCodeAt` — bug or fact? (deliverable 4)

**It is a BUG, not a property of linear memory,** and the size of the bug is
enormous.

`__linear_ir_str_char_code_at` (`src/codegen-linear/runtime.ts:2342+`) is 297
lines containing a `loop` that walks UTF-8 **from byte 0**, decoding
1-/2-/3-/4-byte sequences and counting UTF-16 units until it reaches the
requested index. A tokenizer scanning a length-N string is therefore O(N²).

The experiment that isolates the helper from the memory model: run the
**identical** tokenizer control flow twice, once reading characters via
`s.charCodeAt(pos)` and once from a `number[]` of char codes — an O(1)
indexed read on **both** backends (`.tmp/w3-ablate2.mjs`, N=64, 3127 chars,
two runs):

| variant | node | GC | linear | linear ÷ GC |
| --- | --- | --- | --- | --- |
| **S1** `string.charCodeAt` | 0.0079–0.0088 | 0.0288–0.0296 | 14.47 / 15.26 | **503x / 516x slower** |
| **S2** `number[]` codes | 0.0062–0.0064 | 0.0324 | 0.0376–0.0379 | **1.16x / 1.17x slower** |

**503x → 1.17x.** The entire "linear is catastrophic at strings" result is
the helper, not the backend. Two consequences, and they pull in opposite
directions for the hybrid:

1. #3673's recommendation #2 ("even if it compiled, the string half would be
   catastrophically slower — 184x, *structurally*") is **wrong on the word
   'structurally'**. It is an implementation choice. The conclusion it
   supported still stands, but on the corrected reason.
2. Fixing it makes linear **competitive** on scans, not superior — GC stays
   ~1.17x ahead. So the corrected table does not open a hybrid case either.

Concrete fix directions for whoever takes the linear lane (all
backend-internal, no hybrid needed):

- an **ASCII fast path** gated on a flag in the string header — the linear-IR
  overlay already computes an ASCII encoding proof for `.length`, so the bit
  exists conceptually; when set, `charCodeAt(i)` is `i32.load8_u (base + i)`;
- or store **UTF-16 code units** (2 bytes/char) as the GC lane does, trading
  size for O(1) indexing and removing the `.length` mismatch that forces the
  ASCII proof;
- or memoize a `(byteOffset, unitIndex)` cursor on the string for sequential
  access, which turns the forward-scan pattern that dominates tokenizing from
  O(N²) into O(N) without changing the representation.

**S1 also re-reproduced the round-37 data-segment corruption at a new size**:
at 3127 chars the linear lane returns checksum **106161** where node and GC
both return **101058**. Silently wrong, no diagnostic, in a benchmark. That
bug is doing real damage to measurement integrity and deserves to be lifted
out of #3673's round-37 paragraph into its own issue.

## Spin-off findings worth their own issues

**(a) `class Node { left: Node }` — a non-nullable field of the class's own
type — makes the WasmGC codegen recurse until stack overflow.**
`Codegen error: Maximum call stack size exceeded`, no location. Narrowed
(`.tmp/a2-probe2.mjs`):

| shape | result |
| --- | --- |
| `class Node { left: Node }` (self-ref, NON-nullable) | **CE — infinite recursion** |
| `class Node { left: Node \| null }` | OK |
| `class Node { left?: Node }` | OK |
| `class Node { left: Leaf }` (non-nullable, *different* class) | OK |
| `f(x: Node)` non-nullable class **param** | OK |

Cycle (captured with a temporary `e.stack` print at `src/codegen/index.ts:4054`,
reverted):

```
objectIrTypeFromTsType  src/codegen/index.ts:1081
tsTypeToFieldIr         src/codegen/index.ts:1099   ← mutual recursion, no cycle guard
```

`objectIrTypeFromTsType` (index.ts:1062) expands each property type via
`tsTypeToFieldIr` (index.ts:1095), which for an `Object`-flagged field calls
straight back in. `Node | null` and `Node | undefined` are *unions*, so they
miss the `Object` flag, return `null`, and the whole shape falls back to
legacy — which is the only reason the nullable spelling works. Fix: thread a
visited set (or a recursive-shape marker) through the pair and return `null`
on revisit. Also affected: passing `null as any` where a non-nullable class
ref is expected.

**This blocks #3686 directly.** The end state #3686 is aiming at —
non-nullable child refs on AST nodes, `(ref $Node)` fields, nothing to
re-narrow — is **not expressible in the source today** for exactly the
self-referential shape an AST has. It has to be fixed before #3686's
acceptance criteria can even be written against a real parser.

**(b) #3673's W3 workload is broken and its 5.9x row should be retracted**
(11 of 431 tokens parsed). `.tmp/linear-vs-gc-bench.mjs` W3 should either
adopt the corrected input from `.tmp/w3-fixed-bench.mjs` or grow a
`cursor === tokens.length` assertion. A benchmark that silently measures 2.5 %
of its stated workload is worse than no benchmark: it produced a published
5.9x that then became "evidence 2" in #3686.

**(c) The generic `===` ladder on laundered values** (four `__box_number`,
four unboxes, an object→string conversion and a string comparison per
`tk[i] === 40`, where both operands are statically `number`) is the GC lane's
largest measured cost on parser-shaped code — larger than everything #3686
enumerates. It belongs on the #3685 / #1584 / #1852 typed-value-flow ladder.

## What this study does NOT claim

- It does not claim WasmGC beats linear memory in general. It claims neither
  lane holds a *stable* advantage on parser-shaped work, which is the only
  thing a hybrid could exploit.
- It does not claim #3686 is not worth doing. #3686 is worth ~10–25 % on the
  parse half, measured — a good return for a scoped change — and its
  acceptance criteria are sound. It claims only that #3686's **evidence 2**
  (the 5.9x linear/GC delta) is not valid support for it, and that the op
  *counts* in evidence 1 overstate the runtime cost on V8 by roughly an order
  of magnitude.
- It does not claim the linear backend should be dropped. Its measured
  advantages are real and are target choices, not hybrid opportunities:
  binary size (4–65x smaller), compile time (3–20x faster), and no GC pause
  tail (the GC lane's spread reached 21–56x on this workload; linear's is
  1.6–1.8x). Those matter for WASI/standalone. Keep both backends, exactly as
  `docs/architecture/codegen-axes.md` says.

## Reproduce

```bash
npx tsx .tmp/linear-vs-gc-bench.mjs          # OPT=3 — the original head-to-head
npx tsx .tmp/w3-sanity.mjs                   # the 11-node finding + arena trap
OPT=3 npx tsx .tmp/w3-fixed-bench.mjs        # corrected W3, size sweep
OPT=3 N=64 npx tsx .tmp/w3-ablate2.mjs       # V0/V1/V2 flip + S1/S2 charCodeAt
npx wasm-as --enable-gc --enable-reference-types --enable-exception-handling \
    .tmp/ast-scaffold.wat -o .tmp/ast-scaffold.wasm
DEPTH=10 REPS=8 npx tsx .tmp/ast-scaffold-bench.mjs   # scaffolding price
npx tsx .tmp/a2-probe2.mjs                   # the non-nullable self-ref field CE
npx tsx .tmp/census.mjs <file.wat> '$3'      # per-function opcode census
```

No compiler source was changed. One temporary `e.stack` print at
`src/codegen/index.ts:4054` was used to capture the recursion cycle in
finding (a) and reverted before commit.

## Measurement caveats

- The box carried 3–6 concurrent agents throughout; 1-min load 1.4–3.0 on 4
  cores. Absolute numbers run ~10–20 % above the #3673 figures taken on a
  quiet box (e.g. GC W3 min 0.0074 here vs 0.0061 published) and per-lane
  spreads are inflated. Every conclusion is drawn from **ratios measured
  inside a single interleaved process**, and every headline ratio was
  reproduced in a second independent invocation; the V0/V1/V2 sign flips are
  0.66/1.06/3.35 and 0.68/1.24/3.53 across the two.
- The hand-written control in section 1 prices *allocate + 4-field walk*. It
  is deliberately simpler than a real parse (no token array, no cursor, no
  precedence loop), so its 18.2 ns/node is the AST floor for that shape, not
  a projected full-parse floor. It is used only to price the read-side
  scaffolding delta, which is what it isolates cleanly.
