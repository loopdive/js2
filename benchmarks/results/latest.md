# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.134ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.408ms | 5.07ms | 0.449ms | FAILED | js |
| string/replace | 0.109ms | 0.293ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.264ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.904ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.361ms | 0.295ms | 0.561ms | gc-native |
| array/push-pop | 1.45ms | 0.508ms | 0.506ms | FAILED | gc-native |
| array/sort-i32 | 0.795ms | 0.293ms | 0.295ms | FAILED | host-call |
| array/map-filter | 0.139ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.503ms | 0.499ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 0.998ms | host-call |
| dom/create-elements | 0.189ms | 0.160ms | — | — | host-call |
| dom/set-attributes | 0.105ms | 0.478ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.124ms | — | — | js |
| dom/modify-text | 0.032ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.475ms | 7.23ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.72ms | 0.265ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.285ms | js |
| mixed/matrix-multiply | 0.157ms | 0.210ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.58ms | 1.39ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.13 | 4.53 | 3.75 | — |
| string/concat-long | 1000 | 3.83 | 4.49 | 3.70 | — |
| string/indexOf | 1000 | 19.15 | 62.76 | 12.51 | 14.77 |
| string/includes | 1000 | 19.25 | 133.97 | 14.76 | 70.68 |
| string/split | 10000 | 40.76 | 507.28 | 44.88 | — |
| string/replace | 1000 | 108.58 | 292.64 | 56.44 | — |
| string/case-convert | 2000 | 27.83 | 131.75 | 2.51 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 90.43 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.12 | 18.03 | 14.77 | 28.03 |
| array/map-filter | 30000 | 4.63 | 2.34 | 2.34 | — |
| array/indexOf | 1000 | 3948.27 | 2632.85 | 2634.11 | — |
| dom/create-elements | 2000 | 94.39 | 80.07 | — | — |
| dom/set-attributes | 6000 | 17.51 | 79.73 | — | — |
| dom/read-attributes | 3000 | 19.27 | 41.18 | — | — |
| dom/modify-text | 2000 | 15.80 | 54.28 | — | — |
| mixed/csv-parse | 11000 | 43.18 | 657.36 | 28.73 | — |
| mixed/text-search | 40000 | 9.75 | 43.01 | 6.62 | 27.09 |
| mixed/fibonacci | 10000 | 12.18 | 29.22 | 29.22 | 28.55 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 7.92 | 6.97 | 7.01 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.20x slower | — |
| string/concat-long | 1.17x slower | 1.03x faster | — |
| string/indexOf | 3.28x slower | 1.53x faster | 1.30x faster |
| string/includes | 6.96x slower | 1.30x faster | 3.67x slower |
| string/split | 12.44x slower | 1.10x slower | — |
| string/replace | 2.70x slower | 1.92x faster | — |
| string/case-convert | 4.73x slower | 11.09x faster | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 5.32x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.85x faster | 2.86x faster | — |
| array/sort-i32 | 2.71x faster | 2.69x faster | — |
| array/map-filter | 1.98x faster | 1.98x faster | — |
| array/reduce | 4.29x faster | 4.32x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.11x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 16.01x faster | 15.93x faster | 3.95x slower |
| dom/create-elements | 1.18x faster | — | — |
| dom/set-attributes | 4.55x slower | — | — |
| dom/read-attributes | 2.14x slower | — | — |
| dom/modify-text | 3.44x slower | — | — |
| mixed/csv-parse | 15.22x slower | 1.50x faster | — |
| mixed/text-search | 4.41x slower | 1.47x faster | 2.78x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.34x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.55x slower |
| mixed/sieve | 1.14x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.02x faster |
| string/includes | 9.08x faster |
| string/split | 11.30x faster |
| string/replace | 5.19x faster |
| string/case-convert | 52.50x faster |
| string/substring | 1.22x faster |
| string/trim | 4.85x faster |
| string/startsWith-endsWith | 1.22x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.88x faster |
| mixed/text-search | 6.49x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.0KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1327.5ms | 1077.7ms | — |
| string/concat-long | 645.6ms | 970.9ms | — |
| string/indexOf | 677.0ms | 987.7ms | 886.9ms |
| string/includes | 635.8ms | 954.6ms | 851.8ms |
| string/split | 778.4ms | 961.7ms | — |
| string/replace | 796.7ms | 1060.1ms | — |
| string/case-convert | 751.8ms | 856.8ms | — |
| string/substring | 676.5ms | 756.7ms | — |
| string/trim | 738.7ms | 949.7ms | — |
| string/startsWith-endsWith | 750.0ms | 966.1ms | 903.1ms |
| array/push-pop | 789.1ms | 862.9ms | — |
| array/sort-i32 | 910.8ms | 1005.9ms | — |
| array/map-filter | 971.4ms | 972.3ms | — |
| array/reduce | 836.3ms | 927.7ms | — |
| array/indexOf | 829.5ms | 904.0ms | — |
| array/slice | 773.8ms | 869.9ms | — |
| array/reverse | 794.7ms | 834.8ms | — |
| array/forEach | 886.3ms | 974.0ms | — |
| array/find | 730.1ms | 818.0ms | 816.8ms |
| dom/create-elements | 689.9ms | — | — |
| dom/set-attributes | 781.3ms | — | — |
| dom/read-attributes | 722.5ms | — | — |
| dom/modify-text | 625.1ms | — | — |
| mixed/csv-parse | 824.7ms | 954.2ms | — |
| mixed/text-search | 796.3ms | 989.1ms | 901.0ms |
| mixed/fibonacci | 753.1ms | 790.6ms | 777.6ms |
| mixed/matrix-multiply | 838.0ms | 927.2ms | 783.6ms |
| mixed/sieve | 816.4ms | 891.0ms | — |
