// Shared op list for the clsx dogfood harness (#3748).
//
// clsx's real exported `clsx()` is variadic (reads `arguments` with zero
// declared parameters) — calling it directly across the wasm export
// boundary always observes zero arguments, an inherent fixed-arity Wasm
// export-ABI limitation (verified independent of clsx; not a compiler bug —
// see clsx-pin.json's `_note`). So every op here is a fixed-arity INTERNAL
// call into clsx with hardcoded literal arguments, expressed as the BODY of
// a `return <expr>;` statement.
//
// The exact same `code` string drives BOTH sides of the diff:
//   - compiled:  `export function ${name}() { ${code} }`, appended as a
//     driver epilogue after the unmodified pinned clsx source (clsx-harness.mjs)
//   - native:    `new Function("clsx", code)` bound to the SAME pinned
//     tarball's native `clsx` export (via require)
// so there is no separate "oracle op" to accidentally write differently
// from the "compiled op" — any divergence is a real compiler bug, never a
// harness authoring slip.
export const CLSX_OPS = [
  { name: "op_two_strings", code: "return clsx('foo', 'bar');" },
  { name: "op_single_string", code: "return clsx('foo');" },
  { name: "op_no_args", code: "return clsx();" },
  { name: "op_falsy_mixed", code: "return clsx('a', 0, null, undefined, false, '', 'b');" },
  { name: "op_number_arg", code: "return clsx(1, 'a', 0, 'b');" },
  { name: "op_object_mixed", code: "return clsx('a', { b: true, c: false, d: true });" },
  { name: "op_object_all_false", code: "return clsx({ a: false, b: false });" },
  { name: "op_object_only", code: "return clsx({ foo: true, bar: 1, baz: 0, qux: true });" },
  { name: "op_array_flat", code: "return clsx(['a', 'b', 'c']);" },
  { name: "op_array_with_falsy", code: "return clsx(['a', null, 'b', false, 0, 'c']);" },
  { name: "op_array_nested", code: "return clsx(['a', ['b', 'c'], 'd']);" },
  { name: "op_array_deeply_nested", code: "return clsx([['a', ['b']], 'c']);" },
  {
    name: "op_mixed_all_kinds",
    code: "return clsx('base', { active: true, disabled: false }, ['extra', 'classes'], null, 'end');",
  },
  { name: "op_empty_object", code: "return clsx({});" },
  { name: "op_empty_array", code: "return clsx([]);" },
  { name: "op_whitespace_string", code: "return clsx('  ', 'a');" },
  { name: "op_duplicate_classes", code: "return clsx('a', 'a', 'b', 'a');" },
  { name: "op_array_of_objects", code: "return clsx([{ a: true, b: false }, { c: true }]);" },
];
