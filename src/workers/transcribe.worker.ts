/// <reference lib="webworker" />

import type { TranscriptLanguage, TranscriptWord } from "@/types/audio";
import type { TranscriptionPreprocess } from "@/types/audio";
import { createAdaptiveLanguageSegments, mergeSegmentWords } from "@/lib/transcript";
import { preprocessTranscriptionAudio } from "@/lib/transcriptionAudio";

type PipelineResult = {
  text?: string;
  chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
};

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<PipelineResult>;

type TransformersModule = {
  env: {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
    backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } };
  };
  pipeline: (
    task: string,
    model: string,
    options: Record<string, unknown>,
  ) => Promise<Transcriber>;
};

let transcriber: Transcriber | null = null;
let cachedAudio: Float32Array | null = null;
let cachedPreprocess: TranscriptionPreprocess | null = null;
let transcribing = false;

self.onmessage = async ({ data }: MessageEvent<{ audio?: Float32Array; language: TranscriptLanguage; preprocess?: TranscriptionPreprocess }>) => {
  if (data.audio) cachedAudio = data.audio;
  if (data.preprocess) cachedPreprocess = data.preprocess;
  if (!cachedAudio) {
    self.postMessage({ type: "error", error: "Reload the recording before starting transcription." });
    return;
  }
  if (transcribing) return;
  transcribing = true;
  try {
    if (cachedPreprocess?.enabled) {
      self.postMessage({ type: "status", status: "Subtracting learned noise before transcription…", progress: 0.02 });
      preprocessTranscriptionAudio(cachedAudio, cachedPreprocess, (progress) => {
        self.postMessage({ type: "status", status: "Cleaning speech for Whisper…", progress: 0.02 + progress * 0.18 });
      });
    }
    self.postMessage({ type: "status", status: "Loading local Whisper model…", progress: 0.21 });
    if (!transcriber) {
      // Use the package's declared standalone CDN build. The +esm and
      // transformers.web.js entries leave bare ONNX imports in Safari workers.
      const moduleUrl = "/runtime/ml-kernel-v3.js";
      const transformers = (await import(/* webpackIgnore: true */ moduleUrl)) as TransformersModule;
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
      transformers.env.backends.onnx.wasm.wasmPaths = "/runtime/";
      // One inference thread avoids SharedArrayBuffer requirements and is more
      // stable under iPad Safari's memory pressure than a threaded WASM pool.
      transformers.env.backends.onnx.wasm.numThreads = 1;
      transcriber = await transformers.pipeline(
        "automatic-speech-recognition",
        "onnx-community/whisper-tiny_timestamped",
        {
          dtype: "q8",
          device: "wasm",
          revision: "517244293732ee2d58139af5814231b7e6830a0d",
          progress_callback: (item: { progress?: number; status?: string }) => {
            if (typeof item.progress === "number") {
              self.postMessage({
                type: "status",
                status: "Downloading Whisper model…",
                progress: Math.min(0.6, 0.21 + item.progress / 100 * 0.39),
              });
            }
          },
        },
      );
    }

    self.postMessage({ type: "status", status: "Transcribing on this device…", progress: 0.62 });
    const languageNames: Record<Exclude<TranscriptLanguage, "auto">, string> = {
      en: "english",
      hi: "hindi",
      mr: "marathi",
    };
    let words: TranscriptWord[] = [];
    let text = "";
    if (data.language === "auto") {
      const sampleRate = cachedPreprocess?.sampleRate ?? 16_000;
      const segments = createAdaptiveLanguageSegments(cachedAudio.length, sampleRate);
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        self.postMessage({
          type: "status",
          status: `Adaptive English · Hindi · Marathi scan ${index + 1}/${segments.length}…`,
          progress: 0.62 + index / Math.max(1, segments.length) * 0.36,
        });
        const segmentAudio = cachedAudio.slice(segment.startSample, segment.endSample);
        const result = await transcriber(segmentAudio, {
          return_timestamps: "word",
          task: "transcribe",
          top_k: 0,
          do_sample: false,
          condition_on_prev_tokens: false,
        });
        words = mergeSegmentWords(words, result.chunks ?? [], segment);
        text += result.text ?? "";
      }
    } else {
      const result = await transcriber(cachedAudio, {
        return_timestamps: "word",
        chunk_length_s: 29,
        stride_length_s: 5,
        task: "transcribe",
        language: languageNames[data.language],
      });
      words = (result.chunks ?? []).flatMap((chunk) => {
        const [start, rawEnd] = chunk.timestamp;
        const end = rawEnd ?? start;
        return Number.isFinite(start) ? [{ text: chunk.text, start, end }] : [];
      });
      text = result.text ?? "";
    }
    cachedAudio = null;
    cachedPreprocess = null;
    self.postMessage({ type: "complete", text, words });
  } catch (cause) {
    cachedAudio = null;
    cachedPreprocess = null;
    self.postMessage({
      type: "error",
      error: cause instanceof Error ? cause.message : "Local transcription could not start.",
    });
  } finally {
    transcribing = false;
  }
};

export {};
