/**
 * マイク／PC音声を 16bit PCM にして main へ返す AudioWorklet。
 *
 * AudioContext を 16000Hz で作ってあるので、ここに来る時点で 16kHz。
 * 128サンプルずつ届くので、IPCの回数を減らすため 100ms（1600サンプル）ためて送る。
 * レベル表示（REC-3）用に RMS とピークも一緒に返す。
 */
const BLOCK_SAMPLES = 1600 // 100ms @16kHz

class AdePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(BLOCK_SAMPLES)
    this.filled = 0
    this.sumSquares = 0
    this.peak = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]))
      this.sumSquares += sample * sample
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > this.peak) this.peak = magnitude
      this.buffer[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff

      if (this.filled === BLOCK_SAMPLES) {
        const samples = this.buffer
        this.buffer = new Int16Array(BLOCK_SAMPLES)
        this.filled = 0
        const rms = Math.sqrt(this.sumSquares / BLOCK_SAMPLES)
        this.port.postMessage({ samples, rms, peak: this.peak }, [samples.buffer])
        this.sumSquares = 0
        this.peak = 0
      }
    }
    return true
  }
}

registerProcessor('ade-pcm', AdePcmProcessor)
