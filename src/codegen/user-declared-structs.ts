// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// user-declared-structs.ts (#3920) — the user-declared-vs-builtin struct
// predicate that `fillClosedStructOwnPropertyNamesArms` asked for by name.
//
// WHY THIS EXISTS. `ctx.structFields` is the compiler's whole nominal struct
// set. It does NOT distinguish a shape the *user* declared from a carrier the
// *compiler* emitted to implement a builtin: `__Date` carries `timestamp`, the
// standalone RegExp carrier carries 7 internal fields, and none of those names
// is `$`- or `__`-prefixed, so the existing name-shaped filters do not remove
// them. Every reflective finalize pass that walks `ctx.structFields` therefore
// has to choose between under-answering (skip closed structs entirely — the
// #3920 enumeration hole) and over-answering (leak builtin internals as own
// properties).
//
// That is not hypothetical and it is not only a future risk — it is a wrong
// answer that already ships through the one reflective surface that does have
// closed-struct arms. Measured on `main`, standalone:
//
//   Object.getOwnPropertyNames(/ab/g)       -> 7   (correct: 1)
//   Object.getOwnPropertyNames(new Date(0)) -> 1   (correct: 0)
//
// #4071 hit the same wall from the other side: sharing those arms with
// `__object_keys` was implemented, measured, and reverted precisely because it
// made `Object.keys(new Date(0))` answer `["timestamp"]`. Its note names the
// missing piece — "a principled user-declared-vs-builtin struct predicate,
// which does not exist yet". This is it.
//
// WHY IT IS A WHITELIST, NOT A BLACKLIST. There are ~40 `ctx.structFields.set`
// call sites and the overwhelming majority are builtin carriers, added
// continuously as builtins land. A blacklist is therefore wrong by default: a
// new carrier leaks its internals as own properties until someone remembers to
// add it, and the failure is SILENT (a wrong answer, not a crash). A whitelist
// inverts that: an unrecognised struct enumerates nothing, which is exactly
// today's behaviour for every closed struct — a missed registration costs a
// missing feature, never a wrong answer. Given that the whole point of this
// issue is that silent wrong answers are the expensive failure mode, the
// asymmetry decides the design.
//
// THE THREE ADMITTED KINDS, and the evidence each rests on:
//
//   1. User `class` declarations — `ctx.classDeclarationMap`, which
//      `collectClassDeclaration` populates keyed by the same display name
//      `commitClassStructLayout` uses for `ctx.structFields.set`. This is not
//      an incidental map being repurposed: it IS the registry of user class
//      declarations, and its value type is `ts.ClassDeclaration |
//      ts.ClassExpression` — user syntax by construction.
//
//   2. Constructor functions ("fnctors") — the `__fnctor_` prefix. Every
//      producer of that prefix derives its fields from a user
//      `ts.FunctionDeclaration` via `deriveFnctorFields`; no builtin carrier
//      mints the prefix.
//
//   3. Object-literal / inferred structural shapes — the `__anon_` prefix,
//      minted only from a user `ts.Type` in `literals.ts` and `index.ts`.
//
// Anything else — `__Date`, `$Promise`, the RegExp carrier, iterator records,
// async frames, tuples, vec/arr runtime structs — is a compiler carrier and is
// not an own-property surface.
//
// TUPLES ARE DELIBERATELY EXCLUDED even though they come from user types. A
// tuple lowers to a struct but is a JS *array* at the semantic level, so its
// own enumerable keys are the index strings "0".."n-1", which the vec arm in
// `fillObjectRuntimeVecArms` already produces. Admitting the struct here would
// enumerate the synthetic field names instead — a wrong answer layered on a
// working one.

import type { CodegenContext } from "./context/types.js";

/** `__fnctor_<Name>` — a constructor function's instance struct. */
const FNCTOR_PREFIX = "__fnctor_";

/** `__anon_<N>` — an object-literal / structurally-inferred shape. */
const ANON_PREFIX = "__anon_";

/**
 * Does `structName` name a shape the USER declared, whose physical fields are
 * therefore own properties observable by reflection (`for…in`, `Object.keys`,
 * `Object.getOwnPropertyNames`, `in`, `hasOwnProperty`)?
 *
 * Returns `false` for compiler-emitted builtin carriers, whose fields are
 * internal slots and must stay invisible. See the module header for why the
 * unrecognised case answers `false` (fail to today's behaviour, never to a
 * leak).
 *
 * This is a NARROWING of the existing `isSyntheticStructName` screen, not a
 * replacement: callers should keep that guard: it removes `__cold` tails and
 * wrapper boxes for reasons unrelated to user-declaredness.
 */
export function isUserDeclaredStruct(ctx: CodegenContext, structName: string): boolean {
  if (structName.startsWith(FNCTOR_PREFIX)) return true;
  if (structName.startsWith(ANON_PREFIX)) return true;
  return ctx.classDeclarationMap.has(structName);
}
