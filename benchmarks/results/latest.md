# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.035ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.159ms | 0.022ms | FAILED | js |
| string/split | 0.424ms | 5.86ms | 1.46ms | FAILED | js |
| string/replace | 0.047ms | 0.304ms | 0.101ms | FAILED | js |
| string/case-convert | 0.061ms | 0.245ms | 0.108ms | FAILED | js |
| string/substring | 0.099ms | 2.04ms | 0.910ms | FAILED | js |
| string/trim | 0.169ms | 1.34ms | 0.653ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 2.98ms | 0.520ms | FAILED | js |
| array/push-pop | 1.43ms | 2.17ms | 2.17ms | FAILED | js |
| array/sort-i32 | 0.793ms | 0.393ms | 0.394ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.641ms | 0.642ms | FAILED | js |
| array/reduce | 2.14ms | 2.18ms | 2.16ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.026ms | 0.036ms | 0.036ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.239ms | 0.459ms | 0.459ms | 4.85ms | js |
| dom/create-elements | 0.036ms | 0.286ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.409ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.172ms | — | — | js |
| dom/modify-text | 0.048ms | 0.164ms | — | — | js |
| mixed/csv-parse | 1.39ms | 7.20ms | 0.827ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 6.63ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 1.15ms | js |
| mixed/matrix-multiply | 0.157ms | 0.555ms | 0.555ms | 2.12ms | js |
| mixed/sieve | 1.56ms | 1.38ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.45 | 4.66 | 3.55 | — |
| string/concat-long | 1000 | 3.63 | 7.54 | 8.18 | — |
| string/indexOf | 1000 | 19.13 | 81.17 | 23.57 | — |
| string/includes | 1000 | 19.21 | 158.63 | 22.31 | — |
| string/split | 10000 | 42.42 | 586.02 | 145.85 | — |
| string/replace | 1000 | 46.67 | 304.35 | 101.24 | — |
| string/case-convert | 2000 | 30.37 | 122.38 | 54.00 | — |
| string/substring | 10000 | 9.88 | 203.99 | 90.98 | — |
| string/trim | 10000 | 16.92 | 133.88 | 65.26 | — |
| string/startsWith-endsWith | 20000 | 19.50 | 148.99 | 25.99 | — |
| mixed/csv-parse | 11000 | 126.64 | 654.83 | 75.18 | — |
| mixed/text-search | 40000 | 9.77 | 165.80 | 26.56 | — |
| mixed/fibonacci | 10000 | 12.17 | 26.11 | 26.14 | 114.66 |
| mixed/matrix-multiply | 125000 | 1.25 | 4.44 | 4.44 | 16.99 |
| mixed/sieve | 200000 | 7.82 | 6.91 | 6.90 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.35x slower | 1.03x slower | — |
| string/concat-long | 2.08x slower | 2.25x slower | — |
| string/indexOf | 4.24x slower | 1.23x slower | — |
| string/includes | 8.26x slower | 1.16x slower | — |
| string/split | 13.82x slower | 3.44x slower | — |
| string/replace | 6.52x slower | 2.17x slower | — |
| string/case-convert | 4.03x slower | 1.78x slower | — |
| string/substring | 20.65x slower | 9.21x slower | — |
| string/trim | 7.91x slower | 3.86x slower | — |
| string/startsWith-endsWith | 7.64x slower | 1.33x slower | — |
| array/push-pop | 1.51x slower | 1.52x slower | — |
| array/sort-i32 | 2.02x faster | 2.01x faster | — |
| array/map-filter | 4.94x slower | 4.94x slower | — |
| array/reduce | 1.02x slower | 1.01x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.40x slower | 1.40x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.36x slower | 2.36x slower | — |
| array/find | 1.92x slower | 1.92x slower | 20.28x slower |
| dom/create-elements | 7.92x slower | — | — |
| dom/set-attributes | 3.96x slower | — | — |
| dom/read-attributes | 3.20x slower | — | — |
| dom/modify-text | 3.39x slower | — | — |
| mixed/csv-parse | 5.17x slower | 1.68x faster | — |
| mixed/text-search | 16.97x slower | 2.72x slower | — |
| mixed/fibonacci | 2.15x slower | 2.15x slower | 9.42x slower |
| mixed/matrix-multiply | 3.54x slower | 3.54x slower | 13.55x slower |
| mixed/sieve | 1.13x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.31x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 3.44x faster |
| string/includes | 7.11x faster |
| string/split | 4.02x faster |
| string/replace | 3.01x faster |
| string/case-convert | 2.27x faster |
| string/substring | 2.24x faster |
| string/trim | 2.05x faster |
| string/startsWith-endsWith | 5.73x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 8.71x faster |
| mixed/text-search | 6.24x faster |
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
| string/concat-short | 1417.1ms | 1196.3ms | — |
| string/concat-long | 656.8ms | 1062.2ms | — |
| string/indexOf | 796.0ms | 1066.2ms | — |
| string/includes | 782.4ms | 1032.3ms | — |
| string/split | 828.4ms | 1094.8ms | — |
| string/replace | 826.9ms | 1138.2ms | — |
| string/case-convert | 865.5ms | 1093.8ms | — |
| string/substring | 702.5ms | 999.9ms | — |
| string/trim | 788.4ms | 989.9ms | — |
| string/startsWith-endsWith | 838.0ms | 1013.7ms | — |
| array/push-pop | 777.4ms | 841.5ms | — |
| array/sort-i32 | 953.3ms | 987.0ms | — |
| array/map-filter | 964.7ms | 1043.9ms | — |
| array/reduce | 858.3ms | 873.7ms | — |
| array/indexOf | 740.2ms | 794.9ms | — |
| array/slice | 764.0ms | 800.9ms | — |
| array/reverse | 765.6ms | 810.1ms | — |
| array/forEach | 884.5ms | 962.0ms | — |
| array/find | 919.2ms | 946.0ms | 829.8ms |
| dom/create-elements | 633.2ms | — | — |
| dom/set-attributes | 696.8ms | — | — |
| dom/read-attributes | 682.1ms | — | — |
| dom/modify-text | 668.7ms | — | — |
| mixed/csv-parse | 851.5ms | 1019.0ms | — |
| mixed/text-search | 854.3ms | 1006.1ms | — |
| mixed/fibonacci | 790.4ms | 854.6ms | 767.5ms |
| mixed/matrix-multiply | 886.0ms | 956.2ms | 802.1ms |
| mixed/sieve | 793.1ms | 855.3ms | — |
