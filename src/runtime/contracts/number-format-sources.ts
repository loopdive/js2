// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Exact source versions. V1 remains historical; V2 adds the integer count/fill fast path.
const original = `
export function __sh_num_toString_radix(value: number, radix: number): string {
  if (value !== value) { return "NaN"; }
  if (value > 1.7976931348623157e308) { return "Infinity"; }
  if (value < -1.7976931348623157e308) { return "-Infinity"; }
  let neg: boolean = value < 0;
  let abs: number = value;
  if (neg) { abs = 0 - value; }
  let r: number = Math.floor(radix);
  if (abs === 0) { return "0"; }
  let intPart: number = Math.floor(abs);
  let frac: number = abs - intPart;
  if (intPart > 9007199254740991) { __num_fmt_trap(); }
  let buf = __nfd_new(256);
  let pos: number = 0;
  let n: number = intPart;
  while (n > 0) {
    let q: number = Math.floor(n / r);
    let digit: number = n - q * r;
    let code: number = 48 + digit;
    if (digit >= 10) { code = 87 + digit; }
    __nfd_set(buf, pos, code);
    pos = pos + 1;
    n = q;
  }
  if (pos === 0) {
    __nfd_set(buf, pos, 48);
    pos = pos + 1;
  }
  if (neg) {
    __nfd_set(buf, pos, 45);
    pos = pos + 1;
  }
  let i: number = 0;
  let j: number = pos - 1;
  while (i < j) {
    let t: number = __nfd_get(buf, i);
    __nfd_set(buf, i, __nfd_get(buf, j));
    __nfd_set(buf, j, t);
    i = i + 1;
    j = j - 1;
  }
  if (frac > 0) {
    __nfd_set(buf, pos, 46);
    pos = pos + 1;
    let k: number = 0;
    while (frac > 0 && k < 100) {
      frac = frac * r;
      let fdigit: number = Math.floor(frac);
      frac = frac - fdigit;
      let fcode: number = 48 + fdigit;
      if (fdigit >= 10) { fcode = 87 + fdigit; }
      __nfd_set(buf, pos, fcode);
      pos = pos + 1;
      k = k + 1;
    }
  }
  return __nfd_fin(buf, pos);
}
`;
const integerFastPath = `
export function __sh_num_toString_radix(value: number, radix: number): string {
  if (value !== value) { return "NaN"; }
  if (value > 1.7976931348623157e308) { return "Infinity"; }
  if (value < -1.7976931348623157e308) { return "-Infinity"; }
  let neg: boolean = value < 0;
  let abs: number = value;
  if (neg) { abs = 0 - value; }
  let r: number = Math.floor(radix);
  if (abs === 0) { return "0"; }
  let intPart: number = Math.floor(abs);
  let frac: number = abs - intPart;
  if (intPart > 9007199254740991) { __num_fmt_trap(); }
  if (frac === 0) {
    let len: number = 0;
    let t: number = intPart;
    while (t > 0) {
      t = Math.floor(t / r);
      len = len + 1;
    }
    if (neg) { len = len + 1; }
    let ibuf = __nfd_new(len);
    let p: number = len - 1;
    let m: number = intPart;
    while (m > 0) {
      let iq: number = Math.floor(m / r);
      let idigit: number = m - iq * r;
      let icode: number = 48 + idigit;
      if (idigit >= 10) { icode = 87 + idigit; }
      __nfd_set(ibuf, p, icode);
      p = p - 1;
      m = iq;
    }
    if (neg) { __nfd_set(ibuf, 0, 45); }
    return __nfd_fin(ibuf, len);
  }
  let buf = __nfd_new(256);
  let pos: number = 0;
  let n: number = intPart;
  while (n > 0) {
    let q: number = Math.floor(n / r);
    let digit: number = n - q * r;
    let code: number = 48 + digit;
    if (digit >= 10) { code = 87 + digit; }
    __nfd_set(buf, pos, code);
    pos = pos + 1;
    n = q;
  }
  if (pos === 0) {
    __nfd_set(buf, pos, 48);
    pos = pos + 1;
  }
  if (neg) {
    __nfd_set(buf, pos, 45);
    pos = pos + 1;
  }
  let i: number = 0;
  let j: number = pos - 1;
  while (i < j) {
    let t: number = __nfd_get(buf, i);
    __nfd_set(buf, i, __nfd_get(buf, j));
    __nfd_set(buf, j, t);
    i = i + 1;
    j = j - 1;
  }
  if (frac > 0) {
    __nfd_set(buf, pos, 46);
    pos = pos + 1;
    let k: number = 0;
    while (frac > 0 && k < 100) {
      frac = frac * r;
      let fdigit: number = Math.floor(frac);
      frac = frac - fdigit;
      let fcode: number = 48 + fdigit;
      if (fdigit >= 10) { fcode = 87 + fdigit; }
      __nfd_set(buf, pos, fcode);
      pos = pos + 1;
      k = k + 1;
    }
  }
  return __nfd_fin(buf, pos);
}
`;

export const NATIVE_RADIX_SOURCES = Object.freeze({
  1: Object.freeze({
    source: original,
    provenance: Object.freeze({
      definition: "numToStringRadixDef",
      functionName: "__sh_num_toString_radix",
      utf8Bytes: 1618,
      sha256: "7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6",
    } as const),
  }),
  2: Object.freeze({
    source: integerFastPath,
    provenance: Object.freeze({
      definition: "numToStringRadixDef",
      functionName: "__sh_num_toString_radix",
      utf8Bytes: 2226,
      sha256: "1a09c01c1bd3577b05db730d518995b3ff5317e82decdd64901dcd242601232d",
    } as const),
  }),
});
export type NativeRadixSourceVersion = keyof typeof NATIVE_RADIX_SOURCES;
