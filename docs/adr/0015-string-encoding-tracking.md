# ADR-0015: String encoding tracking

Status: Accepted

## Context

JavaScript strings are WTF-16: sequences of 16-bit code units with no
requirement that surrogate pairs be well-formed (`String.fromCharCode(0xD800)`
is a single unpaired high surrogate). The WebAssembly Component Model `string`
type, by contrast, is a sequence of Unicode scalar values, canonically
transferred as UTF-8 — there is no UTF-8 encoding for an unpaired surrogate.

When a JS string crosses a Component boundary today it must be scanned for
scalar correctness and re-encoded WTF-16 → UTF-8, which allocates and copies.
For long strings, or high-frequency small-string transfers (logging, RPC,
structured output), this dominates the boundary cost.

In practice most strings at a boundary originate from sources that cannot
introduce unpaired surrogates (source literals, `JSON.parse`,
`TextDecoder.decode`, concatenations of such strings). If the compiler can
prove a string is well-formed UTF-8, the boundary can use a cheap path.

This builds on ADR-0013 (explicit allocation sites): encoding annotations are
attached to string `AllocSite`s via the registry's namespaced metadata channel.

## Decision

Introduce a static, advisory **encoding lattice** and a forward analysis pass
(`src/ir/analysis/encoding.ts`) that annotates string allocation sites in the
`AllocSiteRegistry` under the `encoding` namespace
(`ALLOC_NAMESPACES.encoding`). The analysis never mutates the IR and is inert
at lowering, so emitted Wasm is byte-identical whether or not it runs.

### Lattice

```
              wtf16            (top — most permissive, conservative default)
                │
          utf8-guaranteed
                │
              ascii            (bottom — strongest claim, code points ≤ 0x7F)
```

`ascii ⊑ utf8-guaranteed ⊑ wtf16`. The join (least upper bound) is the
conservative combination: any operand `wtf16` forces `wtf16`; otherwise
`utf8-guaranteed`, unless both operands are `ascii` (then `ascii`).

| Left            | Right             | Result            |
|-----------------|-------------------|-------------------|
| `ascii`         | `ascii`           | `ascii`           |
| `ascii`         | `utf8-guaranteed` | `utf8-guaranteed` |
| `utf8-guaranteed` | `utf8-guaranteed` | `utf8-guaranteed` |
| any             | `wtf16`           | `wtf16`           |

### Origin rules (Phase 1)

- **String literal**: classify by code units — `ascii` if all units ≤ 0x7F;
  else `utf8-guaranteed` if no lone surrogate; else `wtf16` (a literal
  containing a lone surrogate, e.g. via an escape, cannot be valid UTF-8).

Phase 2 origins (deferred — see below): `JSON.parse` (UTF-8 per RFC 8259),
`JSON.stringify` (escapes lone surrogates per ES2019+ §24.5.2.2),
`TextDecoder.decode` (UTF-8 per WHATWG Encoding), `fetch().text()`.

### Propagation rules (Phase 1)

- **`s1 + s2` / template concat** (`string.concat`): join the operand
  encodings per the lattice. Concatenating two well-formed UTF-8 strings
  cannot introduce a lone surrogate; concatenating two ASCII strings stays
  ASCII. (A WTF-16 operand forces `wtf16`, which conservatively covers the
  surrogate-split-across-the-seam case.)
- **Typed `string.repeat`**: preserve the receiver's producer-authenticated
  encoding evidence. Repetition cannot introduce a new code unit.

Phase 2 propagation (deferred): `.toUpperCase`/`.toLowerCase`/`.trim`/
`.normalize` (preserve), `.slice` on statically known code-point boundaries
(preserve else drop), `.padStart`/`.padEnd` (preserve), `.split`/`.replace`
(conditional). Any operation without an explicit rule drops to `wtf16`.

### Component Model boundary integration (deferred to Phase 2/3)

The boundary lowering will read the annotation and select a path: zero-copy
for `ascii`/`utf8-guaranteed` (when the runtime string representation
permits), and the existing scan-and-encode path for `wtf16`. Two storage
strategies are on the table — **dual storage** (`(array i8)` for proven-UTF-8
allocation sites, `(array i16)` for WTF-16) and a **lazy re-encoding cache**.
Dual storage is preferred for new allocations because it eliminates the copy;
it requires the annotation to be available before storage layout is committed.
Neither is implemented in Phase 1; the analysis lands first so the boundary
work has data to consume.

## Why this scope for Phase 1

The issue (#1588) targets a useful initial version: lattice + analysis pass +
the canonical origin/propagation set, banking the infrastructure that the
boundary work depends on. The string-producing IR instrs that currently carry
an allocation-site id are `string.const`, `string.concat`, and the independently
prepared `string.repeat` foundation, so those are the direct rules the analysis
can attach annotations to today. Call-result
origins (`JSON.parse`, `TextDecoder`) and method propagation require the IR to
mint string alloc ids on those results first — tracked as Phase 2 follow-up.

## Phase 2 status

**PR-A (landed, still inert).** The builder now mints a `"string"`
allocation-site id on `call` and `extern.call` instrs whose result type is
`string` (`emitCall` / `emitExternCall`). This is inert at lowering — the
emitted Wasm is byte-identical — and gives the analysis an attachment point
for call-result rules:

- **Call-result origins**: `JSON.parse` / `JSON.stringify` (host import names
  `JSON_parse` / `JSON_stringify`) → `utf8-guaranteed`. `TextDecoder.decode`
  (an `extern.call`) → `utf8-guaranteed`.
- **Method propagation**: string methods lower to a `call` named
  `string_<m>` (host) or `__str_<m>` (native) with the receiver as the first
  argument. Methods that cannot introduce a surrogate from non-surrogate
  input — `toUpperCase`, `toLowerCase`, `trim`, `trimStart`, `trimEnd`,
  `normalize`, `padStart`, `padEnd`, `repeat` — propagate the receiver's
  encoding. `slice` / `substring` / `charAt` are **not** preserving:
  code-unit indexing can split a surrogate pair, so they conservatively drop
  to `wtf16` (refining `slice` with statically-known code-point boundaries is
  a later refinement). Any other string-returning call is `wtf16`.

**PR-B part 1 (landed, gated scaffolding — inert when off).** The dual-storage
foundation, all behind `--utf8-storage` (default OFF, implies `nativeStrings`
on the WasmGC backend):

- New WasmGC types registered **only when the flag is on** (so the type table
  is byte-identical when off): `__str_data_u8 = (array (mut i8))` and
  `Utf8String = { len:i32, byteLen:i32, off:i32, data:ref __str_data_u8 }`, a
  third `AnyString` subtype alongside `NativeString`/`ConsString`. `len` stays
  the JS-visible code-unit (UTF-16) length; `byteLen` is the canonical-ABI
  size.
- `--utf8-storage` flag plumbed: `CompileOptions` / `CodegenOptions` /
  `CodegenContext.utf8Storage`, the CLI (`--utf8-storage`), `compiler.ts`, and
  the `nativeStrings` implication in `create-context.ts`.
- `nativeStringLiteralInstrs(ctx, value, encoding?)` emits an i8-backed
  `Utf8String` (with compile-time-computed UTF-8 bytes) for
  `ascii`/`utf8-guaranteed`, the existing i16 `NativeString` otherwise. The
  UTF-8 encoder asserts no lone surrogate (defensive classifier-bug guard —
  §4 soundness anchor).
- The live `AllocSiteRegistry` is exposed on `ctx.allocRegistry` from the IR
  pipeline so the lowering sites can read the `encoding` annotation.

**PR-B part 2 (landed — storage path now active under `--utf8-storage`).**

- The `emitStringConst` resolver hook now takes the `string.const`'s
  `alloc` id (`lower.ts` passes `instr.alloc`); the integration.ts resolver
  reads the `encoding` annotation off `ctx.allocRegistry` and delegates to
  `nativeStringLiteralInstrs(ctx, value, enc)`, so an `ascii`/`utf8-guaranteed`
  literal is now actually materialized as an i8 `Utf8String` when the flag
  is on.
- **Interop is handled at the flatten boundary, not per primitive.** Rather
  than adding a `Utf8String` arm to every access primitive, `__str_flatten`
  gains one branch: a `Utf8String` input is decoded back to an i16
  `NativeString` via a new `__str_utf8_to_flat` helper (a hand-written Wasm
  UTF-8→UTF-16 decode loop: 1/2/3/4-byte sequences, astral scalars re-split
  into surrogate pairs; output pre-sized to the stored code-unit `len`).
  Since all access primitives (`charCodeAt`, `length` on ropes, substring,
  …) already route through `__str_flatten`/`ref.cast` to `NativeString`, they
  work on `Utf8String` values unchanged. This is the "abstract string
  interface" the issue Risks call for, localized to one decode point.
- **Round-trip correctness** verified by `tests/ir/utf8-storage-roundtrip.test.ts`
  (10 cases): each program compiled with the flag OFF (i16) and ON (i8) returns
  observably identical results across `.length`, `charCodeAt` (incl. multi-byte
  decode and astral surrogate halves), `concat`, and `===` — for ascii,
  multi-byte, astral, and lone-surrogate (stays i16) literals.

**Still open (PR-B follow-up / PR-C):** the **alias-fusion soundness guard**
(issue §4) — before any future CSE may fuse string sites, enforce that a
`wtf16` site never aliases into a `utf8` canonical (no string-fusing pass
exists today, so this is a forward guard, not a present bug). Concat-result
i8 storage (`string.concat` still produces i16; only literals take i8 in this
PR — concat decodes its operands via flatten, so it stays correct).

**PR-C (landed — revised scope).** The original PR-C plan presumed a
Component-Model encode-import infrastructure on the WasmGC backend that does not
exist yet (no CM adapter, no boundary-lowering pass that reads the annotation,
no declared encode imports). Edge B "import selection" therefore could not be
built without first building that adapter — an infrastructure gap, not a wiring
change. PR-C was rescoped to ship the **missing transcode primitive** that the
boundary will consume, and to document the two boundary edges so the deferred
work has a clear contract.

Delivered:

- **Standalone `__str_to_utf8(s: ref $AnyString) -> ref $__str_data_u8`**
  (`src/codegen/native-strings.ts`, gated on `--utf8-storage`). A pure-Wasm
  (no JS host call) WTF-16 → UTF-8 transcoder: flattens any string
  (`NativeString` i16, `ConsString` rope, or `Utf8String` i8) via
  `__str_flatten`, then two-passes the i16 buffer — pass 1 sums the UTF-8 byte
  length so the `__str_data_u8` output is allocated exactly once; pass 2 writes
  the bytes. This is the in-heap counterpart to the existing inverse helper
  `__str_utf8_to_flat` (UTF-8 → WTF-16) and the runtime counterpart to the
  compile-time literal encoder `utf8Encode`. It is the primitive the deferred
  Edge B standalone fallback (`string_to_utf8`) will call, satisfying the "JS
  host optional" rule (CLAUDE.md) without a `TextEncoder` host import.
  - **Totality**: unlike the compile-time `utf8Encode` (which asserts
    well-formedness for proven ascii/utf8 literals), the runtime helper handles
    arbitrary WTF-16 input. A lone surrogate is emitted as its 3-byte WTF-8
    generalization, so the function never traps. This is a defensive totality
    guarantee — the boundary fast path is only ever selected for values the
    analysis proved `utf8-guaranteed`, which can never contain a lone surrogate
    (the literal classifier demotes those to `wtf16`), so a surrogate never
    reaches the fast path in practice.
  - **Tests**: `tests/issue-1588-str-to-utf8.test.ts` (10 cases) splices an
    exported probe that builds a `NativeString` from baked-in code units, calls
    `__str_to_utf8`, and reads back the byte array — asserting equality with
    Node's `Buffer.from(str, "utf8")` for ascii / 2-byte / 3-byte / astral /
    mixed / empty, plus explicit WTF-8 byte checks for lone high/low surrogates.

- **Benchmark** — `benchmarks/str-to-utf8.bench.mts` (`npx tsx`), pure-Wasm
  `__str_to_utf8` vs the JS host `TextEncoder.encode`, 20k reps per case. On
  V8/Node 25 (kernel micro-benchmark, each rep re-materializes the source
  string so the figures include WasmGC allocation overhead that the in-heap
  boundary path would not pay): ascii ~0.22×, latin-1 ~0.31×, CJK (3-byte)
  ~0.67×, **astral (4-byte emoji) ~1.5× faster than TextEncoder** — the
  pure-Wasm kernel pulls ahead exactly where the host encoder's surrogate-pair
  handling and the JS↔native boundary cost most. The takeaway for the deferred
  boundary work: a standalone transcoder is competitive with V8's native
  encoder and wins on astral-heavy content, so the standalone CM path is worth
  taking when no host runtime is present.

The two boundary edges (design unchanged from "## Phase 2 ABI Plan" §2 in the
#1588 issue; deferred to **#1650**):

- **Edge A — linear / WASI / canonical ABI (`c-abi.ts`).** Internal strings are
  already byte-oriented UTF-8, so the annotation buys **scan elision**, not a
  copy: a `utf8-guaranteed`/`ascii` arg lowers directly to `(ptr, byteLen)`
  from the string header, skipping the surrogate-validity scan; `wtf16`/unknown
  keeps the existing scan path. **Invariant** (the soundness anchor): a lone
  surrogate can never be `utf8-guaranteed` (the classifier demotes it), so the
  scan-eliding fast path can never emit malformed UTF-8 across the WIT edge.
  For ascii specifically `byteLen == len` (1 byte per code unit), enabling an
  optional latin1 fast path to CM receivers that accept it.

- **Edge B — WasmGC / host edge (`declarations.ts`).** The annotation selects
  *which encode path* a string-typed CM-boundary call lowers to: a checked host
  `string_to_utf8` import (validates/substitutes) for `wtf16`; an unchecked
  `string_to_utf8_unchecked` (or the stringref `encode` builtin) for the proven
  set; and — for standalone mode (no JS host) — the in-heap Wasm-native
  fallback that calls `__str_to_utf8` (this PR). **Deferred** because it
  presumes a CM adapter for the WasmGC backend that does not exist: the encode
  imports are undeclared, no boundary-lowering pass reads the annotation, and
  the `allocRegistry` is not yet threaded into the host-edge resolver. Tracked
  in **#1650** (CM-boundary encode-import selection), which also carries the
  alias-fusion soundness guard and the end-to-end boundary benchmark.

## Consequences

- **Soundness is the bar.** A wrongly-conservative annotation only costs a
  slower path; a wrongly-optimistic one is a correctness bug (malformed UTF-8
  at the boundary). Every rule errs conservative: default `wtf16`, only
  audited rules promote. The literal classifier explicitly demotes lone
  surrogates to `wtf16`.
- **No semantic change.** WTF-16 indexing, `.length`, comparison, etc. are
  untouched. The annotation is internal to the compiler/runtime.
- **Advisory until a consumer lands.** Phase 1 produces annotations with no
  reader; the boundary lowering (Phase 2/3) is the first consumer. The
  annotations are exercised by unit tests in the interim.
- **Reference-Typed Strings.** If that proposal stabilizes, type information
  may replace inference, but the propagation rules and CM dispatch logic
  remain useful.

## References

- ADR-0013 — explicit allocation sites (the attachment mechanism)
- #1650 — Component Model boundary encode-import selection (Edge B follow-up)
- ECMA-262 §6.1.4 (String type / WTF-16), §24.5.2 (JSON.stringify)
- WHATWG Encoding (TextDecoder UTF-8 guarantees), RFC 8259 (JSON UTF-8)
- Component Model CanonicalABI (`string`)
