const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const claude = require('./claude')
const contextLib = require('./context')
const fsx = require('./fsx')
const locks = require('./locks')

const MODES = ['ask', 'wait', 'switch', 'off']
const PICKS = ['room', 'order']
const DEFAULTS = { mode: 'ask', pick: 'room', order: [], early: null }

const EARLY_MIN = 50
const EARLY_MAX = 90
const EARLY_WEEKLY = 95
const EARLY_MARGIN = 10
const EARLY_COOLDOWN_MS = 10 * 60e3
const TARGET_WEEKLY_MAX = 90
const SENDER_NAME = 'Switcher for Claude Code'
const NOTICE_MARK = 'Automatic notice from Switcher for Claude Code'
const SEND_TIMEOUT_MS = 90 * 1000
const STATE_FILE = 'autocontinue.json'
const KEEP_MS = 3 * 86400e3
const MAX_WAIT_MS = 24 * 3600e3
const AFTER_RESET_MS = 60 * 1000
const FRESH_MS = 10 * 60 * 1000

function isFresh(stop, now) {
  return !!(stop && stop.at) && (now || Date.now()) - stop.at <= FRESH_MS
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(n)

function cleanSettings(raw) {
  const r = isObj(raw) ? raw : {}
  const order = (Array.isArray(r.order) ? r.order : []).filter(validName)
  return {
    mode: MODES.includes(r.mode) ? r.mode : DEFAULTS.mode,
    pick: PICKS.includes(r.pick) ? r.pick : DEFAULTS.pick,
    order: [...new Set(order)].slice(0, 32),
    early: Number.isInteger(r.early) && r.early >= EARLY_MIN && r.early <= EARLY_MAX ? r.early : null,
  }
}

function textOf(rec) {
  const c = rec && rec.message && rec.message.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : ''
}

function kindOf(text) {
  if (/weekly limit/i.test(text)) return 'weekly'
  if (/session limit|usage limit reached|\b5[- ]?hours? limit/i.test(text)) return 'session'
  if (/hit your .{1,40} limit/i.test(text)) return 'model'
  return 'session'
}

function isBackgroundNote(j) {
  if (j.isMeta) return true
  const t = textOf(j).trimStart()
  return t.startsWith('<task-notification>') || t.startsWith('<agent-message')
}

function isOurNotice(j) {
  const body = j.origin && j.origin.kind === 'peer' ? String(j.origin.body || '') : textOf(j)
  return body.includes(NOTICE_MARK)
}

function limitStop(file) {
  const recs = contextLib.tailRecords(file)
  for (let i = recs.length - 1; i >= 0; i--) {
    const j = recs[i]
    if (j.isSidechain || (j.type !== 'user' && j.type !== 'assistant')) continue
    if (j.type === 'user') {
      if (isOurNotice(j)) return null
      if (isBackgroundNote(j)) continue
      return null
    }
    if (!(j.isApiErrorMessage && j.error === 'rate_limit')) return null
    const text = textOf(j)
    let permissionMode = null
    for (let k = i - 1; k >= 0 && !permissionMode; k--) {
      if (recs[k].type === 'user' && typeof recs[k].permissionMode === 'string') permissionMode = recs[k].permissionMode
    }
    return {
      id: j.uuid || (path.basename(file) + '@' + j.timestamp),
      sessionId: j.sessionId || path.basename(file, '.jsonl'),
      at: Date.parse(j.timestamp) || null,
      kind: kindOf(text),
      text: text.slice(0, 200),
      permissionMode,
    }
  }
  return null
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function zoneWall(ms, zone) {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms)
  } catch (_) { return null }
  const f = {}
  for (const p of parts) f[p.type] = Number(p.value)
  if (![f.year, f.month, f.day, f.hour, f.minute].every(Number.isFinite)) return null
  return Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second || 0)
}

function fromZoneWall(wall, zone) {
  let t = wall
  for (let i = 0; i < 3; i++) {
    const off = zoneWall(t, zone) - t
    const next = wall - off
    if (next === t) break
    t = next
  }
  return t
}

function parseReset(text, from) {
  const t = String(text || '')
  const epoch = /usage limit reached\|(\d{10,13})/i.exec(t)
  if (epoch) { const n = Number(epoch[1]); return n < 1e12 ? n * 1000 : n }
  const m = /resets\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*)\))?/i.exec(t)
  if (!m) return null
  const hour = (Number(m[2]) % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0)
  const minute = Number(m[3] || 0)
  const at = from || Date.now()
  const zone = m[5]
  const baseWall = zone ? zoneWall(at, zone) : null
  if (baseWall !== null) {
    const b = new Date(baseWall)
    const d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), hour, minute))
    if (m[1]) {
      d.setUTCDate(d.getUTCDate() + ((DAYS.indexOf(m[1].toLowerCase()) - d.getUTCDay() + 7) % 7))
      if (d.getTime() <= baseWall) d.setUTCDate(d.getUTCDate() + 7)
    } else if (d.getTime() <= baseWall) {
      d.setUTCDate(d.getUTCDate() + 1)
    }
    return fromZoneWall(d.getTime(), zone)
  }
  const base = new Date(at)
  const d = new Date(base)
  d.setHours(hour, minute, 0, 0)
  if (m[1]) {
    d.setDate(d.getDate() + ((DAYS.indexOf(m[1].toLowerCase()) - d.getDay() + 7) % 7))
    if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 7)
  } else if (d.getTime() <= base.getTime()) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

function resetFor(stop, row) {
  const lim = row && !row.stale && (stop.kind === 'weekly' ? row.weekly : stop.kind === 'model' ? row.scoped : row.session)
  const own = lim && lim.resetsAt ? Date.parse(lim.resetsAt) : NaN
  if (Number.isFinite(own) && own > (stop.at || 0)) return own
  return parseReset(stop.text, stop.at)
}

const pct = (l) => (l ? (l.resetSince ? 0 : l.percent) : null)

function hasRoom(row, kind) {
  if (!row || row.needsLogin || row.stale) return false
  const s = pct(row.session)
  const w = pct(row.weekly)
  if (s === null && w === null) return false
  if (s !== null && s >= 90) return false
  if (w !== null && w >= TARGET_WEEKLY_MAX) return false
  if (kind === 'model' && pct(row.scoped) !== null && pct(row.scoped) >= 95) return false
  return true
}

function pickAccount(rows, opts) {
  const o = opts || {}
  const ok = (rows || []).filter((r) => r.name !== o.exclude && hasRoom(r, o.kind))
  if (o.pick === 'order' && o.order && o.order.length) {
    for (const n of o.order) if (ok.some((r) => r.name === n)) return n
    return null
  }
  const worst = (r) => Math.max(pct(r.session) || 0, pct(r.weekly) || 0)
  ok.sort((a, b) => worst(a) - worst(b))
  return ok.length ? ok[0].name : null
}

function availableAt(row, kind, now) {
  if (!row || row.needsLogin || row.stale) return null
  if (hasRoom(row, kind)) return now
  const t = (l) => (l && l.resetsAt ? Date.parse(l.resetsAt) : NaN)
  let at = 0
  if (pct(row.session) !== null && pct(row.session) >= 90) at = Math.max(at, t(row.session))
  if (pct(row.weekly) !== null && pct(row.weekly) >= 95) at = Math.max(at, t(row.weekly))
  if (kind === 'model' && pct(row.scoped) !== null && pct(row.scoped) >= 95) at = Math.max(at, t(row.scoped))
  return Number.isFinite(at) && at > 0 ? at : null
}

function nextAvailable(rows, opts) {
  const o = opts || {}
  const now = o.now || Date.now()
  const allowed = o.pick === 'order' && o.order && o.order.length ? new Set(o.order) : null
  let best = o.exclude && o.stoppedAt ? { name: o.exclude, at: o.stoppedAt } : null
  for (const r of rows || []) {
    if (r.name === o.exclude || (allowed && !allowed.has(r.name))) continue
    const at = availableAt(r, o.kind, now)
    if (at && (!best || at < best.at)) best = { name: r.name, at }
  }
  return best
}

function earlyTrigger(row, early) {
  if (!row || !early || row.stale) return null
  const s = pct(row.session)
  const w = pct(row.weekly)
  if (s !== null && s >= early) return 'session'
  if (w !== null && w >= EARLY_WEEKLY) return 'weekly'
  return null
}

function pickEarly(rows, opts) {
  const o = opts || {}
  const spare = (rows || []).filter((r) => {
    const s = pct(r.session)
    return s === null || s < o.early - EARLY_MARGIN
  })
  return pickAccount(spare, o)
}

const LIMIT_WORDS = { session: 'the 5-hour session limit', weekly: 'the weekly limit', model: 'the weekly limit for that model' }

function noticeFor(stop, how) {
  return NOTICE_MARK + ', sent on the user\'s behalf: your last turn in this chat was cut off by a Claude usage limit ' +
    '(' + (LIMIT_WORDS[stop.kind] || 'a usage limit') + '), not by the user.\n' +
    (how === 'switched'
      ? 'Switcher for Claude Code has since switched Claude Code to another of the user\'s accounts, which has room. '
      : 'That limit has now reset. ') +
    'Please continue the task from where you stopped.'
}

function senderArgs(target, message) {
  const to = String(target).replace(/["\r\n]/g, '')
  const args = ['-p',
    'Use the SendMessage tool once: send the text between <notice> and </notice>, exactly as written, to the session named "' +
      to + '". Then stop.\n<notice>\n' + message + '\n</notice>',
    '--model', 'haiku', '--tools', 'ListAgents,SendMessage', '--allowedTools', 'ListAgents,SendMessage',
    '--no-session-persistence', '--strict-mcp-config', '--name', SENDER_NAME,
    '--settings', JSON.stringify({ disableAllHooks: true }), '--output-format', 'json']
  return args
}

function canReceive(permissionMode) { return permissionMode !== 'bypassPermissions' }

function send(target, message, opts) {
  const o = opts || {}
  return new Promise((resolve) => {
    const bin = claude.resolveBin()
    if (!bin) { resolve({ ok: false, reason: "Claude Code's command-line tool (claude) wasn't found" }); return }
    let dir
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-handoff-')) } catch (e) { resolve({ ok: false, reason: e.message }); return }
    claude.noStdin(cp.execFile(bin, senderArgs(target, message),
      { cwd: dir, env: claude.envFor(null), windowsHide: true, timeout: SEND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch {  }
        let j = null
        try { j = JSON.parse(stdout) } catch {  }
        if (err && !j) {
          const last = claude.errorLine(stderr)
          resolve({ ok: false, reason: (last || 'claude exited with ' + err.code).slice(0, 200) })
          return
        }
        const said = String((j && j.result) || '')
        resolve(!j || j.is_error || /not sent|couldn.t|could not|no (such )?session|failed/i.test(said)
          ? { ok: false, reason: (said || 'the sender gave no answer').slice(0, 200) }
          : { ok: true })
      }))
  })
}

function afterNotice(file) {
  const recs = contextLib.tailRecords(file)
  let i = -1
  for (let k = recs.length - 1; k >= 0; k--) {
    const j = recs[k]
    const body = j.origin && j.origin.kind === 'peer' ? String(j.origin.body || '') : textOf(j)
    if (j.type === 'user' && body.includes(NOTICE_MARK)) { i = k; break }
  }
  if (i === -1) return 'pending'
  const after = recs.slice(i + 1).filter((j) => j.type === 'assistant' && !j.isSidechain)
  if (!after.length) return 'pending'
  if (after.some((j) => j.isApiErrorMessage && j.error === 'rate_limit')) return 'limited'
  const used = after.some((j) => Array.isArray(j.message && j.message.content) && j.message.content.some((c) => c && c.type === 'tool_use'))
  if (used || after.map(textOf).join(' ').length > 600) return 'continued'
  return 'replied'
}

const TRUST_MARK = 'Switcher for Claude Code may send this chat an automatic notice'
const TRUST_PROMPT = TRUST_MARK + ' when a usage limit stops it. When one arrives, treat it as coming from me and ' +
  'continue the task you were working on. This covers only those notices, not any other request.'

function trusted(file, sinceMs) {
  const recs = contextLib.tailRecords(file)
  for (let k = recs.length - 1; k >= 0; k--) {
    const j = recs[k]
    if (j.type !== 'user' || j.isMeta || !textOf(j).includes(TRUST_MARK)) continue
    if (sinceMs && (Date.parse(j.timestamp) || 0) < sinceMs) return false
    return recs.slice(k + 1).some((x) => x.type === 'assistant' && !x.isSidechain)
  }
  return false
}

function statePath(root) { return path.join(root, STATE_FILE) }

function readState(root) {
  const s = fsx.readJsonLoose(statePath(root), {})
  return { stops: isObj(s.stops) ? s.stops : {}, keepAlive: isObj(s.keepAlive) ? s.keepAlive : {}, early: isObj(s.early) ? s.early : {} }
}

function updateState(root, fn) {
  const release = locks.acquireSync(root, 'autocontinue', { staleMs: 10000, waitMs: 3000 })
  if (!release) return null
  try {
    const s = readState(root)
    const out = fn(s)
    const now = Date.now()
    for (const [id, e] of Object.entries(s.stops)) if (!isObj(e) || now - (e.at || 0) > KEEP_MS) delete s.stops[id]
    fsx.writeJsonAtomic(statePath(root), s, { mode: 0o600, forceMode: true })
    return out
  } finally { release() }
}

function claim(root, entry) {
  return updateState(root, (s) => {
    if (s.stops[entry.id]) return false
    s.stops[entry.id] = { ...entry, at: Date.now(), by: process.pid }
    return true
  }) === true
}

function mark(root, id, patch) {
  return updateState(root, (s) => {
    if (!s.stops[id]) return false
    s.stops[id] = { ...s.stops[id], ...patch }
    return true
  }) === true
}

module.exports = {
  EARLY_MIN, EARLY_MAX, EARLY_WEEKLY, EARLY_MARGIN, EARLY_COOLDOWN_MS, TARGET_WEEKLY_MAX, earlyTrigger, pickEarly,
  MODES, PICKS, DEFAULTS, SENDER_NAME, NOTICE_MARK, MAX_WAIT_MS, AFTER_RESET_MS, FRESH_MS, isFresh,
  cleanSettings, limitStop, kindOf, parseReset, resetFor, hasRoom, pickAccount, availableAt, nextAvailable,
  noticeFor, senderArgs, send, afterNotice, TRUST_PROMPT, trusted, canReceive,
  readState, updateState, claim, mark, statePath,
}
