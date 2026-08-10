import { writeFile } from "node:fs/promises";

const output = process.argv[2];
if (!output) throw new Error("Pass an output WAV path");

const sampleRate = 16_000;
const duration = 20;
const samples = new Int16Array(sampleRate * duration);
let seed = 0x5eed1234;
const random = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0xffff_ffff * 2 - 1;
};

for (let index = 0; index < samples.length; index++) {
  const time = index / sampleRate;
  const hum = 0.025 * Math.sin(2 * Math.PI * 50 * time) + 0.012 * Math.sin(2 * Math.PI * 100 * time);
  let signal = hum + random() * 0.012;
  if (time >= 3 && time < 8) {
    const syllable = 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * 2.1 * time), 2);
    const breath = (random() - 0.72 * Math.sin(2 * Math.PI * 6200 * time)) * 0.045 * syllable;
    signal += breath + 0.018 * Math.sin(2 * Math.PI * 1850 * time) * syllable;
  } else if (time >= 8 && time < 13) {
    const envelope = 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * 2.8 * time), 2);
    signal += envelope * (0.12 * Math.sin(2 * Math.PI * 125 * time) + 0.055 * Math.sin(2 * Math.PI * 1500 * time) + 0.04 * Math.sin(2 * Math.PI * 2800 * time));
  } else if (time >= 13 && time < 16) {
    signal += random() * 0.06;
  } else if (time >= 16) {
    const envelope = 0.4 + 0.6 * Math.pow(Math.sin(Math.PI * 3.2 * time), 2);
    signal += envelope * (0.1 * Math.sin(2 * Math.PI * 220 * time) + 0.05 * Math.sin(2 * Math.PI * 1750 * time) + 0.035 * Math.sin(2 * Math.PI * 3400 * time));
  }
  samples[index] = Math.round(Math.max(-1, Math.min(1, signal)) * 32767);
}

const dataBytes = samples.byteLength;
const wav = Buffer.alloc(44 + dataBytes);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataBytes, 40);
Buffer.from(samples.buffer).copy(wav, 44);
await writeFile(output, wav, { mode: 0o600 });
console.log(output);
