// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Read final WAT functions by name: their complete form, their direct-call
// targets and their instruction count. Shared by the module-init chunking tests
// (#4376, #7106).
import { expect } from "vitest";

/** Return one complete WAT function form without mistaking a helper prefix for the dispatcher. */
export function watFunction(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = start; index < wat.length; index++) {
    const char = wat[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT function ${name}`);
}

export function watFunctionNames(wat: string): readonly string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  return [...imports, ...definitions];
}

/** Resolve WAT's numeric direct-call operands back to their final function names. */
export function watCallTargets(wat: string, body: string): readonly string[] {
  const names = watFunctionNames(wat);
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => names[Number(match[1])] ?? "<missing>");
}

/** Count final WAT instructions recursively, excluding WAT-only scope forms. */
export function watInstructionCount(body: string): number {
  return body
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("(local "))
    .filter(
      (line) =>
        line !== ")" &&
        line !== "(then" &&
        line !== "(else" &&
        line !== "(do" &&
        line !== "(catch_all" &&
        !line.startsWith("(catch "),
    ).length;
}
