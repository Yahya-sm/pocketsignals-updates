// Writes the signal sounds of ui/sounds.js as WAV files for the phone's notification channels:
// android/app/src/main/res/raw/sig_<key>.wav (16-bit mono, 22 kHz). Run after changing ui/sounds.js.
const fs = require('fs'), path = require('path');
const { SOUNDS } = require('../ui/sounds');
const RATE = 22050, out = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'raw');
fs.mkdirSync(out, { recursive: true });
const wave = (type, ph) => {
  const x = ph % 1;
  return type === 'square' ? (x < 0.5 ? 1 : -1) : type === 'triangle' ? 4 * Math.abs(x - 0.5) - 1 : type === 'sawtooth' ? 2 * x - 1 : Math.sin(2 * Math.PI * x);
};
for (const [key, tones] of Object.entries(SOUNDS)) {
  if (!tones.length) continue; // "none": the channel has no sound
  const len = Math.max(...tones.map(([, t0, d]) => t0 + d)) + 0.05, n = Math.round(len * RATE), buf = new Float32Array(n);
  for (const [f, t0, d, g, type] of tones) {
    const s0 = Math.round(t0 * RATE), sn = Math.round(d * RATE);
    for (let k = 0; k < sn && s0 + k < n; k++) {
      const env = Math.exp(-5 * k / sn) * Math.min(1, k / (0.005 * RATE)); // short attack, decay like the app's gain ramp
      buf[s0 + k] += g * env * wave(type, f * k / RATE);
    }
  }
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVE', 8); pcm.write('fmt ', 12);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(RATE, 24);
  pcm.writeUInt32LE(RATE * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let k = 0; k < n; k++) pcm.writeInt16LE(Math.max(-1, Math.min(1, buf[k] * 2.5)) * 32767 | 0, 44 + k * 2);
  fs.writeFileSync(path.join(out, `sig_${key}.wav`), pcm);
  console.log(`sig_${key}.wav ${(pcm.length / 1024).toFixed(0)} KB`);
}
