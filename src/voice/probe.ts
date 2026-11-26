import { arrayBufferToBase64 } from '../vision/media.js'

/**
 * 第一阶段语音发送可行性验证：生成标准 1 秒 24kHz 16-bit 单声道 WAV 测试提示音（440Hz 正弦波，约 48KB）。
 * 无任何外部依赖，零静态大文件入库，方便实测 QQ file_type=3 对 WAV Base64 与 URL 的原生语音兼容性。
 */
export function generateTestToneWav(durationMs = 1000, sampleRate = 24_000, freqHz = 440): ArrayBuffer {
  const numSamples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000))
  const dataSize = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  // RIFF/WAVE header (PCM s16le, mono)
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  const fadeSamples = Math.min(480, Math.floor(numSamples / 10))
  for (let i = 0; i < numSamples; i++) {
    let env = 1
    if (i < fadeSamples) env = i / fadeSamples
    else if (i > numSamples - fadeSamples) env = (numSamples - i) / fadeSamples
    const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.35 * env
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true)
  }

  return buffer
}

export function generateTestToneWavBase64(durationMs = 1000): string {
  return arrayBufferToBase64(generateTestToneWav(durationMs))
}
