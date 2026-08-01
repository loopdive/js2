# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.067ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.078ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.122ms | 0.023ms | FAILED | js |
| string/split | 0.421ms | 5.70ms | 1.54ms | FAILED | js |
| string/replace | 0.047ms | 0.212ms | 0.078ms | FAILED | js |
| string/case-convert | 0.062ms | 0.233ms | 0.113ms | FAILED | js |
| string/substring | 0.104ms | 1.97ms | 0.928ms | FAILED | js |
| string/trim | 0.175ms | 1.40ms | 0.737ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.67ms | 0.526ms | FAILED | js |
| array/push-pop | 1.67ms | 2.52ms | 2.53ms | FAILED | js |
| array/sort-i32 | 0.841ms | 0.413ms | 0.408ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.689ms | 0.689ms | FAILED | js |
| array/reduce | 1.62ms | 2.56ms | 2.55ms | FAILED | js |
| array/indexOf | 4.46ms | 3.85ms | 3.85ms | FAILED | host-call |
| array/slice | 0.035ms | 0.024ms | 0.025ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.68ms | 3.69ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.123ms | 0.122ms | FAILED | js |
| array/find | 0.282ms | 0.511ms | 0.509ms | 4.89ms | js |
| dom/create-elements | 0.236ms | 0.260ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.385ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.183ms | — | — | js |
| dom/modify-text | 0.057ms | 0.164ms | — | — | js |
| mixed/csv-parse | 0.948ms | 6.66ms | 0.801ms | FAILED | gc-native |
| mixed/text-search | 0.408ms | 5.46ms | 1.16ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.305ms | 0.304ms | 1.23ms | js |
| mixed/matrix-multiply | 0.185ms | 0.566ms | 0.566ms | 2.04ms | js |
| mixed/sieve | 1.78ms | 1.50ms | 1.48ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.32 | 6.71 | 4.27 | — |
| string/concat-long | 1000 | 4.32 | 8.41 | 9.17 | — |
| string/indexOf | 1000 | 19.02 | 78.27 | 23.60 | — |
| string/includes | 1000 | 18.69 | 121.56 | 22.70 | — |
| string/split | 10000 | 42.15 | 570.46 | 153.86 | — |
| string/replace | 1000 | 46.59 | 211.90 | 77.99 | — |
| string/case-convert | 2000 | 31.24 | 116.32 | 56.68 | — |
| string/substring | 10000 | 10.42 | 197.44 | 92.78 | — |
| string/trim | 10000 | 17.47 | 139.51 | 73.70 | — |
| string/startsWith-endsWith | 20000 | 21.42 | 133.61 | 26.28 | — |
| mixed/csv-parse | 11000 | 86.16 | 605.50 | 72.84 | — |
| mixed/text-search | 40000 | 10.20 | 136.43 | 29.10 | — |
| mixed/fibonacci | 10000 | 12.52 | 30.48 | 30.36 | 123.21 |
| mixed/matrix-multiply | 125000 | 1.48 | 4.53 | 4.52 | 16.32 |
| mixed/sieve | 200000 | 8.89 | 7.48 | 7.38 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.02x slower | 1.29x slower | — |
| string/concat-long | 1.95x slower | 2.12x slower | — |
| string/indexOf | 4.11x slower | 1.24x slower | — |
| string/includes | 6.50x slower | 1.21x slower | — |
| string/split | 13.54x slower | 3.65x slower | — |
| string/replace | 4.55x slower | 1.67x slower | — |
| string/case-convert | 3.72x slower | 1.81x slower | — |
| string/substring | 18.94x slower | 8.90x slower | — |
| string/trim | 7.99x slower | 4.22x slower | — |
| string/startsWith-endsWith | 6.24x slower | 1.23x slower | — |
| array/push-pop | 1.51x slower | 1.52x slower | — |
| array/sort-i32 | 2.04x faster | 2.06x faster | — |
| array/map-filter | 5.16x slower | 5.16x slower | — |
| array/reduce | 1.58x slower | 1.58x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.47x faster | 1.40x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.35x slower | 2.34x slower | — |
| array/find | 1.82x slower | 1.81x slower | 17.38x slower |
| dom/create-elements | 1.10x slower | — | — |
| dom/set-attributes | 3.49x slower | — | — |
| dom/read-attributes | 2.89x slower | — | — |
| dom/modify-text | 2.88x slower | — | — |
| mixed/csv-parse | 7.03x slower | 1.18x faster | — |
| mixed/text-search | 13.37x slower | 2.85x slower | — |
| mixed/fibonacci | 2.43x slower | 2.42x slower | 9.84x slower |
| mixed/matrix-multiply | 3.06x slower | 3.06x slower | 11.03x slower |
| mixed/sieve | 1.19x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.57x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.32x faster |
| string/includes | 5.36x faster |
| string/split | 3.71x faster |
| string/replace | 2.72x faster |
| string/case-convert | 2.05x faster |
| string/substring | 2.13x faster |
| string/trim | 1.89x faster |
| string/startsWith-endsWith | 5.08x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.31x faster |
| mixed/text-search | 4.69x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1230.3ms | 1145.6ms | — |
| string/concat-long | 632.7ms | 1005.2ms | — |
| string/indexOf | 758.2ms | 1061.9ms | — |
| string/includes | 757.0ms | 1053.3ms | — |
| string/split | 827.0ms | 1057.4ms | — |
| string/replace | 824.6ms | 1058.3ms | — |
| string/case-convert | 802.4ms | 1062.9ms | — |
| string/substring | 704.4ms | 1027.5ms | — |
| string/trim | 801.7ms | 1009.9ms | — |
| string/startsWith-endsWith | 794.0ms | 1015.2ms | — |
| array/push-pop | 742.2ms | 820.3ms | — |
| array/sort-i32 | 968.6ms | 998.4ms | — |
| array/map-filter | 950.5ms | 987.4ms | — |
| array/reduce | 864.6ms | 878.5ms | — |
| array/indexOf | 740.9ms | 816.6ms | — |
| array/slice | 766.3ms | 822.1ms | — |
| array/reverse | 754.1ms | 832.8ms | — |
| array/forEach | 850.2ms | 940.1ms | — |
| array/find | 850.5ms | 935.2ms | 823.3ms |
| dom/create-elements | 646.8ms | — | — |
| dom/set-attributes | 726.4ms | — | — |
| dom/read-attributes | 705.6ms | — | — |
| dom/modify-text | 719.0ms | — | — |
| mixed/csv-parse | 842.3ms | 1020.3ms | — |
| mixed/text-search | 797.4ms | 1024.9ms | — |
| mixed/fibonacci | 790.2ms | 917.2ms | 795.3ms |
| mixed/matrix-multiply | 898.4ms | 932.9ms | 813.1ms |
| mixed/sieve | 840.3ms | 888.0ms | — |
