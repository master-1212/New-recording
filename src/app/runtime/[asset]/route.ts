const assets: Record<string, string> = {
  "kernel.js": "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/+esm",
  "processor.js": "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/rnnoiseWorklet.js",
  "core.wasm": "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/rnnoise.wasm",
  "core-simd.wasm": "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/rnnoise_simd.wasm",
  "ml-kernel-v3.js": "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js",
};

export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  const { asset } = await context.params;
  const source = assets[asset];
  if (!source) return new Response("Not found", { status: 404 });

  const upstream = await fetch(source, { cache: "force-cache" });
  if (!upstream.ok) return new Response("Runtime asset unavailable", { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
