# VoiceScope 3D

VoiceScope 3D is an iPad-first, local-only audio analysis workstation. It decodes a recording once, displays a synchronized GPU-rendered frequency landscape and overview, estimates voice activity, and offers an immediately switchable speech-enhancement chain. No uploaded audio is sent over the network.

## Architecture

Version 1 is a dependency-free browser application so the signal path stays small, auditable, and resilient on Safari. `app.js` separates the Web Audio engine, WebGL spectral view, interaction state, and UI bindings. `fft-worker.js` performs bounded analysis off the main thread. Static assets can be deployed directly to Vercel; `server.mjs` provides the local development server.

The audio engine uses a single decoded `AudioBuffer` and creates short-lived `AudioBufferSourceNode`s for sample-accurate seek/resume. The UI clock derives from `AudioContext.currentTime`, rather than timer increments, to keep playback, the playhead, and both visualizations synchronized. The worker API is intentionally generic so a future diarization, transcription, or AI-enhancement worker can consume the same time-indexed data.

## Spectrogram rendering

The analysis worker reduces input into a duration-aware maximum of 1,400 time columns and 48 logarithmic frequency bands. It transfers typed-array ownership rather than cloning large sample sets. The WebGL renderer uploads only the time window around the playhead, then draws it as a touch-orbitable, zoomable amplitude surface:

- **X:** time within the selected visible window
- **Y:** logarithmic frequency, 70 Hz to the lower of 12 kHz or Nyquist
- **Z:** relative spectral intensity

Seeking updates the window immediately. During playback it refreshes spectral geometry four times per second while the transport cursor remains at animation-frame cadence. This avoids recalculating a complete spectrogram on every frame.

## Voice Enhance DSP

The enhanced path is parallel to a latency-matched dry path for fast A/B switching:

1. 85 Hz high-pass filter for rumble
2. low-shelf attenuation below 240 Hz
3. presence EQ centered at 2.6 kHz
4. soft-knee dynamics compressor
5. user-controlled make-up/voice gain
6. fast brick-wall-style limiter near -2 dB
7. activity-aware input attenuation during low-energy/background regions

Enhancement strength, clarity, suppression, and gain update live. This is deterministic browser DSP, not AI source separation.

## Performance approach

- Decode once and reuse the audio buffer.
- Transfer mono samples to a Web Worker for chunked, fixed-memory overview analysis.
- Cap global overview resolution independent of recording length.
- Use typed arrays for waveform, activity, RMS, and spectral tiles.
- Upload/render only the visible local spectral window.
- Keep React-style render cycles out of the realtime path; live values update directly at animation cadence.
- Pause full geometry updates between quarter-second intervals.

Long compressed recordings still require browser decoding to PCM. A 31-minute mono 48 kHz file uses roughly 357 MB during the brief copy/transfer stage; stereo decoding uses more. On memory-constrained older iPads, close other tabs first.

## Browser compatibility

Designed for current iPad/iPhone Safari, macOS Safari, Chrome, Edge, and Firefox. Web Audio decoding support varies by browser and OS codec availability. M4A/AAC support is strongest in Safari and Chromium on platforms with codecs installed. Unsupported files receive a visible decode error. Touch drag orbits the view and two-finger pinch zooms it; mouse drag and wheel are the desktop equivalents.

Safari requires playback to begin following a user gesture; the Play control resumes the audio context accordingly. Screen-lock/background playback and OS-level media controls are outside Version 1.

## Local development

Requires Node.js 20 or newer. There are no runtime npm dependencies.

```bash
npm run lint
npm run typecheck
npm run build
npm run dev
```

Open <http://localhost:3000>, choose any browser-supported audio file, and use the overview or transport timeline to seek.

## Vercel deployment

Import the repository into Vercel as a static project and set:

- Build command: `npm run build`
- Output directory: `dist`

Or use `vercel --prod`. `vercel.json` supplies privacy/security headers and clean URLs. There is no backend or storage configuration.

## Known limitations

- Voice activity is an energy/zero-crossing heuristic and is not identity recognition, diarization, or a clinical voice assessment.
- The fixed-resolution overview favors stability on long files over forensic FFT resolution. The interactive surface is a perceptual multi-band estimate rather than an offline STFT export.
- Browser codec support differs; Version 1 cannot transcode formats the browser cannot decode.
- Audio export, selected-region spectral editing, and microphone capture are not included.
- Network-hosted font loading is cosmetic; system fonts are used when offline and audio never leaves the device.

## Future roadmap

The time-indexed analysis model is ready to be extended with local/opt-in AI enhancement, Whisper-compatible transcription, word-level seeking, speaker diarization tracks, transcript search, enhanced WAV/MP3 export, spectral region editing, pitch/formant/harmonic analysis, and voice-fingerprint comparison. These are roadmap items and are **not** represented as available in Version 1.
