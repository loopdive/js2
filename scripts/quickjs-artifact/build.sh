#!/usr/bin/env bash
#
# build.sh — produce the QuickJS "boxed tier" wasm artifact for #4236.
#
# Output (into $OUT_DIR, default .tmp/quickjs-artifact):
#   libquickjs.wasm  standalone wasm32-wasip1 reactor module. Imports ONLY
#                    wasi_snapshot_preview1.*; exports its linear memory,
#                    malloc/free and the qjs_* wrapper ABI (see qjs_shim.c).
#   qjs-abi.json     the tag/encoding constants READ OUT OF that module, so the
#                    compiler never hardcodes QuickJS-internal layouts.
#   build-info.json  pinned source revisions, flags, sizes, sha256.
#
# Requirements: clang >= 17 with a wasm32 target, wasm-ld, llvm-ar, curl, node,
# cmake, git. No wasi-sdk install needed — the sysroot is built from wasi-libc
# source and the wasm32 compiler-rt builtins are fetched from a wasi-sdk
# release (Ubuntu's clang ships no wasm32 builtins).
#
# Everything network-fetched is PINNED by sha below.
set -euo pipefail

QUICKJS_NG_REF="${QUICKJS_NG_REF:-954dc53628e36891f93c359aa60895c2ae3dac6b}"  # quickjs-ng v0.16.1
WASI_LIBC_REF="${WASI_LIBC_REF:-8d8348ec24253d0638a693b8af82445c13d92d32}"
BUILTINS_URL="${BUILTINS_URL:-https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34-rc.1/libclang_rt-34.0-rc.1.tar.gz}"
TARGET_TRIPLE="${TARGET_TRIPLE:-wasm32-wasip1}"

# -O2 is the default on purpose. -Oz cuts the artifact from ~1.01 MB to
# ~626 KB (348 KB -> 261 KB gzip) but costs ~23% on both eval throughput and
# per-property-op cost (measured, #4236 slice 1). The boxed tier is the tier
# that runs the code we could NOT compile, so speed wins by default; set
# OPT=-Oz if you are optimising for download size.
OPT="${OPT:--O2}"
CC="${CC:-clang-18}"
AR="${AR:-llvm-ar-18}"
RANLIB="${RANLIB:-llvm-ranlib-18}"
NM="${NM:-llvm-nm-18}"
JOBS="${JOBS:-$( (nproc 2>/dev/null) || sysctl -n hw.ncpu 2>/dev/null || echo 4 )}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-$REPO_ROOT/.tmp/quickjs-artifact-build}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/.tmp/quickjs-artifact}"

mkdir -p "$WORK" "$OUT_DIR"

say() { printf '\n=== %s\n' "$*"; }

# --------------------------------------------------------------- 1. sources --
fetch_pinned() {
  local url="$1" dest="$2" ref="$3"
  if [ ! -d "$dest/.git" ]; then
    say "clone $url"
    GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none "$url" "$dest"
  fi
  git -C "$dest" fetch --depth 1 origin "$ref" 2>/dev/null || git -C "$dest" fetch origin
  git -C "$dest" checkout --detach "$ref"
}

fetch_pinned https://github.com/quickjs-ng/quickjs "$WORK/quickjs-ng" "$QUICKJS_NG_REF"
fetch_pinned https://github.com/WebAssembly/wasi-libc "$WORK/wasi-libc" "$WASI_LIBC_REF"

# ------------------------------------------------ 2. compiler-rt builtins ----
BUILTINS_DIR="$WORK/builtins"
if [ -z "$(find "$BUILTINS_DIR" -name 'libclang_rt.builtins.a' 2>/dev/null | head -1)" ]; then
  say "fetch wasm32 compiler-rt builtins"
  mkdir -p "$BUILTINS_DIR"
  curl -sSL --max-time 600 "$BUILTINS_URL" -o "$BUILTINS_DIR/builtins.tar.gz"
  tar -xzf "$BUILTINS_DIR/builtins.tar.gz" -C "$BUILTINS_DIR"
fi
BUILTINS_LIB="$(find "$BUILTINS_DIR" -name 'libclang_rt.builtins.a' -path "*${TARGET_TRIPLE#wasm32-}*" \
                 | grep -v threads | head -1)"
[ -n "$BUILTINS_LIB" ] || { echo "no wasm32 builtins found under $BUILTINS_DIR" >&2; exit 1; }

# clang looks for <resource-dir>/lib/<os>/libclang_rt.builtins-wasm32.a and will
# hard-fail the link without it. Ubuntu's clang ships no wasm32 builtins, so
# stage a resource dir that has them (include/ is symlinked to the real one so
# stddef.h etc. still resolve). This is the one step wasi-sdk would hide.
RESOURCE_DIR="$WORK/resource-dir"
mkdir -p "$RESOURCE_DIR/lib/${TARGET_TRIPLE#wasm32-}"
cp "$BUILTINS_LIB" "$RESOURCE_DIR/lib/${TARGET_TRIPLE#wasm32-}/libclang_rt.builtins-wasm32.a"
rm -f "$RESOURCE_DIR/include"
ln -sfn "$("$CC" -print-resource-dir)/include" "$RESOURCE_DIR/include"

# ------------------------------------------------------------ 3. sysroot -----
SYSROOT="$WORK/sysroot"
if [ ! -f "$SYSROOT/lib/$TARGET_TRIPLE/libc.a" ]; then
  say "build wasi-libc sysroot ($TARGET_TRIPLE)"
  cmake -S "$WORK/wasi-libc" -B "$WORK/build-wasi-libc" \
    -DCMAKE_C_COMPILER="$(command -v "$CC")" \
    -DCMAKE_AR="$(command -v "$AR")" \
    -DCMAKE_RANLIB="$(command -v "$RANLIB")" \
    -DCMAKE_NM="$(command -v "$NM")" \
    -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
    -DTARGET_TRIPLE="$TARGET_TRIPLE" \
    -DMALLOC=dlmalloc \
    -DBUILD_TESTS=OFF \
    -DBUILD_SHARED=OFF \
    -DBUILTINS_LIB="$BUILTINS_LIB"
  cmake --build "$WORK/build-wasi-libc" -j"$JOBS"
  cmake --install "$WORK/build-wasi-libc"
fi

# --------------------------------------------------- 4. quickjs core objects -
QJS="$WORK/quickjs-ng"
OBJ="$WORK/obj"
mkdir -p "$OBJ"

# quickjs-ng's own WASI knobs: no signals, no real process clocks, no threads.
# QuickJS core does NOT use setjmp for exceptions (it returns JS_EXCEPTION
# sentinels), so no libsetjmp / Asyncify is needed.
CFLAGS=(
  --target="$TARGET_TRIPLE"
  --sysroot="$SYSROOT"
  -resource-dir "$RESOURCE_DIR"
  "$OPT" -ffunction-sections -fdata-sections
  -fno-strict-aliasing -funsigned-char
  -D_GNU_SOURCE
  -D_WASI_EMULATED_PROCESS_CLOCKS
  -D_WASI_EMULATED_SIGNAL
  -DNDEBUG
  -I"$QJS"
  -Wno-implicit-fallthrough -Wno-sign-compare -Wno-unused-parameter
  -Wno-unused-but-set-variable -Wno-unused-result -Wno-array-bounds
)

say "compile quickjs core + shim"
for f in dtoa libregexp libunicode quickjs; do
  "$CC" "${CFLAGS[@]}" -c "$QJS/$f.c" -o "$OBJ/$f.o"
done
"$CC" "${CFLAGS[@]}" -c "$HERE/qjs_shim.c" -o "$OBJ/qjs_shim.o"
"$AR" rcs "$OBJ/libquickjs.a" "$OBJ/dtoa.o" "$OBJ/libregexp.o" "$OBJ/libunicode.o" "$OBJ/quickjs.o"

# ----------------------------------------------------------------- 5. link --
# -mexec-model=reactor: no _start, an _initialize the peer/host calls once.
# Memory is EXPORTED (wasm-ld default) — this module owns the shared heap and
# the js2wasm peer imports it; see qjs_shim.c ABI note 4.
# --export-table/--growable-table: the #4245 membrane's inward property traps
# call the GC adapter through THIS module's __indirect_function_table. The
# harness grows it once at link time and stores the adapter's exported
# functions into the fresh slots, so the trap edge is a wasm `call_indirect`,
# not a JS closure — the artifact still imports ONLY wasi_snapshot_preview1.
say "link libquickjs.wasm"
"$CC" "${CFLAGS[@]}" \
  -mexec-model=reactor \
  -Wl,--export=malloc \
  -Wl,--export=free \
  -Wl,--export=realloc \
  -Wl,--export=calloc \
  -Wl,--export-memory \
  -Wl,--export-table \
  -Wl,--growable-table \
  -Wl,--initial-memory=16777216 \
  -Wl,--max-memory=1073741824 \
  -Wl,--stack-first \
  -Wl,--gc-sections \
  -Wl,--strip-all \
  -lwasi-emulated-process-clocks \
  -lwasi-emulated-signal \
  -o "$OUT_DIR/libquickjs.wasm" \
  "$OBJ/qjs_shim.o" "$OBJ/libquickjs.a"

# ------------------------------------- 6. read the ABI OUT of the artifact ---
say "extract ABI constants from the built module"
node "$HERE/extract-abi.mjs" "$OUT_DIR/libquickjs.wasm" > "$OUT_DIR/qjs-abi.json"

SHA="$(sha256sum "$OUT_DIR/libquickjs.wasm" | cut -d' ' -f1)"
# portable file size: GNU coreutils `stat -c%s`, BSD/macOS `stat -f%z`
RAW="$(stat -c%s "$OUT_DIR/libquickjs.wasm" 2>/dev/null || stat -f%z "$OUT_DIR/libquickjs.wasm")"
GZ="$(gzip -9 -c "$OUT_DIR/libquickjs.wasm" | wc -c)"

cat > "$OUT_DIR/build-info.json" <<EOF
{
  "quickjs_ng_ref": "$QUICKJS_NG_REF",
  "wasi_libc_ref": "$WASI_LIBC_REF",
  "builtins_url": "$BUILTINS_URL",
  "target_triple": "$TARGET_TRIPLE",
  "compiler": "$("$CC" --version | head -1)",
  "raw_bytes": $RAW,
  "gzip_bytes": $GZ,
  "sha256": "$SHA"
}
EOF

say "done"
cat "$OUT_DIR/build-info.json"
