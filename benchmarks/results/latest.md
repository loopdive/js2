# js2wasm Benchmark Results

Date: 2026-08-19
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.052ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.062ms | 0.012ms | 0.061ms | gc-native |
| string/includes | 0.019ms | 0.042ms | 0.014ms | 0.027ms | gc-native |
| string/split | 0.429ms | 4.56ms | 0.506ms | FAILED | js |
| string/replace | 0.097ms | 0.222ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.233ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.939ms | 0.196ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.349ms | 0.320ms | 0.558ms | gc-native |
| array/push-pop | 1.65ms | 0.598ms | 0.602ms | FAILED | host-call |
| array/sort-i32 | 0.851ms | 0.299ms | 0.300ms | FAILED | host-call |
| array/map-filter | 0.137ms | 0.066ms | 0.067ms | FAILED | host-call |
| array/reduce | 2.38ms | 0.600ms | 0.601ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.037ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.054ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.039ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.552ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.133ms | — | — | js |
| dom/modify-text | 0.030ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.470ms | 6.58ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.30ms | 0.375ms | 1.11ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.305ms | 0.315ms | 0.310ms | js |
| mixed/matrix-multiply | 0.186ms | 0.209ms | 0.209ms | 0.717ms | js |
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
| string/concat-short | 10000 | 3.38 | 5.17 | 3.92 | — |
| string/concat-long | 1000 | 4.13 | 5.13 | 3.69 | — |
| string/indexOf | 1000 | 19.13 | 62.43 | 12.29 | 60.58 |
| string/includes | 1000 | 18.85 | 41.92 | 13.85 | 26.88 |
| string/split | 10000 | 42.94 | 455.63 | 50.62 | — |
| string/replace | 1000 | 96.71 | 222.45 | 59.63 | — |
| string/case-convert | 2000 | 29.01 | 116.65 | 2.61 | — |
| string/substring | 10000 | 10.45 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.30 | 93.87 | 19.65 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 17.44 | 15.99 | 27.89 |
| array/map-filter | 30000 | 4.57 | 2.21 | 2.22 | — |
| array/indexOf | 1000 | 4458.59 | 2859.86 | 2860.07 | — |
| dom/create-elements | 2000 | 19.37 | 76.89 | — | — |
| dom/set-attributes | 6000 | 18.17 | 91.92 | — | — |
| dom/read-attributes | 3000 | 19.81 | 44.50 | — | — |
| dom/modify-text | 2000 | 14.76 | 56.42 | — | — |
| mixed/csv-parse | 11000 | 42.69 | 598.26 | 27.85 | — |
| mixed/text-search | 40000 | 10.07 | 32.49 | 9.37 | 27.87 |
| mixed/fibonacci | 10000 | 12.52 | 30.50 | 31.51 | 30.98 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.68 | 1.67 | 5.73 |
| mixed/sieve | 200000 | 8.76 | 7.54 | 7.48 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.16x slower | — |
| string/concat-long | 1.24x slower | 1.12x faster | — |
| string/indexOf | 3.26x slower | 1.56x faster | 3.17x slower |
| string/includes | 2.22x slower | 1.36x faster | 1.43x slower |
| string/split | 10.61x slower | 1.18x slower | — |
| string/replace | 2.30x slower | 1.62x faster | — |
| string/case-convert | 4.02x slower | 11.10x faster | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 5.43x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.18x faster | 1.29x faster | 1.35x slower |
| array/push-pop | 2.75x faster | 2.73x faster | — |
| array/sort-i32 | 2.85x faster | 2.84x faster | — |
| array/map-filter | 2.07x faster | 2.06x faster | — |
| array/reduce | 3.97x faster | 3.96x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.18x faster | 2.11x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.87x faster | 1.87x faster | — |
| array/find | 18.34x faster | 18.34x faster | 4.44x slower |
| dom/create-elements | 3.97x slower | — | — |
| dom/set-attributes | 5.06x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.82x slower | — | — |
| mixed/csv-parse | 14.01x slower | 1.53x faster | — |
| mixed/text-search | 3.23x slower | 1.07x faster | 2.77x slower |
| mixed/fibonacci | 2.44x slower | 2.52x slower | 2.47x slower |
| mixed/matrix-multiply | 1.12x slower | 1.12x slower | 3.84x slower |
| mixed/sieve | 1.16x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.32x faster |
| string/concat-long | 1.39x faster |
| string/indexOf | 5.08x faster |
| string/includes | 3.03x faster |
| string/split | 9.00x faster |
| string/replace | 3.73x faster |
| string/case-convert | 44.63x faster |
| string/substring | 1.16x faster |
| string/trim | 4.78x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 21.48x faster |
| mixed/text-search | 3.47x faster |
| mixed/fibonacci | 1.03x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1230.0ms | 1033.3ms | — |
| string/concat-long | 620.0ms | 963.0ms | — |
| string/indexOf | 636.4ms | 945.5ms | 830.3ms |
| string/includes | 665.5ms | 966.5ms | 838.0ms |
| string/split | 765.7ms | 963.9ms | — |
| string/replace | 763.8ms | 1011.6ms | — |
| string/case-convert | 800.4ms | 813.0ms | — |
| string/substring | 630.4ms | 728.9ms | — |
| string/trim | 741.5ms | 925.2ms | — |
| string/startsWith-endsWith | 749.2ms | 924.7ms | 881.1ms |
| array/push-pop | 761.2ms | 829.1ms | — |
| array/sort-i32 | 878.0ms | 967.9ms | — |
| array/map-filter | 903.6ms | 943.2ms | — |
| array/reduce | 812.5ms | 891.4ms | — |
| array/indexOf | 825.5ms | 902.2ms | — |
| array/slice | 775.2ms | 846.7ms | — |
| array/reverse | 769.4ms | 852.8ms | — |
| array/forEach | 863.4ms | 953.1ms | — |
| array/find | 759.3ms | 846.8ms | 818.7ms |
| dom/create-elements | 635.1ms | — | — |
| dom/set-attributes | 704.8ms | — | — |
| dom/read-attributes | 671.8ms | — | — |
| dom/modify-text | 600.6ms | — | — |
| mixed/csv-parse | 771.3ms | 911.8ms | — |
| mixed/text-search | 751.6ms | 981.4ms | 904.7ms |
| mixed/fibonacci | 764.4ms | 792.7ms | 782.0ms |
| mixed/matrix-multiply | 862.1ms | 869.1ms | 777.0ms |
| mixed/sieve | 843.9ms | 895.9ms | — |
