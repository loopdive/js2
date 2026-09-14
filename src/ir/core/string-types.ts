// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Audited producer evidence consumed by linear string backends. */
export type IrStringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";

export type IrStringConcatMode = "immutable" | "owned-append";
