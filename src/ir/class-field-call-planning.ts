// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { irUnitFuncRef } from "./callable-bindings.js";
import { isBoundedPreparedNestedFieldCallInitializer } from "./class-accessor-safety.js";
import {
  getIrNestedClassFieldCallInventoryCandidates,
  type IrNestedClassFieldCallFieldCandidate,
  type IrNestedClassFieldCallInventoryCandidate,
  type IrUnitId,
} from "./identity.js";
import type { IrIdentityImportedFunctionResolver, IrIdentityResolvedFunctionTarget } from "./imported-functions.js";
import {
  closureSignatureEquals,
  irTypeEquals,
  irVal,
  type IrClosureSignature,
  type IrFuncRef,
  type IrType,
} from "./nodes.js";
import { requireIrPlanningOwnerUnitId, type IrPlanningIdentityContext } from "./planning-identity.js";
import { irClosureSignatureFromFunctionDeclaration } from "./select.js";

export interface IrNestedClassFieldCallArgumentProjection {
  readonly index: number;
  readonly expression: ts.Expression;
  readonly kind: "number" | "string" | "boolean";
}

export interface IrNestedClassFieldCallArityProjection {
  readonly arity: number;
  readonly arguments: readonly IrNestedClassFieldCallArgumentProjection[];
}

/** Stable signature authority supplied by the pre-selection type-planning seam. */
export interface IrNestedClassFieldCallSignatureAuthority {
  resolveSignature(targetUnitId: IrUnitId, declaration: ts.FunctionDeclaration): IrClosureSignature | undefined;
}

/** Dormant source-qualified proof for one exact constructor-owned field call. */
export interface IrNestedClassFieldCallProof {
  readonly candidate: IrNestedClassFieldCallInventoryCandidate;
  readonly fieldCandidate: IrNestedClassFieldCallFieldCandidate;
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrNestedClassFieldCallInventoryCandidate["source"]["id"];
  readonly classDeclaration: IrNestedClassFieldCallInventoryCandidate["declaration"];
  readonly fieldDeclaration: ts.PropertyDeclaration;
  readonly constructorDeclaration: IrNestedClassFieldCallInventoryCandidate["constructorDeclaration"];
  readonly call: ts.CallExpression;
  readonly callee: ts.Identifier;
  readonly calleeDeclaration: ts.FunctionDeclaration;
  readonly classId: IrNestedClassFieldCallInventoryCandidate["classRecord"]["id"];
  readonly fieldSupportUnitId: IrUnitId;
  readonly constructorUnitId: IrUnitId;
  readonly containingTerminalUnitId: IrUnitId;
  readonly calleeUnitId: IrUnitId;
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
  readonly argumentProjection: IrNestedClassFieldCallArityProjection;
}

export interface PlanIrNestedClassFieldCallsInput {
  readonly identityContext: IrPlanningIdentityContext;
  readonly resolver: IrIdentityImportedFunctionResolver;
  /** Optional wider pre-selection authority; explicit primitive source ABI is the default. */
  readonly signatures?: IrNestedClassFieldCallSignatureAuthority;
  /** F3 A/B switch. Inventory candidates exist regardless of this value. */
  readonly enabled?: boolean;
}

const proofSidecarAuthority = Object.freeze({});
const authenticProofSidecars = new WeakSet<IrNestedClassFieldCallProofSidecar>();

/** Immutable optional sidecar. The private index is populated once. */
export class IrNestedClassFieldCallProofSidecar {
  readonly inventory: IrPlanningIdentityContext["inventory"];
  readonly entries: readonly IrNestedClassFieldCallProof[];
  readonly #byCall: ReadonlyMap<ts.CallExpression, IrNestedClassFieldCallProof>;

  /** @internal Construct through {@link planIrNestedClassFieldCalls}. */
  constructor(
    inventory: IrPlanningIdentityContext["inventory"],
    entries: readonly IrNestedClassFieldCallProof[],
    authority: typeof proofSidecarAuthority,
  ) {
    if (authority !== proofSidecarAuthority) {
      throw new TypeError("nested class field-call sidecars require planner authority");
    }
    const byCall = new Map<ts.CallExpression, IrNestedClassFieldCallProof>();
    for (const entry of entries) {
      if (byCall.has(entry.call)) {
        throw new Error("one nested class field call produced more than one dormant proof");
      }
      byCall.set(entry.call, entry);
    }
    this.inventory = inventory;
    this.entries = Object.freeze([...entries]);
    this.#byCall = byCall;
    authenticProofSidecars.add(this);
    Object.freeze(this);
  }

  get(call: ts.CallExpression): IrNestedClassFieldCallProof | undefined {
    return this.#byCall.get(call);
  }
}

/** Fail-closed authenticity check for selection/overlay retention. */
export function isIrNestedClassFieldCallProofSidecarForInventory(
  sidecar: IrNestedClassFieldCallProofSidecar,
  inventory: IrPlanningIdentityContext["inventory"],
): boolean {
  return authenticProofSidecars.has(sidecar) && sidecar.inventory === inventory;
}

function ownPrimitiveType(type: IrType): IrType | undefined {
  if (type.kind === "string") return Object.freeze({ kind: "string" });
  if (type.kind !== "val" || (type.val.kind !== "f64" && type.val.kind !== "i32")) return undefined;
  return Object.freeze({
    kind: "val",
    val: Object.freeze({ kind: type.val.kind }),
    ...(type.signed === undefined ? {} : { signed: type.signed }),
  });
}

function ownSignature(signature: IrClosureSignature): IrClosureSignature | undefined {
  if (signature.defaultParamStart !== undefined || signature.returnType === null) return undefined;
  const params = signature.params.map(ownPrimitiveType);
  const returnType = ownPrimitiveType(signature.returnType);
  if (!returnType || params.some((type) => type === undefined)) return undefined;
  return Object.freeze({
    params: Object.freeze(params as IrType[]),
    returnType,
  });
}

function boundedArgumentType(
  expression: ts.Expression,
): { readonly kind: IrNestedClassFieldCallArgumentProjection["kind"]; readonly type: IrType } | undefined {
  if (ts.isNumericLiteral(expression)) return { kind: "number", type: irVal({ kind: "f64" }) };
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { kind: "string", type: { kind: "string" } };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", type: irVal({ kind: "i32" }) };
  }
  return undefined;
}

function argumentProjection(
  call: ts.CallExpression,
  signature: IrClosureSignature,
): IrNestedClassFieldCallArityProjection | undefined {
  if (call.arguments.length !== signature.params.length) return undefined;
  const arguments_: IrNestedClassFieldCallArgumentProjection[] = [];
  for (let index = 0; index < call.arguments.length; index++) {
    const expression = call.arguments[index]!;
    const projected = boundedArgumentType(expression);
    if (!projected || !irTypeEquals(projected.type, signature.params[index]!)) return undefined;
    arguments_.push(Object.freeze({ index, expression, kind: projected.kind }));
  }
  return Object.freeze({
    arity: call.arguments.length,
    arguments: Object.freeze(arguments_),
  });
}

function candidateIsCurrent(
  candidate: IrNestedClassFieldCallInventoryCandidate,
  identityContext: IrPlanningIdentityContext,
): boolean {
  const { inventory } = identityContext;
  if (
    candidate.inventory !== inventory ||
    !getIrNestedClassFieldCallInventoryCandidates(inventory).includes(candidate) ||
    identityContext.sourceIdBySourceFile.get(candidate.sourceFile) !== candidate.source.id ||
    identityContext.sourceFileBySourceId.get(candidate.source.id) !== candidate.sourceFile ||
    !inventory.sources.includes(candidate.source) ||
    candidate.declaration.getSourceFile() !== candidate.sourceFile ||
    identityContext.classIdByDeclaration.get(candidate.declaration) !== candidate.classRecord.id ||
    identityContext.declarationByClassId.get(candidate.classRecord.id) !== candidate.declaration ||
    !inventory.classes.includes(candidate.classRecord) ||
    candidate.classRecord.sourceId !== candidate.source.id ||
    candidate.classRecord.lexicalOwnerId !== candidate.containingTerminalRecord.id ||
    identityContext.unitIdByDeclaration.get(candidate.constructorDeclaration) !== candidate.constructorRecord.id ||
    identityContext.declarationByUnitId.get(candidate.constructorRecord.id) !== candidate.constructorDeclaration ||
    identityContext.terminalByUnitId.get(candidate.constructorRecord.id) !== candidate.constructorRecord ||
    identityContext.unitByUnitId.get(candidate.constructorRecord.id) !== candidate.constructorRecord ||
    candidate.constructorRecord.sourceId !== candidate.source.id ||
    candidate.constructorRecord.lexicalOwnerId !== candidate.classRecord.id ||
    candidate.constructorRecord.observedKind !== "class-member" ||
    candidate.constructorRecord.terminalOwnerId !== candidate.constructorRecord.id ||
    candidate.constructorRecord.containingTerminalOwnerId !== candidate.containingTerminalRecord.id ||
    identityContext.terminalByUnitId.get(candidate.containingTerminalRecord.id) !==
      candidate.containingTerminalRecord ||
    identityContext.unitByUnitId.get(candidate.containingTerminalRecord.id) !== candidate.containingTerminalRecord ||
    candidate.containingTerminalRecord.sourceId !== candidate.source.id ||
    candidate.containingTerminalRecord.terminalOwnerId !== candidate.containingTerminalRecord.id
  ) {
    return false;
  }

  const expectedTerminals = inventory.terminalUnits.filter(
    (record) =>
      record.sourceId === candidate.source.id &&
      record.lexicalOwnerId === candidate.classRecord.id &&
      record.observedKind === "class-member" &&
      record.containingTerminalOwnerId === candidate.containingTerminalRecord.id,
  );
  if (
    expectedTerminals.length !== candidate.terminalMembers.length ||
    candidate.terminalMembers.some(
      ({ declaration, record }) =>
        !expectedTerminals.includes(record) ||
        identityContext.unitIdByDeclaration.get(declaration) !== record.id ||
        identityContext.declarationByUnitId.get(record.id) !== declaration ||
        identityContext.terminalByUnitId.get(record.id) !== record ||
        record.lexicalOwnerId !== candidate.classRecord.id ||
        record.containingTerminalOwnerId !== candidate.containingTerminalRecord.id,
    ) ||
    !candidate.terminalMembers.some(({ record }) => record === candidate.constructorRecord)
  ) {
    return false;
  }

  const expectedFields = candidate.declaration.members.filter(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      isBoundedPreparedNestedFieldCallInitializer(member.initializer),
  );
  if (expectedFields.length !== candidate.fields.length || expectedFields.length === 0) return false;
  return candidate.fields.every(({ declaration, record, call }, index) => {
    if (
      declaration !== expectedFields[index] ||
      call !== declaration.initializer ||
      call.getSourceFile() !== candidate.sourceFile ||
      identityContext.unitIdByDeclaration.get(declaration) !== record.id ||
      identityContext.declarationByUnitId.get(record.id) !== declaration ||
      identityContext.unitByUnitId.get(record.id) !== record ||
      !inventory.allUnits.includes(record) ||
      record.sourceId !== candidate.source.id ||
      record.lexicalOwnerId !== candidate.classRecord.id ||
      record.kind !== "class-instance-field-initializer" ||
      record.terminal ||
      record.terminalOwnerId !== candidate.constructorRecord.id
    ) {
      return false;
    }
    try {
      return requireIrPlanningOwnerUnitId(identityContext, call) === candidate.constructorRecord.id;
    } catch {
      return false;
    }
  });
}

function resolveProof(
  candidate: IrNestedClassFieldCallInventoryCandidate,
  fieldCandidate: IrNestedClassFieldCallFieldCandidate,
  input: PlanIrNestedClassFieldCallsInput,
): IrNestedClassFieldCallProof | undefined {
  if (!candidateIsCurrent(candidate, input.identityContext) || !candidate.fields.includes(fieldCandidate)) {
    return undefined;
  }
  const { call } = fieldCandidate;
  if (!ts.isIdentifier(call.expression)) return undefined;
  let resolved: IrIdentityResolvedFunctionTarget | undefined;
  try {
    resolved = input.resolver.resolveTopLevelFunctionValueTarget(call.expression);
  } catch {
    return undefined;
  }
  const targetRecord = resolved ? input.identityContext.terminalByUnitId.get(resolved.targetUnitId) : undefined;
  if (
    !resolved ||
    resolved.legacyProjection !== "unambiguous" ||
    resolved.targetName !== call.expression.text ||
    resolved.declaration.name?.text !== resolved.targetName ||
    resolved.declaration.getSourceFile() !== candidate.sourceFile ||
    resolved.declaration.parent !== candidate.sourceFile ||
    input.identityContext.sourceIdBySourceFile.get(resolved.declaration.getSourceFile()) !== candidate.source.id ||
    input.identityContext.unitIdByDeclaration.get(resolved.declaration) !== resolved.targetUnitId ||
    input.identityContext.declarationByUnitId.get(resolved.targetUnitId) !== resolved.declaration ||
    !targetRecord ||
    targetRecord.sourceId !== candidate.source.id ||
    targetRecord.kind !== "top-level-function" ||
    targetRecord.observedKind !== "function"
  ) {
    return undefined;
  }
  const currentSignature = input.signatures
    ? input.signatures.resolveSignature(resolved.targetUnitId, resolved.declaration)
    : irClosureSignatureFromFunctionDeclaration(resolved.declaration);
  if (!currentSignature) return undefined;
  const signature = ownSignature(currentSignature);
  if (!signature) return undefined;
  const projectedArguments = argumentProjection(call, signature);
  if (!projectedArguments) return undefined;
  return Object.freeze({
    candidate,
    fieldCandidate,
    sourceFile: candidate.sourceFile,
    sourceId: candidate.source.id,
    classDeclaration: candidate.declaration,
    fieldDeclaration: fieldCandidate.declaration,
    constructorDeclaration: candidate.constructorDeclaration,
    call,
    callee: call.expression,
    calleeDeclaration: resolved.declaration,
    classId: candidate.classRecord.id,
    fieldSupportUnitId: fieldCandidate.record.id,
    constructorUnitId: candidate.constructorRecord.id,
    containingTerminalUnitId: candidate.containingTerminalRecord.id,
    calleeUnitId: resolved.targetUnitId,
    target: irUnitFuncRef({ unitId: resolved.targetUnitId, name: resolved.targetName }),
    signature,
    argumentProjection: projectedArguments,
  });
}

/** Build dormant proofs only; this function never changes selection. */
export function planIrNestedClassFieldCalls(
  input: PlanIrNestedClassFieldCallsInput,
): IrNestedClassFieldCallProofSidecar {
  const candidates = getIrNestedClassFieldCallInventoryCandidates(input.identityContext.inventory);
  if (input.enabled === false) {
    return new IrNestedClassFieldCallProofSidecar(input.identityContext.inventory, [], proofSidecarAuthority);
  }
  const entries: IrNestedClassFieldCallProof[] = [];
  for (const candidate of candidates) {
    for (const field of candidate.fields) {
      const proof = resolveProof(candidate, field, input);
      if (proof) entries.push(proof);
    }
  }
  return new IrNestedClassFieldCallProofSidecar(input.identityContext.inventory, entries, proofSidecarAuthority);
}

/** Revalidate every AST, owner, target, argument, and signature join. */
export function isIrNestedClassFieldCallProofCurrent(
  proof: IrNestedClassFieldCallProof,
  input: PlanIrNestedClassFieldCallsInput,
): boolean {
  if (input.enabled === false || !candidateIsCurrent(proof.candidate, input.identityContext)) return false;
  const current = resolveProof(proof.candidate, proof.fieldCandidate, input);
  if (!current) return false;
  return (
    current.sourceFile === proof.sourceFile &&
    current.sourceId === proof.sourceId &&
    current.classDeclaration === proof.classDeclaration &&
    current.fieldDeclaration === proof.fieldDeclaration &&
    current.constructorDeclaration === proof.constructorDeclaration &&
    current.call === proof.call &&
    current.callee === proof.callee &&
    current.calleeDeclaration === proof.calleeDeclaration &&
    current.classId === proof.classId &&
    current.fieldSupportUnitId === proof.fieldSupportUnitId &&
    current.constructorUnitId === proof.constructorUnitId &&
    current.containingTerminalUnitId === proof.containingTerminalUnitId &&
    current.calleeUnitId === proof.calleeUnitId &&
    current.target.binding.kind === "unit" &&
    proof.target.binding.kind === "unit" &&
    current.target.binding.unitId === proof.target.binding.unitId &&
    current.target.name === proof.target.name &&
    closureSignatureEquals(current.signature, proof.signature) &&
    current.argumentProjection.arity === proof.argumentProjection.arity &&
    current.argumentProjection.arguments.length === proof.argumentProjection.arguments.length &&
    current.argumentProjection.arguments.every(
      (argument, index) =>
        argument.index === proof.argumentProjection.arguments[index]?.index &&
        argument.expression === proof.argumentProjection.arguments[index]?.expression &&
        argument.kind === proof.argumentProjection.arguments[index]?.kind,
    )
  );
}
