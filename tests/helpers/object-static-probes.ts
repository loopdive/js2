// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 O1) Source helpers the `Object` statics probes share, written in what the Prepared path lowers today: no
// array, no `instanceof TypeError` (the global is not in scope there; the realm's error carries its name).

/** `t(f)`: `f()`'s outcome as a letter: "T" for a TypeError, "x" for another throw, "-" for none. */
export const CATCHES =
  "function t(f){ try { f(); return '-'; } catch (e) { return e.name === 'TypeError' ? 'T' : 'x'; } }";

/** `fields(d)`: a descriptor's six fields as text, or "u" for `undefined`. */
export const FIELDS =
  "function fields(d){ return d === undefined ? 'u' : String(d.value) + ',' + String(d.writable) + ',' +" +
  " (d.get === undefined ? 'g' : 'G') + ',' + (d.set === undefined ? 's' : 'S') + ',' + String(d.enumerable) + ',' + String(d.configurable); }";
