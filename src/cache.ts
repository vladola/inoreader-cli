// Local article cache + API budget tracking. The API allows ~100 read and ~100 write
// calls per day, so analysis works on a synced local copy instead of live queries.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RateLimitInfo } from 'inoreader-js'

export interface CachedArticle {
  id: string
  title: string
  url?: string
  source?: string
  sourceId?: string
  published: string
  author?: string
  read: boolean
  starred: boolean
  tags: string[]
  text?: string
}

export interface Budget extends RateLimitInfo {
  checkedAt: string
  resetAt: string
}

const dir = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'inoreader-cli',
  process.env.INOREADER_PROFILE || 'default',
)
const articlesFile = join(dir, 'articles.json')
const budgetFile = join(dir, 'budget.json')

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
}

export function cacheDir(): string {
  return dir
}

export function loadArticles(): Map<string, CachedArticle> {
  const list = readJson<CachedArticle[]>(articlesFile, [])
  return new Map(list.map((a) => [a.id, a]))
}

export function saveArticles(map: Map<string, CachedArticle>): void {
  const list = [...map.values()].sort((a, b) => b.published.localeCompare(a.published))
  writeJson(articlesFile, list)
}

export function loadBudget(): Budget | undefined {
  return readJson<Budget | undefined>(budgetFile, undefined)
}

export function recordBudget(info: RateLimitInfo | undefined): Budget | undefined {
  if (!info || !Number.isFinite(info.zone1Limit) || info.zone1Limit <= 0) return undefined
  const now = Date.now()
  const b: Budget = {
    ...info,
    checkedAt: new Date(now).toISOString(),
    resetAt: new Date(now + info.resetAfter * 1000).toISOString(),
  }
  writeJson(budgetFile, b)
  return b
}

export function budgetLine(b: Budget | undefined): string {
  if (!b) return 'budget: unknown'
  return `budget: read ${b.zone1Usage}/${b.zone1Limit}, write ${b.zone2Usage}/${b.zone2Limit}, resets ${b.resetAt}`
}
