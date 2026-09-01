// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Minimal `%Iterator%` provisioning shared by the legacy wrapper and the
// literal original-harness assembler. Keep this module plain, side-effect-free
// JavaScript: both the forked Test262 worker tooling and TypeScript test files
// consume it without a TypeScript loader.

// The iterator-helpers proposal exposes `%IteratorPrototype%` through an
// Array iterator's prototype chain. js2 does not otherwise provide a global
// `Iterator` constructor, so tests that extend the intrinsic need this minimal
// constructor-shaped binding in their compiled source.
export const ITERATOR_BINDING_PREAMBLE = `
function Iterator() {}
Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
`;

// Preserve the legacy wrapper's intentionally broad source predicate. It is
// a provision gate, not a parser: false positives merely add a local shim,
// while a declaration in the test body must always win over the harness one.
export function needsIteratorBinding(source) {
  return /\bIterator\b/.test(source) && !/\b(?:var|let|const|function|class)\s+Iterator\b/.test(source);
}
