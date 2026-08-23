#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Emit the npm-compat measurement matrix for CI as JSON:
//   {"fast": ["acorn", …], "slow": ["react-dom", "lit"]}
//
// npm-compat-refresh.yml builds its per-package matrix rows from this output
// (`fromJSON`), so adding a package to the catalog — or flagging one
// `"longPole": true` — auto-scales the workflow with NO YAML edit. The
// enumeration is the SAME one the generator measures
// (NPM_COMPAT_ALL_PACKAGE_NAMES), so the matrix can never drift from what
// `generate:npm-compat` actually covers.
//
// Pure repo-file read (node builtins only): safe to run in a 30-second
// planner job without pnpm install.

import { NPM_COMPAT_ALL_PACKAGE_NAMES, NPM_COMPAT_LONG_POLE_NAMES } from "../tests/dogfood/npm-compat-catalog.mjs";

const slow = [...NPM_COMPAT_LONG_POLE_NAMES];
const slowSet = new Set(slow);
const fast = NPM_COMPAT_ALL_PACKAGE_NAMES.filter((name) => !slowSet.has(name));

if (fast.length === 0) throw new Error("npm-compat package catalog resolved to an empty fast lane");

process.stdout.write(`${JSON.stringify({ fast, slow })}\n`);
