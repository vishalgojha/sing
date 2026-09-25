import { PitchDetector, PitchShifter } from './dsp.js';

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1 }];
  }

  constructor(options) {
    super();
    const sr = options.processorOptions.sampleRate || sampleRate;
    this.sampleRate = sr;
    this.hop = 512;
    this.detector = new PitchDetector(sr);
    this.shifter = new PitchShifter(sr, 2048, 4);
    this.hist = new Float64Array(1024 + this.detector.tauMax + 16);
    this.hopBuf = new Float32Array(this.hop);
    this.hopCount = 0;
    this.outRing = new Float32Array(4096);
    this.outRead = 0;
    this.outWrite = 0;
    this.outCount = 0;
    this.ratio = 1;
    this.strength = 0.7;
    this.bypass = false;
    this.scaleIntervals = [0, 2, 4, 5, 7, 9, 11];
    this.rootMidi = 60;
    this.freqHistory = [];
    this.mix = 1;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'params') {
        if (typeof d.strength === 'number') this.strength = d.strength;
        if (typeof d.bypass === 'boolean') this.bypass = d.bypass;
        if (Array.isArray(d.scaleIntervals)) this.scaleIntervals = d.scaleIntervals;
        if (typeof d.rootMidi === 'number') this.rootMidi = d.rootMidi;
        if (typeof d.mix === 'number') this.mix = d.mix;
      }
    };
  }

  noteInfo(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const pc = Math.round(midi);
    const name = names[((pc % 12) + 12) % 12];
    const octave = Math.floor(pc / 12) - 1;
    return { midi, name: name + octave, cents: Math.round(100 * (midi - pc)) };
  }

  targetFor(midi) {
    const intervals = this.scaleIntervals;
    if (intervals.length === 0) return midi;
    const root = this.rootMidi;
    const rel = (midi - root) % 12;
    const norm = ((rel % 12) + 12) % 12;
    let best = 0;
    let bestDist = Infinity;
    for (const iv of intervals) {
      for (const cand of [iv, iv - 12, iv + 12]) {
        const dist = Math.abs(cand - norm);
        if (dist < bestDist) {
          bestDist = dist;
          best = cand;
        }
      }
    }
    return root + best + 12 * Math.round((midi - root) / 12);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }
    const ch = input[0] || new Float32Array(128);
    const out = output[0];

    this.hopBuf.set(ch.subarray(0, 128), this.hopCount * 128);
    this.hopCount++;
    const hop = this.hop;
    if (this.hopCount * 128 >= hop) {
      this.hopCount = 0;
      this.runHop(this.hopBuf);
    }

    for (let i = 0; i < out.length; i++) {
      if (this.outCount > 0) {
        out[i] = this.outRing[this.outRead];
        this.outRead = (this.outRead + 1) % this.outRing.length;
        this.outCount--;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }

  runHop(hopBuf) {
    const hop = this.hop;
    this.shiftHist();
    this.hist.set(hopBuf, this.hist.length - hop);

    const det = this.detector.detect(this.hist);
    const voiced = det.conf > 0.55 && det.rms > 0.004;

    let ratio = 1;
    let targetMidi = null;
    let cents = 0;
    if (voiced && det.freq > 0) {
      this.freqHistory.push(det.freq);
      if (this.freqHistory.length > 5) this.freqHistory.shift();
      const sorted = this.freqHistory.slice().sort((a, b) => a - b);
      const medFreq = sorted[Math.floor(sorted.length / 2)];

      const info = this.noteInfo(medFreq);
      const tgt = this.targetFor(info.midi);
      targetMidi = tgt;
      const tgtFreq = 440 * Math.pow(2, (tgt - 69) / 12);
      cents = Math.round(1200 * Math.log2(tgtFreq / medFreq));
      let r = tgtFreq / medFreq;
      r = 1 + (r - 1) * this.strength;
      if (this.bypass) r = 1;
      ratio = r;
    }

    const maxStep = 1.02;
    const cur = this.ratio;
    let step = ratio / cur;
    if (step > maxStep) step = maxStep;
    if (step < 1 / maxStep) step = 1 / maxStep;
    this.ratio = Math.max(0.5, Math.min(2, cur * step));
    const shift = this.ratio;

    const hopOut = new Float32Array(hop);
    this.shifter.process(shift, hopBuf, hopOut);

    const mix = this.mix;
    for (let i = 0; i < hop; i++) {
      hopOut[i] = hopOut[i] * mix + hopBuf[i] * (1 - mix) * 0.9;
      if (hopOut[i] > 1) hopOut[i] = 1;
      else if (hopOut[i] < -1) hopOut[i] = -1;
    }

    for (let i = 0; i < hop; i++) {
      const idx = this.outWrite;
      this.outRing[idx] = hopOut[i];
      this.outWrite = (this.outWrite + 1) % this.outRing.length;
      this.outCount++;
    }

    const info = det.freq > 0 ? this.noteInfo(det.freq) : { name: '--', cents: 0 };
    this.port.postMessage({
      type: 'tuner',
      freq: Math.round(det.freq * 10) / 10,
      conf: Math.round(det.conf * 100) / 100,
      rms: det.rms,
      note: info.name,
      cents: info.cents,
      targetNote: targetMidi !== null ? this.midiName(targetMidi) : info.name,
      centsToTarget: cents,
      ratio: Math.round(shift * 1000) / 1000,
      voiced,
    });
  }

  midiName(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const octave = Math.floor(Math.round(midi) / 12) - 1;
    return names[pc] + octave;
  }

  shiftHist() {
    const hist = this.hist;
    const len = hist.length;
    for (let i = 0; i < len - this.hop; i++) hist[i] = hist[i + this.hop];
  }
}

registerProcessor('pitch-processor', PitchProcessor);
