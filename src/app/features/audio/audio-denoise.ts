// In-place, overlap-add spectral reduction on the worker's private audio samples.
export function reduceNoise(
  channels: Float32Array[],
  sampleRate: number,
  thresholdDb: number,
  firstFrame: number,
  lastFrame: number,
): void {
  const size = 1024;
  const hop = size / 4;
  const bins = size / 2 + 1;
  const window = Float64Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size),
  );
  const windowEnergy = window.reduce((sum, value) => sum + value * value, 0);
  const minimumNoise = 10 ** (thresholdDb / 10) * windowEnergy;
  const real = channels.map(() => new Float64Array(size));
  const imaginary = channels.map(() => new Float64Array(size));
  const output = channels.map(() => new Float64Array(size));
  const weights = new Float64Array(size);
  const power = new Float64Array(bins);
  const sorted = new Float64Array(bins - 2);
  const mask = new Float64Array(bins).fill(1);
  // Keep the noise estimate stable between overlapping windows.
  const smoothing = Math.exp(-hop / (sampleRate * 0.15));
  let noise = minimumNoise;

  for (let start = firstFrame - size + hop; start < lastFrame; start += hop) {
    power.fill(0);
    for (let channel = 0; channel < channels.length; channel++) {
      imaginary[channel].fill(0);
      for (let i = 0; i < size; i++) {
        const frame = start + i;
        real[channel][i] =
          frame >= firstFrame && frame < lastFrame ? channels[channel][frame] * window[i] : 0;
      }
      fft(real[channel], imaginary[channel], false);
      for (let bin = 0; bin < bins; bin++) {
        // One mask for both channels preserves stereo balance.
        power[bin] = Math.max(power[bin], real[channel][bin] ** 2 + imaginary[channel][bin] ** 2);
      }
    }

    // Tonal speech/music peaks do not dominate the median broadband noise estimate.
    sorted.set(power.subarray(1, bins - 1));
    sorted.sort();
    const estimate = Math.max(minimumNoise, sorted[sorted.length >> 1] / Math.LN2);
    noise = smoothing * noise + (1 - smoothing) * estimate;
    for (let bin = 0; bin < bins; bin++) {
      const localPower =
        (power[Math.max(0, bin - 1)] + 2 * power[bin] + power[Math.min(bins - 1, bin + 1)]) / 4;
      const target = Math.sqrt(Math.max(0.01, 1 - (2 * noise) / Math.max(localPower, 1e-20)));
      // Open quickly for transients, close gradually to limit musical-noise artifacts.
      const rate = target > mask[bin] ? 0.8 : 0.3;
      mask[bin] += rate * (target - mask[bin]);
    }

    for (let channel = 0; channel < channels.length; channel++) {
      for (let bin = 0; bin < size; bin++) {
        const gain = mask[bin < bins ? bin : size - bin];
        real[channel][bin] *= gain;
        imaginary[channel][bin] *= gain;
      }
      fft(real[channel], imaginary[channel], true);
      for (let i = 0; i < size; i++) output[channel][i] += real[channel][i] * window[i];
    }
    for (let i = 0; i < size; i++) weights[i] += window[i] ** 2;

    // Only write samples that no future analysis window will read.
    for (let i = 0; i < hop; i++) {
      const frame = start + i;
      if (frame < firstFrame || frame >= lastFrame) continue;
      for (let channel = 0; channel < channels.length; channel++) {
        channels[channel][frame] = output[channel][i] / Math.max(weights[i], 1e-20);
      }
    }
    weights.copyWithin(0, hop);
    weights.fill(0, size - hop);
    for (const samples of output) {
      samples.copyWithin(0, hop);
      samples.fill(0, size - hop);
    }
  }
}

function fft(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let i = 0; i < width / 2; i++) {
        const even = start + i;
        const odd = even + width / 2;
        const re = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
        const im = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
        real[odd] = real[even] - re;
        imaginary[odd] = imaginary[even] - im;
        real[even] += re;
        imaginary[even] += im;
        const nextReal = rotationReal * stepReal - rotationImaginary * stepImaginary;
        rotationImaginary = rotationReal * stepImaginary + rotationImaginary * stepReal;
        rotationReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < size; i++) {
      real[i] /= size;
      imaginary[i] /= size;
    }
  }
}
