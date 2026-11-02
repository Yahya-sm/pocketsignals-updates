// Signal sounds, one per strategy (chosen in its settings). Each sound is a list of tones:
// [frequency Hz, start s, length s, volume 0–1, wave]. The same list is played in the app (Web Audio) and written as
// WAV files for the phone's notification channels (tools/make-sounds.js → android res/raw/sig_<key>.wav).
const __SOUNDS = {
  default: [[880, 0, 0.25, 0.18, 'sine'], [1175, 0.15, 0.25, 0.18, 'sine']],
  bell: [[1568, 0, 0.9, 0.22, 'sine'], [3136, 0, 0.5, 0.06, 'sine']],
  double: [[1000, 0, 0.12, 0.22, 'square'], [1000, 0.2, 0.12, 0.22, 'square']],
  beep: [[1400, 0, 0.15, 0.2, 'square']],
  rise: [[660, 0, 0.14, 0.2, 'triangle'], [880, 0.14, 0.14, 0.2, 'triangle'], [1175, 0.28, 0.22, 0.2, 'triangle']],
  fall: [[1175, 0, 0.14, 0.2, 'triangle'], [880, 0.14, 0.14, 0.2, 'triangle'], [660, 0.28, 0.22, 0.2, 'triangle']],
  gong: [[196, 0, 1.2, 0.3, 'sine'], [392, 0, 0.8, 0.12, 'sine']],
  alarm: [[1300, 0, 0.1, 0.2, 'sawtooth'], [900, 0.12, 0.1, 0.2, 'sawtooth'], [1300, 0.24, 0.1, 0.2, 'sawtooth'], [900, 0.36, 0.1, 0.2, 'sawtooth']],
  none: [],
};
if (typeof module !== 'undefined') module.exports = { SOUNDS: __SOUNDS, SOUND_KEYS: Object.keys(__SOUNDS) };
if (typeof window !== 'undefined') { window.SOUNDS = __SOUNDS; window.SOUND_KEYS = Object.keys(__SOUNDS); }
