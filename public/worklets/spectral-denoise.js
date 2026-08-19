const FFT_SIZE = 1024;
const HOP_SIZE = 128;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fft(real, imaginary, inverse = false) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index++) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let width = 2; width <= length; width <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < length; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < width / 2; index++) {
        const left = offset + index;
        const right = left + width / 2;
        const rightReal = real[right] * twiddleReal - imaginary[right] * twiddleImaginary;
        const rightImaginary = real[right] * twiddleImaginary + imaginary[right] * twiddleReal;
        real[right] = real[left] - rightReal;
        imaginary[right] = imaginary[left] - rightImaginary;
        real[left] += rightReal;
        imaginary[left] += rightImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index++) real[index] /= length;
}

function createState() {
  return {
    history: new Float32Array(FFT_SIZE),
    overlap: new Float32Array(FFT_SIZE),
    normalization: new Float32Array(FFT_SIZE),
    real: new Float32Array(FFT_SIZE),
    imaginary: new Float32Array(FFT_SIZE),
    priorGains: new Float32Array(FFT_SIZE / 2 + 1).fill(1),
    gains: new Float32Array(FFT_SIZE / 2 + 1),
  };
}

class VoiceScopeSpectralDenoise extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.amount = 0;
    this.profile = new Float32Array(0);
    this.minimumFrequency = 45;
    this.maximumFrequency = 5_800;
    this.states = [];
    this.window = new Float32Array(FFT_SIZE);
    this.reportCounter = 0;
    for (let index = 0; index < FFT_SIZE; index++) this.window[index] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * index / (FFT_SIZE - 1)));
    this.port.onmessage = ({ data }) => {
      if (data?.type !== "configure") return;
      this.enabled = Boolean(data.enabled && data.profile?.length);
      this.amount = clamp(Number(data.amount) || 0);
      this.profile = data.profile instanceof Float32Array ? data.profile : new Float32Array(data.profile || []);
      this.minimumFrequency = Math.max(20, Number(data.minimumFrequency) || 45);
      this.maximumFrequency = Math.max(this.minimumFrequency + 1, Number(data.maximumFrequency) || 5_800);
    };
  }

  noiseAt(frequency) {
    if (!this.profile.length) return -90;
    const clamped = Math.max(this.minimumFrequency, Math.min(this.maximumFrequency, frequency));
    const ratio = Math.log(clamped / this.minimumFrequency) / Math.log(this.maximumFrequency / this.minimumFrequency);
    const position = clamp(ratio) * (this.profile.length - 1);
    const before = Math.floor(position);
    const after = Math.min(this.profile.length - 1, before + 1);
    const fraction = position - before;
    return this.profile[before] * (1 - fraction) + this.profile[after] * fraction;
  }

  processChannel(input, output, state) {
    state.history.copyWithin(0, HOP_SIZE);
    state.history.fill(0, FFT_SIZE - HOP_SIZE);
    state.history.set(input.subarray(0, Math.min(HOP_SIZE, input.length)), FFT_SIZE - HOP_SIZE);
    for (let index = 0; index < FFT_SIZE; index++) {
      state.real[index] = state.history[index] * this.window[index];
      state.imaginary[index] = 0;
    }
    fft(state.real, state.imaginary);
    let reductionTotal = 0;
    for (let bin = 0; bin <= FFT_SIZE / 2; bin++) {
      const frequency = bin * sampleRate / FFT_SIZE;
      const amplitude = Math.hypot(state.real[bin], state.imaginary[bin]) / FFT_SIZE;
      let gain = 1;
      if (this.enabled) {
        const signalPower = Math.max(1e-14, amplitude * amplitude);
        const noiseAmplitude = Math.pow(10, this.noiseAt(frequency) / 20);
        const subtraction = 1 + this.amount * 2.2;
        const speechFloor = frequency >= 100 && frequency <= 6_500 ? 0.18 : frequency < 80 ? 0.06 : 0.1;
        gain = Math.sqrt(Math.max(signalPower - subtraction * noiseAmplitude * noiseAmplitude, signalPower * speechFloor * speechFloor) / signalPower);
      }
      const temporal = gain < state.priorGains[bin] ? 0.58 : 0.16;
      state.gains[bin] = state.priorGains[bin] + (gain - state.priorGains[bin]) * temporal;
    }
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const gain = (state.gains[bin - 1] + state.gains[bin] * 2 + state.gains[bin + 1]) / 4;
      state.priorGains[bin] = gain;
      reductionTotal += -20 * Math.log10(Math.max(1e-4, gain));
      state.real[bin] *= gain;
      state.imaginary[bin] *= gain;
      state.real[FFT_SIZE - bin] *= gain;
      state.imaginary[FFT_SIZE - bin] *= gain;
    }
    state.real[0] *= state.gains[0];
    state.imaginary[0] *= state.gains[0];
    state.real[FFT_SIZE / 2] *= state.gains[FFT_SIZE / 2];
    state.imaginary[FFT_SIZE / 2] *= state.gains[FFT_SIZE / 2];
    fft(state.real, state.imaginary, true);
    for (let index = 0; index < FFT_SIZE; index++) {
      state.overlap[index] += state.real[index] * this.window[index];
      state.normalization[index] += this.window[index] * this.window[index];
    }
    for (let index = 0; index < output.length; index++) output[index] = state.overlap[index] / Math.max(1e-6, state.normalization[index]);
    state.overlap.copyWithin(0, HOP_SIZE);
    state.overlap.fill(0, FFT_SIZE - HOP_SIZE);
    state.normalization.copyWithin(0, HOP_SIZE);
    state.normalization.fill(0, FFT_SIZE - HOP_SIZE);
    return reductionTotal / Math.max(1, FFT_SIZE / 2 - 1);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;
    let reduction = 0;
    for (let channel = 0; channel < output.length; channel++) {
      if (!this.states[channel]) this.states[channel] = createState();
      const source = input?.[Math.min(channel, Math.max(0, input.length - 1))] || new Float32Array(HOP_SIZE);
      reduction += this.processChannel(source, output[channel], this.states[channel]);
    }
    if (++this.reportCounter % 24 === 0) this.port.postMessage({ type: "reduction", value: this.enabled ? reduction / output.length : 0 });
    return true;
  }
}

registerProcessor("voicescope-spectral-denoise", VoiceScopeSpectralDenoise);
