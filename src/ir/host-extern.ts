// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2856) Host-extern ambient-global resolution for the IR selector.
//
// Deliberately a LEAF module (imports only the ts facade and the checker
// type-mapper): it is consumed both by `src/codegen/index.ts` (the real
// compiler's `planIrOverlay`) and by `scripts/check-ir-fallbacks.ts` (the IR
// retirement gate, which builds its own program/checker). Importing it from
// the gate script must not drag the whole codegen module graph in — doing so
// perturbs ESM evaluation order and trips the coercion-engine/string-ops
// circular-init TDZ.

import { ts } from "../ts-api.js";
import { isExternalDeclaredClass } from "../checker/type-mapper.js";

/**
 * Build the selector's host-global resolver: identifier node → extern class
 * name ("Document", "Console"), or undefined when the identifier is not an
 * ambient host global the legacy backend would service.
 *
 * Checker-backed on purpose: (a) selection runs before the ctx registries
 * (`declaredGlobals` / `externClasses`) are populated, and (b) the checker
 * resolves the identifier's REAL binding, so user shadowing (`const document
 * = ...`) wins over the lib global by construction. The
 * `isExternalDeclaredClass` gate keeps selector claims in lockstep with what
 * `collectDeclaredGlobals` will actually register as a `global_<name>`
 * handle import.
 *
 * `console` is special-cased: the legacy backend services `console.<m>(...)`
 * via dedicated per-arg-type import variants (`console_log_string`, … — see
 * `collectConsoleImports`), NOT via a `global_console` handle, so it must not
 * need to pass the declared-class gate to be claimable as a method-call
 * receiver.
 *
 * Exclusions:
 *   - `Math` is owned by the dedicated IR whitelist arm
 *     (IR_MATH_UNARY_WHITELIST / mathUnaryToIrOp) — claiming it generically
 *     would bypass the whitelist's method gating.
 *   - CONSTRUCTOR/callable-typed globals (`Date: DateConstructor`,
 *     `Symbol: SymbolConstructor`, …): their static members are
 *     legacy-intercepted (Date.now, Array.isArray, …) and the extern-member
 *     machinery does not model them — claiming one would route a static call
 *     to a nonexistent `<TypeName>_<member>` import. Only INSTANCE-shaped
 *     globals (document, performance, …) resolve.
 */
export function makeIrHostGlobalResolver(checker: ts.TypeChecker): (node: ts.Identifier) => string | undefined {
  return (node: ts.Identifier): string | undefined => {
    try {
      if (node.text === "Math") return undefined;
      const sym = checker.getSymbolAtLocation(node);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (!decl || !ts.isVariableDeclaration(decl)) return undefined;
      if (!decl.getSourceFile().isDeclarationFile) return undefined;
      const type = checker.getTypeAtLocation(decl);
      if (node.text === "console") return "Console";
      if (type.getConstructSignatures().length > 0 || type.getCallSignatures().length > 0) return undefined;
      if (!isExternalDeclaredClass(type, checker)) return undefined;
      return type.getSymbol()?.name;
    } catch {
      return undefined;
    }
  };
}
