# Goal Dependency Graph

Goals form a DAG -- a goal is **activatable** when all its dependencies are met.
Unlike a linear roadmap, multiple independent goals can be worked on in parallel,
and a goal being "ready" doesn't mean it should be worked on immediately.

<!-- AUTO:conformance-start -->
**test262 conformance**: 31,357 / 43,135 (72.7 %) — baseline unknown, 2026-06-17T03:16:20.635Z
<!-- AUTO:conformance-end -->

## DAG

```
                           +----------------+
                      +----+   compilable   +----+
                      |    |   ~95%         |    |
                      |    | ~2,284 CE left |    |
                      +----+-------+--------+    |
                      |            |              |
                      v            v              v
              +----------+ +-----------+ +---------------+
              |crash-free| |   core    | |  error-model  |
              |traps -> 0| | semantics | | spec errors   |
              |  ~50%    | |  ~45%     | |   ~50%        |
              +----+-----+ +--+----+---+ +-------+-------+
                   |          |    |             |
          +--------+    +-----+    +-----+      |
          v             v                v      |
   +------------+ +----------+   +-----------+  |
   |  property  | |  class   |   |  builtin  |<-+
   |   model    | |  system  |   | methods   |
   | ACTIVE ~55%| | ACTIVE~55|   | ACTIVE ~60|
   +--+-----+---+ +----+-----+   +-----+-----+
      |     |          |               |
      |     |    +-----+               |
      |     v    v                     |
      |  +-------------+              |
      |  |   iterator  |              |
      |  |   protocol  |              |
      |  |    ~65%     |              |
      |  +------+------+              |
      |         |                     |
      |    +----+-----+               |
      |    v          v               |
      | +---------+ +-----------+     |
      | |generator| |   symbol  |     |
      | |  model  | |  protocol |     |
      | |  ~70%   | |   ~70%    |     |
      | +---+-----+ +------+---+     |
      |     |              |          |
      |     v              |          |
      | +----------+       |          |
      | |  async   |       |          |
      | |  model   |       |          |
      | |  ~75%    |       |          |
      | +----+-----+       |          |
      |      |             |          |
      v      v             v          v
   +---------------------------------------+
   |          spec-completeness            |
   |     long tail -> 90%+ pass            |
   +-------------------+-------------------+
                       |
                       v
              +------------------+
              | full-conformance |
              |     100%         |
              +------------------+


  === Parallel tracks (no conformance dependency) ===

   +--------------+      +--------------+
   |  standalone  |      | performance  |
   |    mode      |      | optimization |
   | (WASI/edge)  |      | (type flow)  |
   +--------------+      +--------------+
   Depends on:           Depends on:
   iterator-protocol     core-semantics
   generator-model

   +--------------+      +--------------+
   |  platform    |      | refactoring  |
   |  (CM/HTTP)   |      | (modularize) |
   +--------------+      +--------------+
   Depends on:           Independent
   standalone-mode

   +-------------------+   +----------------------+
   | self-hosting-     |   | backend-agnostic-ir  |
   |   dogfood         |   | (IR independent of   |
   | (compile acorn,   |   |  backend: WasmGC /   |
   |  diff vs node)    |   |  linear / bytecode)  |
   +-------------------+   +----------------------+
   Depends on:             Depends on:
   compilable (met)        compiler-architecture
   crash-free (partial)    (activatable)
   ── both feed #1584 (in-Wasm bytecode interpreter), which needs ──
   ── compiled-acorn (self-hosting-dogfood) AND a non-Wasm IR     ──
   ── backend (backend-agnostic-ir) ──
```

## Goal Status Summary

| Goal | Status | Target | Dependencies | Key Issues |
|------|--------|--------|-------------|------------|
| **compilable** | Active | CE -> 0 (~2,284 remaining) | -- | #822 (907 CE), #824 (548 CE), #845 (340 CE), #827/#857 (490 CE), #839 (158 CE), #828 (149 CE), #829 (141 CE), #844 (85 CE), #764 (240 CE) |
| **crash-free** | Active | traps -> 0 | compilable (met) | #852 (1,525 FAIL -- destructuring params), #825 (1,081 FAIL -- null deref), #826 (1,294 FAIL -- illegal cast), #778 (135 FAIL), #1118 (182 FAIL -- worker/eval crashes) |
| **core-semantics** | Active | ~60% | compilable (met) | #847 (660 FAIL -- for-of destructuring), #849 (200 FAIL -- mapped arguments), #850 (135 FAIL -- valueOf/toString), #786 (2,142 FAIL -- multi-assert, in-progress), #853 (58 FAIL -- opaque objects), #737 (276 FAIL), #821 (537 FAIL) |
| **error-model** | Active | spec errors, ~50% | compilable (met) | #846 (2,799 FAIL -- assert.throws not thrown), #1117 (136 FAIL -- wrong error type), #831 (242 FAIL -- negative test gaps), #736 (316 FAIL), #733 (442 FAIL -- RangeError) |
| **property-model** | Active | ~65% | core-semantics (partial) | #797 (~5,000 FAIL -- descriptors Phase 3), #799 (~2,500 FAIL -- prototype remaining), #739 (262 FAIL), #802, #678 |
| **class-system** | Active | ~60% | core-semantics (partial) | #848 (1,015 FAIL -- computed props/accessors), #793 (5 hang -- private methods), #334, #377, #329 |
| **builtin-methods** | Active | ~70% | core-semantics (partial), error-model (partial) | #827/#857 (490 CE -- Array callbacks), #763 (~400 FAIL -- RegExp), #841 (19 CE -- Math), #840 (31 CE -- Array arity) |
| **iterator-protocol** | Activatable | ~65% | class-system (partial) | #766 (~500 FAIL), #851 (147 FAIL -- close protocol), #854 (126 FAIL -- null methods), #761 (~200 FAIL -- rest/spread) |
| **generator-model** | Blocked | ~70% | iterator-protocol | #680, #762, #287, #288 |
| **symbol-protocol** | Blocked | ~70% | iterator-protocol | #481, #482, #484, #485, #486, #487 |
| **async-model** | Blocked | ~75% | generator-model | #735, #1116 (210 FAIL -- promise/async), #675 |
| **spec-completeness** | Blocked | ~90% | async-model, symbol-protocol, builtin-methods, property-model | #696, #661, #674, #671 |
| **full-conformance** | Blocked | 100% | spec-completeness | All remaining |
| **standalone-mode** | Activatable | WASI works | iterator-protocol, generator-model | #680, #681, #682 |
| **performance** | Activatable | faster output | core-semantics | #743, #773, #745, #744, #824 (timeouts) |
| **platform** | Blocked | edge deploy | standalone-mode | #639, #640, #641, #644 |
| **refactoring** | Independent | maintainability | -- | #688, #741, #788, #803-#811 |
| **self-hosting-dogfood** | Active (s57) | compiled acorn AST == node-acorn | compilable (met), crash-free (partial) | #1710 (harness), #1711 (triage), #1712 (acceptance); #1679/#1690/#1690b done |
| **backend-agnostic-ir** | Active (s57) | IR lowers to 2+ backends via a trait | compiler-architecture | #1713 (trait seam, hard, arch-spec), #1714 (linear proof), #1715 (bytecode proof); feeds #1584 |

## How to use this

1. **Pick work from active/activatable goals** -- these have their dependencies met
2. **Within a goal, use issue priority** -- critical > high > medium > low
3. **A goal being activatable doesn't mean it's urgent** -- use judgement about what moves the pass rate most
4. **Goals don't need to be 100% complete** before dependents start -- use the "partial" qualifier when a goal is substantially done but has stragglers
5. **Parallel tracks** (standalone, performance, platform, refactoring) can be worked on alongside conformance work whenever it makes sense

## Sprint priority ranking (by expected pass impact)

> **Updated 2026-06-05 (post-execution sync).** Sprint 60 execution revealed the previous
> ranking was stale: #852, #848, #847 are **done** (sprint 30); #846 is a blocked-umbrella
> with no localized win left (~1,282 residual gated on dense-struct descriptors + hole tracking).
> The active work has pivoted to **standalone conformance catch-up** (#1806, #1827, #1837,
> #1801 merged; native ToPrimitive Phase 1 centerpiece pending architect spec).

For the remainder of sprint 60 and planning sprint 61, highest-impact issues are:

1. **Native ToPrimitive Phase 1** (~2,136 ceiling, standalone) — **pending file + architect spec**
2. **#681** (~331 FAIL) -- pure-Wasm iterator protocol `.values()`/remaining imports [standalone-mode]
3. **#1539** -- standalone Wasm RegExp Phase 2d (remaining flags) [standalone-mode]
4. **#1644** -- standalone BigInt i64 brand + typed-paths [standalone-mode]
5. **#1348** -- class static-init + private fields [class-system, hard, senior-dev]
6. **#1346** -- yield in nested try/finally [generator-model, hard, senior-dev]
7. **#1525b** (142 FAIL) -- ToPrimitive method-trampoline invalid Wasm [shared with Phase 1]
8. **#1833** -- subclass forwarder multi-arg super [correctness, senior-dev]
9. **#846** (~1,282 FAIL) -- assert.throws not thrown [error-model, **blocked-umbrella**]
10. **#1130** (in-review) -- array hole/getter-observing model [unblocks #846 reduce cluster]
