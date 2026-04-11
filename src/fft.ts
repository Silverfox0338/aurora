export function createHannWindow(size: number): Float32Array {
  if (size < 2) return new Float32Array(size);
  return Float32Array.from(
    { length: size },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1)),
  );
}

export function applyWindow(
  input: Float32Array,
  window: Float32Array,
  output = new Float32Array(input.length),
): Float32Array {
  if (input.length !== window.length || output.length !== input.length)
    throw new Error("FFT input, window, and output lengths must match.");
  for (let index = 0; index < input.length; index += 1)
    output[index] = (input[index] ?? 0) * (window[index] ?? 0);
  return output;
}

export function frequencyForBin(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

export function binForFrequency(frequencyHz: number, sampleRate: number, fftSize: number): number {
  return Math.round((frequencyHz * fftSize) / sampleRate);
}

export class Radix2Fft {
  private readonly real: Float64Array;
  private readonly imaginary: Float64Array;
  private readonly reversed: Uint32Array;
  private readonly cosine: Float64Array;
  private readonly sine: Float64Array;

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two.");
    this.real = new Float64Array(size);
    this.imaginary = new Float64Array(size);
    this.reversed = new Uint32Array(size);
    this.cosine = new Float64Array(size / 2);
    this.sine = new Float64Array(size / 2);
    const bits = Math.log2(size);
    for (let index = 0; index < size; index += 1) {
      let reversed = 0;
      let value = index;
      for (let bit = 0; bit < bits; bit += 1) {
        reversed = (reversed << 1) | (value & 1);
        value >>= 1;
      }
      this.reversed[index] = reversed;
    }
    for (let index = 0; index < size / 2; index += 1) {
      const angle = (-2 * Math.PI * index) / size;
      this.cosine[index] = Math.cos(angle);
      this.sine[index] = Math.sin(angle);
    }
  }

  magnitudes(input: Float32Array, output = new Float32Array(this.size / 2 + 1)): Float32Array {
    if (input.length !== this.size) throw new Error("FFT input length does not match its configured size.");
    for (let index = 0; index < this.size; index += 1) {
      const reversed = this.reversed[index]!;
      this.real[reversed] = input[index] ?? 0;
      this.imaginary[reversed] = 0;
    }
    for (let length = 2; length <= this.size; length *= 2) {
      const half = length / 2;
      const twiddleStride = this.size / length;
      for (let start = 0; start < this.size; start += length) {
        for (let offset = 0; offset < half; offset += 1) {
          const cosine = this.cosine[offset * twiddleStride] ?? 1;
          const sine = this.sine[offset * twiddleStride] ?? 0;
          const even = start + offset;
          const odd = even + half;
          const oddReal = (this.real[odd] ?? 0) * cosine - (this.imaginary[odd] ?? 0) * sine;
          const oddImaginary = (this.real[odd] ?? 0) * sine + (this.imaginary[odd] ?? 0) * cosine;
          const evenReal = this.real[even] ?? 0;
          const evenImaginary = this.imaginary[even] ?? 0;
          this.real[even] = evenReal + oddReal;
          this.imaginary[even] = evenImaginary + oddImaginary;
          this.real[odd] = evenReal - oddReal;
          this.imaginary[odd] = evenImaginary - oddImaginary;
        }
      }
    }
    const scale = 2 / this.size;
    for (let bin = 0; bin < output.length; bin += 1)
      output[bin] = Math.hypot(this.real[bin] ?? 0, this.imaginary[bin] ?? 0) * scale;
    return output;
  }
}
