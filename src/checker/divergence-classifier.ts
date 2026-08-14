// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4408) Structural classification of an oracle divergence.
 *
 * The differential lane (`DifferentialOracle`) answers from the TS5 checker and
 * records where the in-house backend disagrees. Turning those records into a
 * worklist needs one judgement per row: **is this a disagreement about a fact,
 * or is one side simply declining to answer?**
 *
 * The original predicate tested the WHOLE answer string against four literals
 * (`unresolvable` / `undefined` / `mixed` / `[]`). That is correct only for
 * scalar answers, and the oracle's answers are mostly not scalar. It missed:
 *
 *  1. **Abstention nested in a composite.** `signatureOf` renders as
 *     `(p1,p2)->r#arity`, so a total abstention reads
 *     `(unresolvable)->unresolvable#1` — not one of the four literals.
 *     Likewise `array<any>` against `array<number>`.
 *  2. **Abstention carried by a boolean polarity.** For `isBooleanProducing`
 *     the conservative answer is `false`; for `isUnresolvableIdentifier` it is
 *     `true`. Both were scored as conflicts.
 *  3. **Abstention on the CHECKER side.** `declarationsOf` returning `[]` from
 *     the checker means the *checker* declined. There was no bucket for that,
 *     so it landed in `conflicting` and read as an in-house bug.
 *  4. **`any` treated as a fact.** For a wasm lowerer `any` carries no static
 *     information; it is the same answer as `unresolvable`.
 *
 * Measured cost of getting this wrong: on a 2,137-input corpus the old
 * predicate reported **908 conflicts**; classifying the same rows structurally
 * gives 136 same-meaning, 306 in-house-weaker, 366 checker-weaker and **100**
 * genuine. `signatureOf` alone accounted for 374 of the 908 and has 12.
 *
 * `checker-weaker` is a first-class verdict, not a sub-case of "conflict": the
 * in-house backend knowing more than TypeScript is a frequent and often
 * CORRECT outcome (#4410) — TS is unsound for `with`, direct `eval` and annexB
 * hoisting, and its `ts.Program` does not contain re-entrant eval'd sources.
 */

/**
 * Verdict for one recorded divergence.
 *
 * - `same-meaning` — different spellings of the same answer.
 * - `inhouse-weaker` — the in-house backend declined; safe, possibly lossy.
 * - `checker-weaker` — the in-house backend claims a fact the checker will not
 *   give. Needs adjudication: it may be a precision win or an invention.
 * - `genuine-conflict` — both claim a fact and the facts are incompatible.
 */
export type DivergenceVerdict = "same-meaning" | "inhouse-weaker" | "checker-weaker" | "genuine-conflict";

/**
 * Leaf answers that carry no static information for a wasm lowerer. `any` is
 * in here deliberately: TypeScript's `any` is the checker's way of saying "no
 * useful type", exactly what `unresolvable` says on the other side.
 */
const NO_INFO: ReadonlySet<string> = new Set(["unresolvable", "any", "undefined", "mixed", "unknown", "error", ""]);

/**
 * Queries whose answer is a boolean where ONE polarity is the abstention.
 * Maps the query name to the string form of its conservative answer.
 */
const CONSERVATIVE_POLARITY: ReadonlyMap<string, string> = new Map([
  // "I cannot prove this produces a boolean."
  ["isBooleanProducing", "false"],
  // "I cannot resolve this identifier."
  ["isUnresolvableIdentifier", "true"],
]);

/** Queries answering with a list, where the empty list is the abstention. */
const LIST_QUERIES: ReadonlySet<string> = new Set(["declarationsOf", "unionPartsOf"]);

/** Split a composite answer into its leaves: `array<union<a|b>>` → a, b. */
function leavesOf(answer: string): string[] {
  return answer
    .split(/[<>()|,#>-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Structural skeleton: every identifier-shaped leaf becomes a hole. */
function skeletonOf(answer: string): string {
  return answer.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, "•");
}

/**
 * A side that answered "no information" in EVERY type position has abstained,
 * even when the two answers have different shapes.
 *
 * The shape-matched path below cannot see this: the checker's
 * `(any,number,array<any>)->boolean#3` and the in-house
 * `(unresolvable,unresolvable,unresolvable)->unresolvable#3` describe the same
 * signature, but one nests a generic and the other does not, so their
 * skeletons differ. That pair is a total in-house abstention, and it is the
 * single most common row in the corpus.
 *
 * Numeric leaves (a signature's declared arity) are compared exactly instead:
 * they are structure, not type information, so a differing arity is a real
 * disagreement no matter how blank the rest is.
 */
function classifyTotalAbstention(checker: string, inhouse: string): DivergenceVerdict | undefined {
  const isNumeric = (leaf: string) => /^\d+$/.test(leaf);
  const checkerLeaves = leavesOf(checker);
  const inhouseLeaves = leavesOf(inhouse);

  const checkerNums = checkerLeaves.filter(isNumeric);
  const inhouseNums = inhouseLeaves.filter(isNumeric);
  if (checkerNums.length !== inhouseNums.length || checkerNums.some((n, i) => n !== inhouseNums[i])) {
    return "genuine-conflict";
  }

  const checkerTypes = checkerLeaves.filter((l) => !isNumeric(l));
  const inhouseTypes = inhouseLeaves.filter((l) => !isNumeric(l));
  if (checkerTypes.length === 0 || inhouseTypes.length === 0) return undefined;

  const checkerBlank = checkerTypes.every((l) => NO_INFO.has(l));
  const inhouseBlank = inhouseTypes.every((l) => NO_INFO.has(l));
  if (checkerBlank && inhouseBlank) return "same-meaning";
  if (inhouseBlank) return "inhouse-weaker";
  if (checkerBlank) return "checker-weaker";
  return undefined;
}

/** Compare two same-shaped composites leaf by leaf. */
function classifyComposite(checker: string, inhouse: string): DivergenceVerdict {
  const checkerLeaves = leavesOf(checker);
  const inhouseLeaves = leavesOf(inhouse);
  if (checkerLeaves.length !== inhouseLeaves.length) return "genuine-conflict";

  let inhouseWeaker = false;
  let checkerWeaker = false;
  for (let i = 0; i < checkerLeaves.length; i++) {
    if (checkerLeaves[i] === inhouseLeaves[i]) continue;
    const checkerBlank = NO_INFO.has(checkerLeaves[i]);
    const inhouseBlank = NO_INFO.has(inhouseLeaves[i]);
    // Two different spellings of "no information" are the SAME answer.
    if (checkerBlank && inhouseBlank) continue;
    if (inhouseBlank) inhouseWeaker = true;
    else if (checkerBlank) checkerWeaker = true;
    else return "genuine-conflict";
  }
  if (inhouseWeaker && checkerWeaker) return "genuine-conflict";
  if (inhouseWeaker) return "inhouse-weaker";
  if (checkerWeaker) return "checker-weaker";
  return "same-meaning";
}

/**
 * Classify one divergence. `query` matters: the same answer string means
 * different things for different questions (see {@link CONSERVATIVE_POLARITY}).
 */
export function classifyDivergence(query: string, checker: string, inhouse: string): DivergenceVerdict {
  if (checker === inhouse) return "same-meaning";

  const conservative = CONSERVATIVE_POLARITY.get(query);
  if (conservative !== undefined) return inhouse === conservative ? "inhouse-weaker" : "checker-weaker";

  if (LIST_QUERIES.has(query)) {
    if (inhouse === "[]") return "inhouse-weaker";
    if (checker === "[]") return "checker-weaker";
    return "genuine-conflict";
  }

  const checkerBlank = NO_INFO.has(checker);
  const inhouseBlank = NO_INFO.has(inhouse);
  if (checkerBlank && inhouseBlank) return "same-meaning";
  if (inhouseBlank) return "inhouse-weaker";
  if (checkerBlank) return "checker-weaker";

  if (skeletonOf(checker) === skeletonOf(inhouse)) return classifyComposite(checker, inhouse);
  return classifyTotalAbstention(checker, inhouse) ?? "genuine-conflict";
}
