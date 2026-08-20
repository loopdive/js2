# js2wasm Benchmark Results

Date: 2026-08-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.047ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.110ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.426ms | 5.00ms | 0.452ms | FAILED | js |
| string/replace | 0.105ms | 0.304ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.248ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.952ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.295ms | 0.560ms | gc-native |
| array/push-pop | 1.40ms | 0.502ms | 0.512ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 1.33ms | 0.505ms | 0.508ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | 0.166ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.481ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.490ms | 7.26ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.437ms | 1.50ms | 0.267ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.293ms | 0.287ms | js |
| mixed/matrix-multiply | 0.157ms | 0.210ms | 0.210ms | 0.722ms | js |
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
| string/concat-short | 10000 | 2.78 | 4.69 | 3.82 | — |
| string/concat-long | 1000 | 3.62 | 4.46 | 3.68 | — |
| string/indexOf | 1000 | 19.23 | 62.83 | 12.26 | 15.63 |
| string/includes | 1000 | 19.20 | 109.77 | 14.74 | 71.15 |
| string/split | 10000 | 42.61 | 499.97 | 45.24 | — |
| string/replace | 1000 | 104.74 | 304.28 | 56.78 | — |
| string/case-convert | 2000 | 27.93 | 124.17 | 2.51 | — |
| string/substring | 10000 | 9.85 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.98 | 95.21 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 17.88 | 14.77 | 28.02 |
| array/map-filter | 30000 | 4.28 | 2.34 | 2.35 | — |
| array/indexOf | 1000 | 3949.51 | 2635.73 | 2632.89 | — |
| dom/create-elements | 2000 | 17.65 | 83.10 | — | — |
| dom/set-attributes | 6000 | 17.20 | 80.15 | — | — |
| dom/read-attributes | 3000 | 18.07 | 41.08 | — | — |
| dom/modify-text | 2000 | 14.72 | 53.43 | — | — |
| mixed/csv-parse | 11000 | 44.56 | 659.94 | 28.63 | — |
| mixed/text-search | 40000 | 10.92 | 37.62 | 6.69 | 27.00 |
| mixed/fibonacci | 10000 | 12.18 | 29.24 | 29.25 | 28.73 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.78 |
| mixed/sieve | 200000 | 7.92 | 6.93 | 7.02 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.69x slower | 1.37x slower | — |
| string/concat-long | 1.23x slower | 1.02x slower | — |
| string/indexOf | 3.27x slower | 1.57x faster | 1.23x faster |
| string/includes | 5.72x slower | 1.30x faster | 3.71x slower |
| string/split | 11.73x slower | 1.06x slower | — |
| string/replace | 2.91x slower | 1.84x faster | — |
| string/case-convert | 4.45x slower | 11.14x faster | — |
| string/substring | 2.62x faster | 3.21x faster | — |
| string/trim | 5.61x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.79x faster | 2.74x faster | — |
| array/sort-i32 | 2.69x faster | 2.69x faster | — |
| array/map-filter | 1.83x faster | 1.82x faster | — |
| array/reduce | 2.63x faster | 2.62x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.73x faster | — |
| array/find | 16.00x faster | 16.12x faster | 4.23x slower |
| dom/create-elements | 4.71x slower | — | — |
| dom/set-attributes | 4.66x slower | — | — |
| dom/read-attributes | 2.27x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 14.81x slower | 1.56x faster | — |
| mixed/text-search | 3.45x slower | 1.63x faster | 2.47x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.36x slower |
| mixed/matrix-multiply | 1.34x slower | 1.33x slower | 4.58x slower |
| mixed/sieve | 1.14x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.12x faster |
| string/includes | 7.45x faster |
| string/split | 11.05x faster |
| string/replace | 5.36x faster |
| string/case-convert | 49.52x faster |
| string/substring | 1.22x faster |
| string/trim | 5.11x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 23.05x faster |
| mixed/text-search | 5.63x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1323.6ms | 1090.4ms | — |
| string/concat-long | 648.9ms | 953.4ms | — |
| string/indexOf | 686.0ms | 971.8ms | 812.5ms |
| string/includes | 651.7ms | 973.1ms | 898.7ms |
| string/split | 787.1ms | 979.2ms | — |
| string/replace | 794.4ms | 1093.2ms | — |
| string/case-convert | 787.9ms | 858.5ms | — |
| string/substring | 648.3ms | 768.3ms | — |
| string/trim | 759.2ms | 970.4ms | — |
| string/startsWith-endsWith | 786.6ms | 950.1ms | 871.7ms |
| array/push-pop | 763.7ms | 848.9ms | — |
| array/sort-i32 | 930.4ms | 980.6ms | — |
| array/map-filter | 921.8ms | 1064.2ms | — |
| array/reduce | 852.5ms | 944.8ms | — |
| array/indexOf | 825.0ms | 955.9ms | — |
| array/slice | 760.1ms | 887.7ms | — |
| array/reverse | 757.2ms | 822.4ms | — |
| array/forEach | 884.5ms | 990.3ms | — |
| array/find | 744.3ms | 858.8ms | 834.5ms |
| dom/create-elements | 638.3ms | — | — |
| dom/set-attributes | 733.6ms | — | — |
| dom/read-attributes | 690.0ms | — | — |
| dom/modify-text | 617.1ms | — | — |
| mixed/csv-parse | 805.9ms | 947.7ms | — |
| mixed/text-search | 795.1ms | 1002.4ms | 956.8ms |
| mixed/fibonacci | 744.7ms | 825.6ms | 802.6ms |
| mixed/matrix-multiply | 885.0ms | 894.9ms | 809.1ms |
| mixed/sieve | 856.6ms | 944.5ms | — |
