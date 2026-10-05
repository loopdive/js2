# js2wasm Benchmark Results

Date: 2026-10-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.025ms | 0.042ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.083ms | 0.011ms | 0.021ms | gc-native |
| string/split | 0.327ms | 6.20ms | 2.15ms | FAILED | js |
| string/replace | 0.077ms | 0.457ms | 0.224ms | FAILED | js |
| string/case-convert | 0.046ms | 0.416ms | 0.192ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.60ms | 1.94ms | FAILED | js |
| string/startsWith-endsWith | 0.321ms | 2.05ms | 1.99ms | 0.436ms | js |
| array/push-pop | 1.34ms | 0.488ms | 0.491ms | FAILED | host-call |
| array/sort-i32 | 0.660ms | 0.231ms | 0.239ms | FAILED | host-call |
| array/map-filter | 0.112ms | 0.054ms | 0.054ms | FAILED | gc-native |
| array/reduce | 1.36ms | 0.502ms | 0.484ms | FAILED | gc-native |
| array/indexOf | 3.57ms | 2.25ms | 2.25ms | FAILED | host-call |
| array/slice | 0.038ms | 0.016ms | 0.016ms | FAILED | gc-native |
| array/reverse | 6.93ms | 3.15ms | 3.09ms | FAILED | gc-native |
| array/forEach | 0.046ms | 0.024ms | 0.023ms | FAILED | gc-native |
| array/find | 0.216ms | 0.013ms | 0.013ms | 0.873ms | host-call |
| dom/create-elements | 0.222ms | 0.112ms | — | — | host-call |
| dom/set-attributes | 0.093ms | 0.203ms | — | — | js |
| dom/read-attributes | 0.062ms | 0.111ms | — | — | js |
| dom/modify-text | 0.027ms | 0.097ms | — | — | js |
| mixed/csv-parse | 0.366ms | 6.12ms | 0.450ms | FAILED | js |
| mixed/text-search | 0.333ms | 3.61ms | 1.97ms | 0.926ms | js |
| mixed/fibonacci | 0.103ms | 0.258ms | 0.265ms | 0.263ms | js |
| mixed/matrix-multiply | 0.154ms | 52.19ms | 54.16ms | 0.599ms | js |
| mixed/sieve | 1.45ms | 1.83ms | 1.86ms | FAILED | js |

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
| string/concat-short | 10000 | 2.51 | 4.23 | 3.91 | — |
| string/concat-long | 1000 | 3.44 | 4.08 | 3.16 | — |
| string/indexOf | 1000 | 14.85 | 47.03 | 9.87 | 12.95 |
| string/includes | 1000 | 14.55 | 83.05 | 11.16 | 21.28 |
| string/split | 10000 | 32.69 | 619.60 | 215.00 | — |
| string/replace | 1000 | 77.23 | 457.00 | 224.03 | — |
| string/case-convert | 2000 | 22.81 | 208.02 | 95.97 | — |
| string/substring | 10000 | 8.14 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.41 | 259.67 | 194.48 | — |
| string/startsWith-endsWith | 20000 | 16.03 | 102.49 | 99.29 | 21.81 |
| array/map-filter | 30000 | 3.75 | 1.81 | 1.80 | — |
| array/indexOf | 1000 | 3571.87 | 2247.87 | 2252.95 | — |
| dom/create-elements | 2000 | 111.17 | 56.00 | — | — |
| dom/set-attributes | 6000 | 15.43 | 33.79 | — | — |
| dom/read-attributes | 3000 | 20.62 | 37.15 | — | — |
| dom/modify-text | 2000 | 13.41 | 48.42 | — | — |
| mixed/csv-parse | 11000 | 33.24 | 556.71 | 40.91 | — |
| mixed/text-search | 40000 | 8.32 | 90.29 | 49.32 | 23.16 |
| mixed/fibonacci | 10000 | 10.29 | 25.81 | 26.53 | 26.28 |
| mixed/matrix-multiply | 125000 | 1.23 | 417.54 | 433.30 | 4.79 |
| mixed/sieve | 200000 | 7.27 | 9.17 | 9.29 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.69x slower | 1.56x slower | — |
| string/concat-long | 1.18x slower | 1.09x faster | — |
| string/indexOf | 3.17x slower | 1.50x faster | 1.15x faster |
| string/includes | 5.71x slower | 1.30x faster | 1.46x slower |
| string/split | 18.96x slower | 6.58x slower | — |
| string/replace | 5.92x slower | 2.90x slower | — |
| string/case-convert | 9.12x slower | 4.21x slower | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 19.36x slower | 14.50x slower | — |
| string/startsWith-endsWith | 6.39x slower | 6.19x slower | 1.36x slower |
| array/push-pop | 2.74x faster | 2.72x faster | — |
| array/sort-i32 | 2.86x faster | 2.77x faster | — |
| array/map-filter | 2.07x faster | 2.08x faster | — |
| array/reduce | 2.71x faster | 2.81x faster | — |
| array/indexOf | 1.59x faster | 1.59x faster | — |
| array/slice | 2.39x faster | 2.42x faster | — |
| array/reverse | 2.20x faster | 2.24x faster | — |
| array/forEach | 1.96x faster | 1.98x faster | — |
| array/find | 17.12x faster | 16.54x faster | 4.04x slower |
| dom/create-elements | 1.99x faster | — | — |
| dom/set-attributes | 2.19x slower | — | — |
| dom/read-attributes | 1.80x slower | — | — |
| dom/modify-text | 3.61x slower | — | — |
| mixed/csv-parse | 16.75x slower | 1.23x slower | — |
| mixed/text-search | 10.86x slower | 5.93x slower | 2.79x slower |
| mixed/fibonacci | 2.51x slower | 2.58x slower | 2.55x slower |
| mixed/matrix-multiply | 338.87x slower | 351.66x slower | 3.89x slower |
| mixed/sieve | 1.26x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.29x faster |
| string/indexOf | 4.76x faster |
| string/includes | 7.44x faster |
| string/split | 2.88x faster |
| string/replace | 2.04x faster |
| string/case-convert | 2.17x faster |
| string/substring | 1.16x faster |
| string/trim | 1.34x faster |
| string/startsWith-endsWith | 1.03x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.04x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.02x faster |
| array/forEach | 1.01x faster |
| array/find | 1.04x slower |
| mixed/csv-parse | 13.61x faster |
| mixed/text-search | 1.83x faster |
| mixed/fibonacci | 1.03x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 900.9ms | 486.2ms | — |
| string/concat-long | 384.6ms | 508.3ms | — |
| string/indexOf | 303.4ms | 532.5ms | 429.5ms |
| string/includes | 313.0ms | 521.2ms | 443.8ms |
| string/split | 423.2ms | 544.7ms | — |
| string/replace | 428.6ms | 573.4ms | — |
| string/case-convert | 420.8ms | 463.6ms | — |
| string/substring | 309.6ms | 377.4ms | — |
| string/trim | 383.3ms | 548.1ms | — |
| string/startsWith-endsWith | 419.9ms | 563.3ms | 494.6ms |
| array/push-pop | 409.1ms | 472.9ms | — |
| array/sort-i32 | 508.2ms | 550.5ms | — |
| array/map-filter | 546.9ms | 594.4ms | — |
| array/reduce | 488.9ms | 545.3ms | — |
| array/indexOf | 479.5ms | 531.0ms | — |
| array/slice | 422.6ms | 501.4ms | — |
| array/reverse | 414.7ms | 482.8ms | — |
| array/forEach | 495.9ms | 562.3ms | — |
| array/find | 396.7ms | 460.8ms | 411.3ms |
| dom/create-elements | 360.7ms | — | — |
| dom/set-attributes | 345.4ms | — | — |
| dom/read-attributes | 317.9ms | — | — |
| dom/modify-text | 307.7ms | — | — |
| mixed/csv-parse | 409.1ms | 533.7ms | — |
| mixed/text-search | 412.7ms | 597.3ms | 507.9ms |
| mixed/fibonacci | 391.9ms | 417.4ms | 389.6ms |
| mixed/matrix-multiply | 501.7ms | 570.2ms | 406.4ms |
| mixed/sieve | 471.3ms | 564.3ms | — |
