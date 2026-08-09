/// <reference lib="webworker" />

import type { TranscriptLanguage, TranscriptWord } from "@/types/audio";

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
let cachedAudio: Float32Array | null = null;
let transcribing = false;

self.onmessage = async ({ data }: MessageEvent<{ audio?: Float32Array; language: TranscriptLanguage }>) => {
  if (data.audio) cachedAudio = data.audio;
  if (!cachedAudio) {
    self.postMessage({ type: "error", error: "Reload the recording before starting transcription." });
    return;
  }
  if (transcribing) return;
  transcribing = true;
  try {
    self.postMessage({ type: "status", status: "Loading local Whisper model…", progress: 0.03 });
    if (!transcriber) {
      // Use the package's declared standalone CDN build. The +esm and
      // transformers.web.js entries leave bare ONNX imports in Safari workers.
      const moduleUrl = "/runtime/ml-kernel-v3.js";
      const transformers = (await import(/* webpackIgnore: true */ moduleUrl)) as TransformersModule;
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
      transcriber = await transformers.pipeline(
        "automatic-speech-recognition",
        "onnx-community/whisper-tiny_timestamped",
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
    const languageNames: Record<Exclude<TranscriptLanguage, "auto">, string> = {
      en: "english",
      hi: "hindi",
      mr: "marathi",
    };
    const languageOptions = data.language === "auto" ? {} : { language: languageNames[data.language] };
    const result = await transcriber(cachedAudio, {
      return_timestamps: "word",
      chunk_length_s: 29,
      stride_length_s: 5,
      task: "transcribe",
      ...languageOptions,
    });
    const words: TranscriptWord[] = (result.chunks ?? []).flatMap((chunk) => {
      const [start, rawEnd] = chunk.timestamp;
      const end = rawEnd ?? start;
      return Number.isFinite(start) ? [{ text: chunk.text, start, end }] : [];
    });
    cachedAudio = null;
    self.postMessage({ type: "complete", text: result.text ?? "", words });
  } catch (cause) {
    cachedAudio = null;
    self.postMessage({
      type: "error",
      error: cause instanceof Error ? cause.message : "Local transcription could not start.",
    });
  } finally {
    transcribing = false;
  }
};

export {};
