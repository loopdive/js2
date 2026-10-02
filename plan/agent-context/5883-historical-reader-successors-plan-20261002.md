# PR5883 historical reader successor implementation plan

Parent owns this plan, issue state, execution and acceptance; Sol-6.1 Medium
implements only the bounded test infrastructure below. This directly unblocks
the existing PR; no new migration scope or retirement permission.

## Measured failure and preserved authority

The pre/post relocation original reports both contain176 executed rows:
layout21/31 and native preservation64/145, hence85pass91fail. Two additional
files fail collection with zero executed rows: earlier-main-port on
builtin-static-globals, export-main-port on promise-class-receiver-drive.
All176 outcomes and both collection messages are preserved. Do not describe
these two collection failures as passes or infer91 runtime defects.

Keep original tests, fixtures, populations, options and timeouts; retain the
immutable pre/post records in5883-relocation-validation-exact-20261002.json.txt.
Original receipt hashes remain authority. No baseline repinning or allowances.

## Source attribution and bounded operands

Read exact Git changes and authenticate each endpoint, not these abbreviations
alone. Reconciled source endpoints may differ from any single upstream commit.

1. promise-class-receiver-drive: fcefaa1123 subclass/resolve admission,
   266a6652aa native-then demand,942abf64d9 ordinary-function constructors.
2. builtin-static-globals: f0728e77c7,7283f26fd9,f323948745 demand notification
   and independently reserved namespace identities.
3. builtin-value-read:0afbe0b933 observable replacement of RegExp-symbol routes.
4. async scheduler:937afecabd observable finally/intrinsic then and1b0ee6d266
   species capability/PromiseResolve constructor checks.
5. custom combinator:61d206221b private capability extraction with shared
   cache ownership;266a6652aa native-then demand.
6. combinator drive:61d206221b observable-owner routing, aggregateSettleFuncIdx
   uses and9d5df9e79b import relocation.
7. combinators:61d206221b extraction, capability export changes ande81a329a8f
   aggregate Resolve semantics.

closure-classifier,carrier-bag-visibility andir/try-table still match their
original dependency pins. Do not add unnecessary inverses for those paths.
Resolve actual repository filenames from original receipts rather than guesses.

## Implementation contract

Add one separate fixture/helper/control suite with explicit, reviewed layers:
actual current source → later/extraction inverse → original export inverse →
original earlier inverse → existing B1/delay reconstruction. Reuse the existing
flat relocation inverse at the drive boundary; never peel it twice.

Pin full before/after SHA256 and Git blobs, exact parent/child provenance plus
each reconciled projection endpoint. Record unique ordered edit spans and
offsets, per-span hashes, retained-byte identity and complete reciprocal replay.
No whole-file historical substitution, runtime Git fallback or disk bypass.
Every target and dependency must be read through the supplied raw reader.

Before reconstructing extracted declarations, authenticate actual moved owners
and their current dependencies. Explicitly account for9feade6d77 aggregate
Resolve/replaceable then changes andc698ec6020 lazy context-service forwarding;
do not label current owners byte-equivalent to initial extraction. This proof
recovers an historical source view; current semantic changes need their separate
runtime evidence and are not erased or certified by the inverse.

Only reader seams may change: promise-export-main-port's default initial read,
plus initial read wrappers in native-delay-combinator-source-preservation and
delay-combinator-layout-ownership. Preserve explicit strings, injected mutant
callbacks, original authenticator logic and original assertions. Other paths
remain raw. Helpers must not import old readers cyclically.

Return a frozen checkpoint listing every endpoint/span/dependency, source
provenance and exact diff. If these seven operands are insufficient or the
existing fixture cannot be reconstructed without broader changes, stop that
layer and report the first concrete barrier; do not widen scope.

## Parent acceptance

Positive-first tests must prove full inverse/replay and refusal of changed
receipts, wrong direction, missing/duplicate/reordered spans, changed retained
bytes, unknown paths, missing or mutated real dependencies, and injected source
mutants. Restore each original mutation-specific refusal, not merely any throw.
Both collection-failing suites must execute their original declared populations;
derive and record their full counts before claiming success. All176 already
executed rows retain their identities and must meet original expectations;
new failures are investigated individually, never excused by totals.

Rerun unchanged104 runtime cases,56 flat-relocation controls, canonical typing,
inventory, cycles, flat directory and normal hooks. Current main's incoming23
built-in tests are separate coverage, not restoration of its removed S16
own-name assertion. Do not alter production or claim full IR equivalence.
