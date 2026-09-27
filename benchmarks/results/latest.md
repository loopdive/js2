# js2wasm Benchmark Results

Date: 2026-09-27
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.046ms | 0.047ms | 0.048ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.012ms | 0.036ms | 0.009ms | 0.010ms | gc-native |
| string/includes | 0.013ms | 0.066ms | 0.011ms | 0.010ms | linear-memory |
| string/split | 0.260ms | 4.62ms | 1.98ms | FAILED | js |
| string/replace | 0.068ms | 0.357ms | 0.215ms | FAILED | js |
| string/case-convert | 0.041ms | 0.358ms | 0.178ms | FAILED | js |
| string/substring | 0.120ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.241ms | 2.28ms | 1.73ms | FAILED | js |
| string/startsWith-endsWith | 0.360ms | 2.09ms | 2.16ms | 0.391ms | js |
| array/push-pop | 1.17ms | 0.391ms | 0.388ms | FAILED | gc-native |
| array/sort-i32 | 0.530ms | 0.247ms | 0.248ms | FAILED | host-call |
| array/map-filter | 0.113ms | 0.067ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.67ms | 0.413ms | 0.385ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.88ms | 1.88ms | FAILED | host-call |
| array/slice | 0.036ms | 0.037ms | 0.036ms | FAILED | gc-native |
| array/reverse | 4.94ms | 2.72ms | 2.72ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.021ms | 0.024ms | FAILED | host-call |
| array/find | 0.245ms | 0.017ms | 0.015ms | 0.701ms | gc-native |
| dom/create-elements | 0.055ms | 0.089ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.154ms | — | — | js |
| dom/read-attributes | 0.064ms | 0.089ms | — | — | js |
| dom/modify-text | 0.052ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.286ms | 4.77ms | 0.406ms | FAILED | js |
| mixed/text-search | 0.305ms | 2.79ms | 1.80ms | 0.815ms | js |
| mixed/fibonacci | 0.098ms | 0.157ms | 0.156ms | 0.158ms | js |
| mixed/matrix-multiply | 0.143ms | 42.99ms | 48.86ms | 0.616ms | js |
| mixed/sieve | 1.46ms | 1.81ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 4.56 | 4.70 | 4.81 | — |
| string/concat-long | 1000 | 4.19 | 4.45 | 5.10 | — |
| string/indexOf | 1000 | 11.76 | 36.20 | 9.17 | 10.37 |
| string/includes | 1000 | 12.91 | 65.92 | 10.65 | 10.02 |
| string/split | 10000 | 25.97 | 461.74 | 197.95 | — |
| string/replace | 1000 | 67.59 | 357.30 | 214.57 | — |
| string/case-convert | 2000 | 20.34 | 179.16 | 88.87 | — |
| string/substring | 10000 | 12.02 | 2.73 | 2.30 | — |
| string/trim | 10000 | 24.06 | 228.33 | 172.71 | — |
| string/startsWith-endsWith | 20000 | 18.02 | 104.54 | 108.14 | 19.56 |
| array/map-filter | 30000 | 3.76 | 2.24 | 2.19 | — |
| array/indexOf | 1000 | 3906.43 | 1877.27 | 1879.27 | — |
| dom/create-elements | 2000 | 27.45 | 44.33 | — | — |
| dom/set-attributes | 6000 | 18.15 | 25.62 | — | — |
| dom/read-attributes | 3000 | 21.31 | 29.76 | — | — |
| dom/modify-text | 2000 | 25.78 | 43.90 | — | — |
| mixed/csv-parse | 11000 | 26.03 | 433.49 | 36.95 | — |
| mixed/text-search | 40000 | 7.63 | 69.79 | 44.97 | 20.38 |
| mixed/fibonacci | 10000 | 9.78 | 15.65 | 15.65 | 15.81 |
| mixed/matrix-multiply | 125000 | 1.14 | 343.95 | 390.85 | 4.93 |
| mixed/sieve | 200000 | 7.28 | 9.06 | 9.07 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x slower | 1.06x slower | — |
| string/concat-long | 1.06x slower | 1.22x slower | — |
| string/indexOf | 3.08x slower | 1.28x faster | 1.13x faster |
| string/includes | 5.11x slower | 1.21x faster | 1.29x faster |
| string/split | 17.78x slower | 7.62x slower | — |
| string/replace | 5.29x slower | 3.17x slower | — |
| string/case-convert | 8.81x slower | 4.37x slower | — |
| string/substring | 4.40x faster | 5.22x faster | — |
| string/trim | 9.49x slower | 7.18x slower | — |
| string/startsWith-endsWith | 5.80x slower | 6.00x slower | 1.09x slower |
| array/push-pop | 2.99x faster | 3.01x faster | — |
| array/sort-i32 | 2.15x faster | 2.14x faster | — |
| array/map-filter | 1.68x faster | 1.71x faster | — |
| array/reduce | 4.05x faster | 4.34x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.00x slower | 1.02x faster | — |
| array/reverse | 1.81x faster | 1.82x faster | — |
| array/forEach | 2.51x faster | 2.17x faster | — |
| array/find | 14.29x faster | 16.51x faster | 2.85x slower |
| dom/create-elements | 1.62x slower | — | — |
| dom/set-attributes | 1.41x slower | — | — |
| dom/read-attributes | 1.40x slower | — | — |
| dom/modify-text | 1.70x slower | — | — |
| mixed/csv-parse | 16.65x slower | 1.42x slower | — |
| mixed/text-search | 9.15x slower | 5.89x slower | 2.67x slower |
| mixed/fibonacci | 1.60x slower | 1.60x slower | 1.62x slower |
| mixed/matrix-multiply | 300.63x slower | 341.62x slower | 4.31x slower |
| mixed/sieve | 1.24x slower | 1.25x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.15x slower |
| string/indexOf | 3.95x faster |
| string/includes | 6.19x faster |
| string/split | 2.33x faster |
| string/replace | 1.67x faster |
| string/case-convert | 2.02x faster |
| string/substring | 1.19x faster |
| string/trim | 1.32x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.02x faster |
| array/reduce | 1.07x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.16x slower |
| array/find | 1.15x faster |
| mixed/csv-parse | 11.73x faster |
| mixed/text-search | 1.55x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.14x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 818.3ms | 446.9ms | — |
| string/concat-long | 331.0ms | 469.6ms | — |
| string/indexOf | 284.0ms | 455.0ms | 418.3ms |
| string/includes | 301.9ms | 498.0ms | 392.6ms |
| string/split | 372.9ms | 493.9ms | — |
| string/replace | 354.5ms | 547.8ms | — |
| string/case-convert | 378.9ms | 451.0ms | — |
| string/substring | 286.9ms | 360.3ms | — |
| string/trim | 358.3ms | 489.4ms | — |
| string/startsWith-endsWith | 356.7ms | 552.2ms | 534.1ms |
| array/push-pop | 371.2ms | 424.2ms | — |
| array/sort-i32 | 490.3ms | 533.3ms | — |
| array/map-filter | 467.1ms | 551.6ms | — |
| array/reduce | 478.2ms | 488.1ms | — |
| array/indexOf | 422.8ms | 500.1ms | — |
| array/slice | 413.4ms | 436.5ms | — |
| array/reverse | 367.4ms | 434.6ms | — |
| array/forEach | 457.3ms | 596.2ms | — |
| array/find | 389.4ms | 449.9ms | 390.0ms |
| dom/create-elements | 311.4ms | — | — |
| dom/set-attributes | 299.1ms | — | — |
| dom/read-attributes | 284.4ms | — | — |
| dom/modify-text | 286.3ms | — | — |
| mixed/csv-parse | 377.4ms | 480.3ms | — |
| mixed/text-search | 351.8ms | 488.0ms | 447.6ms |
| mixed/fibonacci | 335.7ms | 370.9ms | 367.3ms |
| mixed/matrix-multiply | 463.8ms | 549.7ms | 393.4ms |
| mixed/sieve | 443.6ms | 478.4ms | — |
