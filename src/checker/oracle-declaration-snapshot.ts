// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4617 C1) Temporary TypeScript adapter for the declaration-fact snapshot.
 *
 * The adapter translates exact compiler-owned nodes to and from the neutral
 * records in `src/ir/semantic-declaration-snapshot.ts` using one planning
 * identity context. It never places a `ts.Node`, `ts.Symbol`, `ts.Type`,
 * `ts.Signature`, `TypeChecker`, `WeakMap`, absolute filename, display name,
 * or syntax-kind number into a record: a reference is exactly its `IrSourceId`,
 * its source-relative half-open range, and its closed semantic role.
 *
 * Capture is not authority; replay is. The recorder delegates each first
 * request to the live TypeScript oracle and records the neutral answer. The
 * replayer has NO delegate: it joins each neutral reference back to exactly
 * one node in the current source inventory and raises the snapshot's typed
 * missing/invalid-fact error otherwise. It never asks a live oracle, searches
 * by spelling, or returns a guessed declaration.
 */
import type { IrSourceId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import {
  canonicalizeSemanticDeclarationSnapshot,
  parseSemanticDeclarationSnapshot,
  SemanticDeclarationSnapshotError,
  semanticDeclarationRecordKey,
  semanticSourceRangeKey,
  serializeSemanticDeclarationSnapshot,
  type SemanticDeclarationQueryRecord,
  type SemanticDeclarationRecord,
  type SemanticDeclarationRole,
  type SemanticDeclarationSnapshot,
  type SemanticSourceRangeRecord,
} from "../ir/semantic-declaration-snapshot.js";
import { ts } from "../ts-api.js";
import type { TypeOracle } from "./oracle.js";

/** The exact narrow oracle surface this checkpoint records and replays. */
export type DeclarationQueryOracle = Pick<TypeOracle, "valueDeclarationOf" | "declarationsOf">;

/**
 * The exact identity seam the adapter is allowed to consult. Source identity —
 * never a path or a spelling — is the join authority.
 */
export type DeclarationSnapshotIdentity = Pick<
  IrPlanningIdentityContext,
  "sourceIdBySourceFile" | "sourceFileBySourceId" | "unitIdByDeclaration"
>;

/** Closed syntax→role classifier supplied by the consuming route. */
export type DeclarationRoleClassifier = (node: ts.Node) => SemanticDeclarationRole | undefined;

export interface DeclarationSnapshotAdapterInput {
  readonly identity: DeclarationSnapshotIdentity;
  readonly roleOf: DeclarationRoleClassifier;
}

export interface DeclarationSnapshotRecorder {
  /** The recording narrow oracle. Its answers are discovery, never authority. */
  readonly oracle: DeclarationQueryOracle;
  /** Validate, canonicalize, serialize, parse, validate again, and freeze. */
  finalize(): { readonly snapshot: SemanticDeclarationSnapshot; readonly bytes: string };
}

const AMBIGUOUS = Symbol("ambiguous-declaration-join");

function fail(code: ConstructorParameters<typeof SemanticDeclarationSnapshotError>[0], message: string): never {
  throw new SemanticDeclarationSnapshotError(code, message);
}

function sourceRangeOf(node: ts.Node, identity: DeclarationSnapshotIdentity): SemanticSourceRangeRecord {
  const sourceFile = node.getSourceFile();
  const sourceId = sourceFile === undefined ? undefined : identity.sourceIdBySourceFile.get(sourceFile);
  if (sourceId === undefined || identity.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    fail("stale-source", "node does not belong to one bidirectionally registered inventory source");
  }
  return { sourceId, start: node.getStart(sourceFile), end: node.getEnd() };
}

/**
 * A `top-level-function` reference must also be inventoried. That is the check
 * a copied AST or a rebuilt/reordered inventory cannot satisfy, so it is where
 * a stale join fails closed rather than silently returning a look-alike node.
 */
function requireInventoried(node: ts.Node, role: SemanticDeclarationRole, identity: DeclarationSnapshotIdentity): void {
  if (role === "top-level-function" && !identity.unitIdByDeclaration.has(node)) {
    fail("stale-source", "top-level function declaration is not present in the current unit inventory");
  }
}

function declarationRecordOf(
  declaration: ts.Declaration,
  input: DeclarationSnapshotAdapterInput,
): SemanticDeclarationRecord {
  const role = input.roleOf(declaration);
  if (role === undefined) {
    fail("unsupported-declaration-role", "declaration is outside the closed v1 role vocabulary");
  }
  requireInventoried(declaration, role, input.identity);
  return { ...sourceRangeOf(declaration, input.identity), role };
}

function sameDeclarationPopulation(
  left: readonly SemanticDeclarationRecord[],
  right: readonly SemanticDeclarationRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((record, index) => semanticDeclarationRecordKey(record) === semanticDeclarationRecordKey(right[index]!))
  );
}

/**
 * Record the live answers for one query family. A first request through either
 * narrow method proactively captures both the `valueDeclarationOf` answer and
 * the complete `declarationsOf` population for that site. Repeated identical
 * requests must agree; a changed answer is an invariant, not last-write-wins.
 */
export function createDeclarationSnapshotRecorder(
  input: DeclarationSnapshotAdapterInput & { readonly delegate: DeclarationQueryOracle },
): DeclarationSnapshotRecorder {
  const records = new Map<string, SemanticDeclarationQueryRecord>();
  const capture = (node: ts.Node): { record: SemanticDeclarationQueryRecord; live: ts.Declaration | undefined } => {
    const site = sourceRangeOf(node, input.identity);
    const live = input.delegate.valueDeclarationOf(node);
    const valueDeclaration = live ? declarationRecordOf(live, input) : null;
    const declarations = input.delegate.declarationsOf(node).map((entry) => declarationRecordOf(entry, input));
    const key = semanticSourceRangeKey(site);
    const existing = records.get(key);
    if (existing) {
      const changed =
        (existing.valueDeclaration === null) !== (valueDeclaration === null) ||
        (existing.valueDeclaration !== null &&
          valueDeclaration !== null &&
          semanticDeclarationRecordKey(existing.valueDeclaration) !== semanticDeclarationRecordKey(valueDeclaration)) ||
        !sameDeclarationPopulation(existing.declarations, declarations);
      if (changed) fail("capture-answer-changed", `query ${key} produced a different answer during capture`);
      return { record: existing, live };
    }
    const record: SemanticDeclarationQueryRecord = { site, valueDeclaration, declarations };
    records.set(key, record);
    return { record, live };
  };
  return {
    oracle: {
      valueDeclarationOf: (node) => capture(node).live,
      declarationsOf: (node) => {
        capture(node);
        return input.delegate.declarationsOf(node);
      },
    },
    finalize: () => {
      const snapshot = canonicalizeSemanticDeclarationSnapshot([...records.values()]);
      const bytes = serializeSemanticDeclarationSnapshot(snapshot);
      const parsed = parseSemanticDeclarationSnapshot(bytes);
      if (serializeSemanticDeclarationSnapshot(parsed) !== bytes) {
        fail("malformed-record", "canonical snapshot bytes did not survive a parse/reserialize round trip");
      }
      return { snapshot: parsed, bytes };
    },
  };
}

class DeclarationSnapshotJoin {
  readonly #input: DeclarationSnapshotAdapterInput;
  readonly #declarations = new Map<string, ts.Node | typeof AMBIGUOUS>();
  readonly #identifiers = new Map<string, ts.Node | typeof AMBIGUOUS>();
  readonly #indexed = new Set<string>();

  constructor(input: DeclarationSnapshotAdapterInput) {
    this.#input = input;
  }

  #index(sourceId: string): void {
    if (this.#indexed.has(sourceId)) return;
    this.#indexed.add(sourceId);
    const sourceFile = this.#input.identity.sourceFileBySourceId.get(sourceId as IrSourceId);
    if (sourceFile === undefined || this.#input.identity.sourceIdBySourceFile.get(sourceFile) !== sourceId) {
      fail("stale-source", `source ${sourceId} is not bidirectionally registered in the current inventory`);
    }
    const add = (map: Map<string, ts.Node | typeof AMBIGUOUS>, key: string, node: ts.Node): void => {
      map.set(key, map.has(key) ? AMBIGUOUS : node);
    };
    const visit = (node: ts.Node): void => {
      // Both index keys are built by the neutral schema's own key functions, so
      // a joined node is keyed exactly the way its record is.
      const range = { sourceId, start: node.getStart(sourceFile), end: node.getEnd() };
      const role = this.#input.roleOf(node);
      if (role !== undefined) add(this.#declarations, semanticDeclarationRecordKey({ ...range, role }), node);
      if (ts.isIdentifier(node)) add(this.#identifiers, semanticSourceRangeKey(range), node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  #resolve(map: Map<string, ts.Node | typeof AMBIGUOUS>, sourceId: string, key: string, label: string): ts.Node {
    this.#index(sourceId);
    const found = map.get(key);
    if (found === undefined) fail("unresolved-declaration", `${label} ${key} resolves to no node in its source`);
    if (found === AMBIGUOUS) fail("ambiguous-declaration", `${label} ${key} resolves to more than one node`);
    return found;
  }

  declaration(record: SemanticDeclarationRecord): ts.Declaration {
    const node = this.#resolve(
      this.#declarations,
      record.sourceId,
      semanticDeclarationRecordKey(record),
      "declaration reference",
    );
    requireInventoried(node, record.role, this.#input.identity);
    return node as ts.Declaration;
  }

  site(range: SemanticSourceRangeRecord): ts.Node {
    return this.#resolve(this.#identifiers, range.sourceId, semanticSourceRangeKey(range), "query site");
  }
}

/**
 * A replaying implementation of the same narrow surface with no delegate. Every
 * recorded site and reference is joined eagerly at construction, so a missing
 * query, stale source, copied AST, rebuilt or reordered inventory, or a
 * range/role drift fails closed BEFORE the consumer can allocate support,
 * publish a claim, or request a body skip.
 */
export function createDeclarationSnapshotReplayOracle(
  input: DeclarationSnapshotAdapterInput & { readonly snapshot: SemanticDeclarationSnapshot },
): DeclarationQueryOracle {
  const join = new DeclarationSnapshotJoin(input);
  const answers = new Map<
    ts.Node,
    { readonly valueDeclaration: ts.Declaration | undefined; readonly declarations: readonly ts.Declaration[] }
  >();
  for (const query of input.snapshot.queries) {
    const node = join.site(query.site);
    if (answers.has(node)) fail("duplicate-query", `query site ${semanticSourceRangeKey(query.site)} joined twice`);
    answers.set(node, {
      valueDeclaration: query.valueDeclaration ? join.declaration(query.valueDeclaration) : undefined,
      declarations: Object.freeze(query.declarations.map((record) => join.declaration(record))),
    });
  }
  const answerFor = (node: ts.Node) => {
    const answer = answers.get(node);
    if (!answer) fail("missing-query", "the replayed snapshot carries no fact for this declaration query site");
    return answer;
  };
  return {
    valueDeclarationOf: (node) => answerFor(node).valueDeclaration,
    declarationsOf: (node) => answerFor(node).declarations,
  };
}
