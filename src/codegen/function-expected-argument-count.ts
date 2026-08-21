// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4436) ECMA-262 §15.1.5 **ExpectedArgumentCount** — the value a function
 * object's `length` own property must carry.
 *
 * ## The defect this replaces
 * The `<fn>.length` static fold (`property-access-dispatch.ts`) counted the
 * parameters that are *not* optional/defaulted/rest with a `filter().length`,
 * justified in a comment by:
 *
 * > TS forbids required-after-optional, so filtering out optional/default/rest
 * > is equivalent to iterating until the first one.
 *
 * That premise is **false for the JavaScript this compiler actually accepts**
 * (`allowJs: true`, and every Test262 file). TypeScript rejects
 * `function f(x?: number, y: number) {}`, but plain JS
 * `function f(x = 42, y) {}` is legal and pervasive — and for it the two
 * formulations disagree:
 *
 * | source                  | filter() | §15.1.5 | spec `f.length` |
 * | ----------------------- | -------- | ------- | --------------- |
 * | `function f(x, y)`      | 2        | 2       | 2               |
 * | `function f(x = 42)`    | 0        | 0       | 0               |
 * | `function f(x = 42, y)` | **1**    | **0**   | **0**           |
 * | `function f(x, y = 4)`  | 1        | 1       | 1               |
 * | `function f(x, y=4, z)` | **2**    | **1**   | **1**           |
 *
 * §15.1.5 is a *prefix* count, not a *filter*: it walks the FormalsList and
 * returns at the first `FormalParameter` that HasInitializer. A defaulted
 * parameter therefore truncates the count for every parameter to its right,
 * including required ones. Measured on `main` 2026-08-15 (standalone): rows 3
 * and 5 above are exactly the `f2`/`f4` cases of
 * `language/{statements,expressions}/function/length-dflt.js`.
 *
 * ## Why a leaf module
 * The same count is needed by the static fold AND by any runtime metadata
 * carrier for a function instance (the `length` own property is one value, so
 * the fold and the descriptor must not be able to disagree — that divergence is
 * precisely what #2896's header warns about for `name`/`length`). Stating it
 * once, in a module that imports only `typescript`, lets both sides call it
 * without either importing the other.
 *
 * A rest parameter also terminates the walk: §15.1.5's FunctionRestParameter
 * production yields 0 and contributes nothing. `questionToken` (a TS-only
 * spelling of "has no expected argument") is treated as an initializer, which
 * is what the previous filter did too.
 */
import { ts } from "../ts-api.js";

/**
 * §15.1.5 ExpectedArgumentCount over a parameter list: the number of leading
 * parameters before the first defaulted, optional or rest parameter.
 *
 * Accepts the declaration nodes directly, so both a `ts.Signature`'s resolved
 * parameters (via each symbol's `valueDeclaration`) and a raw
 * `SignatureDeclaration.parameters` can be measured by the same rule. A
 * parameter whose declaration is unavailable is counted as expected — the
 * conservative direction, and the one the previous `filter` took.
 */
export function expectedArgumentCountOfParams(params: readonly (ts.ParameterDeclaration | undefined)[]): number {
  let count = 0;
  for (const decl of params) {
    // No declaration to inspect ⇒ treat as an ordinary required formal.
    if (decl === undefined) {
      count++;
      continue;
    }
    // The TypeScript `this` pseudo-parameter is a TYPE annotation, not a
    // FormalParameter — §15.1.5 never sees it, and it may only appear first.
    // Counting it inflated `.length` by one for every signature that declares
    // one, which in `lib.es5.d.ts` is exactly the `%Function.prototype%`
    // invokers: `call(this: Function, thisArg, ...argArray)` answered 2 where
    // §20.2.3.3 says 1, and `bind` likewise (test262
    // `built-ins/Function/prototype/call/S15.3.4.4_A2_T2.js`). `apply` read 2
    // and IS 2, so it hid the defect. `calls.ts`'s `countSpecLength` already
    // skipped it; this is the same rule in the module that owns the count.
    if (ts.isIdentifier(decl.name) && decl.name.text === "this") continue;
    if (decl.dotDotDotToken !== undefined || decl.questionToken !== undefined || decl.initializer !== undefined) {
      // §15.1.5: the walk STOPS here — parameters to the right never count,
      // even when they are themselves required.
      return count;
    }
    count++;
  }
  return count;
}

/**
 * §15.1.5 over a resolved `ts.Signature`. Each parameter symbol's
 * `valueDeclaration` is the `ts.ParameterDeclaration` when the signature came
 * from real source; ambient/library signatures may lack one, and those count as
 * expected (see {@link expectedArgumentCountOfParams}).
 */
export function expectedArgumentCountOfSignature(sig: ts.Signature): number {
  // Prefer the DECLARATION's own FormalsList. §15.1.5 counts a syntactic
  // production, and a resolved signature is not one: for plain JS, TypeScript's
  // inference SYNTHESIZES a trailing parameter on any function that mentions
  // `arguments` —
  //
  //     function f(x, y) { return arguments; }
  //     // sig.parameters → x, y, args        ← `args` is not in the source
  //     f.length  // answered 3, spec 2
  //
  // and that third symbol has no `valueDeclaration`, so the fallback below
  // counts it as an ordinary required formal. Reading `sig.declaration`
  // sidesteps the question: it is the node the author (or the `.d.ts`) wrote,
  // so a library signature is measured exactly as before.
  const decl = sig.declaration;
  if (decl !== undefined && !ts.isJSDocSignature(decl)) return expectedArgumentCountOfParams(decl.parameters);
  return expectedArgumentCountOfParams(
    sig.parameters.map((p) => {
      const decl2 = (p as ts.Symbol).valueDeclaration;
      return decl2 !== undefined && ts.isParameter(decl2) ? decl2 : undefined;
    }),
  );
}
