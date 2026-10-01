const fs = require('fs')

const profiles = require('./profiles')
const credstore = require('./credstore')
const usage = require('./usage')
const locks = require('./locks')
const oauth = require('./oauth')
const live = require('./live')

const RENEW_BEFORE_MS = 60 * 60 * 1000
const POLL_EVERY_MS = 15 * 60 * 1000
const DEFAULT_PAUSE_MS = 5 * 60 * 1000
const LOCK_STALE_MS = 2 * 60 * 1000
const accountLock = (name) => 'account-' + name

const transport = {
  refresh: (rt) => oauth.request(rt),
  fetchUsage: (token) => live.fetchWithToken(token),
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

function liveState(opts) {
  const cfg = readJson(profiles.paths(opts).claudeJson)
  const o = cfg && cfg.oauthAccount
  let creds
  try { creds = credstore.read(null, opts) } catch { return null }
  const rt = creds && creds.claudeAiOauth && creds.claudeAiOauth.refreshToken
  if (!o && !rt) return { email: null, accountUuid: null, refreshToken: null }
  if (!o) return null
  return { email: o.emailAddress || null, accountUuid: o.accountUuid || null, refreshToken: rt || null }
}

function isLive(meta, saved, state) {
  if (!state) return true
  if (meta.email && state.email && meta.email === state.email) return true
  if (meta.accountUuid && state.accountUuid && meta.accountUuid === state.accountUuid) return true
  if (saved && state.refreshToken && saved.refreshToken === state.refreshToken) return true
  return false
}

function keyFor(root, name, meta) {
  if (meta.accountUuid) return meta.accountUuid
  try {
    const p = profiles.readPayload(root, name)
    const uuid = p.identity && p.identity.oauthAccount && p.identity.oauthAccount.accountUuid
    if (uuid) profiles.writeMeta(root, name, { ...profiles.readMeta(root, name), accountUuid: uuid })
    return uuid || null
  } catch { return null }
}

async function renew(root, name, opts) {
  const o = opts || {}
  const now = o.now || Date.now()
  const meta = profiles.readMeta(root, name)
  if (meta.needsLogin) return { name, skipped: 'needs-login' }

  const release = locks.tryAcquire(root, accountLock(name), LOCK_STALE_MS)
  if (!release) return { name, skipped: 'busy' }
  try {
    const payload = profiles.readPayload(root, name)
    const saved = payload.credentials && payload.credentials.claudeAiOauth
    if (!saved || !saved.refreshToken) return { name, skipped: 'no-refresh-token' }
    if (isLive(meta, saved, liveState(o))) return { name, skipped: 'live' }
    if (!o.force && saved.expiresAt && saved.expiresAt - now > RENEW_BEFORE_MS) {
      return { name, skipped: 'fresh' }
    }

    const res = await transport.refresh(saved.refreshToken)
    const out = oauth.interpret(res, saved, Date.now())
    if (out.ok) {
      profiles.updateCredentials(root, name, { ...payload.credentials, claudeAiOauth: out.oauth })
      return { name, renewed: true, expiresAt: out.oauth.expiresAt }
    }
    if (out.rejected) {
      profiles.markNeedsLogin(root, name, out.reason)
      return { name, failed: 'rejected', reason: out.reason }
    }
    return { name, failed: 'transient', reason: out.reason }
  } finally {
    release()
  }
}

async function poll(root, name, opts) {
  const o = opts || {}
  const now = o.now || Date.now()
  const meta = profiles.readMeta(root, name)
  if (meta.needsLogin) return { name, skipped: 'needs-login' }
  const key = keyFor(root, name, meta)
  if (!key) return { name, skipped: 'no-account-id' }
  if (usage.pausedUntil(root, key) > now) return { name, skipped: 'paused' }
  const due = () => {
    const c = usage.readRawCacheForKey(root, key)
    return o.force || !c || now - (c.fetchedAtMs || 0) >= POLL_EVERY_MS
  }
  if (!due()) return { name, skipped: 'fresh' }

  const release = locks.tryAcquire(root, 'usage-' + key, LOCK_STALE_MS)
  if (!release) return { name, skipped: 'busy' }
  try {
    if (!due()) return { name, skipped: 'fresh' }
    const payload = profiles.readPayload(root, name)
    const saved = payload.credentials && payload.credentials.claudeAiOauth
    if (isLive(meta, saved, liveState(o))) return { name, skipped: 'live' }
    if (!saved || !saved.accessToken || (saved.expiresAt && saved.expiresAt <= now)) {
      return { name, skipped: 'token-expired' }
    }
    const res = await transport.fetchUsage(saved.accessToken)
    if (res.ok) {
      usage.writeCacheForKey(root, key, res.utilization, Date.now())
      return { name, polled: true }
    }
    if (res.rateLimited) {
      usage.pauseUntil(root, key, Date.now() + (res.retryAfterMs || DEFAULT_PAUSE_MS))
      return { name, failed: 'rate-limited' }
    }
    return { name, failed: 'error', reason: res.reason }
  } finally {
    release()
  }
}

async function tick(root, opts) {
  const o = opts || {}
  const results = []
  const names = profiles.list(root).map((p) => p.name)
  for (const name of names) {
    try { results.push(await renew(root, name, { ...o, force: false })) } catch (e) { results.push({ name, failed: 'error', reason: e.message }) }
  }
  for (const name of names) {
    try { results.push(await poll(root, name, { ...o, force: !!o.forcePoll })) } catch (e) { results.push({ name, failed: 'error', reason: e.message }) }
  }
  return results
}

function snapshot(root, opts) {
  const now = (opts && opts.now) || Date.now()
  const active = profiles.activeProfile(root, opts)
  return profiles.list(root).map((p) => {
    const isActive = p.name === active
    const key = keyFor(root, p.name, p)
    const u = isActive ? usage.readBest(root, null) : (key ? usage.readCacheForKey(root, key) : null)
    const top = u && u.scoped && u.scoped[0]
    const scoped = top ? usage.effective(top, now) : null
    return {
      name: p.name,
      email: p.email || null,
      active: isActive,
      needsLogin: !!p.needsLogin,
      session: u ? usage.effective(u.session, now) : null,
      weekly: u ? usage.effective(u.weekly, now) : null,
      scoped: scoped ? { ...scoped, model: usage.modelName(top) } : null,
      fetchedAtMs: (u && u.fetchedAtMs) || null,
      source: (u && u.source) || null,
      paused: key ? usage.pausedUntil(root, key) > now : false,
    }
  }).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name))
}

function mostRoom(rows) {
  const scored = rows
    .filter((r) => !r.needsLogin && (r.session || r.weekly))
    .map((r) => ({ r, worst: Math.max(r.session ? r.session.percent : 0, r.weekly ? r.weekly.percent : 0) }))
    .sort((a, b) => a.worst - b.worst || (b.r.active - a.r.active))
  return scored.length ? scored[0].r : null
}

module.exports = {
  renew, poll, tick, snapshot, mostRoom, liveState, isLive, accountLock,
  RENEW_BEFORE_MS, POLL_EVERY_MS, LOCK_STALE_MS,
  _test: { transport },
}
