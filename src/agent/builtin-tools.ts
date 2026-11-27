import type { PluginContext } from '@qqbot/sdk'
import type { LLMToolDefinition, SocialConfig } from '../types.js'
import { addGroupMemory, searchGroupMemories } from '../memory/store.js'
import { searchMemesByQuery } from '../meme/store.js'
import { validateImageUrl } from '../vision/media.js'

export interface BuiltinToolMeta {
  id: string
  wireName: string
  description: string
  sideEffect: 'none' | 'workspace_write'
  requiresApiKey?: boolean
  parameters: Record<string, unknown>
}

export interface BuiltinToolRunContext {
  ctx: PluginContext<SocialConfig>
  conversationId: string
  now: number
  timeoutMs: number
  fetchImpl: typeof fetch
  random?: () => number
}

export const BUILTIN_TOOLS: readonly BuiltinToolMeta[] = [
  {
    id: 'social.get_time',
    wireName: 'social_get_time',
    description: '获取当前北京时间（年月日、星期、时段），用于回答现在几点、今天周几或结合时间自然互动。',
    sideEffect: 'none',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    id: 'social.weather',
    wireName: 'social_weather',
    description: '查询指定城市的实时天气（温度、天气现象、风速），适合回答群友问天气。',
    sideEffect: 'none',
    parameters: {
      type: 'object',
      required: ['city'],
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: '城市名称，例如 北京、上海、Tokyo', minLength: 1, maxLength: 40 },
      },
    },
  },
  {
    id: 'social.search_memory',
    wireName: 'social_search_memory',
    description: '按关键词检索当前群内保存的长期记忆与群梗，仅限当前群聊。',
    sideEffect: 'none',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索关键词；留空返回最新记忆', maxLength: 60 },
        limit: { type: 'integer', description: '返回条数，1~15，默认 6', minimum: 1, maximum: 15 },
      },
    },
  },
  {
    id: 'social.search_memes',
    wireName: 'social_search_memes',
    description: '检索当前可用的表情包素材库，查看有哪些符合氛围的表情包标签与含义。',
    sideEffect: 'none',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '情绪或关键词，如 摸鱼、无语、搞笑', maxLength: 40 },
      },
    },
  },
  {
    id: 'social.remember_fact',
    wireName: 'social_remember_fact',
    description: '当群友明确要求记住某个公开群梗或约定事件时，写入本群长期记忆（自动拒绝隐私信息）。',
    sideEffect: 'workspace_write',
    parameters: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '要记住的简短群公共内容（4~100字）', minLength: 4, maxLength: 100 },
      },
    },
  },
  {
    id: 'social.roll',
    wireName: 'social_roll',
    description: '群聊娱乐随机工具：可掷骰子（如 1d20、2d6）或从候选项中随机抽一个（如今晚吃什么）。',
    sideEffect: 'none',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dice: { type: 'string', description: '骰子表达式，如 1d6、1d100（与 options 二选一）', maxLength: 16 },
        options: {
          type: 'array',
          description: '候选列表，随机抽取一项',
          items: { type: 'string', maxLength: 40 },
          maxItems: 20,
        },
      },
    },
  },
  {
    id: 'social.web_search',
    wireName: 'social_web_search',
    description: '联网搜索最新资讯、热梗、游戏攻略或日常知识（需配置联网搜索 API Key）。',
    sideEffect: 'none',
    requiresApiKey: true,
    parameters: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '搜索关键词', minLength: 1, maxLength: 120 },
      },
    },
  },
  {
    id: 'social.web_fetch',
    wireName: 'social_web_fetch',
    description: '读取指定公开网页的纯文本正文摘要（自动防内网 SSRF，限 2500 字）。',
    sideEffect: 'none',
    parameters: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: '以 https:// 或 http:// 开头的公开网页地址', minLength: 8, maxLength: 500 },
      },
    },
  },
]

const WEATHER_CODE_ZH: Readonly<Record<number, string>> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '密毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  80: '阵雨',
  81: '中阵雨',
  82: '强阵雨',
  95: '雷阵雨',
}

export function listEnabledBuiltinToolDefs(
  config: SocialConfig,
  enabledIds: readonly string[],
): LLMToolDefinition[] {
  const allowed = new Set(enabledIds)
  return BUILTIN_TOOLS.filter((t) => {
    if (!allowed.has(t.id)) return false
    if (t.requiresApiKey && !config.web_search_api_key.trim()) return false
    return true
  }).map((t) => ({
    name: t.wireName,
    description: t.description,
    parameters: t.parameters,
  }))
}

export function findBuiltinByWireName(wireName: string): BuiltinToolMeta | undefined {
  return BUILTIN_TOOLS.find((t) => t.wireName === wireName)
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function executeBuiltinTool(
  tool: BuiltinToolMeta,
  rawArgs: Record<string, unknown>,
  runCtx: BuiltinToolRunContext,
): Promise<{ ok: boolean; output: unknown; error?: string }> {
  const { ctx, conversationId, now, timeoutMs, fetchImpl } = runCtx
  const rng = runCtx.random ?? Math.random

  try {
    switch (tool.id) {
      case 'social.get_time': {
        const bjMs = now + 8 * 3600 * 1000
        const d = new Date(bjMs)
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
        const hour = d.getUTCHours()
        const period =
          hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上'
        return {
          ok: true,
          output: {
            beijingTime: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
            weekday: weekdays[d.getUTCDay()],
            period,
          },
        }
      }

      case 'social.weather': {
        const city = String(rawArgs.city ?? '').trim()
        if (!city) return { ok: false, output: null, error: '缺少城市名称 city' }
        const candidates = [city]
        if (/[市区县]$/.test(city) && city.length > 2) {
          candidates.push(city.replace(/[市区县]$/, ''))
        } else if (/^[\u4e00-\u9fa5]{2,4}$/.test(city)) {
          candidates.push(`${city}县`, `${city}市`)
        }
        let loc: { name: string; country?: string; latitude: number; longitude: number } | undefined
        for (const cand of candidates) {
          const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cand)}&count=1&language=zh&format=json`
          const geoRes = await fetchImpl(geoUrl, { signal: AbortSignal.timeout(timeoutMs) })
          if (!geoRes.ok) {
            if (cand === city) return { ok: false, output: null, error: `城市查询失败 (HTTP ${geoRes.status})` }
            continue
          }
          const geoJson = (await geoRes.json()) as {
            results?: Array<{ name: string; country?: string; latitude: number; longitude: number }>
          }
          if (geoJson.results?.[0]) {
            loc = geoJson.results[0]
            break
          }
        }
        if (!loc) return { ok: false, output: null, error: `未找到城市「${city}」，可尝试改查所属地级市` }

        const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Asia%2FShanghai`
        const wxRes = await fetchImpl(wxUrl, { signal: AbortSignal.timeout(timeoutMs) })
        if (!wxRes.ok) return { ok: false, output: null, error: `天气查询失败 (HTTP ${wxRes.status})` }
        const wxJson = (await wxRes.json()) as {
          current?: {
            temperature_2m?: number
            apparent_temperature?: number
            relative_humidity_2m?: number
            weather_code?: number
            wind_speed_10m?: number
          }
        }
        const cur = wxJson.current
        if (!cur) return { ok: false, output: null, error: '天气接口未返回当前天气数据' }
        return {
          ok: true,
          output: {
            city: loc.name,
            country: loc.country ?? '',
            condition: WEATHER_CODE_ZH[cur.weather_code ?? -1] ?? `天气码 ${cur.weather_code}`,
            temperatureC: cur.temperature_2m,
            feelsLikeC: cur.apparent_temperature,
            humidityPercent: cur.relative_humidity_2m,
            windSpeedKmh: cur.wind_speed_10m,
          },
        }
      }

      case 'social.search_memory': {
        const query = typeof rawArgs.query === 'string' ? rawArgs.query : ''
        const limit = typeof rawArgs.limit === 'number' ? Math.min(15, Math.max(1, Math.floor(rawArgs.limit))) : 6
        const list = await searchGroupMemories(ctx.db, conversationId, query, limit, now)
        return {
          ok: true,
          output: {
            count: list.length,
            memories: list.map((m) => ({
              scope: m.scope,
              userName: m.userName,
              content: m.content,
            })),
          },
        }
      }

      case 'social.search_memes': {
        const query = typeof rawArgs.query === 'string' ? rawArgs.query : ''
        const list = await searchMemesByQuery(
          ctx,
          query,
          {
            scope: ctx.config.share_memes_across_groups || ctx.config.use_global_meme_library ? 'all' : 'group',
            groupId: ctx.config.share_memes_across_groups ? undefined : conversationId,
            includeDisabled: false,
            limit: 8,
          },
          now,
        )
        return {
          ok: true,
          output: {
            count: list.length,
            memes: list.map((m) => ({
              id: m.id,
              meaning: m.meaning,
              mood: m.mood,
              tags: m.tags,
            })),
          },
        }
      }

      case 'social.remember_fact': {
        const content = String(rawArgs.content ?? '').trim()
        const res = await addGroupMemory(ctx.db, {
          groupId: conversationId,
          scope: 'group',
          content,
          ttlDays: ctx.config.memory_ttl_days,
          maxPerGroup: ctx.config.max_memories_per_group,
          now,
        })
        if (!res.ok) return { ok: false, output: null, error: res.reason }
        return { ok: true, output: { saved: true, id: res.memory.id, content: res.memory.content } }
      }

      case 'social.roll': {
        const options = Array.isArray(rawArgs.options)
          ? rawArgs.options.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          : []
        if (options.length > 0) {
          const picked = options[Math.floor(rng() * options.length)]!
          return { ok: true, output: { mode: 'pick', picked, totalOptions: options.length } }
        }
        const diceStr = String(rawArgs.dice ?? '1d100').trim().toLowerCase()
        const m = diceStr.match(/^(\d{1,2})d(\d{1,4})$/)
        if (!m) return { ok: false, output: null, error: '无效的骰子表达式，请使用如 1d20 或 2d6' }
        const count = Math.min(10, Math.max(1, Number(m[1])))
        const sides = Math.min(1000, Math.max(2, Number(m[2])))
        const rolls: number[] = []
        for (let i = 0; i < count; i++) rolls.push(Math.floor(rng() * sides) + 1)
        return {
          ok: true,
          output: { mode: 'dice', expression: `${count}d${sides}`, rolls, total: rolls.reduce((a, b) => a + b, 0) },
        }
      }

      case 'social.web_search': {
        const query = String(rawArgs.query ?? '').trim()
        const apiKey = ctx.config.web_search_api_key.trim()
        if (!apiKey) return { ok: false, output: null, error: '未配置联网搜索 API Key' }
        if (!query) return { ok: false, output: null, error: '缺少搜索关键词 query' }

        if (ctx.config.web_search_provider === 'bocha') {
          const res = await fetchImpl('https://api.bochaai.com/v1/web-search', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query, summary: true, count: 5 }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!res.ok) return { ok: false, output: null, error: `博查搜索失败 (HTTP ${res.status})` }
          const json = (await res.json()) as {
            data?: { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; summary?: string }> } }
          }
          const items = (json.data?.webPages?.value ?? []).slice(0, 5).map((r) => ({
            title: r.name ?? '',
            url: r.url ?? '',
            snippet: (r.summary || r.snippet || '').slice(0, 260),
          }))
          return { ok: true, output: { provider: 'bocha', query, results: items } }
        }

        const res = await fetchImpl('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: 'basic',
            max_results: 5,
            include_answer: true,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) return { ok: false, output: null, error: `Tavily 搜索失败 (HTTP ${res.status})` }
        const json = (await res.json()) as {
          answer?: string
          results?: Array<{ title?: string; url?: string; content?: string }>
        }
        return {
          ok: true,
          output: {
            provider: 'tavily',
            query,
            answer: json.answer?.slice(0, 400) ?? '',
            results: (json.results ?? []).slice(0, 5).map((r) => ({
              title: r.title ?? '',
              url: r.url ?? '',
              snippet: (r.content ?? '').slice(0, 260),
            })),
          },
        }
      }

      case 'social.web_fetch': {
        const url = String(rawArgs.url ?? '').trim()
        const invalid = validateImageUrl(url)
        if (invalid) return { ok: false, output: null, error: `网页地址被拒绝：${invalid}` }
        const res = await fetchImpl(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'text/html, text/plain, application/json' },
        })
        if (res.status >= 300 && res.status < 400) {
          return { ok: false, output: null, error: `网页发生重定向 (HTTP ${res.status})，请使用最终目标地址` }
        }
        if (!res.ok) return { ok: false, output: null, error: `网页读取失败 (HTTP ${res.status})` }
        const raw = (await res.text()).slice(0, 65_536)
        const text = stripHtmlToText(raw).slice(0, 2500)
        return { ok: true, output: { url, text } }
      }

      default:
        return { ok: false, output: null, error: `未知内置工具：${tool.id}` }
    }
  } catch (err) {
    return {
      ok: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
