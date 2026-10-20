// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  IrBindingId,
  IrClassId,
  IrLexicalOwnerId,
  IrSourceId,
  IrUnitId,
} from "../../shared/contracts/ir-identity.js";
import type { IrType, IrTypeRef } from "./types.js";
import type { IrFuncRef, IrGlobalRef } from "./value-references.js";
import type { IrValueId } from "./nodes.js";

/** ECMAScript class DATA. Runtime values are managed references, never these identities. */
export type IrJsClassRole =
  | "object"
  | "constructor"
  | "prototype"
  | "environment"
  | "binding-cell"
  | "frame"
  | "method";
export type IrJsClassPropertyKey =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "computed"; readonly value: IrValueId };
export type IrJsClassBindingStorage =
  | { readonly kind: "module"; readonly bindingId: IrBindingId }
  | { readonly kind: "cell"; readonly bindingId: IrBindingId; readonly cell: IrValueId };
export interface IrJsClassSpan {
  readonly start: number;
  readonly end: number;
}
export interface IrJsClassBinding {
  readonly id: IrBindingId;
  readonly name: string;
  readonly mutable: boolean;
  readonly storage: "module" | "cell";
  readonly valueType: IrType;
  readonly valueGlobal: IrGlobalRef | null;
  readonly tdzGlobal: IrGlobalRef | null;
}
export interface IrJsClassCapture {
  readonly bindingId: IrBindingId;
  readonly mode: "value" | "live-cell" | "live-global";
  readonly type: IrType;
  readonly valueGlobal: IrGlobalRef | null;
  readonly tdzGlobal: IrGlobalRef | null;
}
export interface IrJsClassFrame {
  readonly type: IrTypeRef;
  readonly thisType: IrType;
  readonly environmentType: IrType;
  readonly homeObjectType: IrType;
  readonly newTargetType: IrType;
  readonly captures: readonly IrJsClassCapture[];
}
export interface IrJsClassBody {
  readonly unitId: IrUnitId;
  readonly target: IrFuncRef;
  readonly sourceBodyKind: "constructor" | "method" | "field-initializer" | "static-initializer";
  readonly lexicalOwnerId: IrLexicalOwnerId;
  readonly terminalOwnerId: IrUnitId;
  readonly ordinal: number;
  readonly span: IrJsClassSpan;
  readonly frame: IrJsClassFrame;
  readonly params: readonly IrType[];
  readonly result: IrType | null;
}
export interface IrJsClassInstanceElement {
  readonly sourceOrdinal: number;
  readonly name: string;
  readonly span: IrJsClassSpan;
  readonly valueType: IrType;
  readonly defaultIntent: "undefined" | "initializer";
  readonly initializer: IrJsClassBody | null;
  readonly attributes: { readonly writable: true; readonly enumerable: true; readonly configurable: true };
}
export interface IrJsClassMember {
  readonly sourceOrdinal: number;
  readonly name: string;
  readonly static: boolean;
  readonly span: IrJsClassSpan;
  readonly body: IrJsClassBody;
  readonly attributes: { readonly writable: true; readonly enumerable: false; readonly configurable: true };
}
export interface IrJsClassDefinition {
  readonly schema: "native-js-class-definition-v1";
  readonly sourceClassId: IrClassId;
  readonly sourceId: IrSourceId;
  readonly span: IrJsClassSpan;
  readonly evaluationOwnerUnitId: IrUnitId;
  readonly form: "declaration" | "expression";
  readonly name: string;
  readonly outerBinding: IrJsClassBinding | null;
  readonly innerBinding: IrJsClassBinding | null;
  readonly constructorKind: "base";
  readonly constructor: IrJsClassBody;
  readonly implicitConstructor: boolean;
  readonly members: readonly IrJsClassMember[];
  readonly instanceElements: readonly IrJsClassInstanceElement[];
  readonly captures: readonly IrJsClassCapture[];
  readonly roles: Readonly<Record<IrJsClassRole, IrTypeRef>>;
  readonly realm: {
    readonly objectPrototype: IrBindingId;
    readonly functionPrototype: IrBindingId;
    readonly referenceError: IrBindingId;
    readonly typeError: IrBindingId;
  };
}
/** Original module declarations, separate from the legacy migration observer's queue. */
export interface IrJsClassStartup {
  readonly schema: "native-js-class-startup-v1";
  readonly definitions: readonly {
    readonly definitionId: IrBindingId;
    readonly sourceClassId: IrClassId;
    readonly statementOrdinal: number;
    readonly span: IrJsClassSpan;
  }[];
}
export type IrJsClassFrameAccess =
  | { readonly kind: "this" | "environment" | "home-object" | "new-target" }
  | { readonly kind: "capture"; readonly definitionId: IrBindingId; readonly index: number };
