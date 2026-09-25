const SCALES = {
  chromatic: { name: 'Chromatic (all notes)', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: 'Natural minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  majorPent: { name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPent: { name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  blues: { name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const $ = (id) => document.getElementById(id);

const els = {
  startBtn: $('startBtn'),
  statusBadge: $('statusBadge'),
  strength: $('strength'),
  strengthVal: $('strengthVal'),
  mix: $('mix'),
  mixVal: $('mixVal'),
  bypass: $('bypass'),
  monitor: $('monitor'),
  root: $('root'),
  scale: $('scale'),
  scaleDots: $('scaleDots'),
  reverb: $('reverb'),
  reverbVal: $('reverbVal'),
  roomSize: $('roomSize'),
  roomVal: $('roomVal'),
  noteLabel: $('noteLabel'),
  targetLabel: $('targetLabel'),
  freqVal: $('freqVal'),
  ratioVal: $('ratioVal'),
  confVal: $('confVal'),
  recordBtn: $('recordBtn'),
  recTime: $('recTime'),
  takes: $('takes'),
  meter: $('meter'),
  exercise: $('exercise'),
  mood: $('mood'),
  coachBtn: $('coachBtn'),
  coachMessage: $('coachMessage'),
  exerciseLabel: $('exerciseLabel'),
  overallScore: $('overallScore'),
  pitchScore: $('pitchScore'),
  rhythmScore: $('rhythmScore'),
  stabilityScore: $('stabilityScore'),
  pitchBar: $('pitchBar'),
  rhythmBar: $('rhythmBar'),
  stabilityBar: $('stabilityBar'),
};

const ctx2d = els.meter.getContext('2d');

let audioCtx = null;
let micStream = null;
let sourceNode = null;
let pitchNode = null;
let recorderNode = null;
let dryGain = null;
let sendGain = null;
let convolver = null;
let wetGain = null;
let masterGain = null;
let monitorGain = null;

let running = false;
let recording = false;
let recStart = 0;
let recChunks = [];
let recTimer = null;
let takes = [];
let lastTuner = { cents: 0, note: '-', conf: 0, freq: 0, voiced: false };
let currentAudio = null;
let scoreSamples = [];
let lastVoicedAt = 0;
let lastCoachText = '';
let feedbackHistory = [];
let sessionDb = null;

const EXERCISES = {
  sa: { label: 'Sa practice', target: 'Sa', hint: 'Hold Sa', targetMidi: 60 },
  sarega: { label: 'Sa Re Ga Ma', target: 'Sa → Re → Ga → Ma', hint: 'Sing the ascending pattern', targetMidi: 60 },
  saregaresasa: { label: 'Palta practice', target: 'Sa Re Ga Ma → Ga Re Sa', hint: 'Sing the pattern slowly', targetMidi: 60 },
};

function populateSelectors() {
  for (let i = 0; i < 12; i++) {
    const opt = document.createElement('option');
    opt.value = String(60 + i);
    opt.textContent = NOTE_NAMES[i] + 4;
    els.root.appendChild(opt);
  }
  els.root.value = '60';
  for (const key of Object.keys(SCALES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = SCALES[key].name;
    els.scale.appendChild(opt);
  }
  els.scale.value = 'major';
}

function renderScaleDots() {
  const ivs = SCALES[els.scale.value].intervals;
  els.scaleDots.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const d = document.createElement('span');
    d.className = 'scale-dot' + (ivs.includes(i) ? ' on' : '');
    d.textContent = NOTE_NAMES[i].replace('#', '#');
    d.title = NOTE_NAMES[i];
    els.scaleDots.appendChild(d);
  }
}

function currentParams() {
  return {
    type: 'params',
    strength: Number(els.strength.value) / 100,
    bypass: els.bypass.checked,
    mix: Number(els.mix.value) / 100,
    scaleIntervals: SCALES[els.scale.value].intervals,
    rootMidi: Number(els.root.value),
  };
}

function pushParams() {
  if (pitchNode && pitchNode.port) pitchNode.port.postMessage(currentParams());
}

function setStatus(live) {
  running = live;
  els.statusBadge.textContent = live ? 'live' : 'offline';
  els.statusBadge.className = 'badge ' + (live ? 'live' : 'idle');
  els.startBtn.textContent = live ? 'Stop microphone' : 'Start microphone';
}

function resetScore() {
  scoreSamples = [];
  lastVoicedAt = 0;
  els.coachBtn.disabled = true;
  ['overallScore', 'pitchScore', 'rhythmScore', 'stabilityScore'].forEach((id) => { els[id].textContent = '--'; });
  ['pitchBar', 'rhythmBar', 'stabilityBar'].forEach((id) => { els[id].style.width = '0%'; });
}

function openSessionDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sur-guru-sessions', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('takes', { keyPath: 'id' });
    request.onsuccess = () => { sessionDb = request.result; resolve(sessionDb); };
    request.onerror = () => reject(request.error);
  });
}

function saveTake(take) {
  if (!sessionDb) return;
  const tx = sessionDb.transaction('takes', 'readwrite');
  tx.objectStore('takes').put(take);
}

async function loadStoredTakes() {
  try {
    await openSessionDb();
    const request = sessionDb.transaction('takes', 'readonly').objectStore('takes').getAll();
    request.onsuccess = () => {
      takes = request.result.sort((a, b) => b.id - a.id);
      renderTakes();
    };
  } catch (error) {
    console.warn('Session storage unavailable', error);
  }
}

function updateScore(tuner) {
  if (!recording) return;
  if (!tuner.voiced || tuner.conf < 0.4 || !tuner.freq) return;
  const now = performance.now();
  const gap = lastVoicedAt ? now - lastVoicedAt : 0;
  scoreSamples.push({ cents: Math.abs(tuner.centsToTarget || tuner.cents || 0), gap, at: now });
  if (scoreSamples.length > 180) scoreSamples.shift();
  lastVoicedAt = now;
  if (scoreSamples.length < 5) return;
  renderScore(tuner);
}

function renderScore(tuner = lastTuner) {
  const recent = scoreSamples.slice(-100);
  const avgCents = recent.reduce((sum, item) => sum + item.cents, 0) / recent.length;
  const pitch = Math.max(0, Math.min(100, Math.round(100 - avgCents * 1.8)));
  const gaps = recent.slice(1).map((item) => item.gap).filter((gap) => gap > 0 && gap < 1500);
  const averageGap = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
  const rhythmVariance = gaps.length > 2 ? Math.sqrt(gaps.reduce((sum, gap) => sum + Math.pow(gap - averageGap, 2), 0) / gaps.length) : 0;
  const rhythm = Math.max(0, Math.min(100, Math.round(100 - rhythmVariance / 8)));
  const stability = Math.max(0, Math.min(100, Math.round(100 - Math.min(100, Math.abs((tuner.cents || 0) * 1.4)))));
  const overall = Math.round(pitch * 0.55 + rhythm * 0.2 + stability * 0.25);
  setScore('pitchScore', 'pitchBar', pitch);
  setScore('rhythmScore', 'rhythmBar', rhythm);
  setScore('stabilityScore', 'stabilityBar', stability);
  els.overallScore.textContent = overall;
}

function setScore(labelId, barId, value) {
  els[labelId].textContent = value;
  els[barId].style.width = `${value}%`;
}

async function speak(text) {
  lastCoachText = text;
  // The server proxy uses ElevenLabs when ELEVENLABS_API_KEY is configured.
  try {
    const response = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (response.ok) {
      const audio = new Audio(URL.createObjectURL(await response.blob()));
      await audio.play();
      return;
    }
  } catch {}
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'hi-IN';
    utterance.rate = els.mood.value === 'drill' ? 1.08 : 0.95;
    window.speechSynthesis.speak(utterance);
  }
}

function coachFeedback() {
  const samples = scoreSamples.slice(-100);
  if (samples.length < 5) return 'Pehle microphone start karo aur kam se kam kuch seconds gaaoge. Guru hawa mein marks nahi deta.';
  const score = Number(els.overallScore.textContent) || 0;
  const scores = {
    sur: Number(els.pitchScore.textContent) || 0,
    rhythm: Number(els.rhythmScore.textContent) || 0,
    stability: Number(els.stabilityScore.textContent) || 0,
  };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
  const lines = {
    praise: {
      sur: ['Sur ne aaj tumhe seen-zone nahi kiya', 'Aaj pitch ne tumhara naam yaad rakha', 'Sur ke saath aaj proper attendance thi'],
      rhythm: ['Taal ne tumhara appointment accept kiya', 'Aaj rhythm ne tumhe unfollow nahi kiya', 'Beat aur tum ek hi group chat mein the'],
      stability: ['Awaaz ne earthquake mode se break liya', 'Note ne aaj yoga kiya, kaafi stable tha', 'Aaj voice ne wobble ko chhutti de di'],
    },
    roast: {
      sur: ['Sur ko tumne GPS ke bina bhej diya', 'Note ko tumne miss kiya, woh abhi bhi waiting room mein hai', 'Pitch aur tumhari mulaqat bas traffic signal par hui'],
      rhythm: ['Taal tumse milne aayi thi, tum late pahunch gaye', 'Beat ne attendance lagayi, tumhara naam missing tha', 'Rhythm ko tumne seen karke reply nahi kiya'],
      stability: ['Note itna hil raha tha ki usko seatbelt chahiye', 'Awaaz ne roller-coaster ko serious competition diya', 'Sur khada tha, tumne usko trampoline bana diya'],
    },
    correction: {
      sur: ['drone suno aur note ke beech mein land karo', 'pehle Sa pakdo, phir gaana start karo', 'note ko chase mat karo, usko calmly invite karo'],
      rhythm: ['metronome ke saath dheere practice karo', 'pehle clap karo, phir gaaoge', 'har phrase ko ek steady walking pace do'],
      stability: ['ek note ko teen seconds seedha hold karo', 'volume kam rakho aur airflow smooth karo', 'note ko pakad kar rakho, uske saath wrestling mat karo'],
    },
  };
  const pick = (group, dimension) => {
    const options = lines[group][dimension].filter((line) => !feedbackHistory.includes(line));
    const line = (options.length ? options : lines[group][dimension])[Math.floor(Math.random() * (options.length || lines[group][dimension].length))];
    feedbackHistory.push(line);
    if (feedbackHistory.length > 8) feedbackHistory.shift();
    return line;
  };
  const praise = pick('praise', best[0]);
  const roast = pick('roast', weakest[0]);
  const correction = pick('correction', weakest[0]);
  const openers = {
    strict: ['Sun, superstar', 'Guru ki adalat mein', 'Beta, ek minute'],
    warm: ['Arre wah, singer ji', 'Pyaara effort', 'Chalo, sur ki taraf'],
    drill: ['Attention, vocalist', 'No excuses, singer', 'Mic sambhalo, champion'],
  };
  const opener = openers[els.mood.value][Math.floor(Math.random() * 3)];
  const verdict = weakest[1] < 55 ? `${roast}. ${correction}.` : `${roast}, par correction simple hai: ${correction}.`;
  return `${opener}: ${praise}! Lekin ${verdict} Score ${score}/100. Agli take mein comeback dikhao.`;
}

async function buildGraph() {
  const sr = 48000;
  audioCtx = new AudioContext({ sampleRate: sr, latencyHint: 'interactive' });
  await audioCtx.resume();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  await audioCtx.audioWorklet.addModule('worklet/pitch-processor.js');
  await audioCtx.audioWorklet.addModule('worklet/recorder-processor.js');

  sourceNode = audioCtx.createMediaStreamSource(micStream);
  pitchNode = new AudioWorkletNode(audioCtx, 'pitch-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
    processorOptions: { sampleRate: sr },
  });

  recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
  });

  dryGain = audioCtx.createGain();
  sendGain = audioCtx.createGain();
  wetGain = audioCtx.createGain();
  masterGain = audioCtx.createGain();
  monitorGain = audioCtx.createGain();
  convolver = audioCtx.createConvolver();

  buildImpulseResponse(audioCtx, convolver, Number(els.roomSize.value));

  sourceNode.connect(pitchNode);
  pitchNode.connect(dryGain);
  dryGain.connect(masterGain);
  dryGain.connect(sendGain);
  sendGain.connect(convolver);
  convolver.connect(wetGain);
  wetGain.connect(masterGain);
  masterGain.connect(recorderNode);
  recorderNode.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);

  masterGain.gain.value = 0.9;
  monitorGain.gain.value = els.monitor.checked ? 1 : 0;
  updateReverb();

  pitchNode.port.onmessage = (e) => {
    if (e.data && e.data.type === 'tuner') {
      lastTuner = e.data;
      updateScore(e.data);
    }
  };

  recorderNode.port.onmessage = (e) => {
    if (e.data && e.data.type === 'audio') recChunks.push(e.data.buf);
  };

  pushParams();
}

function buildImpulseResponse(audioCtx, convolver, sizePct) {
  const seconds = 0.8 + (sizePct / 100) * 2.2;
  const len = Math.floor(audioCtx.sampleRate * seconds);
  const buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / audioCtx.sampleRate;
      const decay = Math.exp(-t * (1.2 + sizePct * 0.05));
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  convolver.buffer = buf;
}

function updateReverb() {
  const amt = Number(els.reverb.value) / 100;
  sendGain.gain.value = amt * 0.9;
  wetGain.gain.value = amt * 0.9;
}

async function startEngine() {
  try {
    await buildGraph();
    setStatus(true);
  } catch (err) {
    setStatus(false);
    console.error(err);
    alert('Could not start microphone: ' + err.message);
  }
}

function stopEngine() {
  if (recording) stopRecording();
  if (pitchNode) {
    try { pitchNode.disconnect(); } catch {}
  }
  if (sourceNode) sourceNode.disconnect();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  pitchNode = recorderNode = sourceNode = micStream = null;
  resetScore();
  setStatus(false);
}

els.startBtn.addEventListener('click', () => {
  if (running) stopEngine();
  else startEngine();
});

// ---- Tuner drawing ----
function drawTuner() {
  const w = els.meter.width;
  const h = els.meter.height;
  const cx = w / 2;
  const cy = h / 2;
  ctx2d.clearRect(0, 0, w, h);

  const show = lastTuner.voiced && lastTuner.conf > 0.4;
  const cents = show ? Math.max(-50, Math.min(50, lastTuner.cents)) : 0;

  ctx2d.strokeStyle = '#2a3350';
  ctx2d.lineWidth = 2;
  for (let c = -50; c <= 50; c += 10) {
    const x = cx + (c / 50) * (w / 2 - 30);
    ctx2d.beginPath();
    ctx2d.moveTo(x, cy - 26);
    ctx2d.lineTo(x, cy + 26);
    ctx2d.stroke();
  }

  ctx2d.fillStyle = '#8b949e';
  ctx2d.font = '12px Inter, sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.fillText('-50', 32, cy - 34);
  ctx2d.fillText('0', cx, cy - 34);
  ctx2d.fillText('+50', w - 32, cy - 34);

  ctx2d.strokeStyle = '#3fb950';
  ctx2d.lineWidth = 3;
  ctx2d.beginPath();
  ctx2d.moveTo(cx, cy - 26);
  ctx2d.lineTo(cx, cy + 26);
  ctx2d.stroke();

  if (show) {
    const color = Math.abs(cents) <= 5 ? '#3fb950' : Math.abs(cents) <= 15 ? '#d29922' : '#f85149';
    const x = cx + (cents / 50) * (w / 2 - 30);
    ctx2d.fillStyle = color;
    ctx2d.shadowColor = color;
    ctx2d.shadowBlur = 14;
    ctx2d.beginPath();
    ctx2d.moveTo(x, cy - 36);
    ctx2d.lineTo(x - 9, cy - 14);
    ctx2d.lineTo(x + 9, cy - 14);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.shadowBlur = 0;
  }

  els.noteLabel.textContent = lastTuner.voiced ? lastTuner.note : '-';
  els.targetLabel.textContent = lastTuner.voiced
    ? `target: ${lastTuner.targetNote} (${lastTuner.centsToTarget >= 0 ? '+' : ''}${lastTuner.centsToTarget} cents)`
    : 'target: -';
  els.freqVal.textContent = lastTuner.voiced ? lastTuner.freq + ' Hz' : '-';
  els.ratioVal.textContent = lastTuner.voiced ? 'x' + lastTuner.ratio : '-';
  els.confVal.textContent = lastTuner.voiced ? lastTuner.conf.toFixed(2) : '-';

  requestAnimationFrame(drawTuner);
}

// ---- Recording ----
function startRecording() {
  if (!running || !recorderNode) return;
  resetScore();
  recording = true;
  recChunks = [];
  recStart = performance.now();
  els.recordBtn.textContent = '● Stop';
  els.recordBtn.classList.add('recording');
  recorderNode.port.postMessage({ type: 'record', on: true });
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    els.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  if (scoreSamples.length >= 5) {
    renderScore();
    els.coachBtn.disabled = false;
    els.coachMessage.textContent = 'Take captured. Now ask the Guru for feedback.';
  }
  clearInterval(recTimer);
  els.recordBtn.textContent = '● Record';
  els.recordBtn.classList.remove('recording');
  if (recorderNode && recorderNode.port) recorderNode.port.postMessage({ type: 'record', on: false });

  let len = 0;
  for (const c of recChunks) len += c.length;
  if (len === 0) return;
  const samples = new Float32Array(len);
  let off = 0;
  for (const c of recChunks) {
    samples.set(c, off);
    off += c.length;
  }
  const sr = audioCtx ? audioCtx.sampleRate : 48000;
  const seconds = samples.length / sr;
  const num = takes.length + 1;
  const take = {
    id: Date.now(),
    name: `Take ${num}`,
    seconds,
    wav: encodeWav(samples, sr),
  };
  takes.unshift(take);
  saveTake(take);
  els.recTime.textContent = '0:00';
  renderTakes();
}

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const boost = peak > 0 ? Math.min(2.2, 0.92 / peak) : 1;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    let s = samples[i] * boost;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buffer;
}

function renderTakes() {
  els.takes.innerHTML = '';
  if (takes.length === 0) {
    els.takes.innerHTML = '<li class="empty-takes">No takes yet. Hit record and sing!</li>';
    return;
  }
  for (const take of takes) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'take-name';
    name.textContent = take.name;
    const dur = document.createElement('span');
    dur.className = 'take-dur';
    dur.textContent = `${take.seconds.toFixed(1)}s`;
    const play = document.createElement('button');
    play.textContent = 'Play';
    play.className = 'playback';
    const dl = document.createElement('button');
    dl.textContent = 'Download';
    dl.addEventListener('click', () => {
      const blob = new Blob([take.wav], { type: 'audio/wav' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${take.name.replace(/\s+/g, '-').toLowerCase()}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    const share = document.createElement('button');
    share.textContent = 'Share video';
    share.className = 'share-video';
    share.addEventListener('click', async () => {
      share.disabled = true;
      share.textContent = 'Making video...';
      try {
        await shareTakeVideo(take);
      } catch (error) {
        console.error(error);
        alert('Could not create the share video: ' + error.message);
      } finally {
        share.disabled = false;
        share.textContent = 'Share video';
      }
    });
    play.addEventListener('click', () => {
      togglePlayback(take, play);
    });
    li.append(name, dur, play, dl, share);
    els.takes.appendChild(li);
  }
}

async function shareTakeVideo(take) {
  const context = audioCtx || new AudioContext();
  await context.resume();
  if (!HTMLCanvasElement.prototype.captureStream || !window.MediaRecorder) {
    return shareTakeAudio(take, context);
  }
  const buffer = await context.decodeAudioData(take.wav.slice(0));
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d');
  const visual = context.createAnalyser();
  visual.fftSize = 512;
  const destination = context.createMediaStreamDestination();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(visual);
  visual.connect(destination);

  const videoStream = canvas.captureStream(30);
  destination.stream.getAudioTracks().forEach((track) => videoStream.addTrack(track));
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('This browser cannot create share videos');

  const chunks = [];
  const recorder = new MediaRecorder(videoStream, { mimeType: mime, videoBitsPerSecond: 2500000 });
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const finished = new Promise((resolve) => { recorder.onstop = resolve; });
  const frequency = new Uint8Array(visual.frequencyBinCount);
  const start = performance.now();
  let animation;
  const draw = () => {
    const elapsed = (performance.now() - start) / 1000;
    const progress = Math.min(1, elapsed / buffer.duration);
    visual.getByteFrequencyData(frequency);
    const average = frequency.reduce((sum, value) => sum + value, 0) / frequency.length;
    const gradient = ctx.createLinearGradient(0, 0, 720, 1280);
    gradient.addColorStop(0, '#111a35');
    gradient.addColorStop(1, '#0d1117');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 720, 1280);
    ctx.fillStyle = '#4cc9f0';
    ctx.globalAlpha = 0.14;
    ctx.beginPath();
    ctx.arc(360, 470, 170 + average * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e6edf3';
    ctx.font = '700 44px sans-serif';
    ctx.fillText('SUR GURU', 54, 100);
    ctx.fillStyle = '#8b949e';
    ctx.font = '24px sans-serif';
    ctx.fillText('My riyaaz take', 56, 145);
    ctx.fillStyle = '#4cc9f0';
    ctx.font = '700 110px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', 360, 510);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6edf3';
    ctx.font = '600 30px sans-serif';
    ctx.fillText(`${take.name}  •  ${take.seconds.toFixed(1)}s`, 56, 1110);
    ctx.fillStyle = '#2a3350';
    ctx.fillRect(56, 1160, 608, 8);
    ctx.fillStyle = '#7c5cff';
    ctx.fillRect(56, 1160, 608 * progress, 8);
    if (progress < 1) animation = requestAnimationFrame(draw);
  };
  recorder.start();
  source.start();
  draw();
  await new Promise((resolve) => { source.onended = resolve; });
  cancelAnimationFrame(animation);
  recorder.stop();
  await finished;
  videoStream.getTracks().forEach((track) => track.stop());
  const blob = new Blob(chunks, { type: mime });
  const file = new File([blob], `${take.name.replace(/\s+/g, '-').toLowerCase()}.webm`, { type: mime });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ title: 'My Sur Guru riyaaz', files: [file] });
    return;
  }
  if (navigator.share) return shareTakeAudio(take, context);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

async function shareTakeAudio(take, context) {
  const file = new File([take.wav], `${take.name.replace(/\s+/g, '-').toLowerCase()}.wav`, { type: 'audio/wav' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ title: 'My Sur Guru riyaaz audio', files: [file] });
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([take.wav], { type: 'audio/wav' }));
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

async function togglePlayback(take, btn) {
  if (!audioCtx) audioCtx = new AudioContext({ latencyHint: 'interactive' });
  await audioCtx.resume();
  if (currentAudio) {
    const previousTakeId = currentAudio.takeId;
    stopPlayback();
    if (previousTakeId === take.id) {
      btn.classList.remove('active');
      return;
    }
  }
  const buf = await audioCtx.decodeAudioData(take.wav.slice(0));
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const g = audioCtx.createGain();
  const compressor = audioCtx.createDynamicsCompressor();
  g.gain.value = 1.35;
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.18;
  src.connect(g);
  g.connect(compressor);
  compressor.connect(audioCtx.destination);
  src.onended = () => {
    currentAudio = null;
    document.querySelectorAll('.playback').forEach((b) => b.classList.remove('active'));
  };
  src.start();
  currentAudio = { src, takeId: take.id };
  btn.classList.add('active');
}

function stopPlayback() {
  if (!currentAudio) return;
  try { currentAudio.src.stop(); } catch {}
  currentAudio = null;
}

els.recordBtn.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

els.exercise.addEventListener('change', () => {
  const exercise = EXERCISES[els.exercise.value];
  els.exerciseLabel.textContent = exercise.label;
  els.coachMessage.textContent = `${exercise.hint}. Jab taiyaar ho, microphone start karo.`;
  resetScore();
});

els.coachBtn.addEventListener('click', () => {
  const text = coachFeedback();
  els.coachMessage.textContent = text;
  speak(text);
});

// ---- Event wiring ----
els.strength.addEventListener('input', () => {
  els.strengthVal.textContent = els.strength.value + '%';
  pushParams();
});
els.mix.addEventListener('input', () => {
  els.mixVal.textContent = els.mix.value === '100' ? '100% corrected' : els.mix.value + '% corrected';
  pushParams();
});
els.bypass.addEventListener('change', pushParams);
els.root.addEventListener('change', () => {
  renderScaleDots();
  pushParams();
});
els.scale.addEventListener('change', () => {
  renderScaleDots();
  pushParams();
});
els.reverb.addEventListener('input', () => {
  els.reverbVal.textContent = els.reverb.value + '%';
  updateReverb();
});
els.roomSize.addEventListener('input', () => {
  els.roomVal.textContent = els.roomSize.value + '%';
  if (audioCtx && convolver) buildImpulseResponse(audioCtx, convolver, Number(els.roomSize.value));
});
els.monitor.addEventListener('change', () => {
  if (monitorGain) monitorGain.gain.value = els.monitor.checked ? 1 : 0;
});

populateSelectors();
els.exerciseLabel.textContent = EXERCISES[els.exercise.value].label;
renderScaleDots();
resetScore();
loadStoredTakes();
drawTuner();
