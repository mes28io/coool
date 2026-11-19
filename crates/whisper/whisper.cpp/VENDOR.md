# Vendored whisper.cpp

- Upstream: https://github.com/ggml-org/whisper.cpp, tag `v1.8.3` (ggml 0.9.5).
- Source: the release tarball `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.8.3.tar.gz`
  (sha256 `870ba21409cdf66697dc4db15ebdb13bc67037d76c7cc63756c81471d8f1731a`), files copied unmodified.
- License: MIT (`LICENSE` in this folder, © The ggml authors).

Only the files coool compiles are kept: `src/whisper.cpp`, the public headers, ggml's core, its CPU backend (with the
Arm kernels and the AMX stubs it includes) and its Metal backend. CMake files, examples, bindings, the CUDA / Vulkan /
other backends and all models are left out. `../build.rs` builds these with the `cc` crate, so no CMake is needed:
Accelerate + the CPU backend everywhere, plus the Metal backend (its shaders embedded in the binary) on Apple silicon.

To update: download the new tag's tarball, check its sha256, copy the same files over (the list is what `build.rs`
names), then run `cargo test -p coool-whisper` and the `voice` self-test before committing.
