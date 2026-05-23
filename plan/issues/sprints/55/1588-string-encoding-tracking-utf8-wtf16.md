---
id: 1588
title: "String encoding tracking: prove UTF-8 guarantees for zero-copy Component Model interop"
status: ready
sprint: 55
created: 2026-05-23
updated: 2026-05-23
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: compiler
language_feature: strings
goal: platform
depends_on: [1586]
es_edition: multi
---
# #1588 — String encoding tracking: prove UTF-8 guarantees for zero-copy Component Model interop

Static analysis that propagates a per-string-value encoding guarantee
through the IR, distinguishing **provably-UTF-8** strings from
**possibly-WTF-16** ones. The motivation is the WebAssembly Component
Model: its `string` type is defined as a list of Unicode scalar values
encoded as UTF-8, while JavaScript strings are WTF-16 (UTF-16 with
unpaired surrogates permitted). Without tracking, every JS string crossing
a Component boundary requires re-encoding and a copy. With tracking, strings
proven to contain only valid UTF-8 scalars can cross the boundary directly.

The performance opportunity is substantial. The correctness consequence is
zero: tracking is purely advisory; strings without a UTF-8 guarantee fall
back to the existing re-encode-and-copy path.

Depends on #1586 (explicit allocation sites) for attachment point on
string allocations.

## Background

### Encoding mismatch

JavaScript strings, per ECMAScript spec, are sequences of 16-bit code
units, with no requirement that surrogate pairs are well-formed. A string
like `String.fromCharCode(0xD800)` is a single unpaired high surrogate.
This is WTF-16, not UTF-16.

The Component Model's `string` type is defined as a sequence of Unicode
scalar values (excluding surrogates by definition), canonically transferred
as UTF-8. There is no encoding for unpaired surrogates in UTF-8 because
the Unicode scalar set excludes them.

When a JS string crosses a Component boundary today:

1. The full string is scanned to validate Unicode scalar correctness.
2. Either it is re-encoded WTF-16 → UTF-8 (allocation + copy), or it
   contains unpaired surrogates and the conversion traps or substitutes.

For long strings, this scan + copy is measurable. For high-frequency
small-string transfers (logging, structured output, RPC) it dominates
the boundary cost.

### Many JS strings are provably UTF-8

In practice, most JavaScript strings encountered at Component
boundaries originate from sources that cannot introduce unpaired
surrogates:

- **String literals** in source code are validated at parse time.
- **`TextDecoder` decode results** are UTF-8 by construction (the spec
  forbids the decoder from producing unpaired surrogates).
- **`JSON.parse` outputs** are UTF-8 by spec (RFC 8259 restricts JSON
  text to UTF-8).
- **`fetch().text()` results** are UTF-8 unless explicitly told otherwise
  by the response headers.
- **Concatenations of UTF-8-guaranteed strings** preserve the guarantee.

Tracking these origins through the IR and propagating the guarantee
through preserving operations lets the boundary code use the cheap path
for the strings that allow it.

## Goal

After this issue:

1. Every string `AllocSite` from #1586 carries an `encoding` annotation
   with one of three values:
   - `utf8-guaranteed` — the analysis can prove the string contains
     only well-formed UTF-8 scalar values.
   - `wtf16` — the string may contain unpaired surrogates (the
     conservative default).
   - `ascii` — a stricter subset of `utf8-guaranteed` for strings provably
     containing only code points ≤ 0x7F. Enables further optimization
     (single-byte-per-char paths in Component Model implementations that
     support it).

2. A documented set of propagation rules for string operations:
   - origin operations (literal, decoder, JSON, etc.) seed the
     annotation.
   - preserving operations (concat, slice on code-point boundaries,
     intern) preserve the annotation.
   - encoding-destroying operations (fromCharCode with arbitrary
     argument, substring on raw code-unit indices, regex with capture
     groups that may split surrogates) drop the annotation to `wtf16`.

3. The Component Model boundary lowering reads the annotation and
   selects the appropriate path: zero-copy externref-passing for
   `utf8-guaranteed`, the existing scan-and-encode path for `wtf16`.

4. No semantic change to the program. A wrongly-conservative annotation
   yields a slower path but identical results. A wrongly-optimistic
   annotation is a correctness bug, and the analysis is required to err
   conservative.

## Why this is achievable in a short timeframe

Encoding analysis is structurally simpler than ownership analysis (#1587):

- It is **flow-insensitive in most cases** — the encoding of a string
  is determined at its origin and propagates statically through
  operations regardless of execution order.
- It is **monotonic**: starting `utf8-guaranteed`, an operation either
  preserves the guarantee or drops it. No fixed-point iteration needed
  for the common case.
- The propagation rules are a **small, finite table** — one entry per
  string-producing operation in the language.
- Wrong answers are degrading (slower path) rather than incorrect, so
  the safety bar is "never claim guarantee when none exists" rather
  than "always find every guarantee".

This means the implementation can be staged aggressively: a useful
initial version covers literal-origin + concat + JSON-decode and already
captures the majority of string traffic in real applications. Refinement
proceeds incrementally.

## Design

### Annotation lattice

A simple three-level lattice with `ascii` as a sublattice of
`utf8-guaranteed`:

```
              wtf16   (top, most permissive)
                │
          utf8-guaranteed
                │
              ascii  (bottom, most restrictive)
```

Operations join annotations conservatively. Two strings concatenated:

| Left          | Right         | Result        |
|---------------|---------------|---------------|
| `ascii`       | `ascii`       | `ascii`       |
| `ascii`       | `utf8-guaranteed` | `utf8-guaranteed` |
| `utf8-guaranteed` | `utf8-guaranteed` | `utf8-guaranteed` |
| any           | `wtf16`       | `wtf16`       |

### Origin rules

- String literal in source: `ascii` if all chars ≤ 0x7F, else
  `utf8-guaranteed`. Decided at parse time.
- `JSON.parse` result strings: `utf8-guaranteed` (JSON forbids
  unpaired surrogates per RFC 8259 §7).
- `TextDecoder.decode(buf)` result: `utf8-guaranteed` (per WHATWG
  Encoding spec).
- `fetch().text()` result: `utf8-guaranteed` if the response had a
  text/* media type with UTF-8 charset (the common case); `wtf16`
  otherwise. Conservative default if unknown: `wtf16`.
- `String.fromCharCode(n)` with statically known `n` ≤ 0xD7FF or
  in `[0xE000, 0xFFFF]`: `utf8-guaranteed`. Otherwise `wtf16`.
- `String.fromCodePoint(n)` with statically known scalar `n`:
  `utf8-guaranteed`. Dynamic `n`: `wtf16`.
- Property accesses, method results from non-tracked sources: `wtf16`.

### Propagation rules

- `s1 + s2`, template literal interpolation: join the annotations per
  the lattice table.
- `s.toUpperCase()`, `s.toLowerCase()`, `s.trim()`, `s.normalize()`:
  preserve the annotation. (These cannot introduce surrogates from
  non-surrogate input.)
- `s.slice(a, b)` with statically known indices that fall on code-point
  boundaries: preserve. Otherwise drop to `wtf16` (slicing in the
  middle of a surrogate pair would split the pair).
- `s.split(sep)` results: preserve if `sep` is statically known to be
  a non-surrogate string; otherwise `wtf16`.
- `s.replace(pattern, replacement)`: preserve if `pattern` is a string
  literal and `replacement` is a tracked string; drop for regex
  patterns unless the regex is statically analyzable.
- `s.repeat(n)`, `s.padStart(n, pad)`, `s.padEnd(n, pad)`: preserve.
- `JSON.stringify(value)` result: `utf8-guaranteed` (JSON stringify
  escapes lone surrogates per ES2019+ §24.5.2.2 Step 11).
- Any operation not in the above table: drop to `wtf16`.

### Component Model boundary integration

When the IR emits a call across a Component Model boundary that takes a
`string` argument, the lowering pass checks the annotation on the value:

- `ascii` or `utf8-guaranteed`: pass directly as a `(list u8)` view of
  the string's underlying storage, if the runtime representation
  permits zero-copy. Otherwise, fall through to the next case.
- `wtf16`: emit the existing scan-and-encode path.

The "if the runtime representation permits zero-copy" caveat depends on
how strings are stored in the Wasm-GC heap. If we store strings as
`(array i16)` (typical WTF-16 storage), zero-copy is not possible even
for `utf8-guaranteed` strings — they still need to be re-encoded from
16-bit units to 8-bit units. Two follow-up paths:

1. **Dual storage**: store `ascii` and `utf8-guaranteed` strings as
   `(array i8)` from the start; store `wtf16` strings as `(array i16)`.
   The encoding annotation drives the storage decision at the
   allocation site. This requires the annotation to be available before
   storage layout is committed.
2. **Lazy re-encoding cache**: keep WTF-16 storage everywhere but cache
   a UTF-8 view next to the string for tracked-UTF-8 strings.

Path 1 is preferable for new allocations because it eliminates the copy
entirely; Path 2 may be useful as an intermediate step. This is a
deliberate design decision in the implementation plan.

## Scope

1. ADR documenting the encoding lattice, origin rules, propagation
   table, and Component Model boundary integration.
2. Analysis pass implemented as a small dataflow over the IR, writing
   `encoding` annotations to the `AllocSiteRegistry` from #1586 (under
   the `encoding` namespace).
3. Update the Component Model boundary lowering to read the annotation
   and emit the appropriate path. Initial implementation may emit both
   paths and dispatch at runtime if static encoding is `wtf16`; the
   zero-copy path is only taken for tracked annotations.
4. Choose between dual-storage and lazy-re-encoding strategies. Initial
   implementation: dual storage for newly allocated `utf8-guaranteed`
   strings; keep WTF-16 storage for `wtf16` strings.
5. Implement the canonical origin rules (literal, JSON, TextDecoder)
   and propagation rules (concat, slice with known boundaries,
   case-conversion). Document gaps as follow-up items.
6. Test coverage: encoding annotations correctly inferred for a corpus
   of representative string patterns; Component Model boundary tests
   pass with both `utf8-guaranteed` and `wtf16` paths exercised.

## Phasing

**Phase 1 (this issue, ~3-4 weeks)**: lattice + analysis pass +
boundary integration + dual storage for the canonical origin set
(literal, JSON, TextDecoder, concat).

**Phase 2 (follow-up)**: extended origin coverage (fetch, regex
matches, Intl operations), propagation through more methods, refinement
of slice/substring rules.

**Phase 3 (follow-up)**: integration with the Reference-Typed Strings
proposal once it stabilizes — if that proposal lands, much of the
encoding tracking can be expressed in the type system rather than
inferred. Coordinate with #1165 (JIT-interface tracking) and other
proposal-tracking issues if a similar issue exists for Reference-Typed
Strings.

## Non-goals

- Changing the observable JavaScript semantics. WTF-16 indexing, length,
  comparison, etc. continue to work unchanged.
- Building a fully-precise encoding analysis. Conservative annotations
  on operations we cannot easily analyze (regex, dynamic indices) are
  acceptable; precision improvements are follow-up issues.
- Re-encoding all storage to UTF-8. WTF-16 storage remains the default
  for strings that the analysis cannot prove. Dual storage is only for
  proven-UTF-8 allocation sites.
- Adding new JavaScript-level APIs. The annotation is internal to the
  compiler and runtime.

## Relationship to other issues

- **#1586** (explicit allocation sites) — hard dependency. Encoding
  annotations live on string `AllocSite` nodes.
- **#1587** (ownership and access semantics analysis) — parallel
  analysis. Both run after #1586; both write to the registry; the two
  analyses do not interact in Phase 1, but Phase 2 of either may
  benefit from the other.
- **Component Model boundary issues** (existing or to-be-filed) — direct
  consumer of this analysis. Coordinate naming and ABI.
- **Reference-Typed Strings proposal** (WebAssembly/stringref) — long-
  term, may subsume parts of this analysis. Track separately.
- **#1105** (Wasm-native string method implementations) — relevant.
  Built-in string method implementations are the propagation rules in
  action; #1105 work should be designed to preserve encoding
  annotations.

## ECMAScript and WHATWG spec references

- [ECMA-262 §6.1.4 String type](https://tc39.es/ecma262/#sec-ecmascript-language-types-string-type) — WTF-16 semantics
- [ECMA-262 §24.5.2 JSON.stringify](https://tc39.es/ecma262/#sec-json.stringify) — UTF-8 escape behavior
- [ECMA-262 §22.1.3.x String.prototype methods](https://tc39.es/ecma262/#sec-properties-of-the-string-prototype-object) — method-by-method propagation rules
- [WHATWG Encoding spec](https://encoding.spec.whatwg.org/) — TextDecoder UTF-8 guarantees
- [RFC 8259 JSON](https://datatracker.ietf.org/doc/html/rfc8259) — UTF-8 requirement for JSON text
- [Component Model: string](https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md) — canonical ABI for strings

## Acceptance criteria

- [ ] ADR-XXX documents the encoding lattice, origin rules, propagation
      table, and storage strategy.
- [ ] Analysis pass implemented under `src/ir/analysis/encoding.ts`,
      writing to the `AllocSiteRegistry` `encoding` namespace.
- [ ] Origin rules implemented for: string literals, `JSON.parse`,
      `JSON.stringify`, `TextDecoder.prototype.decode`.
- [ ] Propagation rules implemented for: `+` and template literals
      (concat), `.toUpperCase`, `.toLowerCase`, `.trim`,
      `.slice` with statically known boundaries, `.repeat`, `.padStart`,
      `.padEnd`.
- [ ] Component Model boundary lowering reads the annotation and
      selects path. Both paths exercised by tests.
- [ ] Dual storage implemented for `utf8-guaranteed` allocation sites:
      strings allocated under `utf8-guaranteed` use `(array i8)`
      storage; `wtf16` strings retain `(array i16)`.
- [ ] Benchmark: end-to-end measurement of string-heavy Component Model
      interop showing the zero-copy path's improvement over the
      scan-and-encode baseline. Numbers go into the ADR.
- [ ] No semantic regressions in any test suite. WTF-16 strings continue
      to work; equality, indexing, length, comparison all unchanged.

## Risks

- **Soundness bug claims UTF-8 when string contains a surrogate.**
  Catastrophic — produces malformed UTF-8 at the Component boundary,
  which may corrupt the receiving Component or trap. Mitigation: the
  conservative default is `wtf16`; only explicit, audited origin rules
  promote to `utf8-guaranteed`; differential testing must include
  fuzzed string inputs that exercise the boundary.
- **Dual storage doubles complexity in the string runtime.** Every
  string operation now needs to handle both representations.
  Mitigation: built-ins are coded against an abstract string interface;
  the i8/i16 difference is hidden behind a small set of access
  primitives. This pattern is already established in #1105.
- **Coverage of origin rules insufficient to move the benchmark.** If
  the analysis only promotes a small fraction of strings, the boundary
  improvement is invisible. Mitigation: the canonical origin set
  (literal, JSON, decoder) covers the majority of real-world strings;
  benchmark numbers in the ADR validate this.
- **Reference-Typed Strings proposal lands and obsoletes this work.**
  Possible long-term outcome. Mitigation: the analysis investment is
  still useful even if the proposal lands — type information from the
  proposal would replace inference, but the propagation rules and
  Component Model dispatch logic remain. Worst case: the analysis
  becomes vestigial and is removed; the dual-storage work transfers.

## Notes

- This issue produces directly user-visible performance improvements at
  the Component Model boundary, which is the integration surface that
  matters most for adoption in Wasm-component ecosystems. The ADR
  should make the performance story explicit, with measured numbers,
  so that downstream users can evaluate whether their workload is
  positioned to benefit.
- The conservative-by-default rule is more important here than in
  #1587, because the failure mode is correctness rather than missed
  optimization. The pattern of "small audited origin set, monotonic
  drop to conservative on uncertainty" is the right shape.
- A real benchmark is required as an acceptance criterion (rather than
  being a Phase 2 nice-to-have) because the entire motivation is
  performance. Without numbers, the analysis is theoretical.
- Naming: "UTF-8 guaranteed" is the term used here for clarity; the
  ADR may settle on a different internal name (`wellformed`, `scalar`,
  etc.) once the analysis is implemented.
