export class GameAudio {
  private ctx: AudioContext | null = null;
  private wind: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  enabled = true;
  init() { if (!this.enabled) return; try { this.ctx ??= new AudioContext(); void this.ctx.resume(); } catch { /* Audio is optional. */ } }
  tone(freq = 520, type: OscillatorType = 'sine', duration = .08, volume = .07) {
    const ctx = this.ctx; if (!ctx || !this.enabled) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + duration);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + duration);
  }
  noise(duration = .08, volume = .12) {
    const ctx = this.ctx; if (!ctx || !this.enabled) return;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate), values = buffer.getChannelData(0);
    for (let i = 0; i < values.length; i++) values[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(), gain = ctx.createGain(), filter = ctx.createBiquadFilter(); src.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = 600;
    gain.gain.setValueAtTime(volume, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + duration);
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination); src.start();
  }
  startWind() {
    this.stopWind(); const ctx = this.ctx; if (!ctx || !this.enabled) return;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), values = buffer.getChannelData(0);
    for (let i = 0; i < values.length; i++) values[i] = Math.random() * 2 - 1;
    this.wind = ctx.createBufferSource(); this.wind.buffer = buffer; this.wind.loop = true;
    this.windGain = ctx.createGain(); this.windGain.gain.value = .035; const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 450;
    this.wind.connect(filter); filter.connect(this.windGain); this.windGain.connect(ctx.destination); this.wind.start();
  }
  stopWind() { try { this.wind?.stop(); this.wind?.disconnect(); } catch { /* Already stopped. */ } this.wind = null; this.windGain = null; }
  toggle() { this.enabled = !this.enabled; if (!this.enabled) this.stopWind(); else this.init(); return this.enabled; }
}
