// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Exact intrinsic identities shared by policy and the runtime value boundary. */
export const INTL_EXTERN_CONSTRUCTOR_NAMES = [
  "ListFormat",
  "NumberFormat",
  "DateTimeFormat",
  "Collator",
  "PluralRules",
  "RelativeTimeFormat",
  "DisplayNames",
] as const;

export function externClassAcceleratorFamily(intent: {
  readonly className: string;
  readonly namespacePath?: readonly string[];
}): "date" | "regexp" | "intl" | undefined {
  const namespace = intent.namespacePath;
  if (namespace?.length) {
    return namespace.length === 1 &&
      namespace[0] === "Intl" &&
      INTL_EXTERN_CONSTRUCTOR_NAMES.some((name) => name === intent.className)
      ? "intl"
      : undefined;
  }
  if (intent.className === "Date") return "date";
  if (intent.className === "RegExp") return "regexp";
  return undefined; // Intl is a namespace, not an intrinsic extern constructor.
}
