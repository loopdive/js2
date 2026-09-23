// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6438 — acorn-shaped fnctor graph (from #1712) plus a genuinely field-less
// class instance, so "decoded to {}" and "undecodable" can be told apart.
// @ts-nocheck

var Node = function Node(type) {
  this.type = type;
};

var Parser = function Parser(input) {
  this.input = String(input);
};

Parser.prototype.parse = function parse() {
  return new Node("Program");
};

class Empty {
  m() {
    return 1;
  }
}

export function parse(input) {
  return new Parser(input).parse();
}

export function nodes() {
  return [new Node("A")];
}

export function empty() {
  return new Empty();
}

export function name(input) {
  return new Parser(input).parse().type;
}
