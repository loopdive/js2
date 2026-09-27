#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Generate the pinned Unicode 17.0.0 normalization tables used by the native
 * standalone `String.prototype.normalize` helper.
 *
 * Unlike the historical case-table generator, this tool does not sample the
 * Node/ICU normalizer. It consumes the normative UCD source records directly,
 * rejects any source-byte drift, and proves the generated data with every row
 * of the version-matched NormalizationTest.txt corpus before it writes output.
 *
 * Usage:
 *   node scripts/gen-normalize-tables.mjs
 *   node scripts/gen-normalize-tables.mjs --input-dir /path/to/UCD-17.0.0
 *
 * The no-argument form fetches only the exact public Unicode 17.0.0 URLs below.
 * CI consumes the committed generated module and never regenerates it.
 * This generator remains project code under the Apache-2.0 WITH LLVM-exception
 * header above; every generated data module carries the Unicode License V3
 * notice below alongside its source URL and digest.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const UNICODE_VERSION = "17.0.0";
const SOURCES = [
  {
    file: "UnicodeData.txt",
    url: "https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt",
    // UnicodeData.txt does not carry a version header. The immutable URL and
    // this exact content digest are its version contract.
    sha256: "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c",
  },
  {
    file: "DerivedNormalizationProps.txt",
    url: "https://www.unicode.org/Public/17.0.0/ucd/DerivedNormalizationProps.txt",
    sha256: "71fd6a206a2c0cdd41feb6b7f656aa31091db45e9cedc926985d718397f9e488",
    header: "# DerivedNormalizationProps-17.0.0.txt",
  },
  {
    file: "NormalizationTest.txt",
    url: "https://www.unicode.org/Public/17.0.0/ucd/NormalizationTest.txt",
    sha256: "5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db",
    header: "# NormalizationTest-17.0.0.txt",
  },
];

// Unicode Data Files are subject to Unicode License V3. Keep the complete
// copyright and permission notice in every generated derivative-data module:
// https://www.unicode.org/license.txt
const UNICODE_LICENSE_V3_COMMENT = ` *
 * This generated file includes data derived from Unicode Data Files.
 * Unicode License V3
 * Copyright © 1991-2026 Unicode, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of data files and any associated documentation (the "Data Files") or
 * software and any associated documentation (the "Software") to deal in the
 * Data Files or Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, and/or sell
 * copies of the Data Files or Software, and to permit persons to whom the
 * Data Files or Software are furnished to do so, provided that either (a)
 * this copyright and permission notice appear with all copies of the Data
 * Files or Software, or (b) this copyright and permission notice appear in
 * associated Documentation.
 *
 * THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
 * THIRD PARTY RIGHTS.
 *
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
 * BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
 * OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
 * WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
 * FILES OR SOFTWARE.
 *
 * Except as contained in this notice, the name of a copyright holder shall
 * not be used in advertising or otherwise to promote the sale, use or other
 * dealings in these Data Files or Software without prior written
 * authorization of the copyright holder.
`;

const HANGUL_S_BASE = 0xac00;
const HANGUL_S_COUNT = 11172;
const HANGUL_L_BASE = 0x1100;
const HANGUL_V_BASE = 0x1161;
const HANGUL_T_BASE = 0x11a7;
const HANGUL_L_COUNT = 19;
const HANGUL_V_COUNT = 21;
const HANGUL_T_COUNT = 28;
const HANGUL_N_COUNT = HANGUL_V_COUNT * HANGUL_T_COUNT;

// `array.new_fixed` is used to materialise each generated table in the Wasm
// module. Keep every serialized slice within the engine limit documented by
// src/runtime/wasmgc/values/string-literal-bodies.ts.
const ARRAY_NEW_FIXED_MAX = 10_000;

// Biome intentionally refuses files at or above 1 MiB. Keep the generated
// NormalizationTest payload below that boundary without weakening repository
// lint coverage. A fixed count makes the emitted module set deterministic.
const GENERATED_FIXTURE_FILE_MAX_BYTES = 1024 * 1024;
const NORMALIZATION_TEST_VALUE_CHUNK_COUNT = 4;

function fail(message) {
  throw new Error(`gen-normalize-tables: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function withoutComment(line) {
  const comment = line.indexOf("#");
  return (comment < 0 ? line : line.slice(0, comment)).trim();
}

function parseCodePoint(text, context) {
  if (!/^[0-9A-F]{4,6}$/u.test(text)) fail(`${context}: invalid code point ${JSON.stringify(text)}`);
  const cp = Number.parseInt(text, 16);
  if (cp > 0x10ffff) fail(`${context}: out-of-range code point ${text}`);
  return cp;
}

function parseCodePointSequence(text, context) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/u).map((part) => parseCodePoint(part, context));
}

function parseRange(text, context) {
  const parts = text.trim().split("..");
  if (parts.length === 1) {
    const cp = parseCodePoint(parts[0], context);
    return [cp, cp];
  }
  if (parts.length !== 2) fail(`${context}: invalid range ${JSON.stringify(text)}`);
  const start = parseCodePoint(parts[0], context);
  const end = parseCodePoint(parts[1], context);
  if (end < start) fail(`${context}: descending range ${text}`);
  return [start, end];
}

function isSurrogate(cp) {
  return cp >= 0xd800 && cp <= 0xdfff;
}

function isHangulSyllable(cp) {
  return cp >= HANGUL_S_BASE && cp < HANGUL_S_BASE + HANGUL_S_COUNT;
}

function decomposeHangul(cp) {
  const sIndex = cp - HANGUL_S_BASE;
  const l = HANGUL_L_BASE + Math.floor(sIndex / HANGUL_N_COUNT);
  const v = HANGUL_V_BASE + Math.floor((sIndex % HANGUL_N_COUNT) / HANGUL_T_COUNT);
  const t = sIndex % HANGUL_T_COUNT;
  return t === 0 ? [l, v] : [l, v, HANGUL_T_BASE + t];
}

function composeHangul(first, second) {
  if (
    first >= HANGUL_L_BASE &&
    first < HANGUL_L_BASE + HANGUL_L_COUNT &&
    second >= HANGUL_V_BASE &&
    second < HANGUL_V_BASE + HANGUL_V_COUNT
  ) {
    return HANGUL_S_BASE + (first - HANGUL_L_BASE) * HANGUL_N_COUNT + (second - HANGUL_V_BASE) * HANGUL_T_COUNT;
  }
  if (
    isHangulSyllable(first) &&
    (first - HANGUL_S_BASE) % HANGUL_T_COUNT === 0 &&
    second > HANGUL_T_BASE &&
    second < HANGUL_T_BASE + HANGUL_T_COUNT
  ) {
    return first + second - HANGUL_T_BASE;
  }
  return undefined;
}

/**
 * Retain both the UCD data the helper needs and the complete assigned-scalar
 * inventory required by UAX #15 NormalizationTest rule 2. Range records are
 * fully validated but are not eagerly expanded into normalization records when
 * both CCC and decomposition are zero; the compact scalar-range inventory still
 * preserves every assigned non-surrogate code point, including Co ranges.
 */
function parseUnicodeData(text) {
  /** @type {Map<number, { ccc: number, compatibility: boolean, mapping: number[] }>} */
  const records = new Map();
  /** @type {Array<[number, number]>} */
  const assignedScalarRanges = [];
  let assignedScalarCount = 0;
  let assignedPrivateUseScalarCount = 0;
  let assignedSurrogateCodePointCount = 0;
  /** @type {{ cp: number, nameStem: string, fields: string[] } | undefined} */
  let pendingRange;

  const recordAssignedScalarRange = (start, end, category, context) => {
    if (end < start) fail(`${context}: descending assigned range`);
    const append = (rangeStart, rangeEnd) => {
      if (rangeStart > rangeEnd) return;
      const previous = assignedScalarRanges.at(-1);
      if (previous !== undefined && rangeStart <= previous[1]) {
        fail(`${context}: duplicate or out-of-order assigned scalar range`);
      }
      if (previous !== undefined && rangeStart === previous[1] + 1) previous[1] = rangeEnd;
      else assignedScalarRanges.push([rangeStart, rangeEnd]);
      const count = rangeEnd - rangeStart + 1;
      assignedScalarCount += count;
      if (category === "Co") assignedPrivateUseScalarCount += count;
    };
    // Surrogate code points are not Unicode scalars. They receive their own
    // explicit WTF-16 identity test, rather than being silently folded into
    // the scalar Rule-2 inventory.
    if (start < 0xd800) append(start, Math.min(end, 0xd7ff));
    if (end > 0xdfff) append(Math.max(start, 0xe000), end);
    const surrogateStart = Math.max(start, 0xd800);
    const surrogateEnd = Math.min(end, 0xdfff);
    if (surrogateStart <= surrogateEnd) assignedSurrogateCodePointCount += surrogateEnd - surrogateStart + 1;
  };

  const add = (cp, fields, context) => {
    const cccText = fields[3];
    if (!/^[0-9]+$/u.test(cccText)) fail(`${context}: invalid Canonical_Combining_Class ${cccText}`);
    const ccc = Number.parseInt(cccText, 10);
    if (ccc < 0 || ccc > 255) fail(`${context}: out-of-range Canonical_Combining_Class ${ccc}`);
    const decompField = fields[5].trim();
    let compatibility = false;
    let mapping = [];
    if (decompField !== "") {
      const tokens = decompField.split(/\s+/u);
      if (/^<[^>]+>$/u.test(tokens[0])) {
        compatibility = true;
        tokens.shift();
      }
      if (tokens.length === 0) fail(`${context}: decomposition tag without mapping`);
      mapping = tokens.map((token) => parseCodePoint(token, context));
    }
    if (isSurrogate(cp)) {
      if (ccc !== 0 || mapping.length !== 0) fail(`${context}: surrogate has normalization data`);
      return;
    }
    if (ccc !== 0 || mapping.length !== 0) records.set(cp, { ccc, compatibility, mapping });
  };

  const lines = text.split(/\r?\n/u);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (line === "") continue;
    const fields = line.split(";");
    const context = `UnicodeData.txt:${lineNo + 1}`;
    if (fields.length !== 15) fail(`${context}: expected 15 fields, got ${fields.length}`);
    const cp = parseCodePoint(fields[0], context);
    const name = fields[1];
    const rangeMatch = /^<(.+), (First|Last)>$/u.exec(name);
    if (rangeMatch?.[2] === "First") {
      if (pendingRange !== undefined) fail(`${context}: nested First range`);
      pendingRange = { cp, nameStem: rangeMatch[1], fields };
      continue;
    }
    if (rangeMatch?.[2] === "Last") {
      if (pendingRange === undefined || pendingRange.nameStem !== rangeMatch[1]) {
        fail(`${context}: Last range does not match a preceding First`);
      }
      if (cp < pendingRange.cp) fail(`${context}: descending First/Last range`);
      for (let index = 2; index < fields.length; index++) {
        if (fields[index] !== pendingRange.fields[index]) {
          fail(`${context}: First/Last range normalization fields differ`);
        }
      }
      // A range with no data is a default identity range. Otherwise expand every
      // code point so the generated CCC/decomposition tables are exact.
      if (fields[3] !== "0" || fields[5] !== "") {
        for (let rangeCp = pendingRange.cp; rangeCp <= cp; rangeCp++) add(rangeCp, fields, context);
      }
      recordAssignedScalarRange(pendingRange.cp, cp, fields[2], context);
      pendingRange = undefined;
      continue;
    }
    if (pendingRange !== undefined) fail(`${context}: missing Last range record`);
    recordAssignedScalarRange(cp, cp, fields[2], context);
    add(cp, fields, context);
  }
  if (pendingRange !== undefined) fail("UnicodeData.txt: unterminated First range");
  if (assignedScalarRanges.length === 0) fail("UnicodeData.txt: no assigned scalar ranges");
  if (assignedPrivateUseScalarCount === 0) fail("UnicodeData.txt: missing assigned private-use scalar range");
  if (assignedSurrogateCodePointCount !== 0x800) {
    fail(`UnicodeData.txt: expected 2048 surrogate code points, got ${assignedSurrogateCodePointCount}`);
  }
  return {
    records,
    assignedScalarRanges,
    assignedScalarCount,
    assignedPrivateUseScalarCount,
    assignedSurrogateCodePointCount,
  };
}

function parseFullCompositionExclusions(text) {
  const excluded = new Set();
  for (let lineNo = 0, lines = text.split(/\r?\n/u); lineNo < lines.length; lineNo++) {
    const data = withoutComment(lines[lineNo]);
    if (data === "") continue;
    const fields = data.split(";").map((field) => field.trim());
    if (fields.length < 2) fail(`DerivedNormalizationProps.txt:${lineNo + 1}: malformed property record`);
    // Other derived properties (for example FC_NFKC) legitimately carry a
    // third mapping field. They are outside this generator's input contract;
    // validate the exact two-field shape only after selecting the one property
    // normalization composition actually consumes.
    if (fields[1] !== "Full_Composition_Exclusion") continue;
    if (fields.length !== 2) {
      fail(`DerivedNormalizationProps.txt:${lineNo + 1}: malformed Full_Composition_Exclusion record`);
    }
    const [start, end] = parseRange(fields[0], `DerivedNormalizationProps.txt:${lineNo + 1}`);
    for (let cp = start; cp <= end; cp++) excluded.add(cp);
  }
  if (excluded.size === 0) fail("DerivedNormalizationProps.txt: no Full_Composition_Exclusion records");
  return excluded;
}

function buildTables(records, excluded) {
  const canonicalMemo = new Map();
  const compatibilityMemo = new Map();
  const canonicalVisiting = new Set();
  const compatibilityVisiting = new Set();

  const expand = (cp, compatibility, memo, visiting) => {
    const cached = memo.get(cp);
    if (cached !== undefined) return cached;
    if (isHangulSyllable(cp) || isSurrogate(cp)) return [cp];
    const entry = records.get(cp);
    if (entry === undefined || entry.mapping.length === 0 || (!compatibility && entry.compatibility)) return [cp];
    if (visiting.has(cp)) fail(`decomposition cycle at U+${cp.toString(16).toUpperCase()}`);
    visiting.add(cp);
    const expanded = [];
    for (const part of entry.mapping) expanded.push(...expand(part, compatibility, memo, visiting));
    visiting.delete(cp);
    memo.set(cp, expanded);
    return expanded;
  };

  const canonicalIndex = [];
  const canonicalValues = [];
  const compatibilityIndex = [];
  const compatibilityValues = [];
  const rawCanonicalPairs = new Map();
  const entries = [...records.entries()].sort((left, right) => left[0] - right[0]);
  for (const [cp, entry] of entries) {
    if (entry.mapping.length === 0) continue;
    if (!entry.compatibility) {
      const values = expand(cp, false, canonicalMemo, canonicalVisiting);
      if (values.length === 1 && values[0] === cp) fail(`canonical mapping U+${cp.toString(16)} did not expand`);
      canonicalIndex.push(cp, canonicalValues.length, values.length);
      canonicalValues.push(...values);
      if (entry.mapping.length === 2 && !excluded.has(cp)) {
        const key = `${entry.mapping[0]},${entry.mapping[1]}`;
        const previous = rawCanonicalPairs.get(key);
        if (previous !== undefined && previous !== cp) {
          fail(`duplicate canonical composition ${key}: U+${previous.toString(16)} / U+${cp.toString(16)}`);
        }
        rawCanonicalPairs.set(key, cp);
      }
    }
    const compatibilityValuesForCp = expand(cp, true, compatibilityMemo, compatibilityVisiting);
    if (compatibilityValuesForCp.length === 1 && compatibilityValuesForCp[0] === cp) {
      fail(`compatibility mapping U+${cp.toString(16)} did not expand`);
    }
    compatibilityIndex.push(cp, compatibilityValues.length, compatibilityValuesForCp.length);
    compatibilityValues.push(...compatibilityValuesForCp);
  }

  const cccRanges = [];
  let runStart = -1;
  let runEnd = -1;
  let runCcc = -1;
  for (const [cp, entry] of entries) {
    if (entry.ccc === 0) continue;
    if (runStart >= 0 && cp === runEnd + 1 && entry.ccc === runCcc) {
      runEnd = cp;
      continue;
    }
    if (runStart >= 0) cccRanges.push(runStart, runEnd, runCcc);
    runStart = cp;
    runEnd = cp;
    runCcc = entry.ccc;
  }
  if (runStart >= 0) cccRanges.push(runStart, runEnd, runCcc);

  const composition = [...rawCanonicalPairs.entries()]
    .map(([key, composite]) => {
      const [first, second] = key.split(",").map(Number);
      return [first, second, composite];
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
    .flat();

  // The native helper consumes a flat value slice rather than recursively
  // chasing UCD records. Keep that contract explicit: the generator may leave
  // Hangul syllables for the helper's algorithmic path, but every other table
  // value must already be terminal for the matching normalization form.
  const assertTerminalValues = (values, compatibility, tableName) => {
    for (const cp of values) {
      if (isHangulSyllable(cp) || isSurrogate(cp)) continue;
      const entry = records.get(cp);
      const hasRelevantMapping =
        entry !== undefined && entry.mapping.length > 0 && (compatibility || !entry.compatibility);
      if (hasRelevantMapping) {
        fail(`${tableName} leaves decomposable U+${cp.toString(16).toUpperCase()} in a generated value slice`);
      }
    }
  };
  assertTerminalValues(canonicalValues, false, "canonical");
  assertTerminalValues(compatibilityValues, true, "compatibility");

  if (
    canonicalIndex.length === 0 ||
    compatibilityIndex.length === 0 ||
    cccRanges.length === 0 ||
    composition.length === 0
  ) {
    fail("generated an unexpectedly empty normalization table");
  }
  const splitIndex = (index, tableName) => {
    if (index.length % 3 !== 0) fail(`${tableName}: index triples are malformed`);
    const keys = [];
    const offsets = [];
    const lengths = [];
    for (let base = 0; base < index.length; base += 3) {
      keys.push(index[base]);
      offsets.push(index[base + 1]);
      lengths.push(index[base + 2]);
    }
    return { keys, offsets, lengths };
  };

  return {
    canonicalIndex: splitIndex(canonicalIndex, "canonical"),
    canonicalValues,
    compatibilityIndex: splitIndex(compatibilityIndex, "compatibility"),
    compatibilityValues,
    cccRanges,
    composition,
    rawCanonicalPairs,
  };
}

/** Find an exact serialized index key, returning its entry ordinal. */
function lookupIndexEntry(keys, cp) {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const key = keys[middle];
    if (cp < key) high = middle;
    else if (cp > key) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** Read Canonical_Combining_Class from the exact serialized range table. */
function cccFromTable(ranges, cp) {
  let low = 0;
  let high = ranges.length / 3;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const base = middle * 3;
    const start = ranges[base];
    const end = ranges[base + 1];
    if (cp < start) high = middle;
    else if (cp > end) low = middle + 1;
    else return ranges[base + 2];
  }
  return 0;
}

/** Read a canonical composition from the exact serialized pair table. */
function composeFromTable(pairs, first, second) {
  let low = 0;
  let high = pairs.length / 3;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const base = middle * 3;
    const left = pairs[base];
    const right = pairs[base + 1];
    if (first < left || (first === left && second < right)) high = middle;
    else if (first > left || (first === left && second > right)) low = middle + 1;
    else return pairs[base + 2];
  }
  return undefined;
}

function canonicalOrder(ccc, scalars) {
  const out = [];
  let segmentStart = 0;
  for (const cp of scalars) {
    const currentCcc = ccc(cp);
    if (currentCcc === 0) {
      out.push(cp);
      segmentStart = out.length;
      continue;
    }
    let insertAt = out.length;
    while (insertAt > segmentStart && ccc(out[insertAt - 1]) > currentCcc) insertAt--;
    out.splice(insertAt, 0, cp);
  }
  return out;
}

/**
 * The generator's proof path intentionally consumes the same flat table shapes
 * the Wasm helper consumes. It must not fall back to the raw UCD record map:
 * otherwise a bad serializer could still pass every NormalizationTest row.
 */
function normalizeFromTables(tables, scalars, form) {
  const compatibility = form === "NFKC" || form === "NFKD";
  const memo = new Map();
  const visiting = new Set();
  const expand = (cp) => {
    const cached = memo.get(cp);
    if (cached !== undefined) return cached;
    if (isSurrogate(cp)) return [cp];
    if (isHangulSyllable(cp)) return decomposeHangul(cp);
    const index = compatibility ? tables.compatibilityIndex : tables.canonicalIndex;
    const values = compatibility ? tables.compatibilityValues : tables.canonicalValues;
    const entry = lookupIndexEntry(index.keys, cp);
    if (entry < 0) return [cp];
    if (visiting.has(cp)) fail(`conformance expansion cycle at U+${cp.toString(16)}`);
    visiting.add(cp);
    const result = [];
    const offset = index.offsets[entry];
    const length = index.lengths[entry];
    for (let indexOffset = 0; indexOffset < length; indexOffset++) result.push(...expand(values[offset + indexOffset]));
    visiting.delete(cp);
    memo.set(cp, result);
    return result;
  };
  const decomposed = [];
  for (const cp of scalars) decomposed.push(...expand(cp));
  const ordered = canonicalOrder((cp) => cccFromTable(tables.cccRanges, cp), decomposed);
  if (form === "NFD" || form === "NFKD") return ordered;

  const out = [];
  let starterIndex = -1;
  let starter = 0;
  let lastCcc = 0;
  for (const cp of ordered) {
    const ccc = cccFromTable(tables.cccRanges, cp);
    const composed =
      starterIndex >= 0 && (lastCcc === 0 || lastCcc < ccc)
        ? (composeHangul(starter, cp) ?? composeFromTable(tables.composition, starter, cp))
        : undefined;
    if (composed !== undefined) {
      out[starterIndex] = composed;
      starter = composed;
      continue;
    }
    out.push(cp);
    if (ccc === 0) {
      starterIndex = out.length - 1;
      starter = cp;
    }
    lastCcc = ccc;
  }
  return out;
}

function sameScalars(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** Parse the normative rows once so both the data proof and test fixture use exactly the same corpus view. */
function parseNormalizationTest(text) {
  const rows = [];
  const part1 = new Set();
  let inPart1 = false;
  for (let lineNo = 0, lines = text.split(/\r?\n/u); lineNo < lines.length; lineNo++) {
    const data = withoutComment(lines[lineNo]);
    if (data.startsWith("@")) {
      inPart1 = data === "@Part1";
      continue;
    }
    if (data === "") continue;
    const fields = data.split(";").map((field) => field.trim());
    if (fields.at(-1) === "") fields.pop();
    if (fields.length !== 5) fail(`NormalizationTest.txt:${lineNo + 1}: expected five columns`);
    const cols = fields.map((field) => parseCodePointSequence(field, `NormalizationTest.txt:${lineNo + 1}`));
    if (inPart1) for (const cp of cols[0]) part1.add(cp);
    rows.push({ lineNumber: lineNo + 1, cols });
  }
  if (rows.length === 0) fail("NormalizationTest.txt has no data rows");
  if (part1.size === 0) fail("NormalizationTest.txt: Part 1 has no c1 code points");
  return { rows, part1 };
}

function validateNormalizationTest(parsed, tables) {
  for (const row of parsed.rows) {
    const { lineNumber, cols } = row;
    const expect = (form, sources, expected) => {
      for (const source of sources) {
        const actual = normalizeFromTables(tables, cols[source], form);
        if (!sameScalars(actual, cols[expected])) {
          fail(`NormalizationTest.txt:${lineNumber}: ${form} mismatch from c${source + 1}`);
        }
      }
    };
    expect("NFC", [0, 1, 2], 1);
    expect("NFC", [3, 4], 3);
    expect("NFD", [0, 1, 2], 2);
    expect("NFD", [3, 4], 4);
    expect("NFKC", [0, 1, 2, 3, 4], 3);
    expect("NFKD", [0, 1, 2, 3, 4], 4);
  }
  return parsed.rows.length;
}

/**
 * UAX #15 NormalizationTest rule 2 says every assigned scalar absent from
 * Part 1 must normalize to itself in all four forms. The full row corpus does
 * not execute those one-scalar identities, so prove the generated-data side of
 * that rule separately: every source that can change under a generated
 * decomposition table (or algorithmic Hangul) must be explicitly present in
 * Part 1 column c1. CCC-only scalars have no singleton transformation.
 */
function assertPart1CoversAllTransformSources(part1, tables) {
  const requirePart1 = (cp, source) => {
    if (!part1.has(cp)) {
      fail(`${source} U+${cp.toString(16).toUpperCase()} is transformable but absent from NormalizationTest Part 1`);
    }
  };
  for (const cp of tables.canonicalIndex.keys) {
    requirePart1(cp, "canonical table source");
  }
  for (const cp of tables.compatibilityIndex.keys) {
    requirePart1(cp, "compatibility table source");
  }
  for (let cp = HANGUL_S_BASE; cp < HANGUL_S_BASE + HANGUL_S_COUNT; cp++) {
    requirePart1(cp, "algorithmic Hangul source");
  }
  return part1.size;
}

function formatTable(name, values, stride = 12) {
  const lines = [];
  for (let index = 0; index < values.length; index += stride) {
    lines.push(`  ${values.slice(index, index + stride).join(", ")},`);
  }
  return `export const ${name}: readonly number[] = [\n${lines.join("\n")}\n];\n`;
}

// Generated numeric payloads stay in deterministic fixed rows so the
// generator itself, rather than a formatter version, owns serialization.
// Prettier must leave each generated declaration intact.
function formatGeneratedTable(name, values, stride = 12) {
  return `// prettier-ignore\n${formatTable(name, values, stride)}`;
}

function valueChunkFileName(index) {
  return `normalize-ucd17-conformance-values-${index}.ts`;
}

function valueChunkExportName(index) {
  return `NORMALIZE_UCD17_VALUES_CHUNK_${index}`;
}

function splitNormalizationTestValues(values) {
  if (values.length < NORMALIZATION_TEST_VALUE_CHUNK_COUNT) {
    fail(`NormalizationTest values (${values.length}) cannot fill ${NORMALIZATION_TEST_VALUE_CHUNK_COUNT} chunks`);
  }
  const chunks = [];
  for (let index = 0; index < NORMALIZATION_TEST_VALUE_CHUNK_COUNT; index++) {
    const start = Math.floor((index * values.length) / NORMALIZATION_TEST_VALUE_CHUNK_COUNT);
    const end = Math.floor(((index + 1) * values.length) / NORMALIZATION_TEST_VALUE_CHUNK_COUNT);
    if (end <= start) fail(`NormalizationTest value chunk ${index} is empty`);
    chunks.push(values.slice(start, end));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total !== values.length) fail(`NormalizationTest value chunk total ${total} does not match ${values.length}`);
  return chunks;
}

function assertGeneratedFixtureFileSize(label, source) {
  const byteLength = Buffer.byteLength(source);
  if (byteLength >= GENERATED_FIXTURE_FILE_MAX_BYTES) {
    fail(`${label} is ${byteLength} bytes, exceeding generated fixture limit ${GENERATED_FIXTURE_FILE_MAX_BYTES - 1}`);
  }
  return byteLength;
}

function assertWasmFixedArrayBounds(tables) {
  const serialized = [
    ["canonical keys", tables.canonicalIndex.keys],
    ["canonical offsets", tables.canonicalIndex.offsets],
    ["canonical lengths", tables.canonicalIndex.lengths],
    ["canonical values", tables.canonicalValues],
    ["compatibility keys", tables.compatibilityIndex.keys],
    ["compatibility offsets", tables.compatibilityIndex.offsets],
    ["compatibility lengths", tables.compatibilityIndex.lengths],
    ["compatibility values", tables.compatibilityValues],
    ["CCC ranges", tables.cccRanges],
    ["composition pairs", tables.composition],
  ];
  let largest = 0;
  for (const [name, values] of serialized) {
    if (values.length > ARRAY_NEW_FIXED_MAX) {
      fail(`${name} has ${values.length} values, exceeding Wasm array.new_fixed maximum ${ARRAY_NEW_FIXED_MAX}`);
    }
    largest = Math.max(largest, values.length);
  }
  return largest;
}

function generatedSource(tables, normalizationTestRows, normalizationPart1Scalars, largestFixedArray) {
  const sourceComments = SOURCES.map((source) => ` * - ${source.url}\n *   sha256 ${source.sha256}`).join("\n");
  const counts = {
    canonicalEntries: tables.canonicalIndex.keys.length,
    canonicalScalars: tables.canonicalValues.length,
    compatibilityEntries: tables.compatibilityIndex.keys.length,
    compatibilityScalars: tables.compatibilityValues.length,
    cccRanges: tables.cccRanges.length / 3,
    compositionPairs: tables.composition.length / 3,
    normalizationTestRows,
    normalizationPart1Scalars,
    largestWasmFixedArray: largestFixedArray,
  };
  return `// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * GENERATED by scripts/gen-normalize-tables.mjs — DO NOT EDIT BY HAND.
 * Unicode ${UNICODE_VERSION} normalization data for pure-Wasm String#normalize.
${sourceComments}
 *
 * UnicodeData.txt has no version header; its exact URL and SHA-256 above are
 * the lock. The other two source files carry verified 17.0.0 headers. The
 * generator independently validates all ${normalizationTestRows} rows of the
 * pinned NormalizationTest.txt corpus through these serialized numeric tables
 * (plus the algorithmic Hangul rules) before writing this file. It also checks
 * all ${normalizationPart1Scalars} Part-1 c1 scalars cover every generated
 * singleton transformation source required by NormalizationTest rule 2.
 *
 * Each decomposition index is serialized as parallel codePoint, valueOffset,
 * and valueLength arrays. This keeps every Wasm array.new_fixed initializer
 * within the ${ARRAY_NEW_FIXED_MAX}-element engine limit; the largest emitted
 * table has ${largestFixedArray} elements. CCC ranges are [start, end, ccc]
 * triples. Composition entries are [first, second, composite] triples. Hangul
 * decomposition/composition is algorithmic code in normalize-native.ts, not
 * an incomplete generated syllable table.
${UNICODE_LICENSE_V3_COMMENT} */
export const NORMALIZE_UNICODE_VERSION = ${JSON.stringify(UNICODE_VERSION)};

// prettier-ignore
export const NORMALIZE_UCD_SOURCES = ${JSON.stringify(
    SOURCES.map((source) => ({ file: source.file, url: source.url, sha256: source.sha256 })),
    null,
    2,
  )} as const;

// prettier-ignore
export const NORMALIZE_TABLE_COUNTS = ${JSON.stringify(counts, null, 2)} as const;

${formatGeneratedTable("NORMALIZE_CANONICAL_KEYS", tables.canonicalIndex.keys, 12)}
${formatGeneratedTable("NORMALIZE_CANONICAL_OFFSETS", tables.canonicalIndex.offsets, 12)}
${formatGeneratedTable("NORMALIZE_CANONICAL_LENGTHS", tables.canonicalIndex.lengths, 12)}
${formatGeneratedTable("NORMALIZE_CANONICAL_VALUES", tables.canonicalValues, 12)}
${formatGeneratedTable("NORMALIZE_COMPATIBILITY_KEYS", tables.compatibilityIndex.keys, 12)}
${formatGeneratedTable("NORMALIZE_COMPATIBILITY_OFFSETS", tables.compatibilityIndex.offsets, 12)}
${formatGeneratedTable("NORMALIZE_COMPATIBILITY_LENGTHS", tables.compatibilityIndex.lengths, 12)}
${formatGeneratedTable("NORMALIZE_COMPATIBILITY_VALUES", tables.compatibilityValues, 12)}
${formatGeneratedTable("NORMALIZE_CCC_RANGES", tables.cccRanges, 9)}
${formatGeneratedTable("NORMALIZE_COMPOSITION_PAIRS", tables.composition, 9)}`;
}

/**
 * The conformance fixture intentionally contains Unicode scalars, not JS
 * strings. The later Wasm test encodes them to UTF-16 itself and crosses the
 * module boundary only through numeric exports, so this payload cannot turn
 * into a host-ICU oracle by accident.
 */
function flattenAssignedScalarRanges(ranges) {
  const values = [];
  let scalarCount = 0;
  let previousEnd = -1;
  for (const [start, end] of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 0x10ffff || end < start) {
      fail(`invalid assigned scalar range U+${start.toString(16)}..U+${end.toString(16)}`);
    }
    if (start <= previousEnd || (start <= 0xdfff && end >= 0xd800)) {
      fail(`overlapping or surrogate assigned scalar range U+${start.toString(16)}..U+${end.toString(16)}`);
    }
    values.push(start, end);
    scalarCount += end - start + 1;
    previousEnd = end;
  }
  if (values.length === 0) fail("no assigned scalar ranges to serialize");
  return { values, scalarCount };
}

function scalarIsInFlatRanges(ranges, scalar) {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const start = ranges[mid * 2];
    const end = ranges[mid * 2 + 1];
    if (scalar < start) high = mid - 1;
    else if (scalar > end) low = mid + 1;
    else return true;
  }
  return false;
}

function buildNormalizationTestFixture(parsed, assignedInventory) {
  const lineNumbers = [];
  const cellOffsets = [];
  const values = [];
  for (const row of parsed.rows) {
    lineNumbers.push(row.lineNumber);
    for (const column of row.cols) {
      cellOffsets.push(values.length);
      values.push(...column);
    }
  }
  cellOffsets.push(values.length);
  const part1Scalars = [...parsed.part1].sort((left, right) => left - right);
  const assigned = flattenAssignedScalarRanges(assignedInventory.assignedScalarRanges);
  if (assigned.scalarCount !== assignedInventory.assignedScalarCount) {
    fail(
      `assigned scalar inventory count mismatch: ranges=${assigned.scalarCount}, parsed=${assignedInventory.assignedScalarCount}`,
    );
  }
  for (const scalar of part1Scalars) {
    if (!scalarIsInFlatRanges(assigned.values, scalar)) {
      fail(
        `NormalizationTest.txt Part 1 includes U+${scalar.toString(16).toUpperCase()} outside UnicodeData assigned scalars`,
      );
    }
  }
  const rule2ScalarCount = assigned.scalarCount - part1Scalars.length;
  if (rule2ScalarCount < 0) fail("NormalizationTest.txt Part 1 exceeds the assigned scalar inventory");
  const payload = {
    format: 1,
    lineNumbers,
    cellOffsets,
    values,
    part1Scalars,
    assignedScalarRanges: assigned.values,
    assignedScalarCount: assigned.scalarCount,
    assignedPrivateUseScalarCount: assignedInventory.assignedPrivateUseScalarCount,
    assignedSurrogateCodePointCount: assignedInventory.assignedSurrogateCodePointCount,
    rule2ScalarCount,
  };
  return {
    ...payload,
    sha256: sha256(Buffer.from(JSON.stringify(payload))),
  };
}

function generatedConformanceValuesChunkSource(values, index, chunkCount) {
  const exportName = valueChunkExportName(index);
  return `// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * GENERATED by scripts/gen-normalize-tables.mjs — DO NOT EDIT BY HAND.
 * Unicode ${UNICODE_VERSION} NormalizationTest.txt scalar values part ${index + 1}/${chunkCount}.
 * Imported by normalize-ucd17-conformance.ts; split below Biome's 1 MiB limit.
${UNICODE_LICENSE_V3_COMMENT} */
${formatGeneratedTable(exportName, values, 12)}`;
}

function generatedConformanceFixtureSource(fixture, valueChunkCount) {
  const normalizationTestSource = SOURCES.find((source) => source.file === "NormalizationTest.txt");
  if (normalizationTestSource === undefined) fail("missing NormalizationTest.txt source contract");
  const relationCount = fixture.lineNumbers.length * 20;
  const valueChunkImports = [];
  const valueChunkSpreads = [];
  for (let index = 0; index < valueChunkCount; index++) {
    const exportName = valueChunkExportName(index);
    valueChunkImports.push(`import { ${exportName} } from "./${valueChunkFileName(index).replace(/\.ts$/u, ".js")}";`);
    valueChunkSpreads.push(`  ...${exportName},`);
  }
  return `// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * GENERATED by scripts/gen-normalize-tables.mjs — DO NOT EDIT BY HAND.
 * Compact Unicode ${UNICODE_VERSION} NormalizationTest.txt scalar corpus for
 * the emitted-Wasm String.prototype.normalize conformance test.
 *
 * Source: ${normalizationTestSource.url}
 * Source SHA-256: ${normalizationTestSource.sha256}
 * The payload is scalar values plus five-column cell offsets. It deliberately
 * contains no JavaScript strings or normalized host output. The test encodes
 * these values to UTF-16 and compares numeric Wasm exports only.
${UNICODE_LICENSE_V3_COMMENT} */
${valueChunkImports.join("\n")}

export const NORMALIZE_UCD17_CORPUS_FORMAT = ${fixture.format};
export const NORMALIZE_UCD17_UNICODE_VERSION = ${JSON.stringify(UNICODE_VERSION)};
export const NORMALIZE_UCD17_NORMALIZATION_TEST_SHA256 =
  ${JSON.stringify(normalizationTestSource.sha256)};
export const NORMALIZE_UCD17_CORPUS_PAYLOAD_SHA256 = ${JSON.stringify(fixture.sha256)};
export const NORMALIZE_UCD17_ROW_COUNT = ${fixture.lineNumbers.length};
export const NORMALIZE_UCD17_RELATION_COUNT = ${relationCount};
export const NORMALIZE_UCD17_PART1_C1_SCALAR_COUNT = ${fixture.part1Scalars.length};
// Every assigned non-surrogate code point from UnicodeData.txt. First/Last
// records are expanded before this compact [start, end] serialization, so
// private-use Co ranges are retained rather than inferred from a sampled table.
export const NORMALIZE_UCD17_ASSIGNED_SCALAR_COUNT = ${fixture.assignedScalarCount};
export const NORMALIZE_UCD17_ASSIGNED_PRIVATE_USE_SCALAR_COUNT = ${fixture.assignedPrivateUseScalarCount};
${formatGeneratedTable("NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES", fixture.assignedScalarRanges, 8)}
// Surrogates are assigned Unicode code points but not Unicode scalars. The
// emitted-Wasm test checks these UTF-16 code units separately in all four forms.
export const NORMALIZE_UCD17_ASSIGNED_SURROGATE_CODE_POINT_COUNT = ${fixture.assignedSurrogateCodePointCount};
export const NORMALIZE_UCD17_LONE_SURROGATE_CODE_UNIT_COUNT = 0x800;
export const NORMALIZE_UCD17_RULE2_SCALAR_COUNT = ${fixture.rule2ScalarCount};

// One original NormalizationTest.txt line number per row, for durable mismatch reports.
${formatGeneratedTable("NORMALIZE_UCD17_LINE_NUMBERS", fixture.lineNumbers, 12)}
// Five start offsets per row plus one final end offset, into NORMALIZE_UCD17_VALUES.
${formatGeneratedTable("NORMALIZE_UCD17_CELL_OFFSETS", fixture.cellOffsets, 12)}
// Flattened scalar values for every c1..c5 sequence, imported from fixed-size
// generated chunks so all fixture modules remain within Biome's file limit.
export const NORMALIZE_UCD17_VALUES: readonly number[] = [
${valueChunkSpreads.join("\n")}
];
// Unique c1 scalar values from @Part1, retained for the later UAX #15 Rule-2 gate.
${formatGeneratedTable("NORMALIZE_UCD17_PART1_C1_SCALARS", fixture.part1Scalars, 12)}`;
}

function parseInputDir() {
  const args = process.argv.slice(2);
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--input-dir" && args[1] !== "") return args[1];
  fail("usage: gen-normalize-tables.mjs [--input-dir <directory>]");
}

async function loadSource(source, inputDir) {
  let bytes;
  if (inputDir !== undefined) {
    bytes = await readFile(join(inputDir, source.file));
  } else {
    const response = await fetch(source.url);
    if (!response.ok) fail(`${source.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = sha256(bytes);
  if (digest !== source.sha256) fail(`${source.file}: SHA-256 mismatch (expected ${source.sha256}, got ${digest})`);
  const text = bytes.toString("utf8");
  if (source.header !== undefined && !text.startsWith(`${source.header}\n`)) {
    fail(`${source.file}: expected version header ${source.header}`);
  }
  return { bytes, text };
}

async function main() {
  const inputDir = parseInputDir();
  const sourceMap = new Map();
  for (const source of SOURCES) sourceMap.set(source.file, await loadSource(source, inputDir));
  const unicodeData = sourceMap.get("UnicodeData.txt");
  const derived = sourceMap.get("DerivedNormalizationProps.txt");
  const normalizationTest = sourceMap.get("NormalizationTest.txt");
  if (unicodeData === undefined || derived === undefined || normalizationTest === undefined)
    fail("missing loaded source");

  const assignedInventory = parseUnicodeData(unicodeData.text);
  const { records } = assignedInventory;
  const exclusions = parseFullCompositionExclusions(derived.text);
  const tables = buildTables(records, exclusions);
  const parsedNormalizationTest = parseNormalizationTest(normalizationTest.text);
  const normalizationTestRows = validateNormalizationTest(parsedNormalizationTest, tables);
  const normalizationPart1Scalars = assertPart1CoversAllTransformSources(parsedNormalizationTest.part1, tables);
  const largestWasmFixedArray = assertWasmFixedArrayBounds(tables);
  const output = generatedSource(tables, normalizationTestRows, normalizationPart1Scalars, largestWasmFixedArray);
  const outputPath = fileURLToPath(new URL("../src/codegen/normalize-tables.ts", import.meta.url));
  const fixture = buildNormalizationTestFixture(parsedNormalizationTest, assignedInventory);
  const valueChunks = splitNormalizationTestValues(fixture.values);
  const fixtureOutput = generatedConformanceFixtureSource(fixture, valueChunks.length);
  const fixturePath = fileURLToPath(new URL("../tests/fixtures/normalize-ucd17-conformance.ts", import.meta.url));
  const fixtureChunkOutputs = valueChunks.map((values, index) =>
    generatedConformanceValuesChunkSource(values, index, valueChunks.length),
  );
  const fixtureChunkPaths = valueChunks.map((_, index) =>
    fileURLToPath(new URL(`../tests/fixtures/${valueChunkFileName(index)}`, import.meta.url)),
  );
  const fixtureBytes = assertGeneratedFixtureFileSize("normalize-ucd17-conformance.ts", fixtureOutput);
  const fixtureChunkBytes = fixtureChunkOutputs.map((chunk, index) =>
    assertGeneratedFixtureFileSize(valueChunkFileName(index), chunk),
  );
  await writeFile(outputPath, output);
  await writeFile(fixturePath, fixtureOutput);
  for (let index = 0; index < fixtureChunkOutputs.length; index++) {
    await writeFile(fixtureChunkPaths[index], fixtureChunkOutputs[index]);
  }
  console.log(
    JSON.stringify(
      {
        unicode: UNICODE_VERSION,
        records: records.size,
        fullCompositionExclusions: exclusions.size,
        canonicalEntries: tables.canonicalIndex.keys.length,
        canonicalScalars: tables.canonicalValues.length,
        compatibilityEntries: tables.compatibilityIndex.keys.length,
        compatibilityScalars: tables.compatibilityValues.length,
        cccRanges: tables.cccRanges.length / 3,
        compositionPairs: tables.composition.length / 3,
        normalizationTestRows,
        normalizationPart1Scalars,
        assignedScalarRanges: fixture.assignedScalarRanges.length / 2,
        assignedScalars: fixture.assignedScalarCount,
        assignedPrivateUseScalars: fixture.assignedPrivateUseScalarCount,
        assignedSurrogateCodePoints: fixture.assignedSurrogateCodePointCount,
        normalizationTestRule2Scalars: fixture.rule2ScalarCount,
        normalizationTestPayloadSha256: fixture.sha256,
        normalizationTestFixture: fixturePath,
        normalizationTestFixtureBytes: fixtureBytes,
        normalizationTestValueChunkPaths: fixtureChunkPaths,
        normalizationTestValueChunkBytes: fixtureChunkBytes,
        largestNormalizationTestFixtureFileBytes: Math.max(fixtureBytes, ...fixtureChunkBytes),
        largestWasmFixedArray,
        output: outputPath,
      },
      null,
      2,
    ),
  );
}

await main();
