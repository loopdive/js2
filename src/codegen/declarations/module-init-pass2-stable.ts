// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3523 R4 gap-1a/1b) Would a second direct compile of the module-init
 * population reproduce the first one?
 *
 * ## Why the question is worth asking
 *
 * A typed-Unsupported module initializer compiles its DIRECT body twice:
 * `module-init-pass1` seeds closure/setup discovery for the top-level function
 * bodies compiled after it, and `module-init-pass2` recompiles once those
 * bodies are done. Pass 1's body is already kept structurally valid to the end
 * (module-global and late func-index shifts patch `ctx.pendingInitBody`), so
 * whenever the recompile can only reproduce it, the caller may keep pass 1's
 * body and skip pass 2 outright.
 *
 * Pass 1 itself is NOT optional and this predicate never proposes removing it:
 * function bodies deliberately consume pass 1's END integrity state
 * (`definedPropertyFlags` / `frozenVars` / `sealedVars` /
 * `nonExtensibleVars`, the #2965 snapshot) and its `closureMap` discovery.
 * Compiling bodies first and running a single init compile in the pass-2 slot
 * was measured (2026-09-01) to turn a correct `TypeError` on a frozen object
 * into a silent write, to lose `call_ref` codegen on closure shapes, and to
 * regress six async test262 files. Only the SECOND compile is in question here.
 *
 * ## What makes a second compile differ — the three measured mechanisms
 *
 * 1. **The inlinable-function registry.** Pass 2's stated reason is "so call
 *    sites inside module-level code can see the final inlinable-function
 *    registry". `ctx.inlinableFunctions` is consulted only when compiling a
 *    call, so a population with no call anywhere cannot observe it (gap-1a).
 * 2. **Closure re-lifting.** A population that mints a closure
 *    (arrow / function-expression / class-expression) hands pass 2 a second
 *    lifting opportunity: pass 2 emits a re-lifted `$__closure_N` twin and
 *    applies registry inlining INSIDE the closure body it recompiles. Runtime
 *    values stay equal, but the bytes differ, so those populations keep both
 *    passes (gap-1b).
 * 3. **The closure-info registry** (#5335). `matchClosureInfoBySignature`
 *    iterates `ctx.closureInfoByTypeIdx` to lower a call whose CALLEE is a
 *    value — `outer()()`, `mk()()`, a callable-typed element access. That
 *    registry is filled by lifting closures out of the top-level function
 *    BODIES compiled BETWEEN the two passes, so its content at pass 1 and at
 *    pass 2 are different things. This one is not a byte-identity question: on
 *    a miss the call-of-call lowering falls through to a tail that evaluates
 *    both calls and answers `undefined`, so pass 1's kept body is WRONG, not
 *    merely different. See "Why mechanism 3 is not syntactic" below.
 *
 * The first two mechanisms compose syntactically: a population is
 * pass-2-stable when it is missing EITHER ingredient — no call at all, or no
 * closure at all. Both halves are measured, not argued:
 *
 * | population                     | measured                                    |
 * | ------------------------------ | ------------------------------------------- |
 * | call-free (closure or not)     | gap-1a: 50/50 corpus binaries byte-identical |
 * | call-bearing, closure-free     | gap-1b: 52/52 shape×lane byte-identical     |
 * | call-bearing AND closure-bearing | bytes DIFFER — keeps two passes           |
 *
 * (The one measured exception to byte identity is `console.log` on WASI, where
 * the two-pass build carries a duplicate DEAD `"\n"` data segment that pass 2
 * re-registers; the one-pass build is smaller and its code is identical.)
 *
 * Mechanism 3 does NOT compose that way, and the rest of this file exists to
 * say why.
 *
 * ## The refusals
 *
 * | node                       | class     | why                                     |
 * | -------------------------- | --------- | --------------------------------------- |
 * | `CallExpression`           | call      | the registry consumer (covers `super(…)`, `import(…)`, `a?.()`) |
 * | `NewExpression`            | call      | construction dispatch reads the same name-keyed state |
 * | `TaggedTemplateExpression` | call      | a call in operator clothing             |
 * | `ArrowFunction`            | closure   | pass 2 re-lifts it                      |
 * | `FunctionExpression`       | closure   | same                                    |
 * | `ClassExpression`          | closure   | its methods are lifted with it          |
 * | `Decorator`                | always    | evaluates its expression as a call, on a class that is itself lifted |
 * | `AwaitExpression`          | always    | suspends into machinery compiled later  |
 *
 * ## What the scan looks at
 *
 * The FULL subtree of exactly the nodes `compileModuleInitBody` compiles —
 * every `ctx.moduleInitStatements` statement and every `ctx.staticInitExprs`
 * entry's `staticBlock ?? initializer`. Nested bodies are INCLUDED, which is
 * what makes `const f = () => h()` a refusal: that closure body compiles
 * during the init statement and carries both ingredients at once.
 *
 * The scan deliberately does NOT look at the source file. A call inside a
 * top-level function body is not an init input and must not disqualify; a call
 * inside a static block, or inside a class-expression method whose owning
 * statement reaches the population, must be seen.
 *
 * Fail-closed: anything not provably stable keeps both passes. There is no
 * allowlist of "harmless" callees — the point of the gate is that it needs no
 * judgement about what a call does.
 *
 * ## Why mechanism 3 is not syntactic (#5335 — a silent wrong answer)
 *
 * `console.log(outer()()())` over
 * `function outer() { let a = 1; return function () { let b = 2; return
 * function () { return a + b; }; }; }` printed **`0`** instead of `3` on `main`
 * for three days: it compiled, validated, did not trap, and answered a number
 * nobody wrote.
 *
 * The population is one statement. It is call-bearing and — reading its own
 * syntax — closure-free, because the closures live inside `outer`, a
 * separately-compiled top-level function. So the scan below said "closure-free"
 * and pass 2 was skipped. But the closure `outer` MINTS is registered while
 * `outer`'s BODY compiles, which happens after pass 1 and before pass 2. At
 * pass 1 `matchClosureInfoBySignature` found nothing to match, and
 * `call-tail-dispatch.ts`'s "CallExpression as callee" arm fell through to a
 * tail that evaluates both calls and pushes `ref.null extern` — which unboxes
 * to `0`.
 *
 * **"Mints no closure" is not transitive through callees, and no bounded
 * syntactic scan can make it so.** Measured on this branch, the same `0` comes
 * out through two intermediate hops (`a() -> b() -> function () {…}`) and
 * three; it survives arrows, and it needs no nesting at all — the one-level
 * `mk()()` is wrong the same way. A "refuse on any call to a local function
 * whose own body is not closure-free" rule (the cheap reading of the same idea)
 * answers the one-hop case and still miscompiles the two-hop one. Chasing it
 * transitively means a whole-program call graph with a conservative answer on
 * recursion, indirect calls, host calls and dynamic dispatch — which is a great
 * deal of machinery to approximate a fact the compiler can simply LOOK UP.
 *
 * So this file does not ask "could a callee mint a closure?". It asks the
 * question that actually decides the outcome:
 *
 *   > Did `ctx.closureInfoByTypeIdx` — the exact map the call-of-call lowering
 *   > iterates — change while the function bodies between the two passes were
 *   > compiled?
 *
 * That is two integer reads, it needs no judgement about what a call does
 * (preserving this gate's founding principle), and it cannot be defeated by
 * transitivity, recursion, indirect calls or a host callee, because it observes
 * the effect rather than predicting the cause.
 *
 * It is deliberately applied to BOTH halves of the syntactic predicate, not
 * just gap-1b. A call-free population provably cannot read the registry, so
 * exempting gap-1a would be sound — but the exemption would be argued rather
 * than measured, and this gate has now been wrong once for exactly that reason.
 * Uniform costs little: on the 120-program differential corpus the fast path
 * fires 105 times and this guard withdraws 8 (97 kept, 92.4 %); on 651
 * module-init populations across lodash's 1048 real modules it fires 579 and
 * the guard withdraws 53 (526 kept, 90.8 %). Both withdrawal sets are almost
 * entirely `closures/*`-shaped modules — the population at risk.
 *
 * What this does NOT claim: that the closure-info registry is the only
 * between-pass state a kept pass-1 body can read wrongly. It is the only one
 * measured to produce a wrong ANSWER (the other two produce different bytes
 * with equal runtime values). A future mechanism-4 belongs in the same mark.
 */

import ts from "typescript";
import type { CodegenContext } from "../context/types.js";

/**
 * What a node contributes to the pass-2 divergence question.
 *
 * - `none` — the node cannot make pass 2 differ.
 * - `call` — consults the inlinable-function registry, which grows between
 *   passes.
 * - `closure` — gives pass 2 a second closure-lifting opportunity.
 * - `always` — refuses on its own, without needing a partner.
 */
type Ingredient = "none" | "call" | "closure" | "always";

function ingredientOf(node: ts.Node): Ingredient {
  switch (node.kind) {
    case ts.SyntaxKind.CallExpression:
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.TaggedTemplateExpression:
      return "call";
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassExpression:
      return "closure";
    case ts.SyntaxKind.Decorator:
    case ts.SyntaxKind.AwaitExpression:
      return "always";
    default:
      return "none";
  }
}

/**
 * Test-only anti-vacuity seam. With
 * `JS2WASM_TEST_ADMIT_CLOSURES_IN_MODULE_INIT_PASS2_GATE=1` the closure half of
 * the predicate is dropped, which lets the suite DEMONSTRATE that the closure
 * refusal is load-bearing rather than decorative: admit closures and a
 * call-inside-an-arrow population stops being byte-identical to its two-pass
 * build, and a closure-bearing test262 harness population starts reporting its
 * diagnostics twice. The seam only ever WIDENS admission, and nothing outside
 * the mutation test reads it.
 */
const CLOSURE_ADMIT_SEAM = "JS2WASM_TEST_ADMIT_CLOSURES_IN_MODULE_INIT_PASS2_GATE";

/**
 * True when NOTHING in the accumulated module-init population makes a second
 * direct compile able to differ from the first.
 *
 * `ctx.moduleInitStatements` / `ctx.staticInitExprs` are graph-global
 * accumulated state, so a statement contributed by an EARLIER source counts
 * even when the emitting source's own statements are stable — the population,
 * not the file, decides.
 */
function moduleInitPopulationIsPass2Stable(ctx: CodegenContext): boolean {
  const admitClosures = process.env[CLOSURE_ADMIT_SEAM] === "1";
  let sawCall = false;
  let sawClosure = false;
  const stack: ts.Node[] = [];
  for (const statement of ctx.moduleInitStatements) stack.push(statement);
  for (const entry of ctx.staticInitExprs) {
    const node = entry.staticBlock ?? entry.initializer;
    if (node) stack.push(node);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (ingredientOf(node)) {
      case "always":
        return false;
      case "call":
        if (sawClosure) return false;
        sawCall = true;
        break;
      case "closure":
        if (admitClosures) break;
        if (sawCall) return false;
        sawClosure = true;
        break;
      default:
        break;
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return true;
}

/**
 * (#5335) The closure-info registry as pass 1 left it.
 *
 * Taken AFTER pass 1 returns, not before it: the question is whether the
 * FUNCTION BODIES compiled between the passes moved the registry, and a
 * population that lifts its own closures during pass 1 has already been
 * refused by the syntactic scan above. Marking after pass 1 keeps 97 of the
 * corpus's 105 fast-path hits instead of 96 — measured, and the reason the
 * mark is not simply taken at the top of the enclosing function.
 *
 * `size` is the whole fingerprint because entries are append-only: a closure is
 * registered once, at lift time, keyed by its struct type index. Nothing
 * rewrites an existing entry, so a changed map is a bigger map.
 */
export function markModuleInitClosureRegistry(ctx: CodegenContext): number {
  return ctx.closureInfoByTypeIdx.size;
}

/**
 * (#3523 R4 gap-1a/1b, #5335) The whole decision: may the caller keep pass 1's
 * body and skip the recompile?
 *
 * Both conjuncts must hold.
 *
 * 1. The population is syntactically pass-2-stable — it is missing the call
 *    ingredient or the closure ingredient (gap-1a / gap-1b, measured).
 * 2. `ctx.closureInfoByTypeIdx` is exactly what it was when pass 1 finished,
 *    so the call-of-call lowering could not have matched a closure at pass 2
 *    that it missed at pass 1 (#5335).
 *
 * `mark` is `undefined` when pass 1 did not run in this call. That is not a
 * "nothing changed" answer, it is an ABSENT answer, and this gate fails closed
 * on absent answers: no mark, no skip. (Every route that reaches the pass-2
 * decision with `moduleInitMode === "full"` and an unskipped body has run pass
 * 1; the discovery-static route has not, and it already forces pass 2 for its
 * own reason — this is the belt to that suspenders.)
 *
 * The `CLOSURE_ADMIT_SEAM` mutation test needs the registry conjunct dropped
 * too. That seam exists so the suite can DEMONSTRATE the closure refusal is
 * load-bearing by widening admission until the build changes; leaving a second
 * refusal standing behind it would make the mutation invisible and the
 * anti-vacuity pin vacuous. Consistent with the seam's stated contract — it
 * only ever WIDENS admission, and nothing outside that test reads it.
 */
export function moduleInitPass2IsSkippable(ctx: CodegenContext, mark: number | undefined): boolean {
  if (!moduleInitPopulationIsPass2Stable(ctx)) return false;
  if (process.env[CLOSURE_ADMIT_SEAM] === "1") return true;
  return mark !== undefined && ctx.closureInfoByTypeIdx.size === mark;
}
