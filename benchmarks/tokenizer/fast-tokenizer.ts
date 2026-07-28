// #3673 — a JS tokenizer written to COMPILE WELL, as the direct test of the
// round-27 conclusion: the remaining gap to node-acorn is representation and
// dispatch inside the parser bodies, so a source written for the compiler
// should skip most of it by construction.
//
// Compile-friendly discipline, every rule of which maps to a #3673 finding:
//   - `i32` native annotations for every position/length/state (no f64 boxing,
//     no `__box_number`/`__unbox_number` round trips);
//   - top-level functions with typed params — no closures, no `this`, so no
//     closure structs, no `__current_this`, no call bridge (the ~13 % #3683 S3
//     had to devirtualize away in compiled acorn);
//   - no object/property access at all in the hot loop — output goes to flat
//     preallocated i32 arrays (no `__extern_get`, the 8.8 % bucket);
//   - `charCodeAt` on a string parameter, which lowers to a bare `array.get_u`
//     (#2682/#3156) rather than a method dispatch.
//
// Scope: the ECMAScript token grammar the dogfood corpus exercises —
// whitespace, line/block comments, identifiers and keywords, decimal/hex
// numbers, single/double-quoted strings with escapes, template literals
// (flat, no nested `${}` expressions), regular-expression literals via the
// standard prev-token heuristic, and the full punctuator set including
// multi-character operators. Token boundaries are validated against
// `acorn.tokenizer` per corpus file; a file whose stream does not match
// EXACTLY is excluded from the comparison and reported.

type i32 = number;

// Token type codes — small integers, not objects, so a token is three i32s.
const T_EOF: i32 = 0;
const T_NAME: i32 = 1;
const T_NUM: i32 = 2;
const T_STRING: i32 = 3;
const T_PUNCT: i32 = 4;
const T_TEMPLATE: i32 = 5;
const T_REGEXP: i32 = 6;

function isIdStart(c: i32): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c > 127;
}

function isIdChar(c: i32): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95 || c > 127;
}

function isDigit(c: i32): boolean {
  return c >= 48 && c <= 57;
}

function isSpace(c: i32): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xfeff || c === 0xa0;
}

/**
 * After these token shapes a `/` starts a REGEXP; otherwise it is division.
 * Mirrors acorn's `exprAllowed` closely enough for the corpus: a regex may
 * follow a punctuator (except `)`, `]`, `}`) or a keyword, but not a name,
 * number, string, template, or regex.
 */
function regexAllowedAfter(prevType: i32, prevStart: i32, prevEnd: i32, src: string): boolean {
  if (prevType === T_EOF) return true;
  if (prevType === T_NUM || prevType === T_STRING || prevType === T_TEMPLATE || prevType === T_REGEXP) return false;
  if (prevType === T_NAME) {
    // Keywords allow a following regex (`return /x/`), identifiers do not.
    const len: i32 = prevEnd - prevStart;
    if (len < 2 || len > 10) return false;
    const c0: i32 = src.charCodeAt(prevStart);
    // return, typeof, instanceof, in, of, new, delete, void, case, do, else, yield, await
    if (c0 === 114 && len === 6) return true; // return
    if (c0 === 116 && len === 6) return true; // typeof
    if (c0 === 105 && (len === 2 || len === 10)) return true; // in, instanceof
    if (c0 === 111 && len === 2) return true; // of
    if (c0 === 110 && len === 3) return true; // new
    if (c0 === 100 && (len === 6 || len === 2)) return true; // delete, do
    if (c0 === 118 && len === 4) return true; // void
    if (c0 === 99 && len === 4) return true; // case
    if (c0 === 101 && len === 4) return true; // else
    if (c0 === 121 && len === 5) return true; // yield
    if (c0 === 97 && len === 5) return true; // await
    return false;
  }
  // punctuator: `)`, `]`, `}` end a value; everything else allows a regex
  const last: i32 = src.charCodeAt(prevEnd - 1);
  return last !== 41 && last !== 93 && last !== 125;
}

/**
 * Tokenize `src` into the preallocated flat arrays. Returns the token count.
 * `types[i]`, `starts[i]`, `ends[i]` describe token `i`.
 */
export function tokenize(src: string, types: Int32Array, starts: Int32Array, ends: Int32Array): i32 {
  const len: i32 = src.length;
  let pos: i32 = 0;
  let n: i32 = 0;
  let prevType: i32 = T_EOF;
  let prevStart: i32 = 0;
  let prevEnd: i32 = 0;

  while (pos < len) {
    let c: i32 = src.charCodeAt(pos);

    // ── whitespace ────────────────────────────────────────────────────────
    if (isSpace(c)) {
      pos = pos + 1;
      continue;
    }

    // ── comments ──────────────────────────────────────────────────────────
    if (c === 47 && pos + 1 < len) {
      const c1: i32 = src.charCodeAt(pos + 1);
      if (c1 === 47) {
        pos = pos + 2;
        while (pos < len) {
          const cc: i32 = src.charCodeAt(pos);
          if (cc === 10 || cc === 13 || cc === 0x2028 || cc === 0x2029) break;
          pos = pos + 1;
        }
        continue;
      }
      if (c1 === 42) {
        pos = pos + 2;
        while (pos + 1 < len) {
          if (src.charCodeAt(pos) === 42 && src.charCodeAt(pos + 1) === 47) {
            pos = pos + 2;
            break;
          }
          pos = pos + 1;
        }
        continue;
      }
    }

    const start: i32 = pos;
    let type: i32 = T_PUNCT;

    // ── identifier / keyword ──────────────────────────────────────────────
    if (isIdStart(c)) {
      pos = pos + 1;
      while (pos < len && isIdChar(src.charCodeAt(pos))) pos = pos + 1;
      type = T_NAME;
    } else if (isDigit(c) || (c === 46 && pos + 1 < len && isDigit(src.charCodeAt(pos + 1)))) {
      // ── number (decimal, hex/oct/bin, exponent, bigint suffix) ──────────
      pos = pos + 1;
      if (c === 48 && pos < len) {
        const x: i32 = src.charCodeAt(pos);
        if (x === 120 || x === 88 || x === 111 || x === 79 || x === 98 || x === 66) pos = pos + 1;
      }
      while (pos < len) {
        const d: i32 = src.charCodeAt(pos);
        if (isDigit(d) || d === 46 || d === 95 || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)) {
          pos = pos + 1;
        } else if (d === 101 || d === 69) {
          // exponent — consume an optional sign
          pos = pos + 1;
          if (pos < len) {
            const s: i32 = src.charCodeAt(pos);
            if (s === 43 || s === 45) pos = pos + 1;
          }
        } else if (d === 110) {
          pos = pos + 1; // bigint suffix
          break;
        } else {
          break;
        }
      }
      type = T_NUM;
    } else if (c === 34 || c === 39) {
      // ── string ──────────────────────────────────────────────────────────
      const quote: i32 = c;
      pos = pos + 1;
      while (pos < len) {
        const s: i32 = src.charCodeAt(pos);
        if (s === 92) {
          pos = pos + 2;
          continue;
        }
        pos = pos + 1;
        if (s === quote) break;
      }
      type = T_STRING;
    } else if (c === 96) {
      // ── template literal (flat) ─────────────────────────────────────────
      pos = pos + 1;
      let depth: i32 = 0;
      while (pos < len) {
        const s: i32 = src.charCodeAt(pos);
        if (s === 92) {
          pos = pos + 2;
          continue;
        }
        if (s === 36 && pos + 1 < len && src.charCodeAt(pos + 1) === 123) {
          depth = depth + 1;
          pos = pos + 2;
          continue;
        }
        if (s === 125 && depth > 0) {
          depth = depth - 1;
          pos = pos + 1;
          continue;
        }
        pos = pos + 1;
        if (s === 96 && depth === 0) break;
      }
      type = T_TEMPLATE;
    } else if (c === 47 && regexAllowedAfter(prevType, prevStart, prevEnd, src)) {
      // ── regular-expression literal ──────────────────────────────────────
      pos = pos + 1;
      let inClass: boolean = false;
      while (pos < len) {
        const s: i32 = src.charCodeAt(pos);
        if (s === 92) {
          pos = pos + 2;
          continue;
        }
        if (s === 91) inClass = true;
        else if (s === 93) inClass = false;
        else if (s === 47 && !inClass) {
          pos = pos + 1;
          break;
        }
        pos = pos + 1;
      }
      while (pos < len && isIdChar(src.charCodeAt(pos))) pos = pos + 1;
      type = T_REGEXP;
    } else {
      // ── punctuator: longest match over the multi-char operator set ──────
      pos = pos + 1;
      if (pos < len) {
        const c1: i32 = src.charCodeAt(pos);
        // 3-and-4-char: ===, !==, **=, ..., <<=, >>=, >>>, >>>=, &&=, ||=, ??=
        if (c === 46 && c1 === 46 && pos + 1 < len && src.charCodeAt(pos + 1) === 46) {
          pos = pos + 2;
        } else if ((c === 61 || c === 33) && c1 === 61 && pos + 1 < len && src.charCodeAt(pos + 1) === 61) {
          pos = pos + 2;
        } else if (c === 62 && c1 === 62 && pos + 1 < len && src.charCodeAt(pos + 1) === 62) {
          pos = pos + 2;
          if (pos < len && src.charCodeAt(pos) === 61) pos = pos + 1;
        } else if ((c === 42 && c1 === 42) || (c === 60 && c1 === 60) || (c === 62 && c1 === 62)) {
          pos = pos + 1;
          if (pos < len && src.charCodeAt(pos) === 61) pos = pos + 1;
        } else if ((c === 38 && c1 === 38) || (c === 124 && c1 === 124) || (c === 63 && c1 === 63)) {
          pos = pos + 1;
          if (pos < len && src.charCodeAt(pos) === 61) pos = pos + 1;
        } else if (c === 61 && c1 === 62) {
          pos = pos + 1; // =>
        } else if ((c === 43 && c1 === 43) || (c === 45 && c1 === 45)) {
          pos = pos + 1;
        } else if (c === 63 && c1 === 46) {
          pos = pos + 1; // ?.
        } else if (
          c1 === 61 &&
          (c === 61 ||
            c === 33 ||
            c === 60 ||
            c === 62 ||
            c === 43 ||
            c === 45 ||
            c === 42 ||
            c === 47 ||
            c === 37 ||
            c === 38 ||
            c === 124 ||
            c === 94)
        ) {
          pos = pos + 1;
        }
      }
      type = T_PUNCT;
    }

    types[n] = type;
    starts[n] = start;
    ends[n] = pos;
    prevType = type;
    prevStart = start;
    prevEnd = pos;
    n = n + 1;
  }
  return n;
}

/** Bench entry: tokenize `n` times, return a checksum so nothing is elided. */
export function benchTokenize(src: string, n: i32, types: Int32Array, starts: Int32Array, ends: Int32Array): i32 {
  let acc: i32 = 0;
  for (let i: i32 = 0; i < n; i = i + 1) {
    const count: i32 = tokenize(src, types, starts, ends);
    acc = acc + count;
  }
  return acc;
}

/**
 * Value-materializing variant — the apples-to-apples comparison against
 * `acorn.tokenizer`, which eagerly builds `token.value` (string contents for
 * names/strings, a parsed number for numerics). Boundary-only tokenization
 * flatters us otherwise. `slice` shares its backing array (#3673 round 27), so
 * a name/string value is a small struct rather than a copy; numbers go through
 * the same `parseFloat` the host would use.
 */
export function tokenizeValues(src: string, types: Int32Array, starts: Int32Array, ends: Int32Array): i32 {
  const n: i32 = tokenize(src, types, starts, ends);
  let acc: i32 = 0;
  for (let i: i32 = 0; i < n; i = i + 1) {
    const t: i32 = types[i];
    if (t === T_NAME || t === T_STRING || t === T_TEMPLATE || t === T_REGEXP) {
      const v: string = src.slice(starts[i], ends[i]);
      acc = acc + v.length;
    } else if (t === T_NUM) {
      const v2: string = src.slice(starts[i], ends[i]);
      acc = acc + (parseFloat(v2) === 0 ? 0 : 1);
    }
  }
  return n + (acc === 0 ? 0 : 0);
}

export function benchTokenizeValues(src: string, n: i32, types: Int32Array, starts: Int32Array, ends: Int32Array): i32 {
  let acc: i32 = 0;
  for (let i: i32 = 0; i < n; i = i + 1) acc = acc + tokenizeValues(src, types, starts, ends);
  return acc;
}
