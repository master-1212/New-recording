/// <reference lib="webworker" />

type Request = { samples: Float32Array; sampleRate: number; duration: number };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = ({ data }: MessageEvent<Request>) => {
  const { samples, sampleRate, duration } = data;
  const columns = Math.min(1800, Math.max(320, Math.ceil(duration * 1.5)));
  const bands = 72;
  const fftSize = 1024;
  const waveform = new Float32Array(columns * 2);
  const spectral = new Uint8Array(columns * bands);
  const rms = new Float32Array(columns);
  const peak = new Float32Array(columns);
  const speech = new Float32Array(columns);
  const whisper = new Float32Array(columns);
  const dominant = new Float32Array(columns);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let c = 0; c < columns; c++) {
    const start = Math.floor((c / columns) * samples.length);
    const end = Math.max(start + 1, Math.floor(((c + 1) / columns) * samples.length));
    let lo = 1, hi = -1, sumSq = 0, zc = 0, previous = samples[start] || 0;
    const stride = Math.max(1, Math.floor((end - start) / 1024));
    let count = 0;
    for (let i = start; i < end; i += stride) {
      const value = samples[i] || 0;
      lo = Math.min(lo, value); hi = Math.max(hi, value);
      sumSq += value * value; count++;
      if ((value >= 0) !== (previous >= 0)) zc++;
      previous = value;
    }
    const level = Math.sqrt(sumSq / Math.max(1, count));
    waveform[c * 2] = lo; waveform[c * 2 + 1] = hi;
    rms[c] = level; peak[c] = Math.max(Math.abs(lo), Math.abs(hi));

    const center = Math.floor(((c + 0.5) / columns) * samples.length);
    for (let i = 0; i < fftSize; i++) {
      const sample = samples[center - fftSize / 2 + i] || 0;
      re[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
      im[i] = 0;
    }
    fft(re, im);
    let best = 0, bestBin = 0, voiceEnergy = 0, highSpeechEnergy = 0, lowEnergy = 0, totalEnergy = 0;
    for (let b = 0; b < bands; b++) {
      const lowHz = 45 * Math.pow(20000 / 45, b / bands);
      const highHz = 45 * Math.pow(20000 / 45, (b + 1) / bands);
      const lowBin = Math.max(1, Math.floor(lowHz * fftSize / sampleRate));
      const highBin = Math.min(fftSize / 2, Math.max(lowBin + 1, Math.ceil(highHz * fftSize / sampleRate)));
      let energy = 0;
      for (let k = lowBin; k < highBin; k++) energy = Math.max(energy, Math.hypot(re[k], im[k]));
      const normalized = Math.max(0, Math.min(1, (20 * Math.log10(energy / fftSize + 1e-7) + 90) / 78));
      spectral[c * bands + b] = Math.round(normalized * 255);
      totalEnergy += energy;
      if (lowHz >= 100 && lowHz <= 5000) voiceEnergy += energy;
      if (lowHz >= 900 && lowHz <= 7000) highSpeechEnergy += energy;
      if (lowHz < 250) lowEnergy += energy;
      if (energy > best) { best = energy; bestBin = Math.round((lowBin + highBin) / 2); }
    }
    const voiceRatio = voiceEnergy / Math.max(1e-8, totalEnergy);
    const highSpeechRatio = highSpeechEnergy / Math.max(1e-8, totalEnergy);
    const lowRatio = lowEnergy / Math.max(1e-8, totalEnergy);
    const zcr = zc / Math.max(1, count);
    const levelScore = Math.min(1, Math.max(0, (20 * Math.log10(level + 1e-7) + 52) / 38));
    speech[c] = Math.min(1, levelScore * 0.52 + voiceRatio * 0.65 + Math.min(zcr * 7, 0.2));
    const faintLevelScore = Math.min(1, Math.max(0, (20 * Math.log10(level + 1e-7) + 72) / 46));
    const breathiness = Math.min(1, zcr * 18);
    // Whisper-like speech has weak periodic energy but sustained upper speech-band detail.
    whisper[c] = Math.min(1, Math.max(0,
      faintLevelScore * 0.22 + voiceRatio * 0.32 + highSpeechRatio * 0.58 + breathiness * 0.16 - lowRatio * 0.28 - 0.22,
    ));
    dominant[c] = bestBin * sampleRate / fftSize;
    if (c % 40 === 0) ctx.postMessage({ type: "progress", progress: c / columns });
  }

  for (let c = 1; c < columns - 1; c++) {
    whisper[c] = whisper[c - 1] * 0.2 + whisper[c] * 0.6 + whisper[c + 1] * 0.2;
  }

  ctx.postMessage({ type: "complete", analysis: { duration, columns, bands, waveform, spectral, rms, peak, speech, whisper, dominant } },
    [waveform.buffer, spectral.buffer, rms.buffer, peak.buffer, speech.buffer, whisper.buffer, dominant.buffer]);
};

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < len / 2; j++) {
        const cos = Math.cos(angle * j), sin = Math.sin(angle * j);
        const p = i + j, q = p + len / 2;
        const tr = re[q] * cos - im[q] * sin, ti = re[q] * sin + im[q] * cos;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
      }
    }
  }
}

export {};
