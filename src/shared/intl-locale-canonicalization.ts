/**
 * A host-free semantic kernel for the locale identifier portion of a future
 * standalone Intl.getCanonicalLocales implementation.
 *
 * This module deliberately does not expose Intl, import locale JSON, or use
 * host Intl. A future emitter must provide the same pinned data through
 * IntlLocaleCanonicalizationData and lower this contract to user-visible Wasm
 * operations with the required ToObject and list-observation semantics.
 */

export class IntlLocaleSyntaxError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "IntlLocaleSyntaxError";
  }
}

export class IntlLocaleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntlLocaleDataError";
  }
}

export interface IntlLocaleAliasEntry {
  readonly reason?: string;
  readonly replacement: string;
}

export interface IntlLocaleAliasTable {
  readonly language: Readonly<Record<string, IntlLocaleAliasEntry>>;
  readonly script: Readonly<Record<string, IntlLocaleAliasEntry>>;
  readonly region: Readonly<Record<string, IntlLocaleAliasEntry>>;
  readonly variant: Readonly<Record<string, IntlLocaleAliasEntry>>;
}

export interface IntlLocaleExtensionValue {
  readonly aliases: readonly string[];
  readonly preferred: string | null;
}

export interface IntlUnicodeExtensionKey {
  readonly aliases: readonly string[];
  readonly preferred: string | null;
  readonly typeAliases: Readonly<Record<string, string>>;
  readonly types: Readonly<Record<string, IntlLocaleExtensionValue>>;
}

export interface IntlTransformedExtensionField {
  readonly aliases: readonly string[];
  readonly preferred: string | null;
  readonly valueAliases: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, IntlLocaleExtensionValue>>;
}

/**
 * The data boundary is intentionally independent from any JSON asset. The
 * generator follow-up will emit this schema as source after it adds pinned
 * transformed-extension data alongside the existing aliases, likely subtags,
 * and Unicode-extension inputs.
 */
export interface IntlLocaleCanonicalizationData {
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

export interface ParsedLanguageIdentifier {
  readonly language: string;
  readonly script: string | undefined;
  readonly region: string | undefined;
  readonly variants: readonly string[];
}

export interface ParsedUnicodeExtension {
  readonly kind: "unicode";
  readonly singleton: "u";
  readonly attributes: readonly string[];
  readonly keywords: readonly ParsedExtensionField[];
}

export interface ParsedTransformedExtension {
  readonly kind: "transformed";
  readonly singleton: "t";
  readonly language: ParsedLanguageIdentifier | undefined;
  readonly fields: readonly ParsedExtensionField[];
}

export interface ParsedOtherExtension {
  readonly kind: "other";
  readonly singleton: string;
  readonly subtags: readonly string[];
}

export interface ParsedExtensionField {
  readonly key: string;
  readonly value: readonly string[];
}

export type ParsedLocaleExtension = ParsedUnicodeExtension | ParsedTransformedExtension | ParsedOtherExtension;

export interface ParsedUnicodeBcp47LocaleIdentifier extends ParsedLanguageIdentifier {
  readonly extensions: readonly ParsedLocaleExtension[];
  readonly privateUse: readonly string[] | undefined;
}

interface MutableLanguageIdentifier {
  language: string;
  script: string | undefined;
  region: string | undefined;
  variants: string[];
}

interface MutableUnicodeExtension {
  kind: "unicode";
  singleton: "u";
  attributes: string[];
  keywords: MutableExtensionField[];
}

interface MutableTransformedExtension {
  kind: "transformed";
  singleton: "t";
  language: MutableLanguageIdentifier | undefined;
  fields: MutableExtensionField[];
}

interface MutableOtherExtension {
  kind: "other";
  singleton: string;
  subtags: string[];
}

interface MutableExtensionField {
  key: string;
  value: string[];
}

type MutableLocaleExtension = MutableUnicodeExtension | MutableTransformedExtension | MutableOtherExtension;

interface MutableLocaleIdentifier extends MutableLanguageIdentifier {
  extensions: MutableLocaleExtension[];
  privateUse: string[] | undefined;
}

const MAX_ALIAS_REWRITES = 64;

function syntaxError(message: string): never {
  throw new IntlLocaleSyntaxError(message);
}

function dataError(message: string): never {
  throw new IntlLocaleDataError(message);
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiAlphanumericCode(code: number): boolean {
  return isAsciiAlphaCode(code) || isAsciiDigitCode(code);
}

function isAsciiAlpha(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (!isAsciiAlphaCode(value.charCodeAt(index))) return false;
  }
  return true;
}

function isAsciiAlphanumeric(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (!isAsciiAlphanumericCode(value.charCodeAt(index))) return false;
  }
  return true;
}

function asciiLower(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    result += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[index];
  }
  return result;
}

function asciiUpper(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    result += code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : value[index];
  }
  return result;
}

function asciiTitle(value: string): string {
  if (value.length === 0) return value;
  return asciiUpper(value.slice(0, 1)) + asciiLower(value.slice(1));
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ECMA-402 accepts repeated transformed keys. Keep each field and use its
// canonical serialized value as a deterministic tie-breaker for equal keys.
function compareExtensionFields(left: MutableExtensionField, right: MutableExtensionField): number {
  const keyOrder = compareAscii(left.key, right.key);
  if (keyOrder !== 0) return keyOrder;
  return compareAscii(left.value.join("-"), right.value.join("-"));
}

function isLanguageSubtag(value: string): boolean {
  return isAsciiAlpha(value) && (value.length === 2 || value.length === 3 || (value.length >= 5 && value.length <= 8));
}

function isScriptSubtag(value: string): boolean {
  return value.length === 4 && isAsciiAlpha(value);
}

function isRegionSubtag(value: string): boolean {
  if (value.length === 2) return isAsciiAlpha(value);
  if (value.length !== 3) return false;
  for (let index = 0; index < value.length; index++) {
    if (!isAsciiDigitCode(value.charCodeAt(index))) return false;
  }
  return true;
}

function isVariantSubtag(value: string): boolean {
  if (!isAsciiAlphanumeric(value)) return false;
  return (value.length >= 5 && value.length <= 8) || (value.length === 4 && isAsciiDigitCode(value.charCodeAt(0)));
}

function isSingleton(value: string): boolean {
  return value.length === 1 && isAsciiAlphanumeric(value);
}

function isUnicodeKey(value: string): boolean {
  return value.length === 2 && isAsciiAlphanumericCode(value.charCodeAt(0)) && isAsciiAlphaCode(value.charCodeAt(1));
}

function isTransformedKey(value: string): boolean {
  return value.length === 2 && isAsciiAlphaCode(value.charCodeAt(0)) && isAsciiDigitCode(value.charCodeAt(1));
}

function isUnicodeAttribute(value: string): boolean {
  return value.length >= 3 && value.length <= 8 && isAsciiAlphanumeric(value);
}

function isExtensionValue(value: string): boolean {
  return value.length >= 3 && value.length <= 8 && isAsciiAlphanumeric(value);
}

function isOtherExtensionSubtag(value: string): boolean {
  return value.length >= 2 && value.length <= 8 && isAsciiAlphanumeric(value);
}

function normalizeInput(input: string): string[] {
  if (input.length === 0) syntaxError("locale identifier must not be empty");
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code !== 0x2d && !isAsciiAlphanumericCode(code)) {
      syntaxError("locale identifier must use ASCII alphanumeric subtags separated by hyphens");
    }
  }
  const subtags = asciiLower(input).split("-");
  if (subtags.some((subtag) => subtag.length === 0)) syntaxError("locale identifier contains an empty subtag");
  return subtags;
}

function copyLanguageIdentifier(
  identifier: ParsedLanguageIdentifier | MutableLanguageIdentifier,
): MutableLanguageIdentifier {
  return {
    language: identifier.language,
    script: identifier.script,
    region: identifier.region,
    variants: [...identifier.variants],
  };
}

function copyLocaleExtension(extension: ParsedLocaleExtension): MutableLocaleExtension {
  if (extension.kind === "unicode") {
    return {
      kind: "unicode",
      singleton: "u",
      attributes: [...extension.attributes],
      keywords: extension.keywords.map((keyword) => ({ key: keyword.key, value: [...keyword.value] })),
    };
  }
  if (extension.kind === "transformed") {
    return {
      kind: "transformed",
      singleton: "t",
      language: extension.language === undefined ? undefined : copyLanguageIdentifier(extension.language),
      fields: extension.fields.map((field) => ({ key: field.key, value: [...field.value] })),
    };
  }
  return {
    kind: "other",
    singleton: extension.singleton,
    subtags: [...extension.subtags],
  };
}

function parseLanguageIdentifier(
  subtags: readonly string[],
  start: number,
  label: string,
): [MutableLanguageIdentifier, number] {
  const language = subtags[start];
  if (language === undefined || !isLanguageSubtag(language))
    syntaxError(`${label} must start with a Unicode BCP 47 language subtag`);

  let index = start + 1;
  let script: string | undefined;
  let region: string | undefined;
  if (isScriptSubtag(subtags[index] ?? "")) {
    script = subtags[index++];
  }
  if (isRegionSubtag(subtags[index] ?? "")) {
    region = subtags[index++];
  }

  const variants: string[] = [];
  const seenVariants = new Set<string>();
  while (isVariantSubtag(subtags[index] ?? "")) {
    const variant = subtags[index++];
    if (seenVariants.has(variant)) syntaxError(`${label} contains a duplicate variant ${JSON.stringify(variant)}`);
    seenVariants.add(variant);
    variants.push(variant);
  }
  return [{ language, script, region, variants }, index];
}

function extensionEnd(subtags: readonly string[], start: number): number {
  let index = start;
  while (index < subtags.length && !isSingleton(subtags[index])) index++;
  return index;
}

function parseUnicodeExtension(subtags: readonly string[]): MutableUnicodeExtension {
  let index = 0;
  const attributes: string[] = [];
  while (index < subtags.length && !isUnicodeKey(subtags[index])) {
    const attribute = subtags[index++];
    if (!isUnicodeAttribute(attribute)) syntaxError(`invalid Unicode extension attribute ${JSON.stringify(attribute)}`);
    attributes.push(attribute);
  }

  const keywords: MutableExtensionField[] = [];
  while (index < subtags.length) {
    const key = subtags[index++];
    if (!isUnicodeKey(key)) syntaxError(`invalid Unicode extension key ${JSON.stringify(key)}`);

    const value: string[] = [];
    while (index < subtags.length && !isUnicodeKey(subtags[index])) {
      const subtag = subtags[index++];
      if (!isExtensionValue(subtag)) syntaxError(`invalid Unicode extension value ${JSON.stringify(subtag)}`);
      value.push(subtag);
    }
    keywords.push({ key, value });
  }

  if (attributes.length === 0 && keywords.length === 0)
    syntaxError("Unicode extension must contain an attribute or keyword");
  return { kind: "unicode", singleton: "u", attributes, keywords };
}

function parseTransformedExtension(subtags: readonly string[]): MutableTransformedExtension {
  if (subtags.length === 0) syntaxError("transformed extension must not be empty");

  let index = 0;
  let language: MutableLanguageIdentifier | undefined;
  if (!isTransformedKey(subtags[0])) {
    [language, index] = parseLanguageIdentifier(subtags, 0, "transformed language");
  }

  const fields: MutableExtensionField[] = [];
  while (index < subtags.length) {
    const key = subtags[index++];
    if (!isTransformedKey(key)) syntaxError(`invalid transformed extension key ${JSON.stringify(key)}`);

    const value: string[] = [];
    while (index < subtags.length && !isTransformedKey(subtags[index])) {
      const subtag = subtags[index++];
      if (!isExtensionValue(subtag)) syntaxError(`invalid transformed extension value ${JSON.stringify(subtag)}`);
      value.push(subtag);
    }
    if (value.length === 0) syntaxError(`transformed extension key ${JSON.stringify(key)} requires a value`);
    fields.push({ key, value });
  }

  if (language === undefined && fields.length === 0)
    syntaxError("transformed extension must contain a language or field");
  return { kind: "transformed", singleton: "t", language, fields };
}

function parseOtherExtension(singleton: string, subtags: readonly string[]): MutableOtherExtension {
  if (subtags.length === 0) syntaxError(`extension ${JSON.stringify(singleton)} must not be empty`);
  for (const subtag of subtags) {
    if (!isOtherExtensionSubtag(subtag)) syntaxError(`invalid extension subtag ${JSON.stringify(subtag)}`);
  }
  return { kind: "other", singleton, subtags: [...subtags] };
}

/** Parses one Unicode BCP 47 locale identifier without consulting locale data. */
export function parseUnicodeBcp47LocaleIdentifier(input: string): ParsedUnicodeBcp47LocaleIdentifier {
  const subtags = normalizeInput(input);
  const [languageIdentifier, afterLanguage] = parseLanguageIdentifier(subtags, 0, "locale identifier");
  let index = afterLanguage;
  const extensions: MutableLocaleExtension[] = [];
  const seenSingletons = new Set<string>();
  let privateUse: string[] | undefined;

  while (index < subtags.length) {
    const singleton = subtags[index++];
    if (!isSingleton(singleton)) syntaxError(`unexpected locale subtag ${JSON.stringify(singleton)}`);
    if (singleton === "x") {
      if (index === subtags.length) syntaxError("private-use extension requires at least one subtag");
      privateUse = [];
      while (index < subtags.length) {
        const subtag = subtags[index++];
        if (subtag.length < 1 || subtag.length > 8 || !isAsciiAlphanumeric(subtag)) {
          syntaxError(`invalid private-use subtag ${JSON.stringify(subtag)}`);
        }
        privateUse.push(subtag);
      }
      break;
    }
    if (seenSingletons.has(singleton)) syntaxError(`duplicate locale extension singleton ${JSON.stringify(singleton)}`);
    seenSingletons.add(singleton);

    const end = extensionEnd(subtags, index);
    const extensionSubtags = subtags.slice(index, end);
    index = end;
    if (singleton === "u") {
      extensions.push(parseUnicodeExtension(extensionSubtags));
    } else if (singleton === "t") {
      extensions.push(parseTransformedExtension(extensionSubtags));
    } else {
      extensions.push(parseOtherExtension(singleton, extensionSubtags));
    }
  }

  return {
    ...languageIdentifier,
    extensions,
    privateUse,
  };
}

/** Returns false only for user-locale syntax errors; corrupt data is irrelevant here. */
export function isWellFormedUnicodeBcp47LocaleIdentifier(input: string): boolean {
  try {
    parseUnicodeBcp47LocaleIdentifier(input);
    return true;
  } catch (error) {
    if (error instanceof IntlLocaleSyntaxError) return false;
    throw error;
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    dataError(`${label} must be an object record`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") dataError(`${label} must be a string`);
  return value;
}

function asStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    dataError(`${label} must be an array of strings`);
  return value;
}

function isDataTokenSequence(value: string, allowSpaces: boolean): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x2d || (allowSpaces && code === 0x20) || isAsciiAlphanumericCode(code)) continue;
    return false;
  }
  return true;
}

function validateAliasEntry(value: unknown, label: string): void {
  const entry = asRecord(value, label);
  const replacement = asString(entry.replacement, `${label}.replacement`);
  if (!isDataTokenSequence(replacement, true)) dataError(`${label}.replacement has unsupported syntax`);
  if (entry.reason !== undefined) asString(entry.reason, `${label}.reason`);
}

function validateAliasTable(value: unknown, label: string): void {
  const table = asRecord(value, label);
  for (const [alias, entry] of Object.entries(table)) {
    if (!isDataTokenSequence(alias, false))
      dataError(`${label} contains an unsupported alias key ${JSON.stringify(alias)}`);
    validateAliasEntry(entry, `${label}.${alias}`);
  }
}

function validateExtensionValue(value: unknown, label: string): void {
  const entry = asRecord(value, label);
  const aliases = asStringArray(entry.aliases, `${label}.aliases`);
  for (const alias of aliases) {
    if (!isDataTokenSequence(alias, false)) dataError(`${label}.aliases contains unsupported syntax`);
  }
  if (entry.preferred !== null && typeof entry.preferred !== "string")
    dataError(`${label}.preferred must be a string or null`);
  if (typeof entry.preferred === "string" && !isDataTokenSequence(entry.preferred, false)) {
    dataError(`${label}.preferred has unsupported syntax`);
  }
}

function validateExtensionKey(value: unknown, label: string, transformed: boolean): void {
  const entry = asRecord(value, label);
  const aliases = asStringArray(entry.aliases, `${label}.aliases`);
  for (const alias of aliases) {
    if (!isDataTokenSequence(alias, false)) dataError(`${label}.aliases contains unsupported syntax`);
  }
  if (entry.preferred !== null && typeof entry.preferred !== "string")
    dataError(`${label}.preferred must be a string or null`);
  if (
    typeof entry.preferred === "string" &&
    !(transformed ? isTransformedKey(asciiLower(entry.preferred)) : isUnicodeKey(asciiLower(entry.preferred)))
  ) {
    dataError(`${label}.preferred has an invalid extension key`);
  }

  const aliasesField = transformed ? "valueAliases" : "typeAliases";
  const aliasTable = asRecord(entry[aliasesField], `${label}.${aliasesField}`);
  for (const [alias, target] of Object.entries(aliasTable)) {
    if (
      !isDataTokenSequence(alias, false) ||
      !isDataTokenSequence(asString(target, `${label}.${aliasesField}.${alias}`), false)
    ) {
      dataError(`${label}.${aliasesField} has unsupported syntax`);
    }
  }
  const valueField = transformed ? "values" : "types";
  const values = asRecord(entry[valueField], `${label}.${valueField}`);
  const canonicalValues = new Map<string, { preferred: string | null; source: string }>();
  for (const [name, descriptor] of Object.entries(values)) {
    if (!isDataTokenSequence(name, false)) dataError(`${label}.${valueField} contains an unsupported value`);
    validateExtensionValue(descriptor, `${label}.${valueField}.${name}`);
    const descriptorRecord = asRecord(descriptor, `${label}.${valueField}.${name}`);
    const preferred =
      descriptorRecord.preferred === null
        ? null
        : asciiLower(asString(descriptorRecord.preferred, `${label}.${valueField}.${name}.preferred`));
    canonicalValues.set(asciiLower(name), { preferred, source: name });
  }

  const resolvedAliases = new Map<string, string>();
  const registerAlias = (alias: string, target: string, source: string): void => {
    const normalizedAlias = asciiLower(alias);
    const normalizedTarget = asciiLower(target);
    const targetDescriptor = canonicalValues.get(normalizedTarget);
    if (targetDescriptor === undefined)
      dataError(`${source} targets unknown ${valueField} value ${JSON.stringify(target)}`);
    const canonicalAlias = canonicalValues.get(normalizedAlias);
    if (
      canonicalAlias !== undefined &&
      normalizedAlias !== normalizedTarget &&
      canonicalAlias.preferred !== normalizedTarget
    ) {
      dataError(`${source} conflicts with canonical ${valueField} value ${JSON.stringify(canonicalAlias.source)}`);
    }
    const previous = resolvedAliases.get(normalizedAlias);
    if (previous !== undefined && previous !== normalizedTarget) {
      dataError(`${source} conflicts with an earlier alias target ${JSON.stringify(previous)}`);
    }
    resolvedAliases.set(normalizedAlias, normalizedTarget);
  };

  for (const [alias, target] of Object.entries(aliasTable)) {
    registerAlias(alias, asString(target, `${label}.${aliasesField}.${alias}`), `${label}.${aliasesField}.${alias}`);
  }
  for (const [name, descriptor] of Object.entries(values)) {
    const descriptorRecord = asRecord(descriptor, `${label}.${valueField}.${name}`);
    const preferred =
      descriptorRecord.preferred === null
        ? name
        : asString(descriptorRecord.preferred, `${label}.${valueField}.${name}.preferred`);
    if (descriptorRecord.preferred !== null && !canonicalValues.has(asciiLower(preferred))) {
      dataError(`${label}.${valueField}.${name}.preferred targets an unknown ${valueField} value`);
    }
    for (const alias of asStringArray(descriptorRecord.aliases, `${label}.${valueField}.${name}.aliases`)) {
      registerAlias(alias, preferred, `${label}.${valueField}.${name}.aliases`);
    }
  }
}

function lookupCaseInsensitive<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  const direct = record[key];
  if (direct !== undefined && Object.hasOwn(record, key)) return direct;
  const normalized = asciiLower(key);
  for (const candidate of Object.keys(record)) {
    if (asciiLower(candidate) === normalized) return record[candidate];
  }
  return undefined;
}

function assertSimpleLanguageCycles(languageAliases: Readonly<Record<string, IntlLocaleAliasEntry>>): void {
  for (const alias of Object.keys(languageAliases)) {
    const normalizedAlias = asciiLower(alias);
    if (!isLanguageSubtag(normalizedAlias)) continue;
    const seen = new Set<string>();
    let current = normalizedAlias;
    for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
      if (seen.has(current)) dataError(`language alias cycle includes ${JSON.stringify(current)}`);
      seen.add(current);
      const entry = lookupCaseInsensitive(languageAliases, current);
      if (entry === undefined) break;
      const replacement = asciiLower(entry.replacement);
      if (!isLanguageSubtag(replacement)) break;
      current = replacement;
    }
  }
}

/**
 * Validates an injected table without reaching into a file, host Intl, or a
 * generated asset. The future source-table emitter should call this once when
 * materializing its immutable table.
 */
export function validateIntlLocaleCanonicalizationData(data: IntlLocaleCanonicalizationData): void {
  const root = asRecord(data, "locale canonicalization data");
  if (root.schemaVersion !== 1) dataError("locale canonicalization data has an unsupported schema version");

  const aliases = asRecord(root.localeAliases, "locale canonicalization data.localeAliases");
  for (const kind of ["language", "script", "region", "variant"] as const) {
    validateAliasTable(aliases[kind], `locale canonicalization data.localeAliases.${kind}`);
  }
  assertSimpleLanguageCycles(data.localeAliases.language);

  const likelySubtags = asRecord(root.likelySubtags, "locale canonicalization data.likelySubtags");
  for (const [from, to] of Object.entries(likelySubtags)) {
    if (
      !isDataTokenSequence(from, false) ||
      !isDataTokenSequence(asString(to, `locale canonicalization data.likelySubtags.${from}`), false)
    ) {
      dataError("locale canonicalization data.likelySubtags has unsupported syntax");
    }
  }

  const unicode = asRecord(root.unicodeExtension, "locale canonicalization data.unicodeExtension");
  const keyAliases = asRecord(unicode.keyAliases, "locale canonicalization data.unicodeExtension.keyAliases");
  const unicodeKeys = asRecord(unicode.keys, "locale canonicalization data.unicodeExtension.keys");
  for (const [alias, key] of Object.entries(keyAliases)) {
    const canonicalKey = asString(key, `locale canonicalization data.unicodeExtension.keyAliases.${alias}`);
    if (!isDataTokenSequence(alias, false) || !isUnicodeKey(asciiLower(canonicalKey))) {
      dataError("locale canonicalization data.unicodeExtension.keyAliases has unsupported syntax");
    }
    if (lookupCaseInsensitive(data.unicodeExtension.keys, canonicalKey) === undefined) {
      dataError(`locale canonicalization data.unicodeExtension.keyAliases.${alias} targets an unknown Unicode key`);
    }
  }
  for (const [key, descriptor] of Object.entries(unicodeKeys)) {
    if (!isUnicodeKey(asciiLower(key)))
      dataError(`locale canonicalization data contains invalid Unicode key ${JSON.stringify(key)}`);
    validateExtensionKey(descriptor, `locale canonicalization data.unicodeExtension.keys.${key}`, false);
  }

  const transformed = asRecord(root.transformedExtension, "locale canonicalization data.transformedExtension");
  const fields = asRecord(transformed.fields, "locale canonicalization data.transformedExtension.fields");
  for (const [key, descriptor] of Object.entries(fields)) {
    if (!isTransformedKey(asciiLower(key)))
      dataError(`locale canonicalization data contains invalid transformed key ${JSON.stringify(key)}`);
    validateExtensionKey(descriptor, `locale canonicalization data.transformedExtension.fields.${key}`, true);
  }
}

function serializeLanguageKey(identifier: ParsedLanguageIdentifier | MutableLanguageIdentifier): string {
  return [identifier.language, identifier.script, identifier.region, ...identifier.variants]
    .filter((subtag): subtag is string => subtag !== undefined)
    .map(asciiLower)
    .join("-");
}

function parseDataLanguageReplacement(replacement: string, label: string): MutableLanguageIdentifier {
  if (replacement.includes(" ")) dataError(`${label} cannot use a multi-target replacement as a language identifier`);
  let parsed: ParsedUnicodeBcp47LocaleIdentifier;
  try {
    parsed = parseUnicodeBcp47LocaleIdentifier(replacement);
  } catch (error) {
    if (error instanceof IntlLocaleSyntaxError)
      dataError(`${label} is not a valid locale replacement: ${error.message}`);
    throw error;
  }
  if (parsed.extensions.length !== 0 || parsed.privateUse !== undefined)
    dataError(`${label} cannot add locale extensions or private use`);
  return copyLanguageIdentifier(parsed);
}

function mergeLanguageReplacement(
  current: MutableLanguageIdentifier,
  replacement: MutableLanguageIdentifier,
): MutableLanguageIdentifier {
  const variants = [...current.variants];
  for (const variant of replacement.variants) {
    if (!variants.includes(variant)) variants.push(variant);
  }
  return {
    language: replacement.language,
    script: current.script ?? replacement.script,
    region: current.region ?? replacement.region,
    variants,
  };
}

function canonicalizeLanguageAlias(
  identifier: MutableLanguageIdentifier,
  data: IntlLocaleCanonicalizationData,
): MutableLanguageIdentifier {
  let current = copyLanguageIdentifier(identifier);
  const seen = new Set<string>();
  for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
    const fullKey = serializeLanguageKey(current);
    if (seen.has(fullKey)) dataError(`language alias cycle includes ${JSON.stringify(fullKey)}`);
    seen.add(fullKey);

    const fullAlias = lookupCaseInsensitive(data.localeAliases.language, fullKey);
    if (fullAlias !== undefined) {
      current = parseDataLanguageReplacement(fullAlias.replacement, `language alias ${JSON.stringify(fullKey)}`);
      continue;
    }
    const languageAlias = lookupCaseInsensitive(data.localeAliases.language, current.language);
    if (languageAlias === undefined) return current;
    const replacement = parseDataLanguageReplacement(
      languageAlias.replacement,
      `language alias ${JSON.stringify(current.language)}`,
    );
    current = mergeLanguageReplacement(current, replacement);
  }
  dataError("language alias rewrite limit exceeded");
}

function canonicalizeScript(script: string | undefined, data: IntlLocaleCanonicalizationData): string | undefined {
  if (script === undefined) return undefined;
  const seen = new Set<string>();
  let current = script;
  for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
    const normalized = asciiLower(current);
    if (seen.has(normalized)) dataError(`script alias cycle includes ${JSON.stringify(normalized)}`);
    seen.add(normalized);
    const alias = lookupCaseInsensitive(data.localeAliases.script, normalized);
    if (alias === undefined) return normalized;
    const replacement = asciiLower(alias.replacement);
    if (!isScriptSubtag(replacement))
      dataError(`script alias ${JSON.stringify(normalized)} has an invalid replacement`);
    current = replacement;
  }
  dataError("script alias rewrite limit exceeded");
}

function likelyRegion(identifier: MutableLanguageIdentifier, data: IntlLocaleCanonicalizationData): string | undefined {
  const language = asciiLower(identifier.language);
  const script = identifier.script === undefined ? undefined : asciiTitle(identifier.script);
  const candidates =
    script === undefined ? [language, "und"] : [`${language}-${script}`, language, `und-${script}`, "und"];
  for (const candidate of candidates) {
    const value = lookupCaseInsensitive(data.likelySubtags, candidate);
    if (value === undefined) continue;
    return parseDataLanguageReplacement(value, `likely-subtag ${JSON.stringify(candidate)}`).region;
  }
  return undefined;
}

function replacementRegions(value: string, label: string): string[] {
  const regions = value
    .split(" ")
    .filter((part) => part.length !== 0)
    .map(asciiLower);
  if (regions.length === 0 || regions.some((region) => !isRegionSubtag(region))) {
    dataError(`${label} has an invalid region replacement`);
  }
  return regions;
}

function canonicalizeRegion(
  identifier: MutableLanguageIdentifier,
  data: IntlLocaleCanonicalizationData,
): string | undefined {
  if (identifier.region === undefined) return undefined;
  const seen = new Set<string>();
  let current = identifier.region;
  for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
    const normalized = asciiLower(current);
    if (seen.has(normalized)) dataError(`region alias cycle includes ${JSON.stringify(normalized)}`);
    seen.add(normalized);
    const alias = lookupCaseInsensitive(data.localeAliases.region, normalized);
    if (alias === undefined) return normalized;
    const candidates = replacementRegions(alias.replacement, `region alias ${JSON.stringify(normalized)}`);
    const likely = likelyRegion(identifier, data);
    current = candidates.find((candidate) => candidate === likely) ?? candidates[0];
  }
  dataError("region alias rewrite limit exceeded");
}

function canonicalizeVariants(variants: readonly string[], data: IntlLocaleCanonicalizationData): string[] {
  const output: string[] = [];
  for (const variant of variants) {
    const seen = new Set<string>();
    let current = variant;
    for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
      const normalized = asciiLower(current);
      if (seen.has(normalized)) dataError(`variant alias cycle includes ${JSON.stringify(normalized)}`);
      seen.add(normalized);
      const alias = lookupCaseInsensitive(data.localeAliases.variant, normalized);
      if (alias === undefined) break;
      const replacement = asciiLower(alias.replacement);
      if (!isVariantSubtag(replacement))
        dataError(`variant alias ${JSON.stringify(normalized)} has an invalid replacement`);
      current = replacement;
    }
    if (!output.includes(current)) output.push(current);
  }
  return output.sort(compareAscii);
}

function canonicalizeLanguageIdentifier(
  identifier: ParsedLanguageIdentifier | MutableLanguageIdentifier,
  data: IntlLocaleCanonicalizationData,
): MutableLanguageIdentifier {
  const aliased = canonicalizeLanguageAlias(copyLanguageIdentifier(identifier), data);
  const script = canonicalizeScript(aliased.script, data);
  const withScript = { ...aliased, script };
  const region = canonicalizeRegion(withScript, data);
  return {
    language: asciiLower(withScript.language),
    script,
    region,
    variants: canonicalizeVariants(withScript.variants, data),
  };
}

function keyDescriptor<T extends { readonly aliases: readonly string[]; readonly preferred: string | null }>(
  key: string,
  aliases: Readonly<Record<string, string>>,
  descriptors: Readonly<Record<string, T>>,
  transformed: boolean,
): [string, T | undefined] {
  const keyPredicate = transformed ? isTransformedKey : isUnicodeKey;
  let current = asciiLower(key);
  const seen = new Set<string>();
  for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
    if (seen.has(current)) dataError(`extension key alias cycle includes ${JSON.stringify(current)}`);
    seen.add(current);
    const alias = lookupCaseInsensitive(aliases, current);
    if (alias !== undefined) {
      current = asciiLower(alias);
      continue;
    }
    let descriptor = lookupCaseInsensitive(descriptors, current);
    if (descriptor === undefined) {
      for (const [candidate, value] of Object.entries(descriptors)) {
        if (value.aliases.some((aliasName) => asciiLower(aliasName) === current)) {
          descriptor = value;
          current = asciiLower(candidate);
          break;
        }
      }
    }
    if (descriptor === undefined) {
      if (!keyPredicate(current)) dataError(`extension data maps to an invalid key ${JSON.stringify(current)}`);
      return [current, undefined];
    }
    if (descriptor.preferred === null) {
      if (!keyPredicate(current)) dataError(`extension data contains an invalid key ${JSON.stringify(current)}`);
      return [current, descriptor];
    }
    current = asciiLower(descriptor.preferred);
  }
  dataError("extension key alias rewrite limit exceeded");
}

function canonicalizeExtensionValue(
  value: readonly string[],
  aliases: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, IntlLocaleExtensionValue>> | undefined,
): string[] {
  let current = value.join("-");
  if (aliases === undefined || values === undefined) return current.split("-");
  const seen = new Set<string>();
  for (let step = 0; step < MAX_ALIAS_REWRITES; step++) {
    current = asciiLower(current);
    if (seen.has(current)) dataError(`extension value alias cycle includes ${JSON.stringify(current)}`);
    seen.add(current);
    const alias = lookupCaseInsensitive(aliases, current);
    if (alias !== undefined) {
      current = alias;
      continue;
    }
    let valueDescriptor = lookupCaseInsensitive(values, current);
    if (valueDescriptor === undefined) {
      for (const [candidate, candidateDescriptor] of Object.entries(values)) {
        if (candidateDescriptor.aliases.some((aliasName) => asciiLower(aliasName) === current)) {
          valueDescriptor = candidateDescriptor;
          current = candidate;
          break;
        }
      }
    }
    if (valueDescriptor !== undefined && valueDescriptor.preferred !== null) {
      current = valueDescriptor.preferred;
      continue;
    }
    const subtags = current.split("-").map(asciiLower);
    if (subtags.some((subtag) => !isExtensionValue(subtag)))
      dataError(`extension data contains an invalid value ${JSON.stringify(current)}`);
    return subtags;
  }
  dataError("extension value alias rewrite limit exceeded");
}

function canonicalizeUnicodeExtension(
  extension: MutableUnicodeExtension,
  data: IntlLocaleCanonicalizationData,
): MutableUnicodeExtension {
  const attributes: string[] = [];
  for (const attribute of extension.attributes) {
    const normalized = asciiLower(attribute);
    if (!attributes.includes(normalized)) attributes.push(normalized);
  }
  attributes.sort(compareAscii);

  const keywords: MutableExtensionField[] = [];
  const seenKeys = new Set<string>();
  for (const keyword of extension.keywords) {
    const [key, descriptor] = keyDescriptor(
      keyword.key,
      data.unicodeExtension.keyAliases,
      data.unicodeExtension.keys,
      false,
    );
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const value = canonicalizeExtensionValue(keyword.value, descriptor?.typeAliases, descriptor?.types);
    keywords.push({ key, value: value.length === 1 && value[0] === "true" ? [] : value });
  }
  keywords.sort((left, right) => compareAscii(left.key, right.key));
  return { kind: "unicode", singleton: "u", attributes, keywords };
}

function canonicalizeTransformedExtension(
  extension: MutableTransformedExtension,
  data: IntlLocaleCanonicalizationData,
): MutableTransformedExtension {
  const language =
    extension.language === undefined ? undefined : canonicalizeLanguageIdentifier(extension.language, data);
  const fields: MutableExtensionField[] = [];
  for (const field of extension.fields) {
    const [key, descriptor] = keyDescriptor(field.key, {}, data.transformedExtension.fields, true);
    fields.push({ key, value: canonicalizeExtensionValue(field.value, descriptor?.valueAliases, descriptor?.values) });
  }
  fields.sort(compareExtensionFields);
  return { kind: "transformed", singleton: "t", language, fields };
}

function canonicalizeExtensions(
  extensions: readonly MutableLocaleExtension[],
  data: IntlLocaleCanonicalizationData,
): MutableLocaleExtension[] {
  const canonical = extensions.map((extension) => {
    if (extension.kind === "unicode") return canonicalizeUnicodeExtension(extension, data);
    if (extension.kind === "transformed") return canonicalizeTransformedExtension(extension, data);
    return {
      kind: "other" as const,
      singleton: asciiLower(extension.singleton),
      subtags: extension.subtags.map(asciiLower),
    };
  });
  return canonical.sort((left, right) => compareAscii(left.singleton, right.singleton));
}

function serializeLanguageIdentifier(identifier: MutableLanguageIdentifier, transformed: boolean): string[] {
  const subtags = [identifier.language, identifier.script, identifier.region, ...identifier.variants].filter(
    (subtag): subtag is string => subtag !== undefined,
  );
  if (transformed) return subtags.map(asciiLower);
  return subtags.map((subtag, index) => {
    if (index === 0) return asciiLower(subtag);
    if (identifier.script !== undefined && subtag === identifier.script) return asciiTitle(subtag);
    if (identifier.region !== undefined && subtag === identifier.region) return asciiUpper(subtag);
    return asciiLower(subtag);
  });
}

function serializeExtension(extension: MutableLocaleExtension): string[] {
  if (extension.kind === "unicode") {
    return ["u", ...extension.attributes, ...extension.keywords.flatMap((keyword) => [keyword.key, ...keyword.value])];
  }
  if (extension.kind === "transformed") {
    return [
      "t",
      ...(extension.language === undefined ? [] : serializeLanguageIdentifier(extension.language, true)),
      ...extension.fields.flatMap((field) => [field.key, ...field.value]),
    ];
  }
  return [extension.singleton, ...extension.subtags];
}

function serializeLocaleIdentifier(identifier: MutableLocaleIdentifier): string {
  return [
    ...serializeLanguageIdentifier(identifier, false),
    ...identifier.extensions.flatMap(serializeExtension),
    ...(identifier.privateUse === undefined ? [] : ["x", ...identifier.privateUse.map(asciiLower)]),
  ].join("-");
}

/**
 * Canonicalizes one already-obtained locale string. It intentionally does not
 * implement CanonicalizeLocaleList's observable array-like iteration, ToObject,
 * duplicate elimination, or public RangeError construction.
 */
export function canonicalizeUnicodeLocaleIdentifier(input: string, data: IntlLocaleCanonicalizationData): string {
  const parsed = parseUnicodeBcp47LocaleIdentifier(input);
  validateIntlLocaleCanonicalizationData(data);
  const language = canonicalizeLanguageIdentifier(parsed, data);
  const extensions = canonicalizeExtensions(parsed.extensions.map(copyLocaleExtension), data);
  return serializeLocaleIdentifier({
    ...language,
    extensions,
    privateUse: parsed.privateUse === undefined ? undefined : [...parsed.privateUse],
  });
}
