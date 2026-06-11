# Compiler quality & architecture review — June 2026

> Full-codebase review conducted 2026-06-10 by seven parallel subsystem
> reviewers (Claude Fable 5, 1M context — each held its entire subsystem in
> context), synthesized by the review lead. Every claim cites file:line
> evidence; two findings were confirmed by live compilation probes. Companion
> to [`structure-and-language-assessment.md`](structure-and-language-assessment.md)
> (2026-06-04, structure/language) and [`codegen-axes.md`](codegen-axes.md)
> (two-axis model). This review goes below the directory level into the code
> itself.
>
> Improvement work items: **issues #1916–#1950** (`plan/issues/`), indexed at
> the bottom of this document.

## Grade sheet

| Subsystem | Grade | One-line verdict |
|---|---|---|
| WasmGC codegen core (`src/codegen/`) | **C−** | Ships 71.6% test262, but correctness is validate-and-patch: lossy fixups silently substitute wrong values; absolute func-index baking has caused ≥7 regressions |
| Typed IR (`src/ir/`) | **B−** | Excellent pass discipline (verify-between-every-stage, demote-not-miscompile) on a representation accreting debt; a live defect drops ordinary `while` loops off the IR path |
| Front-end / types (`src/compiler*`, `src/checker/`) | **C+** | Works, but the pipeline exists in three divergent copies, diagnostics report wrong positions, and `ts.Type` leaks into ~400 codegen sites |
| Runtime / host interop (`src/runtime*`) | **B** | Allowlist governance and the native regex engine are exemplary; the 10.4k-line host runtime has an unversioned 200-name ABI and multi-instance state bleed |
| Linear backend + emit (`src/codegen-linear/`, `src/emit/`) | **C+** | Careful emitter and a self-hosting linker anchor a prototype-grade backend that silently miscompiles (`break`/`continue` never compiled) |
| Testing & CI | **B+** | One of the most sophisticated conformance pipelines at this scale; but the enforced gate is weaker than the documented one and `--optimize` is conformance-untested |
| Optimization / performance | **C+** | Real compile-away on the happy path; one step off it, closures pay 15-instruction dynamic dispatch that Binaryen provably cannot remove |

**Overall: B−.** The split is stark: the *engineering process* (conformance
pipeline, ratchets, issue-linked comments, honest self-documentation, dogfood
lanes) operates at an A− level rare for a project this young, while the *core
compiler architecture* is patch-layered C-range — velocity has been bought
with silent-failure risk that test262 only partially observes. The strategic
bets (typed IR, BackendEmitter trait, host-import allowlist) are the right
ones; what's missing is one deliberate consolidation pass before the next
adoption waves multiply the existing debt.

---

## Cross-cutting findings

These five themes recur independently across subsystems. They matter more
than any single-file fix, and they define the priority order below.

### 1. The compiler prefers emitting *something* over refusing — silent degradation is systemic

The single most consequential pattern. Independent instances:

- **Stack-balance lossy fixups**: when a branch produces a wrongly-typed
  value, `stack-balance.ts:709-755` patches it with `drop; f64.const 0` or
  `drop; ref.null` — a compile-time bug becomes a silently wrong runtime
  value. Fixup counts are computed and discarded (`index.ts:1571`). (#1918)
- **The compile-failure gate is a string prefix**: `compiler.ts:731` fails the
  build only for messages starting `"Codegen error:"`. ~118 "Unsupported …"
  `reportError` sites compile the expression to `null`, the balancer patches
  the hole, and `compile()` returns `success: true`. (#1921)
- **Linear backend dispatchers have no default arm**: `break`/`continue` are
  *never compiled* (`codegen-linear/index.ts:519-732` — the depth stacks are
  pushed and never read), so `while (true) { if (x) break; }` is a silent
  infinite loop; `typeof`/`await`/spread emit zero instructions. (#1937)
- **`encodeInstr` has no default arm** (`emit/binary.ts:728-1678`): combined
  with the 173 `as unknown as Instr` casts, an unmatched op string is
  silently omitted from the binary. (#1939)
- **WIT generator silently drops unmappable params**
  (`wit-generator.ts:401-406`), emitting signatures whose arity disagrees
  with the core function. (#1940)
- **The runtime's `undefined`-as-sentinel protocol** (`runtime.ts:3869-3873`)
  misinterprets user getters legitimately returning `undefined`. (#1935)

The team demonstrably knows the standard — #1838/#1868 fixed exactly this
class in two spots, and the standalone refusal layer
(`late-imports.ts:46-86`) is a model — it just hasn't been applied uniformly.
**Direction: make fail-loud the invariant, ratchet the remaining silent paths
to zero** the same way IR fallbacks are ratcheted. Extends #1858.

### 2. Single-sources-of-truth exist in 3–5 divergent copies — and divergence is already shipping bugs

- **Four coercion matrices** (`type-coercion.ts:980`, `:2695`,
  `stack-balance.ts:1179`, `:678`) that *disagree semantically*: externref→f64
  unboxes in call-arg position but becomes `f64.const 0` in branch position.
  (#1917)
- **≥5 IR nested-buffer walkers** (verify/lower/DCE/const-fold/alloc) with
  divergent coverage — confirmed live defect: DCE never walks `while.loop`
  condition buffers, so every ordinary `while (i < limit)` demotes off the IR
  path, invisibly to the ratchet (probe-verified). (#1922, #1923)
- **Three pipeline drivers** (`compileSourceSync`/`compileMultiSource`/
  `compileFilesSource`, ~450 lines each): multi-file compiles silently skip
  ES early errors, hardened mode, IR, JSX, fs detection. (#1927)
- **Three i32-safety matchers** (`array-element-typing.ts:30` admits
  mirroring `function-body.ts` "intentionally narrower"), **three ToPrimitive
  walkers**, **four property-lookup implementations** in the host runtime,
  **≥4 instruction walkers** in codegen (peephole's misses `catchAll` —
  bodies wrapped by async try/catch are never optimized; `walk-instructions.ts`
  exists with 2 consumers). (#1948, #1934, #1920)

**Direction: each of these is a mechanical consolidation with an existing
"good twin" to consolidate onto.** They are the highest payoff-per-risk items
in this review.

### 3. Type information is gathered four times and then thrown away

The TS checker knows the types; codegen mostly doesn't use them:

- Four uncoordinated inference systems (TS checker, IR lattice
  `propagate.ts`, `shape-inference.ts`, import-resolver's syntactic stubs)
  with no shared representation; ~397 raw `getTypeAtLocation` sites leak
  `ts.Type` deep into codegen — which also forecloses the planned TS7
  migration (`ts-api.ts:114-131` throws under `--ts7`). (#1930)
- A closure bound once to a known arrow is stored as **externref** and every
  call does `ref.test`→`ref.cast`→`call_ref` (~15 instrs) — and the externref
  laundering means **Binaryen -O3 provably cannot repair it** (verified by
  disassembly diff). (#1946, #1947)
- `strictNullChecks` non-nullness never reaches Wasm: every typed param is
  `(ref null $T)` with four null-check-throw blocks in a 6-line function.
- `i - 1` on a known-i32 loop var round-trips through f64
  (`convert`→`sub`→`trunc_sat`, survives -O3). (#1948)

**Direction: one type-query facade (TypeOracle) + one numeric lattice +
end-to-end GC-ref typing.** This is also the precondition for the project's
own "compile away, don't emulate" principle to hold off the happy path.

### 4. The enforced gates are weaker than the documented ones

- CI's hard test262 gate is **net ≥ 0** (`diff-test262.ts:336-340`); the
  10%-ratio and 50-per-bucket rules exist only in skill text
  (`dev-self-merge.md:187-189`) — agent convention, not branch protection. A
  PR with 60 improvements and 55 unrelated regressions merges. (#1943)
- **`pass → compile_timeout` is excluded from every gate** — a PR that
  pathologically slows compilation is invisible; nothing tracks aggregate
  compile time, though it's already recorded in the JSONL. (#1942)
- **`--optimize` output is never executed in CI** — three reviewers
  independently converged on this as the largest correctness hole. (#1941)
- The test262 runner deliberately weakens its oracle (discards expected error
  types in `assert.throws`, strips `assert.sameValue(x, undefined)`) — the
  71.6% headline is an upper bound. (#1945)
- The perf gate is 4 microbenchmarks at 50% tolerance, and one pass's header
  literally names the benchmark it targets, while the honest internal suite
  (string/split 4.9× slower than JS, csv-parse 2.9×) feeds no gate.
  (#1949, #1950)

### 5. Index- and ABI-fragility: identity by absolute number, compatibility by luck

- **Absolute function-index baking** in WasmGC codegen forces three
  coexisting shift/relocation regimes (`late-imports.ts:139-270`, `:355+`)
  walking 13+ instruction roots; ≥7 numbered regressions (#618, #1109,
  #1384, #1525b, #1666, #1677) trace to this one decision. The IR layer
  already proved the fix (symbolic refs, `ir/nodes.ts:22-28`). (#1916)
- **The ~200-name `env` ABI between compiled binaries and `runtime.ts` has no
  version constant and no handshake** — skew fails as LinkError or silent
  misbehavior. The team knows how: `STANDALONE_REGEXP_ABI_VERSION` exists
  for the regex engine. (#1932)
- Module-level mutable state in the host runtime (`_symbolCache`,
  `_legacyRegExpState`, `_subclassCtors`) breaks two-instances-on-one-page
  and retains whole instances forever in hot-reload scenarios. (#1933)

---

## Per-subsystem summaries

### WasmGC codegen core — C−

71.6% test262 from a direct AST→Wasm emitter is a serious achievement, the
`context/` extraction shows active remediation, and known debt
(#1095/#1098/#1172/#1530) is honestly tracked. But the architecture is
patch-layered: the pipeline tail is repair passes
(`eliminateDeadImports` → `repairStructTypeMismatches` → `peephole` →
`stackBalance` → `fixupExternConvertAny`, index.ts:1559-1575 — three of six
are fixups for invalid emission); `stack-balance.ts` (2,524 LOC) is a partial
Wasm-validator reimplementation used to patch the emitter's own output, with
176 lines of tests; `CodegenContext` is a ~150-field interface shaped partly
by repair-pass reachability; 23 probe-compile-and-rollback sites truncate the
body but leak locals/imports/types (#1847 fixed 8 of ~23); `compileCallExpression`
is 8,800 lines with ~125 string-matched dispatch arms. New issues: #1916–#1921.

### Typed IR — B−

The process is excellent: verifier between every pass with
demote-not-miscompile, reference-equality fixpoints, alloc-site provenance
(ADR-0013), three-backend emitter-seam proof. The representation is the
problem: two competing control-flow forms (a vestigial blockarg CFG under
de-facto structured nested buffers — paying for both, benefiting from
neither); 53 instruction kinds growing one-per-feature-per-strategy
(`forof.vec/iter/string`); backend `ValType`/`typeIdx` inside `IrType`
(blocks serialization/caching and linear adoption of unions); the verifier —
the stated compensation for TS unsoundness — checks **no per-instruction
operand types** (branch args: arity only; `resultType` trusted, never
re-derived); hygiene passes never descend into loop bodies, so the IR's main
optimization target is never optimized. Post-claim demotions are counted
nowhere, so the #1530 ratchet has a blind side. New issues: #1922–#1926.

### Front-end / type system — C+

Smart lib caching, a clean TS-API shim, exemplary issue-linked comments, and
a genuinely needed ES early-error pass. Structural debt: pipeline
triplication with silently divergent semantics; the primary API path's
"module system" string-rewrites imports into `any` stubs (destroying types
and positions); pre-parse rewrites shift all line numbers with no offset
mapping, so reported diagnostics are wrong whenever a rewrite fires;
`CompileError` has no `file` field; ~300 lines of heuristics suppress the
checker's own correct diagnostics because `number|null` lowers to bare `f64`
— the fix belongs in type lowering, not diagnostic whack-a-mole;
`detectEarlyErrors` is a single ~3,350-line function that runs only on the
single-source path; the public `treeshake` option is dead code. New issues:
#1927–#1931.

### Runtime / host interop — B

The host-import allowlist (40 entries, each with tracking issue + rationale,
size-ratcheted in CI, enforced at codegen) is a model governance artifact;
the native regex engine (compile-time bytecode + one backtracking VM,
mirrored opcode-for-opcode by an executable reference VM, versioned ABI,
shared step cap) is the template the rest of the codebase should follow;
map/object runtimes are spec-cited. Held back by `runtime.ts` itself: one
~5,000-line `resolveImport` with 188 name checks; seven WeakMap sidecars with
four property-lookup implementations that must agree; three ToPrimitive
walkers; the unversioned ABI; multi-instance state bleed; and the async
landmine — CPS lowering is built but disabled (`ASYNC_CPS_ENABLED = false`)
because legacy call sites consume async results synchronously, so shipped
async semantics are spec-wrong by design until call sites learn to drive
Promises. New issues: #1932–#1936.

### Linear backend + emit — C+

The periphery is the strong part: the binary emitter is careful and
battle-hardened (rec-groups for forward refs, LEB range guards, valued-if
patching); the linker is a self-hosting, isolation-checked gem (the linker
compiles *itself* via the linear backend in tests); the Binaryen integration
shows mature judgment (the custom-descriptors disable for wasmtime ≤44). The
backend itself is prototype-grade behind a production flag: silent
`break`/`continue` drop, `number[]` stored as i32 (`[1.5]` → `[1]`),
element-assignment RHS evaluated twice, `throw` lowered to bare
`unreachable`, diagnostics at `0:0`, `if (NaN)` truthy. The IR
`BackendEmitter` seam is the right escape route but `LinearEmitter` is a
206-line proof reachable only from tests. New issues: #1937–#1940.

### Testing & CI — B+

Dual-target 57×2-shard test262 with duration-weighted chunks, merge-base-exact
baseline resolution, wasm-sha noise filtering, poison-fork recycling, a real
V8 differential lane, an acorn dogfood lane (pinned tarball,
compile→validate→run→AST-diff), zero snapshot tests, ratcheted baselines.
Gaps: the gate/documentation mismatch and compile-time blindness (above);
~100 equivalence failures permanently baselined with no burn-down ratchet;
no fuzzing despite a harness that makes it cheap (#1855 exists);
~120–170 wasted runner-minutes per run (per-shard installs ×114, run twice
for PR + merge_group). New issues: #1941–#1945.

### Optimization / performance — C+

Real compile-away where types are explicit: interfaces → flat structs with
direct `struct.get`, inlined `Math.*`, fully-inlined `push` growth, real Wasm
Timsort. Off that path it emulates: the closure dispatch and i32/f64
ping-pong findings (§3 above); default builds ship unoptimized (`-O` opt-in)
while in-compiler peephole has 6 patterns; the gated benchmark set is 4
overfitted micros while the honest suite shows JS winning most string/mixed
workloads, ungated. New issues: #1946–#1950.

---

## Directions — what to do, in order

**Now (small, high-leverage, mostly S-effort; the "stop the silent bleeding" wave):**

1. Fail-loud defaults everywhere a dispatcher or encoder can fall through:
   #1937 (linear break/continue + default arms), #1939 (encodeInstr default
   throw + funcref validation in CI), #1921 (structured failure gate),
   #1940 (WIT params).
2. Make the gates match the documentation: #1941 (differential `--optimize`
   lane — single biggest untested correctness surface), #1943 (ratio/bucket
   in CI), #1942 (compile-time gate), #1923 (meter IR post-claim demotions).
3. #1932 (version the env ABI) — one global, one check, removes a whole
   failure mode for precompiled binaries.

**Next (M-effort consolidations that delete recurring bug classes):**

4. #1922 (shared IR traversal — fixes the live while-loop defect),
   #1917 (one coercion engine), #1918 (stack-balance strict mode + fixup
   ratchet), #1920 (one instruction walker), #1919 (transactional probes),
   #1933 (runtime instance state), #1928/#1929 (diagnostics fidelity),
   #1927 (one pipeline driver), #1924 (IR verifier type rules).

**Strategic (L-effort, architect-spec first — these decide what the compiler becomes):**

5. #1916 symbolic function references — removes the index-shift regime the
   same way IR symbolic refs already did.
6. #1930 TypeOracle boundary — prerequisite for TS7 and for every
   type-driven optimization; #1946/#1947/#1948 (closure devirt, GC-ref
   typing, numeric lattice) are the performance payoff that falls out.
7. #1936 async contract migration (enable the already-built CPS path).
8. #1925/#1926 IR representation consolidation (one control-flow form;
   backend types out of IrType) — do this **before** the class-method/async
   adoption waves (#1370/#1373) multiply every cost.
9. Linear backend: drive `LinearEmitter` past the vec group rather than
   patching `codegen-linear/index.ts` feature-by-feature (existing #1714
   direction; #1938 is the interim correctness floor).

**Explicit non-directions:** don't grow the IR node set one-node-per-feature
(prefer resolver-deferred kinds like `string`/`object`); don't add host
imports without standalone fallbacks (the allowlist ratchet is working);
don't chase the 4 landing-page microbenchmarks (#1949 replaces the
incentive).

---

## New issue index (#1916–#1950)

| # | Title (short) | Area | Effort | Priority |
|---|---|---|---|---|
| 1916 | Symbolic function references in WasmGC codegen | codegen | L | high |
| 1917 | Single coercion engine (4 divergent matrices) | codegen | M | high |
| 1918 | Stack-balance strict mode + fixup ratchet | codegen | S→M | high |
| 1919 | Transactional speculative-compile API | codegen | M | medium |
| 1920 | One instruction walker; peephole catchAll bug | codegen | S | medium |
| 1921 | Structured compile-failure gate (no string prefix) | compiler | S | high |
| 1922 | Shared IR traversal; fix while-loop DCE demotion | ir | M | high |
| 1923 | Meter IR post-claim demotions in ratchet | ir | S | high |
| 1924 | Instruction-level type rules in IR verifier | ir | M | high |
| 1925 | IR hygiene passes inside nested buffers / one CF form | ir | M→L | medium |
| 1926 | Remove ValType/typeIdx from IrType | ir | M | medium |
| 1927 | Single front-end pipeline driver | compiler | M | high |
| 1928 | Source-position remapping for pre-parse rewrites | compiler | M | high |
| 1929 | CompileError.file + flattened diagnostic chains | compiler | S | medium |
| 1930 | TypeOracle: one type-query boundary | compiler | L | high |
| 1931 | Decompose detectEarlyErrors; wire or delete treeshake | compiler | M | medium |
| 1932 | Version the env ABI | runtime | S | high |
| 1933 | Multi-instance isolation + retention leak | runtime | M | high |
| 1934 | Decompose resolveImport into domain tables | runtime | L | medium |
| 1935 | Retire the undefined-sentinel protocol | runtime | M | medium |
| 1936 | Async contract migration (enable CPS) | runtime | L | high |
| 1937 | Linear backend: fail loud; implement break/continue | codegen-linear | S | critical |
| 1938 | Linear number[] i32 truncation + double-eval RHS | codegen-linear | M | high |
| 1939 | encodeInstr default throw; funcref validation in CI | emit | S | high |
| 1940 | WIT generator: never silently drop params | tooling | S | medium |
| 1941 | Differential testing of --optimize output | testing | S | critical |
| 1942 | Compile-time regression gate | testing | S | high |
| 1943 | Enforce ratio/bucket thresholds in CI | testing | S | high |
| 1944 | CI cost: bundle-once artifact + pnpm cache | testing | M | medium |
| 1945 | Test262 oracle precision (error types, stripped asserts) | testing | M | medium |
| 1946 | Closure devirtualization for singleton callees | codegen | M | high |
| 1947 | End-to-end GC-ref typing (externref at boundary only) | codegen | L | high |
| 1948 | Shared numeric i32 lattice | codegen | M | high |
| 1949 | Representative, tighter perf gate | testing | S | medium |
| 1950 | Default-on optimization pipeline | compiler | S | medium |

Already-tracked overlaps deliberately *not* re-filed: god files (#1098/#1172),
`as unknown as Instr` (#1095/#1526), IR fallback phase-out (#1530), verifier
dominance hardening (#1850), backend value representation (#1852), cross-backend
differential harness (#1854), TS fuzzer (#1855), naming symmetry (#1860),
subdir READMEs (#1859), fail-loud audit umbrella (#1858 — issues #1918/#1921/
#1937/#1939/#1940 are its concrete children).
