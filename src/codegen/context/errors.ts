// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared codegen error reporting helpers.
 *
 * This module owns backend diagnostics plumbing that only depends on the
 * stable context layer.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, CodegenError } from "./types.js";

/**
 * #1921 — diagnostic severity for the helpers below. Omitting it defaults to
 * `"error"`, which fails the build. Pass `"degrade"` only for a *deliberate*
 * compile-with-fallback-value site (and reference the tracking issue in the
 * message), or `"warning"` for a purely informational diagnostic.
 */
type ReportSeverity = NonNullable<CodegenError["severity"]>;

/**
 * #1921 — does this codegen diagnostic fail the build?
 *
 * The compile-failure gate keys on {@link CodegenError.severity}, not on a
 * `"Codegen error:"` message prefix. An omitted severity is treated as
 * `"error"` so a forgotten classification fails loudly instead of silently
 * degrading the binary with a stack-balancer placeholder (#1918). `"warning"`
 * (IR-fallback channel) and `"degrade"` (deliberate compile-with-fallback-value)
 * are non-fatal.
 */
export function isFatalCodegenDiagnostic(err: { severity?: CodegenError["severity"] }): boolean {
  return (err.severity ?? "error") === "error";
}

/** Extract {line, column} from a node, returning {0,0} if not available. */
function extractLocation(node: ts.Node): { line: number; column: number } {
  try {
    const sf = node.getSourceFile();
    if (sf) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      return { line: line + 1, column: character + 1 };
    }
  } catch {
    // Fall through to {0,0}
  }
  return { line: 0, column: 0 };
}

/**
 * Report a compile error with source location extracted from the given AST node.
 * Falls back to ctx.lastKnownNode when the node lacks source file context.
 *
 * #1921 — the diagnostic carries an explicit `severity: "error"` by default so
 * the compile-failure gate keys on severity rather than a `"Codegen error:"`
 * message prefix. Pass `"degrade"` for a deliberate compile-with-fallback site.
 */
export function reportError(
  ctx: CodegenContext,
  node: ts.Node,
  message: string,
  severity: ReportSeverity = "error",
): void {
  let loc = extractLocation(node);
  // If the primary node yielded no location, try the last known good node
  if (loc.line === 0 && ctx.lastKnownNode && ctx.lastKnownNode !== node) {
    loc = extractLocation(ctx.lastKnownNode);
  }
  ctx.errors.push({ message, line: loc.line, column: loc.column, severity });
}

/**
 * Report a compile error when no AST node is available.
 * Uses ctx.lastKnownNode for location if possible.
 *
 * #1921 — defaults to `severity: "error"` (see {@link reportError}).
 */
export function reportErrorNoNode(ctx: CodegenContext, message: string, severity: ReportSeverity = "error"): void {
  if (ctx.lastKnownNode) {
    const loc = extractLocation(ctx.lastKnownNode);
    ctx.errors.push({ message, line: loc.line, column: loc.column, severity });
  } else {
    ctx.errors.push({ message, line: 0, column: 0, severity });
  }
}
