/// <reference lib="webworker" />

import type { TranscriptWord } from "@/types/audio";

type PipelineResult = {
  text?: string;
  chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
};

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<PipelineResult>;

type TransformersModule = {
  env: { allowLocalModels: boolean; useBrowserCache: boolean };
  pipeline: (
    task: string,
    model: string,
    options: Record<string, unknown>,
  ) => Promise<Transcriber>;
};

let transcriber: Transcriber | null = null;

self.onmessage = async ({ data }: MessageEvent<{ audio: Float32Array }>) => {
  try {
    self.postMessage({ type: "status", status: "Loading local Whisper model…", progress: 0.03 });
    if (!transcriber) {
      const moduleUrl = "/runtime/ml-kernel.js";
      const transformers = (await import(/* webpackIgnore: true */ moduleUrl)) as TransformersModule;
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
      transcriber = await transformers.pipeline(
        "automatic-speech-recognition",
        "onnx-community/whisper-tiny.en_timestamped",
        {
          dtype: "q8",
          device: "wasm",
          progress_callback: (item: { progress?: number; status?: string }) => {
            if (typeof item.progress === "number") {
              self.postMessage({
                type: "status",
                status: "Downloading Whisper model…",
                progress: Math.min(0.65, item.progress / 100 * 0.65),
              });
            }
          },
        },
      );
    }

    self.postMessage({ type: "status", status: "Transcribing on this device…", progress: 0.7 });
    const result = await transcriber(data.audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      language: "en",
      task: "transcribe",
    });
    const words: TranscriptWord[] = (result.chunks ?? []).flatMap((chunk) => {
      const [start, rawEnd] = chunk.timestamp;
      const end = rawEnd ?? start;
      return Number.isFinite(start) ? [{ text: chunk.text, start, end }] : [];
    });
    self.postMessage({ type: "complete", text: result.text ?? "", words });
  } catch (cause) {
    self.postMessage({
      type: "error",
      error: cause instanceof Error ? cause.message : "Local transcription could not start.",
    });
  }
};

export {};
