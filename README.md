# VoiceScope 3D

VoiceScope 3D is an iPad-first, private audio-analysis workstation built with Next.js, TypeScript, React Three Fiber, WebGL, Web Audio, and a Web Worker. Recordings stay in the browser.

Transport playback supports 0.5×–2× speed with pitch preservation, ±10-second navigation, looping, overview seeking, and limiter-protected master gain up to 500%.

## Architecture

- `src/hooks/useAudioEngine.ts` owns decoding, transport synchronization, the Web Audio graph, and DSP state.
- `src/workers/analyze.worker.ts` creates bounded-resolution waveform, log-frequency spectral, level, dominant-frequency, and voice-activity data off the UI thread.
- `src/components/Spectrogram3D.tsx` renders only a playback-centered spectral window on the GPU. Orbit controls provide mouse/touch rotation, pinch zoom, and pan.
- `src/components/Overview.tsx` draws both a zoomed waveform synchronized to the 3D visible window and the full-recording heatmap, waveform, VAD, and seek cursor.

## Spectrogram and performance

Audio is decoded once and mixed to mono for analysis. The worker caps the overview at 1,800 time columns and 72 logarithmic frequency bands, transferring typed-array buffers without copying. The 3D surface samples only 96 × 36 vertices around the playhead. React does not hold per-frame FFT data, and the complete spectrogram is never recomputed during playback. This tiered resolution keeps memory bounded for 30–60 minute recordings.

## Voice Enhance DSP

The enhanced branch uses an adjustable high-pass filter, low-shelf attenuation, 2.7 kHz presence EQ, soft-knee compressor, makeup gain, and the browser output limiter. A parallel dry branch makes the A/B transition immediate and click-free. The shared master stage supports 0–500% gain and feeds a fast limiter to reduce clipping at high boost. Suppression is conservative because Version 1 has no server-side neural denoiser.

## Browser compatibility

Designed for current Safari on iPad/iPhone and current Safari, Chrome, Edge, and Firefox on desktop. Codec support is supplied by the browser/OS; WAV and MP3 are the most portable. iOS requires a user gesture before audio starts. Very large compressed recordings may hit Safari's decode-memory ceiling because `decodeAudioData` does not stream.

## Local development

```bash
pnpm install
pnpm dev
```

Validation:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Vercel deployment

No backend or environment variables are required. Import the repository into Vercel or run `vercel deploy`, validate the preview, then `vercel promote <preview-url>`.

## Known limitations and roadmap

Version 1 performs voice activity detection, not identity recognition. VAD is an energy, spectral-ratio, and zero-crossing estimate and may classify music as voice. Neural enhancement, transcription, word timestamps, speaker diarization, export, spectral editing, pitch/formant/harmonic tools, and voice comparison are future capabilities and are not represented as implemented.
