# js2wasm Benchmark Results

Date: 2026-08-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.051ms | 0.035ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.107ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.423ms | 4.99ms | 0.449ms | FAILED | js |
| string/replace | 0.113ms | 0.320ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.246ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.940ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.286ms | 0.560ms | gc-native |
| array/push-pop | 1.39ms | 0.505ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.794ms | 0.309ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.126ms | 0.067ms | 0.067ms | FAILED | host-call |
| array/reduce | 1.33ms | 0.507ms | 0.508ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.478ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.487ms | 7.35ms | 0.320ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.48ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.235ms | 0.235ms | 0.250ms | js |
| mixed/matrix-multiply | 0.157ms | 0.210ms | 0.209ms | 0.718ms | js |
| mixed/sieve | 1.54ms | 1.39ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.02 | 5.07 | 3.54 | — |
| string/concat-long | 1000 | 3.53 | 4.45 | 3.52 | — |
| string/indexOf | 1000 | 19.16 | 64.08 | 12.41 | 22.23 |
| string/includes | 1000 | 19.21 | 106.86 | 14.56 | 15.42 |
| string/split | 10000 | 42.35 | 498.52 | 44.90 | — |
| string/replace | 1000 | 113.19 | 319.85 | 71.14 | — |
| string/case-convert | 2000 | 27.81 | 123.23 | 2.48 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.96 | 94.00 | 18.70 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.86 | 14.32 | 27.99 |
| array/map-filter | 30000 | 4.19 | 2.23 | 2.24 | — |
| array/indexOf | 1000 | 3948.99 | 2637.56 | 2637.36 | — |
| dom/create-elements | 2000 | 17.32 | 76.16 | — | — |
| dom/set-attributes | 6000 | 17.21 | 79.61 | — | — |
| dom/read-attributes | 3000 | 18.26 | 40.68 | — | — |
| dom/modify-text | 2000 | 14.27 | 54.43 | — | — |
| mixed/csv-parse | 11000 | 44.29 | 668.36 | 29.09 | — |
| mixed/text-search | 40000 | 9.74 | 36.88 | 6.64 | 27.23 |
| mixed/fibonacci | 10000 | 12.18 | 23.48 | 23.50 | 24.96 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.68 | 1.67 | 5.75 |
| mixed/sieve | 200000 | 7.70 | 6.95 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.68x slower | 1.17x slower | — |
| string/concat-long | 1.26x slower | 1.00x faster | — |
| string/indexOf | 3.34x slower | 1.54x faster | 1.16x slower |
| string/includes | 5.56x slower | 1.32x faster | 1.25x faster |
| string/split | 11.77x slower | 1.06x slower | — |
| string/replace | 2.83x slower | 1.59x faster | — |
| string/case-convert | 4.43x slower | 11.21x faster | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 5.54x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.40x faster | 1.39x slower |
| array/push-pop | 2.75x faster | 2.75x faster | — |
| array/sort-i32 | 2.57x faster | 2.65x faster | — |
| array/map-filter | 1.88x faster | 1.87x faster | — |
| array/reduce | 2.62x faster | 2.61x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.72x faster | — |
| array/find | 16.26x faster | 15.90x faster | 4.25x slower |
| dom/create-elements | 4.40x slower | — | — |
| dom/set-attributes | 4.63x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 3.81x slower | — | — |
| mixed/csv-parse | 15.09x slower | 1.52x faster | — |
| mixed/text-search | 3.79x slower | 1.47x faster | 2.80x slower |
| mixed/fibonacci | 1.93x slower | 1.93x slower | 2.05x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.58x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.43x faster |
| string/concat-long | 1.26x faster |
| string/indexOf | 5.16x faster |
| string/includes | 7.34x faster |
| string/split | 11.10x faster |
| string/replace | 4.50x faster |
| string/case-convert | 49.68x faster |
| string/substring | 1.22x faster |
| string/trim | 5.03x faster |
| string/startsWith-endsWith | 1.25x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 22.98x faster |
| mixed/text-search | 5.56x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1281.3ms | 1113.1ms | — |
| string/concat-long | 624.9ms | 958.9ms | — |
| string/indexOf | 784.8ms | 964.3ms | 812.7ms |
| string/includes | 760.4ms | 978.6ms | 824.5ms |
| string/split | 744.2ms | 993.5ms | — |
| string/replace | 806.8ms | 1025.1ms | — |
| string/case-convert | 775.7ms | 805.4ms | — |
| string/substring | 624.3ms | 688.2ms | — |
| string/trim | 713.4ms | 937.4ms | — |
| string/startsWith-endsWith | 719.1ms | 1003.5ms | 884.4ms |
| array/push-pop | 770.5ms | 814.0ms | — |
| array/sort-i32 | 923.1ms | 1006.8ms | — |
| array/map-filter | 931.7ms | 1013.9ms | — |
| array/reduce | 819.4ms | 888.3ms | — |
| array/indexOf | 902.2ms | 970.0ms | — |
| array/slice | 773.7ms | 834.3ms | — |
| array/reverse | 781.0ms | 830.6ms | — |
| array/forEach | 862.1ms | 954.0ms | — |
| array/find | 738.8ms | 805.6ms | 841.6ms |
| dom/create-elements | 617.2ms | — | — |
| dom/set-attributes | 711.2ms | — | — |
| dom/read-attributes | 682.5ms | — | — |
| dom/modify-text | 613.1ms | — | — |
| mixed/csv-parse | 788.5ms | 979.5ms | — |
| mixed/text-search | 767.5ms | 1037.5ms | 888.7ms |
| mixed/fibonacci | 798.2ms | 894.8ms | 781.5ms |
| mixed/matrix-multiply | 859.5ms | 924.5ms | 786.2ms |
| mixed/sieve | 832.1ms | 882.0ms | — |
