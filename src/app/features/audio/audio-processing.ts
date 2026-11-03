import { Mp3Encoder } from '@breezystack/lamejs';
import { reduceNoise } from './audio-denoise';

export interface AudioJob {
  channels: Float32Array[];
  sampleRate: number;
  bitrate: number;
  gain: number;
  start: number;
  end: number;
  noiseThreshold?: number;
}

export type AudioReply = { blob: Blob } | { error: string };

export function boostVolume(
  channels: Float32Array[],
  gain: number,
  firstFrame: number,
  lastFrame: number,
): void {
  if (gain === 1) return;

  for (let frame = firstFrame; frame < lastFrame; frame++) {
    let peak = 0;
    for (const channel of channels) {
      peak = Math.max(peak, Math.abs(channel[frame]) * gain);
    }
    // A soft knee limits only loud peaks, leaving quieter samples at the requested gain.
    const limitedPeak = peak > 0.8 ? 0.8 + 0.15 * (1 - Math.exp(-(peak - 0.8) / 0.15)) : peak;
    const frameGain = peak > 0 ? gain * (limitedPeak / peak) : gain;
    // Link both channels so limiting preserves the stereo balance.
    for (const channel of channels) {
      channel[frame] *= frameGain;
    }
  }
}

export function toPcm(samples: Float32Array, gain: number): Int16Array {
  return Int16Array.from(samples, (value) => {
    const sample = Math.max(-1, Math.min(1, value * gain));
    return Math.round(sample * (sample < 0 ? 32768 : 32767));
  });
}

export function encodeAudio(job: AudioJob): Blob {
  const { channels, sampleRate, bitrate, gain, start, end } = job;
  const length = channels[0]?.length ?? 0;
  if (
    channels.length < 1 ||
    channels.length > 2 ||
    channels.some((channel) => channel.length !== length) ||
    sampleRate !== 44100 ||
    ![64, 96, 128, 192].includes(bitrate) ||
    !Number.isFinite(gain) ||
    gain < 1 ||
    gain > 3 ||
    (job.noiseThreshold !== undefined &&
      (!Number.isFinite(job.noiseThreshold) ||
        job.noiseThreshold < -60 ||
        job.noiseThreshold > -20)) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > length / sampleRate
  ) {
    throw new Error('Choose valid audio settings and a non-empty time range.');
  }

  const firstFrame = Math.floor(start * sampleRate);
  const lastFrame = Math.min(length, Math.ceil(end * sampleRate));
  if (job.noiseThreshold !== undefined) {
    reduceNoise(channels, sampleRate, job.noiseThreshold, firstFrame, lastFrame);
  }
  boostVolume(channels, gain, firstFrame, lastFrame);
  const encoder = new Mp3Encoder(channels.length, sampleRate, bitrate);
  const parts: ArrayBuffer[] = [];

  for (let offset = firstFrame; offset < lastFrame; offset += 1152) {
    const stop = Math.min(offset + 1152, lastFrame);
    const left = toPcm(channels[0].subarray(offset, stop), 1);
    const right = channels[1] ? toPcm(channels[1].subarray(offset, stop), 1) : undefined;
    parts.push(new Uint8Array(encoder.encodeBuffer(left, right)).buffer);
  }
  parts.push(new Uint8Array(encoder.flush()).buffer);
  return new Blob(parts, { type: 'audio/mpeg' });
}
