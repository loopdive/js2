# js2wasm Benchmark Results

Date: 2026-08-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.034ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.003ms | 0.005ms | FAILED | js |
| string/indexOf | 0.014ms | 0.054ms | 0.016ms | FAILED | js |
| string/includes | 0.013ms | 0.096ms | 0.016ms | FAILED | js |
| string/split | 0.288ms | 4.08ms | 0.349ms | FAILED | js |
| string/replace | 0.078ms | 0.228ms | 0.055ms | FAILED | gc-native |
| string/case-convert | 0.041ms | 0.178ms | 0.090ms | FAILED | js |
| string/substring | 0.088ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.131ms | 0.718ms | 0.181ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 1.78ms | 0.218ms | FAILED | gc-native |
| array/push-pop | 1.16ms | 0.369ms | 0.353ms | FAILED | gc-native |
| array/sort-i32 | 0.544ms | 0.286ms | 0.286ms | FAILED | host-call |
| array/map-filter | 0.057ms | 0.494ms | 0.483ms | FAILED | js |
| array/reduce | 1.08ms | 0.369ms | 0.352ms | FAILED | gc-native |
| array/indexOf | 4.49ms | 4.19ms | 4.20ms | FAILED | host-call |
| array/slice | 0.016ms | 0.017ms | 0.016ms | FAILED | gc-native |
| array/reverse | 7.05ms | 3.17ms | 3.17ms | FAILED | gc-native |
| array/forEach | 0.040ms | 0.019ms | 0.022ms | FAILED | host-call |
| array/find | 0.240ms | 0.012ms | 0.012ms | 0.817ms | gc-native |
| dom/create-elements | 0.032ms | 0.216ms | — | — | js |
| dom/set-attributes | 0.088ms | 0.265ms | — | — | js |
| dom/read-attributes | 0.038ms | 0.122ms | — | — | js |
| dom/modify-text | 0.047ms | 0.117ms | — | — | js |
| mixed/csv-parse | 0.330ms | 6.07ms | 0.727ms | FAILED | js |
| mixed/text-search | 0.368ms | 1.76ms | 0.306ms | FAILED | gc-native |
| mixed/fibonacci | 0.113ms | 0.036ms | 0.036ms | 0.037ms | gc-native |
| mixed/matrix-multiply | 0.160ms | 0.144ms | 0.144ms | 0.601ms | gc-native |
| mixed/sieve | 1.38ms | 1.35ms | 1.36ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
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
| string/concat-short | 10000 | 3.12 | 3.35 | 3.85 | — |
| string/concat-long | 1000 | 2.66 | 3.22 | 4.54 | — |
| string/indexOf | 1000 | 13.52 | 54.21 | 16.10 | — |
| string/includes | 1000 | 13.36 | 95.75 | 16.11 | — |
| string/split | 10000 | 28.79 | 407.84 | 34.93 | — |
| string/replace | 1000 | 77.78 | 228.13 | 55.34 | — |
| string/case-convert | 2000 | 20.27 | 89.05 | 45.10 | — |
| string/substring | 10000 | 8.82 | 3.17 | 2.71 | — |
| string/trim | 10000 | 13.08 | 71.82 | 18.08 | — |
| string/startsWith-endsWith | 20000 | 20.15 | 88.98 | 10.90 | — |
| array/map-filter | 30000 | 1.91 | 16.47 | 16.09 | — |
| array/indexOf | 1000 | 4494.58 | 4189.29 | 4203.85 | — |
| dom/create-elements | 2000 | 16.24 | 108.08 | — | — |
| dom/set-attributes | 6000 | 14.60 | 44.21 | — | — |
| dom/read-attributes | 3000 | 12.79 | 40.76 | — | — |
| dom/modify-text | 2000 | 23.70 | 58.38 | — | — |
| mixed/csv-parse | 11000 | 30.00 | 551.91 | 66.06 | — |
| mixed/text-search | 40000 | 9.20 | 43.96 | 7.65 | — |
| mixed/fibonacci | 10000 | 11.33 | 3.64 | 3.63 | 3.65 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.15 | 1.15 | 4.81 |
| mixed/sieve | 200000 | 6.92 | 6.76 | 6.79 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x slower | 1.23x slower | — |
| string/concat-long | 1.21x slower | 1.71x slower | — |
| string/indexOf | 4.01x slower | 1.19x slower | — |
| string/includes | 7.17x slower | 1.21x slower | — |
| string/split | 14.17x slower | 1.21x slower | — |
| string/replace | 2.93x slower | 1.41x faster | — |
| string/case-convert | 4.39x slower | 2.22x slower | — |
| string/substring | 2.78x faster | 3.26x faster | — |
| string/trim | 5.49x slower | 1.38x slower | — |
| string/startsWith-endsWith | 4.42x slower | 1.85x faster | — |
| array/push-pop | 3.15x faster | 3.30x faster | — |
| array/sort-i32 | 1.90x faster | 1.90x faster | — |
| array/map-filter | 8.64x slower | 8.44x slower | — |
| array/reduce | 2.93x faster | 3.07x faster | — |
| array/indexOf | 1.07x faster | 1.07x faster | — |
| array/slice | 1.05x slower | 1.02x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.17x faster | 1.83x faster | — |
| array/find | 19.62x faster | 19.82x faster | 3.40x slower |
| dom/create-elements | 6.66x slower | — | — |
| dom/set-attributes | 3.03x slower | — | — |
| dom/read-attributes | 3.19x slower | — | — |
| dom/modify-text | 2.46x slower | — | — |
| mixed/csv-parse | 18.40x slower | 2.20x slower | — |
| mixed/text-search | 4.78x slower | 1.20x faster | — |
| mixed/fibonacci | 3.12x faster | 3.12x faster | 3.10x faster |
| mixed/matrix-multiply | 1.11x faster | 1.11x faster | 3.76x slower |
| mixed/sieve | 1.02x faster | 1.02x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x slower |
| string/concat-long | 1.41x slower |
| string/indexOf | 3.37x faster |
| string/includes | 5.94x faster |
| string/split | 11.68x faster |
| string/replace | 4.12x faster |
| string/case-convert | 1.97x faster |
| string/substring | 1.17x faster |
| string/trim | 3.97x faster |
| string/startsWith-endsWith | 8.16x faster |
| array/push-pop | 1.05x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.02x faster |
| array/reduce | 1.05x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.07x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.18x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 8.35x faster |
| mixed/text-search | 5.75x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.0KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.8KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 960.4ms | 877.1ms | — |
| string/concat-long | 489.7ms | 752.9ms | — |
| string/indexOf | 604.1ms | 809.4ms | — |
| string/includes | 597.6ms | 801.5ms | — |
| string/split | 599.7ms | 770.9ms | — |
| string/replace | 651.5ms | 873.9ms | — |
| string/case-convert | 635.0ms | 875.5ms | — |
| string/substring | 498.9ms | 584.5ms | — |
| string/trim | 585.7ms | 824.3ms | — |
| string/startsWith-endsWith | 604.7ms | 804.3ms | — |
| array/push-pop | 633.7ms | 675.1ms | — |
| array/sort-i32 | 752.3ms | 806.3ms | — |
| array/map-filter | 723.7ms | 793.4ms | — |
| array/reduce | 678.8ms | 723.0ms | — |
| array/indexOf | 675.2ms | 720.4ms | — |
| array/slice | 618.8ms | 656.1ms | — |
| array/reverse | 615.1ms | 655.3ms | — |
| array/forEach | 698.3ms | 731.4ms | — |
| array/find | 582.3ms | 641.5ms | 652.1ms |
| dom/create-elements | 463.8ms | — | — |
| dom/set-attributes | 548.5ms | — | — |
| dom/read-attributes | 546.2ms | — | — |
| dom/modify-text | 529.0ms | — | — |
| mixed/csv-parse | 635.4ms | 833.2ms | — |
| mixed/text-search | 596.8ms | 803.5ms | — |
| mixed/fibonacci | 608.3ms | 631.3ms | 572.5ms |
| mixed/matrix-multiply | 682.9ms | 709.0ms | 630.9ms |
| mixed/sieve | 663.6ms | 692.8ms | — |
