# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.051ms | 0.059ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.014ms | 0.060ms | 0.019ms | FAILED | js |
| string/includes | 0.014ms | 0.096ms | 0.019ms | FAILED | js |
| string/split | 0.304ms | 4.29ms | 1.27ms | FAILED | js |
| string/replace | 0.037ms | 0.194ms | 0.083ms | FAILED | js |
| string/case-convert | 0.043ms | 0.162ms | 0.092ms | FAILED | js |
| string/substring | 0.098ms | 1.45ms | 0.791ms | FAILED | js |
| string/trim | 0.148ms | 1.05ms | 0.647ms | FAILED | js |
| string/startsWith-endsWith | 0.395ms | 1.78ms | 0.439ms | FAILED | js |
| array/push-pop | 1.28ms | 1.96ms | 2.01ms | FAILED | js |
| array/sort-i32 | 0.547ms | 0.332ms | 0.331ms | FAILED | gc-native |
| array/map-filter | 0.123ms | 0.589ms | 0.590ms | FAILED | js |
| array/reduce | 1.19ms | 2.02ms | 2.00ms | FAILED | js |
| array/indexOf | 4.49ms | 3.84ms | 3.84ms | FAILED | gc-native |
| array/slice | 0.023ms | 0.031ms | 0.031ms | FAILED | js |
| array/reverse | 7.06ms | 3.27ms | 3.27ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.108ms | 0.108ms | FAILED | js |
| array/find | 0.248ms | 0.480ms | 0.479ms | 3.37ms | js |
| dom/create-elements | 0.047ms | 0.237ms | — | — | js |
| dom/set-attributes | 0.116ms | 0.278ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.134ms | — | — | js |
| dom/modify-text | 0.066ms | 0.137ms | — | — | js |
| mixed/csv-parse | 0.339ms | 5.18ms | 0.756ms | FAILED | js |
| mixed/text-search | 0.376ms | 3.61ms | 0.979ms | FAILED | js |
| mixed/fibonacci | 0.113ms | 0.149ms | 0.149ms | 0.148ms | js |
| mixed/matrix-multiply | 0.161ms | 0.759ms | 0.759ms | 1.41ms | js |
| mixed/sieve | 1.41ms | 1.36ms | 1.37ms | FAILED | host-call |

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
| string/concat-short | 10000 | 4.29 | 5.06 | 5.89 | — |
| string/concat-long | 1000 | 4.31 | 8.20 | 9.06 | — |
| string/indexOf | 1000 | 13.94 | 59.78 | 19.18 | — |
| string/includes | 1000 | 13.91 | 95.75 | 18.53 | — |
| string/split | 10000 | 30.37 | 429.33 | 126.91 | — |
| string/replace | 1000 | 37.47 | 193.94 | 83.46 | — |
| string/case-convert | 2000 | 21.56 | 80.98 | 45.99 | — |
| string/substring | 10000 | 9.82 | 145.29 | 79.10 | — |
| string/trim | 10000 | 14.81 | 104.80 | 64.66 | — |
| string/startsWith-endsWith | 20000 | 19.77 | 88.94 | 21.97 | — |
| mixed/csv-parse | 11000 | 30.82 | 471.17 | 68.76 | — |
| mixed/text-search | 40000 | 9.41 | 90.19 | 24.47 | — |
| mixed/fibonacci | 10000 | 11.30 | 14.85 | 14.86 | 14.80 |
| mixed/matrix-multiply | 125000 | 1.29 | 6.07 | 6.07 | 11.31 |
| mixed/sieve | 200000 | 7.04 | 6.78 | 6.85 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.18x slower | 1.37x slower | — |
| string/concat-long | 1.90x slower | 2.10x slower | — |
| string/indexOf | 4.29x slower | 1.38x slower | — |
| string/includes | 6.88x slower | 1.33x slower | — |
| string/split | 14.14x slower | 4.18x slower | — |
| string/replace | 5.18x slower | 2.23x slower | — |
| string/case-convert | 3.76x slower | 2.13x slower | — |
| string/substring | 14.80x slower | 8.06x slower | — |
| string/trim | 7.08x slower | 4.37x slower | — |
| string/startsWith-endsWith | 4.50x slower | 1.11x slower | — |
| array/push-pop | 1.53x slower | 1.57x slower | — |
| array/sort-i32 | 1.65x faster | 1.65x faster | — |
| array/map-filter | 4.79x slower | 4.80x slower | — |
| array/reduce | 1.70x slower | 1.68x slower | — |
| array/indexOf | 1.17x faster | 1.17x faster | — |
| array/slice | 1.35x slower | 1.34x slower | — |
| array/reverse | 2.16x faster | 2.16x faster | — |
| array/forEach | 2.03x slower | 2.02x slower | — |
| array/find | 1.94x slower | 1.93x slower | 13.61x slower |
| dom/create-elements | 5.07x slower | — | — |
| dom/set-attributes | 2.41x slower | — | — |
| dom/read-attributes | 2.68x slower | — | — |
| dom/modify-text | 2.06x slower | — | — |
| mixed/csv-parse | 15.29x slower | 2.23x slower | — |
| mixed/text-search | 9.59x slower | 2.60x slower | — |
| mixed/fibonacci | 1.31x slower | 1.31x slower | 1.31x slower |
| mixed/matrix-multiply | 4.71x slower | 4.71x slower | 8.78x slower |
| mixed/sieve | 1.04x faster | 1.03x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x slower |
| string/concat-long | 1.11x slower |
| string/indexOf | 3.12x faster |
| string/includes | 5.17x faster |
| string/split | 3.38x faster |
| string/replace | 2.32x faster |
| string/case-convert | 1.76x faster |
| string/substring | 1.84x faster |
| string/trim | 1.62x faster |
| string/startsWith-endsWith | 4.05x faster |
| array/push-pop | 1.03x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 6.85x faster |
| mixed/text-search | 3.69x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1015.6ms | 895.8ms | — |
| string/concat-long | 505.4ms | 785.2ms | — |
| string/indexOf | 632.4ms | 838.0ms | — |
| string/includes | 629.2ms | 824.5ms | — |
| string/split | 650.4ms | 844.1ms | — |
| string/replace | 657.2ms | 864.1ms | — |
| string/case-convert | 668.1ms | 884.3ms | — |
| string/substring | 567.5ms | 754.1ms | — |
| string/trim | 647.6ms | 837.7ms | — |
| string/startsWith-endsWith | 671.4ms | 829.1ms | — |
| array/push-pop | 625.2ms | 635.2ms | — |
| array/sort-i32 | 763.0ms | 806.4ms | — |
| array/map-filter | 766.4ms | 821.8ms | — |
| array/reduce | 696.6ms | 752.7ms | — |
| array/indexOf | 634.9ms | 671.2ms | — |
| array/slice | 627.7ms | 675.4ms | — |
| array/reverse | 637.8ms | 665.9ms | — |
| array/forEach | 720.3ms | 770.7ms | — |
| array/find | 693.7ms | 779.1ms | 677.0ms |
| dom/create-elements | 482.8ms | — | — |
| dom/set-attributes | 582.9ms | — | — |
| dom/read-attributes | 541.7ms | — | — |
| dom/modify-text | 555.7ms | — | — |
| mixed/csv-parse | 686.3ms | 822.1ms | — |
| mixed/text-search | 657.7ms | 832.5ms | — |
| mixed/fibonacci | 621.1ms | 684.2ms | 638.9ms |
| mixed/matrix-multiply | 714.8ms | 743.7ms | 653.5ms |
| mixed/sieve | 657.1ms | 721.2ms | — |
