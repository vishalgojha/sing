export class FFT {
  constructor(size) {
    this.size = size;
    this.twR = [];
    this.twI = [];
    let len = 2;
    while (len <= size) {
      const half = len >> 1;
      const aR = new Float64Array(half);
      const aI = new Float64Array(half);
      const ang = (2 * Math.PI) / len;
      for (let k = 0; k < half; k++) {
        aR[k] = Math.cos(ang * k);
        aI[k] = Math.sin(ang * k);
      }
      this.twR.push(aR);
      this.twI.push(aI);
      len <<= 1;
    }
  }

  transform(buf, inverse) {
    const n = this.size;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const x = i * 2;
        const y = j * 2;
        let t = buf[x];
        buf[x] = buf[y];
        buf[y] = t;
        t = buf[x + 1];
        buf[x + 1] = buf[y + 1];
        buf[y + 1] = t;
      }
    }
    const twR = this.twR;
    const twI = this.twI;
    const sign = inverse ? 1 : -1;
    let stage = 0;
    let len = 2;
    while (len <= n) {
      const half = len >> 1;
      const aR = twR[stage];
      const aI = twI[stage];
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const idx = i + k;
          const jdx = idx + half;
          const wr = aR[k];
          const wi = sign * aI[k];
          const ar = buf[2 * idx];
          const ai = buf[2 * idx + 1];
          const br = buf[2 * jdx] * wr - buf[2 * jdx + 1] * wi;
          const bi = buf[2 * jdx] * wi + buf[2 * jdx + 1] * wr;
          buf[2 * idx] = ar + br;
          buf[2 * idx + 1] = ai + bi;
          buf[2 * jdx] = ar - br;
          buf[2 * jdx + 1] = ai - bi;
        }
      }
      len <<= 1;
      stage++;
    }
    if (inverse) {
      for (let i = 0; i < n * 2; i++) buf[i] /= n;
    }
  }
}

export class PitchDetector {
  constructor(sampleRate, win = 1024) {
    this.sampleRate = sampleRate;
    this.win = win;
    this.tauMin = Math.max(10, Math.floor(sampleRate / 1600));
    this.tauMax = Math.floor(sampleRate / 62);
    this.prevTau = 0;
    this.prevConf = 0;
    this.nsdf = new Float64Array(this.tauMax + 1);
  }

  detect(hist) {
    const W = this.win;
    const tauMin = this.tauMin;
    const tauMax = Math.min(this.tauMax, hist.length - W - 2);
    const nsdf = this.nsdf;
    let e0 = 0;
    for (let j = 0; j < W; j++) e0 += hist[j] * hist[j];
    const rms = Math.sqrt(e0 / W);

    let low = tauMin;
    let high = tauMax;
    if (this.prevTau >= tauMin && this.prevTau <= tauMax && this.prevConf > 0.6) {
      low = Math.max(tauMin, Math.floor(this.prevTau * 0.8));
      high = Math.min(tauMax, Math.ceil(this.prevTau * 1.25));
    }

    for (let tau = low; tau <= high; tau++) {
      let r = 0;
      let eTau = 0;
      for (let j = 0; j < W; j++) {
        const v = hist[j + tau];
        r += hist[j] * v;
        eTau += v * v;
      }
      const denom = e0 * eTau;
      nsdf[tau] = denom > 1e-12 ? r / Math.sqrt(denom) : 0;
    }

    let gMax = -Infinity;
    for (let tau = low; tau <= high; tau++) {
      if (nsdf[tau] > gMax) gMax = nsdf[tau];
    }

    let freq = 0;
    let conf = gMax;
    let bestTau = -1;
    let bestV = -Infinity;

    if (gMax > 0.35) {
      const threshold = 0.9 * gMax;
      const valleyLimit = 0.4 * gMax;
      let sawValley = nsdf[low] < valleyLimit;
      let prev = nsdf[low];
      for (let tau = low + 1; tau < high; tau++) {
        const cur = nsdf[tau];
        if (cur < valleyLimit) sawValley = true;
        if (cur >= prev && cur > nsdf[tau + 1] && cur >= threshold && sawValley) {
          bestTau = tau;
          bestV = cur;
          break;
        }
        prev = cur;
      }
      if (bestTau < 0 && gMax >= threshold) {
        bestTau = low;
        bestV = gMax;
        for (let tau = low; tau <= high; tau++) {
          if (nsdf[tau] === gMax) {
            bestTau = tau;
            break;
          }
        }
      }
      if (bestTau >= 0) {
        let tauF = bestTau;
        if (bestTau > low && bestTau < high) {
          const y0 = nsdf[bestTau - 1];
          const y1 = nsdf[bestTau];
          const y2 = nsdf[bestTau + 1];
          const denom = y0 - 2 * y1 + y2;
          if (Math.abs(denom) > 1e-12) {
            const d = (0.5 * (y0 - y2)) / denom;
            tauF = bestTau + Math.max(-0.5, Math.min(0.5, d));
          }
        }
        freq = this.sampleRate / tauF;
        conf = bestV;
      }
    }

    this.prevTau = freq > 0 ? this.sampleRate / freq : 0;
    this.prevConf = conf;
    return { freq, conf, rms, tau: freq > 0 ? this.sampleRate / freq : 0 };
  }
}

export class PitchShifter {
  constructor(sampleRate, fftFrameSize = 2048, osamp = 4) {
    this.sampleRate = sampleRate;
    this.N = fftFrameSize;
    this.osamp = osamp;
    this.hop = Math.max(1, Math.floor(fftFrameSize / osamp));
    this.inFifoLatency = fftFrameSize - this.hop;
    this.window = new Float64Array(fftFrameSize);
    for (let k = 0; k < fftFrameSize; k++) {
      this.window[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / fftFrameSize);
    }
    this.fft = new FFT(fftFrameSize);
    this.inFifo = new Float64Array(fftFrameSize);
    this.outFifo = new Float64Array(fftFrameSize);
    this.outAccum = new Float64Array(2 * fftFrameSize);
    this.fftWorksp = new Float64Array(fftFrameSize * 2);
    this.lastPhase = new Float64Array(fftFrameSize / 2 + 1);
    this.sumPhase = new Float64Array(fftFrameSize / 2 + 1);
    this.anaMagn = new Float64Array(fftFrameSize / 2 + 1);
    this.anaFreq = new Float64Array(fftFrameSize / 2 + 1);
    this.rover = this.inFifoLatency;
    this.expct = (2 * Math.PI * this.hop) / fftFrameSize;
    this.freqPerBin = sampleRate / fftFrameSize;
  }

  process(pitchShift, hopIn, hopOut) {
    const hop = this.hop;
    const lat = this.inFifoLatency;
    for (let i = 0; i < hop; i++) {
      this.inFifo[this.rover] = hopIn[i];
      hopOut[i] = this.outFifo[this.rover - lat];
      this.rover++;
      if (this.rover >= this.N) {
        this.rover = lat;
        this.frame(pitchShift);
      }
    }
  }

  frame(pitchShift) {
    const N = this.N;
    const half = N >> 1;
    const os = this.osamp;
    const hop = this.hop;
    const w = this.window;
    const ws = this.fftWorksp;
    for (let k = 0; k < N; k++) {
      ws[2 * k] = this.inFifo[k] * w[k];
      ws[2 * k + 1] = 0;
    }
    this.fft.transform(ws, false);

    const fpb = this.freqPerBin;
    const expct = this.expct;
    for (let k = 0; k <= half; k++) {
      const re = ws[2 * k];
      const im = ws[2 * k + 1];
      const magn = 2 * Math.sqrt(re * re + im * im);
      const phase = Math.atan2(im, re);
      let tmp = phase - this.lastPhase[k];
      this.lastPhase[k] = phase;
      tmp -= k * expct;
      tmp = ((tmp + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      tmp = (os * tmp) / (2 * Math.PI);
      this.anaFreq[k] = (k * fpb + tmp * fpb) * pitchShift;
      this.anaMagn[k] = magn;
    }

    for (let k = 0; k <= half; k++) {
      const magn = this.anaMagn[k];
      let tmp = ((this.anaFreq[k] / fpb - k) * 2 * Math.PI) / os;
      tmp += k * expct;
      this.sumPhase[k] += tmp;
      ws[2 * k] = magn * Math.cos(this.sumPhase[k]);
      ws[2 * k + 1] = magn * Math.sin(this.sumPhase[k]);
    }
    for (let k = N + 2; k < 2 * N; k++) ws[k] = 0;
    this.fft.transform(ws, true);

    const oa = this.outAccum;
    const scale = 8 / (3 * os);
    for (let k = 0; k < N; k++) {
      oa[k] += scale * w[k] * ws[2 * k];
    }
    for (let k = 0; k < hop; k++) this.outFifo[k] = oa[k];
    for (let k = 0; k < N; k++) oa[k] = oa[k + hop];
    for (let k = N; k < 2 * N; k++) oa[k] = 0;
    for (let k = 0; k < this.inFifoLatency; k++) {
      this.inFifo[k] = this.inFifo[k + hop];
    }
  }
}
