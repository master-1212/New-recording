# VoiceScope 3D

VoiceScope 3D is an iPad-first, private audio-analysis workstation built with Next.js, TypeScript, React Three Fiber, WebGL, Web Audio, and a Web Worker. Recordings stay in the browser.

Transport playback supports 0.5×–2× speed with pitch preservation, ±10-second navigation, looping, overview seeking, and limiter-protected master gain up to 500%.

## Architecture

- `src/hooks/useAudioEngine.ts` owns decoding, transport synchronization, the Web Audio graph, and DSP state.
- `src/workers/analyze.worker.ts` creates bounded-resolution waveform, log-frequency spectral, level, dominant-frequency, voice-activity, whisper-likelihood, acoustic voice-profile data, and a capped high-resolution noise envelope off the UI thread.
- `src/workers/transcribe.worker.ts` lazily loads Whisper in a dedicated worker and returns clickable word-level timestamps without uploading the recording.
- `src/components/Spectrogram3D.tsx` renders only a playback-centered spectral window on the GPU. Orbit controls provide mouse/touch rotation, pinch zoom, and pan.
- `src/components/Overview.tsx` draws both a zoomed waveform synchronized to the 3D visible window and the full-recording heatmap, waveform, VAD, and seek cursor. Both views use the same clamped time-range function, including near the beginning and end of a recording.

## Spectrogram and performance

Audio is decoded once and mixed to mono for analysis. The worker caps the overview at 1,800 time columns and 72 logarithmic frequency bands, transferring typed-array buffers without copying. A separate 10 Hz noise envelope is capped at 36,000 frames (about 144 KB) so five-second noise learning remains precise on long recordings. The 3D surface samples only 96 × 36 vertices around the playhead. React does not hold per-frame FFT data, and the complete spectrogram is never recomputed during playback. This tiered resolution keeps memory bounded for 30–60 minute recordings.

## Voice Enhance DSP

The enhanced branch uses an adjustable high-pass filter, low-shelf attenuation, 2.7 kHz presence EQ, soft-knee compressor, makeup gain, an adaptive learned-noise gate, and the browser output limiter. A parallel dry branch makes the A/B transition immediate and click-free. The shared master stage supports 0–500% gain and feeds a fast limiter to reduce clipping at high boost.

Speech Focus applies a strong intelligibility preset and enables a 70% RNNoise blend. RNNoise runs as a local WASM `AudioWorklet`; the slider crossfades it with the unprocessed signal. Learn Noise Profile samples an exact five-second region from the high-resolution envelope, rejects speech/whisper candidates, calculates a confidence score, and automatically enables the Enhanced/B path. The learned profile has its own Active switch and Reset control, while live feedback reports its current attenuation. Original/A remains a true unprocessed reference. Voice-only playback uses the VAD timeline to skip sustained non-speech sections.

Whisper Recovery is a separate faint-speech preset. It raises the 2.7–4.6 kHz articulation region, uses deeper controlled compression and makeup gain, limits very high-frequency hiss, reduces the learned gate's maximum attenuation, increases speech/whisper sensitivity, and keeps RNNoise moderate so breathy consonants are less likely to be removed as noise. The whisper indicator is a spectral/energy heuristic, not identity recognition or forensic proof.

## Local Whisper transcription

Whisper transcription is opt-in. The language selector supports automatic detection plus explicit English, Hindi, and Marathi modes. Explicit language selection is recommended for muffled recordings. On first use, the browser downloads the quantized multilingual `whisper-tiny_timestamped` model and caches it; inference then runs locally on 16 kHz audio in a Web Worker. Words are timestamped and can be tapped to seek, and the same loaded recording can be retranscribed in another language without decoding it again. After each run, the worker returns the downsampled audio buffer and terminates so its model memory is released—important on iPad. Audio is never sent to the CDN or model host: those services provide code/model assets only. A small same-origin Vercel route proxies and caches allowlisted runtime assets so Safari content blockers do not have to permit third-party executable files; it never accepts or transmits user audio. An internet connection is required the first time RNNoise or Whisper is enabled.

## Voice Profile Analysis

Voice Profile Analysis is an independent opt-in landscape module below the transport, not an enhancement preset and not part of the playback DSP. The bounded analysis worker estimates fundamental pitch and periodicity from speech-like time columns, smooths estimates over nearby voiced columns, and conservatively labels them as lower/masculine-range, higher/feminine-range, or overlapping/uncertain. Its touch-seekable strip uses the same visible-window calculation and cursor ratio as the 3D spectrogram and waveform detail, while also providing a live estimate, confidence, and whole-recording proportions. All calculation remains local.

This is an acoustic description rather than a gender-identity detector. Adult vocal ranges overlap, and age, vocal style, pitch shifting, noise, and recording quality can change the estimate. Whispering commonly lacks a stable fundamental pitch and is therefore shown as unavailable or uncertain instead of being guessed.

## Browser compatibility

Designed for current Safari on iPad/iPhone and current Safari, Chrome, Edge, and Firefox on desktop. Codec support is supplied by the browser/OS; WAV and MP3 are the most portable. iOS requires a user gesture before audio starts. Very large compressed recordings may hit Safari's decode-memory ceiling because `decodeAudioData` does not stream. Local Whisper is demanding on older iPads, and the tiny multilingual model trades accuracy for memory and speed—especially on severely muffled speech or recordings that switch languages mid-sentence.

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

VAD and whisper likelihood are energy, spectral-ratio, and zero-crossing estimates and may classify music or hiss as voice, so voice-only playback can occasionally skip faint speech or retain non-speech. Increase sensitivity when speech is being missed; reduce it when too much background passes through. RNNoise and DSP can reveal captured speech components but cannot reconstruct words that were never recorded. Whisper output must be treated as an aid, not forensic proof; explicit Hindi or Marathi selection generally works better than auto detection on muffled audio.

Speaker diarization is intentionally not shown. VoiceScope does not yet ship a sufficiently reliable local speaker-embedding model, and assigning guessed Speaker 1/2 labels would be misleading. Voice Profile Analysis describes acoustic pitch presentation but does not establish whether two regions belong to the same person. Reliable diarization, export of cleaned audio, spectral editing, formant/harmonic tools, and voice comparison remain roadmap items.
