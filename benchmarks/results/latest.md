# js2wasm Benchmark Results

Date: 2026-08-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.047ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.411ms | 5.29ms | 0.448ms | FAILED | js |
| string/replace | 0.110ms | 0.319ms | 0.073ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.230ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.888ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 0.357ms | 0.287ms | 0.565ms | gc-native |
| array/push-pop | 1.45ms | 0.519ms | 0.518ms | FAILED | gc-native |
| array/sort-i32 | 0.797ms | 0.302ms | 0.302ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.073ms | 0.074ms | FAILED | host-call |
| array/reduce | 1.40ms | 0.510ms | 0.516ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.050ms | 0.031ms | 0.030ms | FAILED | gc-native |
| array/find | 0.261ms | 0.017ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.037ms | 0.160ms | — | — | js |
| dom/set-attributes | 0.118ms | 0.530ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.122ms | — | — | js |
| dom/modify-text | 0.033ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.482ms | 7.41ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.57ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.235ms | 0.235ms | 1.17ms | js |
| mixed/matrix-multiply | 0.162ms | 0.238ms | 0.227ms | 0.721ms | js |
| mixed/sieve | 1.59ms | 1.44ms | 1.41ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.12 | 4.53 | 3.79 | — |
| string/concat-long | 1000 | 3.55 | 4.49 | 3.76 | — |
| string/indexOf | 1000 | 19.18 | 64.22 | 12.42 | 14.91 |
| string/includes | 1000 | 19.18 | 47.48 | 14.75 | 15.42 |
| string/split | 10000 | 41.15 | 528.99 | 44.85 | — |
| string/replace | 1000 | 110.39 | 318.90 | 73.10 | — |
| string/case-convert | 2000 | 27.85 | 115.22 | 2.51 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.96 | 88.78 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.14 | 17.83 | 14.35 | 28.23 |
| array/map-filter | 30000 | 4.33 | 2.43 | 2.46 | — |
| array/indexOf | 1000 | 3958.00 | 2640.18 | 2638.26 | — |
| dom/create-elements | 2000 | 18.65 | 79.92 | — | — |
| dom/set-attributes | 6000 | 19.69 | 88.27 | — | — |
| dom/read-attributes | 3000 | 19.09 | 40.71 | — | — |
| dom/modify-text | 2000 | 16.44 | 52.76 | — | — |
| mixed/csv-parse | 11000 | 43.86 | 673.57 | 28.52 | — |
| mixed/text-search | 40000 | 9.74 | 39.19 | 6.65 | 27.23 |
| mixed/fibonacci | 10000 | 12.19 | 23.46 | 23.50 | 117.40 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.91 | 1.82 | 5.77 |
| mixed/sieve | 200000 | 7.94 | 7.22 | 7.05 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.21x slower | — |
| string/concat-long | 1.26x slower | 1.06x slower | — |
| string/indexOf | 3.35x slower | 1.54x faster | 1.29x faster |
| string/includes | 2.47x slower | 1.30x faster | 1.24x faster |
| string/split | 12.86x slower | 1.09x slower | — |
| string/replace | 2.89x slower | 1.51x faster | — |
| string/case-convert | 4.14x slower | 11.09x faster | — |
| string/substring | 2.64x faster | 3.20x faster | — |
| string/trim | 5.24x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.13x faster | 1.40x faster | 1.40x slower |
| array/push-pop | 2.80x faster | 2.81x faster | — |
| array/sort-i32 | 2.64x faster | 2.64x faster | — |
| array/map-filter | 1.78x faster | 1.76x faster | — |
| array/reduce | 2.75x faster | 2.72x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.64x faster | 1.66x faster | — |
| array/find | 15.71x faster | 15.93x faster | 4.13x slower |
| dom/create-elements | 4.29x slower | — | — |
| dom/set-attributes | 4.48x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.21x slower | — | — |
| mixed/csv-parse | 15.36x slower | 1.54x faster | — |
| mixed/text-search | 4.02x slower | 1.46x faster | 2.80x slower |
| mixed/fibonacci | 1.93x slower | 1.93x slower | 9.63x slower |
| mixed/matrix-multiply | 1.47x slower | 1.40x slower | 4.45x slower |
| mixed/sieve | 1.10x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.19x faster |
| string/indexOf | 5.17x faster |
| string/includes | 3.22x faster |
| string/split | 11.79x faster |
| string/replace | 4.36x faster |
| string/case-convert | 45.90x faster |
| string/substring | 1.21x faster |
| string/trim | 4.77x faster |
| string/startsWith-endsWith | 1.24x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 23.62x faster |
| mixed/text-search | 5.90x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.05x faster |
| mixed/sieve | 1.02x faster |

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
| string/concat-short | 1301.6ms | 1108.5ms | — |
| string/concat-long | 636.0ms | 973.3ms | — |
| string/indexOf | 799.4ms | 985.9ms | 857.2ms |
| string/includes | 767.2ms | 1003.6ms | 842.8ms |
| string/split | 766.0ms | 1002.1ms | — |
| string/replace | 824.4ms | 1101.4ms | — |
| string/case-convert | 867.0ms | 823.8ms | — |
| string/substring | 646.7ms | 731.5ms | — |
| string/trim | 733.5ms | 976.2ms | — |
| string/startsWith-endsWith | 737.5ms | 1023.5ms | 912.1ms |
| array/push-pop | 773.8ms | 820.8ms | — |
| array/sort-i32 | 965.3ms | 984.4ms | — |
| array/map-filter | 890.1ms | 1009.0ms | — |
| array/reduce | 834.1ms | 899.9ms | — |
| array/indexOf | 898.1ms | 971.2ms | — |
| array/slice | 760.7ms | 841.5ms | — |
| array/reverse | 744.5ms | 826.0ms | — |
| array/forEach | 866.6ms | 937.6ms | — |
| array/find | 753.5ms | 842.1ms | 835.1ms |
| dom/create-elements | 636.0ms | — | — |
| dom/set-attributes | 730.3ms | — | — |
| dom/read-attributes | 701.3ms | — | — |
| dom/modify-text | 631.8ms | — | — |
| mixed/csv-parse | 796.3ms | 1040.6ms | — |
| mixed/text-search | 817.5ms | 1017.5ms | 933.7ms |
| mixed/fibonacci | 844.6ms | 891.1ms | 849.4ms |
| mixed/matrix-multiply | 884.5ms | 952.3ms | 823.9ms |
| mixed/sieve | 871.1ms | 918.3ms | — |
