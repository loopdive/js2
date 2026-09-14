# js2wasm Benchmark Results

Date: 2026-09-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.077ms | 0.011ms | 0.014ms | gc-native |
| string/split | 0.326ms | 5.93ms | 2.06ms | FAILED | js |
| string/replace | 0.075ms | 0.458ms | 0.213ms | FAILED | js |
| string/case-convert | 0.045ms | 0.421ms | 0.182ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.63ms | 1.81ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.91ms | 1.89ms | 0.432ms | js |
| array/push-pop | 1.28ms | 0.471ms | 0.475ms | FAILED | host-call |
| array/sort-i32 | 0.654ms | 0.233ms | 0.236ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.053ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.28ms | 0.472ms | 0.467ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.869ms | gc-native |
| dom/create-elements | 0.192ms | 0.082ms | — | — | host-call |
| dom/set-attributes | 0.089ms | 0.189ms | — | — | js |
| dom/read-attributes | 0.052ms | 0.127ms | — | — | js |
| dom/modify-text | 0.025ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.362ms | 6.39ms | 0.438ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.36ms | 1.94ms | 0.863ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 49.89ms | 50.81ms | 0.563ms | js |
| mixed/sieve | 1.38ms | 1.80ms | 1.79ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.70 | 4.04 | 3.82 | — |
| string/concat-long | 1000 | 3.37 | 3.96 | 2.90 | — |
| string/indexOf | 1000 | 14.75 | 46.65 | 9.81 | 12.55 |
| string/includes | 1000 | 14.53 | 77.20 | 10.99 | 13.82 |
| string/split | 10000 | 32.62 | 593.40 | 206.49 | — |
| string/replace | 1000 | 74.54 | 457.87 | 213.15 | — |
| string/case-convert | 2000 | 22.46 | 210.40 | 90.89 | — |
| string/substring | 10000 | 8.11 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.42 | 263.36 | 180.98 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 95.53 | 94.66 | 21.60 |
| array/map-filter | 30000 | 3.60 | 1.76 | 1.74 | — |
| array/indexOf | 1000 | 3461.18 | 2224.69 | 2221.59 | — |
| dom/create-elements | 2000 | 96.09 | 41.11 | — | — |
| dom/set-attributes | 6000 | 14.80 | 31.46 | — | — |
| dom/read-attributes | 3000 | 17.38 | 42.25 | — | — |
| dom/modify-text | 2000 | 12.51 | 44.67 | — | — |
| mixed/csv-parse | 11000 | 32.95 | 580.66 | 39.79 | — |
| mixed/text-search | 40000 | 7.81 | 83.97 | 48.54 | 21.56 |
| mixed/fibonacci | 10000 | 9.72 | 25.41 | 25.41 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 399.13 | 406.51 | 4.50 |
| mixed/sieve | 200000 | 6.89 | 9.01 | 8.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.41x slower | — |
| string/concat-long | 1.17x slower | 1.16x faster | — |
| string/indexOf | 3.16x slower | 1.50x faster | 1.18x faster |
| string/includes | 5.31x slower | 1.32x faster | 1.05x faster |
| string/split | 18.19x slower | 6.33x slower | — |
| string/replace | 6.14x slower | 2.86x slower | — |
| string/case-convert | 9.37x slower | 4.05x slower | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 19.63x slower | 13.49x slower | — |
| string/startsWith-endsWith | 5.96x slower | 5.91x slower | 1.35x slower |
| array/push-pop | 2.71x faster | 2.69x faster | — |
| array/sort-i32 | 2.80x faster | 2.77x faster | — |
| array/map-filter | 2.05x faster | 2.07x faster | — |
| array/reduce | 2.70x faster | 2.73x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.21x faster | 2.13x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.90x faster | 1.89x faster | — |
| array/find | 17.56x faster | 17.61x faster | 4.08x slower |
| dom/create-elements | 2.34x faster | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.43x slower | — | — |
| dom/modify-text | 3.57x slower | — | — |
| mixed/csv-parse | 17.62x slower | 1.21x slower | — |
| mixed/text-search | 10.75x slower | 6.21x slower | 2.76x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 341.02x slower | 347.33x slower | 3.85x slower |
| mixed/sieve | 1.31x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.37x faster |
| string/indexOf | 4.75x faster |
| string/includes | 7.03x faster |
| string/split | 2.87x faster |
| string/replace | 2.15x faster |
| string/case-convert | 2.31x faster |
| string/substring | 1.16x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.59x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 853.3ms | 503.9ms | — |
| string/concat-long | 343.3ms | 499.4ms | — |
| string/indexOf | 291.7ms | 518.4ms | 422.5ms |
| string/includes | 287.7ms | 509.6ms | 439.0ms |
| string/split | 376.7ms | 515.2ms | — |
| string/replace | 385.3ms | 582.1ms | — |
| string/case-convert | 384.4ms | 446.6ms | — |
| string/substring | 309.0ms | 369.7ms | — |
| string/trim | 376.7ms | 522.5ms | — |
| string/startsWith-endsWith | 415.1ms | 533.0ms | 475.9ms |
| array/push-pop | 383.5ms | 428.7ms | — |
| array/sort-i32 | 496.1ms | 525.8ms | — |
| array/map-filter | 526.6ms | 564.1ms | — |
| array/reduce | 447.0ms | 527.5ms | — |
| array/indexOf | 441.9ms | 517.0ms | — |
| array/slice | 397.9ms | 471.0ms | — |
| array/reverse | 377.0ms | 434.0ms | — |
| array/forEach | 488.4ms | 547.3ms | — |
| array/find | 381.4ms | 428.6ms | 423.2ms |
| dom/create-elements | 355.3ms | — | — |
| dom/set-attributes | 320.3ms | — | — |
| dom/read-attributes | 327.2ms | — | — |
| dom/modify-text | 324.8ms | — | — |
| mixed/csv-parse | 397.1ms | 525.3ms | — |
| mixed/text-search | 380.9ms | 549.2ms | 492.3ms |
| mixed/fibonacci | 352.5ms | 396.3ms | 362.7ms |
| mixed/matrix-multiply | 473.1ms | 542.2ms | 400.1ms |
| mixed/sieve | 449.8ms | 506.2ms | — |
