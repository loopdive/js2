# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.046ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.083ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.148ms | 0.022ms | FAILED | js |
| string/split | 0.431ms | 6.06ms | 1.45ms | FAILED | js |
| string/replace | 0.047ms | 0.295ms | 0.105ms | FAILED | js |
| string/case-convert | 0.060ms | 0.256ms | 0.106ms | FAILED | js |
| string/substring | 0.099ms | 1.99ms | 0.908ms | FAILED | js |
| string/trim | 0.169ms | 1.38ms | 0.648ms | FAILED | js |
| string/startsWith-endsWith | 0.392ms | 3.02ms | 0.520ms | FAILED | js |
| array/push-pop | 1.45ms | 2.18ms | 2.19ms | FAILED | js |
| array/sort-i32 | 0.793ms | 0.392ms | 0.390ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.643ms | 0.645ms | FAILED | js |
| array/reduce | 1.36ms | 2.18ms | 2.16ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.025ms | 0.034ms | 0.035ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.238ms | 0.460ms | 0.458ms | 4.85ms | js |
| dom/create-elements | 0.051ms | 0.308ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.415ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.194ms | — | — | js |
| dom/modify-text | 0.053ms | 0.174ms | — | — | js |
| mixed/csv-parse | 0.477ms | 7.39ms | 0.827ms | FAILED | js |
| mixed/text-search | 0.393ms | 6.29ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.157ms | 0.555ms | 0.555ms | 2.12ms | js |
| mixed/sieve | 1.56ms | 1.39ms | 1.38ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.33 | 4.55 | 3.77 | — |
| string/concat-long | 1000 | 3.56 | 7.47 | 8.16 | — |
| string/indexOf | 1000 | 19.12 | 82.52 | 23.58 | — |
| string/includes | 1000 | 19.15 | 147.74 | 22.48 | — |
| string/split | 10000 | 43.10 | 605.88 | 145.05 | — |
| string/replace | 1000 | 46.52 | 294.59 | 105.49 | — |
| string/case-convert | 2000 | 30.19 | 127.95 | 52.84 | — |
| string/substring | 10000 | 9.87 | 199.10 | 90.75 | — |
| string/trim | 10000 | 16.93 | 138.49 | 64.76 | — |
| string/startsWith-endsWith | 20000 | 19.58 | 151.08 | 26.02 | — |
| mixed/csv-parse | 11000 | 43.36 | 671.37 | 75.16 | — |
| mixed/text-search | 40000 | 9.81 | 157.15 | 26.56 | — |
| mixed/fibonacci | 10000 | 12.17 | 26.11 | 26.13 | 25.90 |
| mixed/matrix-multiply | 125000 | 1.26 | 4.44 | 4.44 | 16.99 |
| mixed/sieve | 200000 | 7.78 | 6.93 | 6.92 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.37x slower | 1.13x slower | — |
| string/concat-long | 2.10x slower | 2.29x slower | — |
| string/indexOf | 4.32x slower | 1.23x slower | — |
| string/includes | 7.72x slower | 1.17x slower | — |
| string/split | 14.06x slower | 3.37x slower | — |
| string/replace | 6.33x slower | 2.27x slower | — |
| string/case-convert | 4.24x slower | 1.75x slower | — |
| string/substring | 20.17x slower | 9.19x slower | — |
| string/trim | 8.18x slower | 3.83x slower | — |
| string/startsWith-endsWith | 7.72x slower | 1.33x slower | — |
| array/push-pop | 1.50x slower | 1.51x slower | — |
| array/sort-i32 | 2.02x faster | 2.03x faster | — |
| array/map-filter | 5.05x slower | 5.07x slower | — |
| array/reduce | 1.60x slower | 1.59x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.38x slower | 1.40x slower | — |
| array/reverse | 2.29x faster | 2.29x faster | — |
| array/forEach | 2.39x slower | 2.39x slower | — |
| array/find | 1.93x slower | 1.92x slower | 20.35x slower |
| dom/create-elements | 6.07x slower | — | — |
| dom/set-attributes | 3.96x slower | — | — |
| dom/read-attributes | 3.49x slower | — | — |
| dom/modify-text | 3.25x slower | — | — |
| mixed/csv-parse | 15.48x slower | 1.73x slower | — |
| mixed/text-search | 16.01x slower | 2.71x slower | — |
| mixed/fibonacci | 2.15x slower | 2.15x slower | 2.13x slower |
| mixed/matrix-multiply | 3.54x slower | 3.54x slower | 13.54x slower |
| mixed/sieve | 1.12x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.50x faster |
| string/includes | 6.57x faster |
| string/split | 4.18x faster |
| string/replace | 2.79x faster |
| string/case-convert | 2.42x faster |
| string/substring | 2.19x faster |
| string/trim | 2.14x faster |
| string/startsWith-endsWith | 5.81x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.93x faster |
| mixed/text-search | 5.92x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1238.6ms | 1146.3ms | — |
| string/concat-long | 628.4ms | 992.3ms | — |
| string/indexOf | 778.0ms | 1034.6ms | — |
| string/includes | 779.7ms | 1036.2ms | — |
| string/split | 811.6ms | 1139.9ms | — |
| string/replace | 821.0ms | 1068.9ms | — |
| string/case-convert | 808.7ms | 1084.3ms | — |
| string/substring | 710.8ms | 988.3ms | — |
| string/trim | 805.9ms | 1023.2ms | — |
| string/startsWith-endsWith | 808.1ms | 1036.2ms | — |
| array/push-pop | 757.4ms | 812.0ms | — |
| array/sort-i32 | 914.3ms | 951.5ms | — |
| array/map-filter | 920.3ms | 1028.7ms | — |
| array/reduce | 872.0ms | 885.4ms | — |
| array/indexOf | 757.7ms | 813.8ms | — |
| array/slice | 747.7ms | 833.6ms | — |
| array/reverse | 746.8ms | 827.9ms | — |
| array/forEach | 847.9ms | 946.4ms | — |
| array/find | 859.0ms | 962.0ms | 833.2ms |
| dom/create-elements | 647.1ms | — | — |
| dom/set-attributes | 704.6ms | — | — |
| dom/read-attributes | 675.0ms | — | — |
| dom/modify-text | 694.5ms | — | — |
| mixed/csv-parse | 879.8ms | 1023.9ms | — |
| mixed/text-search | 825.1ms | 988.5ms | — |
| mixed/fibonacci | 757.3ms | 858.6ms | 764.7ms |
| mixed/matrix-multiply | 865.6ms | 936.2ms | 770.5ms |
| mixed/sieve | 795.1ms | 857.3ms | — |
