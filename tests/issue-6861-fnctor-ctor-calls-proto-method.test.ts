// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6861 — in `--target standalone`, a function constructor whose body calls a
 * method from its own prototype (`function Hash() { this.clear(); }`) must
 * reach that method from every `new Hash` site.
 *
 * The #2660 escape gate classified a site like `{ hash: new Hash }` as
 * `keep-static`, which lowers the instance to a struct with no prototype link.
 * The constructor's own `this.clear()` then found nothing and threw
 * `TypeError: called value is not a function`. lodash's module init died this
 * way (`memoize` → `new MapCache` → `mapCacheClear` → `new Hash`).
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "fnctor-self-call.js",
    emitWat: false,
    runtimeEvalProvider: false,
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  return (instance.exports.run as () => number)();
}

/** The minimal shape: the only `new Hash` site is an object-literal value. */
const LITERAL_SITE = `
var out = 0;
function ric() {
  function Hash() {
    this.clear();
  }
  function hashClear() {
    this.size = 0;
  }
  Hash.prototype.clear = hashClear;
  function make() {
    return { h: new Hash };
  }
  var d = make();
  out += 1;
  if (d.h.size === 0) out += 2;
}
ric();
export function run() { return out; }
`;

/** lodash's cache stack: memoize → new (Cache || MapCache) → new Hash, new ListCache. */
const LODASH_CACHES = `
var out = 0;
function ric(context) {
  var nativeCreate = context.Object.create;
  var Map = undefined;
  function Hash(entries) {
    var index = -1, length = entries == null ? 0 : entries.length;
    this.clear();
    while (++index < length) { var entry = entries[index]; this.set(entry[0], entry[1]); }
  }
  function hashClear() { this.__data__ = nativeCreate ? nativeCreate(null) : {}; this.size = 0; }
  function hashGet(key) { return this.__data__[key]; }
  function hashSet(key, value) {
    var data = this.__data__;
    this.size += data[key] === undefined ? 1 : 0;
    data[key] = value;
    return this;
  }
  Hash.prototype.clear = hashClear;
  Hash.prototype.get = hashGet;
  Hash.prototype.set = hashSet;
  function ListCache(entries) { this.clear(); }
  function listCacheClear() { this.__data__ = []; this.size = 0; }
  ListCache.prototype.clear = listCacheClear;
  function MapCache(entries) {
    var index = -1, length = entries == null ? 0 : entries.length;
    this.clear();
    while (++index < length) { var entry = entries[index]; this.set(entry[0], entry[1]); }
  }
  function mapCacheClear() {
    this.size = 0;
    this.__data__ = { 'hash': new Hash, 'map': new (Map || ListCache), 'string': new Hash };
  }
  function mapCacheGet(key) { return this.__data__.string.get(key); }
  function mapCacheSet(key, value) { this.__data__.string.set(key, value); return this; }
  MapCache.prototype.clear = mapCacheClear;
  MapCache.prototype.get = mapCacheGet;
  MapCache.prototype.set = mapCacheSet;
  function memoize(func) {
    var memoized = function () { return func.apply(this, arguments); };
    memoized.cache = new (memoize.Cache || MapCache);
    return memoized;
  }
  var m = memoize(function (s) { return s; });
  out += 1;
  if (m.cache.__data__.hash.size === 0) out += 2;
  m.cache.set('k', 5);
  if (m.cache.get('k') === 5) out += 4;
  if (m.cache.__data__.map.size === 0) out += 8;
}
ric(globalThis);
export function run() { return out; }
`;

/**
 * Anti-vacuity control: the same constructor, constructed through a binding
 * that is read dynamically, was already approved by the gate and passes with
 * and without the fix.
 */
const BOUND_SITE_CONTROL = `
var out = 0;
function ric() {
  function Hash() {
    this.clear();
  }
  function hashClear() {
    this.size = 0;
  }
  Hash.prototype.clear = hashClear;
  var x = new Hash();
  out += 1;
  if (x.size === 0) out += 2;
}
ric();
export function run() { return out; }
`;

describe("#6861 standalone fnctor constructor calling its own prototype method", () => {
  it("an object-literal `new F` site reaches the prototype method the constructor calls", async () => {
    expect(await runStandalone(LITERAL_SITE)).toBe(3);
  });

  it("lodash's memoize/MapCache/Hash/ListCache stack constructs and answers", async () => {
    expect(await runStandalone(LODASH_CACHES)).toBe(15);
  });

  it("control: a bound, dynamically read site already worked", async () => {
    expect(await runStandalone(BOUND_SITE_CONTROL)).toBe(3);
  });
});
