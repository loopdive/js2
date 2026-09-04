# js2wasm Benchmark Results

Date: 2026-09-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.049ms | 0.047ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.133ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.425ms | 8.25ms | 2.80ms | FAILED | js |
| string/replace | 0.109ms | 0.670ms | 0.331ms | FAILED | js |
| string/case-convert | 0.056ms | 0.625ms | 0.260ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.79ms | 2.63ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.76ms | 2.87ms | 0.560ms | js |
| array/push-pop | 1.45ms | 0.503ms | 0.498ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.18ms | 0.510ms | 0.508ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.037ms | 0.161ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.537ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.120ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.481ms | 8.74ms | 1.03ms | FAILED | js |
| mixed/text-search | 0.388ms | 4.61ms | 2.81ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.162ms | 72.78ms | 72.14ms | 0.721ms | js |
| mixed/sieve | 1.61ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.25 | 4.91 | 4.72 | — |
| string/concat-long | 1000 | 3.74 | 4.49 | 3.71 | — |
| string/indexOf | 1000 | 19.16 | 64.47 | 12.43 | 14.62 |
| string/includes | 1000 | 19.22 | 132.52 | 14.80 | 16.03 |
| string/split | 10000 | 42.45 | 824.82 | 279.68 | — |
| string/replace | 1000 | 109.44 | 669.71 | 330.54 | — |
| string/case-convert | 2000 | 28.21 | 312.28 | 130.23 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 379.12 | 263.16 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 138.18 | 143.65 | 28.01 |
| array/map-filter | 30000 | 4.29 | 2.36 | 2.37 | — |
| array/indexOf | 1000 | 3952.91 | 2641.20 | 2639.26 | — |
| dom/create-elements | 2000 | 18.48 | 80.51 | — | — |
| dom/set-attributes | 6000 | 17.37 | 89.58 | — | — |
| dom/read-attributes | 3000 | 18.15 | 39.90 | — | — |
| dom/modify-text | 2000 | 14.41 | 53.03 | — | — |
| mixed/csv-parse | 11000 | 43.75 | 794.94 | 93.96 | — |
| mixed/text-search | 40000 | 9.70 | 115.22 | 70.28 | 27.40 |
| mixed/fibonacci | 10000 | 12.01 | 28.29 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.29 | 582.25 | 577.10 | 5.77 |
| mixed/sieve | 200000 | 8.06 | 10.59 | 10.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.45x slower | — |
| string/concat-long | 1.20x slower | 1.01x faster | — |
| string/indexOf | 3.36x slower | 1.54x faster | 1.31x faster |
| string/includes | 6.89x slower | 1.30x faster | 1.20x faster |
| string/split | 19.43x slower | 6.59x slower | — |
| string/replace | 6.12x slower | 3.02x slower | — |
| string/case-convert | 11.07x slower | 4.62x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 22.30x slower | 15.48x slower | — |
| string/startsWith-endsWith | 6.90x slower | 7.17x slower | 1.40x slower |
| array/push-pop | 2.89x faster | 2.92x faster | — |
| array/sort-i32 | 2.71x faster | 2.70x faster | — |
| array/map-filter | 1.82x faster | 1.81x faster | — |
| array/reduce | 4.27x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.07x slower | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.74x faster | 1.72x faster | — |
| array/find | 15.62x faster | 15.75x faster | 4.24x slower |
| dom/create-elements | 4.36x slower | — | — |
| dom/set-attributes | 5.16x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.68x slower | — | — |
| mixed/csv-parse | 18.17x slower | 2.15x slower | — |
| mixed/text-search | 11.87x slower | 7.24x slower | 2.82x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 450.15x slower | 446.16x slower | 4.46x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.19x faster |
| string/includes | 8.95x faster |
| string/split | 2.95x faster |
| string/replace | 2.03x faster |
| string/case-convert | 2.40x faster |
| string/substring | 1.22x faster |
| string/trim | 1.44x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 8.46x faster |
| mixed/text-search | 1.64x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x slower |

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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
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
| string/concat-short | 1710.2ms | 1111.5ms | — |
| string/concat-long | 798.5ms | 973.9ms | — |
| string/indexOf | 667.4ms | 990.8ms | 884.0ms |
| string/includes | 661.3ms | 994.5ms | 839.1ms |
| string/split | 778.4ms | 969.0ms | — |
| string/replace | 794.0ms | 1031.4ms | — |
| string/case-convert | 793.8ms | 869.2ms | — |
| string/substring | 648.0ms | 750.0ms | — |
| string/trim | 750.3ms | 978.0ms | — |
| string/startsWith-endsWith | 781.6ms | 972.2ms | 907.4ms |
| array/push-pop | 785.7ms | 842.4ms | — |
| array/sort-i32 | 973.2ms | 999.1ms | — |
| array/map-filter | 957.6ms | 1015.7ms | — |
| array/reduce | 900.1ms | 920.0ms | — |
| array/indexOf | 854.0ms | 957.7ms | — |
| array/slice | 793.1ms | 849.6ms | — |
| array/reverse | 774.6ms | 860.9ms | — |
| array/forEach | 881.6ms | 977.9ms | — |
| array/find | 779.9ms | 862.3ms | 827.8ms |
| dom/create-elements | 720.7ms | — | — |
| dom/set-attributes | 733.8ms | — | — |
| dom/read-attributes | 693.7ms | — | — |
| dom/modify-text | 664.6ms | — | — |
| mixed/csv-parse | 848.3ms | 956.1ms | — |
| mixed/text-search | 813.1ms | 985.4ms | 913.7ms |
| mixed/fibonacci | 759.7ms | 845.3ms | 760.5ms |
| mixed/matrix-multiply | 905.7ms | 1014.0ms | 856.1ms |
| mixed/sieve | 942.6ms | 962.6ms | — |
