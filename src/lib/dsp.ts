export type DspSettings = {
  enabled: boolean;
  strength: number;
  clarity: number;
  suppression: number;
  gain: number;
  deMuffle: number;
  humRemoval: number;
  hissReduction: number;
  whisperLift: number;
};

export type DspFocus = {
  noiseFloor: number | null;
  noiseProfileEnabled: boolean;
  speechSensitivity: number;
  whisperRecovery: boolean;
};

export type AdaptiveFrame = {
  speech: number;
  whisper: number;
  noise: number;
  clarity: number;
  rms: number;
};

export function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function detectionThreshold(sensitivity: number) {
  return 0.68 - clamp(sensitivity) * 0.36;
}

export function voiceLikelihood(speech: number, whisper: number, sensitivity: number) {
  return clamp(Math.max(speech, whisper * (0.78 + clamp(sensitivity) * 0.3)));
}

export function computeDspParameters(settings: DspSettings, focus: Pick<DspFocus, "whisperRecovery">) {
  const whisperMode = focus.whisperRecovery ? 1 : 0;
  const ordinaryMakeupDb = (settings.gain - 0.5) * 10 + settings.strength * 1.5;
  const whisperMakeupDb = Math.min(0.5, Math.max(-1, (settings.gain - 0.5) * 4 + settings.strength * 0.4));
  return {
    highpassHz: 62 + settings.strength * 35 + settings.suppression * 8 - whisperMode * 7,
    lowShelfDb: -settings.suppression * (3.5 + settings.deMuffle * 3.5),
    hum50Db: -settings.humRemoval * 18,
    hum100Db: -settings.humRemoval * 12,
    mudDb: -settings.deMuffle * 5.5,
    intelligibilityDb: settings.deMuffle * 5 + settings.clarity * 2,
    presenceDb: settings.clarity * 6.5 + settings.deMuffle * 2,
    articulationDb: settings.clarity * 3.5 + whisperMode * 1.5,
    hissShelfDb: -settings.hissReduction * 9,
    lowpassHz: 20000 - settings.hissReduction * 7000 - whisperMode * 1000,
    compressorThresholdDb: -15 - settings.strength * 14 - whisperMode * 3,
    compressorRatio: 2 + settings.strength * 3.2,
    makeupDb: whisperMode ? whisperMakeupDb : ordinaryMakeupDb,
  };
}

export function computeAdaptiveFrame(frame: AdaptiveFrame, settings: DspSettings, focus: DspFocus) {
  if (!settings.enabled) return { likelihood: 0, reductionDb: 0, gateGain: 1, voiceLiftDb: 0, voiceGain: 1 };

  const threshold = detectionThreshold(focus.speechSensitivity);
  const likelihood = voiceLikelihood(frame.speech, frame.whisper, focus.speechSensitivity);
  const whisperEvidence = clamp((frame.whisper - 0.2) / 0.65) * (0.55 + clamp(frame.clarity) * 0.45);
  const backgroundEvidence = clamp(frame.noise * (1 - likelihood * 0.9));
  const learnedEvidence = focus.noiseProfileEnabled && focus.noiseFloor !== null
    ? clamp((focus.noiseFloor * 1.85 - frame.rms) / Math.max(focus.noiseFloor * 1.35, 1e-7))
    : 0;
  const noiseEvidence = Math.max(backgroundEvidence, learnedEvidence);
  const learnedBonusDb = focus.noiseProfileEnabled && focus.noiseFloor !== null ? 8 : 0;
  const maximumReductionDb = settings.suppression * (9 + learnedBonusDb);
  const whisperProtection = 1 - whisperEvidence * 0.9;
  const reductionDb = clamp(noiseEvidence * whisperProtection, 0, 1) * maximumReductionDb;

  // Extra level is conditional on voice evidence. Background-only frames never
  // receive the Whisper Lift, which prevents a quiet recording's hiss being
  // raised simply because the preset is enabled.
  const liftStart = threshold - 0.14;
  const voicedEvidence = clamp((likelihood - liftStart) / Math.max(0.15, 1 - liftStart));
  const whisperBias = 0.35 + whisperEvidence * 0.65;
  const voiceLiftDb = settings.whisperLift * 6 * voicedEvidence * whisperBias;

  return {
    likelihood,
    reductionDb,
    gateGain: Math.pow(10, -reductionDb / 20),
    voiceLiftDb,
    voiceGain: Math.pow(10, voiceLiftDb / 20),
  };
}
