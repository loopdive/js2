// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrObjectShape } from "../core/nodes.js";
import { irCallableBindingKey, irSupportFuncRef } from "../core/callable-bindings.js";
import { preparedIrTypeKey } from "./abi-signatures.js";
import { preparedIrRuntimeAbiAnchor } from "./runtime-abi-identity.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { IrObjectReferencePlan, IrObjectReferenceCallable } from "./object-reference-contracts.js";
import type { TypedIrProgramInput } from "./input-contracts.js";
import type { PreparedIrProgram, PreparedIrAbiEntry } from "./prepared-contracts.js";
import { projectObjectPropertyCalls, type IrObjectPropertyResolver } from "./object-property-projection.js";
import { forEachInstrDeep } from "../core/nodes.js";
import { assertObjectReferenceCallClosure } from "./object-reference-closure.js";

type PlanInput = Pick<TypedIrProgramInput, "inventory" | "ir" | "allocations"> & {
  readonly globals?: TypedIrProgramInput["globals"];
  readonly abi?: PreparedIrProgram["abi"];
};

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `reference object program: ${detail}`);
}

const shapeKey = (shape: IrObjectShape): string => preparedIrTypeKey({ kind: "object", shape });

/**
 * Walk compiler-owned data, not source names or a hand-picked function list.
 * Includes slots, captures, async states, declarations and allocation metadata.
 * Class-shape back edges and shared types are visited once, not recursively copied.
 */
export function deriveObjectReferencePlan(input: PlanInput): IrObjectReferencePlan {
  const shapes = new Map<string, IrObjectShape>(),
    seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as { kind?: string; shape?: IrObjectShape };
    if (record.kind === "object" && record.shape) shapes.set(shapeKey(record.shape), record.shape);
    if (value instanceof Map || Object.prototype.toString.call(value) === "[object FrozenMap]") {
      for (const [key, item] of value as ReadonlyMap<unknown, unknown>) {
        visit(key);
        visit(item);
      }
    } else if (value instanceof Set || Object.prototype.toString.call(value) === "[object FrozenSet]") {
      for (const item of value as ReadonlySet<unknown>) visit(item);
    } else for (const item of Object.values(value)) visit(item);
  };
  visit(input.ir);
  visit(input.allocations);
  visit(input.globals);
  // Prepared programs retain source globals in the one ABI, not another table.
  for (const entry of input.abi?.entries ?? [])
    if (
      entry.contract.kind === "global" &&
      entry.plan.intent.kind === "global" &&
      entry.plan.intent.origin === "source"
    )
      visit(entry.contract.type);
  return {
    schema: "ir-object-reference-plan-v1",
    sourceId: preparedIrRuntimeAbiAnchor(input.inventory).id,
    shapes: [...shapes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, shape]) => shape),
  };
}

/** Exact logical declarations; native resource allocation is a separate obligation. */
export function objectReferenceCallables(plan: IrObjectReferencePlan): readonly IrObjectReferenceCallable[] {
  return plan.shapes.flatMap((shape) =>
    shape.fields.flatMap((field) => {
      const receiver = { kind: "object" as const, shape };
      return (["get", "set", "setSloppy"] as const).map((operation) => ({
        ref: irSupportFuncRef(
          plan.sourceId,
          JSON.stringify(["reference-object-v1", shapeKey(shape), field.name, operation]),
          `__reference_${operation}`,
        ),
        params: operation === "get" ? [receiver] : [receiver, field.type],
        results: operation === "get" ? [field.type] : [],
        receiver,
        field: field.name,
        operation,
      }));
    }),
  );
}

export function assertObjectReferencePlan(
  input: PlanInput & { readonly objectReferences?: IrObjectReferencePlan },
): void {
  if (!Object.hasOwn(input, "objectReferences")) return;
  if (
    input.objectReferences === undefined ||
    preparedIrDataMismatch(input.objectReferences, deriveObjectReferencePlan(input)) !== undefined
  )
    invalid("plan differs from the complete current logical type population");
}

/** Run on owned raw input, before hygiene, inlining or other effect-sensitive passes. */
export function projectObjectReferenceProgram(input: TypedIrProgramInput): TypedIrProgramInput {
  assertObjectReferencePlan(input);
  if (!input.objectReferences) return input;
  const byShape = new Map<
    string,
    Map<
      string,
      {
        get?: IrObjectReferenceCallable["ref"];
        set?: IrObjectReferenceCallable["ref"];
        setSloppy?: IrObjectReferenceCallable["ref"];
      }
    >
  >();
  for (const callable of objectReferenceCallables(input.objectReferences)) {
    const key = shapeKey(callable.receiver.shape);
    let fields = byShape.get(key);
    if (!fields) byShape.set(key, (fields = new Map()));
    const field = fields.get(callable.field) ?? {};
    fields.set(callable.field, { ...field, [callable.operation]: callable.ref });
  }
  const resolve: IrObjectPropertyResolver = (shape, name, _fieldType, operation, failureMode) => {
    const fields = byShape.get(shapeKey(shape));
    if (!fields) return invalid("field operation has no complete logical shape declaration");
    if (operation === "set" && failureMode !== "throw" && failureMode !== "ignore")
      return invalid("Set requires its source write mode");
    const role = operation === "set" && failureMode === "ignore" ? "setSloppy" : operation;
    const provider = fields.get(name)?.[role];
    if (!provider) return invalid("field operation has no exact declared provider");
    return provider;
  };
  return {
    ...input,
    ir: { ...input.ir, functions: input.ir.functions.map((fn) => projectObjectPropertyCalls(fn, resolve)) },
  };
}

/** Reconcile the exact declarations in the existing ABI; no second binding authority. */
export function assertObjectReferenceAbi(program: PreparedIrProgram): void {
  if (
    !program.objectReferences &&
    !program.abi.entries.some(
      (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "support",
    )
  )
    return;
  const plan = program.objectReferences ?? deriveObjectReferencePlan(program);
  const declarations = objectReferenceCallables(plan);
  for (const callable of declarations) {
    const matches = program.abi.entries.filter(
      (entry) => entry.plan.structuralReferenceKey === irCallableBindingKey(callable.ref.binding),
    );
    if (!program.objectReferences) {
      if (matches.length) invalid("reference provider ABI cannot outlive its plan");
      continue;
    }
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      !entry ||
      callable.ref.binding.kind !== "support" ||
      entry.plan.id !== callable.ref.binding.bindingId ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "function" ||
      entry.plan.intent.kind !== "callable" ||
      entry.plan.intent.origin !== "support" ||
      entry.plan.intent.sourceId !== plan.sourceId ||
      preparedIrDataMismatch(entry.contract, {
        kind: "callable",
        ref: callable.ref,
        params: callable.params,
        results: callable.results,
      }) !== undefined
    )
      invalid("provider lacks its exact required source-owned callable contract");
  }
  if (!program.objectReferences) return;
  assertObjectReferenceCallClosure(program, program.abi.entries);
  for (const fn of program.ir.functions) {
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers)
      for (const instruction of buffer)
        forEachInstrDeep(instruction, (row) => {
          if (row.kind === "object.get" || row.kind === "object.set")
            invalid("raw property operation survived reference projection");
        });
  }
}

export function objectReferenceAbiEntries(
  input: { readonly objectReferences?: IrObjectReferencePlan },
  order: (sourceId: IrObjectReferencePlan["sourceId"]) => PreparedIrAbiEntry["plan"]["order"],
): readonly PreparedIrAbiEntry[] {
  const plan = input.objectReferences;
  if (!plan) return [];
  return objectReferenceCallables(plan).map((callable): PreparedIrAbiEntry => {
    if (callable.ref.binding.kind !== "support") return invalid("provider lacks support identity");
    return {
      plan: {
        id: callable.ref.binding.bindingId,
        order: order(plan.sourceId),
        displayName: callable.ref.name,
        structuralReferenceKey: irCallableBindingKey(callable.ref.binding),
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "support",
          sourceId: plan.sourceId,
          signature: {
            params: callable.params.map(preparedIrTypeKey),
            results: callable.results.map(preparedIrTypeKey),
          },
        },
      },
      contract: { kind: "callable", ref: callable.ref, params: callable.params, results: callable.results },
    };
  });
}
