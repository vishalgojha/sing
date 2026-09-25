class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'record') {
        this.recording = !!e.data.on;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (output && output.length > 0 && output[0]) {
      output[0].set(ch);
    }
    if (this.recording && ch) {
      const buf = ch.slice();
      this.port.postMessage({ type: 'audio', buf }, [buf.buffer]);
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
