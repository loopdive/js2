# js2wasm Benchmark Results

Date: 2026-08-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.084ms | 0.023ms | FAILED | js |
| string/includes | 0.019ms | 0.159ms | 0.022ms | FAILED | js |
| string/split | 0.425ms | 6.08ms | 1.43ms | FAILED | js |
| string/replace | 0.046ms | 0.292ms | 0.101ms | FAILED | js |
| string/case-convert | 0.060ms | 0.247ms | 0.106ms | FAILED | js |
| string/substring | 0.098ms | 0.936ms | 0.910ms | FAILED | js |
| string/trim | 0.169ms | 1.32ms | 0.643ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 3.03ms | 0.520ms | FAILED | js |
| array/push-pop | 1.46ms | 2.18ms | 2.18ms | FAILED | js |
| array/sort-i32 | 0.794ms | 0.396ms | 0.392ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.641ms | 0.645ms | FAILED | js |
| array/reduce | 2.15ms | 2.20ms | 2.25ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.035ms | 0.035ms | FAILED | js |
| array/reverse | 7.82ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.240ms | 0.458ms | 0.459ms | 1.07ms | js |
| dom/create-elements | 0.035ms | 0.275ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.373ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.180ms | — | — | js |
| dom/modify-text | 0.047ms | 0.168ms | — | — | js |
| mixed/csv-parse | 0.479ms | 7.67ms | 0.824ms | FAILED | js |
| mixed/text-search | 0.393ms | 6.12ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.158ms | 0.555ms | 0.556ms | 0.717ms | js |
| mixed/sieve | 1.55ms | 1.40ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.06 | 4.53 | 4.24 | — |
| string/concat-long | 1000 | 3.58 | 7.48 | 8.27 | — |
| string/indexOf | 1000 | 19.13 | 84.23 | 23.38 | — |
| string/includes | 1000 | 19.17 | 158.65 | 22.31 | — |
| string/split | 10000 | 42.50 | 607.52 | 143.07 | — |
| string/replace | 1000 | 46.46 | 292.39 | 101.42 | — |
| string/case-convert | 2000 | 30.21 | 123.45 | 52.90 | — |
| string/substring | 10000 | 9.84 | 93.65 | 91.01 | — |
| string/trim | 10000 | 16.94 | 132.08 | 64.34 | — |
| string/startsWith-endsWith | 20000 | 19.49 | 151.60 | 25.99 | — |
| mixed/csv-parse | 11000 | 43.59 | 697.38 | 74.92 | — |
| mixed/text-search | 40000 | 9.81 | 152.88 | 26.56 | — |
| mixed/fibonacci | 10000 | 12.18 | 26.14 | 26.11 | 25.90 |
| mixed/matrix-multiply | 125000 | 1.26 | 4.44 | 4.45 | 5.74 |
| mixed/sieve | 200000 | 7.73 | 6.99 | 6.99 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.39x slower | — |
| string/concat-long | 2.09x slower | 2.31x slower | — |
| string/indexOf | 4.40x slower | 1.22x slower | — |
| string/includes | 8.28x slower | 1.16x slower | — |
| string/split | 14.29x slower | 3.37x slower | — |
| string/replace | 6.29x slower | 2.18x slower | — |
| string/case-convert | 4.09x slower | 1.75x slower | — |
| string/substring | 9.52x slower | 9.25x slower | — |
| string/trim | 7.80x slower | 3.80x slower | — |
| string/startsWith-endsWith | 7.78x slower | 1.33x slower | — |
| array/push-pop | 1.49x slower | 1.49x slower | — |
| array/sort-i32 | 2.00x faster | 2.02x faster | — |
| array/map-filter | 4.90x slower | 4.92x slower | — |
| array/reduce | 1.03x slower | 1.05x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.38x slower | 1.39x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.38x slower | 2.38x slower | — |
| array/find | 1.91x slower | 1.91x slower | 4.47x slower |
| dom/create-elements | 7.86x slower | — | — |
| dom/set-attributes | 3.61x slower | — | — |
| dom/read-attributes | 3.27x slower | — | — |
| dom/modify-text | 3.54x slower | — | — |
| mixed/csv-parse | 16.00x slower | 1.72x slower | — |
| mixed/text-search | 15.58x slower | 2.71x slower | — |
| mixed/fibonacci | 2.15x slower | 2.14x slower | 2.13x slower |
| mixed/matrix-multiply | 3.52x slower | 3.53x slower | 4.55x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.11x slower |
| string/indexOf | 3.60x faster |
| string/includes | 7.11x faster |
| string/split | 4.25x faster |
| string/replace | 2.88x faster |
| string/case-convert | 2.33x faster |
| string/substring | 1.03x faster |
| string/trim | 2.05x faster |
| string/startsWith-endsWith | 5.83x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 9.31x faster |
| mixed/text-search | 5.76x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 233B | 964B | — |
| string/indexOf | 412B | 1.3KB | — |
| string/includes | 398B | 1.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 645B | 1.0KB | — |
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
| array/find | 2.7KB | 3.0KB | 635B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 297B | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1291.0ms | 1141.3ms | — |
| string/concat-long | 636.4ms | 981.7ms | — |
| string/indexOf | 745.9ms | 1001.1ms | — |
| string/includes | 757.1ms | 1037.9ms | — |
| string/split | 829.2ms | 1014.2ms | — |
| string/replace | 826.0ms | 1066.0ms | — |
| string/case-convert | 836.9ms | 1089.4ms | — |
| string/substring | 728.7ms | 933.8ms | — |
| string/trim | 811.6ms | 1004.4ms | — |
| string/startsWith-endsWith | 820.6ms | 1028.0ms | — |
| array/push-pop | 768.1ms | 820.9ms | — |
| array/sort-i32 | 951.3ms | 1018.6ms | — |
| array/map-filter | 932.8ms | 999.2ms | — |
| array/reduce | 859.9ms | 924.9ms | — |
| array/indexOf | 772.4ms | 820.1ms | — |
| array/slice | 754.1ms | 804.5ms | — |
| array/reverse | 749.0ms | 826.8ms | — |
| array/forEach | 862.9ms | 948.8ms | — |
| array/find | 881.1ms | 956.7ms | 834.4ms |
| dom/create-elements | 631.4ms | — | — |
| dom/set-attributes | 735.2ms | — | — |
| dom/read-attributes | 678.6ms | — | — |
| dom/modify-text | 679.6ms | — | — |
| mixed/csv-parse | 886.2ms | 1025.9ms | — |
| mixed/text-search | 856.1ms | 1038.1ms | — |
| mixed/fibonacci | 799.1ms | 865.0ms | 805.2ms |
| mixed/matrix-multiply | 898.3ms | 930.9ms | 780.6ms |
| mixed/sieve | 785.6ms | 888.9ms | — |
