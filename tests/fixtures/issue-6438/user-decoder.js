// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6438 / #3520 control — the module declares its OWN `__struct_field_names`.
// A user-authored helper of that name must never become the boundary decoder,
// so the raw-record overload still refuses and the Instance overload still
// answers the compiler's names.
// @ts-nocheck

var Node = function Node(type) {
  this.type = type;
};

export function parse() {
  return new Node("Program");
}

export function __struct_field_names() {
  return "type";
}
