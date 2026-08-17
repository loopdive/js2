# js2wasm Benchmark Results

Date: 2026-08-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.049ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.098ms | 0.014ms | 0.052ms | gc-native |
| string/split | 0.415ms | 4.55ms | 0.505ms | FAILED | js |
| string/replace | 0.095ms | 0.220ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.222ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.184ms | 0.925ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.355ms | 0.308ms | 0.567ms | gc-native |
| array/push-pop | 1.64ms | 0.604ms | 0.602ms | FAILED | gc-native |
| array/sort-i32 | 0.842ms | 0.467ms | 0.299ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 1.61ms | 0.601ms | 0.599ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.034ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 8.86ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.153ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.549ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.133ms | — | — | js |
| dom/modify-text | 0.029ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.469ms | 6.82ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.392ms | 1.30ms | 0.291ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.305ms | 0.315ms | 0.302ms | js |
| mixed/matrix-multiply | 0.184ms | 0.210ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.75ms | 1.51ms | 1.50ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.98 | 4.93 | 3.91 | — |
| string/concat-long | 1000 | 4.13 | 5.05 | 3.41 | — |
| string/indexOf | 1000 | 18.99 | 59.60 | 12.26 | 16.24 |
| string/includes | 1000 | 18.71 | 97.63 | 13.83 | 51.65 |
| string/split | 10000 | 41.49 | 454.89 | 50.49 | — |
| string/replace | 1000 | 95.40 | 219.98 | 59.32 | — |
| string/case-convert | 2000 | 29.24 | 110.88 | 2.62 | — |
| string/substring | 10000 | 10.40 | 3.99 | 3.43 | — |
| string/trim | 10000 | 18.36 | 92.51 | 19.68 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 17.74 | 15.40 | 28.34 |
| array/map-filter | 30000 | 4.44 | 2.18 | 2.18 | — |
| array/indexOf | 1000 | 4457.10 | 2861.23 | 2861.35 | — |
| dom/create-elements | 2000 | 18.78 | 76.52 | — | — |
| dom/set-attributes | 6000 | 18.06 | 91.58 | — | — |
| dom/read-attributes | 3000 | 19.71 | 44.19 | — | — |
| dom/modify-text | 2000 | 14.38 | 56.04 | — | — |
| mixed/csv-parse | 11000 | 42.63 | 620.16 | 27.84 | — |
| mixed/text-search | 40000 | 9.80 | 32.53 | 7.29 | 27.61 |
| mixed/fibonacci | 10000 | 12.53 | 30.53 | 31.51 | 30.25 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.68 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 8.75 | 7.54 | 7.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.65x slower | 1.31x slower | — |
| string/concat-long | 1.22x slower | 1.21x faster | — |
| string/indexOf | 3.14x slower | 1.55x faster | 1.17x faster |
| string/includes | 5.22x slower | 1.35x faster | 2.76x slower |
| string/split | 10.96x slower | 1.22x slower | — |
| string/replace | 2.31x slower | 1.61x faster | — |
| string/case-convert | 3.79x slower | 11.18x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.04x slower | 1.07x slower | — |
| string/startsWith-endsWith | 1.16x faster | 1.34x faster | 1.37x slower |
| array/push-pop | 2.72x faster | 2.72x faster | — |
| array/sort-i32 | 1.80x faster | 2.82x faster | — |
| array/map-filter | 2.04x faster | 2.04x faster | — |
| array/reduce | 2.67x faster | 2.68x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.13x faster | 2.05x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.81x faster | 1.81x faster | — |
| array/find | 18.41x faster | 18.53x faster | 4.45x slower |
| dom/create-elements | 4.08x slower | — | — |
| dom/set-attributes | 5.07x slower | — | — |
| dom/read-attributes | 2.24x slower | — | — |
| dom/modify-text | 3.90x slower | — | — |
| mixed/csv-parse | 14.55x slower | 1.53x faster | — |
| mixed/text-search | 3.32x slower | 1.34x faster | 2.82x slower |
| mixed/fibonacci | 2.44x slower | 2.52x slower | 2.41x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.88x slower |
| mixed/sieve | 1.16x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.26x faster |
| string/concat-long | 1.48x faster |
| string/indexOf | 4.86x faster |
| string/includes | 7.06x faster |
| string/split | 9.01x faster |
| string/replace | 3.71x faster |
| string/case-convert | 42.39x faster |
| string/substring | 1.16x faster |
| string/trim | 4.70x faster |
| string/startsWith-endsWith | 1.15x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.56x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.27x faster |
| mixed/text-search | 4.46x faster |
| mixed/fibonacci | 1.03x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
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
| string/concat-short | 1229.8ms | 1058.0ms | — |
| string/concat-long | 608.7ms | 919.0ms | — |
| string/indexOf | 629.9ms | 917.1ms | 836.8ms |
| string/includes | 653.1ms | 948.3ms | 806.0ms |
| string/split | 780.4ms | 930.1ms | — |
| string/replace | 749.4ms | 995.1ms | — |
| string/case-convert | 748.6ms | 828.4ms | — |
| string/substring | 628.3ms | 732.8ms | — |
| string/trim | 721.8ms | 930.5ms | — |
| string/startsWith-endsWith | 747.8ms | 926.2ms | 871.6ms |
| array/push-pop | 757.6ms | 830.7ms | — |
| array/sort-i32 | 871.2ms | 971.0ms | — |
| array/map-filter | 878.9ms | 972.7ms | — |
| array/reduce | 821.5ms | 878.4ms | — |
| array/indexOf | 806.7ms | 885.9ms | — |
| array/slice | 732.9ms | 809.4ms | — |
| array/reverse | 746.4ms | 807.6ms | — |
| array/forEach | 863.0ms | 943.7ms | — |
| array/find | 714.9ms | 803.1ms | 815.7ms |
| dom/create-elements | 593.4ms | — | — |
| dom/set-attributes | 688.1ms | — | — |
| dom/read-attributes | 651.4ms | — | — |
| dom/modify-text | 565.7ms | — | — |
| mixed/csv-parse | 769.8ms | 905.9ms | — |
| mixed/text-search | 766.6ms | 938.2ms | 906.6ms |
| mixed/fibonacci | 754.8ms | 780.8ms | 788.8ms |
| mixed/matrix-multiply | 852.3ms | 885.8ms | 795.6ms |
| mixed/sieve | 813.6ms | 893.1ms | — |
