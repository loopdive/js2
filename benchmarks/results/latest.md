# js2wasm Benchmark Results

Date: 2026-08-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.046ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.114ms | 0.015ms | 0.070ms | gc-native |
| string/split | 0.414ms | 4.93ms | 0.448ms | FAILED | js |
| string/replace | 0.113ms | 0.302ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.228ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.949ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.357ms | 0.295ms | 0.559ms | gc-native |
| array/push-pop | 1.41ms | 0.509ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.302ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.132ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.14ms | 0.499ms | 0.513ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.153ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.556ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.494ms | 7.12ms | 0.320ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.63ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.293ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.157ms | 0.225ms | 0.210ms | 0.721ms | js |
| mixed/sieve | 1.56ms | 1.40ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.41 | 4.62 | 4.10 | — |
| string/concat-long | 1000 | 3.62 | 4.48 | 3.49 | — |
| string/indexOf | 1000 | 19.16 | 63.30 | 12.33 | 14.62 |
| string/includes | 1000 | 19.22 | 114.31 | 14.62 | 70.31 |
| string/split | 10000 | 41.40 | 493.40 | 44.80 | — |
| string/replace | 1000 | 113.02 | 302.15 | 56.20 | — |
| string/case-convert | 2000 | 27.95 | 114.11 | 2.52 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.99 | 94.95 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 17.84 | 14.76 | 27.95 |
| array/map-filter | 30000 | 4.39 | 2.35 | 2.38 | — |
| array/indexOf | 1000 | 3950.61 | 2633.02 | 2633.21 | — |
| dom/create-elements | 2000 | 17.73 | 76.41 | — | — |
| dom/set-attributes | 6000 | 17.20 | 92.60 | — | — |
| dom/read-attributes | 3000 | 18.23 | 41.01 | — | — |
| dom/modify-text | 2000 | 14.43 | 54.29 | — | — |
| mixed/csv-parse | 11000 | 44.91 | 646.98 | 29.13 | — |
| mixed/text-search | 40000 | 9.71 | 40.80 | 6.65 | 27.04 |
| mixed/fibonacci | 10000 | 12.17 | 29.30 | 29.23 | 28.62 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.80 | 1.68 | 5.77 |
| mixed/sieve | 200000 | 7.79 | 7.02 | 6.97 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.36x slower | 1.20x slower | — |
| string/concat-long | 1.24x slower | 1.04x faster | — |
| string/indexOf | 3.30x slower | 1.55x faster | 1.31x faster |
| string/includes | 5.95x slower | 1.31x faster | 3.66x slower |
| string/split | 11.92x slower | 1.08x slower | — |
| string/replace | 2.67x slower | 2.01x faster | — |
| string/case-convert | 4.08x slower | 11.10x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.59x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.13x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.78x faster | 2.82x faster | — |
| array/sort-i32 | 2.62x faster | 2.69x faster | — |
| array/map-filter | 1.87x faster | 1.85x faster | — |
| array/reduce | 4.29x faster | 4.18x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.06x faster | 3.08x faster | — |
| array/find | 15.88x faster | 15.68x faster | 4.25x slower |
| dom/create-elements | 4.31x slower | — | — |
| dom/set-attributes | 5.38x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 14.41x slower | 1.54x faster | — |
| mixed/text-search | 4.20x slower | 1.46x faster | 2.79x slower |
| mixed/fibonacci | 2.41x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.43x slower | 1.34x slower | 4.59x slower |
| mixed/sieve | 1.11x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.13x faster |
| string/includes | 7.82x faster |
| string/split | 11.01x faster |
| string/replace | 5.38x faster |
| string/case-convert | 45.31x faster |
| string/substring | 1.22x faster |
| string/trim | 5.09x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.03x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.21x faster |
| mixed/text-search | 6.14x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x faster |
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
| string/concat-short | 1328.8ms | 1096.4ms | — |
| string/concat-long | 627.4ms | 973.4ms | — |
| string/indexOf | 694.0ms | 1001.0ms | 865.1ms |
| string/includes | 672.4ms | 960.6ms | 867.7ms |
| string/split | 794.6ms | 956.4ms | — |
| string/replace | 800.6ms | 1026.0ms | — |
| string/case-convert | 782.5ms | 892.6ms | — |
| string/substring | 657.7ms | 759.1ms | — |
| string/trim | 784.8ms | 992.3ms | — |
| string/startsWith-endsWith | 753.7ms | 990.8ms | 897.0ms |
| array/push-pop | 775.1ms | 830.4ms | — |
| array/sort-i32 | 878.5ms | 997.3ms | — |
| array/map-filter | 936.6ms | 1008.3ms | — |
| array/reduce | 851.6ms | 966.7ms | — |
| array/indexOf | 866.1ms | 924.9ms | — |
| array/slice | 786.4ms | 883.0ms | — |
| array/reverse | 763.7ms | 839.4ms | — |
| array/forEach | 886.4ms | 971.0ms | — |
| array/find | 732.6ms | 820.4ms | 847.3ms |
| dom/create-elements | 628.3ms | — | — |
| dom/set-attributes | 719.2ms | — | — |
| dom/read-attributes | 674.1ms | — | — |
| dom/modify-text | 592.1ms | — | — |
| mixed/csv-parse | 791.8ms | 950.6ms | — |
| mixed/text-search | 799.3ms | 1028.7ms | 927.7ms |
| mixed/fibonacci | 767.1ms | 839.6ms | 807.2ms |
| mixed/matrix-multiply | 873.0ms | 953.2ms | 828.4ms |
| mixed/sieve | 891.3ms | 947.2ms | — |
