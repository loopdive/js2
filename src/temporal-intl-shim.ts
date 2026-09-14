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
//  - It is NOT a general Intl implementation. Since #6442 (S9) exactly ONE
//    member has a body: `DateTimeFormat`, and only for the zones that need no
//    CLDR/tzdata tables (`UTC`, its aliases, `Etc/GMT±N`) — see
//    `standalone-intl-datetimeformat.ts`. Every other member, and every other
//    zone/locale/option shape, is still a refusal that names the target, so
//    `Intl.`/`toLocaleString` rows stay red with a RangeError that says why
//    rather than a null dereference.
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
//     lazy path (a non-ISO calendar, a tzdata zone) fails with a nameable
//     error instead of a trap or a wrong answer. `hr` wraps its
//     `resolvedOptions()` call in `try/catch`, so a refusal reads to the
//     polyfill as "unknown time zone" — which is the truth.

import { standaloneIntlDateTimeFormatSource } from "./standalone-intl-datetimeformat.js";

/** The message every refusal in the shim throws, with the member spelled out. */
function refusal(member: string): string {
  return `Intl.${member} is unavailable under --target standalone (no ICU data in pure Wasm)`;
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
  return [
    "// #5383 S2c — standalone Intl shim (js2wasm, provider-local).",
    standaloneIntlDateTimeFormatSource("__js2wasm_IntlDateTimeFormat", refusal("DateTimeFormat")),
    "const Intl = {",
    "  DateTimeFormat: __js2wasm_IntlDateTimeFormat,",
    "  DurationFormat: undefined,",
    "  supportedValuesOf: undefined,",
    "};",
    "",
  ].join("\n");
}
