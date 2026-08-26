# Goal Dependency Graph

Goals form a DAG -- a goal is **activatable** when all its dependencies are met.
Unlike a linear roadmap, multiple independent goals can be worked on in parallel,
and a goal being "ready" doesn't mean it should be worked on immediately.

<!-- AUTO:conformance-start -->

**test262 conformance**: 33,282 / 43,621 (76.3 %)

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

   +-----------------------------+
   |  wasi-async-runtime         |  NEW (not active)
   |  (event-loop reactor:       |
   |   scheduler + poll_oneoff + |
   |   process.stdin Readable)   |
   +-----------------------------+
   Depends on:
   async-model (microtask substrate, #1326)
   standalone-mode (WASI target + poll_oneoff, #1484)
   ── enables GENERAL async/streaming Node programs (true        ──
   ── process.stdin streaming, timers, promise-driven I/O) on    ──
   ── --target wasi. Phase 1 (scheduler/timers) is activatable   ──
   ── now; later phases gate on standalone-mode maturing. #2632.  ──

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

   +------------------------------+
   |  ir-full-coverage            |  NORTH STAR (active)
   |  (ALL AST kinds through the  |
   |   IR front-end; WasmGC vs    |
   |   linear = backend fork ONLY;|
   |   direct AST->Wasm path is   |
   |   deprecation-tracked)       |
   +------------------------------+
   Depends on:
   backend-agnostic-ir (trait seam #1713/#1714)
   ── the front-end end state (docs/architecture/codegen-axes.md  ──
   ── "North star"): #2856-#2859 drive the unintended fallback    ──
   ── buckets to zero; #2855 then retires the warning channel.    ──

   +-----------------------------+
   |  runtime-eval               |  NEW (Tier-0 slices activatable)
   |  (eval / indirect eval /    |
   |   new Function: tiered       |
   |   compile-away -> JS-host    |
   |   meta-circular -> standalone|
   |   bytecode interpreter)      |
   +-----------------------------+
   Depends on:
   standalone-mode (the standalone dynamic-code leg)
   backend-agnostic-ir (#1713/#1715 IR->bytecode seam)
   self-hosting-dogfood (#1710 Acorn-via-js2wasm)
   substrate: #2864 ($Frame), #2527 (core-wasm linking)
   ── umbrella #1584; docs/architecture/runtime-eval-interpreter.md. ──
   ── Tiers 0/1 shipped (#1163/#1164); interpreter = Tier 2.        ──
   ── env-reification + dynamic-MOP substrate CONVERGES with        ──
   ── `with` and Proxy (#1355) — built once, shared.               ──
```

## Goal Status Summary

| Goal                     | Status                                        | Target                                                                                                | Dependencies                                                                        | Key Issues                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **compilable**           | Active                                        | CE -> 0 (~2,284 remaining)                                                                            | --                                                                                  | #822 (907 CE), #824 (548 CE), #845 (340 CE), #827/#857 (490 CE), #839 (158 CE), #828 (149 CE), #829 (141 CE), #844 (85 CE), #764 (240 CE)                                                                                                          |
| **crash-free**           | Active                                        | traps -> 0                                                                                            | compilable (met)                                                                    | #852 (1,525 FAIL -- destructuring params), #825 (1,081 FAIL -- null deref), #826 (1,294 FAIL -- illegal cast), #778 (135 FAIL), #1118 (182 FAIL -- worker/eval crashes)                                                                            |
| **core-semantics**       | Active                                        | ~60%                                                                                                  | compilable (met)                                                                    | #847 (660 FAIL -- for-of destructuring), #849 (200 FAIL -- mapped arguments), #850 (135 FAIL -- valueOf/toString), #786 (2,142 FAIL -- multi-assert, in-progress), #853 (58 FAIL -- opaque objects), #737 (276 FAIL), #821 (537 FAIL)              |
| **error-model**          | Active                                        | spec errors, ~50%                                                                                     | compilable (met)                                                                    | #846 (2,799 FAIL -- assert.throws not thrown), #1117 (136 FAIL -- wrong error type), #831 (242 FAIL -- negative test gaps), #736 (316 FAIL), #733 (442 FAIL -- RangeError)                                                                         |
| **property-model**       | Active                                        | ~65%                                                                                                  | core-semantics (partial)                                                            | #797 (~5,000 FAIL -- descriptors Phase 3), #799 (~2,500 FAIL -- prototype remaining), #739 (262 FAIL), #802, #678                                                                                                                                  |
| **class-system**         | Active                                        | ~60%                                                                                                  | core-semantics (partial)                                                            | #848 (1,015 FAIL -- computed props/accessors), #793 (5 hang -- private methods), #334, #377, #329                                                                                                                                                  |
| **builtin-methods**      | Active                                        | ~70%                                                                                                  | core-semantics (partial), error-model (partial)                                     | #827/#857 (490 CE -- Array callbacks), #763 (~400 FAIL -- RegExp), #841 (19 CE -- Math), #840 (31 CE -- Array arity)                                                                                                                               |
| **iterator-protocol**    | Activatable                                   | ~65%                                                                                                  | class-system (partial)                                                              | #766 (~500 FAIL), #851 (147 FAIL -- close protocol), #854 (126 FAIL -- null methods), #761 (~200 FAIL -- rest/spread)                                                                                                                              |
| **generator-model**      | Blocked                                       | ~70%                                                                                                  | iterator-protocol                                                                   | #680, #762, #287, #288                                                                                                                                                                                                                             |
| **symbol-protocol**      | Blocked                                       | ~70%                                                                                                  | iterator-protocol                                                                   | #481, #482, #484, #485, #486, #487                                                                                                                                                                                                                 |
| **async-model**          | Blocked                                       | ~75%                                                                                                  | generator-model                                                                     | #735, #1116 (210 FAIL -- promise/async), #675, #1042 (re-scoped 2026-07: host lane onto the #2906 N-state machine), #2957 (async arrows/methods activation)                                                                                        |
| **spec-completeness**    | Blocked                                       | ~90%                                                                                                  | async-model, symbol-protocol, builtin-methods, property-model                       | #696, #661, #674, #671                                                                                                                                                                                                                             |
| **full-conformance**     | Blocked                                       | 100%                                                                                                  | spec-completeness                                                                   | All remaining                                                                                                                                                                                                                                      |
| **standalone-mode**      | Activatable                                   | WASI works                                                                                            | iterator-protocol, generator-model                                                  | #680, #681, #682; July-2026 audit adds: #2962 (error identity, P1), #2959 (Promise executor, P1), #2963 (builtin reification), #2961 (strict leak-scan), #2964 (for-in proto chain), #2958 (unhandled rejection); carriers #2864/#2865/#2866/#2867 |
| **runtime-eval**         | Activatable (Tier-0 now)                      | eval/`new Function` work standalone, not a trap                                                       | standalone-mode, backend-agnostic-ir, self-hosting-dogfood; substrate #2864/#2527   | #1584 (umbrella/strategy), #2923/#2924 (compile-away, current), #2960 (loud diagnostics + host new-Function shim routing), #2925 (direct-eval reification), #2927/#2928/#2929 (interpreter)                                                        |
| **wasi-async-runtime**   | New (not active)                              | event-loop reactor on WASI; real `process.stdin` Readable, timers, promise-driven I/O                 | async-model (microtask substrate #1326), standalone-mode (WASI + poll_oneoff #1484) | #2632 (refs #389 reporter; #2631 is the orthogonal synchronous host)                                                                                                                                                                               |
| **performance**          | Activatable                                   | faster output                                                                                         | core-semantics                                                                      | #743, #773, #745, #744, #824 (timeouts)                                                                                                                                                                                                            |
| **platform**             | Blocked                                       | edge deploy                                                                                           | standalone-mode                                                                     | #639, #640, #641, #644                                                                                                                                                                                                                             |
| **refactoring**          | Independent                                   | maintainability                                                                                       | --                                                                                  | #688, #741, #788, #803-#811                                                                                                                                                                                                                        |
| **self-hosting-dogfood** | Active (s57)                                  | compiled acorn AST == node-acorn                                                                      | compilable (met), crash-free (partial)                                              | #1710 (harness), #1711 (triage), #1712 (acceptance); #1679/#1690/#1690b done                                                                                                                                                                       |
| **backend-agnostic-ir**  | Active (s57)                                  | IR lowers to 2+ backends via a trait                                                                  | compiler-architecture                                                               | #1713 (trait seam, hard, arch-spec), #1714 (linear proof), #1715 (bytecode proof), #2953 (pushRaw gap, P1), #2954 (LinearEmitter core ops), #2956 (linear consumes IR, XL); feeds #1584                                                            |
| **ir-full-coverage**     | **Active — NORTH STAR** (elevated 2026-07-02) | ALL AST kinds through the IR front-end; backends fork below the IR; direct AST→Wasm front-end retired | backend-agnostic-ir (trait seam)                                                    | Current retirement: #3518 epic; #3519 truth; #3520–#3523 identity/compile-once; #3525 whole program; #3526 runtime contract; #3527 async plans; #3528 shared linear; #3090 deletion. Historical inputs: #2855/#2856–#2859, #2949–#2952, #2955.     |


### ⚠ ES5 + untagged standalone — goal RESTATED 2026-08-01 (project-lead ruling)

**The goal is ~95.4 % EX-DYNAMIC-CODE, not 100 %.** Target **8,150 of 8,545**
reachable (6,176 passing + 1,974 non-dynamic failures). Scope = test262 files
carrying `es5id:` **or** none of `es5id`/`es6id`/`esid`.

**317 files are DECLINE-BY-DEPENDENCY and are OUT OF SCOPE — not failures to fix:**

| blocker | files | needs |
| --- | ---: | --- |
| eval / `Function` | ~144 | real eval (#2928) — the Acorn interpreter provider; minutes to compile, unaffordable per shard. A **packaging** problem (#2527) as much as a semantics one. |
| `with` — object environment records with first-class Reference identity | ~162 | a **front-end substrate**, same weight class as the 795-file descriptor MOP |

Near-disjoint; 13 files need both. **Funding eval does NOT deliver `with`** — an
earlier version of the census said otherwise and was corrected.

- **Do not dispatch agents at these 317.**
- **Do not measure progress against 8,545 or report "100 %".** A run at 95.4 % is
  **success**, not a 4.6 % shortfall.
- **95.4 % is an UPPER BOUND, not a forecast** — 202 files remain unpriced.

**Why the exclusion is sound (non-circularity control):** the same detector run
over the 6,176 goal-scope *passes* finds **248 files that use `eval`/`with`/
`Function` and pass anyway**. The 317 were identified by **engine refusal**, not
by mentioning the feature.

`with` is additionally **168 of 175 host-lane**, so it is shared front-end
scope-analysis work, not a standalone-gap item.

**Revisit** if #2527 packaging makes real eval affordable per shard.

Evidence: `plan/log/analysis-2026-08-01-es5-untagged-tail-census.md` (baselines
`d8c30f3b7df0`, js2 main `bc54c09da`).

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
