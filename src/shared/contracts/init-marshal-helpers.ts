// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const NATIVE_STRING_MEMORY_READER = "__\0js2_str_mem_read16";

/** Wire IDs for __register_init_export. Append only: existing IDs are permanent. */
export const INIT_MARSHAL_HELPER_NAMES: readonly string[] = [
  "__vec_len",
  "__vec_get",
  "__is_vec",
  "__dv_byte_len",
  "__dv_byte_get",
  "__ab_max_len",
  "__\0js2_is_date",
  "__\0js2_date_value",
  "__str_is_native",
  "__str_to_extern",
  "__dynamic_boundary_tag",
  "__typeof_number",
  "__unbox_number",
  "__typeof_boolean",
  "__unbox_boolean",
  "__typeof_bigint",
  "__to_bigint",
  NATIVE_STRING_MEMORY_READER,
];
