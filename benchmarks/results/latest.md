# js2wasm Benchmark Results

Date: 2026-08-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.065ms | gc-native |
| string/includes | 0.019ms | 0.047ms | 0.015ms | 0.017ms | gc-native |
| string/split | 0.424ms | 4.98ms | 0.450ms | FAILED | js |
| string/replace | 0.105ms | 0.295ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.242ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.891ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.360ms | 0.288ms | 0.562ms | gc-native |
| array/push-pop | 1.40ms | 0.502ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.302ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.069ms | 0.069ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.503ms | 0.503ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 0.995ms | gc-native |
| dom/create-elements | 0.204ms | 0.167ms | — | — | host-call |
| dom/set-attributes | 0.107ms | 0.194ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.119ms | — | — | js |
| dom/modify-text | 0.031ms | 0.122ms | — | — | js |
| mixed/csv-parse | 0.499ms | 7.59ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.61ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.235ms | 0.235ms | 0.244ms | js |
| mixed/matrix-multiply | 0.163ms | 0.213ms | 0.211ms | 0.717ms | js |
| mixed/sieve | 1.57ms | 1.39ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.14 | 4.49 | 3.97 | — |
| string/concat-long | 1000 | 3.58 | 4.56 | 3.70 | — |
| string/indexOf | 1000 | 19.20 | 65.58 | 12.16 | 64.62 |
| string/includes | 1000 | 19.23 | 47.42 | 14.69 | 16.54 |
| string/split | 10000 | 42.43 | 497.69 | 44.97 | — |
| string/replace | 1000 | 105.17 | 294.77 | 70.98 | — |
| string/case-convert | 2000 | 27.79 | 121.00 | 2.50 | — |
| string/substring | 10000 | 9.90 | 3.77 | 3.07 | — |
| string/trim | 10000 | 17.02 | 89.11 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 17.98 | 14.40 | 28.11 |
| array/map-filter | 30000 | 4.34 | 2.30 | 2.30 | — |
| array/indexOf | 1000 | 3951.87 | 2639.68 | 2638.02 | — |
| dom/create-elements | 2000 | 102.19 | 83.75 | — | — |
| dom/set-attributes | 6000 | 17.76 | 32.30 | — | — |
| dom/read-attributes | 3000 | 19.19 | 39.50 | — | — |
| dom/modify-text | 2000 | 15.69 | 61.07 | — | — |
| mixed/csv-parse | 11000 | 45.33 | 690.28 | 28.62 | — |
| mixed/text-search | 40000 | 9.74 | 40.17 | 6.65 | 26.99 |
| mixed/fibonacci | 10000 | 12.18 | 23.50 | 23.49 | 24.36 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.70 | 1.69 | 5.74 |
| mixed/sieve | 200000 | 7.87 | 6.93 | 6.94 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.26x slower | — |
| string/concat-long | 1.27x slower | 1.03x slower | — |
| string/indexOf | 3.42x slower | 1.58x faster | 3.37x slower |
| string/includes | 2.47x slower | 1.31x faster | 1.16x faster |
| string/split | 11.73x slower | 1.06x slower | — |
| string/replace | 2.80x slower | 1.48x faster | — |
| string/case-convert | 4.35x slower | 11.10x faster | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 5.24x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.40x faster | 1.40x slower |
| array/push-pop | 2.80x faster | 2.78x faster | — |
| array/sort-i32 | 2.61x faster | 2.63x faster | — |
| array/map-filter | 1.89x faster | 1.89x faster | — |
| array/reduce | 2.67x faster | 2.67x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.78x faster | — |
| array/find | 15.75x faster | 15.85x faster | 3.92x slower |
| dom/create-elements | 1.22x faster | — | — |
| dom/set-attributes | 1.82x slower | — | — |
| dom/read-attributes | 2.06x slower | — | — |
| dom/modify-text | 3.89x slower | — | — |
| mixed/csv-parse | 15.23x slower | 1.58x faster | — |
| mixed/text-search | 4.13x slower | 1.46x faster | 2.77x slower |
| mixed/fibonacci | 1.93x slower | 1.93x slower | 2.00x slower |
| mixed/matrix-multiply | 1.31x slower | 1.30x slower | 4.40x slower |
| mixed/sieve | 1.14x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 5.39x faster |
| string/includes | 3.23x faster |
| string/split | 11.07x faster |
| string/replace | 4.15x faster |
| string/case-convert | 48.31x faster |
| string/substring | 1.23x faster |
| string/trim | 4.78x faster |
| string/startsWith-endsWith | 1.25x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 24.12x faster |
| mixed/text-search | 6.04x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 350B | 350B | 342B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1304.6ms | 1145.0ms | — |
| string/concat-long | 676.0ms | 1020.9ms | — |
| string/indexOf | 815.6ms | 996.9ms | 850.0ms |
| string/includes | 807.7ms | 999.1ms | 886.7ms |
| string/split | 790.8ms | 998.7ms | — |
| string/replace | 933.8ms | 1089.5ms | — |
| string/case-convert | 808.7ms | 845.7ms | — |
| string/substring | 667.8ms | 779.4ms | — |
| string/trim | 771.6ms | 1012.1ms | — |
| string/startsWith-endsWith | 762.0ms | 1014.5ms | 911.5ms |
| array/push-pop | 782.1ms | 826.9ms | — |
| array/sort-i32 | 932.0ms | 1012.6ms | — |
| array/map-filter | 901.7ms | 1026.8ms | — |
| array/reduce | 851.3ms | 894.8ms | — |
| array/indexOf | 919.9ms | 1008.0ms | — |
| array/slice | 762.9ms | 840.5ms | — |
| array/reverse | 779.4ms | 839.0ms | — |
| array/forEach | 845.7ms | 974.2ms | — |
| array/find | 758.3ms | 838.9ms | 850.1ms |
| dom/create-elements | 675.6ms | — | — |
| dom/set-attributes | 753.9ms | — | — |
| dom/read-attributes | 706.1ms | — | — |
| dom/modify-text | 641.0ms | — | — |
| mixed/csv-parse | 820.5ms | 1015.6ms | — |
| mixed/text-search | 779.7ms | 1010.9ms | 946.2ms |
| mixed/fibonacci | 847.6ms | 868.2ms | 814.5ms |
| mixed/matrix-multiply | 844.7ms | 906.1ms | 823.1ms |
| mixed/sieve | 812.6ms | 877.4ms | — |
