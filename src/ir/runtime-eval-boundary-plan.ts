// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend-neutral inventory of syntax that can cross the linked runtime-eval
 * boundary. The inventory is built once so IR admission and legacy lowering
 * cannot disagree after a speculative static lowering declines a site.
 */
import type { TypeOracle } from "../checker/oracle.js";
import { forEachChild, ts } from "../ts-api.js";
import { identifierWritesOf, isStoreTarget } from "../shared/binding-writes.js";

export type IrRuntimeEvalSiteKind =
  | "direct-eval"
  | "indirect-eval"
  | "function-constructor"
  | "intrinsic-value"
  | "global-eval-property"
  | "global-script-eval"
  | "provider-definition"
  // (#6651 A9) A call or `new` whose callee is statically `%GeneratorFunction%`
  // (CreateDynamicFunction, kind "generator"): see
  // `isStaticGeneratorFunctionConstructorSyntax`.
  | "generator-function-constructor";

export interface IrRuntimeEvalSite {
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
  readonly kind: IrRuntimeEvalSiteKind;
  readonly providerDisposition: "required" | "may-fallback" | "provided";
  readonly literalSource?: string;
  /**
   * (#4442) For an `intrinsic-value` site, WHICH intrinsic escaped as a value.
   *
   * `intrinsic-value` conflates two escapes with different consequences: a bare
   * `eval` read needs the provider to EXECUTE, while a bare `Function` read
   * needs it to have an IDENTITY that the rest of the module agrees with. The
   * `%Function%` emitter (codegen/function-intrinsic-carrier.ts) only has to
   * take the provider route for the second, and serving the self-contained
   * carrier in the first case is the difference between a module that links
   * `js2wasm:runtime-eval` and one that does not — measured: a module with a
   * foldable `eval("1")` plus a `<fn>.constructor` read went from `[]` imports
   * to `[js2wasm:runtime-eval]` before this field existed.
   *
   * Recorded here rather than re-derived by a second scanner precisely because
   * the classification has non-obvious carve-outs (`isDirectCalleeIntrinsicValue`,
   * `isFunctionPrototypeMethodChain`) whose cost is measured in the comments
   * below; a copy of them would drift.
   */
  readonly intrinsicName?: "eval" | "Function";
}

export interface IrRuntimeEvalBoundaryPlan {
  readonly sites: readonly IrRuntimeEvalSite[];
  readonly providerMayExecute: boolean;
  readonly sharedRealmMayContainCanonicalValues: boolean;
  readonly callableBoundaryRequired: boolean;
  /** Some dynamic source is computed, or a literal one writes bindings no scan can name. */
  readonly unknownDynamicSource: boolean;
  /** (#7106 A3) Every name a literal dynamic source can write (`literalSourceWrites`). */
  readonly dynamicSourceWrites: ReadonlySet<string>;
}

const PROVIDER_NAMES = new Set([
  "__runtime_new_function",
  "__runtime_indirect_eval",
  "__runtime_direct_eval",
  "__runtime_script_eval",
  "__runtime_apply_interpreted",
]);

export function isRuntimeEvalBoundaryProviderName(name: string | undefined): boolean {
  return name !== undefined && PROVIDER_NAMES.has(name);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalIntrinsic(identifier: ts.Identifier, oracle: TypeOracle | undefined): boolean {
  const declaration = oracle?.valueDeclarationOf(identifier);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

/** `Object.defineProperty(this, k, …)` and friends write a property named by a runtime value. */
function isPropertyDefiningCall(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  if (name === "defineProperty" || name === "defineProperties" || name === "assign") return true;
  return name === "set" && ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect";
}

/**
 * (#7106 A3) Add to `written` every script binding the literal source can
 * write, or answer `false` when it can write one this scan cannot name.
 *
 * Writes are the shared binding-write walker's identifier targets
 * (`identifierWritesOf`: assignment and destructuring, `++`/`--`, for-in/of
 * heads, `var` initializers), a store into `X.f` / `X["f"]` (the receiver may
 * be the global object), and a function declaration (Annex B block functions
 * in sloppy eval code are global var bindings). Nested dynamic code is found
 * by the plan's own site visitor: a literal nested source is scanned the same
 * way, anything else is unnameable — as are a computed member store, a
 * property-defining call, any `.constructor(…)` call and any computed-member
 * call (`this["ev" + "al"](…)`), the spellings a string can use to reach
 * `eval` / `Function` without naming them. The answer over-approximates; it
 * only ever makes a function live.
 */
function literalSourceWrites(source: string, written: Set<string>): boolean {
  const script = ts.createSourceFile("eval-source.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let nameable = true;
  const nested: string[] = [];
  visitRuntimeEvalSites(script, undefined, {
    site: () => {},
    source: (literal) => {
      if (literal === undefined) nameable = false;
      else nested.push(literal);
    },
  });
  const visit = (node: ts.Node): void => {
    for (const write of identifierWritesOf(node)) written.add(write.target.text);
    if (ts.isFunctionDeclaration(node) && node.name) written.add(node.name.text);
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isStoreTarget(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name : unwrapExpression(node.argumentExpression);
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) written.add(key.text);
      else nameable = false;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const reachesConstructor = ts.isPropertyAccessExpression(callee) && callee.name.text === "constructor";
      if (reachesConstructor || ts.isElementAccessExpression(callee) || isPropertyDefiningCall(node)) nameable = false;
    }
    forEachChild(node, visit);
  };
  visit(script);
  for (const fragment of nested) if (!literalSourceWrites(fragment, written)) nameable = false;
  return nameable;
}

function stableSourceId(sourceFile: ts.SourceFile, index: number): string {
  const normalized = sourceFile.fileName.replace(/\\/g, "/");
  return `source:${index}:${normalized.slice(normalized.lastIndexOf("/") + 1)}`;
}

/**
 * Cheap, sound negative gate for the runtime-eval inventory walk. Most source
 * files contain none of the boundary spellings, and walking their full AST is
 * pure compile work. A Unicode escape keeps the answer conservatively true:
 * escaped identifier characters can spell `eval`, `Function`, or a provider
 * name without those literal substrings appearing in the raw source.
 */
export function sourceMayContainRuntimeEvalBoundary(sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text;
  return (
    text.includes("eval") ||
    text.includes("Function") ||
    text.includes("__runtime_") ||
    text.includes("\\u") ||
    // (#6651 A9, #7106 A3) `Object.getPrototypeOf(function* () {}).constructor(src)`
    // and `(function () {}).constructor(src)` reach CreateDynamicFunction
    // without spelling `Function`.
    text.includes("constructor")
  );
}

/**
 * (#6651 A9) Does `expression` denote `%GeneratorFunction%` by SYNTAX alone?
 *
 *  - `Object.getPrototypeOf(G).constructor`, where `G` is a sync generator
 *    function EXPRESSION — the `constructor` that `%GeneratorFunction.prototype%`
 *    owns (§27.3.3.1). The shorter `(G).constructor` reads the same property
 *    but is NOT claimed: standalone routes only the `getPrototypeOf` spelling
 *    to the reified intrinsic (A3), so the run-time guard would reject it;
 *  - an identifier whose variable initializer is that expression (one hop);
 *  - (#6651 A14) `P.constructor`, where `P`'s initializer is that
 *    `Object.getPrototypeOf(G)` call (the test262 `Generator.constructor` form).
 *
 * This is the inventory's half of the claim. The codegen half
 * (`generator-function-dynamic.ts`) additionally proves the binding is never
 * reassigned and guards the value at run time, and it only claims a node this
 * inventory recorded — so the two can never disagree about which module links
 * the provider.
 */
export function isStaticGeneratorFunctionConstructorSyntax(
  expression: ts.Expression,
  oracle: TypeOracle,
  viaBinding = false,
): boolean {
  const e = unwrapExpression(expression);
  if (ts.isIdentifier(e)) {
    if (viaBinding) return false;
    const init = oracle.variableInitializerOf(e);
    return init !== undefined && isStaticGeneratorFunctionConstructorSyntax(init, oracle, true);
  }
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "constructor") return false;
  let call = unwrapExpression(e.expression);
  // (#6651 A14) `var Generator = Object.getPrototypeOf(G); Generator.constructor`
  // — the receiver through one binding hop (codegen proves that binding stable).
  if (ts.isIdentifier(call)) {
    const init = oracle.variableInitializerOf(call);
    if (init === undefined) return false;
    call = unwrapExpression(init);
  }
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return false;
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "getPrototypeOf") return false;
  const receiver = unwrapExpression(callee.expression);
  if (!ts.isIdentifier(receiver) || receiver.text !== "Object" || !isGlobalIntrinsic(receiver, oracle)) return false;
  const holder = unwrapExpression(call.arguments[0]!);
  return (
    ts.isFunctionExpression(holder) &&
    holder.asteriskToken !== undefined &&
    !holder.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function stringArguments(args: readonly ts.Expression[] | undefined): { literalSource?: string; unknown: boolean } {
  if (!args || args.length === 0) return { unknown: false };
  if (!args.every(ts.isStringLiteralLike)) return { unknown: true };
  return { literalSource: args.map((arg) => arg.text).join("\n"), unknown: false };
}

/**
 * `Function.prototype.<name>` where `<name>` is a statically-known key other
 * than `constructor` — e.g. the receiver-uncurry idiom the test262
 * propertyHelper harness opens with (`Function.prototype.call.bind(...)`).
 * The value that escapes such a chain is an ordinary prototype METHOD
 * (`call`, `bind`, `toString`, …), never the `Function` constructor itself,
 * so no dynamic-code capability crosses the runtime-eval boundary. Counting
 * it as an `intrinsic-value` site linked the full interpreter provider (a
 * ~24 MB binary delta) into every propertyHelper-including test262 module
 * AND flipped those modules into the shared-realm carrier representation,
 * where the dynamic-descriptor round-trip loses descriptor fields
 * (harness/verifyProperty-restore-accessor.js and friends). A bare
 * `Function.prototype` value use, a computed member, or `.constructor` all
 * still count as escapes.
 */
function isFunctionPrototypeMethodChain(identifier: ts.Identifier): boolean {
  const proto = identifier.parent;
  if (!ts.isPropertyAccessExpression(proto) || proto.expression !== identifier) return false;
  if (proto.name.text !== "prototype") return false;
  // (#5148 checkpoint) Walk out of transparent wrappers so a cast between the
  // proto read and its member does not defeat the excusal —
  // `(Function.prototype as any).p = 12` is the same non-escape as
  // `Function.prototype.p = 12`, but the AsExpression made it an
  // `intrinsic-value` site, which pulled `js2wasm:runtime-eval` imports into
  // zero-import standalone modules (the #4563 carrier-walk red).
  let outer: ts.Node = proto;
  while (
    outer.parent !== undefined &&
    (ts.isParenthesizedExpression(outer.parent) ||
      ts.isAsExpression(outer.parent) ||
      ts.isSatisfiesExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent) ||
      ts.isTypeAssertionExpression(outer.parent)) &&
    outer.parent.expression === outer
  ) {
    outer = outer.parent;
  }
  const member = outer.parent;
  if (member !== undefined && ts.isPropertyAccessExpression(member) && member.expression === outer) {
    return member.name.text !== "constructor";
  }
  if (member !== undefined && ts.isElementAccessExpression(member) && member.expression === outer) {
    const key = unwrapExpression(member.argumentExpression);
    return ts.isStringLiteralLike(key) && key.text !== "constructor";
  }
  // (#5148 checkpoint) A DESTRUCTURE of the proto object — Deno's
  // `const { bind, call } = Function.prototype` — is the same member-read
  // family: safe unless it binds `constructor`.
  if (
    member !== undefined &&
    ts.isVariableDeclaration(member) &&
    member.initializer === outer &&
    ts.isObjectBindingPattern(member.name)
  ) {
    return member.name.elements.every((element) => {
      const key = element.propertyName ?? element.name;
      return !(ts.isIdentifier(key) && key.text === "constructor");
    });
  }
  // The BARE `Function.prototype` VALUE (stored, passed on): the proto object
  // itself is not eval-capable, and its `.constructor` read is served by the
  // self-contained `%Function%` arm (function-intrinsic-carrier.ts) exactly
  // like `<fn>.constructor` — there is no bare `Function` read for it to
  // disagree with when this excusal fires. Before this, storing the value
  // linked the provider ABI, and a module whose imports were stubbed threw
  // during `__module_init` while seeding the companion's `constructor`.
  return true;
}

function isDirectCalleeIntrinsicValue(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    unwrapExpression(parent.expression) === identifier
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    parent.right === identifier
  ) {
    // `(0, eval)(…)`: the comma always sits inside the parentheses the call's callee unwraps.
    let call = parent.parent;
    while (ts.isParenthesizedExpression(call)) call = call.parent;
    return (ts.isCallExpression(call) || ts.isNewExpression(call)) && unwrapExpression(call.expression) === parent;
  }
  return false;
}

/**
 * A small syntactic gate for the realm object's first-class `eval` property.
 * The global binding is commonly reached as `globalThis.eval`, `this.eval`, or
 * Node's `global.eval`; the latter also covers the ES5 Test262 row's
 * `var global = this` alias. A property on an arbitrary object is deliberately
 * excluded so the global-object seed does not pull the runtime-eval provider
 * into unrelated `obj.eval` programs.
 */
function isLikelyGlobalObjectReceiver(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    unwrapped.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isIdentifier(unwrapped) && (unwrapped.text === "globalThis" || unwrapped.text === "global"))
  );
}

/** Build the single immutable runtime-eval routing authority for a program. */
/** Where the site visitor reports what it finds. */
interface RuntimeEvalSiteSink {
  site(
    node: ts.Node,
    kind: IrRuntimeEvalSiteKind,
    providerDisposition: IrRuntimeEvalSite["providerDisposition"],
    literalSource?: string,
    intrinsicName?: "eval" | "Function",
  ): void;
  /** A dynamic source reaches the provider: its literal text, or `undefined` when computed. */
  source(literalSource: string | undefined): void;
}

function recordStringArguments(source: { literalSource?: string; unknown: boolean }, sink: RuntimeEvalSiteSink): void {
  if (source.literalSource !== undefined) sink.source(source.literalSource);
  if (source.unknown) sink.source(undefined);
}

/** `globalThis.eval(src)` passes `src`; any other use escapes the realm's `eval`. */
function recordGlobalEvalPropertySource(node: ts.Expression, sink: RuntimeEvalSiteSink): void {
  const call = node.parent;
  const source = ts.isCallExpression(call) && call.expression === node ? call.arguments[0] : undefined;
  if (source === undefined || !ts.isStringLiteralLike(source)) sink.source(undefined);
  else sink.source(source.text);
}

/**
 * `(function () {}).constructor(…)` / `[].constructor.constructor(…)`: a
 * function's `constructor` is `%Function%`, reached without naming it.
 */
function isFunctionConstructorReach(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "constructor") return false;
  const receiver = unwrapExpression(callee.expression);
  return (
    ts.isFunctionExpression(receiver) ||
    ts.isArrowFunction(receiver) ||
    (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "constructor")
  );
}

/**
 * Every runtime-eval site under `root`. Without an `oracle` (an eval source
 * fragment) every `eval` / `Function` identifier is the global intrinsic and
 * the generator-constructor spelling is left to the fragment scan.
 */
function visitRuntimeEvalSites(root: ts.Node, oracle: TypeOracle | undefined, sink: RuntimeEvalSiteSink): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "__js2wasm_global_script_eval") {
        const source = node.arguments?.[0];
        const literalSource = source && ts.isStringLiteralLike(source) ? source.text : undefined;
        sink.site(node, "global-script-eval", "required", literalSource);
        if (source !== undefined) sink.source(literalSource);
      } else if (ts.isIdentifier(callee) && isGlobalIntrinsic(callee, oracle)) {
        if (callee.text === "eval") {
          const source = node.arguments?.[0];
          const literalSource = source && ts.isStringLiteralLike(source) ? source.text : undefined;
          sink.site(node, "direct-eval", "required", literalSource);
          if (source !== undefined) sink.source(literalSource);
        } else if (callee.text === "Function") {
          const source = stringArguments(node.arguments);
          sink.site(node, "function-constructor", "may-fallback", source.literalSource);
          recordStringArguments(source, sink);
        }
      } else if (isFunctionConstructorReach(callee)) {
        const source = stringArguments(node.arguments);
        sink.site(node, "function-constructor", "may-fallback", source.literalSource);
        recordStringArguments(source, sink);
      } else if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        const intrinsic = unwrapExpression(callee.right);
        if (ts.isIdentifier(intrinsic) && intrinsic.text === "eval" && isGlobalIntrinsic(intrinsic, oracle)) {
          const source = node.arguments?.[0];
          const literalSource = source && ts.isStringLiteralLike(source) ? source.text : undefined;
          sink.site(node, "indirect-eval", "required", literalSource);
          if (source !== undefined) sink.source(literalSource);
        }
      }
      if (oracle !== undefined && isStaticGeneratorFunctionConstructorSyntax(callee, oracle)) {
        const source = stringArguments(node.arguments);
        sink.site(node, "generator-function-constructor", "required", source.literalSource);
        recordStringArguments(source, sink);
      }
    }

    // `eval` is normally accounted for by the identifier walk below, but a
    // realm-object read (`global.eval` / `globalThis.eval`) has the property
    // name in AST member position and therefore intentionally does not count
    // as an `intrinsic-value` site. It still needs the provider-backed,
    // identity-stable wrapper when the compiler seeds the native global
    // object, so record this narrow demand separately.
    const elementKey = ts.isElementAccessExpression(node) ? unwrapExpression(node.argumentExpression) : undefined;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "eval" &&
      isLikelyGlobalObjectReceiver(node.expression)
    ) {
      sink.site(node, "global-eval-property", "required");
      recordGlobalEvalPropertySource(node, sink);
    } else if (
      ts.isElementAccessExpression(node) &&
      elementKey !== undefined &&
      ts.isStringLiteralLike(elementKey) &&
      elementKey.text === "eval" &&
      isLikelyGlobalObjectReceiver(node.expression)
    ) {
      sink.site(node, "global-eval-property", "required");
      recordGlobalEvalPropertySource(node, sink);
    }

    if (
      ts.isIdentifier(node) &&
      (node.text === "eval" || node.text === "Function") &&
      isGlobalIntrinsic(node, oracle) &&
      !isDirectCalleeIntrinsicValue(node)
    ) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isElementAccessExpression(parent) && parent.argumentExpression === node);
      // (#2960/#4394) The predicate deliberately fires only for `Function` —
      // `eval` stays a site in receiver position (`eval.call(null, src)` is a
      // real indirect eval), and `.constructor` chains stay escapes because
      // `Function.prototype.constructor` IS the eval-capable constructor.
      // This supersedes the broader any-receiver-read carve-out that briefly
      // held this arm: that version also excused the `.constructor` chain.
      const isSafePrototypeMethodReceiver = node.text === "Function" && isFunctionPrototypeMethodChain(node);
      if (!isMemberName && !isSafePrototypeMethodReceiver) {
        sink.site(node, "intrinsic-value", "required", undefined, node.text as "eval" | "Function");
        sink.source(undefined);
      }
    }
    forEachChild(node, visit);
  };
  visit(root);
}

export function buildIrRuntimeEvalBoundaryPlan(
  sourceFiles: readonly ts.SourceFile[],
  oracle: TypeOracle,
): IrRuntimeEvalBoundaryPlan {
  const sites: IrRuntimeEvalSite[] = [];
  const dynamicSourceFragments: string[] = [];
  let unknownDynamicSource = false;

  const addSite = (
    sourceFile: ts.SourceFile,
    id: string,
    node: ts.Node,
    kind: IrRuntimeEvalSiteKind,
    providerDisposition: IrRuntimeEvalSite["providerDisposition"],
    literalSource?: string,
    intrinsicName?: "eval" | "Function",
  ): void => {
    sites.push(
      Object.freeze({
        sourceId: id,
        start: node.getStart(sourceFile),
        end: node.end,
        kind,
        providerDisposition,
        ...(literalSource === undefined ? {} : { literalSource }),
        ...(intrinsicName === undefined ? {} : { intrinsicName }),
      }),
    );
  };

  sourceFiles.forEach((sourceFile, index) => {
    if (!sourceMayContainRuntimeEvalBoundary(sourceFile)) return;
    const id = stableSourceId(sourceFile, index);
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && isRuntimeEvalBoundaryProviderName(statement.name?.text)) {
        addSite(sourceFile, id, statement, "provider-definition", "provided");
      }
    }

    visitRuntimeEvalSites(sourceFile, oracle, {
      site: (node, kind, disposition, literalSource, intrinsicName) =>
        addSite(sourceFile, id, node, kind, disposition, literalSource, intrinsicName),
      source: (literalSource) => {
        if (literalSource === undefined) unknownDynamicSource = true;
        else dynamicSourceFragments.push(literalSource);
      },
    });
  });

  const frozenSites = Object.freeze(sites.slice());
  const dynamicSourceWrites = new Set<string>();
  for (const fragment of dynamicSourceFragments) {
    if (!literalSourceWrites(fragment, dynamicSourceWrites)) unknownDynamicSource = true;
  }
  const providerMayExecute = frozenSites.some((site) => site.providerDisposition !== "provided");
  // A provider module has no *consumer* call site of its own, but its exported
  // boundary functions receive and retain canonical caller-realm values. Keep
  // that distinction explicit: providerMayExecute describes callers, while
  // sharedRealmMayContainCanonicalValues also covers the provider definition
  // side of the seam.
  const sharedRealmMayContainCanonicalValues =
    providerMayExecute || frozenSites.some((site) => site.kind === "provider-definition");
  return Object.freeze({
    sites: frozenSites,
    providerMayExecute,
    sharedRealmMayContainCanonicalValues,
    callableBoundaryRequired: frozenSites.length !== 0,
    unknownDynamicSource,
    dynamicSourceWrites,
  });
}
