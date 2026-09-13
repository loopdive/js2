// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { encodeLength, roundTrip } from "./lib.js";

export function utf8Length(text) {
  return encodeLength(text);
}

export function echo(text) {
  return roundTrip(text);
}
