// Run after building the device: node tests/band-overlap.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const device = fs.readFileSync(path.join(__dirname, '..', 'FreqFriction.amxd'));
const patch = JSON.parse(device.subarray(32, -1));
const script = patch.patcher.boxes.find(({box}) => box.id === 'plot').box.textfile.text;
const context = vm.createContext({Dict: function () {}, Task: function () {}});
const measure = vm.runInContext(script + `
    (function (bufferA, bufferB) {
        const a = makeSource({identifier: 1}), b = makeSource({identifier: 2});
        analyze(a, bufferA, 0, 1000);
        analyze(b, bufferB, 0, 1000);
        const overlap = temporalOverlap(a, b);
        return Array.from(a.spectrum, (_, band) => ({
            hz: hz(band), old: risk(a.spectrum[band], b.spectrum[band]) * overlap,
            warning: bandRisk(a, b, band, overlap)
        }));
    })`, context);

// Both tracks sustain the same upper tone. Their low notes either alternate
// or overlap. Opposite stereo polarity guards against accidentally summing to mono.
function buffer(rate, sub, early) {
    const length = 8192;
    return {
        channelcount: () => 2, framecount: () => length, length: () => 1000 * length / rate,
        peek(channel, start, count) {
            return Float64Array.from({length: count}, (_, i) => {
                const n = start + i - (length - 4096 - 256);
                const onset = sub ? (early ? 700 : 2150) : 0;
                const end = sub ? 4096 : 1960;
                const envelope = Math.max(0, Math.min(1, (n - onset) / 120, (end - n) / 120));
                const phase = 2 * Math.PI * n / rate;
                return (channel === 1 ? 1 : -1) * (0.3 * envelope * Math.sin(70 * phase)
                    + 0.22 * Math.sin(2400 * phase));
            });
        }
    };
}

for (const rate of [44100, 48000, 96000]) {
    for (const early of [false, true]) {
        const values = measure(buffer(rate, false, early), buffer(rate, true, early));
        const low = values.filter(v => v.hz > 55 && v.hz < 90);
        assert(low.some(v => v.old >= 0.16), 'fixture must reproduce the broadband false positive');
        assert.equal(low.some(v => v.warning > 0), early, 'sub warning at ' + rate);
        assert(values.some(v => v.hz > 2000 && v.hz < 2800 && v.warning > 0), 'upper tones coincide');
    }
}
