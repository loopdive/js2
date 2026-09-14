// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IntrinsicId, IntrinsicSignatureVersion } from "./intrinsic-vocabulary.js";
import type { IrType } from "./types.js";

export interface IntrinsicSignature {
  readonly version: IntrinsicSignatureVersion;
  readonly params: readonly IrType[];
  readonly result: IrType;
}

export interface IntrinsicSourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface IntrinsicUse {
  readonly id: IntrinsicId;
  readonly version: IntrinsicSignatureVersion;
  readonly argumentTypes: readonly IrType[];
  readonly resultType: IrType;
  readonly location: IntrinsicSourceLocation;
}

export interface IntrinsicDefinition<Feature extends string> {
  readonly id: IntrinsicId;
  readonly signature: IntrinsicSignature;
  readonly feature: Feature;
}

export type IntrinsicVerificationCode =
  | "unknown-intrinsic"
  | "invalid-intrinsic-location"
  | "intrinsic-version-mismatch"
  | "intrinsic-signature-mismatch"
  | "intrinsic-effect-mismatch";

export interface IntrinsicVerificationFailure {
  readonly code: IntrinsicVerificationCode;
  readonly detail: string;
}
