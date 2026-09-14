// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  createStringDataType,
  createAnyStringShape,
  createNativeStringShape,
  createConsStringShape,
  createHashedStringShape,
  createUtf8StringDataType,
  createUtf8StringShape,
  type NativeStringLayout,
} from "../../../runtime/wasmgc/values/string-layouts.js";
import {
  planNativeStringLiteral,
  selectNativeStringLiteral,
  buildOversizedNativeStringLiteral,
  type StringEncoding,
} from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
  NativeDeclaredType,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  executeNativeResourceRecipe,
  requireNativeDeclaredReservation,
  freezeNativeResourceRecipe,
  nativeScalarTypeDeclaration,
} from "./native-resource-declarations.js";

export function nativeStringTypeKeys(key: string) {
  return {
    data: `${key}:data`,
    any: `${key}:any`,
    flat: `${key}:flat`,
    cons: `${key}:cons`,
    hashed: `${key}:hashed`,
    utf8Data: `${key}:utf8-data`,
    utf8: `${key}:utf8`,
  } as const;
}
export function declareNativeStringLiteralTypes(key: string, utf8Storage: boolean): NativeResourceRecipe {
  if (typeof key !== "string" || !key || typeof utf8Storage !== "boolean")
    throw new Error("native strings: invalid type recipe key/config");
  const keys = nativeStringTypeKeys(key);
  const ref = (typeKey: string) => ({ kind: "ref" as const, typeKey });
  const parent = (typeKey: string) => ({ kind: "resource" as const, typeKey });
  const declarations: NativeStringValueDeclaration[] = [];
  const add = (role: string, resourceKey: string, shape: NativeDeclaredType) =>
    declarations.push({ key: resourceKey, role: ["string-type", role], space: "type", shape });
  add("data", keys.data, nativeScalarTypeDeclaration(createStringDataType()));
  add("any", keys.any, createAnyStringShape({ kind: "root" } as const));
  add("flat", keys.flat, createNativeStringShape(ref(keys.data), parent(keys.any)));
  add("cons", keys.cons, createConsStringShape(ref(keys.any), parent(keys.any)));
  add("hashed", keys.hashed, createHashedStringShape(ref(keys.data), parent(keys.flat)));
  if (utf8Storage) {
    add("utf8-data", keys.utf8Data, nativeScalarTypeDeclaration(createUtf8StringDataType()));
    add("utf8", keys.utf8, createUtf8StringShape(ref(keys.utf8Data), parent(keys.any)));
  }
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "string-types" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}
export interface NativeStringLiteralRecipe extends NativeResourceRecipe {
  readonly requests: readonly { readonly cacheKey: string }[];
  readonly globals: readonly {
    readonly cacheKey: string;
    readonly value: string;
    readonly encoding?: StringEncoding;
  }[];
  readonly functions: readonly {
    readonly cacheKey: string;
    readonly chunks: readonly string[];
    readonly chunkKeys: readonly string[];
  }[];
}
function checkedDemands(requirements: NativeStringLiteralRequirements) {
  if (
    !requirements ||
    typeof requirements.key !== "string" ||
    !requirements.key ||
    typeof requirements.utf8Storage !== "boolean" ||
    !Array.isArray(requirements.literals)
  )
    throw new Error("native strings: invalid reservation phase/key/config/demands");
  const demands: { value: string; encoding?: StringEncoding }[] = [];
  for (let i = 0; i < requirements.literals.length; i++) {
    const row = requirements.literals[i];
    if (
      !Object.hasOwn(requirements.literals, i) ||
      !row ||
      typeof row.value !== "string" ||
      (row.encoding !== undefined &&
        row.encoding !== "ascii" &&
        row.encoding !== "utf8-guaranteed" &&
        row.encoding !== "wtf16")
    )
      throw new Error("native strings: invalid literal demand");
    demands.push({ value: row.value, encoding: row.encoding });
  }
  return demands;
}
/** Complete private chunk topology and exact per-space names/order from the canonical selector. */
export function declareNativeStringLiteralResources(
  requirements: NativeStringLiteralRequirements,
): NativeStringLiteralRecipe {
  const demands = checkedDemands(requirements),
    keys = nativeStringTypeKeys(requirements.key);
  const declarations: NativeStringValueDeclaration[] = [],
    reservationSteps: NativeStringValueReservationStep[] = [];
  const globals: { cacheKey: string; value: string; encoding?: StringEncoding }[] = [];
  const functions: { cacheKey: string; chunks: readonly string[]; chunkKeys: readonly string[] }[] = [];
  const cache = new Set<string>();
  const add = (row: NativeStringValueDeclaration) => {
    declarations.push(row);
    reservationSteps.push({ phase: "resources", kind: "reserve", resourceKey: row.key });
  };
  const visit = (value: string, encoding?: StringEncoding): string => {
    const selected = selectNativeStringLiteral(requirements.utf8Storage, requirements.utf8Storage, value, encoding);
    if (cache.has(selected.key)) return selected.key;
    if (selected.kind === "global") {
      add({
        key: `${requirements.key}:${selected.key}`,
        role: ["literal-global", selected.key],
        space: "global",
        name: `__strlit_${globals.length}`,
        valueType: { kind: "ref", typeKey: selected.encoding === "utf8" ? keys.utf8 : keys.flat },
        mutable: false,
      });
      globals.push({ cacheKey: selected.key, value, encoding });
    } else {
      const chunkKeys = selected.chunks.map((chunk) => visit(chunk, "wtf16"));
      add({
        key: `${requirements.key}:${selected.key}`,
        role: ["literal-materializer", selected.key],
        space: "function",
        name: `__strlit_materialize_${functions.length}`,
        signature: { params: [], results: [{ kind: "ref", typeKey: keys.any }] },
      });
      functions.push({ cacheKey: selected.key, chunks: selected.chunks, chunkKeys });
    }
    cache.add(selected.key);
    return selected.key;
  };
  const requests = demands.map(({ value, encoding }) => ({ cacheKey: visit(value, encoding) }));
  return freezeNativeResourceRecipe({ declarations, reservationSteps, requests, globals, functions });
}

export interface NativeStringLiteralRequirements {
  readonly key: string;
  readonly utf8Storage: boolean;
  /** Ordered demands; repeated literals share the original interning key. */
  readonly literals: readonly { readonly value: string; readonly encoding?: StringEncoding }[];
}
export type NativeStringLiteralBinding =
  | {
      readonly kind: "global";
      readonly text: string;
      readonly global: GlobalReservation;
      readonly representation: "gc";
    }
  | {
      readonly kind: "callable";
      readonly text: string;
      readonly function: FunctionReservation;
      readonly representation: "gc";
    };
export interface NativeStringLiteralReservations {
  readonly layout: NativeStringLayout;
  readonly types: readonly TypeReservation[];
  /** One binding per ordered demand, including repeated demands. */
  readonly literals: readonly NativeStringLiteralBinding[];
}
export interface NativeStringLiteralTypeReservations {
  readonly key: string;
  readonly utf8Storage: boolean;
  readonly layout: NativeStringLayout;
  readonly types: readonly TypeReservation[];
}
export interface NativeStringLiteralReservationInventory {
  readonly typePack: NativeStringLiteralTypeReservations;
  readonly requests: readonly { readonly cacheKey: string; readonly binding: NativeStringLiteralBinding }[];
  readonly globals: readonly { readonly cacheKey: string; readonly global: GlobalReservation }[];
  readonly functions: readonly {
    readonly cacheKey: string;
    readonly function: FunctionReservation;
    readonly chunkGlobals: readonly GlobalReservation[];
  }[];
}
const typeOwners = new WeakMap<
  NativeStringLiteralTypeReservations,
  { tx: PhysicalModuleReservations; consumed: boolean }
>();
function authenticateTypes(tx: PhysicalModuleReservations, pack: NativeStringLiteralTypeReservations) {
  const owner = typeOwners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native strings: foreign or forged type owner");
  for (const token of pack.types) {
    if (tx.state === "reserving") tx.assertTypeReservation(token);
    else tx.physicalIndex(token);
  }
  return owner;
}
interface LiteralOwner {
  readonly tx: PhysicalModuleReservations;
  readonly typePack: NativeStringLiteralTypeReservations;
  readonly inventory: NativeStringLiteralReservationInventory;
  readonly utf8Storage: boolean;
  readonly bindings: ReadonlyMap<string, NativeStringLiteralBinding>;
  readonly globals: readonly { readonly cacheKey: string; readonly token: GlobalReservation; readonly init: Instr[] }[];
  readonly functions: readonly {
    readonly token: FunctionReservation;
    readonly cacheKey: string;
    readonly chunks: readonly string[];
    readonly globals: readonly GlobalReservation[];
  }[];
  filled: boolean;
}
const owners = new WeakMap<NativeStringLiteralReservations, LiteralOwner>();

/** Reserve only the canonical type family, leaving the import window open. */
export function reserveNativeStringLiteralTypes(
  tx: PhysicalModuleReservations,
  resourceKey: string,
  utf8Storage: boolean,
): NativeStringLiteralTypeReservations {
  if (typeof resourceKey !== "string" || !resourceKey || typeof utf8Storage !== "boolean" || tx.state !== "reserving")
    throw new Error("native strings: invalid reservation phase/key/config");
  const recipe = declareNativeStringLiteralTypes(resourceKey, utf8Storage);
  const records = executeNativeResourceRecipe(tx, recipe),
    keys = nativeStringTypeKeys(resourceKey);
  const types = recipe.declarations.map((row) => requireNativeDeclaredReservation(records, row.key, "type"));
  const index = (key: string) => requireNativeDeclaredReservation(records, key, "type").typeIndex;
  const layout = {
    nativeStrDataTypeIdx: index(keys.data),
    anyStrTypeIdx: index(keys.any),
    nativeStrTypeIdx: index(keys.flat),
    consStrTypeIdx: index(keys.cons),
    hashedStrTypeIdx: index(keys.hashed),
    utf8StrDataTypeIdx: utf8Storage ? index(keys.utf8Data) : -1,
    utf8StrTypeIdx: utf8Storage ? index(keys.utf8) : -1,
  };
  Object.freeze(layout);
  const pack = Object.freeze({ key: resourceKey, utf8Storage, layout, types: Object.freeze(types) });
  typeOwners.set(pack, { tx, consumed: false });
  return pack;
}

/** Combined compatibility API, or literal demands using this producer's exact type pack. */
export function reserveNativeStringLiteralResources(
  tx: PhysicalModuleReservations,
  requirements: NativeStringLiteralRequirements,
  suppliedTypes?: NativeStringLiteralTypeReservations,
): NativeStringLiteralReservations {
  if (
    !requirements ||
    typeof requirements.key !== "string" ||
    !requirements.key ||
    typeof requirements.utf8Storage !== "boolean" ||
    tx.state !== "reserving" ||
    !Array.isArray(requirements.literals)
  )
    throw new Error("native strings: invalid reservation phase/key/config/demands");
  // Copy dense, validated demands before any type allocation. Encoding evidence is
  // checked by the canonical planner below, after authenticating the type pack.
  const demands: { value: string; encoding?: StringEncoding }[] = [];
  for (let i = 0; i < requirements.literals.length; i++) {
    const row = requirements.literals[i];
    if (
      !Object.hasOwn(requirements.literals, i) ||
      !row ||
      typeof row.value !== "string" ||
      (row.encoding !== undefined &&
        row.encoding !== "ascii" &&
        row.encoding !== "utf8-guaranteed" &&
        row.encoding !== "wtf16")
    )
      throw new Error("native strings: invalid literal demand");
    demands.push({ value: row.value, encoding: row.encoding });
  }
  const typePack = suppliedTypes ?? reserveNativeStringLiteralTypes(tx, requirements.key, requirements.utf8Storage);
  const typeOwner = authenticateTypes(tx, typePack);
  if (typePack.key !== requirements.key || typePack.utf8Storage !== requirements.utf8Storage)
    throw new Error("native strings: type key/config mismatch");
  if (typeOwner.consumed) throw new Error("native strings: type pack already consumed");
  const { layout, types } = typePack;
  const recipe = declareNativeStringLiteralResources({ ...requirements, literals: demands });
  const plans = recipe.globals.map(({ value, encoding, cacheKey }) => {
    const plan = planNativeStringLiteral(layout, typePack.utf8Storage, value, encoding);
    if (plan.kind !== "global" || plan.key !== cacheKey) throw new Error("native strings: contradictory leaf recipe");
    return plan;
  });
  const key = (role: string) => `${requirements.key}:${role}`;
  const globals: { cacheKey: string; token: GlobalReservation; init: Instr[] }[] = [];
  const functions: {
    cacheKey: string;
    token: FunctionReservation;
    chunks: readonly string[];
    globals: readonly GlobalReservation[];
  }[] = [];
  const cache = new Map<string, NativeStringLiteralBinding>();
  // Allocation failures consume this pack; there is no rollback contract.
  typeOwner.consumed = true;
  const records = executeNativeResourceRecipe(tx, recipe, new Map(types.map((token) => [token.key, token])));
  recipe.globals.forEach((row, i) => {
    const token = requireNativeDeclaredReservation(records, key(row.cacheKey), "global");
    globals.push({ cacheKey: row.cacheKey, token, init: plans[i]!.init });
    cache.set(row.cacheKey, Object.freeze({ kind: "global", text: row.value, global: token, representation: "gc" }));
  });
  for (const row of recipe.functions) {
    const token = requireNativeDeclaredReservation(records, key(row.cacheKey), "function");
    const leaves = row.chunkKeys.map((cacheKey) => requireNativeDeclaredReservation(records, key(cacheKey), "global"));
    functions.push({ cacheKey: row.cacheKey, token, chunks: row.chunks, globals: leaves });
    cache.set(
      row.cacheKey,
      Object.freeze({ kind: "callable", text: row.chunks.join(""), function: token, representation: "gc" }),
    );
  }
  const literals = recipe.requests.map(({ cacheKey }) => cache.get(cacheKey)!);
  const pack = Object.freeze({ layout, types: Object.freeze(types), literals: Object.freeze(literals) });
  const inventory = Object.freeze({
    typePack,
    requests: Object.freeze(
      literals.map((binding, i) => Object.freeze({ cacheKey: recipe.requests[i]!.cacheKey, binding })),
    ),
    globals: Object.freeze(globals.map((row) => Object.freeze({ cacheKey: row.cacheKey, global: row.token }))),
    functions: Object.freeze(
      functions.map((row) =>
        Object.freeze({ cacheKey: row.cacheKey, function: row.token, chunkGlobals: Object.freeze([...row.globals]) }),
      ),
    ),
  });
  owners.set(pack, {
    tx,
    typePack,
    inventory,
    utf8Storage: typePack.utf8Storage,
    bindings: cache,
    globals,
    functions,
    filled: false,
  });
  return pack;
}

function authenticateLiteralOwner(tx: PhysicalModuleReservations, pack: NativeStringLiteralReservations) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native strings: foreign or forged resource owner");
  authenticateTypes(tx, owner.typePack);
  return owner;
}

/** Reservation census includes private chunks; it does not attest completion. */
export function nativeStringLiteralReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeStringLiteralReservations,
): NativeStringLiteralReservationInventory {
  return authenticateLiteralOwner(tx, pack).inventory;
}

/** Authenticate the actual owner and ledger descriptors before exposing a literal dependency. */
export function requireNativeStringLiteral(
  tx: PhysicalModuleReservations,
  pack: NativeStringLiteralReservations,
  text: string,
  encoding?: StringEncoding,
): NativeStringLiteralBinding {
  const owner = authenticateLiteralOwner(tx, pack);
  const selected =
    encoding === undefined
      ? undefined
      : owner.bindings.get(planNativeStringLiteral(pack.layout, owner.utf8Storage, text, encoding).key);
  const binding = pack.literals.find((row) => (encoding === undefined ? row.text === text : row === selected));
  if (!binding) throw new Error(`native strings: missing literal ${JSON.stringify(text)}`);
  return binding;
}

/** Attest actual canonical fills through this owner's existing ledger, not a body-name heuristic. */
export function requireCompletedNativeStringLiterals(
  tx: PhysicalModuleReservations,
  pack: NativeStringLiteralReservations,
): NativeStringLiteralReservations {
  const owner = authenticateLiteralOwner(tx, pack);
  if (!owner.filled) throw new Error("native strings: incomplete literal resources");
  for (const token of pack.types) tx.physicalIndex(token);
  for (const row of owner.globals) tx.physicalIndex(row.token);
  for (const row of owner.functions) tx.physicalIndex(row.token);
  return pack;
}

export function fillNativeStringLiteralResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringLiteralReservations,
): void {
  const owner = authenticateLiteralOwner(tx, pack);
  if (owner.filled) throw new Error("native strings: duplicate fill");
  for (const token of pack.types) tx.physicalIndex(token);
  for (const row of owner.globals) tx.fillGlobal(row.token, row.init);
  for (const row of owner.functions) {
    tx.fillFunction(
      row.token,
      buildOversizedNativeStringLiteral(
        pack.layout,
        row.chunks,
        row.globals.map((token) => tx.physicalIndex(token)),
      ),
    );
  }
  owner.filled = true;
}
