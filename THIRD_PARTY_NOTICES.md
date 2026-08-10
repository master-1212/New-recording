# Third-party runtime notices

VoiceScope downloads reviewed runtime bytes during the build, verifies pinned SHA-256 digests, and serves the accepted files from `public/runtime` so production clients never execute mutable CDN code:

- `@sapphi-red/web-noise-suppressor` 0.3.5 — MIT License
- `@huggingface/transformers` 3.7.6 and its bundled ONNX Runtime Web files — Apache License 2.0

The exact source URLs and SHA-256 digests are declared in `scripts/vendor-runtime.mjs`. CI performs the same download-and-verify step before every production build. License texts are retained beside the generated runtime files.
