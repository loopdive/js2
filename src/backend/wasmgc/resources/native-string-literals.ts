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
  createAnyStringType,
  createNativeStringType,
  createConsStringType,
  createHashedStringType,
  createUtf8StringDataType,
  createUtf8StringType,
  type NativeStringLayout,
} from "../../../runtime/wasmgc/values/string-layouts.js";
import {
  planNativeStringLiteral,
  buildOversizedNativeStringLiteral,
  type StringEncoding,
} from "../../../runtime/wasmgc/values/string-literal-bodies.js";

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
  const key = (role: string) => `${resourceKey}:${role}`;
  const types: TypeReservation[] = [];
  const reserve = (role: string, descriptor: Parameters<PhysicalModuleReservations["reserveType"]>[1]) => {
    const token = tx.reserveType(key(role), descriptor);
    types.push(token);
    return token.typeIndex;
  };
  const layout = {
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    hashedStrTypeIdx: -1,
    utf8StrDataTypeIdx: -1,
    utf8StrTypeIdx: -1,
  };
  layout.nativeStrDataTypeIdx = reserve("data", createStringDataType());
  layout.anyStrTypeIdx = reserve("any", createAnyStringType());
  layout.nativeStrTypeIdx = reserve("flat", createNativeStringType(layout));
  layout.consStrTypeIdx = reserve("cons", createConsStringType(layout));
  layout.hashedStrTypeIdx = reserve("hashed", createHashedStringType(layout));
  if (utf8Storage) {
    layout.utf8StrDataTypeIdx = reserve("utf8-data", createUtf8StringDataType());
    layout.utf8StrTypeIdx = reserve("utf8", createUtf8StringType(layout));
  }
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
  const plans = demands.map(({ value, encoding }) =>
    planNativeStringLiteral(layout, typePack.utf8Storage, value, encoding),
  );
  const key = (role: string) => `${requirements.key}:${role}`;
  const globals: { cacheKey: string; token: GlobalReservation; init: Instr[] }[] = [];
  const functions: {
    cacheKey: string;
    token: FunctionReservation;
    chunks: readonly string[];
    globals: readonly GlobalReservation[];
  }[] = [];
  const cache = new Map<string, NativeStringLiteralBinding>();
  const literal = (
    value: string,
    encoding?: StringEncoding,
    planned?: ReturnType<typeof planNativeStringLiteral>,
  ): NativeStringLiteralBinding => {
    const plan = planned ?? planNativeStringLiteral(layout, typePack.utf8Storage, value, encoding);
    const existing = cache.get(plan.key);
    if (existing) return existing;
    let binding: NativeStringLiteralBinding;
    if (plan.kind === "global") {
      const token = tx.reserveGlobal(
        key(plan.key),
        `__strlit_${globals.length}`,
        { kind: "ref", typeIdx: plan.refTypeIdx },
        false,
      );
      globals.push({ cacheKey: plan.key, token, init: plan.init });
      binding = Object.freeze({ kind: "global", text: value, global: token, representation: "gc" });
    } else {
      const leaves = plan.chunks.map((chunk) => {
        const leaf = literal(chunk, "wtf16");
        if (leaf.kind !== "global") throw new Error("native strings: oversized leaf");
        return leaf.global;
      });
      const token = tx.reserveFunction(key(plan.key), `__strlit_materialize_${functions.length}`, {
        params: [],
        results: [{ kind: "ref", typeIdx: layout.anyStrTypeIdx }],
      });
      functions.push({ cacheKey: plan.key, token, chunks: plan.chunks, globals: leaves });
      binding = Object.freeze({ kind: "callable", text: value, function: token, representation: "gc" });
    }
    cache.set(plan.key, binding);
    return binding;
  };
  // Allocation failures consume this pack; there is no rollback contract.
  typeOwner.consumed = true;
  const literals = demands.map(({ value, encoding }, i) => literal(value, encoding, plans[i]));
  const pack = Object.freeze({ layout, types: Object.freeze(types), literals: Object.freeze(literals) });
  const inventory = Object.freeze({
    typePack,
    requests: Object.freeze(literals.map((binding, i) => Object.freeze({ cacheKey: plans[i]!.key, binding }))),
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
