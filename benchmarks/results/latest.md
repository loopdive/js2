# js2wasm Benchmark Results

Date: 2026-10-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.046ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.123ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.425ms | 8.37ms | 2.85ms | FAILED | js |
| string/replace | 0.106ms | 0.703ms | 0.326ms | FAILED | js |
| string/case-convert | 0.056ms | 0.587ms | 0.291ms | FAILED | js |
| string/substring | 0.101ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.01ms | 2.92ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.12ms | 3.09ms | 0.560ms | js |
| array/push-pop | 1.41ms | 0.500ms | 0.510ms | FAILED | host-call |
| array/sort-i32 | 0.792ms | 0.294ms | 0.296ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.498ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.65ms | 2.65ms | FAILED | host-call |
| array/slice | 0.026ms | 0.029ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.041ms | 0.177ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.122ms | — | — | js |
| dom/modify-text | 0.030ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.488ms | 8.64ms | 0.631ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.24ms | 2.80ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.163ms | 72.78ms | 77.08ms | 0.720ms | js |
| mixed/sieve | 1.55ms | 2.12ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.47 | 4.63 | 4.47 | — |
| string/concat-long | 1000 | 3.59 | 4.55 | 3.77 | — |
| string/indexOf | 1000 | 19.17 | 63.99 | 12.41 | 16.11 |
| string/includes | 1000 | 19.25 | 123.34 | 14.86 | 18.67 |
| string/split | 10000 | 42.51 | 836.88 | 285.21 | — |
| string/replace | 1000 | 105.59 | 703.08 | 326.19 | — |
| string/case-convert | 2000 | 27.82 | 293.74 | 145.46 | — |
| string/substring | 10000 | 10.09 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.99 | 400.98 | 292.46 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 155.78 | 154.63 | 28.02 |
| array/map-filter | 30000 | 4.23 | 2.36 | 2.36 | — |
| array/indexOf | 1000 | 3957.72 | 2646.63 | 2647.05 | — |
| dom/create-elements | 2000 | 20.72 | 88.75 | — | — |
| dom/set-attributes | 6000 | 17.37 | 36.54 | — | — |
| dom/read-attributes | 3000 | 18.69 | 40.66 | — | — |
| dom/modify-text | 2000 | 15.02 | 53.63 | — | — |
| mixed/csv-parse | 11000 | 44.40 | 785.19 | 57.36 | — |
| mixed/text-search | 40000 | 9.73 | 131.09 | 70.03 | 27.02 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.31 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.30 | 582.27 | 616.64 | 5.76 |
| mixed/sieve | 200000 | 7.76 | 10.61 | 10.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.33x slower | 1.29x slower | — |
| string/concat-long | 1.27x slower | 1.05x slower | — |
| string/indexOf | 3.34x slower | 1.54x faster | 1.19x faster |
| string/includes | 6.41x slower | 1.30x faster | 1.03x faster |
| string/split | 19.69x slower | 6.71x slower | — |
| string/replace | 6.66x slower | 3.09x slower | — |
| string/case-convert | 10.56x slower | 5.23x slower | — |
| string/substring | 2.70x faster | 3.28x faster | — |
| string/trim | 23.61x slower | 17.22x slower | — |
| string/startsWith-endsWith | 7.77x slower | 7.71x slower | 1.40x slower |
| array/push-pop | 2.82x faster | 2.76x faster | — |
| array/sort-i32 | 2.70x faster | 2.68x faster | — |
| array/map-filter | 1.79x faster | 1.79x faster | — |
| array/reduce | 4.36x faster | 4.30x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.80x faster | 1.80x faster | — |
| array/find | 15.93x faster | 16.05x faster | 4.24x slower |
| dom/create-elements | 4.28x slower | — | — |
| dom/set-attributes | 2.10x slower | — | — |
| dom/read-attributes | 2.18x slower | — | — |
| dom/modify-text | 3.57x slower | — | — |
| mixed/csv-parse | 17.68x slower | 1.29x slower | — |
| mixed/text-search | 13.47x slower | 7.20x slower | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 446.59x slower | 472.95x slower | 4.41x slower |
| mixed/sieve | 1.37x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.16x faster |
| string/includes | 8.30x faster |
| string/split | 2.93x faster |
| string/replace | 2.16x faster |
| string/case-convert | 2.02x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.69x faster |
| mixed/text-search | 1.87x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1155.4ms | 627.4ms | — |
| string/concat-long | 433.7ms | 649.2ms | — |
| string/indexOf | 375.9ms | 677.9ms | 561.3ms |
| string/includes | 385.6ms | 688.4ms | 598.0ms |
| string/split | 512.7ms | 670.3ms | — |
| string/replace | 508.5ms | 719.0ms | — |
| string/case-convert | 521.6ms | 599.9ms | — |
| string/substring | 389.9ms | 459.5ms | — |
| string/trim | 485.4ms | 693.7ms | — |
| string/startsWith-endsWith | 469.2ms | 689.2ms | 599.6ms |
| array/push-pop | 503.5ms | 595.5ms | — |
| array/sort-i32 | 694.8ms | 745.8ms | — |
| array/map-filter | 684.7ms | 725.6ms | — |
| array/reduce | 606.8ms | 692.8ms | — |
| array/indexOf | 596.2ms | 664.6ms | — |
| array/slice | 502.5ms | 620.5ms | — |
| array/reverse | 505.9ms | 590.9ms | — |
| array/forEach | 643.5ms | 694.6ms | — |
| array/find | 504.6ms | 574.0ms | 531.3ms |
| dom/create-elements | 406.9ms | — | — |
| dom/set-attributes | 375.5ms | — | — |
| dom/read-attributes | 385.5ms | — | — |
| dom/modify-text | 379.3ms | — | — |
| mixed/csv-parse | 534.7ms | 677.2ms | — |
| mixed/text-search | 510.4ms | 711.3ms | 610.7ms |
| mixed/fibonacci | 441.0ms | 482.8ms | 475.1ms |
| mixed/matrix-multiply | 623.1ms | 702.0ms | 514.3ms |
| mixed/sieve | 601.7ms | 684.2ms | — |
