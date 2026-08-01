# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.166ms | 0.022ms | FAILED | js |
| string/split | 0.423ms | 5.82ms | 1.44ms | FAILED | js |
| string/replace | 0.046ms | 0.275ms | 0.103ms | FAILED | js |
| string/case-convert | 0.060ms | 0.296ms | 0.106ms | FAILED | js |
| string/substring | 0.098ms | 2.02ms | 0.906ms | FAILED | js |
| string/trim | 0.169ms | 1.33ms | 0.648ms | FAILED | js |
| string/startsWith-endsWith | 0.391ms | 2.91ms | 0.523ms | FAILED | js |
| array/push-pop | 1.43ms | 2.18ms | 2.19ms | FAILED | js |
| array/sort-i32 | 0.799ms | 0.392ms | 0.394ms | FAILED | host-call |
| array/map-filter | 0.131ms | 0.642ms | 0.644ms | FAILED | js |
| array/reduce | 2.13ms | 2.18ms | 2.18ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.024ms | 0.034ms | 0.035ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.239ms | 0.459ms | 0.458ms | 4.84ms | js |
| dom/create-elements | 0.036ms | 0.294ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.367ms | — | — | js |
| dom/read-attributes | 0.053ms | 0.174ms | — | — | js |
| dom/modify-text | 0.047ms | 0.173ms | — | — | js |
| mixed/csv-parse | 0.475ms | 7.37ms | 0.829ms | FAILED | js |
| mixed/text-search | 0.390ms | 6.27ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.162ms | 0.554ms | 0.555ms | 2.13ms | js |
| mixed/sieve | 1.57ms | 1.41ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.40 | 4.38 | 3.75 | — |
| string/concat-long | 1000 | 3.54 | 7.52 | 8.12 | — |
| string/indexOf | 1000 | 19.12 | 80.70 | 23.59 | — |
| string/includes | 1000 | 19.17 | 165.83 | 22.28 | — |
| string/split | 10000 | 42.29 | 582.01 | 143.88 | — |
| string/replace | 1000 | 46.48 | 275.43 | 103.37 | — |
| string/case-convert | 2000 | 30.18 | 148.01 | 53.10 | — |
| string/substring | 10000 | 9.84 | 202.47 | 90.61 | — |
| string/trim | 10000 | 16.91 | 133.10 | 64.80 | — |
| string/startsWith-endsWith | 20000 | 19.54 | 145.58 | 26.14 | — |
| mixed/csv-parse | 11000 | 43.21 | 670.37 | 75.34 | — |
| mixed/text-search | 40000 | 9.75 | 156.82 | 26.53 | — |
| mixed/fibonacci | 10000 | 12.17 | 26.08 | 26.12 | 25.90 |
| mixed/matrix-multiply | 125000 | 1.30 | 4.43 | 4.44 | 17.00 |
| mixed/sieve | 200000 | 7.85 | 7.04 | 6.94 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.29x slower | 1.10x slower | — |
| string/concat-long | 2.12x slower | 2.29x slower | — |
| string/indexOf | 4.22x slower | 1.23x slower | — |
| string/includes | 8.65x slower | 1.16x slower | — |
| string/split | 13.76x slower | 3.40x slower | — |
| string/replace | 5.93x slower | 2.22x slower | — |
| string/case-convert | 4.90x slower | 1.76x slower | — |
| string/substring | 20.58x slower | 9.21x slower | — |
| string/trim | 7.87x slower | 3.83x slower | — |
| string/startsWith-endsWith | 7.45x slower | 1.34x slower | — |
| array/push-pop | 1.52x slower | 1.53x slower | — |
| array/sort-i32 | 2.04x faster | 2.03x faster | — |
| array/map-filter | 4.89x slower | 4.91x slower | — |
| array/reduce | 1.02x slower | 1.02x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.39x slower | 1.41x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.37x slower | 2.36x slower | — |
| array/find | 1.92x slower | 1.92x slower | 20.27x slower |
| dom/create-elements | 8.26x slower | — | — |
| dom/set-attributes | 3.57x slower | — | — |
| dom/read-attributes | 3.29x slower | — | — |
| dom/modify-text | 3.72x slower | — | — |
| mixed/csv-parse | 15.51x slower | 1.74x slower | — |
| mixed/text-search | 16.08x slower | 2.72x slower | — |
| mixed/fibonacci | 2.14x slower | 2.15x slower | 2.13x slower |
| mixed/matrix-multiply | 3.42x slower | 3.43x slower | 13.13x slower |
| mixed/sieve | 1.11x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 3.42x faster |
| string/includes | 7.44x faster |
| string/split | 4.05x faster |
| string/replace | 2.66x faster |
| string/case-convert | 2.79x faster |
| string/substring | 2.23x faster |
| string/trim | 2.05x faster |
| string/startsWith-endsWith | 5.57x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.90x faster |
| mixed/text-search | 5.91x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1273.1ms | 1149.4ms | — |
| string/concat-long | 628.7ms | 1031.8ms | — |
| string/indexOf | 742.7ms | 1000.6ms | — |
| string/includes | 761.1ms | 974.3ms | — |
| string/split | 801.0ms | 1020.1ms | — |
| string/replace | 809.8ms | 1075.8ms | — |
| string/case-convert | 807.1ms | 1077.4ms | — |
| string/substring | 723.7ms | 981.5ms | — |
| string/trim | 811.5ms | 1035.8ms | — |
| string/startsWith-endsWith | 847.2ms | 1066.8ms | — |
| array/push-pop | 784.6ms | 836.6ms | — |
| array/sort-i32 | 955.9ms | 994.7ms | — |
| array/map-filter | 987.3ms | 1037.3ms | — |
| array/reduce | 837.9ms | 928.8ms | — |
| array/indexOf | 767.3ms | 833.4ms | — |
| array/slice | 757.0ms | 820.7ms | — |
| array/reverse | 769.5ms | 825.1ms | — |
| array/forEach | 907.7ms | 932.2ms | — |
| array/find | 894.5ms | 935.6ms | 841.3ms |
| dom/create-elements | 645.8ms | — | — |
| dom/set-attributes | 689.4ms | — | — |
| dom/read-attributes | 680.1ms | — | — |
| dom/modify-text | 676.3ms | — | — |
| mixed/csv-parse | 918.4ms | 1061.0ms | — |
| mixed/text-search | 803.7ms | 1018.5ms | — |
| mixed/fibonacci | 812.3ms | 935.6ms | 781.2ms |
| mixed/matrix-multiply | 873.1ms | 946.1ms | 792.8ms |
| mixed/sieve | 793.6ms | 910.6ms | — |
