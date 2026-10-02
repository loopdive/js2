---
id: 6809
title: "codegen: generic Unicode BCP 47 locale grammar and canonicalization kernel for a future standalone Intl.getCanonicalLocales"
status: in-progress
assignee: "ttraenkler/codex-intl-locale-parser"
branch: "codex/6809-intl-locale-canonicalization"
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: intl
goal: standalone-gap
parent: 6717
related: [6717, 6712, 5206, 6442]
created: 2026-10-02
updated: 2026-10-02
---

# #6809 — generic locale grammar and canonicalization kernel

## Scope and status

This is a bounded prerequisite for the standalone user-visible `Intl` work in
[#6717 — Standalone user-visible Intl namespace/API gap](./6717-standalone-user-intl-namespace-api-gap.md).
It owns only a new pure compiler-consumable semantic module, its focused unit
tests, and this record:

- `src/codegen/intl-locale-canonicalization.ts`;
- `tests/issue-6809-intl-locale-canonicalization.test.ts`; and
- this issue file.

It does **not** expose `Intl`, add `Intl.getCanonicalLocales`, allocate a
standalone global namespace, lower calls, add runtime imports, or change the
object/array/Proxy machinery. Therefore this kernel alone cannot flip any
Test262 result and earns no standalone or `Intl` conformance credit. The
unchanged completion boundary remains every original in the frozen 11,778-path
manifest; the 74-row Intl diagnostic cohort also remains unchanged.

The worktree was created from `upstream/main` `1f1b0ad61cbc74d0bde3a326e8b7e2e02b7add99`.
Issue allocation and assignment were made atomically through
`scripts/claim-issue.mjs`: #6809 is claimed by
`ttraenkler/codex-intl-locale-parser` on this branch.

## Fresh ownership and overlap receipt (2026-10-02)

The active data-foundation PR #6427 owns only the generator, pinned CLDR
inputs/provenance/licenses, generated JSON, its #6717 plan update, and its
generator test. It is frozen and is not modified here. The active static and
runtime ownership work includes `builtin-value-read.ts`, `identifiers.ts`,
`calls.ts`, `call-namespace-static.ts`, `array-object-proto.ts`,
`object-runtime.ts`, `index.ts`, `literals.ts`, and IR paths. Those files are
explicitly outside this issue. The #6428 work also owns `index.ts`, `misc.ts`,
`type-coercion.ts`, `runtime.ts`, and IR files. This issue introduces no edit
to any of those shared surfaces.

The chosen module is deliberately data-injected rather than importing a JSON
asset. The current #6427 output is an asset-only JSON document and the
compiler's `tsconfig` includes `src/**/*.ts`, not generated assets. A later,
separately-owned data-emission step must produce a deterministic
compiler-consumable source table from the #6427 pins before any compiled
standalone API can consume the kernel.

## Standards contract

The kernel implements the semantic portion that a future
`CanonicalizeLocaleList` lowering needs for one already-obtained locale string:

1. recognize the Unicode BCP 47 / UTS #35 language-tag grammar;
2. reject structurally invalid input without an available-locales filter;
3. apply data-derived language, script, region, and variant aliases;
4. canonicalize casing and Unicode `u`/transformed `t` extension components;
   and
5. serialize one stable canonical identifier.

The relevant primary algorithms are ECMA-402
[`IsWellFormedLanguageTag`](https://tc39.es/ecma402/#sec-iswellformedlanguagetag),
[`CanonicalizeUnicodeLocaleId`](https://tc39.es/ecma402/#sec-canonicalizeunicodelocaleid),
and [`CanonicalizeLocaleList`](https://tc39.es/ecma402/#sec-canonicalizelocalelist),
with the Unicode grammar and canonical processing rules in
[UTS #35, Unicode locale identifiers](https://unicode.org/reports/tr35/tr35.html#Unicode_locale_identifier).

No behavior is delegated to host `Intl`, evaluator ICU, URL parsing, locale
comparison, or an available-locale table. In particular, a syntactically valid
but invented language subtag remains valid; locale availability and matching
are separate ECMA-402 operations.

The parser must cover generic, non-fixture-specific forms:

- language, optional script and region, and valid variants;
- regular singleton extensions, private use, and their ordering constraints;
- Unicode `u` attributes/keys/types, including data-derived key and type
  aliases; and
- transformed `t` language/field forms.

It must reject non-ASCII or underscore-separated spellings, empty/doubled
subtags, initial private use, extlang/irregular grandfathered forms where the
ECMA-402 grammar excludes them, duplicate language variants or extension
singletons, duplicate variants in a transformed language, malformed
private-use tails, and malformed extension fields. ECMA-402's
`IsWellFormedLanguageTag` deliberately does **not** reject repeated `u` keys
or transformed `t` field keys: repeated `u` attributes and keywords remain
parseable, and canonicalization retains only the first instance of an
attribute or keyword key. Repeated transformed fields also remain parseable;
their canonical key/value fields are retained and ordered deterministically
after metadata canonicalization. This models ECMA-402's structural-validation
algorithm rather than imposing the stricter UTS #35 well-formedness constraint
for duplicate `ukey`/`tkey` fields. Exact extension serialization is grounded
in the specification and corpus tests; the Node 24 duplicate-`t` observation
used to choose an otherwise-unspecified equal-key tie-breaker is an oracle
diagnostic only, never a production fallback.

## Injected-data ABI

The new module accepts an explicit `IntlLocaleCanonicalizationData` record.
It must be ordinary, immutable data supplied by a later generated TypeScript
table, not a file path or a runtime JSON import. Its minimum stable shape is:

```ts
interface IntlLocaleAliasTable {
  readonly language: Readonly<Record<string, LocaleAliasEntry>>;
  readonly script: Readonly<Record<string, LocaleAliasEntry>>;
  readonly region: Readonly<Record<string, LocaleAliasEntry>>;
  readonly variant: Readonly<Record<string, LocaleAliasEntry>>;
}

interface IntlUnicodeExtensionKey {
  readonly aliases: readonly string[];
  readonly preferred: string | null;
  readonly typeAliases: Readonly<Record<string, string>>;
  readonly types: Readonly<Record<string, { readonly aliases: readonly string[]; readonly preferred: string | null }>>;
}

interface IntlTransformedExtensionField {
  readonly aliases: readonly string[];
  readonly preferred: string | null;
  readonly valueAliases: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, { readonly aliases: readonly string[]; readonly preferred: string | null }>>;
}

interface IntlLocaleCanonicalizationData {
  readonly schemaVersion: 1;
  readonly localeAliases: IntlLocaleAliasTable;
  readonly likelySubtags: Readonly<Record<string, string>>;
  readonly unicodeExtension: {
    readonly keyAliases: Readonly<Record<string, string>>;
    readonly keys: Readonly<Record<string, IntlUnicodeExtensionKey>>;
  };
  readonly transformedExtension: {
    readonly fields: Readonly<Record<string, IntlTransformedExtensionField>>;
  };
}
```

The implementation may make the individual records narrower after it validates
the #6427 schema in a focused test, but it must not bake names such as `iw`,
`islamicc`, or a test locale into production logic. A validation/normalization
entry point will fail closed on an unsupported schema version, non-ASCII or
malformed keys/replacements, conflicting aliases, and alias cycles. Data
validation errors are distinct from invalid user locale input so a later
native wrapper can turn user input into the required RangeError-like result
without disguising a corrupt pinned table as a user error.

The module does not consult `availableLocales`; a language tag is not invalid
because a formatter cannot serve it. It does consume injected `likelySubtags`
only when an alias has multiple replacement regions: UTS #35 chooses the
candidate matching the likely language/script region, then the first
replacement. That data is canonicalization metadata, not a locale availability
filter.

### Data-emission prerequisite

PR #6427 currently proves deterministic, pinned JSON generation only. It
contains locale aliases, likely subtags, and `u`-extension key/type metadata,
but it does not yet ingest CLDR BCP 47 transformed-extension (`t` field/value)
metadata. Before this kernel can participate in compiled standalone behavior,
a separate follow-up must add the missing pinned transformed-extension input
and emit an audited, deterministic `src`-consumable table with the same source
release, input hashes, license provenance, ordering, and whole-input drift
checks. It must version the emitted table when this contract changes. That
follow-up owns the generator/assets and must be coordinated after #6427 lands.
This issue will only prove the injected interface with small in-test records;
it will not claim an unreachable parser is a completed API.

## Implementation plan

1. Add `intl-locale-canonicalization.ts` as a pure TypeScript semantic kernel.
   Use ASCII-only predicates and explicit parsing state rather than host Intl
   or a regular-expression black box. Expose a structural parse result,
   `isWellFormedUnicodeBcp47LocaleIdentifier`, data validation, and a
   `canonicalizeUnicodeLocaleIdentifier(input, data)` operation. Keep the
   module free of Node, filesystem, evaluator, and object-runtime imports.
2. Preserve parsed components long enough to apply aliases generically. Alias
   replacements may contain more than one subtag, so reparse/reconcile them
   through the same grammar with cycle detection rather than substituting one
   special-case string. Apply ASCII case rules consistently: lower-case
   language/variants/extensions, title-case script, and upper-case region.
3. Canonicalize `u` keys through generic injected key aliases and key-specific
   type aliases/preferred data, retaining the first canonical keyword key and
   the specification's ordering. Canonicalize `t` language and every field
   component through the same parser/case/alias machinery plus injected
   transformed-field/value metadata; repeated canonical `t` keys remain
   distinct fields and are deterministically ordered by key, then their
   canonical serialized value. For multi-target region aliases, select through
   `likelySubtags`; do not use the input's existing region or fixture-specific
   logic. Do not infer data values from fixture names.
4. Add focused unit tests using a deliberately miniature injected schema.
   The tests cover valid, uncommon grammar shapes; invalid grammar; generic
   language/region/variant aliases; repeated `u` keyword retention; repeated
   `t` fields and their metadata-derived order; `u` key/type aliases and
   preferred forms; absent locale availability; malformed data/cycles; and
   stable output. They do not import or use host `Intl` as an oracle and make
   no standalone compiler claim.
5. Before any integration claim, hand off the exact public API dependencies:
   a single identity-stable `%Intl%` namespace/property/closure route;
   generic `CanonicalizeLocaleList` iteration with observable `HasProperty`,
   `Get`, `ToString`, duplicate removal and RangeError ordering; native
   `ToObject`/`Intl.Locale` handling; and a source-emitted pinned data table.
   Those remain owned by their current maintainers and require fresh overlap
   clearance.

## Relationship to the four frozen getCanonicalLocales originals

The frozen originals are:

- `test/intl402/Intl/getCanonicalLocales/error-cases.js`;
- `test/intl402/Intl/getCanonicalLocales/has-property.js`;
- `test/intl402/Intl/getCanonicalLocales/locales-is-not-a-string.js`; and
- `test/intl402/Intl/getCanonicalLocales/overriden-arg-length.js`.

This kernel supplies only a future final-string operation. It cannot itself
observe `HasProperty` before `Get`, box primitive or inherited array-like
inputs, honour list length mutation/overrides, preserve namespace/callable
identity, or make a native error visible. A future integration must prove all
four untouched originals in maintained standalone execution plus generic
proxy, getter, list de-duplication, alias, `Intl.Locale`, and error-order
controls. It must then rerun the full 74-row Intl cohort and unchanged
11,778-path corpus with complete accounting.

## Acceptance for this bounded prerequisite

- [ ] The new semantic module has no host `Intl`, host import, evaluator, file
      system, or locale-availability dependency.
- [ ] It accepts an injected, validated generic data schema and uses aliases
      and extension metadata by table lookup, not source-level locale-name
      heuristics.
- [ ] Focused tests exercise grammar and metadata semantics beyond the four
      frozen originals, including `u` and `t` extensions and malformed data.
- [ ] A valid but unavailable/invented language is not rejected by locale
      availability filtering.
- [ ] The plan records the generated-source, namespace/closure, generic
      `ToObject`, and list-iteration prerequisites rather than claiming a
      public API or Test262 credit.
- [ ] Any later integration runs the four original files, then the full
      74-row Intl cohort and frozen 11,778-path manifest with complete
      accounting. This issue remains incomplete until the bounded kernel's
      tests and normal repository gates are run under a granted validation
      lease.

## Validation receipt (2026-10-02)

Validation used Node `v24.19.0`, pnpm `10.30.2`, and a symlink-only dependency
tree verified to contain Vitest, Prettier, and TypeScript 7. No dependency was
installed or changed.

- Focused direct Vitest: one registered root test file,
  `tests/issue-6809-intl-locale-canonicalization.test.ts`; six assertions
  passed, zero failed. The single-fork JSON receipt is
  `.tmp/issue-6809-intl-locale-canonicalization-20261002-0907/focused-vitest.json`.
- `pnpm run typecheck` (the TS7 configuration) passed.
- `pnpm run format:check` passed after Prettier made formatting-only changes
  to the two owned TypeScript files.
- `pnpm run check:loc-budget` passed for the new source file (`+1046` LOC),
  and `pnpm run check:func-budget` passed.
- Supplemental `pnpm run check:godfiles` exited 1 on 47 pre-existing profile
  regressions in held/shared `calls.ts`, `index.ts`, `object-runtime.ts`,
  `array-methods.ts`, and `native-strings.ts`. It reported no #6809 file.
  This failure is retained as an unrelated workspace diagnostic, not bypassed
  or attributed to this kernel.

These are pure-module results only. They do not exercise a compiled Intl
namespace, `Intl.getCanonicalLocales`, any Test262 original, or the 74-row
Intl cohort.

## Handoff

The next integration owner must consume the same injected-data contract from a
pinned generated source table, not reimplement aliases in a namespace shim.
It must coordinate the held identifier/static-call/array-like/object-runtime
surfaces before editing them. No claim in this record changes #6717's broader
completion status.

Inventory note: `src/codegen/intl-locale-canonicalization.ts` is recorded as
`unmigrated` migration debt targeting `backend-wasmgc`. The module is a pure,
data-injected kernel with no imports, but it is not a clean-layer activation:
there is still no generated source table, `%Intl%` route, generic locale-list
semantics, or native error exposure. This record only accounts for the new
module in the compiler-boundaries inventory; it grants no public API, runtime,
or Test262 completion credit.
