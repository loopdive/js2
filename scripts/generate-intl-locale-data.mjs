#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Generate deterministic, host-independent locale metadata for a future
 * standalone Intl implementation.
 *
 * The committed CLDR JSON inputs are deliberately pinned by release, commit,
 * byte size, and SHA-256. This generator rejects any mismatch rather than
 * silently accepting a changed upstream dataset. It never consults a host
 * locale API: the output is only a normalized representation of the checked-in
 * data files.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ASSET_ROOT = "assets/intl";
const PROVENANCE_PATH = "provenance/cldr-json-48.2.0.json";
const OUTPUT_PATH = "generated/locale-data.json";
const CLDR_RELEASE = "48.2.0";
const CLDR_COMMIT = "bb334e8d6250c9363e957e131bf7e6d08ec72f91";
const CLDR_VERSION = "48";
const UNICODE_VERSION = "16.0.0";
const CLDR_REPOSITORY = "https://github.com/unicode-org/cldr-json";
const CLDR_RAW_BASE = `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR_COMMIT}`;

const PINNED_LICENSE = {
  path: "license/UNICODE-LICENSE-3.0.txt",
  sourcePath: "LICENSE",
  sha256: "220ba0e1c43b99530d2d5bdb892a99dca0989414f51ab695ecd90163eaa1ec3b",
  bytes: 2033,
};

const PINNED_INPUTS = [
  {
    file: "aliases.json",
    sourcePath: "cldr-json/cldr-core/supplemental/aliases.json",
    sha256: "b7011c866f27502ed6f160ca83f2a83fa42bce9fdc2176e60e2c6630961d877c",
    bytes: 137469,
  },
  {
    file: "availableLocales.json",
    sourcePath: "cldr-json/cldr-core/availableLocales.json",
    sha256: "2961ccc06b437a732c689ad59e891b563e6618546b4c4cda7216549d8a0b4528",
    bytes: 11175,
  },
  {
    file: "likelySubtags.json",
    sourcePath: "cldr-json/cldr-core/supplemental/likelySubtags.json",
    sha256: "38345946ad457213fb39e9645ab50f36b61681bf674b2eef2979a3b58d04afc8",
    bytes: 220093,
  },
  {
    file: "unicode-calendar.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/calendar.json",
    sha256: "bcf1a12f71038aca3716f098c23e23d7125f64df7b7dd9945b29ff682eb5ed17",
    bytes: 4101,
  },
  {
    file: "unicode-collation.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/collation.json",
    sha256: "fcd5f22d3d3db3bf94becf5d83ce21cdca45f3d8c66babd09e88231039669181",
    bytes: 8531,
  },
  {
    file: "unicode-currency.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/currency.json",
    sha256: "88228d7c386bdc1cc5ce7d67ae8a149f3eb4cc4f607ecdd4f6c8cefd8c4114d0",
    bytes: 27552,
  },
  {
    file: "unicode-measure.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/measure.json",
    sha256: "313062c751fcbce1d3027bec924421505f72c0084d8b82ca80f0c8e119ffa2dc",
    bytes: 1177,
  },
  {
    file: "unicode-number.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/number.json",
    sha256: "a8a5d72e55d0bcab49b70887bb69eedbaadc28c7651f6c78661e44e9b28a4cf5",
    bytes: 10182,
  },
  {
    file: "unicode-segmentation.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/segmentation.json",
    sha256: "a373b341a329fa4ef3d2382ed9e2bcca8e17936a81699e580c28f1a98e23a927",
    bytes: 2090,
  },
  {
    file: "unicode-timezone.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/timezone.json",
    sha256: "c11423884420f00cf52733c854de5c898ddb6657ce560334c638a2bd994a1448",
    bytes: 59702,
  },
  {
    file: "unicode-variant.json",
    sourcePath: "cldr-json/cldr-bcp47/bcp47/variant.json",
    sha256: "d7c128971823aabd0f204349175302608f028e360161f74bfddc25d8e2db2497",
    bytes: 1513,
  },
];

const ALIAS_KINDS = ["languageAlias", "scriptAlias", "territoryAlias", "subdivisionAlias", "variantAlias", "zoneAlias"];
const FLAT_ALIAS_KINDS = new Set(ALIAS_KINDS.filter((kind) => kind !== "zoneAlias"));
const KEY_METADATA_FIELDS = new Set(["_alias", "_deprecated", "_description", "_preferred", "_since", "_valueType"]);
const TYPE_METADATA_FIELDS = new Set([
  "_alias",
  "_deprecated",
  "_description",
  "_iana",
  "_preferred",
  "_region",
  "_since",
]);
const LOCALE_TOKEN = /^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*$/;
const UNICODE_KEY = /^[0-9a-z]{2}$/;
const UNICODE_TYPE = /^[0-9a-z]+(?:-[0-9a-z]+)*$/;
const UNICODE_TYPE_PLACEHOLDER = /^[A-Z][A-Z0-9_]*$/;

function compareText(left, right) {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0));
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(leftCodePoints.length, rightCodePoints.length); index++) {
    if (leftCodePoints[index] < rightCodePoints[index]) return -1;
    if (leftCodePoints[index] > rightCodePoints[index]) return 1;
  }
  if (leftCodePoints.length < rightCodePoints.length) return -1;
  if (leftCodePoints.length > rightCodePoints.length) return 1;
  return 0;
}

function fail(message) {
  throw new Error(`Intl locale data: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function assertOptionalString(value, label) {
  if (value === undefined) return undefined;
  return assertString(value, label);
}

function assertOptionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actualKeys = Object.keys(assertRecord(value, label)).sort(compareText);
  const expectedKeys = [...expected].sort(compareText);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail(`${label} has unexpected keys: ${actualKeys.join(", ")}`);
  }
}

function assertMatches(value, pattern, label) {
  assertString(value, label);
  if (!pattern.test(value)) fail(`${label} has unsupported syntax: ${JSON.stringify(value)}`);
  return value;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} contains a duplicate value: ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function sortedEntries(record) {
  return Object.entries(record).sort(([left], [right]) => compareText(left, right));
}

function sortedRecord(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => compareText(left, right)));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function inputUrl(sourcePath) {
  return `${CLDR_RAW_BASE}/${sourcePath}`;
}

function assetPath(root, path) {
  return resolve(root, ASSET_ROOT, path);
}

class DuplicateKeyJsonReader {
  constructor(text, label) {
    this.text = text;
    this.label = label;
    this.index = 0;
  }

  parse() {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.invalid("trailing data");
    return value;
  }

  parseValue() {
    this.skipWhitespace();
    const character = this.text[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === "-" || (character >= "0" && character <= "9")) return this.parseNumber();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    this.invalid("expected a JSON value");
  }

  parseObject() {
    const result = Object.create(null);
    const keys = new Set();
    this.expect("{");
    this.skipWhitespace();
    if (this.consume("}")) return result;
    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.invalid("expected an object key");
      const key = this.parseString();
      if (keys.has(key)) this.invalid(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      const value = this.parseValue();
      Object.defineProperty(result, key, { configurable: true, enumerable: true, value, writable: true });
      this.skipWhitespace();
      if (this.consume("}")) return result;
      this.expect(",");
    }
  }

  parseArray() {
    const result = [];
    this.expect("[");
    this.skipWhitespace();
    if (this.consume("]")) return result;
    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return result;
      this.expect(",");
    }
  }

  parseString() {
    const start = this.index;
    this.expect('"');
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index++;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.invalid("invalid JSON string");
        }
      }
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      if (character.codePointAt(0) < 0x20) this.invalid("control character in string");
      this.index++;
    }
    this.invalid("unterminated string");
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (match === null) this.invalid("invalid JSON number");
    this.index += match[0].length;
    return Number(match[0]);
  }

  consume(character) {
    if (this.text[this.index] !== character) return false;
    this.index++;
    return true;
  }

  expect(character) {
    if (!this.consume(character)) this.invalid(`expected ${JSON.stringify(character)}`);
  }

  skipWhitespace() {
    while (/\s/u.test(this.text[this.index] ?? "")) this.index++;
  }

  invalid(message) {
    throw new Error(`${this.label}: invalid JSON at byte ${this.index}: ${message}`);
  }
}

function parseJson(buffer, label) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) fail(`${label} is not valid UTF-8`);
  return new DuplicateKeyJsonReader(text, label).parse();
}

function expectedProvenanceInput(spec) {
  return {
    path: `pinned-input/${spec.file}`,
    sourcePath: spec.sourcePath,
    url: inputUrl(spec.sourcePath),
    sha256: spec.sha256,
    bytes: spec.bytes,
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function validateProvenance(provenance) {
  assertExactKeys(provenance, ["inputs", "license", "schemaVersion", "source"], "provenance");
  assertEqual(provenance.schemaVersion, 1, "provenance.schemaVersion");

  const source = assertRecord(provenance.source, "provenance.source");
  assertExactKeys(source, ["cldrVersion", "commit", "name", "release", "unicodeVersion", "url"], "provenance.source");
  assertEqual(source.name, "Unicode CLDR JSON", "provenance.source.name");
  assertEqual(source.release, CLDR_RELEASE, "provenance.source.release");
  assertEqual(source.commit, CLDR_COMMIT, "provenance.source.commit");
  assertEqual(source.cldrVersion, CLDR_VERSION, "provenance.source.cldrVersion");
  assertEqual(source.unicodeVersion, UNICODE_VERSION, "provenance.source.unicodeVersion");
  assertEqual(source.url, `${CLDR_REPOSITORY}/tree/${CLDR_COMMIT}`, "provenance.source.url");

  const license = assertRecord(provenance.license, "provenance.license");
  assertExactKeys(license, ["bytes", "path", "sha256", "sourcePath", "url"], "provenance.license");
  assertEqual(license.path, PINNED_LICENSE.path, "provenance.license.path");
  assertEqual(license.sourcePath, PINNED_LICENSE.sourcePath, "provenance.license.sourcePath");
  assertEqual(license.url, inputUrl(PINNED_LICENSE.sourcePath), "provenance.license.url");
  assertEqual(license.sha256, PINNED_LICENSE.sha256, "provenance.license.sha256");
  assertEqual(license.bytes, PINNED_LICENSE.bytes, "provenance.license.bytes");

  const inputs = assertArray(provenance.inputs, "provenance.inputs");
  if (inputs.length !== PINNED_INPUTS.length) fail("provenance.inputs has an unexpected number of inputs");
  for (const [index, spec] of PINNED_INPUTS.entries()) {
    const actual = assertRecord(inputs[index], `provenance.inputs[${index}]`);
    assertExactKeys(actual, ["bytes", "path", "sha256", "sourcePath", "url"], `provenance.inputs[${index}]`);
    const expected = expectedProvenanceInput(spec);
    for (const [key, value] of Object.entries(expected)) {
      assertEqual(actual[key], value, `provenance.inputs[${index}].${key}`);
    }
  }
}

async function readVerifiedFile(root, relativePath, expected, label) {
  const data = await readFile(assetPath(root, relativePath));
  if (data.byteLength !== expected.bytes) {
    fail(`${label} byte length expected ${expected.bytes}, got ${data.byteLength}`);
  }
  const actualHash = sha256(data);
  if (actualHash !== expected.sha256) {
    fail(`${label} sha256 mismatch: expected ${expected.sha256}, got ${actualHash}`);
  }
  return data;
}

async function loadPinnedInputs(root) {
  const pinnedDirectory = assetPath(root, "pinned-input");
  const actualFiles = (await readdir(pinnedDirectory)).sort(compareText);
  const expectedFiles = PINNED_INPUTS.map((spec) => spec.file).sort(compareText);
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    fail(`pinned-input contains an unexpected file set: ${actualFiles.join(", ")}`);
  }

  const provenanceBuffer = await readFile(assetPath(root, PROVENANCE_PATH));
  const provenance = parseJson(provenanceBuffer, PROVENANCE_PATH);
  validateProvenance(provenance);
  await readVerifiedFile(root, PINNED_LICENSE.path, PINNED_LICENSE, PINNED_LICENSE.path);

  const inputs = new Map();
  for (const spec of PINNED_INPUTS) {
    const data = await readVerifiedFile(root, `pinned-input/${spec.file}`, spec, `pinned-input/${spec.file}`);
    inputs.set(spec.file, parseJson(data, `pinned-input/${spec.file}`));
  }
  return inputs;
}

function validateFlatAliasEntry(value, label) {
  assertExactKeys(value, ["_reason", "_replacement"], label);
  return {
    reason: assertString(value._reason, `${label}._reason`),
    replacement: assertString(value._replacement, `${label}._replacement`),
  };
}

function normalizeFlatAliasTable(value, label) {
  const aliases = assertRecord(value, label);
  const entries = [];
  for (const [alias, metadata] of sortedEntries(aliases)) {
    assertString(alias, `${label} alias`);
    entries.push([alias, validateFlatAliasEntry(metadata, `${label}.${alias}`)]);
  }
  if (entries.length === 0) fail(`${label} must not be empty`);
  return sortedRecord(entries);
}

function normalizeNestedAliasTable(value, label) {
  const aliases = assertRecord(value, label);
  const entries = [];
  for (const [alias, replacement] of sortedEntries(aliases)) {
    assertString(alias, `${label} alias`);
    const record = assertRecord(replacement, `${label}.${alias}`);
    const keys = Object.keys(record);
    const isLeaf = keys.includes("_reason") || keys.includes("_replacement");
    entries.push([
      alias,
      isLeaf
        ? validateFlatAliasEntry(record, `${label}.${alias}`)
        : normalizeNestedAliasTable(record, `${label}.${alias}`),
    ]);
  }
  if (entries.length === 0) fail(`${label} must not be empty`);
  return sortedRecord(entries);
}

function countNestedAliases(value) {
  return Object.values(value).reduce(
    (count, entry) => count + (Object.hasOwn(entry, "replacement") ? 1 : countNestedAliases(entry)),
    0,
  );
}

function extractLocaleAliases(source) {
  assertExactKeys(source, ["supplemental"], "aliases.json");
  const supplemental = assertRecord(source.supplemental, "aliases.json.supplemental");
  assertExactKeys(supplemental, ["metadata", "version"], "aliases.json.supplemental");
  const version = assertRecord(supplemental.version, "aliases.json.supplemental.version");
  assertExactKeys(version, ["_cldrVersion", "_unicodeVersion"], "aliases.json.supplemental.version");
  assertEqual(version._cldrVersion, CLDR_VERSION, "aliases.json.supplemental.version._cldrVersion");
  assertEqual(version._unicodeVersion, UNICODE_VERSION, "aliases.json.supplemental.version._unicodeVersion");

  const metadata = assertRecord(supplemental.metadata, "aliases.json.supplemental.metadata");
  assertExactKeys(metadata, ["alias"], "aliases.json.supplemental.metadata");
  const aliases = assertRecord(metadata.alias, "aliases.json.supplemental.metadata.alias");
  assertExactKeys(aliases, ALIAS_KINDS, "aliases.json.supplemental.metadata.alias");

  const normalized = Object.create(null);
  for (const kind of ALIAS_KINDS) {
    const outputName = kind === "territoryAlias" ? "region" : kind.replace(/Alias$/u, "");
    normalized[outputName] = FLAT_ALIAS_KINDS.has(kind)
      ? normalizeFlatAliasTable(aliases[kind], `aliases.json.${kind}`)
      : normalizeNestedAliasTable(aliases[kind], `aliases.json.${kind}`);
  }
  return normalized;
}

function extractLikelySubtags(source) {
  assertExactKeys(source, ["supplemental"], "likelySubtags.json");
  const supplemental = assertRecord(source.supplemental, "likelySubtags.json.supplemental");
  assertExactKeys(supplemental, ["likelySubtags", "version"], "likelySubtags.json.supplemental");
  const version = assertRecord(supplemental.version, "likelySubtags.json.supplemental.version");
  assertExactKeys(version, ["_cldrVersion", "_unicodeVersion"], "likelySubtags.json.supplemental.version");
  assertEqual(version._cldrVersion, CLDR_VERSION, "likelySubtags.json.supplemental.version._cldrVersion");
  assertEqual(version._unicodeVersion, UNICODE_VERSION, "likelySubtags.json.supplemental.version._unicodeVersion");

  const sourceSubtags = assertRecord(supplemental.likelySubtags, "likelySubtags.json.supplemental.likelySubtags");
  const entries = [];
  for (const [from, to] of sortedEntries(sourceSubtags)) {
    assertMatches(from, LOCALE_TOKEN, `likelySubtags key ${JSON.stringify(from)}`);
    assertMatches(to, LOCALE_TOKEN, `likelySubtags value for ${JSON.stringify(from)}`);
    entries.push([from, to]);
  }
  if (entries.length === 0) fail("likelySubtags must not be empty");
  return sortedRecord(entries);
}

function extractAvailableLocales(source) {
  assertExactKeys(source, ["availableLocales"], "availableLocales.json");
  const available = assertRecord(source.availableLocales, "availableLocales.json.availableLocales");
  assertExactKeys(available, ["full", "modern"], "availableLocales.json.availableLocales");
  const modern = assertArray(available.modern, "availableLocales.json.availableLocales.modern");
  if (modern.length !== 0) fail("availableLocales.json.availableLocales.modern must remain empty for this pin");

  const full = assertArray(available.full, "availableLocales.json.availableLocales.full");
  const locales = full.map((locale, index) =>
    assertMatches(locale, LOCALE_TOKEN, `availableLocales.json.availableLocales.full[${index}]`),
  );
  assertUnique(locales, "availableLocales.json.availableLocales.full");
  if (locales.length === 0) fail("availableLocales.json.availableLocales.full must not be empty");
  return locales.sort(compareText);
}

function extractMetadata(record, allowedFields, label, allowNestedValues = false) {
  const metadata = Object.create(null);
  for (const [field, value] of sortedEntries(record)) {
    if (!field.startsWith("_")) {
      if (!allowNestedValues) fail(`${label} has unsupported nested field ${field}`);
      continue;
    }
    if (!allowedFields.has(field)) fail(`${label} has unsupported metadata field ${field}`);
    if (field === "_deprecated") {
      metadata[field] = assertOptionalBoolean(value, `${label}.${field}`);
    } else {
      metadata[field] = assertOptionalString(value, `${label}.${field}`);
    }
  }
  return metadata;
}

function splitAliases(value, label) {
  if (value === undefined) return [];
  const aliases = assertString(value, label).trim().split(/\s+/u);
  assertUnique(aliases, label);
  return aliases.sort(compareText);
}

function unicodeTypeKind(type, label) {
  if (UNICODE_TYPE.test(type)) return "literal";
  if (UNICODE_TYPE_PLACEHOLDER.test(type)) return "placeholder";
  fail(`${label} has unsupported syntax: ${JSON.stringify(type)}`);
}

function normalizeUnicodeKey(source, label) {
  const record = assertRecord(source, label);
  const metadata = extractMetadata(record, KEY_METADATA_FIELDS, label, true);
  const typeNames = Object.keys(record).filter((name) => !name.startsWith("_"));
  if (typeNames.length === 0) fail(`${label} has no Unicode extension types`);
  const typeKinds = new Map(typeNames.map((type) => [type, unicodeTypeKind(type, `${label} type`)]));

  const canonicalTypes = new Set(typeNames.filter((type) => typeKinds.get(type) === "literal"));
  const typeAliases = new Map();
  const types = [];
  const placeholders = [];
  for (const type of [...typeNames].sort(compareText)) {
    const typeLabel = `${label}.${type}`;
    const typeMetadata = extractMetadata(assertRecord(record[type], typeLabel), TYPE_METADATA_FIELDS, typeLabel);
    const aliases = splitAliases(typeMetadata._alias, `${typeLabel}._alias`);
    const descriptor = {
      aliases,
      deprecated: typeMetadata._deprecated ?? false,
      preferred: typeMetadata._preferred ?? null,
    };
    if (typeKinds.get(type) === "placeholder") {
      if (aliases.some((alias) => canonicalTypes.has(alias))) {
        fail(`${typeLabel} placeholder alias collides with a canonical type`);
      }
      placeholders.push([type, descriptor]);
      continue;
    }
    for (const alias of aliases) {
      if (canonicalTypes.has(alias) && alias !== type) {
        // A deprecated spelling can carry both an alias and an explicit
        // preferred canonical type. The canonical spelling wins the lookup
        // table; accepting it without that matching preferred value would hide
        // an ambiguous data collision.
        if (typeMetadata._preferred !== alias) {
          fail(`${typeLabel} alias ${JSON.stringify(alias)} collides with a canonical type`);
        }
        continue;
      }
      const previous = typeAliases.get(alias);
      if (previous !== undefined && previous !== type) {
        fail(`${typeLabel} alias ${JSON.stringify(alias)} collides with ${JSON.stringify(previous)}`);
      }
      typeAliases.set(alias, type);
    }
    types.push([type, descriptor]);
  }
  return {
    aliases: splitAliases(metadata._alias, `${label}._alias`),
    deprecated: metadata._deprecated ?? false,
    placeholders: sortedRecord(placeholders),
    preferred: metadata._preferred ?? null,
    typeAliases: sortedRecord(typeAliases.entries()),
    types: sortedRecord(types),
    valueType: metadata._valueType ?? null,
  };
}

function extractUnicodeExtensionData(inputs) {
  const keys = new Map();
  const keyAliases = new Map();
  for (const spec of PINNED_INPUTS.filter((entry) => entry.file.startsWith("unicode-"))) {
    const source = inputs.get(spec.file);
    assertExactKeys(source, ["keyword", "version"], `pinned-input/${spec.file}`);
    const version = assertRecord(source.version, `pinned-input/${spec.file}.version`);
    assertExactKeys(version, ["_number"], `pinned-input/${spec.file}.version`);
    assertEqual(version._number, "$Revision$", `pinned-input/${spec.file}.version._number`);
    const keyword = assertRecord(source.keyword, `pinned-input/${spec.file}.keyword`);
    assertExactKeys(keyword, ["u"], `pinned-input/${spec.file}.keyword`);
    const unicode = assertRecord(keyword.u, `pinned-input/${spec.file}.keyword.u`);

    for (const [key, sourceKey] of sortedEntries(unicode)) {
      assertMatches(key, UNICODE_KEY, `pinned-input/${spec.file}.keyword.u key`);
      if (keys.has(key)) fail(`Unicode extension key ${JSON.stringify(key)} appears in more than one source file`);
      if (keyAliases.has(key)) fail(`Unicode extension key ${JSON.stringify(key)} collides with an earlier key alias`);
      const normalized = normalizeUnicodeKey(sourceKey, `pinned-input/${spec.file}.keyword.u.${key}`);
      for (const alias of normalized.aliases) {
        if (keys.has(alias) && alias !== key)
          fail(`Unicode extension key alias ${JSON.stringify(alias)} collides with a key`);
        const previous = keyAliases.get(alias);
        if (previous !== undefined && previous !== key) {
          fail(`Unicode extension key alias ${JSON.stringify(alias)} collides with ${JSON.stringify(previous)}`);
        }
        keyAliases.set(alias, key);
      }
      keys.set(key, normalized);
    }
  }
  if (keys.size === 0) fail("Unicode extension data has no keys");
  return {
    keyAliases: sortedRecord(keyAliases.entries()),
    keys: sortedRecord(keys.entries()),
  };
}

function sourceMetadata() {
  return {
    cldrJson: {
      cldrVersion: CLDR_VERSION,
      commit: CLDR_COMMIT,
      release: CLDR_RELEASE,
      unicodeVersion: UNICODE_VERSION,
      url: `${CLDR_REPOSITORY}/tree/${CLDR_COMMIT}`,
    },
    inputs: PINNED_INPUTS.map((spec) => expectedProvenanceInput(spec)),
    license: {
      bytes: PINNED_LICENSE.bytes,
      path: PINNED_LICENSE.path,
      sha256: PINNED_LICENSE.sha256,
      sourcePath: PINNED_LICENSE.sourcePath,
      url: inputUrl(PINNED_LICENSE.sourcePath),
    },
  };
}

function buildLocaleData(inputs) {
  const localeAliases = extractLocaleAliases(inputs.get("aliases.json"));
  const likelySubtags = extractLikelySubtags(inputs.get("likelySubtags.json"));
  const availableLocales = extractAvailableLocales(inputs.get("availableLocales.json"));
  const unicodeExtension = extractUnicodeExtensionData(inputs);
  const unicodeTypeCount = Object.values(unicodeExtension.keys).reduce(
    (count, key) => count + Object.keys(key.types).length,
    0,
  );
  const unicodePlaceholderCount = Object.values(unicodeExtension.keys).reduce(
    (count, key) => count + Object.keys(key.placeholders).length,
    0,
  );

  return {
    counts: {
      availableLocales: availableLocales.length,
      likelySubtags: Object.keys(likelySubtags).length,
      localeAliases: Object.fromEntries(
        Object.entries(localeAliases).map(([kind, values]) => [kind, countNestedAliases(values)]),
      ),
      unicodeExtensionKeys: Object.keys(unicodeExtension.keys).length,
      unicodeExtensionTypePlaceholders: unicodePlaceholderCount,
      unicodeExtensionTypes: unicodeTypeCount,
    },
    availableLocales,
    likelySubtags,
    localeAliases,
    schemaVersion: 1,
    source: sourceMetadata(),
    unicodeExtension,
  };
}

function parseArguments(argv) {
  const options = { check: false, root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--root") {
      const root = argv[++index];
      if (root === undefined) fail("--root requires a path");
      options.root = resolve(root);
      continue;
    }
    fail(`unsupported argument ${JSON.stringify(argument)}`);
  }
  return options;
}

async function writeOrCheck(root, output, check) {
  const outputFile = assetPath(root, OUTPUT_PATH);
  if (check) {
    let existing;
    try {
      existing = await readFile(outputFile, "utf8");
    } catch {
      fail(`${OUTPUT_PATH} is missing; run the generator without --check`);
    }
    if (existing !== output) fail(`${OUTPUT_PATH} is not reproducible; regenerate it from the pinned inputs`);
    return;
  }
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, output);
}

async function main() {
  const { check, root } = parseArguments(process.argv.slice(2));
  const inputs = await loadPinnedInputs(root);
  const data = buildLocaleData(inputs);
  const output = `${JSON.stringify(data, null, 2)}\n`;
  await writeOrCheck(root, output, check);
  const totalInputBytes = PINNED_LICENSE.bytes + PINNED_INPUTS.reduce((sum, input) => sum + input.bytes, 0);
  const mode = check ? "verified" : "wrote";
  console.log(`${mode} ${OUTPUT_PATH}: ${Buffer.byteLength(output)} bytes`);
  console.log(`CLDR JSON ${CLDR_RELEASE} @ ${CLDR_COMMIT}: ${totalInputBytes} pinned input bytes`);
  console.log(
    `tables: ${data.counts.availableLocales} locales, ${data.counts.likelySubtags} likely subtags, ${data.counts.unicodeExtensionKeys} Unicode extension keys`,
  );
}

export function normalizeUnicodeExtensionKey(source, label = "Unicode extension key") {
  return normalizeUnicodeKey(source, label);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
