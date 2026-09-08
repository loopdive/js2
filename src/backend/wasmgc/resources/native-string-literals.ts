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
interface LiteralOwner {
  readonly tx: PhysicalModuleReservations;
  readonly globals: readonly { readonly token: GlobalReservation; readonly init: Instr[] }[];
  readonly functions: readonly {
    readonly token: FunctionReservation;
    readonly chunks: readonly string[];
    readonly globals: readonly GlobalReservation[];
  }[];
  filled: boolean;
}
const owners = new WeakMap<NativeStringLiteralReservations, LiteralOwner>();

/** Canonical type family and actual literal demands, reserved without publishing indices. */
export function reserveNativeStringLiteralResources(
  tx: PhysicalModuleReservations,
  requirements: NativeStringLiteralRequirements,
): NativeStringLiteralReservations {
  if (!requirements.key || tx.state !== "reserving") throw new Error("native strings: invalid reservation phase/key");
  const key = (role: string) => `${requirements.key}:${role}`;
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
  if (requirements.utf8Storage) {
    layout.utf8StrDataTypeIdx = reserve("utf8-data", createUtf8StringDataType());
    layout.utf8StrTypeIdx = reserve("utf8", createUtf8StringType(layout));
  }
  Object.freeze(layout);
  const globals: { token: GlobalReservation; init: Instr[] }[] = [];
  const functions: { token: FunctionReservation; chunks: readonly string[]; globals: readonly GlobalReservation[] }[] =
    [];
  const cache = new Map<string, NativeStringLiteralBinding>();
  const literal = (value: string, encoding?: StringEncoding): NativeStringLiteralBinding => {
    const plan = planNativeStringLiteral(layout, requirements.utf8Storage, value, encoding);
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
      globals.push({ token, init: plan.init });
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
      functions.push({ token, chunks: plan.chunks, globals: leaves });
      binding = Object.freeze({ kind: "callable", text: value, function: token, representation: "gc" });
    }
    cache.set(plan.key, binding);
    return binding;
  };
  const literals = requirements.literals.map(({ value, encoding }) => literal(value, encoding));
  const pack = Object.freeze({ layout, types: Object.freeze(types), literals: Object.freeze(literals) });
  owners.set(pack, { tx, globals, functions, filled: false });
  return pack;
}

/** Authenticate the actual owner and ledger descriptors before exposing a literal dependency. */
export function requireNativeStringLiteral(
  tx: PhysicalModuleReservations,
  pack: NativeStringLiteralReservations,
  text: string,
): NativeStringLiteralBinding {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native strings: foreign or forged resource owner");
  if (tx.state !== "reserving") {
    for (const token of pack.types) tx.physicalIndex(token);
  }
  const binding = pack.literals.find((row) => row.text === text);
  if (!binding) throw new Error(`native strings: missing literal ${JSON.stringify(text)}`);
  return binding;
}

export function fillNativeStringLiteralResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringLiteralReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native strings: foreign or forged resource owner");
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
