# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.084ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.145ms | 0.022ms | FAILED | js |
| string/split | 0.411ms | 6.18ms | 1.40ms | FAILED | js |
| string/replace | 0.047ms | 0.297ms | 0.148ms | FAILED | js |
| string/case-convert | 0.060ms | 0.255ms | 0.106ms | FAILED | js |
| string/substring | 0.099ms | 1.98ms | 0.905ms | FAILED | js |
| string/trim | 0.170ms | 1.40ms | 0.646ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 2.78ms | 0.520ms | FAILED | js |
| array/push-pop | 1.43ms | 2.19ms | 2.22ms | FAILED | js |
| array/sort-i32 | 0.795ms | 0.392ms | 0.394ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.641ms | 0.645ms | FAILED | js |
| array/reduce | 1.39ms | 2.20ms | 2.19ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.028ms | 0.035ms | 0.038ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.054ms | 0.117ms | 0.115ms | FAILED | js |
| array/find | 0.229ms | 0.461ms | 0.459ms | 4.84ms | js |
| dom/create-elements | 0.255ms | 0.302ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.408ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.181ms | — | — | js |
| dom/modify-text | 0.052ms | 0.165ms | — | — | js |
| mixed/csv-parse | 0.480ms | 7.61ms | 0.831ms | FAILED | js |
| mixed/text-search | 0.392ms | 5.78ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 1.15ms | js |
| mixed/matrix-multiply | 0.164ms | 0.556ms | 0.556ms | 2.13ms | js |
| mixed/sieve | 1.57ms | 1.38ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.22 | 4.44 | 3.83 | — |
| string/concat-long | 1000 | 3.73 | 7.52 | 8.20 | — |
| string/indexOf | 1000 | 19.17 | 83.88 | 23.63 | — |
| string/includes | 1000 | 19.20 | 145.00 | 22.35 | — |
| string/split | 10000 | 41.10 | 618.17 | 140.24 | — |
| string/replace | 1000 | 46.68 | 296.71 | 147.92 | — |
| string/case-convert | 2000 | 30.17 | 127.31 | 53.08 | — |
| string/substring | 10000 | 9.92 | 198.10 | 90.54 | — |
| string/trim | 10000 | 16.95 | 139.51 | 64.64 | — |
| string/startsWith-endsWith | 20000 | 19.50 | 138.99 | 25.99 | — |
| mixed/csv-parse | 11000 | 43.66 | 692.13 | 75.58 | — |
| mixed/text-search | 40000 | 9.80 | 144.39 | 26.47 | — |
| mixed/fibonacci | 10000 | 12.17 | 26.13 | 26.12 | 114.67 |
| mixed/matrix-multiply | 125000 | 1.31 | 4.45 | 4.45 | 17.01 |
| mixed/sieve | 200000 | 7.83 | 6.91 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.38x slower | 1.19x slower | — |
| string/concat-long | 2.02x slower | 2.20x slower | — |
| string/indexOf | 4.37x slower | 1.23x slower | — |
| string/includes | 7.55x slower | 1.16x slower | — |
| string/split | 15.04x slower | 3.41x slower | — |
| string/replace | 6.36x slower | 3.17x slower | — |
| string/case-convert | 4.22x slower | 1.76x slower | — |
| string/substring | 19.97x slower | 9.13x slower | — |
| string/trim | 8.23x slower | 3.81x slower | — |
| string/startsWith-endsWith | 7.13x slower | 1.33x slower | — |
| array/push-pop | 1.53x slower | 1.56x slower | — |
| array/sort-i32 | 2.03x faster | 2.02x faster | — |
| array/map-filter | 4.94x slower | 4.97x slower | — |
| array/reduce | 1.58x slower | 1.58x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.27x slower | 1.36x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.16x slower | 2.13x slower | — |
| array/find | 2.01x slower | 2.00x slower | 21.13x slower |
| dom/create-elements | 1.19x slower | — | — |
| dom/set-attributes | 3.86x slower | — | — |
| dom/read-attributes | 2.96x slower | — | — |
| dom/modify-text | 3.19x slower | — | — |
| mixed/csv-parse | 15.85x slower | 1.73x slower | — |
| mixed/text-search | 14.73x slower | 2.70x slower | — |
| mixed/fibonacci | 2.15x slower | 2.15x slower | 9.42x slower |
| mixed/matrix-multiply | 3.39x slower | 3.40x slower | 12.98x slower |
| mixed/sieve | 1.13x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.55x faster |
| string/includes | 6.49x faster |
| string/split | 4.41x faster |
| string/replace | 2.01x faster |
| string/case-convert | 2.40x faster |
| string/substring | 2.19x faster |
| string/trim | 2.16x faster |
| string/startsWith-endsWith | 5.35x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.07x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.02x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.16x faster |
| mixed/text-search | 5.45x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

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
| string/substring | 556B | 1.0KB | — |
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
| mixed/fibonacci | 297B | 297B | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1279.7ms | 1160.0ms | — |
| string/concat-long | 684.3ms | 983.5ms | — |
| string/indexOf | 809.3ms | 1060.8ms | — |
| string/includes | 787.1ms | 1022.6ms | — |
| string/split | 856.3ms | 1100.9ms | — |
| string/replace | 872.8ms | 1159.0ms | — |
| string/case-convert | 825.9ms | 1115.3ms | — |
| string/substring | 765.2ms | 1001.3ms | — |
| string/trim | 834.5ms | 1064.5ms | — |
| string/startsWith-endsWith | 847.4ms | 1047.0ms | — |
| array/push-pop | 784.3ms | 826.4ms | — |
| array/sort-i32 | 935.5ms | 1022.8ms | — |
| array/map-filter | 973.7ms | 1055.2ms | — |
| array/reduce | 908.1ms | 938.1ms | — |
| array/indexOf | 794.1ms | 856.3ms | — |
| array/slice | 803.9ms | 853.7ms | — |
| array/reverse | 771.0ms | 850.8ms | — |
| array/forEach | 894.5ms | 959.3ms | — |
| array/find | 911.9ms | 1008.0ms | 854.9ms |
| dom/create-elements | 675.6ms | — | — |
| dom/set-attributes | 742.9ms | — | — |
| dom/read-attributes | 735.4ms | — | — |
| dom/modify-text | 699.3ms | — | — |
| mixed/csv-parse | 871.9ms | 1043.4ms | — |
| mixed/text-search | 838.2ms | 1077.4ms | — |
| mixed/fibonacci | 794.2ms | 865.5ms | 795.6ms |
| mixed/matrix-multiply | 908.1ms | 958.1ms | 826.5ms |
| mixed/sieve | 850.9ms | 899.6ms | — |
