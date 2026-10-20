// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Shared symbolic storage identities; no physical reservations or IR admission authority. */
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
