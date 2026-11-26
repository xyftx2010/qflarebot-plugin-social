import { describe, expect, it } from 'vitest'
import { runCommand } from '@qqbot/sdk/testing'
import plugin from '../src/index.js'
import { defaultConfig } from '../src/config.js'
import { generateTestToneWav } from '../src/voice/probe.js'

describe('voice phase-1 probe', () => {
  it('generates a valid RIFF/WAVE PCM test audio buffer', () => {
    const buf = generateTestToneWav(500, 24_000)
    expect(buf.byteLength).toBe(44 + 12_000 * 2)
    const header = new TextDecoder().decode(new Uint8Array(buf, 0, 4))
    const wave = new TextDecoder().decode(new Uint8Array(buf, 8, 4))
    expect(header).toBe('RIFF')
    expect(wave).toBe('WAVE')
  })

  it('sends wav-b64 and wav-url voice messages via official SDK media.type=voice', async () => {
    const sB64 = await runCommand(plugin, 'social voicetest', 'wav-b64', {
      session: { scene: 'group', targetId: 'g-voice', memberRole: 'admin' },
      ctx: { config: defaultConfig },
    })
    expect(sB64.replies).toHaveLength(2)
    expect(sB64.replies[0]).toMatchObject({
      media: { type: 'voice', filename: 'test.wav', base64: expect.any(String) },
    })
    expect(String(sB64.replies[1])).toContain('语音发送回执：成功 (wav-b64)')

    const sUrl = await runCommand(plugin, 'social voicetest', 'wav-url', {
      session: { scene: 'group', targetId: 'g-voice', memberRole: 'admin' },
      ctx: { config: defaultConfig, publicUrl: 'https://bot.example.com' },
    })
    expect(sUrl.replies[0]).toMatchObject({
      media: {
        type: 'voice',
        url: 'https://bot.example.com/p/social/voice-test/sample.wav',
        filename: 'test.wav',
      },
    })
  })
})
