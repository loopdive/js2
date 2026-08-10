#!/usr/bin/env npx tsx
/**
 * Generate feature table JS/WAT examples for the landing page.
 *
 * Compiles each JS snippet with the compiler, extracts the most readable
 * WAT function, and outputs public/feature-examples.json.
 *
 * Usage:  pnpm run generate:feature-examples
 * Output: public/feature-examples.json
 */

import { compile } from "../src/index.js";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHighlighter } from "shiki";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_FILE = join(ROOT, "website", "public", "feature-examples.json");

// ── Types ────────────────────────────────────────────────────────────────

type Badge = "full" | "partial" | "none";

interface FeatureDef {
  name: string;
  edition: string;
  badge: Badge;
  host?: boolean;
  /** Feature is sloppy-mode only — hide when strict-only toggle is on */
  sloppy?: boolean;
  description: string;
  js: string;
  explain?: string;
  /** Skip compilation — for features the compiler doesn't support at all */
  noCompile?: boolean;
}

interface FeatureResult extends FeatureDef {
  wat: string | null;
  compileSuccess: boolean;
  compileError?: string;
  jsHtml?: string;
  watHtml?: string;
}

// ── Feature definitions ──────────────────────────────────────────────────

const FEATURES: FeatureDef[] = [
  // ── ES3 / Core ──────────────────────────────────────────────────────────
  {
    name: "Primitive types (string, number, boolean, null, undefined)",
    edition: "ES3 / Core",
    badge: "full",
    description: "All primitive value types and coercion",
    js: `const s = "hello";
const n = 42;
const b = true;
const x = null;`,
  },
  {
    name: "Operators (arithmetic, comparison, logical, bitwise)",
    edition: "ES3 / Core",
    badge: "full",
    description: "All standard operators including ternary",
    js: `function calc(a: number, b: number): number {
  const sum = a + b;
  const eq = a === b ? 1 : 0;
  const both = a > 0 && b > 0 ? 1 : 0;
  return sum + eq + both;
}`,
  },
  {
    name: "typeof / instanceof",
    edition: "ES3 / Core",
    badge: "full",
    description: "Runtime type checking operators",
    js: `function classify(x: unknown): string {
  if (typeof x === "number") return "num";
  if (typeof x === "string") return "str";
  return "other";
}`,
  },
  {
    name: "delete operator",
    edition: "ES3 / Core",
    badge: "full",
    description: "Remove a property from an object",
    js: `class Obj { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
function dropY(o: Obj): boolean {
  return delete (o as unknown as Record<string, unknown>).y;
}`,
  },
  {
    name: "Comma operator",
    edition: "ES3 / Core",
    badge: "full",
    description: "Evaluate multiple expressions, return last",
    js: `function withSideEffect(): number {
  let x = 0;
  const y = (x++, x * 2);
  return y;
}`,
  },
  {
    name: "Labeled statements (break / continue)",
    edition: "ES3 / Core",
    badge: "full",
    description: "Named loops for multi-level break and continue",
    js: `function firstPair(n: number): number {
  outer: for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) break outer;
    }
  }
  return 0;
}`,
  },
  {
    name: "for-in",
    edition: "ES3 / Core",
    badge: "full",
    description: "Iterate over object property names",
    js: `function countKeys(obj: Record<string, unknown>): number {
  let n = 0;
  for (const key in obj) { n++; }
  return n;
}`,
  },
  {
    name: "arguments object (full)",
    edition: "ES3 / Core",
    badge: "partial",
    sloppy: true,
    description: "Legacy arguments — partial, rest params preferred",
    js: `function legacy(): number {
  return arguments.length;
}
// prefer rest params: (...args)`,
    explain: "arguments.length and indexed access work. Rest parameters (...args) are preferred and fully compiled.",
  },
  {
    name: "eval()",
    edition: "ES3 / Core",
    badge: "partial",
    description: "Dynamic code evaluation at runtime",
    js: `eval("1 + 2");`,
    explain:
      "A compiled-in evaluator handles common cases. Complex dynamic scoping is not fully equivalent to a real JS engine.",
  },
  {
    name: "with statement",
    edition: "ES3 / Core",
    badge: "none",
    sloppy: true,
    description: "Dynamic scope extension",
    js: `with (obj) { x; } // not supported`,
    explain:
      "Compiles without the spec-required early error in strict-mode code, but property writes inside the block do not reach the object.",
    noCompile: true,
  },

  // ── ES5 ────────────────────────────────────────────────────────────────
  {
    name: "Variables (var, let, const)",
    edition: "ES5",
    badge: "full",
    description: "Block-scoped and function-scoped variable declarations",
    js: `let count = 1;
const name = "hello";
var legacy = true;`,
  },
  {
    name: "Functions & closures",
    edition: "ES5",
    badge: "full",
    description: "Named functions, expressions, and lexical closures over captured state",
    js: `function makeCounter(): () => number {
  let n = 0;
  return () => ++n;
}

const c = makeCounter();
c(); c();
const value = c(); // 3`,
  },
  {
    name: "Control flow",
    edition: "ES5",
    badge: "full",
    description: "Branching, loops, and switch statements",
    js: `function abs(x: number): number {
  if (x > 0) {
    return x;
  } else {
    return -x;
  }
}`,
  },
  {
    name: "try / catch / finally",
    edition: "ES5",
    badge: "full",
    description: "Exception handling with recovery via catch",
    js: `function safeDiv(a: number, b: number): number {
  try {
    if (b === 0) throw new Error("div by zero");
    return a / b;
  } catch (e) {
    return -1;
  }
}`,
  },
  {
    name: "throw",
    edition: "ES5",
    badge: "full",
    description: "Throw custom and built-in error objects",
    js: `function check(x: number): number {
  if (x < 0) throw new Error("negative");
  return x;
}`,
  },
  {
    name: "Objects",
    edition: "ES5",
    badge: "full",
    description: "Literals, property access, methods, and shorthand syntax",
    js: `class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  dist(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
}`,
  },
  {
    name: "Strings",
    edition: "ES5",
    badge: "full",
    description: "String methods, concatenation, and manipulation",
    js: `function greet(name: string): string {
  return "Hello " + name;
}

function initials(first: string, last: string): string {
  return first.slice(0, 1) + last.slice(0, 1);
}`,
  },
  {
    name: "Numbers",
    edition: "ES5",
    badge: "full",
    description: "Math operations, parseInt, Number methods",
    js: `const a = 1.5;
const b = 2.5;
const m = Math.max(a, b);
const floored = Math.floor(3.7);`,
  },
  {
    name: "JSON",
    edition: "ES5",
    badge: "full",
    host: true,
    description: "Parse and stringify JSON data",
    js: `const obj = JSON.parse('{"a": 1}');
const str = JSON.stringify({ a: 1 });`,
  },
  {
    name: "Error types",
    edition: "ES5",
    badge: "full",
    description: "Error, TypeError, RangeError, SyntaxError and more",
    js: `function fail(msg: string): never {
  throw new TypeError(msg);
}`,
  },
  {
    name: "Arrays",
    edition: "ES5",
    badge: "partial",
    host: true,
    description: "Array methods and iteration helpers",
    js: `const nums = [1, 2, 3];
const doubled = nums.map((x: number) => x * 2);
const sum = nums.reduce((a: number, b: number) => a + b, 0);`,
    explain: "Most built-in methods work. Some iterator edge cases and sparse array handling incomplete.",
  },
  {
    name: "Regular expressions",
    edition: "ES5",
    badge: "partial",
    host: true,
    description: "Pattern matching and string search",
    js: `const re = /\\d+/g;
const found = "abc123def456".match(re);`,
    explain: "Basic patterns work. Named groups and lookbehind partially supported.",
  },
  {
    name: "Property accessors (get / set)",
    edition: "ES5",
    badge: "partial",
    description: "Getter and setter property definitions",
    js: `class Circle {
  private _r: number;
  constructor(r: number) { this._r = r; }
  get radius(): number { return this._r; }
  set radius(v: number) { this._r = v; }
}`,
    explain: "Basic get/set works. Object.defineProperty partially supported.",
  },
  {
    name: "Object.defineProperty (full)",
    edition: "ES5",
    badge: "none",
    description: "Full property descriptor configuration",
    js: `Object.defineProperty({}, "x", {
  enumerable: false,
  writable: false,
  value: 42,
});`,
    explain:
      "Compiles, but the descriptor is not applied — reading the property afterward returns undefined instead of the configured value.",
    noCompile: true,
  },

  // ── ES2015 ──────────────────────────────────────────────────────────────
  {
    name: "Arrow functions",
    edition: "ES2015",
    badge: "full",
    description: "Concise function syntax with lexical this",
    js: `const double = (x: number): number => x * 2;
const negate = (x: number): number => -x;
const add = (a: number, b: number): number => a + b;`,
  },
  {
    name: "Template literals",
    edition: "ES2015",
    badge: "full",
    description: "String interpolation with backtick syntax",
    js: `function greeting(name: string, age: number): string {
  return \`Hello \${name}, you are \${age}!\`;
}`,
  },
  {
    name: "Destructuring",
    edition: "ES2015",
    badge: "full",
    description: "Extract values from arrays and objects, with rest patterns",
    js: `function firstTwo(arr: number[]): number {
  const [a, b, ...rest] = arr;
  return a + b + rest.length;
}`,
  },
  {
    name: "Spread / rest operators",
    edition: "ES2015",
    badge: "full",
    description: "Expand iterables and collect arguments",
    js: `function sum(...nums: number[]): number {
  let total = 0;
  for (const n of nums) total += n;
  return total;
}`,
  },
  {
    name: "Default parameters",
    edition: "ES2015",
    badge: "full",
    description: "Fallback values for function parameters",
    js: `function greet(name: string = "world"): string {
  return "Hello " + name;
}`,
  },
  {
    name: "Computed property names",
    edition: "ES2015",
    badge: "full",
    description: "Dynamic property keys in object literals",
    js: `const key = "id";
const obj: Record<string, number> = { [key]: 42 };`,
  },
  {
    name: "for-of",
    edition: "ES2015",
    badge: "full",
    description: "Iterate over iterable objects",
    js: `function sum(arr: number[]): number {
  let total = 0;
  for (const x of arr) {
    total += x;
  }
  return total;
}`,
  },
  {
    name: "Generators (function*, yield)",
    edition: "ES2015",
    badge: "full",
    description: "Pausable functions that produce sequences",
    js: `function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

function sumRange(n: number): number {
  let sum = 0;
  for (const x of range(n)) sum += x;
  return sum;
}`,
  },
  {
    name: "Classes",
    edition: "ES2015",
    badge: "partial",
    description: "Class declarations, inheritance, and method override",
    js: `class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  speak(): string { return this.name + " speaks"; }
}

class Dog extends Animal {
  speak(): string { return this.name + " barks"; }
}

const d = new Dog("Rex");
const msg = d.speak(); // "Rex barks"`,
    explain: "Constructor, methods, extends, super, and virtual dispatch work. Dynamic prototype lookup is partial.",
  },
  {
    name: "Map / Set",
    edition: "ES2015",
    badge: "partial",
    host: true,
    description: "Key-value and unique-value collections",
    js: `const m = new Map<string, number>();
m.set("key", 42);
const val = m.get("key");

const s = new Set<string>();
s.add("a");`,
    explain: "Core operations work. Some iteration edge cases incomplete.",
  },
  {
    name: "Symbol",
    edition: "ES2015",
    badge: "partial",
    host: true,
    description: "Unique, immutable primitive identifiers",
    js: `const id = Symbol("id");
const desc = id.description;`,
    explain: "Creation and basic use work. Well-known symbols (Symbol.iterator) partial.",
  },
  {
    name: "TypedArray / ArrayBuffer",
    edition: "ES2015",
    badge: "partial",
    host: true,
    description: "Binary data buffers and typed views",
    js: `const buf = new ArrayBuffer(16);
const view = new Int32Array(buf);
view[0] = 42;
const first = view[0];`,
    explain: "Int8 through Float64 arrays work. BigInt64Array not yet.",
  },
  {
    name: "Modules (import / export)",
    edition: "ES2015",
    badge: "partial",
    description: "ES module system for code organization",
    js: `export function bar(): number { return 1; }
export const version = "1.0";`,
    explain: "Static imports work. Dynamic import() not yet.",
  },
  {
    name: "Proxy / Reflect",
    edition: "ES2015",
    badge: "none",
    description: "Object behavior interception and reflection",
    js: `new Proxy(target, handler); // not supported`,
    explain:
      "Compiles, but trap forwarding is not implemented — property access on the proxy does not reach the target object.",
    noCompile: true,
  },
  {
    name: "Promise .then / .catch / .finally",
    edition: "ES2015",
    badge: "none",
    host: true,
    description: "Promise chaining and error handling",
    js: `promise.then(v => v + 1); // not yet`,
    explain: "Compiles but async callbacks do not execute. Promise.resolve/all/race work.",
    noCompile: true,
  },

  // ── ES2017 ──────────────────────────────────────────────────────────────
  {
    name: "async / await",
    edition: "ES2017",
    badge: "full",
    host: true,
    description: "Asynchronous functions with synchronous-style syntax",
    js: `export async function fetchAndDouble(p: Promise<number>): Promise<number> {
  const n = await p;
  return n * 2;
}`,
  },
  {
    name: "Object.entries / values",
    edition: "ES2017",
    badge: "full",
    description: "Extract entries or values from objects",
    js: `class Pair { key: string; val: number; constructor(k: string, v: number) { this.key = k; this.val = v; } }
function pairs(obj: Pair): [string, number][] {
  return Object.entries(obj) as [string, number][];
}`,
  },
  {
    name: "SharedArrayBuffer / Atomics",
    edition: "ES2017",
    badge: "none",
    host: true,
    description: "Shared memory and atomic operations",
    js: `new SharedArrayBuffer(1024); // not supported`,
    explain: "Compiles, but the returned buffer's properties are not wired up at runtime (byteLength reads as null).",
    noCompile: true,
  },

  // ── ES2018 ──────────────────────────────────────────────────────────────
  {
    name: "Object spread / rest",
    edition: "ES2018",
    badge: "full",
    description: "Object spread in literals and rest in destructuring",
    js: `class Vec2 { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
function move(v: Vec2, dx: number, dy: number): Vec2 {
  return { ...v, x: v.x + dx, y: v.y + dy };
}`,
  },
  {
    name: "Async iteration (for-await-of)",
    edition: "ES2018",
    badge: "partial",
    host: true,
    description: "Iterate over async data sources",
    js: `async function sum(iter: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of iter) { total += n; }
  return total;
}`,
    explain: "Basic patterns work. Some async generator edge cases incomplete.",
  },

  // ── ES2020 ──────────────────────────────────────────────────────────────
  {
    name: "Optional chaining (?.)",
    edition: "ES2020",
    badge: "full",
    description: "Safe property access on nullable values",
    js: `interface User { profile?: { name?: string } }
function getName(u: User): string | undefined {
  return u?.profile?.name;
}`,
  },
  {
    name: "Nullish coalescing (??)",
    edition: "ES2020",
    badge: "full",
    description: "Default values for null or undefined",
    js: `function getPort(port: number | null): number {
  return port ?? 8080;
}`,
  },
  {
    name: "globalThis",
    edition: "ES2020",
    badge: "full",
    host: true,
    description: "Universal global object reference",
    js: `const g = globalThis;`,
  },
  {
    name: "BigInt",
    edition: "ES2020",
    badge: "partial",
    host: true,
    description: "Arbitrary precision integer arithmetic",
    js: `const big = 9007199254740993n;
const sum = big + 1n;`,
    explain: "Basic arithmetic works. BigInt typed arrays not yet.",
  },
  {
    name: "Dynamic import()",
    edition: "ES2020",
    badge: "none",
    host: true,
    description: "Load modules at runtime on demand",
    js: `const mod = await import("./module"); // not yet`,
    explain: "Compiles, but the returned promise never settles — dynamic import is not wired to a runtime loader.",
    noCompile: true,
  },

  // ── ES2021 ──────────────────────────────────────────────────────────────
  {
    name: "WeakRef / FinalizationRegistry",
    edition: "ES2021",
    badge: "partial",
    host: true,
    description: "Weak references and GC callbacks",
    js: `const target = { name: "cached" };
const ref = new WeakRef(target);
const value = ref.deref();`,
    explain:
      "WeakRef creation and deref() work correctly. FinalizationRegistry is not implemented — registering a target throws.",
  },

  // ── ES2022 ──────────────────────────────────────────────────────────────
  {
    name: "Class fields (public, private, static)",
    edition: "ES2022",
    badge: "full",
    description: "Declarative field syntax in classes",
    js: `class Counter {
  count: number = 0;
  #value: number = 42;
  static instances: number = 0;
  increment(): void { this.count++; }
}`,
  },
  {
    name: "Error.cause",
    edition: "ES2022",
    badge: "full",
    description: "Chain errors with a cause property",
    js: `function wrap(inner: Error): never {
  throw new Error("wrapped", { cause: inner });
}`,
  },
  {
    name: "Array.at / String.at",
    edition: "ES2022",
    badge: "full",
    description: "Relative indexing with negative support",
    js: `const nums = [1, 2, 3];
const last = nums.at(-1);
const first = "hello".at(0);`,
  },
  {
    name: "Top-level await",
    edition: "ES2022",
    badge: "none",
    description: "Await at module scope without async wrapper",
    js: `await fetch("./data.json"); // not supported`,
    explain:
      "Compiles for a trivial `await Promise.resolve(x)`, but a `new Promise` executor or a `.then()`-chained promise at top level resolves incorrectly or throws — the async runtime is not reliable here yet.",
    noCompile: true,
  },

  // ── ES2016 ──────────────────────────────────────────────────────────────
  {
    name: "Array.prototype.includes",
    edition: "ES2016",
    badge: "full",
    description: "Check if array contains a value",
    js: `function has(arr: number[], val: number): boolean {
  return arr.includes(val);
}`,
  },
  {
    name: "Exponentiation operator (**)",
    edition: "ES2016",
    badge: "full",
    description: "Power operator as syntactic sugar for Math.pow",
    js: `function power(base: number, exp: number): number {
  return base ** exp;
}`,
  },

  // ── ES2019 ──────────────────────────────────────────────────────────────
  {
    name: "Optional catch binding",
    edition: "ES2019",
    badge: "full",
    description: "Omit the catch parameter when not needed",
    js: `function isJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}`,
  },
  {
    name: "Array.prototype.flat / flatMap",
    edition: "ES2019",
    badge: "partial",
    host: true,
    description: "Flatten nested arrays and map-then-flatten",
    js: `const nested = [[1, 2], [3, 4]];
const flat = nested.flat();
const doubled = nested.flatMap((a: number[]) => a.map((x: number) => x * 2));`,
    explain: "Basic flat/flatMap work. Deep nesting levels partially supported.",
  },
  {
    name: "Object.fromEntries",
    edition: "ES2019",
    badge: "partial",
    host: true,
    description: "Create object from key-value pairs",
    js: `const entries: [string, number][] = [["a", 1], ["b", 2]];
const obj = Object.fromEntries(entries);`,
    explain: "Works for basic key-value pairs.",
  },

  // ── ES2023 ──────────────────────────────────────────────────────────────
  {
    name: "Array.findLast / findLastIndex",
    edition: "ES2023",
    badge: "partial",
    host: true,
    description: "Find elements searching from the end",
    js: `const nums = [1, 2, 3, 4];
const last = nums.findLast((x: number) => x % 2 === 0);
const lastIdx = nums.findLastIndex((x: number) => x % 2 === 0);`,
    explain: "Works for standard arrays.",
  },
  {
    name: "Change array by copy (toSorted, toReversed, toSpliced)",
    edition: "ES2023",
    badge: "partial",
    host: true,
    description: "Immutable array operations returning new arrays",
    js: `const arr = [3, 1, 2];
const sorted = arr.toSorted();
const reversed = arr.toReversed();`,
    explain: "toSorted, toReversed and toSpliced all produce correct copies without mutating the original array.",
  },
  {
    name: "Hashbang (#!) comments",
    edition: "ES2023",
    badge: "full",
    description: "Unix shebang line support in JS files",
    js: `#!/usr/bin/env node
const x = 1;`,
  },

  // ── ES2024 ──────────────────────────────────────────────────────────────
  {
    name: "Promise.withResolvers",
    edition: "ES2024",
    badge: "none",
    host: true,
    description: "Create a Promise with exposed resolve/reject functions",
    js: `const { promise, resolve, reject } = Promise.withResolvers(); // not yet`,
    explain: "Promise infrastructure not yet fully implemented.",
    noCompile: true,
  },
  {
    name: "Resizable ArrayBuffer",
    edition: "ES2024",
    badge: "none",
    host: true,
    description: "ArrayBuffer that can grow or shrink after creation",
    js: `const buf = new ArrayBuffer(8, { maxByteLength: 1024 }); // not yet`,
    explain: "Compiles, but calling resize() throws — growth is not wired to Wasm memory.",
    noCompile: true,
  },
  {
    name: "RegExp v flag",
    edition: "ES2024",
    badge: "full",
    description: "Enhanced Unicode set notation in regular expressions",
    js: `const re = /[\\p{Letter}&&\\p{ASCII}]/v;
const matches = re.test("a");`,
  },

  // ── ES2025 ──────────────────────────────────────────────────────────────
  {
    name: "Set methods (union, intersection, difference)",
    edition: "ES2025",
    badge: "partial",
    host: true,
    description: "Set algebra operations",
    js: `const a = new Set([1, 2, 3]);
const b = new Set([2, 3, 4]);
const union = a.union(b);`,
    explain: "union() works correctly; intersection() and difference() are less thoroughly exercised.",
  },
  {
    name: "Iterator helpers (map, filter, take)",
    edition: "ES2025",
    badge: "none",
    host: true,
    description: "Lazy iterator combinators on Iterator.prototype",
    js: `[1, 2, 3].values().map((x: number) => x * 2).take(2); // not yet`,
    explain:
      "Rejected by the type-checker before codegen runs — Iterator.prototype.map/filter/take are not yet in the compiler's type surface.",
    noCompile: true,
  },
  {
    name: "RegExp duplicate named groups",
    edition: "ES2025",
    badge: "none",
    description: "Same named capture groups across alternatives",
    js: `const re = /(?<y>\\d{4})-(?<m>\\d{2})|(?<m>\\d{2})\\/(?<y>\\d{4})/v; // not yet`,
    explain:
      "Rejected by the type-checker before codegen runs — the checker's TypeScript lib is pinned to ES2022, and this syntax requires newer lib typings.",
    noCompile: true,
  },

  // ── ES2026 ──────────────────────────────────────────────────────────────
  // The 7 proposals published in the 17th edition (June 2026). Status below is
  // MEASURED, not assumed: all 7 compile, but only Error.isError and Upsert
  // also produce the right answer at runtime — the other five reach codegen and
  // then hit a missing runtime helper (`X is not a function`) or return an empty
  // result. Those are marked `none` + `noCompile` so the page does not show
  // plausible WAT for a feature that throws when you run it.
  {
    name: "Error.isError",
    edition: "ES2026",
    badge: "full",
    description: "Cross-realm-safe branded check for Error objects",
    js: `const real = Error.isError(new TypeError("boom"));
const fake = Error.isError({ name: "TypeError" });`,
  },
  {
    name: "Upsert (Map.getOrInsert)",
    edition: "ES2026",
    badge: "full",
    description: "Insert-if-absent then read, in one Map lookup",
    js: `const counts = new Map<string, number>();
counts.getOrInsert("a", 0);`,
  },
  {
    name: "Array.fromAsync",
    edition: "ES2026",
    badge: "none",
    host: true,
    description: "Build an array from an async iterable",
    js: `const rows = await Array.fromAsync(stream); // not yet`,
    explain: "Compiles, but the returned promise resolves to an empty array — async iteration drain is not wired up.",
    noCompile: true,
  },
  {
    name: "Math.sumPrecise",
    edition: "ES2026",
    badge: "none",
    description: "Exactly-rounded sum of a list of numbers",
    js: `const total = Math.sumPrecise([0.1, 0.2, 0.3]); // not yet`,
    explain: "Compiles, but throws `sumPrecise is not a function` — the runtime helper is not implemented.",
    noCompile: true,
  },
  {
    name: "Iterator sequencing (Iterator.concat)",
    edition: "ES2026",
    badge: "none",
    host: true,
    description: "Concatenate iterators lazily",
    js: `const all = Iterator.concat(a.values(), b.values()).toArray(); // not yet`,
    explain: "Compiles, but yields an empty sequence — Iterator.concat is not implemented in the runtime.",
    noCompile: true,
  },
  {
    name: "Uint8Array to/from Base64",
    edition: "ES2026",
    badge: "none",
    description: "Base64 and hex codecs on Uint8Array",
    js: `const bytes = Uint8Array.fromBase64("SGVsbG8="); // not yet`,
    explain: "Compiles, but throws `fromBase64 is not a function` — the codec is not reachable at runtime.",
    noCompile: true,
  },
  {
    name: "JSON.parse source text access",
    edition: "ES2026",
    badge: "none",
    description: "Preserve exact number source through parse/stringify",
    js: `const big = JSON.rawJSON("12345678901234567890"); // not yet`,
    explain: "Compiles, but JSON.stringify of a rawJSON box returns undefined.",
    noCompile: true,
  },

  // ── Legacy / Deprecated ─────────────────────────────────────────────────
  {
    name: "var hoisting",
    edition: "Legacy / Deprecated",
    badge: "partial",
    sloppy: true,
    description: "Function-scoped var declarations hoisted to function top",
    js: `function hoisted(): number {
  console.log(x); // undefined (hoisted)
  var x = 5;
  return x;
}`,
    explain: "var declarations are hoisted. Full TDZ semantics for let/const.",
  },
  {
    name: "arguments.callee",
    edition: "Legacy / Deprecated",
    badge: "none",
    sloppy: true,
    description: "Reference to the currently executing function",
    js: `(function factorial(n) {
  return n <= 1 ? 1 : n * arguments.callee(n - 1);
})(5); // not supported`,
    explain:
      "Compiles without the spec-required restriction, but the recursive call through arguments.callee does not produce correct results. Use named function expressions instead.",
    noCompile: true,
  },
  {
    name: "__proto__ accessor",
    edition: "Legacy / Deprecated",
    badge: "none",
    description: "Direct prototype chain mutation via __proto__",
    js: `const obj = {};
obj.__proto__ = protoObj; // not supported`,
    explain:
      "Compiles, but assigning __proto__ does not update the object's prototype chain — inherited methods remain unreachable at runtime.",
    noCompile: true,
  },
  {
    name: "String.prototype.substr",
    edition: "Legacy / Deprecated",
    badge: "full",
    description: "Legacy string slicing (use slice instead)",
    js: `"hello".substr(1, 3);`,
    explain: "Deprecated. Use String.prototype.slice instead.",
  },
  {
    name: "Octal literals (0777)",
    edition: "Legacy / Deprecated",
    badge: "none",
    sloppy: true,
    description: "Legacy octal integer syntax (use 0o prefix instead)",
    js: `const n = 0777; // not supported in strict mode`,
    explain:
      "Legacy octal without the 0o prefix is Annex B sloppy-mode syntax that strict-mode code should reject as a SyntaxError; the compiler does not yet enforce that early error. Use 0o prefix: 0o777.",
    noCompile: true,
  },
  {
    name: "escape() / unescape()",
    edition: "Legacy / Deprecated",
    badge: "partial",
    description: "Legacy URL-encoding functions (use encodeURIComponent instead)",
    js: `const encoded = escape("hello world");
const decoded = unescape(encoded);`,
    explain: "Deprecated globals. Use encodeURIComponent / decodeURIComponent.",
  },
  {
    name: "Function.prototype.caller",
    edition: "Legacy / Deprecated",
    badge: "none",
    sloppy: true,
    description: "Reference to the function that called the current function",
    js: `function f() { return f.caller; } // not supported`,
    explain:
      "Compiles, but accessing .caller throws a runtime exception rather than resolving to the calling function.",
    noCompile: true,
  },
  {
    name: "HTML string methods (.bold(), .anchor())",
    edition: "Legacy / Deprecated",
    badge: "full",
    description: "Legacy String methods wrapping HTML tags",
    js: `"hello".bold();
"hello".anchor("name");`,
    explain: "Deprecated HTML wrapper methods. Use DOM APIs directly.",
  },
  {
    name: "RegExp.$1 static properties",
    edition: "Legacy / Deprecated",
    badge: "none",
    description: "Static capture group properties on RegExp constructor",
    js: `/(\\d+)/.test("abc123");
const match = RegExp.$1; // not supported`,
    explain: "Compiles, but the static capture-group properties are never populated — RegExp.$1 reads empty.",
    noCompile: true,
  },

  // ── Proposals ───────────────────────────────────────────────────────────
  {
    name: "Hono-style router (Map + closures + classes)",
    edition: "npm libraries",
    badge: "partial",
    description: "Hono web-framework patterns: class-based router, Map route table, closure handlers, method chaining",
    js: `type Handler = (c: Context) => string;

class Context {
  path: string;
  constructor(path: string) { this.path = path; }
  text(s: string): string { return s; }
}

class App {
  routes: Map<string, Handler> = new Map();

  get(path: string, handler: Handler): App {
    this.routes.set(path, handler);
    return this;
  }

  dispatch(path: string): string {
    const handler = this.routes.get(path);
    if (handler == null) return "404 Not Found";
    return handler(new Context(path));
  }
}

const app = new App();
app.get("/", c => c.text("Hello, World!"))
   .get("/api/users", c => c.text("Users: Alice, Bob"))
   .get("/api/health", c => c.text("ok"));

console.log(app.dispatch("/"));          // Hello, World!
console.log(app.dispatch("/api/users")); // Users: Alice, Bob
console.log(app.dispatch("/404"));       // 404 Not Found`,
    testCategories: [],
  },
  {
    name: "Temporal",
    edition: "Proposals",
    badge: "none",
    description: "Modern date and time API",
    js: `const now = Temporal.Now.plainDateTimeISO(); // not supported`,
    noCompile: true,
  },
  {
    name: "Decorators",
    edition: "Proposals",
    badge: "none",
    description: "Syntax for class and method metadata annotation",
    js: `@sealed
class Foo {
  @log
  method() {}
} // not yet`,
    explain: "Stage 3 proposal. Decorator transform not yet in scope.",
    noCompile: true,
  },
  {
    name: "Pattern matching",
    edition: "Proposals",
    badge: "none",
    description: "Structural pattern matching with match expression",
    js: `const result = match (value) {
  when ({ type: "a" }): "A";
  when ({ type: "b" }): "B";
}; // not yet`,
    explain: "Stage 1 proposal. Structural pattern matching not yet in scope.",
    noCompile: true,
  },
];

// ── WAT extraction ───────────────────────────────────────────────────────

interface ParsedFunc {
  name: string;
  text: string;
}

function parseFunctions(wat: string): ParsedFunc[] {
  const result: ParsedFunc[] = [];
  let i = 0;

  while (i < wat.length) {
    // Find start of a function definition
    const funcIdx = wat.indexOf("(func ", i);
    if (funcIdx === -1) break;

    // Extract name: (func $name ... or (func (export "name") ...
    const nameMatch = wat.slice(funcIdx).match(/^\(func\s+(\$[\w.]+)/);
    const name = nameMatch ? nameMatch[1] : "$__anonymous";

    // Find end of function by tracking parenthesis depth
    let depth = 0;
    let j = funcIdx;
    let inString = false;
    while (j < wat.length) {
      const ch = wat[j];
      if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      j++;
    }

    const text = wat.slice(funcIdx, j).trim();
    result.push({ name, text });
    i = j;
  }

  return result;
}

/** Functions to always exclude from display */
const SKIP_NAMES = new Set([
  "$__box_number",
  "$__unbox_number",
  "$__box_bool",
  "$__truthy",
  "$__is_nullish",
  "$__get_globalThis",
]);

/** Prefixes of generated internal helpers that aren't interesting to display */
const BORING_PREFIXES = ["$__vec_", "$__sget_", "$__struct_", "$__ng_", "$__forit_"];

function isBoring(f: ParsedFunc): boolean {
  // Import stubs end in _import
  if (f.name.endsWith("_import")) return true;
  // Fully anonymous
  if (f.name === "$__anonymous") return true;
  // Specific utility internals
  if (SKIP_NAMES.has(f.name)) return true;
  // Generated internal helpers (vec ops, struct getters, etc.)
  if (BORING_PREFIXES.some((p) => f.name.startsWith(p))) return true;
  // Import stubs have only 1 non-empty line (just a type reference)
  const nonEmpty = f.text.split("\n").filter((l) => l.trim()).length;
  if (nonEmpty <= 1) return true;
  return false;
}

function extractBestWat(wat: string, maxLines = 15): string | null {
  const funcs = parseFunctions(wat);
  if (funcs.length === 0) return null;

  // Tier 1: named non-utility functions (most readable)
  const interesting = funcs.filter((f) => !isBoring(f) && !f.name.startsWith("$__"));
  // Tier 2: internal helpers (closures, etc.) — real implementations, not stubs
  const helpers = funcs.filter((f) => !isBoring(f) && f.name.startsWith("$__"));
  // Tier 3: fall back to $__module_init if it has content
  const moduleInit = funcs.filter((f) => f.name === "$__module_init");

  const candidates = interesting.length > 0 ? interesting : helpers.length > 0 ? helpers : moduleInit;

  if (candidates.length === 0) return null;

  // Sort: operation functions before constructors (Class_new), then shorter first
  const sorted = [...candidates].sort((a, b) => {
    const aIsNew = a.name.endsWith("_new");
    const bIsNew = b.name.endsWith("_new");
    if (aIsNew !== bIsNew) return aIsNew ? 1 : -1; // constructors last in tier
    const aLines = a.text.split("\n").filter((l) => l.trim()).length;
    const bLines = b.text.split("\n").filter((l) => l.trim()).length;
    return aLines - bLines; // shorter first
  });

  const best = sorted[0];
  const lines = best.text.split("\n");

  // Truncate and close
  if (lines.length > maxLines) {
    const trimmed = lines.slice(0, maxLines);
    trimmed.push("  ...");
    trimmed.push(")");
    return trimmed.join("\n");
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating feature examples → ${OUT_FILE}\n`);

  const results: FeatureResult[] = [];
  let passed = 0;
  let skipped = 0;
  let failed = 0;

  for (const feat of FEATURES) {
    if (feat.noCompile) {
      results.push({ ...feat, wat: null, compileSuccess: false });
      skipped++;
      console.log(`  skip  ${feat.name}`);
      continue;
    }

    try {
      const result = await compile(feat.js, { emitWat: true, fileName: "snippet.ts" });

      if (!result.success) {
        const msg = result.errors[0]?.message ?? "unknown error";
        results.push({ ...feat, wat: null, compileSuccess: false, compileError: msg });
        failed++;
        console.warn(`  FAIL  ${feat.name}\n        ${msg}`);
        continue;
      }

      const wat = extractBestWat(result.wat);
      results.push({ ...feat, wat, compileSuccess: true });
      passed++;
      console.log(`  ok    ${feat.name}${wat ? "" : " (no named func)"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ...feat, wat: null, compileSuccess: false, compileError: msg });
      failed++;
      console.warn(`  FAIL  ${feat.name}\n        ${msg}`);
    }
  }

  console.log(`\n${passed} compiled, ${skipped} skipped, ${failed} failed`);

  // Syntax highlight all code with shiki
  console.log("\nHighlighting with shiki...");
  const highlighter = await createHighlighter({
    themes: ["material-theme-ocean"],
    langs: ["javascript", "wasm"],
  });

  for (const r of results) {
    try {
      r.jsHtml = highlighter.codeToHtml(r.js, { lang: "javascript", theme: "material-theme-ocean" });
    } catch {
      r.jsHtml = undefined;
    }
    if (r.wat) {
      try {
        r.watHtml = highlighter.codeToHtml(r.wat, { lang: "wasm", theme: "material-theme-ocean" });
      } catch {
        r.watHtml = undefined;
      }
    }
  }

  highlighter.dispose();
  console.log("Highlighting done.");

  // This script owns the compiled-example fields on each row (js/wat/
  // compileSuccess/badge/noCompile/…, everything FeatureResult declares). It
  // does NOT own `testCategories`/`passCount`/`totalCount`/`tests`/
  // `testsTruncated`/`features_generated` — those are written by a SEPARATE
  // pipeline (website/dashboard/build-data.js's buildFeatureStats, #1327,
  // reconciled on top by scripts/generate-editions.ts's patchFeatureExamples,
  // #2910) that scores each row against live test262 results.
  //
  // A naive overwrite here would silently WIPE those fields on every run:
  // this script's own output only ever contains `{ generated, features }`,
  // and generate-editions.ts's patch step READS `testCategories` (for its
  // path-prefix fallback scoring) but never WRITES it if absent — so a wipe
  // here is never self-healing downstream. Confirmed by hand: running this
  // script standalone against a file already carrying those fields dropped
  // `testCategories` from every row, which breaks the "view test262 sources"
  // links on the landing page and the feature-report detail page for every
  // row scored by path prefix (the ~29 core ES3/ES5 rows that predate
  // `features:` tags) — silently, since nothing downstream restores it.
  //
  // So: merge into whatever is already on disk, carrying those fields forward
  // untouched, rather than replacing the file outright. This makes the script
  // safe to run in CI on its own, without depending on build-data.js having
  // run first or after.
  const PRESERVED_KEYS = ["testCategories", "passCount", "totalCount", "tests", "testsTruncated"] as const;
  const previousByName = new Map<string, Record<string, unknown>>();
  let previousFeaturesGenerated: string | undefined;
  if (existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(readFileSync(OUT_FILE, "utf-8")) as {
        features_generated?: string;
        features?: Array<Record<string, unknown>>;
      };
      if (Array.isArray(prev.features)) {
        for (const f of prev.features) {
          if (typeof f.name === "string") previousByName.set(f.name, f);
        }
      }
      previousFeaturesGenerated = prev.features_generated;
    } catch (err) {
      console.warn(`Could not parse existing ${OUT_FILE} to preserve test262 fields: ${(err as Error).message}`);
    }
  }

  const mergedResults = results.map((r) => {
    const prev = previousByName.get(r.name);
    if (!prev) return r;
    const carried: Record<string, unknown> = {};
    for (const key of PRESERVED_KEYS) {
      if (key in prev) carried[key] = prev[key];
    }
    return { ...r, ...carried };
  });

  const output: Record<string, unknown> = {
    generated: new Date().toISOString(),
    features: mergedResults,
  };
  // Carry the companion timestamp forward too — it is meaningless to reset it
  // here since this script never touches the fields it describes.
  if (previousFeaturesGenerated) output.features_generated = previousFeaturesGenerated;

  mkdirSync(join(ROOT, "website", "public"), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nWrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
