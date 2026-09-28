// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  FunctionReservation,
  GlobalReservation,
  PhysicalModuleReservations,
  TagReservation,
  TagImportReservation,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeInvocationRequirements } from "../../../ir/program/native-invocation-requirements.js";
import { assertNativeInvocationRequirementsCurrent } from "../../../ir/program/native-invocation-requirements.js";
import type { NativeObjectAccessRequirements } from "../../../ir/program/native-object-access-requirements.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import type { NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { requireNativeSourceClosureTypes, type NativeSourceClosureTypes } from "./native-source-closures.js";
import {
  requireNativeSourceClosureCallables,
  type NativeSourceClosureCallables,
} from "./native-source-closure-callables.js";
import {
  requireNativeValueReservations,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import { requireNativeVectorTypeReservations, type NativeVectorTypeReservations } from "./native-vectors.js";
import {
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
  nativeArgumentVectorReservationInventory,
  fillNativeArgumentVectorResources,
  type NativeArgumentVectorReservations,
  type NativeArgumentVectorDeclarationPlan,
} from "./native-argument-vectors.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
  requireCompletedNativeErrors,
  requireNativeErrorReservations,
  type NativeErrorReservations,
  type NativeErrorDependencies,
  type NativeErrorRequirements,
} from "./native-errors.js";
import { createVectorBaseType } from "../../../runtime/wasmgc/values/vector-grow-store.js";
import { buildClosureUndefinedTest } from "../../../runtime/wasmgc/values/closure-receiver-bodies.js";
import {
  buildNativeClosureMethodDefinition,
  type ClosureInvocationState,
  type NativeClosureMethodEntry,
} from "../../../runtime/wasmgc/values/closure-method-body.js";
import { buildNativeClosureVectorApplyDefinition } from "../../../runtime/wasmgc/values/closure-vector-apply-body.js";
import type { ClosureInvocationLayout } from "../../../runtime/wasmgc/values/closure-invocation-types.js";
import {
  requireNativeBooleanBoxReservations,
  requireCompletedNativeBooleanBoxes,
  type NativeBooleanBoxReservations,
} from "./native-booleans.js";
import { objectResultIsBoolean } from "../../../ir/program/native-object-result-values.js";

export interface NativeInvocationDependencies {
  readonly source: NativeSourceClosureTypes;
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
  readonly strings: NativeStringLiteralReservations;
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly booleanBoxes?: NativeBooleanBoxReservations;
}
export interface NativeInvocationReservations {
  readonly requirements: NativeInvocationRequirements;
  readonly arguments: NativeArgumentVectorReservations;
  readonly errors: NativeErrorReservations;
  readonly globals: {
    readonly currentThis: GlobalReservation;
    readonly argc: GlobalReservation;
    readonly extras: GlobalReservation;
  };
  readonly undefinedValue: FunctionReservation;
  readonly isUndefined: FunctionReservation;
  readonly methods: readonly { readonly arity: number; readonly function: FunctionReservation }[];
  readonly applyVector?: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly dependencies: NativeInvocationDependencies;
  readonly dependenciesSnapshot: NativeInvocationDependencies;
  readonly layout: ClosureInvocationLayout;
  readonly argumentPlan: NativeArgumentVectorDeclarationPlan;
  readonly errorRequirements: NativeErrorRequirements;
  readonly errorDependencies: NativeErrorDependencies;
  readonly functions: readonly FunctionReservation[];
  readonly ownedBase?: TypeReservation;
  callables?: NativeSourceClosureCallables;
  filled: boolean;
}
const owners = new WeakMap<NativeInvocationReservations, Owner>();
function fail(detail: string): never {
  throw new Error(`native invocation resources: ${detail}`);
}
function authenticate(
  tx: PhysicalModuleReservations,
  requirements: NativeInvocationRequirements,
  dependencies: NativeInvocationDependencies,
): void {
  assertNativeInvocationRequirementsCurrent(requirements);
  if (requirements.gaps.length) fail(requirements.gaps.map((gap) => `${gap.unitId}: ${gap.detail}`).join("; "));
  requireNativeSourceClosureTypes(tx, dependencies.source, requirements.source);
  requireNativeValueReservations(tx, dependencies.values, dependencies.valuePlan, dependencies.valueDependencies);
  requireNativeVectorTypeReservations(tx, dependencies.vectors, dependencies.vectorPlan);
  const needsBooleanBox = requirements.getterUses.some((use) =>
    objectResultIsBoolean(
      requirements.source.demands.owners.find((row) => row.unitId === use.liftedUnitId)?.projectedFunction
        .closureSubtype?.signature.returnType,
    ),
  );
  if (needsBooleanBox && !dependencies.booleanBoxes)
    fail("selected Boolean getter needs its actual native Boolean BOX owner");
  if (dependencies.booleanBoxes)
    requireNativeBooleanBoxReservations(
      tx,
      dependencies.booleanBoxes,
      dependencies.values,
      dependencies.valuePlan,
      dependencies.valueDependencies,
    );
  requireNativeStringLiteral(tx, dependencies.strings, "TypeError");
  requireNativeStringLiteral(tx, dependencies.strings, "Value is not callable");
  if (
    dependencies.valueDependencies.strings.kind !== "native-string" ||
    dependencies.valueDependencies.strings.stringPack !== dependencies.strings
  )
    fail("value/string producer identities differ");
  if (requirements.applyVector && !dependencies.vectors.layouts.some((row) => row.element === "externref"))
    fail("selected apply vector has no issued external-element carrier");
}

/** Flattened coordinates come only from actual ledger tokens, never outer rec-group positions. */
function invocationLayout(source: NativeSourceClosureTypes): ClosureInvocationLayout {
  const tokens = [
    source.closures.root,
    ...source.closures.signatures.map((row) => row.binding.type),
    ...source.shapes.map((row) => row.type),
    ...source.closures.registrations.flatMap((row) => (row.kind === "type" || row.kind === "root" ? [row.type] : [])),
  ];
  const types: { kind: string; superTypeIdx?: number }[] = [];
  for (const token of tokens) {
    const shape = token.object;
    if (shape.kind !== "struct") continue;
    const row = { kind: shape.kind, ...(shape.superTypeIdx === undefined ? {} : { superTypeIdx: shape.superTypeIdx }) };
    if (types[token.typeIndex] && preparedIrDataMismatch(types[token.typeIndex], row))
      fail("competing flattened type owners");
    types[token.typeIndex] = row;
  }
  for (const token of tokens) {
    const seen = new Set<number>();
    let index: number | undefined = token.typeIndex;
    while (index !== undefined) {
      if (seen.has(index) || seen.size >= 63) fail("cyclic or overdepth closure ancestry");
      seen.add(index);
      const row: { kind: string; superTypeIdx?: number } | undefined = types[index];
      if (!row) fail("closure ancestry lacks an issued type owner");
      if (index === source.closures.root.typeIndex) break;
      index = row.superTypeIdx;
      if (index === undefined) fail("closure carrier is detached from its canonical root");
    }
  }
  return Object.freeze({ rootTypeIdx: source.closures.root.typeIndex, types: Object.freeze(types) });
}

export function reserveNativeInvocationResources(
  tx: PhysicalModuleReservations,
  requirements: NativeInvocationRequirements,
  dependencies: NativeInvocationDependencies,
): NativeInvocationReservations {
  if (tx.state !== "reserving") fail("reservation requires the owning ledger's reserving phase");
  authenticate(tx, requirements, dependencies);
  const layout = invocationLayout(dependencies.source);
  const key = (role: string) => `${requirements.key}:${role}`;
  const argumentPlan = declareNativeArgumentVectorResources(
    { key: key("arguments") },
    {
      vectorBaseKey: dependencies.vectors.base?.key ?? key("vector-base"),
    },
  );
  const errorRequirements = Object.freeze({ key: key("errors") });
  const errorDependencies = Object.freeze({ strings: dependencies.strings, typeErrorTag: -11 });
  // The complete connected owner is preflighted before even its first base type.
  tx.assertReservationKeysAvailable([
    ...(dependencies.vectors.base ? [] : [key("vector-base")]),
    ...argumentPlan.declarations.map((row) => row.key),
    `${errorRequirements.key}:type`,
    `${errorRequirements.key}:new-TypeError`,
    ...["this", "argc", "extras", "undefined", "is-undefined"].map(key),
    ...requirements.methodArities.map((arity) => key(`method:${arity}`)),
    ...(requirements.applyVector ? [key("apply-vector")] : []),
  ]);
  const ownedBase = dependencies.vectors.base ? undefined : tx.reserveType(key("vector-base"), createVectorBaseType());
  const args = reserveNativeArgumentVectorResources(
    tx,
    { key: key("arguments") },
    {
      vectorBase: dependencies.vectors.base ?? ownedBase!,
    },
    argumentPlan,
  );
  const errors = reserveNativeErrorResources(tx, errorRequirements, errorDependencies);
  const globals = Object.freeze({
    currentThis: tx.reserveGlobal(key("this"), "__current_this", { kind: "externref" }, true),
    argc: tx.reserveGlobal(key("argc"), "__argc", { kind: "i32" }, true),
    extras: tx.reserveGlobal(
      key("extras"),
      "__extra_args",
      { kind: "ref_null", typeIdx: args.carrier.typeIndex },
      true,
    ),
  });
  const undefinedValue = tx.reserveFunction(key("undefined"), "__closure_undefined", {
    params: [],
    results: [{ kind: "externref" }],
  });
  const isUndefined = tx.reserveFunction(key("is-undefined"), "__closure_is_undefined", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const methods = Object.freeze(
    requirements.methodArities.map((arity) =>
      Object.freeze({
        arity,
        function: tx.reserveFunction(key(`method:${arity}`), `__call_fn_method_${arity}`, {
          params: Array.from({ length: arity + 2 }, () => ({ kind: "externref" as const })),
          results: [{ kind: "externref" }],
        }),
      }),
    ),
  );
  const input = dependencies.vectors.layouts.find((row) => row.element === "externref");
  const applyVector = requirements.applyVector
    ? tx.reserveFunction(key("apply-vector"), "__apply_closure_vector", {
        params: [{ kind: "externref" }, { kind: "externref" }, { kind: "ref", typeIdx: input!.carrier.typeIndex }],
        results: [{ kind: "externref" }],
      })
    : undefined;
  const pack = Object.freeze({
    requirements,
    arguments: args,
    errors,
    globals,
    undefinedValue,
    isUndefined,
    methods,
    ...(applyVector ? { applyVector } : {}),
  });
  owners.set(pack, {
    tx,
    dependencies,
    dependenciesSnapshot: Object.freeze({ ...dependencies }),
    layout,
    argumentPlan,
    errorRequirements,
    errorDependencies,
    ...(ownedBase ? { ownedBase } : {}),
    filled: false,
    functions: Object.freeze([
      args.newVector,
      args.push,
      errors.newTypeError,
      undefinedValue,
      isUndefined,
      ...methods.map((row) => row.function),
      ...(applyVector ? [applyVector] : []),
    ]),
  });
  return pack;
}

function requireOwner(tx: PhysicalModuleReservations, pack: NativeInvocationReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied invocation owner");
  for (const key of Object.keys(owner.dependenciesSnapshot) as (keyof NativeInvocationDependencies)[])
    if (owner.dependencies[key] !== owner.dependenciesSnapshot[key]) fail("substituted dependency identity");
  authenticate(tx, pack.requirements, owner.dependencies);
  if (preparedIrDataMismatch(invocationLayout(owner.dependencies.source), owner.layout))
    fail("changed closure ancestry");
  nativeArgumentVectorReservationInventory(tx, pack.arguments, owner.argumentPlan);
  requireNativeErrorReservations(tx, pack.errors, owner.errorRequirements, owner.errorDependencies);
  return owner;
}

/** Read-only cycle join. Reservation authentication never certifies callable body completion. */
export function requireNativeInvocationReservations(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationReservations,
  expectedRequirements: NativeInvocationRequirements = pack.requirements,
  expectedDependencies?: NativeInvocationDependencies,
): NativeInvocationReservations {
  if (pack.requirements !== expectedRequirements) fail("substituted expected invocation requirements");
  const owner = requireOwner(tx, pack);
  if (expectedDependencies !== undefined && owner.dependencies !== expectedDependencies)
    fail("substituted expected invocation dependencies");
  return pack;
}

/** The actual method-zero slot selected by this exact C1 getter demand owner. */
export function nativeInvocationGetterDispatch(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationReservations,
  expectedAccess: NativeObjectAccessRequirements,
): FunctionReservation {
  requireNativeInvocationReservations(tx, pack);
  if (pack.requirements.objectAccess !== expectedAccess) fail("foreign expected object-access requirements");
  if (!pack.requirements.getterUses.length) fail("no issued semantic getter demand");
  const selected = pack.methods.filter((row) => row.arity === 0);
  if (selected.length !== 1) fail("semantic getter demand lacks its sole method-zero reservation");
  return selected[0]!.function;
}

export function nativeInvocationFunctions(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationReservations,
): readonly FunctionReservation[] {
  return requireOwner(tx, pack).functions;
}

function entries(
  owner: Owner,
  callables: NativeSourceClosureCallables,
  pack: NativeInvocationReservations,
): NativeClosureMethodEntry[] {
  const { values } = owner.dependencies;
  return callables.entries.map((row) => {
    const info = row.signature.info;
    const booleanResult =
      objectResultIsBoolean(row.source.closureSubtype?.signature.returnType) &&
      info.returnType?.kind === "i32" &&
      info.returnType.boolean === true &&
      owner.dependencies.booleanBoxes !== undefined;
    if (
      info.paramTypes.some((type) => type.kind !== "externref" && type.kind !== "f64") ||
      (info.returnType && info.returnType.kind !== "externref" && info.returnType.kind !== "f64" && !booleanResult)
    )
      fail("selected callable lacks its actual native argument/result conversion");
    return {
      allocationTypeIdx: row.shape.type.typeIndex,
      selfTypeIdx: row.signature.liftedSelfTypeIndex,
      funcTypeIdx: row.slot.object.typeIdx,
      closureArity: info.paramTypes.length,
      params: info.paramTypes,
      arguments: { unboxNumber: values.functions.unboxNumber.handle, isUndefined: pack.isUndefined.handle },
      result: info.returnType
        ? {
            kind: "value",
            returnType: info.returnType,
            boxNumber: values.functions.boxNumber.handle,
            ...(booleanResult ? { boxBoolean: owner.dependencies.booleanBoxes!.boxBoolean.handle } : {}),
          }
        : {
            kind: "void",
            undefinedValue: [
              { op: "global.get", index: owner.tx.physicalIndex(values.globals.undefined) },
              { op: "extern.convert_any" },
            ],
          },
    };
  });
}

/** Bodies are shared canonical recipes; only the existing unit owner supplies lifted slots. */
export function fillNativeInvocationResources(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationReservations,
  callables: NativeSourceClosureCallables,
  exception: TagReservation | TagImportReservation,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate fill");
  requireNativeSourceClosureCallables(tx, callables, owner.dependencies.source);
  if (callables.requirements !== pack.requirements) fail("selected callable requirements differ");
  const exceptionTag = tx.physicalIndex(exception);
  const rows = entries(owner, callables, pack);
  const { values, strings } = owner.dependencies;
  requireCompletedNativeValues(tx, values, owner.dependencies.valuePlan, owner.dependencies.valueDependencies);
  if (owner.dependencies.booleanBoxes)
    requireCompletedNativeBooleanBoxes(
      tx,
      owner.dependencies.booleanBoxes,
      values,
      owner.dependencies.valuePlan,
      owner.dependencies.valueDependencies,
    );
  requireCompletedNativeStringLiterals(tx, strings);
  const state: ClosureInvocationState = {
    currentThis: tx.physicalIndex(pack.globals.currentThis),
    argc: tx.physicalIndex(pack.globals.argc),
    extrasArgv: tx.physicalIndex(pack.globals.extras),
    extrasVecTypeIdx: pack.arguments.carrier.typeIndex,
    extrasArrTypeIdx: pack.arguments.array.typeIndex,
    undefinedGlobal: tx.physicalIndex(values.globals.undefined),
    anyValueTypeIdx: values.types.anyValue.typeIndex,
    receiverPolicy: "exact",
  };
  const literal = requireNativeStringLiteral(tx, strings, "Value is not callable");
  const failure = {
    newTypeError: pack.errors.newTypeError.handle,
    exceptionTag,
    message:
      literal.kind === "global"
        ? { kind: "global" as const, index: tx.physicalIndex(literal.global) }
        : { kind: "callable" as const, handle: literal.function.handle },
  };
  fillNativeArgumentVectorResources(tx, pack.arguments);
  fillNativeErrorResources(tx, pack.errors);
  tx.fillGlobal(pack.globals.currentThis, [{ op: "ref.null.extern" }]);
  tx.fillGlobal(pack.globals.argc, [{ op: "i32.const", value: -1 }]);
  tx.fillGlobal(pack.globals.extras, [{ op: "ref.null", typeIdx: pack.arguments.carrier.typeIndex }]);
  tx.fillFunction(pack.undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: state.undefinedGlobal }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(pack.isUndefined, {
    locals: [],
    body: buildClosureUndefinedTest(0, values.types.anyValue.typeIndex),
  });
  for (const row of pack.methods)
    tx.fillFunction(row.function, buildNativeClosureMethodDefinition(row.arity, owner.layout, rows, state, failure));
  if (pack.applyVector) {
    const input = owner.dependencies.vectors.layouts.find((row) => row.element === "externref")!;
    tx.fillFunction(
      pack.applyVector,
      buildNativeClosureVectorApplyDefinition(owner.layout, rows, state, failure, {
        vectorTypeIdx: input.carrier.typeIndex,
        arrayTypeIdx: input.array.typeIndex,
      }),
    );
  }
  owner.callables = callables;
  owner.filled = true;
}

export function requireCompletedNativeInvocation(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (!owner.filled || !owner.callables) fail("incomplete selected source-invocation population");
  requireNativeSourceClosureCallables(tx, owner.callables, owner.dependencies.source, true);
  requireCompletedNativeValues(
    tx,
    owner.dependencies.values,
    owner.dependencies.valuePlan,
    owner.dependencies.valueDependencies,
  );
  requireCompletedNativeErrors(tx, pack.errors, owner.errorRequirements, owner.errorDependencies);
  for (const token of owner.functions) tx.assertCompletedReservation(token);
  for (const token of Object.values(pack.globals)) tx.assertCompletedReservation(token);
}
