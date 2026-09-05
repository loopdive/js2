// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4527 — the reference-preserving dynamic-call bridge (`__call_dyn_<n>`).
//
// A call on an `any`-typed KNOWN variable whose closure wrapper candidates
// were not registered when the calling body compiled — the cross-module case:
// `cb.mjs`'s `callIt(cb) { return cb(2, 3); }` compiles before `main.ts`'s
// arrow argument exists — used to lower to a graceful `ref.null.extern`, so
// the callee was silently never invoked (diff-sequences' isCommon /
// foundSubsequence shape). The bridge routes the call through the host with
// every argument crossing as externref: numbers boxed (and unboxed host-side),
// reference args passed LIVE.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(files: Record<string, string>, entry: string, expectedImports: readonly string[] = []) {
  const result = await compileMulti(files, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
  for (const name of expectedImports) {
    expect(
      result.imports?.some((entry) => entry.name === name),
      `missing ${name} import`,
    ).toBe(true);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as Record<string, Function>).__module_init?.();
  return wrapExports(instance.exports as Record<string, Function>) as Record<string, () => unknown>;
}

describe("issue #4527: cross-module dynamic callback invocation", () => {
  it("routes mixed spreads to arguments for zero-formal class methods", async () => {
    const w = await run(
      {
        "./main.js": `
          class C {
            method() {
              return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
            }
          }
          export function t() {
            const tail = [2, 3];
            return C.prototype.method(42, ...[1], ...tail,);
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(52);
  });

  it("reads reflective array carriers through canonical dynamic string indices", async () => {
    const w = await run(
      {
        "./main.js": `
          export function t(key) {
            const names = Object.getOwnPropertyNames({ answer: 42 });
            return names[key];
          }
        `,
      },
      "./main.js",
      ["__extern_get"],
    );
    expect(w.t("0")).toBe("answer");
  });

  it("keeps class methods on the prototype through borrowed hasOwnProperty", async () => {
    const w = await run(
      {
        "./main.js": `
          export function t() {
            class C {
              field = 1;
              method() { return 42; }
            }
            const value = new C();
            const hasOwn = Object.prototype.hasOwnProperty;
            return (!hasOwn.call(value, 'method') ? 1 : 0)
              + (hasOwn.call(value, 'field') ? 2 : 0)
              + (value.method() === 42 ? 4 : 0);
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(7);
  });

  it("preserves an Object.create result through a callback-driven strategy", async () => {
    const w = await run(
      {
        "./utils.js": `
          const { toString } = Object.prototype;
          const { getPrototypeOf } = Object;
          const { iterator, toStringTag } = Symbol;
          const kindOf = (value) => toString.call(value).slice(8, -1).toLowerCase();
          function forEach(values, callback) {
            for (let index = 0; index < values.length; index++) {
              callback.call(null, values[index], index, values);
            }
          }
          function hasOwnProp(object, property) {
            return Object.prototype.hasOwnProperty.call(object, property);
          }
          function isUndefined(value) { return typeof value === 'undefined'; }
          function isPlainObject(value) {
            if (kindOf(value) !== 'object') return false;
            const prototype = getPrototypeOf(value);
            return (
              (prototype === null ||
                prototype === Object.prototype ||
                Object.getPrototypeOf(prototype) === null) &&
              !(toStringTag in value) &&
              !(iterator in value)
            );
          }
          const { isArray } = Array;
          export default { forEach, hasOwnProp, isUndefined, isPlainObject, isArray };
        `,
        "./strategy.js": `
          import utils from './utils.js';
          export function mergeConfig(config1, config2) {
            function getMergedValue(source) {
              if (utils.isPlainObject(source)) return { ...source };
              if (utils.isArray(source)) return source.slice();
              return source;
            }
            function valueFromConfig2(a, b) {
              if (!utils.isUndefined(b)) return getMergedValue(b);
            }
            const config = Object.create(null);
            const mergeMap = { data: valueFromConfig2 };
            utils.forEach(Object.keys({ ...config1, ...config2 }), function compute(prop) {
              const merge = utils.hasOwnProp(mergeMap, prop) ? mergeMap[prop] : valueFromConfig2;
              const a = utils.hasOwnProp(config1, prop) ? config1[prop] : undefined;
              const b = utils.hasOwnProp(config2, prop) ? config2[prop] : undefined;
              config[prop] = merge(a, b, prop);
            });
            return config;
          }
        `,
        "./main.js": `
          import { mergeConfig } from './strategy.js';
          function expectValue(actual) {
            return {
              toBe(expected) { return Object.is(actual, expected) ? 1 : 0; }
            };
          }
          export function t() {
            const value = Object.create({});
            const merged = mergeConfig({}, { data: value });
            return expectValue(merged.data).toBe(value);
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(1);
  });

  it("materializes a nested fallback captured only by a host callback", async () => {
    const w = await run(
      {
        "./utils.js": `
          function forEach(values, callback) {
            for (let index = 0; index < values.length; index++) {
              callback.call(null, values[index], index, values);
            }
          }
          function hasOwnProp(object, property) {
            return Object.prototype.hasOwnProperty.call(object, property);
          }
          export default { forEach, hasOwnProp };
        `,
        "./strategy.js": `
          import utils from './utils.js';
          export function select(useTable) {
            function fallback(value) { return value + 1; }
            function tableValue(value) { return value + 2; }
            const mergeMap = { known: tableValue };
            const prop = useTable ? 'known' : 'other';
            let result = 0;
            utils.forEach([prop], function compute(current) {
              const merge = utils.hasOwnProp(mergeMap, current)
                ? mergeMap[current]
                : fallback;
              result = merge(41);
            });
            return result;
          }
        `,
        "./main.js": `
          import { select } from './strategy.js';
          export function t(useTable) { return select(useTable); }
        `,
      },
      "./main.js",
    );
    expect(w.t(1)).toBe(43);
    expect(w.t(0)).toBe(42);
  });

  it("keeps static-method this live for computed class-object writes", async () => {
    const w = await run(
      {
        "./utils.mjs": `
          const { isArray } = Array;
          export default { isArray };
        `,
        "./headers.mjs": `
          import utils from './utils.mjs';
          const internals = Symbol('internals');
          export default class Headers {
            static accessor(header) {
              const state = { accessors: {} };
              const accessors = state.accessors;
              const prototype = this.prototype;
              accessors.accept = true;
              let result = 0;
              if (utils.isArray(header)) result += 8;
              if (accessors.accept) result += 4;
              if (prototype !== undefined) result += 2;
              if (typeof header === 'object') result += 1;
              return result;
            }
          }
        `,
        "./main.ts": `
          import Headers from './headers.mjs';
          const initialized = Headers.accessor(['Accept']);
          export function t(): number { return initialized; }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(15);
  });

  it("constructs a class forwarded through a default identifier export", async () => {
    const w = await run(
      {
        "./error.mjs": `
          class PackageError extends Error {
            static from(message) { return new PackageError(message); }
            constructor(message) {
              super(message);
              this.code = 'PACKAGE_ERROR';
            }
          }
          PackageError.STATIC_CODE = 'STATIC';
          export default PackageError;
        `,
        "./main.mjs": `
          import RenamedError from './error.mjs';
          export function t() {
            const direct = new RenamedError('direct');
            const derived = RenamedError.from('derived');
            return direct.code === 'PACKAGE_ERROR' &&
              direct.message === 'direct' &&
              RenamedError.STATIC_CODE === 'STATIC' &&
              derived.message === 'derived' &&
              derived instanceof RenamedError ? 1 : 0;
          }
        `,
      },
      "./main.mjs",
    );
    expect(w.t()).toBe(1);
  });

  it("links a default-exported object expression through a live module cell", async () => {
    const w = await run(
      {
        "./utils.mjs": `
          const { toString } = Object.prototype;
          const kindOf = ((cache) => (thing) => {
            const str = toString.call(thing);
            return cache[str] || (cache[str] = str.slice(8, -1).toLowerCase());
          })(Object.create(null));
          export default { kindOf };
        `,
        "./main.ts": `
          import utils from './utils.mjs';
          const { kindOf } = utils;
          export function t(): string {
            return kindOf({}) + '|' + kindOf({}) + '|' + kindOf([]);
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("object|object|array");
  });

  it("calls a host builtin extracted through object destructuring", async () => {
    const w = await run(
      {
        "./main.ts": `
          const { getPrototypeOf } = Object;
          const _global = (() => {
            if (typeof globalThis !== 'undefined') return globalThis;
            return null;
          })();
          const TypedArray = typeof Uint8Array !== 'undefined' && getPrototypeOf(Uint8Array);

          export function t(): string {
            const globalState = _global === null ? 'null' : _global === undefined ? 'undefined' : typeof _global;
            return globalState + '|' + typeof globalThis + '|' + String(typeof globalThis !== 'undefined') + '|' + typeof TypedArray;
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("object|object|true|function");
  });

  it("keeps symbol-keyed class statics live through a static method receiver", async () => {
    const w = await run(
      {
        "./main.ts": `
          const internalsKey = Symbol('internals');
          class Headers {
            static accessor(): number {
              const internals = (this[internalsKey] = this[internalsKey] = { accessors: {} });
              const accessors = internals.accessors;
              accessors.accept = true;
              return accessors.accept ? 1 : 0;
            }
          }
          const initialized = Headers.accessor();
          export function t(): number { return initialized; }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(1);
  });

  it("initializes a dependency's default object before an importing module uses it", async () => {
    const w = await run(
      {
        "./utils.mjs": `
          const isArray = (value) => Array.isArray(value);
          export default { isArray };
        `,
        "./headers.mjs": `
          import utils from './utils.mjs';
          class Headers {
            static accessor(header) { return utils.isArray(header) ? 1 : 0; }
          }
          export const initialized = Headers.accessor([]);
          export function readAfterInit() { return utils.isArray([]) ? 2 : 0; }
          export default Headers;
        `,
        "./main.ts": `
          import { initialized, readAfterInit } from './headers.mjs';
          export function t(): number { return initialized * 10 + readAfterInit(); }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(12);
  });

  it("recognizes a concrete array carrier through an unannotated JS parameter", async () => {
    const w = await run(
      {
        "./array.mjs": `
          export function isArray(value) { return Array.isArray(value); }
        `,
        "./main.ts": `
          import { isArray } from './array.mjs';
          export function t(): string { return String(isArray([])) + '|' + String(isArray({})); }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("true|false");
  });

  it("destructures a host object passed back into a compiled callback", async () => {
    const w = await run(
      {
        "./main.ts": `
          function invoke(fn) {
            return fn.call(null, { value: 7 }, 'x');
          }
          export function t(): number {
            return invoke(({ value }, key) => value + key.length);
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(8);
  });

  it("binds a destructured IIFE parameter before a nested closure captures it", async () => {
    const w = await run(
      {
        "./main.ts": `
          const owns = (({ hasOwnProperty: own }) =>
            (object, property) => own.call(object, property)
          )(Object.prototype);

          export function t(): number {
            return owns({ value: 1 }, 'value') && !owns({}, 'value') ? 1 : 0;
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(1);
  });

  it("keeps a destructured IIFE capture distinct from a same-named module binding", async () => {
    const w = await run(
      {
        "./main.ts": `
          const hasOwnProperty = (({ hasOwnProperty }) =>
            (object, property) => hasOwnProperty.call(object, property)
          )(Object.prototype);

          export function t(): number {
            return hasOwnProperty({ value: 1 }, 'value') && !hasOwnProperty({}, 'value') ? 1 : 0;
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(1);
  });

  it("keeps fields on a multi-level Error subclass on its host instance", async () => {
    const w = await run(
      {
        "./main.ts": `
          class ParentError extends Error {
            constructor(message: string) {
              super(message);
              this.name = 'ParentError';
            }
          }
          class ChildError extends ParentError {
            marker: boolean;
            constructor() {
              super('stopped');
              this.name = 'ChildError';
              this.marker = true;
            }
          }
          export function t(): string {
            const error = new ChildError();
            return error.name + '|' + error.message + '|' + String(error.marker);
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("ChildError|stopped|true");
  });

  it("keeps an extracted Object.getPrototypeOf result on the host carrier", async () => {
    const w = await run(
      {
        "./main.ts": `
          const getPrototypeOf = Object.getPrototypeOf;
          export function t(): number {
            return getPrototypeOf({ value: 1 }) === Object.prototype ? 1 : 0;
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(1);
  });

  it("keeps a host prototype result through an untyped wrapper", async () => {
    const w = await run(
      {
        "./main.js": `
          var $Object = Object;
          var $getPrototypeOf = $Object.getPrototypeOf;
          function getDunder(value) {
            return $getPrototypeOf(value == null ? value : $Object(value));
          }
          export function t() {
            return getDunder({ value: 1 }) === Object.prototype ? 1 : 0;
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(1);
  });

  it("reads an array value through a dynamic key on a null-prototype literal", async () => {
    const w = await run(
      {
        "./main.js": `
          var aliases = {
            __proto__: null,
            '%ArrayPrototype%': ['Array', 'prototype'],
            '%ObjectPrototype%': ['Object', 'prototype']
          };
          function first(name) {
            var alias = aliases[name];
            return alias[0];
          }
          export function t() {
            return first('%ObjectPrototype%') === 'Object' ? 1 : 0;
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(1);
  });

  it("preserves string elements and closure results through an unresolved Array.map callback", async () => {
    const w = await run(
      {
        "./utils.mjs": `
          const kindOf = (thing) => typeof thing;
          const kindOfTest = (type) => {
            type = type.toLowerCase();
            return (thing) => kindOf(thing) === type;
          };

          export const [isString, isNumber] = ['STRING', 'NUMBER'].map(kindOfTest);
        `,
        "./main.ts": `
          import { isString, isNumber } from './utils.mjs';
          export function t(): string {
            return [isString('value'), isString(1), isNumber(1), isNumber('value')].join('|');
          }
        `,
      },
      "./main.ts",
      ["__call_dyn_1"],
    );
    expect(w.t()).toBe("true|false|true|false");
  });

  it("invokes an arrow passed into another module's untyped callback param", async () => {
    const w = await run(
      {
        "./cb.mjs": `
          export function callIt(cb) { return '' + cb(2, 3); }
          export function callBool(cb) { return cb(0, 0) ? 'T' : 'F'; }
        `,
        "./main.ts": `
          import { callIt, callBool } from './cb.mjs';
          export function t(): string {
            const r1 = callIt((x, y) => x + y);
            const r2 = callBool((a, b) => a === b);
            const s = 'ab';
            const r3 = callBool((ai, bi) => s[ai] === s[bi]);
            return [r1, r2, r3].join('|');
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("5|T|T");
  });

  it("threads live index arguments through a diff-sequences-shaped loop", async () => {
    const w = await run(
      {
        "./diffseq.mjs": `
          export default function diff(aLength, bLength, isCommon, foundSubsequence) {
            let n = 0;
            for (let a = 0; a < aLength; a++) {
              for (let b = 0; b < bLength; b++) {
                if (isCommon(a, b)) { n += 1; foundSubsequence(1, a, b); }
              }
            }
            return n;
          }
        `,
        "./main.ts": `
          import diff from './diffseq.mjs';
          export function t(): string {
            const a = 'abc', b = 'abd';
            const found: string[] = [];
            const n = diff(a.length, b.length,
              (ai, bi) => a[ai] === b[bi],
              (nCommon, ai, bi) => { found.push(nCommon + ':' + ai + ',' + bi); });
            return n + '|' + found.join(' ');
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("2|1:0,0 1:1,1");
  });

  it("keeps Function.prototype.bind live in a default-export fallback expression", async () => {
    const w = await run(
      {
        "./fallback.mjs": `export default function fallback() { return 'fallback'; }`,
        "./provider.mjs": `
          import fallback from './fallback.mjs';
          export { fallback };
          export default Function.prototype.bind || fallback;
        `,
        "./main.ts": `
          import selected, { fallback } from './provider.mjs';
          export function t(): number { return selected === fallback ? 0 : 1; }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(1);
  });

  it("keeps a default import distinct from an unrelated same-named function", async () => {
    const w = await run(
      {
        "./provider.mjs": `export default Function.prototype.bind;`,
        "./unrelated.mjs": `export function bind() { return -1; }`,
        "./main.ts": `
          import bind from './provider.mjs';
          import { bind as unrelated } from './unrelated.mjs';

          const bound = bind.call(Object.prototype.hasOwnProperty, { value: 42 });

          export function t(): number { return (bound('value') ? 2 : 0) + unrelated(); }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(1);
  });

  it("preserves a bound hasOwnProperty default export across modules", async () => {
    const w = await run(
      {
        "./provider.mjs": `export default Function.prototype.bind;`,
        "./has-own.mjs": `
          import bind from './provider.mjs';
          const call = Function.prototype.call;
          const hasOwnProperty = Object.prototype.hasOwnProperty;
          export default bind.call(call, hasOwnProperty);
        `,
        "./unrelated.mjs": `export function bind() { return true; }`,
        "./main.ts": `
          import hasOwn from './has-own.mjs';
          import { bind as unrelated } from './unrelated.mjs';
          export function t(): number {
            const value = { present: 1 };
            return (hasOwn(value, 'present') ? 2 : 0)
              + (hasOwn(value, 'missing') ? 4 : 0)
              + (unrelated() ? 1 : 0);
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe(3);
  });

  it("uses a bound hasOwnProperty before dynamically reading an alias table", async () => {
    const w = await run(
      {
        "./provider.mjs": `export default Function.prototype.bind;`,
        "./has-own.mjs": `
          import bind from './provider.mjs';
          const call = Function.prototype.call;
          const hasOwnProperty = Object.prototype.hasOwnProperty;
          export default bind.call(call, hasOwnProperty);
        `,
        "./aliases.mjs": `
          import hasOwn from './has-own.mjs';
          const aliases = {
            __proto__: null,
            '%StringPrototype%': ['String', 'prototype']
          };
          function first(name) {
            let alias;
            if (hasOwn(aliases, name)) {
              alias = aliases[name];
              return alias[0];
            }
            return 'missing';
          }
          export const known = first('%StringPrototype%');
          export const absent = first('%String.prototype.indexOf%');
        `,
        "./main.ts": `
          import { known, absent } from './aliases.mjs';
          export function t(): string { return known + '|' + absent; }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("String|missing");
  });

  it("uses returned match arrays when stale JSDoc declares boolean elements", async () => {
    const w = await run(
      {
        "./main.js": `
          /** @returns {Array<boolean>} */
          const matchAll = (regexp, str) => {
            const matches = [];
            let match;
            while ((match = regexp.exec(str)) !== null) matches.push(match);
            return matches;
          };

          export function t() {
            return matchAll(/\\w+|\\[(\\w*)]/g, 'foo[bar]')
              .map((match) => match[1] || match[0])
              .join('|');
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe("foo|bar");
  });

  it("preserves named properties across a JSDoc Array parameter", async () => {
    const w = await run(
      {
        "./main.js": `
          /** @param {Array<any>} arr */
          function arrayToObject(arr) {
            const object = {};
            const keys = Object.keys(arr);
            for (let i = 0; i < keys.length; i++) {
              const key = keys[i];
              object[key] = arr[key];
            }
            return object;
          }

          export function t() {
            const values = [];
            values.bar = 7;
            values.baz = 9;
            const object = arrayToObject(values);
            return object.bar * 10 + object.baz;
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(79);
  });

  it("preserves this for a rest-parameter function invoked with call", async () => {
    const w = await run(
      {
        "./main.js": `
          function merge(...values) {
            const { caseless } = this || {};
            return (caseless ? 100 : 0) + values.length;
          }
          export function t() {
            return merge.call({ caseless: true }, { x: 1 }, { X: 2 });
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(102);
  });

  it("preserves this for a rest function extracted from an object", async () => {
    const w = await run(
      {
        "./utils.js": `
          function merge(...values) {
            const { caseless } = this || {};
            return (caseless ? 100 : 0) + values.length;
          }
          export default { merge };
        `,
        "./main.js": `
          import utils from './utils.js';
          const { merge } = utils;
          export function t() {
            return merge.call({ caseless: true }, { x: 1 }, { X: 2 });
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(102);
  });

  it("calls an imported object shorthand function during module initialization", async () => {
    const w = await run(
      {
        "./utils.mjs": `
          function forEach(obj, fn, { allOwnKeys = false } = {}) {
            if (allOwnKeys) throw new Error('unexpected option');
            for (let i = 0; i < obj.length; i++) fn.call(null, obj[i], i, obj);
          }
          export default { forEach };
        `,
        "./noise.mjs": `
          export const value = (a, b, c) => String(a) + String(b) + String(c);
          export const nothing = (a, b, c) => {};
          export const numeric = (a, b, c) => 1;
          export const predicate = (a, b, c) => true;
        `,
        "./main.ts": `
          import utils from './utils.mjs';
          import * as noise from './noise.mjs';
          let result = '';
          utils.forEach(['delete', 'get'], (method) => { result += method + '|'; });
          export function t(): string {
            void noise;
            return result;
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("delete|get|");
  });

  it("calls a function selected from a local strategy table", async () => {
    const w = await run(
      {
        "./utils.js": `
          function hasOwnProp(object, property) {
            return Object.prototype.hasOwnProperty.call(object, property);
          }
          function merge(...values) {
            return values.length;
          }
          function forEach(values, callback) {
            for (let index = 0; index < values.length; index++) {
              callback.call(null, values[index], index, values);
            }
          }
          export default { hasOwnProp, merge, forEach };
        `,
        "./main.js": `
          import utils from './utils.js';
          function mergeValue(key, a, b) {
            const outer = key.length;
            function getMergedValue(a, b, key, caseless) {
              return (caseless ? 100 : 0) + a + b + key.length + outer;
            }
            function mergeDeep(a, b, key, caseless) {
              return getMergedValue(a, b, key, caseless);
            }
            function useSecond(a, b) {
              return getMergedValue(0, b, key, false);
            }
            function useFirst(a, b) {
              return outer ? a : undefined;
            }
            function useKey(a, b, key) {
              return { key, outer };
            }
            const strategies = {
              url: useSecond,
              method: useFirst,
              data: useKey,
              baseURL: useFirst,
              transformRequest: useFirst,
              transformResponse: useFirst,
              paramsSerializer: useFirst,
              timeout: useFirst,
              timeoutMessage: useFirst,
              withCredentials: useFirst,
              withXSRFToken: useFirst,
              adapter: useFirst,
              responseType: useFirst,
              xsrfCookieName: useFirst,
              xsrfHeaderName: useFirst,
              onUploadProgress: useFirst,
              onDownloadProgress: useFirst,
              decompress: useFirst,
              maxContentLength: useFirst,
              maxBodyLength: useFirst,
              beforeRedirect: useFirst,
              transport: useFirst,
              httpAgent: useFirst,
              httpsAgent: useFirst,
              cancelToken: useFirst,
              socketPath: useFirst,
              allowedSocketPaths: useFirst,
              responseEncoding: useFirst,
              validateStatus: useKey,
              headers: (a, b, key) => mergeDeep(a, b, key, true),
            };
            const result = { value: 0 };
            utils.forEach([key], function compute(prop) {
              const merge = utils.hasOwnProp(strategies, prop)
                ? strategies[prop]
                : mergeDeep;
              result.value = merge(a, b, prop, true);
            });
            return result.value;
          }

          export function t() {
            return mergeValue('url', 3, 7) * 1000 + mergeValue('other', 3, 7);
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe(13120);
  });

  it("keeps a nested callback callable after an imported rest function is called with this", async () => {
    const w = await run(
      {
        "./utils.js": `
          function isPlainObject(value) {
            return value !== null && typeof value === 'object' && !Array.isArray(value);
          }
          function forEach(object, callback) {
            const keys = Object.keys(object);
            for (let i = 0; i < keys.length; i++) {
              const key = keys[i];
              callback.call(null, object[key], key, object);
            }
          }
          function merge(...objects) {
            const result = {};
            const assignValue = (value, key) => {
              result[key] = isPlainObject(value) ? merge({}, value) : value;
            };
            for (let i = 0; i < objects.length; i++) {
              forEach(objects[i], assignValue);
            }
            return result;
          }
          export default { isPlainObject, merge };
        `,
        "./merge.js": `
          import utils from './utils.js';
          function mergedValue(target, source) {
            if (utils.isPlainObject(target) && utils.isPlainObject(source)) {
              return utils.merge.call({ caseless: false }, target, source);
            }
            return source;
          }
          export function combine(first, second) {
            return mergedValue(first, second);
          }
        `,
        "./main.js": `
          import { combine } from './merge.js';
          export function t() {
            const value = combine({ user: 'a' }, { password: 'b' });
            return value.user + value.password;
          }
        `,
      },
      "./main.js",
    );
    expect(w.t()).toBe("ab");
  });
});
