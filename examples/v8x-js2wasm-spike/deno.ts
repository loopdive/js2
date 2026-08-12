// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// First typed v8x <-> Deno host seam. Strings stay inside the Wasm program:
// the Rust host exposes primitive UTF-16 operations and this AOT wrapper
// reconstructs the JavaScript string returned by Deno.cwd().
declare function __v8x_op_cwd_utf16_length(): number;
declare function __v8x_op_cwd_utf16_code_unit(index: number): number;

function cwd(): string {
  const length = __v8x_op_cwd_utf16_length();
  let value = "";
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(__v8x_op_cwd_utf16_code_unit(index));
  }
  return value;
}

export const Deno = { cwd };
