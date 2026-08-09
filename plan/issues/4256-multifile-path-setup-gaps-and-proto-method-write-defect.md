---
id: 4256
title: "The specialized fnctor dispatch arm is a CORRECTNESS dependency only the single-file path reaches — multi drops prototype-method this-writes; plus 10 more single-path-only setup steps"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, objects, modules
goal: core-semantics
horizon: l
related: [4235, 4133, 4037, 3683, 3673, 2179]
origin: "2026-08-09, while fixing #4235: the audit the issue asked for turned up twelve MORE single-path-only setup steps, and validating the fix surfaced a live multi-path miscompile that predates it."
---

# #4256 — the rest of the multi-file setup gap, and a live prototype-method defect

**The framing that matters (established 2026-08-09): the specialized fnctor
dispatch arm is a CORRECTNESS dependency, not an optimization — and only the
single-file path reaches it.** Removing either the factory or the expando
write from the repro makes it fail on the SINGLE path too, so this is not
"multi is missing a fast path"; it is "a write only lands when the instance
reaches an arm one path never reaches". Treat any fix that merely restores
parity of *speed* as not addressing this issue.

#4235 fixed ONE of these (the fnctor pipeline). This is what the audit it
mandated turned up, plus the correctness defect found while validating it.

## Part A — a live miscompile: prototype-method `this.<field> = …` writes are
## dropped on the multi-file path

**This is the urgent half.** It is a wrong answer, not a missed optimization,
and it predates #4235.

Same source, same options (`target: "standalone"`), one file, both paths:

```ts
function Node(pos: any) { this.type = ""; this.start = pos; this.end = 0; }
Node.prototype.finish = function (t: any, end: any) {
  this.type = t; this.end = end; return this;
};
function makeA(p: any) { const n = new Node(p); n.extraA = 1; return n; }
function makeB(p: any) { const n = new Node(p); n.extraB = 2; n.extraC = 3; return n; }

export function c2(): number { const a: any = makeA(1); a.finish("A", 5); return (a.end as number) === 5 ? 1 : 0; }
export function c3(): number { const a: any = makeA(1); a.finish("A", 5); return (a.type as string) === "A" ? 1 : 0; }
export function c4(): number { const b: any = makeB(2); return (b.extraC as number) === 3 ? 1 : 0; }
```

| | `c2` (`this.end`) | `c3` (`this.type`) | `c4` (plain own field) |
| --- | --- | --- | --- |
| `compile()` | **1** | **1** | 1 |
| `compileMulti()` | **0** | **0** | 1 |

Both compiles report `success: true` with zero errors — the wrong value is
returned silently. `c4` passing is the control that says this is specific to
the prototype-method `this` write, not to fnctor own-field access in general.

Established with a full-tree A/B against `HEAD` (all three files #4235 touched
reverted via file copies — **not** `git stash`, which is a shared stack across
worktrees). The baseline fails identically, so #4235 is exactly neutral on it:
it neither caused nor fixed this.

### Narrowing (2026-08-09) — it is NOT the analysis, and NOT the setter

Measured after #4235 landed the pipeline on the multi path, so the escape gate
now runs on both. Minimal repro (`.tmp/repro-4256.mts` shape), one file,
`target: "standalone"`, driven through both compilers:

```ts
function K(p: any) { this.a = p; this.n = 0; }
K.prototype.setN = function (v: any) { this.n = v; };
function make(p: any) { const k = new K(p); k.extra = 1; return k; }
export function mustLand(): number { const k: any = make(1); k.setN(7); return (k.n as number) === 7 ? 1 : 0; }
```

| probe | single | multi |
| --- | --- | --- |
| `mustLand` — proto-method `this.n = v` (POSITIVE CONTROL) | PASS | **FAIL(0)** |
| read back via another proto method | PASS | **FAIL(0)** |
| string-valued proto-method write | PASS | **FAIL(0)** |
| `k.extra = 1` plain own-field write (negative control) | PASS | PASS |
| ctor-assigned `this.a` (negative control) | PASS | PASS |

Ruled OUT, each by direct comparison:

- **Not the escape-gate analysis.** Both paths print exactly
  `1 new F() site(s): reconstruct=1 keep-typed=0 keep-static=0;
  receiverStruct flow-map entries=3`. Identical verdicts.
- **Not the struct shape.** Both emit
  `(type $__fnctor_K (struct (field $a …) (field $n (mut f64)) (field $extra …)
  (field $$presence_0 (mut i32)) (field $$constructor externref)))`. The
  written field `$n` is `(mut f64)` on both. (`$a` differs — `f64` single vs
  `externref` multi — which is the `applyNumericPropertyAnalysis` row below,
  and is NOT the defect: `$n` is identical and still fails.)
- **Not the setter.** `$__set_member_n` is structurally identical on both
  (same `ref.test` / `ref.cast` / `struct.set <t> 1` shape, modulo type
  renumbering).

**The divergence is the CALL helper.** `$__call_m_setN_1` differs
structurally:

- **single** — walks the prototype (`global.get <proto>`, two calls) and then
  `ref.test`s the resolved callee against a closure type with an arity check
  (`struct.get … i32.const 1 i32.le_s`), i.e. a specialized, arity-checked
  prototype dispatch.
- **multi** — a much shorter generic sequence (build argvec → generic invoke),
  with no prototype-walk and no arity check.

So the multi path invokes `setN` through the generic dynamic method-call arm,
and the receiver that reaches `$__set_member_n` there evidently fails its
`ref.test (ref $__fnctor_K)`, taking the else arm and dropping the write.

Two further facts that constrain the mechanism:

- Removing EITHER the factory or the `k.extra = 1` expando makes the repro
  fail on **single** too. So the write only lands when the instance is
  `reconstruct`-approved AND reaches the specialized dispatch — the specialized
  arm is load-bearing for correctness here, not just for speed.
- Excluded by direct experiment (temporarily wired into `generateMultiModule`,
  neither flipped the result): `collectUserMethodNames` and
  `applyNumericPropertyAnalysis`.

**The arm's INPUT is identical on both paths — so the consumers are where to
look, and the analysis is fully exonerated.** The specialized arm gates on
`approvedNames` readers across three files, so the first question is whether
those readers are being handed different sets. They are not. Instrumenting both
`analyzeFnctorEscapeGate` call sites in `src/codegen/index.ts` and compiling
the repro through each path:

```
[approved:single] names=[K] ctorDecls=[K] reserved=[]
[approved:multi]  names=[K] ctorDecls=[K] reserved=[]
```

Identical. So the divergence is NOT upstream of the consumers — some consumer
of `approvedNames`, or a second precondition it carries, behaves differently
on the multi path with the same input.

**Next step:** find what gates the specialized arm of `$__call_m_<name>_<arity>`.
It is not in `closed-method-dispatch.ts` (no fnctor/ctx-field gate there), so it
is emitted by whichever pass installs the fnctor prototype dispatch —
`fnctor-prototype.ts`, `typed-this.ts`, or `object-runtime.ts:~1544`, all three
of which read `fnctorEscapeGate.approvedNames`. Since the set they receive is
the same, look for each one's OTHER precondition and check it against the ten
Part-B rows.

**Note on grepping the WAT while working this:** `.tmp/*.wat` contains NUL
bytes, so plain `grep` treats it as binary and prints **nothing** — which reads
exactly like "the symbol is absent". Use `grep -a`. This produced two false
"it's not there" conclusions during this investigation before being caught.

## Part B — ten more single-path-only setup steps

Produced by diffing `generateModule`'s prologue against
`generateMultiModule`'s and then verifying each name is absent from the whole
`generateMultiModule` body (main @ `49cab5c82`). #4235 fixed the first three
rows of the original thirteen; these ten remain:

| step | sets | note |
| --- | --- | --- |
| `applyNumericPropertyAnalysis` | `ctx.numericPropertyNames`, `stringPropertyNames`, `numericFunctionNames`, the numeric-local oracle | #3683 S4a. Standalone-only. Reads `fnctorEscapeGate.receiverStruct`, so it is fnctor-adjacent, but it changes numeric field REPRESENTATION graph-wide — deliberately excluded from #4235 as a separate blast radius. Already takes `readonly ts.SourceFile[]`, so wiring it is a one-liner; the risk is in what it changes, not in the plumbing. |
| `collectUserMethodNames` | `ctx.userMethodNames` | #3673. Without it the guarded native-string method lowering cannot tell a genuine `String.prototype` call from a same-named USER method on an object receiver. |
| `scanModuleMemberDeletes` | `ctx.moduleUsesDelete`, `ctx.memberDeleteReceiverNames` | #2179/#4187. Without it an `any`-receiver property read keeps the inline `struct.get` fast path and ignores the runtime delete tombstone. |
| `sourceUsesRuntimeEvalBoundary` / `isRuntimeEvalBoundaryName` | `ctx.runtimeEvalCallableBoundaryEnabled` | standalone/WASI. |
| top-level `function` declaration pre-scan | `ctx.topLevelFunctionNames` | #1983. Its absence means `classMemberFuncKey` cannot detect a `${className}_${member}` ↔ user-function collision on the multi path. Note this interacts with #4133's bare-name `funcMap` collisions, which multi already has to work around. |
| `sourceHasDynamicTaConstruct` | `ctx.moduleUsesDynTaView` | #3057. Standalone/WASI. |
| `reserveTypedArraySubviewTypes` | `$__subview_<elem>` type slots | #2357/#47. Standalone/WASI. Reserved up-front on the single path *specifically* so the subview type index is pass-invariant. |
| `analyzeLinearUint8` + `reserveLinearU8AllocType` | `ctx.linearUint8` | #1886. WASI only. |
| `registerJsxRuntimeImports` | JSX runtime imports | multi-file JSX gets no runtime imports. |
| `addStringImports` | string helper imports | registered as a lazy delegate elsewhere, so verify whether multi genuinely lacks it before wiring. |

## Why this keeps happening

`generateModule` and `generateMultiModule` are two ~800–1300-line prologues
that must stay in step by hand, and nothing tells you when they diverge. Every
fix in this family has been found the same way — someone measured the multi
path and got a zero (#4037's `$ObjVecArr`, #4133's `funcMap`, #4235's fnctor
pipeline, and now these). **Consider a structural fix as part of this issue:**
extract the shared prologue into one `setUpModuleAnalyses(ctx, sourceFiles)`
that both entry points call, so a new analysis is wired into both by
construction rather than by memory. That is the change that stops the next
one.

## Acceptance criteria

- [ ] Part A root-caused and fixed: `c2`/`c3` above return 1 through
      `compileMulti()`, with a regression test that pins the single/multi
      runtime VALUES (not just compile success — both paths already "succeed").
- [ ] Each Part-B row is either wired into `generateMultiModule` or given a
      recorded, reasoned decline in this file. No row is left unstated.
- [ ] Where a row is wired, its gate matches the single-path gate exactly, so
      graphs that do not use the feature stay byte-identical.
- [ ] A check that FAILS when the two prologues diverge again — the structural
      fix above, or a test that asserts the multi path sets every `ctx` field
      the single path sets for a fixture exercising all of them.
