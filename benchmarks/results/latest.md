# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.044ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.021ms | gc-native |
| string/includes | 0.019ms | 0.103ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.424ms | 5.18ms | 0.449ms | FAILED | js |
| string/replace | 0.105ms | 0.313ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.231ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.925ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.364ms | 0.296ms | 0.562ms | gc-native |
| array/push-pop | 1.39ms | 0.508ms | 0.512ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.293ms | 0.297ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.507ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.027ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.038ms | 0.147ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.498ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.122ms | — | — | js |
| dom/modify-text | 0.030ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.487ms | 7.76ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.54ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.293ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.719ms | js |
| mixed/sieve | 1.56ms | 1.43ms | 1.41ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.42 | 4.39 | 3.98 | — |
| string/concat-long | 1000 | 3.60 | 4.45 | 3.71 | — |
| string/indexOf | 1000 | 19.13 | 63.16 | 12.28 | 20.65 |
| string/includes | 1000 | 19.18 | 102.58 | 14.55 | 15.96 |
| string/split | 10000 | 42.38 | 517.72 | 44.87 | — |
| string/replace | 1000 | 104.70 | 313.16 | 56.63 | — |
| string/case-convert | 2000 | 28.07 | 115.68 | 2.51 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.01 | 92.54 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 18.21 | 14.78 | 28.10 |
| array/map-filter | 30000 | 4.32 | 2.35 | 2.34 | — |
| array/indexOf | 1000 | 3960.51 | 2635.23 | 2636.17 | — |
| dom/create-elements | 2000 | 18.75 | 73.69 | — | — |
| dom/set-attributes | 6000 | 17.46 | 82.96 | — | — |
| dom/read-attributes | 3000 | 18.58 | 40.62 | — | — |
| dom/modify-text | 2000 | 15.09 | 54.75 | — | — |
| mixed/csv-parse | 11000 | 44.30 | 705.90 | 28.64 | — |
| mixed/text-search | 40000 | 9.71 | 38.40 | 6.64 | 27.09 |
| mixed/fibonacci | 10000 | 12.18 | 29.27 | 29.18 | 28.67 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 7.78 | 7.16 | 7.03 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.28x slower | 1.16x slower | — |
| string/concat-long | 1.24x slower | 1.03x slower | — |
| string/indexOf | 3.30x slower | 1.56x faster | 1.08x slower |
| string/includes | 5.35x slower | 1.32x faster | 1.20x faster |
| string/split | 12.22x slower | 1.06x slower | — |
| string/replace | 2.99x slower | 1.85x faster | — |
| string/case-convert | 4.12x slower | 11.17x faster | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 5.44x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.10x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.74x faster | 2.72x faster | — |
| array/sort-i32 | 2.69x faster | 2.66x faster | — |
| array/map-filter | 1.83x faster | 1.84x faster | — |
| array/reduce | 4.28x faster | 4.26x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.80x faster | 1.81x faster | — |
| array/find | 15.99x faster | 15.95x faster | 4.25x slower |
| dom/create-elements | 3.93x slower | — | — |
| dom/set-attributes | 4.75x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 15.94x slower | 1.55x faster | — |
| mixed/text-search | 3.95x slower | 1.46x faster | 2.79x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.55x slower |
| mixed/sieve | 1.09x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.15x faster |
| string/includes | 7.05x faster |
| string/split | 11.54x faster |
| string/replace | 5.53x faster |
| string/case-convert | 46.04x faster |
| string/substring | 1.22x faster |
| string/trim | 4.97x faster |
| string/startsWith-endsWith | 1.23x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 24.65x faster |
| mixed/text-search | 5.78x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x faster |

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
| array/forEach | 2.5KB | 3.1KB | — |
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
| string/concat-short | 1321.8ms | 1104.1ms | — |
| string/concat-long | 667.2ms | 956.8ms | — |
| string/indexOf | 677.6ms | 1047.9ms | 897.1ms |
| string/includes | 660.7ms | 995.4ms | 900.3ms |
| string/split | 795.1ms | 993.9ms | — |
| string/replace | 794.8ms | 1054.7ms | — |
| string/case-convert | 802.1ms | 862.3ms | — |
| string/substring | 664.5ms | 756.7ms | — |
| string/trim | 751.5ms | 990.6ms | — |
| string/startsWith-endsWith | 774.1ms | 967.0ms | 939.0ms |
| array/push-pop | 814.9ms | 856.0ms | — |
| array/sort-i32 | 919.3ms | 974.2ms | — |
| array/map-filter | 929.0ms | 1048.3ms | — |
| array/reduce | 848.7ms | 959.0ms | — |
| array/indexOf | 842.8ms | 930.2ms | — |
| array/slice | 774.4ms | 855.9ms | — |
| array/reverse | 786.1ms | 845.4ms | — |
| array/forEach | 908.0ms | 992.3ms | — |
| array/find | 745.9ms | 875.6ms | 842.8ms |
| dom/create-elements | 629.5ms | — | — |
| dom/set-attributes | 727.3ms | — | — |
| dom/read-attributes | 706.3ms | — | — |
| dom/modify-text | 623.2ms | — | — |
| mixed/csv-parse | 801.5ms | 959.9ms | — |
| mixed/text-search | 770.3ms | 1043.7ms | 913.4ms |
| mixed/fibonacci | 761.8ms | 846.0ms | 808.1ms |
| mixed/matrix-multiply | 860.9ms | 905.9ms | 819.1ms |
| mixed/sieve | 883.2ms | 937.2ms | — |
