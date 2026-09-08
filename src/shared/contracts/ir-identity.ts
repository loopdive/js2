// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CompilerSourceProducer } from "./source-origin.js";

declare const irSourceIdBrand: unique symbol;
declare const irUnitIdBrand: unique symbol;
declare const irClassIdBrand: unique symbol;
declare const irBindingIdBrand: unique symbol;

/** Canonical, program-relative identity for one compiler input source. */
export type IrSourceId = string & { readonly [irSourceIdBrand]: "IrSourceId" };
/** Canonical identity for one executable source or synthetic unit. */
export type IrUnitId = string & { readonly [irUnitIdBrand]: "IrUnitId" };
/** Canonical identity for one class declaration or expression. */
export type IrClassId = string & { readonly [irClassIdBrand]: "IrClassId" };
/** Canonical identity for one program ABI intention. */
export type IrBindingId = string & { readonly [irBindingIdBrand]: "IrBindingId" };

export type IrLexicalOwnerId = IrUnitId | IrClassId;
/** Structural function identity plus its temporary compatibility/reference label. */
export interface IrFunctionIdentity {
  readonly unitId: IrUnitId;
  readonly name: string;
}

/** Closed role families for compiler/pass-created executable units. */
export type IrSyntheticUnitRole =
  | `compiler-unit:${CompilerSourceProducer}:${string}`
  | `stdlib-selfhost:${string}`
  | "ir-async-state"
  | "lifted-closure"
  | "monomorphization-clone";
export interface CreateDerivedIrUnitIdInput {
  readonly parentId: IrSourceId | IrLexicalOwnerId;
  readonly role: IrSyntheticUnitRole;
  readonly ordinal: number;
}

export interface CreateIrBindingIdInput {
  readonly ownerId: IrSourceId | IrUnitId | IrClassId;
  readonly domain: "callable" | "global" | "type" | "export" | "class" | "support";
  readonly role: string;
  readonly ordinal?: number;
}
