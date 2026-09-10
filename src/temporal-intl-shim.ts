// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// temporal-intl-shim.ts (#5383 S2c) — the module-scoped `Intl` binding that is
// prepended to the @js-temporal/polyfill provider SOURCE for the standalone /
// WASI lanes, and to nothing else.
//
// Why this exists. The polyfill reads the `Intl` namespace at MODULE TOP LEVEL
// in three places, so its `__module_init` cannot return without them:
//
//   ct = Intl.DateTimeFormat                     (a cache of the constructor)
//   const ai = Intl.DateTimeFormat
//   "formatToParts" in ai.prototype || delete DateTimeFormatImpl.prototype.formatToParts
//   "formatRangeToParts" in ai.prototype || delete …
//   di.supportedLocalesOf = ai.supportedLocalesOf
//   const { format: Ri, formatToParts: Si } = Intl.DurationFormat?.prototype ?? …
//
// Standalone deliberately leaves the `Intl` IDENTIFIER null (#5206: "a compiled
// shim for it is a separate, much larger gap" — there is no ICU in pure Wasm),
// so `Intl.DateTimeFormat` reads a property of null and init throws at the
// first of those lines.
//
// Two things this is NOT, both measured before choosing this shape (#5383 S2b):
//
//  - It is NOT a change to standalone `Intl` semantics for user code. An
//    `Intl.<member>` → `undefined` codegen arm was written and REVERTED: it
//    cleared the first read and the `.prototype` probe then threw on
//    `undefined`, so it moved the failure rather than removing it, while
//    changing what every standalone program sees. This binding is lexical and
//    lives in ONE compilation unit — the provider's `index.js`.
//  - It is NOT an Intl implementation. Every member is a refusal that names the
//    target. The 66 of 4,603 Temporal rows that touch `Intl.`/`toLocaleString`
//    are out of scope for #5383 by its own plan and stay red; they now fail
//    with a RangeError that says why, instead of a null dereference.
//
// The shape is dictated by the eager uses above, not by taste:
//   * `Intl.DateTimeFormat` must be a CONSTRUCTOR VALUE with a real
//     `.prototype`, because `"formatToParts" in ai.prototype` is evaluated
//     eagerly. Answering `true` there is also what keeps the polyfill from
//     running the `delete DateTimeFormatImpl.prototype.formatToParts` branch,
//     so its own implementation surface stays intact.
//   * `DurationFormat` and `supportedValuesOf` are `undefined`, because every
//     use of them is behind `?.` or a `typeof … === "function"` test. Giving
//     them bodies would turn those graceful degradations into throws
//     (`Duration.prototype.toLocaleString` falls back to the ISO string).
//   * Every remaining member throws a `RangeError` naming the target, so a
//     lazy path (`Temporal.Now.timeZoneId()`, a non-ISO calendar) fails with a
//     nameable error instead of a trap or a wrong answer.

/** The message every refusal in the shim throws, with the member spelled out. */
function refusal(member: string): string {
  return `Intl.${member} is unavailable under --target standalone (no ICU data in pure Wasm)`;
}

function throwingMethod(name: string, member: string): string {
  return `  ${name}() { throw new RangeError(${JSON.stringify(refusal(member))}); }`;
}

/**
 * The `Intl` shim prepended to the provider source under `--target standalone`
 * / `--target wasi`. Deterministic: the text is part of the provider's cache
 * key (`temporalProviderCacheKey` fingerprints the EFFECTIVE source), so a
 * change here re-keys the standalone artifact and cannot serve a stale one.
 *
 * The binding names are `__js2wasm_`-prefixed so they cannot collide with any
 * of the bundle's 340 top-level bindings.
 */
export function standaloneIntlShimSource(): string {
  const methods = ["format", "formatToParts", "formatRange", "formatRangeToParts", "resolvedOptions"]
    .map((name) => throwingMethod(name, "DateTimeFormat"))
    .join("\n");
  return [
    "// #5383 S2c — standalone Intl refusal shim (js2wasm, provider-local).",
    "class __js2wasm_IntlDateTimeFormat {",
    `  constructor() { throw new RangeError(${JSON.stringify(refusal("DateTimeFormat"))}); }`,
    methods,
    "}",
    "const Intl = {",
    "  DateTimeFormat: __js2wasm_IntlDateTimeFormat,",
    "  DurationFormat: undefined,",
    "  supportedValuesOf: undefined,",
    "};",
    "",
  ].join("\n");
}
