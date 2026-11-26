// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7410) A debug name without TypeScript's symbol ids. TypeScript names a symbol-keyed member `__@replace@<id>`, and
 * the id comes from a process-global counter, so a method name built from it changes with compile order. The id stays
 * in the compiler's own keys; only the emitted name drops it.
 */
export function withoutSymbolIds(name: string): string {
  return name.replace(/__@([^@]+)@\d+/g, "__@$1");
}
