// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5241) "Does ANY compiled class in this PROGRAM declare an instance method
 * of this name?"
 *
 * Why this exists as a program-wide question:
 *
 * `sourceDefinesFunctionMember` (source-function-members.ts) answers the same
 * question **per source file**, and the extern-class first-match loop in
 * `tryExternClassMethodOnAny` uses it to decline binding an `any`-typed
 * receiver's `o.m(...)` to an ambient DOM/builtin import (#3033). That refusal
 * is correct but its scope is one file, so it silently stops applying the
 * moment the class and the call site live in different modules — the ordinary
 * shape for a polyfill/provider plus a consumer.
 *
 * Measured consequence (#5241, base = PR #5347): a provider declaring
 * `class K { add(n) {…} }` and a consumer calling `K.makeStatic(1).add(2)` on
 * the `any`-typed result bound `add` to the FIRST registered extern class
 * declaring it — `Set.prototype.add` — and emitted `env::Set_add`, which
 * answered `undefined`. Because the extern arm returns before the closed /
 * host class-member dispatcher is ever consulted, the `__class_call_add_1`
 * bridge export was never even demanded: the compiled module exported
 * `__class_call_plusOne_1` (a sibling method whose name no extern class
 * declares) and nothing for `add`. Same class, same instance, same arity — the
 * only difference was the NAME colliding with a builtin. That is why #5241
 * looked like an arity defect: every Temporal arithmetic member that failed
 * (`add`, and the `.get`/`.set`/`.has` family) happens to collide, while
 * `subtract` and a 2-arg method did not and worked on base.
 *
 * The answer is derived from `ctx.classSet` × `ctx.classMethodSet` (the same
 * pair `call-receiver-method.ts` already uses for `hasKnownUserClassMethod`),
 * so it covers every class the module compiles, not just the current file's.
 *
 * Hot-path discipline (#3903): the derived name set is memoized per context and
 * invalidated only when either source set changes size — class bodies deferred
 * to a later phase can still grow `classMethodSet` after the first query.
 */

import { ts } from "../ts-api.js";
import { isLinkedImportAccessorName } from "../linked-import-getter-names.js";
import { sourceDefinesFunctionMember } from "./source-function-members.js";

/** `const K = __js2wasm_get_K_<hash>()` — the linker's consumer-side rewrite. */
function isLinkedImportBinding(declaration: ts.Declaration): boolean {
  if (!ts.isVariableDeclaration(declaration)) return false;
  const initializer = declaration.initializer;
  if (initializer === undefined || !ts.isCallExpression(initializer)) return false;
  const callee = initializer.expression;
  if (ts.isPropertyAccessExpression(callee)) return isLinkedImportAccessorName(callee.name.text);
  return ts.isIdentifier(callee) && isLinkedImportAccessorName(callee.text);
}

interface ClassNameSets {
  classSet: Set<string>;
  classMethodSet: Set<string>;
}

interface CachedNames {
  classCount: number;
  methodCount: number;
  names: Set<string>;
}

const cache = new WeakMap<ClassNameSets, CachedNames>();

function methodNames(ctx: ClassNameSets): Set<string> {
  const cached = cache.get(ctx);
  if (cached && cached.classCount === ctx.classSet.size && cached.methodCount === ctx.classMethodSet.size) {
    return cached.names;
  }
  const names = new Set<string>();
  // `classMethodSet` keys are `${className}_${methodName}` and BOTH halves may
  // contain underscores, so the split has to be driven by the known class
  // names rather than by the first separator.
  for (const className of ctx.classSet) {
    const prefix = `${className}_`;
    for (const key of ctx.classMethodSet) {
      if (key.length > prefix.length && key.startsWith(prefix)) names.add(key.slice(prefix.length));
    }
  }
  cache.set(ctx, { classCount: ctx.classSet.size, methodCount: ctx.classMethodSet.size, names });
  return names;
}

/** Does some compiled class in this program declare `name` as a member? */
export function programDeclaresClassMethod(ctx: ClassNameSets, name: string): boolean {
  return methodNames(ctx).has(name);
}

/**
 * The LINKED-lane half of the same question (#5241).
 *
 * `programDeclaresClassMethod` reads the sets of the module being compiled, so
 * in a `separate` link plan the CONSUMER — which compiles on its own, with the
 * provider's classes absent from its `classSet` — still hijacked the call. The
 * measured residual: with only the set-based refusal, `inst.add(2)` answered
 * correctly in both lanes but `inst.has(2)` answered `false` (the `Set_has`
 * import) in the linked lane while answering `"H3"` single-module.
 *
 * So ask the receiver instead. Walk to the leftmost identifier of the receiver
 * expression (`K` in `K.makeStatic(1).has(2)`) and resolve its declaration
 * through the oracle. Two answers decline the extern binding:
 *
 * 1. **The origin file declares the member.** Re-run the ordinary #3033
 *    syntactic scan on the file that declares the value. This is the
 *    same-program / bundled case, where the provider's source is visible.
 *
 * 2. **The origin IS a linked import.** In a `separate` link plan the linker
 *    has already rewritten `import { K } from "pkg"` to
 *    `const K = __js2wasm_get_K_<hash>()`, so the provider's declarations are
 *    not in the consumer's program at all — measured: the consumer's `K`
 *    resolves to a `VariableDeclaration` in its OWN file. Nothing at compile
 *    time can say which members that value has, and guessing "the first ambient
 *    extern class declaring this name" is exactly the wrong guess: it produced
 *    `env::Set_has` for a provider class's `has(n)`, answering `false` where the
 *    single-module control answered `"H3"`. Declining sends the call to the
 *    generic `__extern_method_call` bridge, which resolves by runtime shape
 *    across the seam — demonstrably the working path, since the non-colliding
 *    sibling `subtract` took it and answered correctly on base.
 *
 * Ambient lib declarations are unaffected by (1): `sourceDefinesFunctionMember`
 * counts `ts.MethodDeclaration`s (and function-valued assignments/properties),
 * and a `.d.ts` interface carries `MethodSignature`s, so a receiver rooted at
 * `Set` or `Map` still answers false and keeps its extern binding. (2) is
 * likewise inert outside a linked build — nothing else produces those names.
 */
export function receiverOriginRejectsExternBinding(
  oracle: { valueDeclarationOf(node: ts.Node): ts.Declaration | undefined },
  receiver: ts.Expression,
  name: string,
): boolean {
  let node: ts.Expression = receiver;
  // Bounded so a pathological chain cannot walk forever on the hot path.
  for (let depth = 0; depth < 8; depth++) {
    if (ts.isIdentifier(node)) {
      const declaration = oracle.valueDeclarationOf(node);
      if (declaration === undefined) return false;
      if (isLinkedImportBinding(declaration)) return true;
      return sourceDefinesFunctionMember(declaration.getSourceFile(), name);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) node = node.expression;
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
    else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else return false;
  }
  return false;
}
