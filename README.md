# VoiceScope 3D

VoiceScope 3D is an iPad-first, private audio-analysis workstation built with Next.js, TypeScript, React Three Fiber, WebGL, Web Audio, and a Web Worker. Recordings stay in the browser.

Transport playback supports 0.5×–2× speed with pitch preservation, ±10-second navigation, looping, overview seeking, and limiter-protected master gain up to 500%.

## Architecture

- `src/hooks/useAudioEngine.ts` owns decoding, transport synchronization, the Web Audio graph, and DSP state.
- `src/workers/analyze.worker.ts` creates bounded-resolution waveform, log-frequency spectral, level, dominant-frequency, voice-activity, whisper-likelihood, acoustic voice-profile data, a capped high-resolution noise envelope, and an automatic 72-band background fingerprint off the UI thread.
- `src/workers/transcribe.worker.ts` applies the active local cleanup chain, lazily loads Whisper, and returns clickable word-level timestamps without uploading the recording. Adaptive multilingual mode re-detects language in overlapping sections for English/Hindi/Marathi code switching.
- `src/lib/audioSession.ts` provides opt-in 24-hour crash/reload recovery using chunked AES-256-GCM encryption, PBKDF2-SHA-256 passphrase derivation, and an encrypted IndexedDB payload. Sensitive Session mode writes no recording or playback snapshot.
- `src/lib/dsp.ts` contains deterministic parameter and adaptive-frame calculations shared by playback and automated diagnostics.
- `src/components/Spectrogram3D.tsx` renders only a playback-centered spectral window on the GPU. Orbit controls provide mouse/touch rotation, pinch zoom, and pan.
- `src/components/Overview.tsx` draws both a zoomed waveform synchronized to the 3D visible window and the full-recording heatmap, waveform, VAD, and seek cursor. Both views use the same clamped time-range function, including near the beginning and end of a recording.

## Spectrogram and performance

Audio is decoded once for the initial analysis and resampled directly into a speech-band 12 kHz mono copy instead of retaining a full-rate mono duplicate. The worker uses a shared sample-based clock and caps analysis at 12,000 time columns (targeting four columns per second) and 72 logarithmic frequency bands, transferring typed-array buffers without copying. It keeps local FFT-window peaks separate from whole-column overview peaks so the waveform, spectral surface, and playhead refer to the same time frames. A separate 10 Hz noise envelope is capped at 36,000 frames (about 144 KB) so five-second noise learning remains precise on long recordings. The 3D surface samples only 96 × 36 vertices around the playhead, renders on demand, and explicitly disposes replaced GPU geometries. Playback-facing React state is bounded to about 15 updates per second, and the expensive full-recording heatmap is painted only when analysis or its display size changes. This tiered resolution keeps memory and CPU use bounded for 30–60 minute recordings.

The app does not retain a full-length 16 kHz transcription copy during ordinary playback. It creates that temporary PCM data only after the user enables transcription, transfers it to the worker, cleans it in place, and releases it when the worker finishes or is cancelled. RNNoise is also disconnected when its slider returns to zero. These choices substantially reduce steady-state memory pressure on iPad Safari.

## Voice Enhance DSP

Original/A is a direct media-source branch. Enhanced/B independently uses RNNoise, a same-origin short-time Fourier transform worklet for learned spectral subtraction, a high-pass filter, low-shelf attenuation, narrow 50/100 Hz hum rejection, 430 Hz mud reduction, 1.55 kHz de-muffling, 2.7 kHz presence, 4.6 kHz articulation, high-frequency hiss control, controlled compression, adaptive voice-only lift, adaptive noise expansion, and a fast output limiter. The true dry/wet branches make A/B switching immediate and click-free. The shared master stage supports 0–500% gain and feeds the limiter to reduce clipping at high boost.

Speech Focus applies a strong intelligibility preset and enables a 70% RNNoise blend. RNNoise runs as a local WASM `AudioWorklet`; the slider crossfades it with the unprocessed signal. Learn Noise Profile samples the selected five-second region, rejects speech/whisper candidates, and estimates the background separately in all 72 log-frequency bands instead of storing one loudness threshold. The spectral worklet subtracts that fingerprint across playback with temporal/frequency smoothing and a speech-band floor to avoid musical artifacts. The learned profile has its own Active switch and Reset control, while live feedback reports its current attenuation. Original/A remains a true unprocessed reference. Voice-only playback uses the VAD timeline to skip sustained non-speech sections.

Whisper Recovery is a separate, reversible faint-speech mode. It automatically activates the recording's quiet-frame spectral fingerprint, performs RNNoise and spectral subtraction first, and only then applies up to 4.5 dB of smoothed lift to credible speech/whisper frames. Background-only frames receive no lift. Static makeup is capped at 0.5 dB, preventing the preset from simply raising the entire noise floor. RNNoise uses a linear correlated-signal crossfade so partial settings do not add a correlated mixing bump. The whisper indicator is a spectral/energy heuristic, not identity recognition or forensic proof.

## Local Whisper transcription

Whisper transcription is opt-in. **Adaptive multilingual · Hinglish** is the default: it runs the multilingual model on overlapping 18-second sections without forcing a single language token, so language is re-detected throughout the recording and mixed Latin/Devanagari output can be preserved. Explicit English, Hindi, and Marathi modes remain available when the recording is known to contain one language. When Voice Enhance is active, the worker applies the learned spectral fingerprint, de-muffling/presence shaping, and voice-evidence-gated lift to the temporary 16 kHz copy before inference; it never globally normalizes the file. On first use, the browser downloads the quantized multilingual `whisper-tiny_timestamped` model from immutable revision `517244293732ee2d58139af5814231b7e6830a0d` and caches it. Words are timestamped and can be tapped to seek. Audio is never sent to the model host. Transformers.js, ONNX Runtime Web, and RNNoise are reviewed, SHA-256-locked files served from `public/runtime`; CI rejects any byte change. An internet connection is required only for the first Whisper model download.

## Reload recovery and privacy

Sensitive Session is the default and retains nothing after a reload. Optional Encrypted Recovery requires a passphrase of at least 12 characters before loading audio. The recording is encrypted in 4 MiB chunks with AES-256-GCM; its key is derived with 600,000 PBKDF2-SHA-256 iterations and is never stored. Playback position, speed, loop, and volume are associated with the encrypted copy. After a reload, the user must re-enter the passphrase before VoiceScope can decrypt and restore the recording. Recovery expires after 24 hours and can be removed immediately with **Forget recovery copy**. The Version 1 plaintext recovery database is deleted automatically during migration.

## Security hardening

- Exact dependency and package-manager versions; frozen lockfile CI; a three-day minimum package age; blocked exotic transitive sources; and explicit install-script allowlisting.
- GitHub Actions have read-only repository permission, do not persist credentials, and are pinned to full commit SHAs. Dependabot, CODEOWNERS, a security policy, and a security/quality workflow are included.
- A restrictive Content Security Policy, anti-framing, no-referrer, HSTS, origin isolation, content-type protection, and disabled device permissions are sent on every response.
- Runtime executable assets are fetched only from exact package versions, rejected unless their pinned SHA-256 digests match, and then served from the same origin. The large generated files are excluded from Git history. Uploaded audio has no server route and is never placed in build output.
- Repository rulesets, account passkeys/2FA, GitHub secret scanning/CodeQL availability, Vercel team/token restrictions, macOS FileVault/firewall, and OS updates remain account/device controls that must be enabled by their owner; source code cannot safely toggle them.

## Voice Profile Analysis

Voice Profile Analysis is an independent opt-in landscape module below the transport, not an enhancement preset and not part of the playback DSP. The bounded analysis worker estimates fundamental pitch and periodicity from speech-like time columns, smooths estimates over nearby voiced columns, and conservatively labels them as lower/masculine-range, higher/feminine-range, or overlapping/uncertain. Its touch-seekable strip uses the same visible-window calculation and cursor ratio as the 3D spectrogram and waveform detail, while also providing a live estimate, confidence, and whole-recording proportions. All calculation remains local.

This is an acoustic description rather than a gender-identity detector. Adult vocal ranges overlap, and age, vocal style, pitch shifting, noise, and recording quality can change the estimate. Whispering commonly lacks a stable fundamental pitch and is therefore shown as unavailable or uncertain instead of being guessed.

## Browser compatibility

Designed for current Safari on iPad/iPhone and current Safari, Chrome, Edge, and Firefox on desktop. Codec support is supplied by the browser/OS; WAV and MP3 are the most portable. iOS requires a user gesture before audio starts, including after an automatic recovery. Very large compressed recordings may hit Safari's decode-memory ceiling because `decodeAudioData` does not stream. Local Whisper is demanding on older iPads, and the tiny multilingual model trades accuracy for memory and speed—especially on severely muffled speech or recordings that switch languages mid-sentence.

## Local development

```bash
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install
pnpm vendor:runtime
pnpm dev
```

Validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm verify:runtime
pnpm security:audit
pnpm build
```

## Vercel deployment

No backend or environment variables are required. Import the repository into Vercel or run `vercel deploy`, validate the preview, then `vercel promote <preview-url>`.

## Known limitations and roadmap

VAD and whisper likelihood are energy, spectral-ratio, and zero-crossing estimates and may classify music or hiss as voice, so voice-only playback can occasionally skip faint speech or retain non-speech. Increase sensitivity when speech is being missed; reduce it when too much background passes through. A spectral fingerprint works best when the chosen region contains steady background without speech; non-stationary noise cannot be perfectly subtracted. RNNoise and DSP can reveal captured speech components but cannot reconstruct words that were never recorded. Whisper output must be treated as an aid, not forensic proof. Adaptive multilingual mode improves code switching but a tiny local model still cannot guarantee correct language identification for every isolated word.

Speaker diarization is intentionally not shown. VoiceScope does not yet ship a sufficiently reliable local speaker-embedding model, and assigning guessed Speaker 1/2 labels would be misleading. Voice Profile Analysis describes acoustic pitch presentation but does not establish whether two regions belong to the same person. Reliable diarization, export of cleaned audio, spectral editing, formant/harmonic tools, and voice comparison remain roadmap items.
