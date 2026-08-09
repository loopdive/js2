// Emit-identity corpus (#3105): a program that exercises the JSON runtime
// counter-loops in src/codegen/json-runtime.ts so the counter-loop scaffolds
// are present in the emitted binary. Without a JSON-using corpus file the
// counter-loop byte-identity proof would be vacuous (the website/playground
// examples do not force emitJsonQuoteString / emitJsonParsePrimitive).
//
//  - `JSON.stringify(<string with escapable + control chars>)` forces
//    emitJsonQuoteString (the char-scan out-length loop + the escape-write loop).
//  - `JSON.parse(<primitive>)` forces emitJsonParsePrimitive (the digit / token
//    scan loops).
//
// Kept DOM-free / Promise-free / class-field-free so it compiles under the gc,
// standalone, and wasi targets (where the WasmGC JSON runtime is emitted).

export function run(): number {
  let total = 0;

  // emitJsonQuoteString — a string containing quote, backslash, and control
  // chars exercises both the length-scan loop and the escape-write loop.
  const quoted = JSON.stringify('a"b\\c\n\tde');
  total += quoted.length;

  // emitJsonParsePrimitive — parse a numeric primitive (the digit-scan loop).
  total += JSON.parse("12345") as number;
  total += JSON.parse("-67") as number;

  return total;
}
