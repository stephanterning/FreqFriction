// Shared time-domain and spectral analysis for both input banks.
const bands = 80;
const floor = -78;
const size = 4096;
const hz = b => 30 * Math.pow(600, b / (bands - 1));

const windowFn = Float64Array.from({length: size}, (_, i) =>
    0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
const activityFloor = Math.pow(10, -65 / 10);
// Use a decaying peak so the recording level alone does not determine whether a tail counts.
const relativeActivityFloor = Math.pow(10, -20 / 10);
const peakReleaseDbPerSecond = 18;
const warningThreshold = 0.16;

const reversed = new Int32Array(size);
const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
for (let i = 1; i < size; i++)
    reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) * (size >> 1));
for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos(-2 * Math.PI * i / size);
    sin[i] = Math.sin(-2 * Math.PI * i / size);
}
const real = new Float64Array(size), imag = new Float64Array(size);
const power = new Float64Array(size / 2);

function accumulate(input) {
    for (let i = 0; i < size; i++) real[reversed[i]] = windowFn[i] * input[i];
    imag.fill(0);
    for (let span = 2; span <= size; span *= 2) {
        const half = span / 2;
        for (let block = 0; block < size; block += span) {
            for (let j = 0; j < half; j++) {
                const a = block + j, b = a + half, w = j * size / span;
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
    power.fill(0);
    accumulate(left);
    accumulate(right);
    for (let b = 0; b < bands; b++) {
        const lo = Math.max(1, Math.round(hz(b - 0.5) * size / rate));
        const hi = Math.min(power.length, Math.max(lo + 1, Math.round(hz(b + 0.5) * size / rate)));
        let peak = 0;
        for (let k = lo; k < hi; k++) peak = Math.max(peak, power[k]);
        source.spectrum[b] = Math.max(floor, 10 * Math.log10(1e-12 + peak * 8 / (size * size)));
    }
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

