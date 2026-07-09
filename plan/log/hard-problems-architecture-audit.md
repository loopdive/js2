# Hard-problems architecture audit — the five domains, ranked (2026-07-09)

> fable-arch deep audit against `origin/main @ 928c85179` (2026-07-09).
> Method: verify-first — every claim below was re-probed against current
> main via `compileSource(..., {target:"standalone", nativeStrings:true})`
>
> - instantiate-and-run, or grep of the live source; several written
>   findings from earlier sessions turned out stale (noted inline). Scope
>   per the lead's brief: audit the five hard domains BEYOND the in-flight
>   work (#2773 / #2963 / #3037 / #3087 / #2865 / #3050 are being
>   implemented right now and are NOT re-spec'd here).
>
> New issues filed by this audit: **#3098, #3099, #3100, #3101** + the
> requested architect spec written into **#2956** + a verified-state
> addendum in **#3031**.

## Executive ranking (by leverage per budget token)

| Rank | Domain                                                  | Verdict                                                                                                                                                            | This audit's delta                                                                         |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1    | **Dynamic features** (any/dynamic value rep + dispatch) | Substrate is FAR further along than the docs/memories say; the remaining roots are dispatch arms, not representation                                               | #3098 (native callback dispatch), #3100 (dynamic-iterable iteration)                       |
| 2    | **Standalone** (pure-Wasm parity)                       | Floor 19,219 host-free and climbing; carriers staffed; the two biggest UNSTAFFED leak roots are #3098/#3100's                                                      | leak-root map below; #3098/#3100                                                           |
| 3    | **IR** (`ir-full-coverage`)                             | Machinery essentially built (inversion done, effect model done, capability tables in flight); the wall is untyped-JS claiming (#2949, in flight) + the linear seam | #2956 architect spec (the one requested-but-unwritten keystone spec)                       |
| 4    | **Proxy**                                               | 12 traps wired but DARK for test262's dominant handler shape — one bounded bug caps the whole lane                                                                 | #3099 (the keystone enabler) + #3031 re-verification (P5 unblocked: descriptor bits exist) |
| 5    | **eval / new Function**                                 | Architecture fully decided (4-tier ladder, bytecode ADR'd); Tiers 0/1/3 shipped; only the ISA design artifact blocked cold-start of the interpreter build          | #3101 (ISA + $Frame ABI pre-spec → E1 is now Opus-executable)                              |

Ranking rationale: domains 1 and 2 share their two biggest roots (callback
dispatch, dynamic iteration) — landing #3098+#3100 moves BOTH the gc-lane
honest-fail tail (post-#3074) and the standalone leak classes. Domain 3 is
architecturally on rails; its highest-leverage unwritten artifact was the
#2956 spec, now written. Domain 4 is gated on a single M-sized bug (#3099)
before any of its planned Fable slices are worth scoping. Domain 5 is
deliberately last: superbly planned, zero-conflict, and now cold-startable
— ideal budget-window filler, not the critical path.

---

## Domain 1 — Dynamic features (any/dynamic value rep + dispatch substrate)

### Verified current state (probes, standalone lane)

The standalone dynamic MOP is much stronger than recorded. All of these
work host-free on current main (several memory notes claiming otherwise
are STALE — e.g. `reference_standalone_any_string_value_read_substrate`,
fixed by the #3027 lineage):

- `(o: any).v` for number AND string values (`o.v.length` → 2 ✓); the
  native-string drop is FIXED.
- Computed keys `o[k]`, incl. `o[Object.keys(o)[0]]`; `delete`; set of a
  new string-valued prop; accessors (`get p(){…}`); prototype walk via
  `Object.create(p)`; symbol-keyed props (`o[s]`, no host import!);
  dynamic `this` (`o.m()` reading `this.v`); `with (o) { a }`;
  `instanceof` on a class instance; for-in with `o[k]` reads.

### Verified live gaps (each pinned to a shape)

| Gap                                                          | Probe                                                                                                                                       | Owner                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Callback through a dynamic dispatch boundary → host bridge   | `(a: any).map(cb)` → TRAP + LEAK `__make_callback` (typed receiver is native)                                                               | **#3098 (new)**                                                            |
| Iterating a dynamically-produced iterable → baked wrong cast | `for (k of Object.keys(o: any))` → illegal_cast; `Object.entries` destructuring → illegal_cast; index loop over same value works            | **#3100 (new)**                                                            |
| `Function.prototype.bind` standalone                         | `f.bind({v:8})()` → null deref                                                                                                              | small, unfiled (note for PO; likely folds into #2963's reification family) |
| `console.log(e.message)` of a dynamic-read native string     | wasm compile error (`(ref null 6)` where externref expected) — the VALUE path is fine (`e.message.length` ✓), only console_log arg coercion | small, unfiled (note for PO)                                               |

### End-state substrate + migration path (the brief's question)

The end state is already implicitly ratified across four in-flight specs;
stated here in one place:

1. **One value ABI**: boxed-any carrier + tag classifier (tag-5/tag-6
   discipline), `$Object` for open shapes, `$NativeProto` for builtin
   protos, `$Proxy` at ladder step 1, native i16-array strings, undefined
   singleton. Owner: #2773 (rep) + #3037 (identity) + #3053 (reader
   carrier) + #2949 (the same ABI inside the IR's type system).
2. **One MOP spine**: front-guarded shared helpers + `__chain_lookup` +
   receiver-classification ladder (#3031 Part 0). Every new dynamic
   consumer (with, Proxy, interpreter opcodes, destructuring) routes
   through it; none re-implements classification.
3. **One dispatch arm for callable values**: compiled-closure `ref.test` →
   `__apply_closure`, arity-tolerant (#2939 lesson). #3098 builds it for
   HOF callbacks; #3100 reuses it for `next()`; the #3101 interpreter
   trampoline makes interpreted functions indistinguishable from compiled
   closures under the SAME classifier — after which "dynamic dispatch"
   is one mechanism everywhere.
4. **Migration**: land in-flight #2773-tail/#3037/#3053/#2949 → #3098 S1/S2
   → #3100 S1–S3 → the #3031 C-slices (chain walker refactors). Each step
   retires per-shape baked casts in favor of the ladder.

---

## Domain 2 — IR (`ir-full-coverage` north star)

### Verified current state

- **Fallback baseline is down to `body-shape-rejected: 17`** (+4 deferred
  async) — from 33 on 2026-07-02. The residual is fully characterized in
  #2856's landed diagnostics: it is NOT missing statement kinds; it is
  entangled capability clusters (cross-module imported calls #2858 +
  first-class function values + `.push` + C-style-loop vec SSA + `#private`
  - module-scope mutables). #2856 is correctly `blocked` on that
    capability program; nothing to re-spec.
- **Keystones**: #2138 compile-once inversion **done** (flag-gated, full
  test262 measured: −15/48,088, all attributed, fail-loud held); #2134
  effect model **done** (slices 1+2, `src/ir/effects.ts` + schedule
  verifier); #2135 capability table **in-progress** (operators landed);
  #1930 TypeOracle **in-progress**; #2953 pushRaw gap **in-progress**;
  #2954 LinearEmitter core ops **done**; #2952 multi-exit CF
  **in-progress**; #2949 dynamic IrType **in-progress** (slices ratified,
  U0–U2 of #3053 landed); #2950 default flip **backlog** (correctly gated
  on #2138-S3 divergence fixes #2972/#2973 + #2135 families + #2951).
- **The honest wall** (from the July audit, still true): IR claim rate on
  untyped JS is ~3% — zeroing the playground-corpus buckets is necessary
  but NOT sufficient; #2949 (dynamic IrType) is the true critical path and
  is staffed.

### The sequenced retirement plan (consolidated)

```
NOW (in flight): #2949 slices · #2135 families · #2953 · #2952 · #1930
  → #2972/#2973 (the two #2138-S3 divergences) → #2951 (gens+class-members skip)
  → #2950 slice 1 (IR-first default-ON, one soak window)
  → #2950 slice 2 (delete flag + compile-twice; demote channel dies for
     claimed code — #2855 AC4)
  → capability program unblocks #2856/#2857/#2858 buckets → 0 →
     STRICT_IR_REASONS promotions → #2855 closes
PARALLEL (backend axis): #2953 → L0/L1 of #2956 (spec now written) → L2+
  → #2955 (string de-polymorph) → linear families widen via the ratchet
LATER: #1373b (IR async, AFTER #1042 engine convergence — one engine rule)
END STATE: src/codegen/ = WasmGcEmitter + registries (backend library);
  src/codegen-linear/ = LinearEmitter + layout/runtime; one front-end.
```

**This audit's delta**: the #2956 architect spec (adapter-interface design
`IrBackendIntegration`, ONE integration core + two context adapters — NOT
a cloned twin — plus the legality-gated slice map L0–L4 and a
`check:linear-ir` ratchet). It was the one keystone explicitly awaiting an
architect spec ("Architect spec recorded here ... before dev dispatch").

---

## Domain 3 — Standalone (pure Wasm, no JS host)

### Verified current state

- Honest floor: **19,219 host-free pass** (`test262-standalone-highwater.json`
  @ 2026-07-06) — up from 18,157 on 2026-07-02 and 12,551 on 2026-06-29.
  The carrier lane (#2864/#2865/#2867, all in-progress) is landing.
- The last full standalone JSONL with leak attribution is **2026-06-26**
  (stale — 12 days, pre-#2962/#2902/#2959): leak classes `host_import`
  10,209 · `iterator_protocol` 8,156 · `dynamic_object_property` 5,167 ·
  `dynamic_code` 387. Top leaked imports and their owners:

| Import (files @ 06-26)                       | Root                               | Owner                                                                                         |
| -------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `__get_caught_exception` 8,807               | error identity                     | #2962 **done** — expect a large drop on refresh                                               |
| `__make_callback` 7,519                      | dynamic-receiver callback dispatch | **#3098 (new)** (async share → carriers)                                                      |
| `__gen_*` ≈7.4k+5.6k                         | generator carrier                  | #2864 in-progress                                                                             |
| `__new_Test262Error` 6,402                   | harness error ctor                 | #2902 **done**                                                                                |
| `__extern_get` 4,354                         | dynamic reader                     | #3027 done / #3053 in-progress                                                                |
| `__array_from_iter_n` 4,348                  | iteration of dynamic iterables     | **#3100 (new)** S4                                                                            |
| `Promise_*` ≈4.1k×2+4k                       | promise carrier                    | #2867/#2959 (2959 done)                                                                       |
| `__create_async_generator` 4,065             | async-gen carrier                  | #2865 in-flight                                                                               |
| `__box_symbol` 2,748                         | symbol boxing at host boundary     | native symbol keys already work (probe ✓); residual shapes need a fresh harvest before filing |
| `global_<TypedArray>` ~780×8                 | TA ctors as host globals           | #2651 blocked / #3087 in-flight adjacent                                                      |
| `__extern_eval` 682 / `__dynamic_import` 433 | dynamic code                       | runtime-eval ladder (domain 5)                                                                |

- **Action for the lead**: schedule a fresh standalone JSONL harvest —
  every number above predates 5 merged leak-root fixes; scoping new
  slices against the 06-26 file would misallocate budget.

### Path to close (the brief's question)

The gap decomposes into: (a) carriers (staffed, landing), (b) the two
unstaffed dispatch roots this audit filed (#3098 callbacks, #3100
iteration), (c) dynamic-code (domain 5's Tier 2), (d) a long tail of
bounded bugs (bind, console-log coercion, catch-payload shapes) that
should be harvested AFTER (a)+(b) land, against a fresh baseline. The
structural guarantee gap (#2961, strict leak-scan for `--target
standalone`) remains blocked and is worth unblocking once #3098/#3100
retire their import families — at that point the allowlist shrinks enough
for the scan to be enforceable.

---

## Domain 4 — Proxy

### Verified current state (probes + grep)

- Standalone substrate (#1100 + #1355 A–F): `$Proxy` + `$ProxyTraps` with
  **12 trap fields** (get/set/has/apply/deleteProperty/gOPD/getPrototypeOf/
  setPrototypeOf/isExtensible/preventExtensions/ownKeys/defineProperty);
  `construct` absent. Arrow-property handlers fire (get/set/has verified ✓).
- **THE FINDING — #3099 (new)**: method-shorthand handlers (`{ get(t,k)
{…} }` — test262's dominant shape) **silently never fire**: the
  any-context object-literal route skips MethodDeclaration props entirely
  (`literals.ts:322` — a documented "S2 follow-on" that was tracked
  nowhere). `Object.keys` of a shorthand-method literal returns 0;
  `__proxy_create`'s runtime trap read misses. Every standalone Proxy
  measurement to date understates the wired substrate. **Land #3099 first;
  re-measure; then scope the rest.**
- **P5 unblocked**: the §10.5 invariant slices were "sequenced behind
  descriptor-attribute bits" — those bits EXIST now (`$PropEntry.$flags` +
  native non-configurable redefine TypeErrors). Recorded in #3031's
  re-verification addendum.
- Still open, unchanged: K2 (standalone `construct` + `__construct_dispatch`
  — spec'd in #3031 §1.3), P3 (`Proxy.revocable` standalone — CE today),
  P4 (`Reflect.*` standalone wiring — CE today), K1 (host inbound
  arg-marshalling — coordinate with in-flight #3087, adjacent locus).

### Sequenced path

#3099 (M, Opus) → re-measure standalone `built-ins/Proxy` → P3+P4 (Opus,
bounded) → K2 (Fable) → P5 invariants (now executable; predicates are
mechanical from fetched §10.5 text) → K1/K1b host lane (after #3087
lands). The trap-dispatch mechanism and exotic-object representation
questions the brief asked are ANSWERED and ratified in #3031 Part 0
(front-guarded shared helpers; `$Proxy` as a standalone struct,
storage-typed externref, ladder step 1) — no new representation design is
needed; execution is.

---

## Domain 5 — eval / new Function

### Verified current state

The architecture is the most complete of the five domains
(`docs/architecture/runtime-eval-interpreter.md` Parts I+II):

- **Tier 0** (constant-string compile-away) — shipped + broadened (#1163/
  #2923/#2924); 91.7% of test262 eval call-sites are constant-string.
- **Tier 1** (host meta-circular shim) — shipped (#1164/#2960); known gaps
  #2925 (direct-eval scope reification, backlog) + #3017 gap 2 (eval-code
  linkage / ReferenceError shape).
- **Tier 3** (refuse-loudly) — shipped (#2960); invariant L1 (no silent
  wrong values) holds.
- **Tier 2** (standalone bytecode interpreter) — DECIDED (bytecode over
  tree-walking, §13 ADR; self-compiled TS, strategy 2a) but NOT built.
  Parser prerequisites: #2853 **done**; #2927 ready; #2928 sliced
  (E0–E6) with E1 (interpreter library, Node-tested, zero substrate risk)
  startable in any window.
- The user-floated "bytecode interpreter" IS the committed direction; the
  alternatives (compile-at-runtime meta-circular standalone, QuickJS
  bridge, tree-walker) were evaluated and rejected with recorded rationale
  (doc §3, §13) — no need to relitigate.

### This audit's delta — #3101 (new)

The one artifact between "fully planned" and "an Opus dev can build it
cold" was the opcode ADR (E1's first deliverable, design-taste work).
#3101 pre-specs it concretely: 34-op register+accumulator ISA with packed
i32 encoding, side exception TABLE instead of TryStart/TryEnd opcodes
(zero-cost non-throwing path), `$FuncMeta`/`$Frame`/`$EnvRec` layouts
(coordinated with #2864/#2925/§14), and — the load-bearing decision — the
**closure-struct trampoline call protocol** that makes interpreted
functions indistinguishable from compiled closures to every AOT call site
(zero interpreter-awareness in codegen, `ref.eq` identity free, and
direct reuse of #3098's callable classifier).

### Sequencing

E0 (in-Wasm AST probe) ∥ E1 via #3101 → E2 (self-compile; the risk
concentration) → E3/E4/E5 → #2929 (direct eval + with + MOP convergence —
whose MOP surface is #3031's, single-sourced). Independent Tier-1 work
(#2925, #3017-g2) schedulable anytime.

---

## Consolidated new-issue list (this audit)

| Id        | Domain   | Title (short)                                                                                   | Effort                      | Model      | Priority |
| --------- | -------- | ----------------------------------------------------------------------------------------------- | --------------------------- | ---------- | -------- |
| **#3098** | 1+2      | Native callback dispatch — retire `__make_callback` on the dynamic-receiver lane                | L (S1/S2 Fable, S3–S5 Opus) | fable      | high     |
| **#3099** | 4 (+1,3) | Method-shorthand props never materialize on `$Object` — un-darks the wired Proxy trap substrate | M                           | opus       | high     |
| **#3100** | 3+1      | Dynamic-iterable substrate — native GetIterator/IteratorStep ladder                             | L–XL (S1/S3 Fable)          | fable      | high     |
| **#3101** | 5        | Bytecode ISA + `$Frame` ABI pre-spec — E1 executable cold                                       | L (spec cuts design out)    | fable→opus | medium   |
| **#2956** | 2        | (spec added to existing issue) linear backend consumes IR — adapter interface + L0–L4 slice map | XL (L0+L1 first window)     | fable      | medium   |

Suggested queue insertion: #3099 immediately (`sprint: current`
candidate — it re-baselines the whole Proxy domain for cheap); #3098 S1/S2
and #3100 S1 as the next Fable rocks after the in-flight #2773/#3037/#3087
wave lands (they share the classifier arm — build once); #2956 L0/L1 and
#3101/E1 as parallel, conflict-free window fillers; refresh the standalone
JSONL before scoping anything else in domain 3.

## Stale-knowledge corrections (recorded so nobody re-chases)

1. `reference_standalone_any_string_value_read_substrate` (memory) — FIXED
   on main; dynamic any-typed string reads work (probe ✓). Do not re-mine.
2. #3031's "P5 needs #797/#1460/#1462 descriptor bits" — bits EXIST now;
   P5 is executable.
3. The 2026-06-26 standalone JSONL leak counts predate #2962/#2902/#2959/
   #3027 — treat as upper bounds only; refresh before scoping.
4. CLAUDE.md "Skip filters: eval, with, Proxy…" remains stale doc (already
   flagged in #3031) — these categories RUN; the gap is pass-rate.
