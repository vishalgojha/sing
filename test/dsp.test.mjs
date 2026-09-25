import { FFT, PitchDetector, PitchShifter } from '../worklet/dsp.js';

let failures = 0;
function ok(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`);
  }
}

function estimateFreq(samples, sr) {
  let crossings = 0;
  let lastSign = Math.sign(samples[0]) >= 0;
  for (let i = 1; i < samples.length; i++) {
    const s = Math.sign(samples[i]) >= 0;
    if (s !== lastSign) {
      crossings++;
      lastSign = s;
    }
  }
  return (crossings / 2) * (sr / samples.length);
}

function estimateRms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

// ---- FFT round trip ----
{
  const n = 2048;
  const fft = new FFT(n);
  const buf = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    buf[2 * i] = Math.sin(2 * Math.PI * 100 * i / 48000) + Math.random() * 0.01;
    buf[2 * i + 1] = 0;
  }
  const original = buf.slice();
  fft.transform(buf, false);
  fft.transform(buf, true);
  let maxErr = 0;
  for (let i = 0; i < buf.length; i++) maxErr = Math.max(maxErr, Math.abs(buf[i] - original[i]));
  ok('FFT round trip < 1e-9', maxErr < 1e-9);
}

// ---- Pitch shifter: correction-style shifts (small, like pitch correction) ----
function testShift(shift, expected, tol, label) {
  const sr = 48000;
  const shifter = new PitchShifter(sr, 2048, 4);
  const hop = shifter.hop;
  const total = hop * 60;
  const inBuf = new Float32Array(total);
  const outBuf = new Float32Array(total);
  for (let i = 0; i < total; i++) inBuf[i] = 0.6 * Math.sin(2 * Math.PI * 440 * i / sr);
  for (let h = 0; h < total / hop; h++) {
    shifter.process(shift, inBuf.subarray(h * hop, (h + 1) * hop), outBuf.subarray(h * hop, (h + 1) * hop));
  }
  const tail = outBuf.subarray(hop * 16);
  const f = estimateFreq(tail, sr);
  const rms = estimateRms(tail);
  ok(`${label}: ${expected} Hz (got ${f.toFixed(1)})`, Math.abs(f - expected) < tol);
  ok(`${label}: level ok (rms ${rms.toFixed(3)})`, rms > 0.25 && rms < 0.6);
}

testShift(1.0, 440, 3, 'unity keeps 440 Hz');
testShift(1.0595, 466, 12, 'shift +1 semitone to ~466 Hz');
testShift(0.9439, 415, 12, 'shift -1 semitone to ~415 Hz');

// ---- Pitch detector ----
for (const [freq, label] of [[110, 'A2'], [220, 'A3'], [330, 'E4'], [440, 'A4'], [587, 'D5'], [784, 'G5']]) {
  const sr = 48000;
  const det = new PitchDetector(sr);
  const win = det.win;
  const tauMax = det.tauMax;
  const hist = new Float64Array(win + tauMax + 4);
  for (let i = 0; i < hist.length; i++) {
    const t = i / sr;
    const vib = 1 + 0.001 * Math.sin(2 * Math.PI * 5 * t);
    hist[i] = 0.7 * Math.sin(2 * Math.PI * freq * vib * t) + 0.25 * Math.sin(2 * Math.PI * 2 * freq * vib * t);
  }
  const r = det.detect(hist);
  const centsErr = 1200 * Math.abs(Math.log2(r.freq / freq));
  ok(`detects ${label} ~${freq} Hz (got ${r.freq.toFixed(1)} Hz, ${centsErr.toFixed(1)}c, conf ${r.conf.toFixed(2)})`, r.conf > 0.7 && centsErr < 15);
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
