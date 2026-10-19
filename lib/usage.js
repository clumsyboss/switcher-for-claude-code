const fs = require('fs')
const os = require('os')
const path = require('path')

const fsx = require('./fsx')

function claudeJsonPath(configDir) {
  return configDir
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json')
}

function shape(cached) {
  const u = cached && cached.utilization
  if (!u) return null

  const limits = Array.isArray(u.limits) ? u.limits : []
  const session = limits.find((l) => l.kind === 'session') || null
  const weekly = limits.find((l) => l.kind === 'weekly_all') || null
  const scoped = limits
    .filter((l) => l.kind === 'weekly_scoped')
    .sort((a, b) => (b.percent || 0) - (a.percent || 0))

  return {
    fetchedAtMs: cached.fetchedAtMs || null,
    session,
    weekly,
    scoped,
    extra: u.extra_usage && u.extra_usage.is_enabled ? u.extra_usage : null,
  }
}

function readUsage(configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath(configDir), 'utf8'))
    return shape(j && j.cachedUsageUtilization)
  } catch {
    return null
  }
}

function accountKey(configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath(configDir), 'utf8'))
    const o = j && j.oauthAccount
    if (o && o.accountUuid) return String(o.accountUuid).replace(/[^A-Za-z0-9_.-]/g, '')
  } catch {  }
  return 'default'
}

function safeKey(key) { return String(key || 'default').replace(/[^A-Za-z0-9_.-]/g, '') || 'default' }

function cachePathForKey(root, key) { return path.join(root, 'usage', safeKey(key) + '.json') }

function cachePath(root, configDir) { return cachePathForKey(root, accountKey(configDir)) }

function writeAtomicJson(file, obj) {
  fsx.writeFileAtomic(file, JSON.stringify(obj), { mode: 0o600, forceMode: true })
}

function writeCacheForKey(root, key, utilization, fetchedAtMs) {
  writeAtomicJson(cachePathForKey(root, key), { fetchedAtMs: fetchedAtMs || Date.now(), utilization })
}

function readRawCacheForKey(root, key) {
  try { return JSON.parse(fs.readFileSync(cachePathForKey(root, key), 'utf8')) } catch { return null }
}

function readCacheForKey(root, key) {
  const u = shape(readRawCacheForKey(root, key))
  if (u) u.source = 'live'
  return u
}

function writeLiveCache(root, configDir, utilization) {
  writeCacheForKey(root, accountKey(configDir), utilization)
}

function readLiveCache(root, configDir) {
  return shape(readRawCacheForKey(root, accountKey(configDir)))
}

function rememberClaudeCache(root, configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath(configDir), 'utf8'))
    const c = j && j.cachedUsageUtilization
    if (!c || !c.utilization) return false
    const key = accountKey(configDir)
    if (key === 'default') return false
    const ours = readRawCacheForKey(root, key)
    const theirsAt = c.fetchedAtMs || 0
    if (ours && (ours.fetchedAtMs || 0) >= theirsAt) return false
    writeCacheForKey(root, key, c.utilization, theirsAt || Date.now())
    return true
  } catch { return false }
}

function pausePath(root, key) { return path.join(root, 'usage', safeKey(key) + '.pause') }

function pausedUntil(root, key) {
  try { return Number(fs.readFileSync(pausePath(root, key), 'utf8')) || 0 } catch { return 0 }
}

function pauseUntil(root, key, untilMs) {
  fsx.writeFileAtomic(pausePath(root, key), String(Math.round(untilMs)), { mode: 0o600, forceMode: true })
}

function effective(limit, now) {
  if (!limit || typeof limit.percent !== 'number') return null
  const t = now || Date.now()
  const at = limit.resets_at ? Date.parse(limit.resets_at) : NaN
  if (!Number.isNaN(at) && at <= t) return { percent: 0, resetSince: true, resetsAt: null }
  return { percent: Math.round(limit.percent), resetSince: false, resetsAt: limit.resets_at || null }
}

function readBest(root, configDir) {
  const claudeSide = readUsage(configDir)
  const liveSide = root ? readLiveCache(root, configDir) : null
  if (claudeSide) claudeSide.source = 'claude'
  if (liveSide) liveSide.source = 'live'
  if (!claudeSide) return liveSide
  if (!liveSide) return claudeSide
  return (liveSide.fetchedAtMs || 0) >= (claudeSide.fetchedAtMs || 0) ? liveSide : claudeSide
}

function modelName(limit) {
  const m = limit && limit.scope && limit.scope.model
  return (m && m.display_name) || 'scoped'
}

const pct = (l) => (l && typeof l.percent === 'number' ? Math.round(l.percent) : null)

function compactText(usage) {
  if (!usage) return null
  const cells = [pct(usage.session), pct(usage.scoped[0]), pct(usage.weekly)]
  if (cells.every((c) => c === null)) return null
  return cells.map((c) => (c === null ? '–' : c + '%')).join(' | ')
}

function peak(usage) {
  if (!usage) return 0
  return Math.max(0, ...[usage.session, usage.weekly, ...usage.scoped]
    .map(pct).filter((n) => n !== null))
}

function relTime(ms) {
  if (!ms) return 'unknown'
  const d = Math.abs(Date.now() - ms)
  const mins = Math.round(d / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + ' min ago'
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago')
  const days = Math.round(hrs / 24)
  return days + (days === 1 ? ' day ago' : ' days ago')
}

function untilTime(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  let mins = Math.round((t - Date.now()) / 60000)
  if (mins <= 0) return 'now'
  const days = Math.floor(mins / 1440); mins -= days * 1440
  const hrs = Math.floor(mins / 60); mins -= hrs * 60
  return [days ? days + 'd' : null, hrs ? hrs + 'h' : null,
    !days && mins ? mins + 'm' : null].filter(Boolean).join(' ') || 'now'
}

function extraText(usage) {
  const e = usage && usage.extra
  if (!e) return null
  const dp = typeof e.decimal_places === 'number' ? e.decimal_places : 2
  const money = (c) => '$' + (c / Math.pow(10, dp)).toFixed(dp)
  return money(e.used_credits) + ' of ' + money(e.monthly_limit)
}

function detailLines(usage) {
  if (!usage) return ['Usage data not available yet for this account.']
  const row = (label, limit) => {
    const p = pct(limit)
    if (p === null) return null
    const resets = untilTime(limit.resets_at)
    return '`' + String(p).padStart(3) + '%`  ' + label + (resets ? '  · resets in ' + resets : '')
  }
  const lines = [
    row('Session (5 hour)', usage.session),
    ...usage.scoped.map((s) => row(modelName(s) + ' (weekly)', s)),
    row('Weekly (all models)', usage.weekly),
  ].filter(Boolean)

  if (usage.extra) {
    lines.push('`' + String(Math.round(usage.extra.utilization)).padStart(3) + '%`  Extra usage · ' + extraText(usage))
  }
  lines.push('')
  lines.push(usage.source === 'live'
    ? '_Fetched live ' + relTime(usage.fetchedAtMs) + '. Click to refresh again._'
    : '_Cached by Claude Code ' + relTime(usage.fetchedAtMs) + '. Click to fetch live._')
  return lines
}

module.exports = {
  readUsage, readBest, readLiveCache, writeLiveCache, cachePath, accountKey,
  cachePathForKey, writeCacheForKey, readCacheForKey, readRawCacheForKey,
  rememberClaudeCache, pausedUntil, pauseUntil, effective, relTime, untilTime,
  compactText, detailLines, extraText, peak, claudeJsonPath, modelName, shape,
}
