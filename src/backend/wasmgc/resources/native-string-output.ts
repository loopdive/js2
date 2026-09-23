// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  GlobalReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import type { NativeStringOutputPhysicalPlan } from "../program/native-string-output.js";
import {
  assertNativeStringOutputRequirementsCurrent,
  type NativeStringOutputRequirements,
} from "../../../ir/program/native-string-output-requirements.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "../../../ir/program/data.js";
import type {
  NativeResourceRecipe,
  NativeDeclaredSignature,
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
  type NativeDeclaredReservation,
} from "./native-resource-declarations.js";
import {
  nativeStringTypeKeys,
  nativeStringLiteralReservationInventory,
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  requireNativeStringFlattenReservations,
  requireCompletedNativeStringFlatten,
  type NativeStringFlattenReservations,
} from "./native-string-flatten.js";
import {
  buildStringConcatDefinition,
  buildStringBatchedConcatDefinition,
} from "../../../runtime/wasmgc/values/string-concat-bodies.js";
import {
  buildStdoutAppendDefinition,
  buildStdoutPrepareDefinition,
  buildStdoutCharDefinition,
} from "../../../runtime/wasmgc/values/stdout-bodies.js";

function fail(detail: string): never {
  throw new Error("native string output: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

/** The one symbolic recipe, shared by planning and actual reservation. */
export function declareNativeStringOutputResources(
  key: string,
  stringKey: string,
  selection: { readonly binaryConcat: boolean; readonly batchArities: readonly number[]; readonly stdout: boolean },
): NativeResourceRecipe {
  const selected = freezePreparedIrValue(selection) as typeof selection;
  if (typeof key !== "string" || !key || typeof stringKey !== "string" || !stringKey) fail("invalid recipe keys");
  if (
    typeof selected.binaryConcat !== "boolean" ||
    typeof selected.stdout !== "boolean" ||
    !Array.isArray(selected.batchArities)
  )
    fail("invalid output selection");
  const arities = new Set<number>();
  for (const arity of selected.batchArities) {
    if (!Number.isSafeInteger(arity) || arity < 3 || arity > 8 || arities.has(arity))
      fail("invalid or duplicate batch arity");
    arities.add(arity);
  }
  if (!selected.binaryConcat && (selected.stdout || arities.size)) fail("output dependencies require binary concat");
  const keys = nativeStringTypeKeys(stringKey);
  const ref = { kind: "ref" as const, typeKey: keys.any };
  const declarations: NativeStringValueDeclaration[] = [];
  const reservationSteps: NativeStringValueReservationStep[] = [];
  const add = (row: NativeStringValueDeclaration, signatureName?: string) => {
    declarations.push(row);
    if (signatureName !== undefined && row.space === "function")
      reservationSteps.push({
        phase: "resources",
        kind: "intern-signature",
        signature: row.signature,
        name: signatureName,
      });
    reservationSteps.push({ phase: "resources", kind: "reserve", resourceKey: row.key });
  };
  const fn = (
    suffix: string,
    role: readonly string[],
    name: string,
    signature: NativeDeclaredSignature,
    signatureName?: string,
  ) => add({ key: `${key}:${suffix}`, role: ["output", ...role], space: "function", name, signature }, signatureName);
  if (selected.binaryConcat) fn("concat", ["concat"], "__str_concat", { params: [ref, ref], results: [ref] });
  for (const arity of selected.batchArities)
    fn(`batch:${arity}`, ["batch", String(arity)], `__str_concat_${arity}`, {
      params: Array.from({ length: arity }, () => ({ ...ref })),
      results: [ref],
    });
  if (selected.stdout) {
    add({
      key: `${key}:accumulator`,
      role: ["output", "stdout-accumulator"],
      space: "global",
      name: "__stdout_acc",
      valueType: { kind: "ref_null", typeKey: keys.any },
      mutable: true,
    });
    fn(
      "append",
      ["stdout-append"],
      "__stdout_append",
      { params: [{ kind: "ref_null", typeKey: keys.any }], results: [] },
      "$stdout_append_type",
    );
    add({
      key: `${key}:flat`,
      role: ["output", "stdout-flat"],
      space: "global",
      name: "__stdout_flat",
      valueType: { kind: "ref_null", typeKey: keys.flat },
      mutable: true,
    });
    fn(
      "prepare",
      ["stdout-prepare"],
      "__stdout_prepare",
      { params: [], results: [{ kind: "i32" }] },
      "$stdout_prepare_type",
    );
    fn(
      "char",
      ["stdout-char"],
      "__stdout_char",
      { params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
      "$stdout_char_type",
    );
  }
  const recipe = freezeNativeResourceRecipe({ declarations, reservationSteps });
  preflightNativeResourceRecipe(recipe, Object.values(keys));
  return recipe;
}

export interface NativeStringOutputDependencies {
  readonly strings: NativeStringLiteralReservations;
  readonly flatten: NativeStringFlattenReservations;
}
export interface NativeStringOutputReservations {
  readonly concat: FunctionReservation;
  readonly batches: readonly { readonly arity: number; readonly function: FunctionReservation }[];
  readonly stdout?: {
    readonly accumulator: GlobalReservation;
    readonly flat: GlobalReservation;
    readonly append: FunctionReservation;
    readonly prepare: FunctionReservation;
    readonly char: FunctionReservation;
  };
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeStringOutputRequirements;
  readonly plan: NativeStringOutputPhysicalPlan;
  readonly planSnapshot: unknown;
  readonly dependencies: NativeStringOutputDependencies;
  readonly rows: readonly NativeDeclaredReservation[];
  filled: boolean;
  published: boolean;
}
const owners = new WeakMap<NativeStringOutputReservations, Owner>();

function checkPlan(requirements: NativeStringOutputRequirements, plan: NativeStringOutputPhysicalPlan) {
  assertNativeStringOutputRequirementsCurrent(requirements);
  if (typeof plan.flattenKey !== "string" || !plan.flattenKey || typeof plan.options?.emptyIdentity !== "boolean")
    fail("invalid plan keys/options");
  const recipe = declareNativeStringOutputResources(plan.key, plan.stringKey, {
    binaryConcat: requirements.binaryConcat,
    batchArities: requirements.batchArities,
    stdout: requirements.stdout,
  });
  same(
    plan,
    {
      key: plan.key,
      stringKey: plan.stringKey,
      flattenKey: plan.flattenKey,
      options: requirements.options,
      binaryConcat: requirements.binaryConcat,
      batchArities: requirements.batchArities,
      stdout: requirements.stdout,
      ...recipe,
    },
    "requirements/plan mismatch",
  );
  return recipe;
}
function checkDependencies(
  tx: PhysicalModuleReservations,
  plan: NativeStringOutputPhysicalPlan,
  dependencies: NativeStringOutputDependencies,
) {
  const { strings, flatten } = dependencies;
  const inventory = nativeStringLiteralReservationInventory(tx, strings);
  requireNativeStringFlattenReservations(tx, flatten);
  if (
    flatten.stringPack !== strings ||
    inventory.typePack.key !== plan.stringKey ||
    strings.layout !== inventory.typePack.layout ||
    strings.types !== inventory.typePack.types
  )
    fail("substituted string dependency/configuration");
  if (
    flatten.flatten.key !== `${plan.flattenKey}:flatten` ||
    flatten.copyTree.key !== `${plan.flattenKey}:copy-tree` ||
    flatten.worklist.key !== `${plan.flattenKey}:worklist` ||
    (flatten.utf8Decoder !== null) !== inventory.typePack.utf8Storage ||
    (flatten.utf8Decoder && flatten.utf8Decoder.key !== `${plan.flattenKey}:utf8-decoder`)
  )
    fail("substituted flatten dependency/configuration");
  const empty = requireNativeStringLiteral(tx, strings, "", "wtf16");
  if (empty.kind !== "global" || empty.global !== flatten.emptyLiteral) fail("missing canonical UTF-16 empty literal");
  if (plan.batchArities.length) requireNativeStringLiteral(tx, strings, "undefined");
  return inventory;
}
function ownerFor(tx: PhysicalModuleReservations, pack: NativeStringOutputReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied output owner");
  same(owner.plan, owner.planSnapshot, "changed retained plan");
  checkPlan(owner.requirements, owner.plan);
  checkDependencies(tx, owner.plan, owner.dependencies);
  if (tx.state !== "reserving") for (const token of owner.rows) tx.physicalIndex(token);
  return owner;
}

export function reserveNativeStringOutputResources(
  tx: PhysicalModuleReservations,
  requirements: NativeStringOutputRequirements,
  plan: NativeStringOutputPhysicalPlan,
  dependencies: NativeStringOutputDependencies,
): NativeStringOutputReservations {
  if (tx.state !== "reserving") fail("reservation requires reserving phase");
  const recipe = checkPlan(requirements, plan);
  if (!plan.binaryConcat) fail("empty output selection has no resource owner");
  const inventory = checkDependencies(tx, plan, dependencies);
  const records = executeNativeResourceRecipe(
    tx,
    recipe,
    new Map(inventory.typePack.types.map((token) => [token.key, token])),
  );
  const fn = (role: string) => requireNativeDeclaredReservation(records, `${plan.key}:${role}`, "function");
  const global = (role: string) => requireNativeDeclaredReservation(records, `${plan.key}:${role}`, "global");
  const pack = Object.freeze({
    concat: fn("concat"),
    batches: Object.freeze(plan.batchArities.map((arity) => Object.freeze({ arity, function: fn(`batch:${arity}`) }))),
    ...(plan.stdout
      ? {
          stdout: Object.freeze({
            accumulator: global("accumulator"),
            flat: global("flat"),
            append: fn("append"),
            prepare: fn("prepare"),
            char: fn("char"),
          }),
        }
      : {}),
  });
  owners.set(pack, {
    tx,
    requirements,
    plan,
    planSnapshot: freezePreparedIrValue(plan),
    dependencies: Object.freeze({ strings: dependencies.strings, flatten: dependencies.flatten }),
    rows: Object.freeze(
      recipe.declarations.map((row) => records.get(row.key) ?? fail("missing declared output resource")),
    ),
    filled: false,
    published: false,
  });
  return pack;
}
export function requireNativeStringOutputReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringOutputReservations,
): NativeStringOutputReservations {
  ownerFor(tx, pack);
  return pack;
}
export function nativeStringOutputReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeStringOutputReservations,
  expectedPlan: NativeStringOutputPhysicalPlan,
): readonly NativeDeclaredReservation[] {
  const owner = ownerFor(tx, pack);
  if (owner.plan !== expectedPlan) fail("foreign expected plan");
  return owner.rows;
}

export function fillNativeStringOutputResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringOutputReservations,
): void {
  const owner = ownerFor(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("output requires one filling-phase fill");
  const { strings, flatten } = owner.dependencies;
  requireCompletedNativeStringLiterals(tx, strings);
  requireCompletedNativeStringFlatten(tx, flatten, strings);
  const l = strings.layout;
  const layout = {
    strTypeIdx: l.nativeStrTypeIdx,
    strDataTypeIdx: l.nativeStrDataTypeIdx,
    anyStrTypeIdx: l.anyStrTypeIdx,
    consStrTypeIdx: l.consStrTypeIdx,
  };
  const literal = (): Instr[] => {
    const binding = requireNativeStringLiteral(tx, strings, "undefined");
    return binding.kind === "global"
      ? [{ op: "global.get", index: tx.physicalIndex(binding.global) }]
      : [{ op: "call", funcIdx: binding.function.handle }];
  };
  if (pack.stdout) {
    tx.fillGlobal(pack.stdout.accumulator, [{ op: "ref.null", typeIdx: l.anyStrTypeIdx }]);
    tx.fillGlobal(pack.stdout.flat, [{ op: "ref.null", typeIdx: l.nativeStrTypeIdx }]);
  }
  tx.fillFunction(
    pack.concat,
    buildStringConcatDefinition(layout, {
      flattenIdx: flatten.flatten.handle,
      emptyIdentity: owner.plan.options.emptyIdentity,
    }),
  );
  for (const batch of pack.batches)
    tx.fillFunction(
      batch.function,
      buildStringBatchedConcatDefinition(layout, batch.arity, {
        flattenIdx: flatten.flatten.handle,
        concatIdx: pack.concat.handle,
        undefinedLiterals: Array.from({ length: batch.arity }, literal),
      }),
    );
  if (pack.stdout) {
    const accGlobalIdx = tx.physicalIndex(pack.stdout.accumulator),
      flatGlobalIdx = tx.physicalIndex(pack.stdout.flat);
    tx.fillFunction(pack.stdout.append, buildStdoutAppendDefinition({ accGlobalIdx, concatIdx: pack.concat.handle }));
    tx.fillFunction(
      pack.stdout.prepare,
      buildStdoutPrepareDefinition({
        accGlobalIdx,
        flatGlobalIdx,
        flatTypeIdx: l.nativeStrTypeIdx,
        flattenIdx: flatten.flatten.handle,
      }),
    );
    tx.fillFunction(
      pack.stdout.char,
      buildStdoutCharDefinition({
        flatGlobalIdx,
        flatTypeIdx: l.nativeStrTypeIdx,
        dataTypeIdx: l.nativeStrDataTypeIdx,
      }),
    );
  }
  for (const token of owner.rows)
    if (token.kind === "function" || token.kind === "global") tx.assertCompletedReservation(token);
  owner.filled = true;
}

/** Pre-publication completion also remains valid after the ledger seals. */
export function requireCompletedNativeStringOutput(
  tx: PhysicalModuleReservations,
  pack: NativeStringOutputReservations,
): NativeStringOutputReservations {
  const owner = ownerFor(tx, pack);
  if ((tx.state !== "filling" && tx.state !== "sealed") || !owner.filled) fail("incomplete output resources");
  const { strings, flatten } = owner.dependencies;
  requireCompletedNativeStringLiterals(tx, strings);
  requireCompletedNativeStringFlatten(tx, flatten, strings);
  for (const token of owner.rows) {
    tx.physicalIndex(token);
    if (token.kind === "function" || token.kind === "global") tx.assertCompletedReservation(token);
  }
  return pack;
}
export function publishNativeStringOutput(tx: PhysicalModuleReservations, pack: NativeStringOutputReservations): void {
  if (tx.state !== "filling") fail("publication requires filling phase");
  requireCompletedNativeStringOutput(tx, pack);
  if (!pack.stdout) return;
  const owner = owners.get(pack)!;
  if (owner.published) fail("duplicate stdout publication");
  tx.defineExport(`${owner.plan.key}:export:prepare`, "__stdout_prepare", pack.stdout.prepare);
  tx.defineExport(`${owner.plan.key}:export:char`, "__stdout_char", pack.stdout.char);
  owner.published = true;
}
