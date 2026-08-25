# Architecture Decision Records

This directory captures the foundational architectural decisions behind js2wasm.
Each record documents a decision that has already been made, the context in
which it was made, and the consequences of that choice. ADRs are not design
documents — they are retrospective records intended to make the design
auditable for external contributors and reviewers.

The format follows Michael Nygard's 2011 ADR template: **Context**,
**Decision**, **Consequences**. Records are short by design (200–400 words).

## Index

| #   | Status    | Title                                                                                                                  |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| 001 | Accepted  | [Hybrid static–dynamic compilation strategy](./0001-hybrid-compilation-strategy.md)                                    |
| 002 | Accepted  | [Architectural approach: AOT + WasmGC](./0002-architectural-approach.md)                                               |
| 003 | Accepted  | [WasmGC over linear memory](./0003-wasmgc.md)                                                                          |
| 004 | Accepted  | [AOT compilation over JIT/interpreter](./0004-aot.md)                                                                  |
| 005 | Accepted  | [Object layout via WasmGC struct types (closed-world)](./0005-object-layout.md)                                        |
| 006 | Accepted  | [Boundary guards at host-import surfaces](./0006-boundary-guards.md)                                                   |
| 007 | Accepted  | [Closure conversion via WasmGC ref-cell structs](./0007-closure-conversion.md)                                         |
| 008 | Accepted  | [Dual string backend: wasm:js-string vs WasmGC i16 arrays](./0008-dual-string-backend.md)                              |
| 009 | Accepted  | [TypeScript annotations as inference seeds, not ground truth](./0009-typescript-annotations.md)                        |
| 010 | Accepted  | [Dynamic eval() via host import](./0010-eval-host-import.md)                                                           |
| 011 | Accepted  | [Implementation language: TypeScript with the `typescript` package as the frontend](./0011-implementation-language.md) |
| 012 | Accepted¹ | [Intermediate representation: multi-stage typed IR](./0012-intermediate-representation.md)                             |
| 013 | Accepted  | [Explicit allocation sites in the IR](./0013-ir-allocation-sites.md)                                                   |
| 014 | Accepted  | [Ownership and access-semantics analysis on IR values](./0014-ownership-access-analysis.md)                            |
| 015 | Accepted  | [String encoding tracking](./0015-string-encoding-tracking.md)                                                         |
| 016 | Accepted  | [Differential codegen performance analysis](./0016-differential-codegen-perf-analysis.md)                              |
| 017 | Accepted  | [Linear-backend bump/arena allocator; one fixed GC strategy, not pluggable](./0017-linear-bump-arena-allocator.md)     |
| 018 | Accepted  | [Structured IR: optimize inside nested control-flow buffers](./0018-structured-ir-nested-buffers.md)                   |
| 019 | Accepted  | [Bytecode interpreter ISA: register+accumulator, i32-packed encoding, side exception table](./0019-bytecode-isa.md)    |
| 020 | Accepted  | [QuickJS `JSValue` as the linear backend's dynamic tier](./0020-linear-dynamic-tier-quickjs-jsvalue.md)                |
| 021 | Accepted  | [A direct native backend emits C](./0021-native-backend-targets-c.md)                                                  |
| 022 | Accepted  | [Linked-mode heap and read-only-data placement](./0022-linked-mode-heap-and-rodata-placement.md)                        |

¹ ADR-012's high-level-IR / lowered-IR _split_ is superseded in practice by
ADR-018 (one structured IR, optimized in place); its other content still holds.

## Reading order

For a first read, ADR-002 (architectural approach) and ADR-001 (hybrid
compilation strategy) frame everything else. The remaining records are
sub-decisions within that frame and can be read in any order.
