// Shared time-domain and spectral analysis for both input banks.
const bands = 80;
const floor = -78;
const size = 4096;
const hz = b => 30 * Math.pow(600, b / (bands - 1));

const activityFloor = Math.pow(10, -65 / 10);
// Use a decaying peak so the recording level alone does not determine whether a tail counts.
const relativeActivityFloor = Math.pow(10, -20 / 10);
const peakReleaseDbPerSecond = 18;
const warningThreshold = 0.16;

// Reuse FFT workspaces for the display and the shorter overlap measurements.
function fftWorkspace(length) {
    const reversed = new Int32Array(length);
    const cos = new Float64Array(length / 2), sin = new Float64Array(length / 2);
    for (let i = 1; i < length; i++)
        reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) * (length >> 1));
    for (let i = 0; i < length / 2; i++) {
        cos[i] = Math.cos(-2 * Math.PI * i / length);
        sin[i] = Math.sin(-2 * Math.PI * i / length);
    }
    return {length, reversed, cos, sin, real: new Float64Array(length),
        imag: new Float64Array(length), power: new Float64Array(length / 2),
        window: Float64Array.from({length}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / length))};
}

const displayFFT = fftWorkspace(size);
const slices = 7;
const overlapFFT = fftWorkspace(size / 4);
const windowFn = displayFFT.window;

function accumulate(fft, input, offset) {
    const {length, reversed, cos, sin, real, imag, power, window} = fft;
    for (let i = 0; i < length; i++) real[reversed[i]] = window[i] * input[offset + i];
    imag.fill(0);
    for (let span = 2; span <= length; span *= 2) {
        const half = span / 2;
        for (let block = 0; block < length; block += span) {
            for (let j = 0; j < half; j++) {
                const a = block + j, b = a + half, w = j * length / span;
                const r = real[b] * cos[w] - imag[b] * sin[w];
                const t = real[b] * sin[w] + imag[b] * cos[w];
                real[b] = real[a] - r; imag[b] = imag[a] - t;
                real[a] += r; imag[a] += t;
            }
        }
    }
    for (let k = 0; k < power.length; k++)
        power[k] += real[k] * real[k] + imag[k] * imag[k];
}

function measureBands(fft, rate, left, right, offset, output, index) {
    const {length, power} = fft;
    power.fill(0);
    accumulate(fft, left, offset);
    accumulate(fft, right, offset);
    if (fft.rate !== rate) {
        fft.rate = rate;
        fft.edges = Array.from({length: bands + 1}, (_, b) =>
            Math.max(1, Math.round(hz(b - 0.5) * length / rate)));
    }
    for (let b = 0; b < bands; b++) {
        const lo = fft.edges[b], hi = Math.min(power.length, Math.max(lo + 1, fft.edges[b + 1]));
        let peak = 0;
        for (let k = lo; k < hi; k++) peak = Math.max(peak, power[k]);
        output[index + b] = Math.max(floor, 10 * Math.log10(1e-12 + peak * 8 / (length * length)));
    }
}

function frame(buffer, channel, start, frames) {
    if (start + size <= frames) return buffer.peek(channel, start, size);
    const count = frames - start;
    const data = new Float64Array(size);
    const asArray = x => typeof x === 'number' ? [x] : x;
    data.set(asArray(buffer.peek(channel, start, count)));
    data.set(asArray(buffer.peek(channel, 0, size - count)), count);
    return data;
}

function analyze(source, buffer, phase, now) {
    const frames = buffer.framecount(), length = buffer.length();
    if (buffer.channelcount() !== 2 || frames <= size + 256 || length <= 0) return false;
    const rate = frames * 1000 / length;
    const start = (frames + Math.floor(phase * frames) - size - 256) % frames;
    const left = frame(buffer, 1, start, frames);
    const right = frame(buffer, 2, start, frames);
    const samplePower = source.activity;
    let framePeak = 0;
    for (let n = 0; n < size; n++) {
        samplePower[n] = (left[n] * left[n] + right[n] * right[n]) / 2;
        framePeak = Math.max(framePeak, samplePower[n]);
    }
    const elapsed = Math.max(0, now - source.lastFrameTime) / 1000;
    source.lastFrameTime = now;
    const retention = Math.pow(10, -peakReleaseDbPerSecond * elapsed / 10);
    source.peakPower = Math.max(framePeak, source.peakPower * retention);
    const gate = Math.max(activityFloor, source.peakPower * relativeActivityFloor);
    source.energy = 0;
    for (let n = 0; n < size; n++) {
        samplePower[n] = Math.max(0, samplePower[n] - gate) * windowFn[n] ** 2;
        source.energy += samplePower[n];
    }
    if (framePeak <= 1e-12) {
        source.spectrum.fill(floor);
        return true;
    }
    measureBands(displayFFT, rate, left, right, 0, source.spectrum, 0);
    // Inactive frames cannot enter the overlap comparison.
    if (source.energy === 0) return true;
    for (let i = 0; i < slices; i++)
        measureBands(overlapFFT, rate, left, right, i * overlapFFT.length / 2, source.sliceDb, i * bands);
    return true;
}

function temporalOverlap(first, second) {
    if (!first.energy || !second.energy) return 0;
    const firstScale = 1 / first.energy, secondScale = 1 / second.energy;
    let overlap = 0;
    for (let n = 0; n < size; n++)
        overlap += Math.min(first.activity[n] * firstScale, second.activity[n] * secondScale);
    return Math.min(1, overlap);
}

function risk(target, other) {
    const strength = db => Math.min(1, Math.max(0, (db + 65) / 20));
    return strength(target) * strength(other) * Math.max(0, Math.min(1, (other - target + 18) / 24));
}

// The long FFT localizes a warning in frequency. Short, aligned windows decide
// whether both sources actually contributed energy there at the same time.
function bandRisk(first, second, band, overlap) {
    const full = risk(first.spectrum[band], second.spectrum[band]);
    if (full * overlap < warningThreshold) return 0;
    let targetPeak = floor, otherPeak = floor;
    for (let i = band; i < slices * bands; i += bands) {
        targetPeak = Math.max(targetPeak, first.sliceDb[i]);
        otherPeak = Math.max(otherPeak, second.sliceDb[i]);
    }
    let shared = 0, targetEnergy = 0;
    for (let i = band; i < slices * bands; i += bands) {
        const target = first.sliceDb[i], other = second.sliceDb[i];
        const weight = Math.pow(10, (target - targetPeak) / 10);
        targetEnergy += weight;
        // Attenuate the tapered edges between two alternating notes.
        const simultaneous = Math.min(weight, Math.pow(10, (other - otherPeak) / 10));
        shared += simultaneous * risk(target, other);
    }
    const score = Math.min(full * overlap, shared / targetEnergy);
    return score >= warningThreshold ? score : 0;
}
