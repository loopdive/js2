// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218) Oracle backend selection — the ONE place that decides which
 * implementation of {@link TypeOracle} backs `ctx.oracle`.
 *
 * Three backends, same frozen surface (#1930):
 *
 *   - `"checker"` — {@link TsCheckerOracle}, the TS5 `ts.TypeChecker`. **Default.**
 *   - `"inhouse"` — {@link InHouseOracle}, the checker-free binder + annotation
 *     propagation backend (this issue's Phase 1).
 *   - `"differential"` — {@link DifferentialOracle}: answers from the CHECKER
 *     (so compile behavior is byte-identical) while recording every query
 *     where the in-house backend disagrees. This is the measurement lane; it
 *     is how "conformance parity" gets evidence instead of assertion.
 *
 * Selection order: explicit option → `JS2WASM_ORACLE_BACKEND` env → checker.
 * The env var exists so an entire test262 / equivalence run can be flipped
 * without threading an option through every driver.
 */
import type { ts } from "../ts-api.js";
import {
  TsCheckerOracle,
  type JsTag,
  type OracleTypeKey,
  type SignatureFact,
  type TypeFact,
  type TypeOracle,
} from "./oracle.js";
import { InHouseOracle, factKey } from "./inhouse-oracle.js";
import { classifyDivergence, type DivergenceVerdict } from "./divergence-classifier.js";

export type OracleBackend = "checker" | "inhouse" | "differential";

const VALID_BACKENDS: ReadonlySet<string> = new Set<OracleBackend>(["checker", "inhouse", "differential"]);

/** Resolve the backend for this compile (explicit option wins over env). */
export function resolveOracleBackend(explicit?: OracleBackend): OracleBackend {
  if (explicit) return explicit;
  const fromEnv = process.env.JS2WASM_ORACLE_BACKEND;
  if (fromEnv && VALID_BACKENDS.has(fromEnv)) return fromEnv as OracleBackend;
  return "checker";
}

/** Construct the oracle backing `ctx.oracle`. */
export function createTypeOracle(checker: ts.TypeChecker, explicit?: OracleBackend): TypeOracle {
  switch (resolveOracleBackend(explicit)) {
    case "inhouse":
      return new InHouseOracle();
    case "differential":
      return new DifferentialOracle(new TsCheckerOracle(checker), new InHouseOracle());
    default:
      return new TsCheckerOracle(checker);
  }
}

export interface OracleDivergence {
  query: string;
  checker: string;
  inhouse: string;
  /** Source text of the queried node, truncated. */
  node: string;
  /** Four-way structural verdict (#4408). */
  verdict: DivergenceVerdict;
}

/**
 * Divergence tally for a differential run, bucketed by
 * {@link classifyDivergence}'s four-way verdict (#4408).
 *
 * `agreements` folds in `same-meaning`: two spellings of the same answer are
 * an agreement, not a divergence. `weakened` is `inhouse-weaker` — the in-house
 * backend declined, which its contract permits. `checkerWeaker` is the reverse
 * and is NOT a bug signal on its own: the in-house backend knowing more than
 * TypeScript is frequent and often correct (#4410). Only `conflicting` means
 * both sides claim a fact and the facts are incompatible.
 */
/** Per-query tally — which oracle question diverges, not just how often. */
export interface QueryDivergence {
  agreements: number;
  weakened: number;
  checkerWeaker: number;
  conflicting: number;
}

export class DivergenceLedger {
  agreements = 0;
  weakened = 0;
  /** In-house claimed a fact the checker declined — adjudicate, don't assume. */
  checkerWeaker = 0;
  conflicting = 0;
  readonly samples: OracleDivergence[] = [];
  /**
   * (#4218) Per-query breakdown. The global counters answer "is the in-house
   * backend safe?"; this answers "which query do I fix next?" — the whole
   * point of a differential run is to produce a worklist, and a single total
   * cannot. Unbounded by design: the key space is the oracle's frozen query
   * vocabulary (~15 names plus `propertyFactOf:<name>`), not the node count.
   */
  readonly byQuery = new Map<string, QueryDivergence>();
  /**
   * (#4218) Conflict samples, quota'd PER QUERY.
   *
   * `samples` cannot serve this purpose: it is a single FIFO over *all*
   * divergences, and `weakened` outnumbers `conflicting` ~54:1 on a wide
   * corpus — so the shared cap fills with weakened entries before a single
   * conflict is seen. Measured on the 2,137-input run: 908 conflicts existed
   * and 25 were sampled, none of them from `signatureOf`, the query with the
   * *highest* conflict rate. A worklist you cannot see the top item of is not
   * a worklist.
   */
  readonly conflictSamples: OracleDivergence[] = [];
  private readonly conflictQuota = new Map<string, number>();
  private readonly maxSamples: number;
  private readonly maxConflictsPerQuery: number;

  constructor(maxSamples = 200, maxConflictsPerQuery = 60) {
    this.maxSamples = maxSamples;
    this.maxConflictsPerQuery = maxConflictsPerQuery;
  }

  private tally(query: string): QueryDivergence {
    let entry = this.byQuery.get(query);
    if (!entry) {
      entry = { agreements: 0, weakened: 0, checkerWeaker: 0, conflicting: 0 };
      this.byQuery.set(query, entry);
    }
    return entry;
  }

  record(query: string, checkerAnswer: string, inhouseAnswer: string, node: string): void {
    const perQuery = this.tally(query);
    const verdict = classifyDivergence(query, checkerAnswer, inhouseAnswer);
    if (verdict === "same-meaning") {
      this.agreements++;
      perQuery.agreements++;
      return;
    }
    if (verdict === "inhouse-weaker") {
      this.weakened++;
      perQuery.weakened++;
    } else if (verdict === "checker-weaker") {
      this.checkerWeaker++;
      perQuery.checkerWeaker++;
    } else {
      this.conflicting++;
      perQuery.conflicting++;
    }
    // Sample everything that is not a plain in-house abstention: both a
    // genuine conflict and a checker-weaker row need a human verdict.
    if (verdict !== "inhouse-weaker") {
      const used = this.conflictQuota.get(query) ?? 0;
      if (used < this.maxConflictsPerQuery) {
        this.conflictQuota.set(query, used + 1);
        this.conflictSamples.push({ query, checker: checkerAnswer, inhouse: inhouseAnswer, node, verdict });
      }
    }
    if (this.samples.length < this.maxSamples) {
      this.samples.push({ query, checker: checkerAnswer, inhouse: inhouseAnswer, node, verdict });
    }
  }

  summary(): { agreements: number; weakened: number; checkerWeaker: number; conflicting: number; total: number } {
    const total = this.agreements + this.weakened + this.checkerWeaker + this.conflicting;
    return {
      agreements: this.agreements,
      weakened: this.weakened,
      checkerWeaker: this.checkerWeaker,
      conflicting: this.conflicting,
      total,
    };
  }

  /** Reset between corpus files so a run can attribute divergence per input. */
  reset(): void {
    this.agreements = 0;
    this.weakened = 0;
    this.checkerWeaker = 0;
    this.conflicting = 0;
    this.samples.length = 0;
    this.conflictSamples.length = 0;
    this.conflictQuota.clear();
    this.byQuery.clear();
  }
}

/** Process-wide ledger for env-driven differential runs. */
export const globalDivergenceLedger = new DivergenceLedger();

function describeNode(node: ts.Node): string {
  try {
    const text = node.getText();
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  } catch {
    return `<kind ${node.kind}>`;
  }
}

function describeFact(fact: TypeFact | undefined): string {
  return fact ? factKey(fact) : "undefined";
}

function describeSignature(sig: SignatureFact | undefined): string {
  if (!sig) return "undefined";
  return `(${sig.params.map(factKey).join(",")})->${factKey(sig.returns)}#${sig.declaredArity}`;
}

/**
 * Answers from `primary` (the checker) so behavior is unchanged; records where
 * `candidate` (in-house) disagrees. Wrapping is cheap — both backends memoize.
 */
export class DifferentialOracle implements TypeOracle {
  constructor(
    private readonly primary: TypeOracle,
    private readonly candidate: TypeOracle,
    private readonly ledger: DivergenceLedger = globalDivergenceLedger,
  ) {}

  private compare<T>(query: string, node: ts.Node, run: (oracle: TypeOracle) => T, describe: (value: T) => string): T {
    const primaryAnswer = run(this.primary);
    let candidateAnswer: T | undefined;
    try {
      candidateAnswer = run(this.candidate);
    } catch {
      this.ledger.record(query, describe(primaryAnswer), "<threw>", describeNode(node));
      return primaryAnswer;
    }
    this.ledger.record(query, describe(primaryAnswer), describe(candidateAnswer), describeNode(node));
    return primaryAnswer;
  }

  typeFactOf(node: ts.Node): TypeFact {
    return this.compare("typeFactOf", node, (o) => o.typeFactOf(node), describeFact);
  }

  staticJsTypeOf(expr: ts.Expression): JsTag | "mixed" {
    return this.compare("staticJsTypeOf", expr, (o) => o.staticJsTypeOf(expr), String);
  }

  isBooleanProducing(expr: ts.Expression): boolean {
    return this.compare("isBooleanProducing", expr, (o) => o.isBooleanProducing(expr), String);
  }

  nullabilityOf(node: ts.Node): { nullable: boolean; undefinable: boolean } {
    return this.compare(
      "nullabilityOf",
      node,
      (o) => o.nullabilityOf(node),
      (v) => `${v.nullable}/${v.undefinable}`,
    );
  }

  unionPartsOf(node: ts.Node): TypeFact[] | undefined {
    return this.compare(
      "unionPartsOf",
      node,
      (o) => o.unionPartsOf(node),
      (v) => (v ? v.map(factKey).join("|") : "undefined"),
    );
  }

  signatureOf(node: ts.Node): SignatureFact | undefined {
    return this.compare("signatureOf", node, (o) => o.signatureOf(node), describeSignature);
  }

  propertyFactOf(node: ts.Node, name: string): TypeFact {
    return this.compare(`propertyFactOf:${name}`, node, (o) => o.propertyFactOf(node, name), describeFact);
  }

  elementFactOf(node: ts.Node): TypeFact {
    return this.compare("elementFactOf", node, (o) => o.elementFactOf(node), describeFact);
  }

  contextualFactOf(expr: ts.Expression): TypeFact | undefined {
    return this.compare("contextualFactOf", expr, (o) => o.contextualFactOf(expr), describeFact);
  }

  builtinReceiverOf(node: ts.Node): string | undefined {
    return this.compare(
      "builtinReceiverOf",
      node,
      (o) => o.builtinReceiverOf(node),
      (v) => v ?? "undefined",
    );
  }

  wellKnownSymbolMemberOf(node: ts.Node, name: string): boolean | undefined {
    return this.compare(
      `wellKnownSymbolMemberOf:${name}`,
      node,
      (o) => o.wellKnownSymbolMemberOf(node, name),
      (v) => (v === undefined ? "undefined" : String(v)),
    );
  }

  typeKeyOf(node: ts.Node): OracleTypeKey {
    // Identity tokens are not comparable across backends by construction.
    return this.primary.typeKeyOf(node);
  }

  declaredNameOf(node: ts.Node): string | undefined {
    return this.compare(
      "declaredNameOf",
      node,
      (o) => o.declaredNameOf(node),
      (v) => v ?? "undefined",
    );
  }

  isUnresolvableIdentifier(id: ts.Identifier): boolean {
    return this.compare("isUnresolvableIdentifier", id, (o) => o.isUnresolvableIdentifier(id), String);
  }

  constInitializerOf(id: ts.Node): ts.Expression | undefined {
    return this.compare("constInitializerOf", id, (o) => o.constInitializerOf(id), describeOptionalNode);
  }

  variableInitializerOf(id: ts.Node): ts.Expression | undefined {
    return this.compare("variableInitializerOf", id, (o) => o.variableInitializerOf(id), describeOptionalNode);
  }

  valueDeclarationOf(id: ts.Node): ts.Declaration | undefined {
    return this.compare("valueDeclarationOf", id, (o) => o.valueDeclarationOf(id), describeOptionalNode);
  }

  declarationsOf(node: ts.Node): readonly ts.Declaration[] {
    return this.compare(
      "declarationsOf",
      node,
      (o) => o.declarationsOf(node),
      (v) => `[${v.map(describeOptionalNode).join(",")}]`,
    );
  }

  variableDeclarationOf(id: ts.Node): ts.VariableDeclaration | undefined {
    return this.compare("variableDeclarationOf", id, (o) => o.variableDeclarationOf(id), describeOptionalNode);
  }
}

function describeOptionalNode(node: ts.Node | undefined): string {
  if (!node) return "undefined";
  return `${node.kind}@${node.pos}`;
}
