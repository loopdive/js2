// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4617 C1) Route-local declaration-fact capture/replay for the exact
 * standalone `bench_loop` Prepared function-value leaf.
 *
 * This module owns two things and nothing else:
 *
 *   1. the exact reduction-body declaration-query proof, expressed against a
 *      narrow declaration oracle rather than a live codegen context; and
 *   2. the bounded capture → finalize → no-delegate-replay lifecycle whose
 *      REPLAY result is the only authority a caller may act on.
 *
 * It deliberately does not import `multi-prepared-scalar-leaf.ts`, allocate
 * support, publish a claim, request a body skip, or lower Wasm. The live
 * capture callback may discover facts; it can never become returned authority.
 */
import {
  createDeclarationSnapshotRecorder,
  createDeclarationSnapshotReplayOracle,
  type DeclarationQueryOracle,
  type DeclarationRoleClassifier,
  type DeclarationSnapshotIdentity,
} from "../checker/oracle-declaration-snapshot.js";
import type { IrSourceId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { IrInvariantError } from "../ir/outcomes.js";
import {
  parseSemanticDeclarationSnapshot,
  SemanticDeclarationSnapshotError,
  serializeSemanticDeclarationSnapshot,
  type SemanticDeclarationRole,
  type SemanticDeclarationSnapshot,
} from "../ir/semantic-declaration-snapshot.js";
import { ts } from "../ts-api.js";
import {
  multiPreparedFunctionValueUseIsCurrent,
  type MultiPreparedFunctionValueUseReceipt,
} from "./multi-prepared-function-value-import-target.js";

const POISON_MESSAGE = "live declaration oracle poisoned after semantic-snapshot finalization";

function invariant(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", detail);
}

// ── the exact reduction-body declaration proof ─────────────────────────────

function numericLiteralIs(node: ts.Expression | undefined, text: string): node is ts.NumericLiteral {
  return node !== undefined && ts.isNumericLiteral(node) && node.text === text;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function resolvesExactly(oracle: DeclarationQueryOracle, identifier: ts.Identifier, declaration: ts.Declaration) {
  return oracle.valueDeclarationOf(identifier) === declaration;
}

/**
 * The exact source-identity-proven i32 reduction shape, minus the numeric
 * declaration-signature precheck its caller already applied. Every binding
 * identity is asked of the supplied narrow oracle, so the identical proof runs
 * against the live checker during capture and against the parsed snapshot
 * during replay.
 */
export function exactPreparedReductionDeclarationProof(
  oracle: DeclarationQueryOracle,
  declaration: ts.FunctionDeclaration,
): boolean {
  const body = declaration.body;
  if (!body) return false;
  const [seedStatement, loopStatement, returnStatement] = body.statements;
  if (
    body.statements.length !== 3 ||
    !seedStatement ||
    !ts.isVariableStatement(seedStatement) ||
    (seedStatement.declarationList.flags & ts.NodeFlags.Let) === 0 ||
    seedStatement.declarationList.declarations.length !== 1 ||
    !loopStatement ||
    !ts.isForStatement(loopStatement) ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement)
  ) {
    return false;
  }
  const seed = seedStatement.declarationList.declarations[0];
  if (!seed || !ts.isIdentifier(seed.name) || seed.type !== undefined || !numericLiteralIs(seed.initializer, "0")) {
    return false;
  }
  const initializer = loopStatement.initializer;
  if (
    !initializer ||
    !ts.isVariableDeclarationList(initializer) ||
    (initializer.flags & ts.NodeFlags.Let) === 0 ||
    initializer.declarations.length !== 1
  ) {
    return false;
  }
  const counter = initializer.declarations[0];
  if (
    !counter ||
    !ts.isIdentifier(counter.name) ||
    counter.type !== undefined ||
    !numericLiteralIs(counter.initializer, "0")
  ) {
    return false;
  }
  const condition = loopStatement.condition;
  const incrementor = loopStatement.incrementor;
  const loopBody = loopStatement.statement;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(condition.left) ||
    !resolvesExactly(oracle, condition.left, counter) ||
    !numericLiteralIs(condition.right, "1000000") ||
    !incrementor ||
    !ts.isPostfixUnaryExpression(incrementor) ||
    incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(incrementor.operand) ||
    !resolvesExactly(oracle, incrementor.operand, counter) ||
    !ts.isExpressionStatement(loopBody) ||
    !ts.isBinaryExpression(loopBody.expression) ||
    loopBody.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(loopBody.expression.left) ||
    !resolvesExactly(oracle, loopBody.expression.left, seed)
  ) {
    return false;
  }
  const wrapped = unwrapParentheses(loopBody.expression.right);
  if (
    !ts.isBinaryExpression(wrapped) ||
    wrapped.operatorToken.kind !== ts.SyntaxKind.BarToken ||
    !numericLiteralIs(wrapped.right, "0")
  ) {
    return false;
  }
  const sum = unwrapParentheses(wrapped.left);
  return (
    ts.isBinaryExpression(sum) &&
    sum.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ts.isIdentifier(sum.left) &&
    resolvesExactly(oracle, sum.left, seed) &&
    ts.isIdentifier(sum.right) &&
    resolvesExactly(oracle, sum.right, counter) &&
    returnStatement.expression !== undefined &&
    ts.isIdentifier(returnStatement.expression) &&
    resolvesExactly(oracle, returnStatement.expression, seed)
  );
}

// ── the closed v1 role vocabulary for this route ───────────────────────────

function isInside(node: ts.Node, container: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (current === container) return true;
  }
  return false;
}

/** Named import specifier, top-level function, or a local of the exact reduction body. */
export function multiPreparedDeclarationRoleClassifier(reductionBody: ts.Node): DeclarationRoleClassifier {
  return (node) => {
    if (ts.isImportSpecifier(node)) return "named-import-specifier";
    if (ts.isFunctionDeclaration(node) && node.parent !== undefined && ts.isSourceFile(node.parent)) {
      return "top-level-function";
    }
    if (ts.isVariableDeclaration(node) && isInside(node, reductionBody)) return "reduction-local-variable";
    return undefined;
  };
}

// ── test-only, parsed, exact fault injection ───────────────────────────────

interface RawRange {
  sourceId: string;
  start: number;
  end: number;
}
interface RawDeclaration extends RawRange {
  role: SemanticDeclarationRole;
}
interface RawQuery {
  site: RawRange;
  valueDeclaration: RawDeclaration | null;
  declarations: RawDeclaration[];
}
interface RawSnapshot {
  version: string;
  queries: RawQuery[];
  [extra: string]: unknown;
}

function armed(variable: string, legacyName: string): boolean {
  const raw = process.env[variable];
  if (raw === undefined || raw === "") return false;
  const names = raw.split(",").map((entry) => entry.trim());
  if (names.some((entry) => entry.length === 0)) invariant(`${variable} must be an exact comma-separated name list`);
  if (names.includes(legacyName)) return true;
  invariant(`${variable} is armed for ${raw} but the certified route is ${legacyName}`);
}

function pickQuery(raw: RawSnapshot, predicate: (query: RawQuery) => boolean, label: string): RawQuery {
  const matches = raw.queries.filter(predicate);
  if (matches.length !== 1) invariant(`snapshot mutation ${label} matched ${matches.length} queries, expected 1`);
  return matches[0]!;
}

function roleQuery(raw: RawSnapshot, role: SemanticDeclarationRole, label: string): RawQuery {
  return pickQuery(raw, (query) => query.valueDeclaration?.role === role, label);
}

function foreignTargetQuery(raw: RawSnapshot, label: string): RawQuery {
  const importSource = roleQuery(raw, "named-import-specifier", label).site.sourceId;
  return pickQuery(
    raw,
    (query) => query.valueDeclaration?.role === "top-level-function" && query.site.sourceId !== importSource,
    label,
  );
}

function localFunctionQuery(raw: RawSnapshot, label: string): RawQuery {
  const importSource = roleQuery(raw, "named-import-specifier", label).site.sourceId;
  return pickQuery(
    raw,
    (query) => query.valueDeclaration?.role === "top-level-function" && query.site.sourceId === importSource,
    label,
  );
}

function retarget(query: RawQuery, record: RawDeclaration): void {
  query.valueDeclaration = { ...record };
  query.declarations = [{ ...record }];
}

/**
 * One deliberate, named corruption applied to the finalized snapshot before
 * replay. `canonical: false` keeps the mutated population exactly as written so
 * an ordering/duplication defect is not normalized away.
 */
const SNAPSHOT_MUTATIONS: Readonly<Record<string, { readonly canonical: boolean; apply: (raw: RawSnapshot) => void }>> =
  {
    "wrong-version": { canonical: true, apply: (raw) => void (raw.version = "semantic-declaration-snapshot/0") },
    "extra-field": { canonical: true, apply: (raw) => void (raw.generatedBy = "test") },
    "drop-query": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "drop-query");
        raw.queries = raw.queries.filter((query) => query !== target);
      },
    },
    "answer-to-null": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "answer-to-null");
        target.valueDeclaration = null;
      },
    },
    "duplicate-query": {
      canonical: false,
      apply: (raw) => raw.queries.unshift(structuredClone(raw.queries[0]!)),
    },
    "unknown-query": {
      canonical: true,
      apply: (raw) => {
        const site = roleQuery(raw, "named-import-specifier", "unknown-query").site;
        raw.queries.push({
          site: { sourceId: site.sourceId, start: 0, end: 1 },
          valueDeclaration: null,
          declarations: [],
        });
      },
    },
    "wrong-source": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "wrong-source");
        const foreign = foreignTargetQuery(raw, "wrong-source").site.sourceId;
        retarget(target, { ...target.valueDeclaration!, sourceId: foreign });
      },
    },
    "wrong-range": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "wrong-range");
        retarget(target, { ...target.valueDeclaration!, end: target.valueDeclaration!.end + 1 });
      },
    },
    "wrong-role": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "wrong-role");
        retarget(target, { ...target.valueDeclaration!, role: "top-level-function" });
      },
    },
    "empty-population": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "empty-population");
        target.valueDeclaration = null;
        target.declarations = [];
      },
    },
    "duplicate-population": {
      canonical: false,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "duplicate-population");
        target.declarations = [...target.declarations, structuredClone(target.declarations[0]!)];
      },
    },
    "value-not-in-population": {
      canonical: true,
      apply: (raw) => {
        const target = roleQuery(raw, "named-import-specifier", "value-not-in-population");
        target.declarations = [structuredClone(foreignTargetQuery(raw, "value-not-in-population").valueDeclaration!)];
      },
    },
    "foreign-import": {
      canonical: true,
      apply: (raw) =>
        retarget(
          roleQuery(raw, "named-import-specifier", "foreign-import"),
          foreignTargetQuery(raw, "foreign-import").valueDeclaration!,
        ),
    },
    "foreign-target": {
      canonical: true,
      apply: (raw) =>
        retarget(
          foreignTargetQuery(raw, "foreign-target"),
          localFunctionQuery(raw, "foreign-target").valueDeclaration!,
        ),
    },
  };

const IDENTITY_MUTATIONS = new Set(["copied-source", "stale-inventory"]);

function mutatedSnapshot(snapshot: SemanticDeclarationSnapshot, mutation: string): SemanticDeclarationSnapshot {
  const entry = SNAPSHOT_MUTATIONS[mutation];
  if (!entry) invariant(`unknown declaration-snapshot mutation ${mutation}`);
  const raw = JSON.parse(serializeSemanticDeclarationSnapshot(snapshot)) as RawSnapshot;
  entry.apply(raw);
  if (entry.canonical) {
    raw.queries.sort(
      (left, right) =>
        (left.site.sourceId < right.site.sourceId ? -1 : left.site.sourceId > right.site.sourceId ? 1 : 0) ||
        left.site.start - right.site.start ||
        left.site.end - right.site.end,
    );
  }
  return parseSemanticDeclarationSnapshot(JSON.stringify(raw));
}

function mutatedIdentity(
  identity: DeclarationSnapshotIdentity,
  mutation: string,
  snapshot: SemanticDeclarationSnapshot,
): DeclarationSnapshotIdentity {
  // Mutate a source the snapshot actually joins, so an armed injection can
  // never silently pass by corrupting an unreferenced inventory entry.
  const sourceId = snapshot.queries[0]?.site.sourceId as IrSourceId | undefined;
  const sourceFile = sourceId === undefined ? undefined : identity.sourceFileBySourceId.get(sourceId);
  if (!sourceId || !sourceFile) invariant(`declaration-snapshot mutation ${mutation} found no joined source`);
  if (mutation === "stale-inventory") {
    const pruned = new Map(identity.sourceIdBySourceFile);
    pruned.delete(sourceFile);
    return { ...identity, sourceIdBySourceFile: pruned };
  }
  const copy = ts.createSourceFile(sourceFile.fileName, sourceFile.text, sourceFile.languageVersion, true);
  const replaced = new Map<IrSourceId, ts.SourceFile>(identity.sourceFileBySourceId);
  replaced.set(sourceId, copy);
  return { ...identity, sourceFileBySourceId: replaced };
}

// ── the bounded capture/finalize/no-delegate-replay lifecycle ──────────────

export interface MultiPreparedDeclarationReplayReceipt {
  /** The no-delegate replay authority retained for every later recheck. */
  readonly oracle: DeclarationQueryOracle;
  readonly snapshot: SemanticDeclarationSnapshot;
  /** Frozen canonical bytes of the certified snapshot. */
  readonly bytes: string;
  readonly identity: DeclarationSnapshotIdentity;
  readonly roleOf: DeclarationRoleClassifier;
}

export type MultiPreparedDeclarationReplayOutcome<Evidence> =
  | { readonly kind: "certified"; readonly evidence: Evidence; readonly receipt: MultiPreparedDeclarationReplayReceipt }
  | { readonly kind: "withdrawn"; readonly detail: string };

/**
 * Run `prove` twice: once through a recording oracle that only discovers and
 * captures facts, then once through the finalized, canonical-round-tripped,
 * no-delegate replayer. Only the second result is returned as evidence.
 */
export function certifyMultiPreparedDeclarationReplay<Evidence>(input: {
  readonly liveOracle: DeclarationQueryOracle;
  readonly identity: DeclarationSnapshotIdentity;
  readonly reductionBody: ts.Node;
  readonly legacyName: string;
  readonly prove: (oracle: DeclarationQueryOracle) => Evidence | undefined;
}): MultiPreparedDeclarationReplayOutcome<Evidence> {
  const roleOf = multiPreparedDeclarationRoleClassifier(input.reductionBody);
  const useLiveOracle = armed("JS2WASM_TEST_DECLARATION_REPLAY_LIVE_ORACLE", input.legacyName);
  const poisonLiveOracle = armed("JS2WASM_TEST_POISON_DECLARATION_ORACLE", input.legacyName);
  const mutation = process.env.JS2WASM_TEST_MUTATE_DECLARATION_SNAPSHOT;
  let poisoned = false;
  const facade: DeclarationQueryOracle = {
    valueDeclarationOf: (node) => {
      if (poisoned) invariant(POISON_MESSAGE);
      return input.liveOracle.valueDeclarationOf(node);
    },
    declarationsOf: (node) => {
      if (poisoned) invariant(POISON_MESSAGE);
      return input.liveOracle.declarationsOf(node);
    },
  };

  const recorder = createDeclarationSnapshotRecorder({ delegate: facade, identity: input.identity, roleOf });
  let certified: { snapshot: SemanticDeclarationSnapshot; bytes: string };
  try {
    input.prove(recorder.oracle);
    certified = recorder.finalize();
  } catch (error) {
    if (error instanceof SemanticDeclarationSnapshotError) return { kind: "withdrawn", detail: error.message };
    throw error;
  }

  poisoned = poisonLiveOracle;
  let identity = input.identity;
  let snapshot = certified.snapshot;
  let evidence: Evidence | undefined;
  let oracle: DeclarationQueryOracle;
  try {
    // Reading a corrupted snapshot is a consumer-side failure like any other:
    // it withdraws before support allocation rather than escaping as a crash.
    if (mutation !== undefined && mutation !== "") {
      if (IDENTITY_MUTATIONS.has(mutation)) identity = mutatedIdentity(identity, mutation, snapshot);
      else snapshot = mutatedSnapshot(snapshot, mutation);
    }
    oracle = useLiveOracle ? facade : createDeclarationSnapshotReplayOracle({ snapshot, identity, roleOf });
    evidence = input.prove(oracle);
  } catch (error) {
    if (error instanceof SemanticDeclarationSnapshotError) return { kind: "withdrawn", detail: error.message };
    throw error;
  }
  if (evidence === undefined) return { kind: "withdrawn", detail: "replayed declaration facts declined the candidate" };
  return {
    kind: "certified",
    evidence,
    receipt: { oracle, snapshot, bytes: certified.bytes, identity, roleOf },
  };
}

/**
 * Re-prove the frozen imported function-value edge from the RETAINED snapshot.
 * `ctx.oracle` is never accepted as a late authority for these facts; a drifted
 * or tampered receipt fails closed as an ordinary currentness rejection.
 */
export function multiPreparedDeclarationReplayIsCurrent(
  route: MultiPreparedFunctionValueUseReceipt & {
    readonly declarationReplay: MultiPreparedDeclarationReplayReceipt;
  },
  identityContext: IrPlanningIdentityContext | undefined,
): boolean {
  const { declarationReplay } = route;
  try {
    const oracle = armed("JS2WASM_TEST_TAMPER_DECLARATION_REPLAY", route.legacyName)
      ? createDeclarationSnapshotReplayOracle({
          snapshot: mutatedSnapshot(declarationReplay.snapshot, "drop-query"),
          identity: declarationReplay.identity,
          roleOf: declarationReplay.roleOf,
        })
      : declarationReplay.oracle;
    return multiPreparedFunctionValueUseIsCurrent(oracle, identityContext, route);
  } catch (error) {
    if (error instanceof SemanticDeclarationSnapshotError) return false;
    throw error;
  }
}
