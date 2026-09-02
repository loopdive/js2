# js2wasm Benchmark Results

Date: 2026-09-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.051ms | 0.051ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.114ms | 0.014ms | 0.026ms | gc-native |
| string/split | 0.421ms | 7.70ms | 2.63ms | FAILED | js |
| string/replace | 0.095ms | 0.629ms | 0.270ms | FAILED | js |
| string/case-convert | 0.058ms | 0.526ms | 0.234ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.25ms | 2.36ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.58ms | 2.46ms | 0.559ms | js |
| array/push-pop | 1.69ms | 0.618ms | 0.612ms | FAILED | gc-native |
| array/sort-i32 | 0.843ms | 0.553ms | 0.304ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.60ms | 0.608ms | 0.606ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.036ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.159ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.548ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.137ms | — | — | js |
| dom/modify-text | 0.029ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.471ms | 8.11ms | 0.534ms | FAILED | js |
| mixed/text-search | 0.403ms | 3.86ms | 2.40ms | 1.12ms | js |
| mixed/fibonacci | 0.126ms | 0.327ms | 0.327ms | 1.41ms | js |
| mixed/matrix-multiply | 0.185ms | 67.71ms | 65.69ms | 0.724ms | js |
| mixed/sieve | 1.80ms | 2.30ms | 2.30ms | FAILED | js |

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
| string/concat-short | 10000 | 3.42 | 5.09 | 5.14 | — |
| string/concat-long | 1000 | 4.18 | 5.10 | 3.60 | — |
| string/indexOf | 1000 | 19.01 | 60.18 | 12.25 | 17.15 |
| string/includes | 1000 | 18.74 | 113.58 | 13.79 | 25.59 |
| string/split | 10000 | 42.14 | 770.15 | 263.04 | — |
| string/replace | 1000 | 94.74 | 628.56 | 269.61 | — |
| string/case-convert | 2000 | 29.04 | 263.15 | 116.97 | — |
| string/substring | 10000 | 10.44 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.31 | 325.47 | 235.66 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 129.19 | 123.13 | 27.95 |
| array/map-filter | 30000 | 4.47 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4461.73 | 2862.52 | 2864.29 | — |
| dom/create-elements | 2000 | 18.99 | 79.64 | — | — |
| dom/set-attributes | 6000 | 18.28 | 91.31 | — | — |
| dom/read-attributes | 3000 | 19.86 | 45.73 | — | — |
| dom/modify-text | 2000 | 14.52 | 57.05 | — | — |
| mixed/csv-parse | 11000 | 42.84 | 736.84 | 48.56 | — |
| mixed/text-search | 40000 | 10.07 | 96.57 | 59.93 | 27.97 |
| mixed/fibonacci | 10000 | 12.60 | 32.74 | 32.75 | 140.78 |
| mixed/matrix-multiply | 125000 | 1.48 | 541.72 | 525.53 | 5.79 |
| mixed/sieve | 200000 | 9.02 | 11.48 | 11.51 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.50x slower | — |
| string/concat-long | 1.22x slower | 1.16x faster | — |
| string/indexOf | 3.17x slower | 1.55x faster | 1.11x faster |
| string/includes | 6.06x slower | 1.36x faster | 1.37x slower |
| string/split | 18.27x slower | 6.24x slower | — |
| string/replace | 6.63x slower | 2.85x slower | — |
| string/case-convert | 9.06x slower | 4.03x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 18.80x slower | 13.61x slower | — |
| string/startsWith-endsWith | 6.26x slower | 5.97x slower | 1.35x slower |
| array/push-pop | 2.73x faster | 2.75x faster | — |
| array/sort-i32 | 1.53x faster | 2.78x faster | — |
| array/map-filter | 2.04x faster | 2.04x faster | — |
| array/reduce | 2.64x faster | 2.65x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.22x faster | 2.17x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.83x faster | 1.84x faster | — |
| array/find | 18.12x faster | 18.46x faster | 4.44x slower |
| dom/create-elements | 4.19x slower | — | — |
| dom/set-attributes | 4.99x slower | — | — |
| dom/read-attributes | 2.30x slower | — | — |
| dom/modify-text | 3.93x slower | — | — |
| mixed/csv-parse | 17.20x slower | 1.13x slower | — |
| mixed/text-search | 9.59x slower | 5.95x slower | 2.78x slower |
| mixed/fibonacci | 2.60x slower | 2.60x slower | 11.17x slower |
| mixed/matrix-multiply | 366.43x slower | 355.48x slower | 3.92x slower |
| mixed/sieve | 1.27x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x slower |
| string/concat-long | 1.42x faster |
| string/indexOf | 4.91x faster |
| string/includes | 8.24x faster |
| string/split | 2.93x faster |
| string/replace | 2.33x faster |
| string/case-convert | 2.25x faster |
| string/substring | 1.16x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.05x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.82x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 15.18x faster |
| mixed/text-search | 1.61x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x faster |
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
| string/concat-short | 1615.6ms | 1088.7ms | — |
| string/concat-long | 792.8ms | 969.4ms | — |
| string/indexOf | 669.6ms | 978.2ms | 840.1ms |
| string/includes | 663.8ms | 962.1ms | 827.6ms |
| string/split | 797.2ms | 993.4ms | — |
| string/replace | 775.2ms | 1025.9ms | — |
| string/case-convert | 766.6ms | 888.1ms | — |
| string/substring | 655.1ms | 782.8ms | — |
| string/trim | 749.0ms | 958.8ms | — |
| string/startsWith-endsWith | 775.1ms | 973.4ms | 908.4ms |
| array/push-pop | 774.5ms | 839.4ms | — |
| array/sort-i32 | 927.2ms | 1001.7ms | — |
| array/map-filter | 929.3ms | 1056.4ms | — |
| array/reduce | 865.7ms | 996.3ms | — |
| array/indexOf | 851.9ms | 995.9ms | — |
| array/slice | 767.9ms | 885.3ms | — |
| array/reverse | 779.4ms | 841.7ms | — |
| array/forEach | 871.3ms | 1009.3ms | — |
| array/find | 773.9ms | 857.5ms | 822.9ms |
| dom/create-elements | 710.5ms | — | — |
| dom/set-attributes | 734.7ms | — | — |
| dom/read-attributes | 690.7ms | — | — |
| dom/modify-text | 675.0ms | — | — |
| mixed/csv-parse | 797.2ms | 985.0ms | — |
| mixed/text-search | 787.4ms | 1012.6ms | 905.3ms |
| mixed/fibonacci | 788.4ms | 803.8ms | 729.8ms |
| mixed/matrix-multiply | 911.4ms | 1006.2ms | 802.7ms |
| mixed/sieve | 877.5ms | 928.7ms | — |
