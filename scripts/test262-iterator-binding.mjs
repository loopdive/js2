// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Minimal `%Iterator%` provisioning shared by the legacy wrapper and the
// literal original-harness assembler. Keep this module plain, side-effect-free
// JavaScript: both the forked Test262 worker tooling and TypeScript test files
// consume it without a TypeScript loader.

// The iterator-helpers proposal exposes `%IteratorPrototype%` through an
// Array iterator's prototype chain. js2 does not otherwise provide a global
// `Iterator` constructor BINDING, so tests that extend the intrinsic need a
// constructor-shaped binding in their compiled source.
//
// (#6492 round 4b) It must be the REAL `%Iterator%` whenever one exists, not a
// synthetic stand-in. There is one, and `%IteratorPrototype%.constructor`
// reaches it even though the binding site shadows the name: the runtime's
// iterator-helper polyfill installs `from`/`concat`/`zip`/`zipKeyed` on it (and
// on a host that ships the helpers natively it IS the host's `Iterator`, which
// also carries `chunks`/`windows` on its prototype). A synthetic
// `function Iterator() {}` shadows all of that, which is exactly what round 4's
// first cut did: it fixed 120 rows that need the BINDING and regressed 19 that
// need the STATICS (`Iterator/{concat,from,zip,zipKeyed}/*`,
// `Iterator/prototype/{chunks,windows}/*`), because before the shim existed
// those member reads resolved through the compiler's builtin machinery to the
// real object while the bare identifier read `undefined`.
//
// The binding must stay a js2-COMPILED function while its MEMBERS answer like
// the intrinsic. Measured, not assumed: binding `Iterator` directly to the
// intrinsic restores every static but makes `new (class Sub extends Iterator {})
// instanceof Iterator` FALSE — a compiled class instance does not satisfy
// `instanceof` against a host function — which is the 120-row half again, from
// the other side. So the shim keeps the binding and the constructor role, its
// `.prototype` stays `%IteratorPrototype%` (so every prototype method,
// including a host-only `chunks`/`windows`, resolves exactly as it did before
// any shim existed), and the intrinsic's own function-valued statics are copied
// onto it.
//
// The copy is an enumeration rather than a fixed list of the four ES2025
// statics because the set is engine-dependent — CI runs a newer Node than a
// dev container, and a hand list silently omits whatever the newer engine
// added. `length`/`name`/`prototype` are excluded so the shim keeps its own
// (`Iterator.name === "Iterator"`, arity 0). Written in the plainest possible
// dialect (no IIFE, no spread, no `isPrototypeOf`, no `for…of`) because this
// source is compiled by js2 itself.
export const ITERATOR_BINDING_PREAMBLE = `
function Iterator() {}
Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
var __js2wasmIteratorIntrinsic = Iterator.prototype.constructor;
if (typeof __js2wasmIteratorIntrinsic === "function") {
  var __js2wasmIteratorStatics = Object.getOwnPropertyNames(__js2wasmIteratorIntrinsic);
  for (var __js2wasmIteratorI = 0; __js2wasmIteratorI < __js2wasmIteratorStatics.length; __js2wasmIteratorI++) {
    var __js2wasmIteratorKey = __js2wasmIteratorStatics[__js2wasmIteratorI];
    if (__js2wasmIteratorKey === "length") continue;
    if (__js2wasmIteratorKey === "name") continue;
    if (__js2wasmIteratorKey === "prototype") continue;
    if (typeof __js2wasmIteratorIntrinsic[__js2wasmIteratorKey] !== "function") continue;
    Iterator[__js2wasmIteratorKey] = __js2wasmIteratorIntrinsic[__js2wasmIteratorKey];
  }
}
`;

/**
 * (#6492 round 4b) The predicate is still deliberately broad — a provision
 * gate, not a parser — but it no longer counts mentions inside COMMENTS.
 *
 * "A false positive merely adds a local shim" was true of a shim that only
 * declared a name, and stopped being true once the shim reads
 * `%IteratorPrototype%.constructor` and copies statics: measured, injecting it
 * into `Iterator/prototype/{drop,take}/underlying-iterator-advanced-in-parallel.js`
 * — whose ONLY occurrence of `Iterator` is `%Iterator.prototype%.drop` in the
 * frontmatter `info:` block — flips those rows from pass to fail. A body that
 * never names `Iterator` in code cannot reference the binding, so declining
 * there is free.
 *
 * Stripping runs before BOTH halves of the test, so a declaration commented out
 * no longer suppresses a binding the code below it needs either.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

export function needsIteratorBinding(source) {
  const code = stripComments(source);
  return /\bIterator\b/.test(code) && !/\b(?:var|let|const|function|class)\s+Iterator\b/.test(code);
}
