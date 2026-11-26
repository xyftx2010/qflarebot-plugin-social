import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { DBBatchResult, DBStatement, PluginDB } from '@qqbot/sdk'

/**
 * 基于 Node 22 内置 node:sqlite 的真实 SQLite 替身，
 * 传入 createMockContext({ db }) 后会先经过框架真实 scopeSql 表名检查，再在此执行。
 */
export function createSqliteTestDB(): PluginDB {
  const sqlite = new DatabaseSync(':memory:')

  const expand = (sql: string): string => sql.replace(/\{([a-zA-Z0-9_]+)\}/g, 'p_social_$1')

  const toParams = (params: readonly unknown[]): SQLInputValue[] =>
    params.map((p) => (p === undefined ? null : (p as SQLInputValue)))

  return {
    table: (name) => `p_social_${name}`,
    async exec(sql: string) {
      sqlite.exec(expand(sql))
    },
    async run(sql: string, ...params: unknown[]) {
      const info = sqlite.prepare(expand(sql)).run(...toParams(params))
      return { changes: Number(info.changes ?? 0) }
    },
    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      return sqlite.prepare(expand(sql)).all(...toParams(params)) as T[]
    },
    async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      const row = sqlite.prepare(expand(sql)).get(...toParams(params))
      return (row ?? null) as T | null
    },
    async batch<T = Record<string, unknown>>(statements: readonly DBStatement[]) {
      const out: Array<DBBatchResult<T>> = []
      sqlite.exec('BEGIN')
      try {
        for (const st of statements) {
          const stmt = sqlite.prepare(expand(st.sql))
          const trimmed = st.sql.trim().toUpperCase()
          if (trimmed.startsWith('SELECT')) {
            const results = stmt.all(...toParams(st.params ?? [])) as T[]
            out.push({ changes: 0, results })
          } else {
            const info = stmt.run(...toParams(st.params ?? []))
            out.push({ changes: Number(info.changes ?? 0), results: [] })
          }
        }
        sqlite.exec('COMMIT')
        return out
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  }
}
