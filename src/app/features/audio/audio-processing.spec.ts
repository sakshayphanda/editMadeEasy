import { reduceNoise } from './audio-denoise';
import { AudioJob, encodeAudio, boostVolume, toPcm } from './audio-processing';

function job(overrides: Partial<AudioJob> = {}): AudioJob {
  const samples = Float32Array.from(
    { length: 44100 },
    (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 44100),
  );
  return {
    channels: [samples],
    sampleRate: 44100,
    bitrate: 96,
    gain: 1,
    start: 0,
    end: 1,
    ...overrides,
  };
}

describe('Audio processing', () => {
  it('reduces broadband noise beneath a louder tone while preserving stereo balance', () => {
    let seed = 123;
    const clean = Float32Array.from(
      { length: 44100 },
      (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 44100),
    );
    const left = Float32Array.from(clean, (sample) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return sample + (seed / 2147483648) * 0.04;
    });
    const right = Float32Array.from(left, (sample) => sample * 0.5);
    const error = (samples: Float32Array) =>
      samples.reduce((sum, sample, i) => (i < 4410 ? sum : sum + (sample - clean[i]) ** 2), 0);
    const before = error(left);
    reduceNoise([left, right], 44100, -40, 0, left.length);
    expect(error(left)).toBeLessThan(before * 0.4);
    for (let i = 0; i < left.length; i++) {
      expect(right[i]).toBeCloseTo(left[i] * 0.5, 6);
    }
  });

  it('keeps silence finite and only processes the selected interval', () => {
    const samples = new Float32Array(44100);
    samples[0] = 0.1;
    samples[44099] = -0.1;
    reduceNoise([samples], 44100, -40, 1, 44099);
    expect(samples[0]).toBeCloseTo(0.1);
    expect(samples[44099]).toBeCloseTo(-0.1);
    expect(samples.subarray(1, 44099).every((sample) => sample === 0)).toBe(true);
  });

  it('preserves the timing and level of clean tones across overlapping windows', () => {
    const original = Float32Array.from(
      { length: 44137 },
      (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 44100),
    );
    const samples = original.slice();
    reduceNoise([samples], 44100, -60, 0, samples.length);
    const error = samples.reduce((sum, sample, i) => sum + (sample - original[i]) ** 2, 0);
    const energy = original.reduce((sum, sample) => sum + sample ** 2, 0);
    expect(error / energy).toBeLessThan(0.0001);
  });

  it.each([1, 255, 1025])(
    'handles a short %i-sample recording without losing its tail',
    (length) => {
      const samples = new Float32Array(length).fill(0.1);
      reduceNoise([samples], 44100, -60, 0, length);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(samples[length - 1]).toBeGreaterThan(0.05);
    },
  );

  it('applies stronger reduction at a higher threshold and encodes denoised MP3', () => {
    const low = Float32Array.from(
      { length: 44100 },
      (_, i) => 0.005 * Math.sin((2 * Math.PI * 440 * i) / 44100),
    );
    const high = low.slice();
    reduceNoise([low], 44100, -60, 0, low.length);
    reduceNoise([high], 44100, -20, 0, high.length);
    const energy = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample ** 2, 0);
    expect(energy(high)).toBeLessThan(energy(low) * 0.1);
    const result = encodeAudio(job({ noiseThreshold: -40 }));
    expect(result.type).toBe('audio/mpeg');
    expect(result.size).toBeGreaterThan(0);
  });

  it('keeps the requested boost for quiet audio and handles silence', () => {
    const samples = new Float32Array([0.1, -0.2, 0]);
    boostVolume([samples], 3, 0, samples.length);
    expect(samples[0]).toBeCloseTo(0.3);
    expect(samples[1]).toBeCloseTo(-0.6);
    expect(samples[2]).toBe(0);
  });

  it('boosts quiet passages despite full-scale peaks and softly limits both polarities', () => {
    const original = new Float32Array([-1, -0.1, 0, 0.1, 1]);
    const samples = original.slice();
    boostVolume([samples], 3, 0, samples.length);
    expect(samples[1]).toBeCloseTo(-0.3);
    expect(samples[3]).toBeCloseTo(0.3);
    expect(samples[0]).toBeCloseTo(-samples[4]);
    expect(Math.max(...Array.from(samples, Math.abs))).toBeLessThanOrEqual(0.95);
    const energy = (values: Float32Array) => values.reduce((sum, value) => sum + value ** 2, 0);
    const passage = new Float32Array(44100).fill(0.1);
    passage[2000] = 1;
    const before = energy(passage);
    boostVolume([passage], 3, 0, passage.length);
    expect(energy(passage)).toBeGreaterThan(before * 8);
  });

  it('increases output as the requested boost rises', () => {
    const low = new Float32Array([0.1, 0.4, 0.9]);
    const high = low.slice();
    boostVolume([low], 1.5, 0, low.length);
    boostVolume([high], 3, 0, high.length);
    for (let frame = 0; frame < low.length; frame++) {
      expect(high[frame]).toBeGreaterThan(low[frame]);
    }
  });

  it('links stereo limiting without allowing a later peak to suppress earlier audio', () => {
    const left = new Float32Array(2304).fill(0.1);
    const right = new Float32Array(2304).fill(0.2);
    right[2000] = 0.9;
    boostVolume([left, right], 3, 0, left.length);
    expect(left[0]).toBeCloseTo(0.3);
    expect(right[0]).toBeCloseTo(0.6);
    expect(right[2000]).toBeLessThanOrEqual(0.95);
    expect(right[2000] / left[2000]).toBeCloseTo(9);
  });

  it('processes only the selected interval and leaves unity gain unchanged', () => {
    const samples = new Float32Array([0.9, 0.1, -0.1, -0.9]);
    const original = samples.slice();
    boostVolume([samples], 1, 0, samples.length);
    expect(samples).toEqual(original);
    boostVolume([samples], 3, 1, 3);
    expect(samples[0]).toBe(original[0]);
    expect(samples[3]).toBe(original[3]);
    expect(samples[1]).toBeCloseTo(0.3);
    expect(samples[2]).toBeCloseTo(-0.3);
  });

  it('boosts samples and clamps peaks without integer wraparound', () => {
    expect(Array.from(toPcm(new Float32Array([-0.75, -0.25, 0, 0.25, 0.75]), 2))).toEqual([
      -32768, -16384, 0, 16384, 32767,
    ]);
  });

  it('produces MP3 frames and a smaller file at a lower bitrate', async () => {
    const low = encodeAudio(job({ bitrate: 64 }));
    const high = encodeAudio(job({ bitrate: 192 }));
    expect(low.type).toBe('audio/mpeg');
    expect(low.size).toBeGreaterThan(0);
    expect(low.size).toBeLessThan(high.size);
    const bytes = new Uint8Array(await low.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xe0).toBe(0xe0);
  });

  it('encodes only the selected interval, including the last partial block', () => {
    const full = encodeAudio(job());
    const trimmed = encodeAudio(job({ start: 0.25, end: 0.75 }));
    const tiny = encodeAudio(job({ start: 0, end: 1 / 44100 }));
    expect(trimmed.size).toBeLessThan(full.size);
    expect(tiny.size).toBeGreaterThan(0);
  });

  it('supports stereo audio', () => {
    const source = job();
    const stereo = encodeAudio({ ...source, channels: [source.channels[0], source.channels[0]] });
    expect(stereo.size).toBeGreaterThan(0);
  });

  it.each([
    { start: -1 },
    { start: 0.8, end: 0.5 },
    { end: 2 },
    { end: NaN },
    { end: 0 },
    { channels: [] },
    { gain: Infinity },
    { gain: 4 },
    { bitrate: 0 },
    { noiseThreshold: NaN },
    { noiseThreshold: -61 },
    { noiseThreshold: -19 },
  ])('rejects invalid settings: %j', (settings) => {
    expect(() => encodeAudio(job(settings))).toThrow();
  });
});
