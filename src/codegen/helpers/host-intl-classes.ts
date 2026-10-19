// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// host-intl-classes.ts (#6986) — the one place that decides how `Intl` compiles.
//
// There is no native Intl beyond the `Intl.ListFormat` source prelude (#6839):
// real locale formatting needs the CLDR/ICU tables. So `Intl` is a HOST
// provider, and a build has exactly two honest options:
//
// - a host `Intl` is available (the linear backend, or the native regime with
//   the `intl` host accelerator selected): the `Intl.*` constructors
//   register as extern classes whose `Intl_<Class>_*` imports call the real
//   host object. Under the accelerator the runtime marshals every argument and
//   result through the JS value boundary (`src/runtime/intl-host-accelerator.ts`),
//   so native strings and Wasm-owned options bags reach the host as JS values;
// - no host `Intl` (the native regime without the accelerator, standalone,
//   WASI, strict no-host builds): a reference to the global `Intl` is a
//   COMPILE error naming `--host-accelerator intl`. Before #6986 those builds
//   emitted the host imports anyway and failed at run time (or returned null).
//
// Which builds have a host `Intl` is `hostIntlAvailable` (target-profile.ts);
// the ListFormat prelude reads the same predicate, so where the prelude serves
// `Intl.ListFormat` no global `Intl` reference is left for the check to see.

import { ts, forEachChild } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { hasHostAccelerator, hostIntlAvailable } from "../../target-profile.js";
import { reportError } from "../context/errors.js";
import type { CodegenContext } from "../context/types.js";

type ExternMethod = { params: ValType[]; results: ValType[]; requiredParams: number };

function externMethod(paramCount: number): ExternMethod {
  const params: ValType[] = [];
  for (let i = 0; i <= paramCount; i++) params.push({ kind: "externref" }); // self + args
  return { params, results: [{ kind: "externref" }], requiredParams: paramCount + 1 };
}

/**
 * Intl constructors and their instance methods (`name` → arity). The first
 * three predate #6986 (host-assisted lane); the rest are reachable only where
 * the host values are marshalled (see `registerHostIntlExternClasses`).
 */
const INTL_CLASSES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
  [
    "ListFormat",
    [
      ["format", 1],
      ["formatToParts", 1],
      ["resolvedOptions", 0],
    ],
  ],
  [
    "NumberFormat",
    [
      ["format", 1],
      ["formatToParts", 1],
      ["formatRange", 2],
      ["formatRangeToParts", 2],
      ["resolvedOptions", 0],
    ],
  ],
  [
    "DateTimeFormat",
    [
      ["format", 1],
      ["formatToParts", 1],
      ["resolvedOptions", 0],
      ["formatRange", 2],
      ["formatRangeToParts", 2],
    ],
  ],
  [
    "Collator",
    [
      ["compare", 2],
      ["resolvedOptions", 0],
    ],
  ],
  [
    "PluralRules",
    [
      ["select", 1],
      ["selectRange", 2],
      ["resolvedOptions", 0],
    ],
  ],
  [
    "RelativeTimeFormat",
    [
      ["format", 2],
      ["formatToParts", 2],
      ["resolvedOptions", 0],
    ],
  ],
  [
    "DisplayNames",
    [
      ["of", 1],
      ["resolvedOptions", 0],
    ],
  ],
];

/** Every `Intl.*` constructor the `intl` accelerator binds. */
export const INTL_CLASS_NAMES: ReadonlySet<string> = new Set(INTL_CLASSES.map(([className]) => className));

/** Classes registered on the host-assisted lane before #6986 (gates kept byte-identical there). */
const LEGACY_HOST_INTL_CLASSES = new Set(["ListFormat", "NumberFormat", "DateTimeFormat"]);

/**
 * Register the `Intl.*` extern classes for a build that has a host `Intl`.
 *
 * Linear backend (unchanged by #6986): ListFormat and NumberFormat always,
 * DateTimeFormat only while strings are host strings (#5355). The native regime
 * registers every class in {@link INTL_CLASSES}, and only under the `intl`
 * accelerator — there the runtime marshals the boundary.
 */
export function registerHostIntlExternClasses(ctx: CodegenContext): void {
  if (!hostIntlAvailable(ctx.targetProfile)) return;
  const accelerated = hasHostAccelerator(ctx.targetProfile, "intl");
  for (const [className, methodList] of INTL_CLASSES) {
    if (ctx.externClasses.has(className)) continue;
    if (!accelerated) {
      if (!LEGACY_HOST_INTL_CLASSES.has(className)) continue;
      if (className === "DateTimeFormat" && ctx.nativeStrings) continue;
    }
    // The pre-#6986 method tables, kept so the host-assisted import set does not move.
    const methods = new Map<string, ExternMethod>();
    for (const [name, arity] of methodList) {
      if (!accelerated && className === "NumberFormat" && name.startsWith("formatRange")) continue;
      methods.set(name, externMethod(arity));
    }
    ctx.externClasses.set(className, {
      importPrefix: `Intl_${className}`,
      namespacePath: ["Intl"],
      className,
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locales?, options?
      methods,
      properties: new Map(),
    });
  }
}

/** Is `id` a value reference (not a declaration name, member name or type position)? */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === id) return false;
  const named = parent as { name?: ts.Node };
  if (named.name === id && !ts.isShorthandPropertyAssignment(parent)) return false;
  return !ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent);
}

/** Does `id` resolve to the ambient global `Intl` (lib declarations only, or unresolved)? */
export function isGlobalIntl(ctx: CodegenContext, id: ts.Identifier): boolean {
  return ctx.oracle.declarationsOf(id).every((decl) => decl.getSourceFile().isDeclarationFile);
}

function noHostIntlMessage(ctx: CodegenContext, member: string): string {
  const what = member ? `Intl.${member}` : "Intl";
  const profile = ctx.targetProfile;
  if (profile.environment !== "javascript") {
    return (
      `${what} is not available in --target ${profile.target}: there is no ICU data in pure Wasm and no host Intl ` +
      `(only Intl.ListFormat has a native implementation). Compile for the JavaScript target with ` +
      `--host-accelerator intl to use the host's Intl (#6986).`
    );
  }
  if (profile.capabilityPolicy !== "ambient-js") {
    return `${what} needs the host Intl, which strictNoHostImports forbids (#6986).`;
  }
  return (
    `${what} has no native implementation on the native semantic regime: compile with --host-accelerator intl ` +
    `(hostAccelerators: ["intl"]) to use the JavaScript host's Intl (#6986).`
  );
}

/**
 * (#6986) A build without a host `Intl` rejects the first reference to the
 * global `Intl` in each file at compile time, naming the accelerator. Local
 * bindings called `Intl` (the Temporal provider's own shim, a user `const Intl`)
 * are not the global and pass.
 */
export function rejectIntlWithoutHost(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (hostIntlAvailable(ctx.targetProfile) || !sourceFile.text.includes("Intl")) return;
  let reported = false;
  const visit = (node: ts.Node): void => {
    if (reported) return;
    if (ts.isIdentifier(node) && node.text === "Intl" && isValueReference(node) && isGlobalIntl(ctx, node)) {
      const parent = node.parent;
      const member =
        ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isIdentifier(parent.name)
          ? parent.name.text
          : "";
      reportError(ctx, node, noHostIntlMessage(ctx, member));
      reported = true;
      return;
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) visit(stmt);
}
