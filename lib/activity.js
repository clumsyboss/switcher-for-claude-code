const fs = require('fs')
const path = require('path')

const fsx = require('./fsx')
const locks = require('./locks')

const FILE = 'activity.json'
const AWAY_FILE = 'away.json'
const LOCK = 'activity'
const AWAY_LOCK = 'activity-away'
const KEEP_MS = 30 * 24 * 3600e3
const MAX_ENTRIES = 2000
const MAX_KEYS = 6000
const AWAY_AFTER_MS = 30 * 60e3
const PHONE_GROUP_MS = 30 * 60e3
const SEEN_FIX_MS = 30 * 1000
const PREVIEW_MAX = 80

const BY = ['page', 'command', 'roomback', 'autocontinue', 'early', 'switchback', 'added', 'hub', 'seen']
const LIMITS = ['session', 'weekly', 'model']

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const SECRET_WORD = '(?:token|secret|password|passwd|pwd|apikey|api_key|key)'
const VALUE = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\',}]+)'
const SCRUBS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  /\bAuthorization\s*[:=]\s*\S+(?:\s+\S+)?/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bBasic\s+(?=[A-Za-z0-9+/_-]*[0-9=+/])[A-Za-z0-9+/_-]{8,}={0,2}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
  new RegExp('["\']?\\b(?:[A-Za-z0-9]+[_-])*' + SECRET_WORD + '(?:[_-][A-Za-z0-9]+)*["\']?\\s*[:=]\\s*' + VALUE, 'gi'),
  new RegExp('["\']?\\b[a-z][a-z0-9]*(?:Token|Secret|Password|Passwd|Key)["\']?\\s*[:=]\\s*' + VALUE, 'g'),
  /(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'<>|]*/g,
  /\\\\[^\s"'<>|\\]+\\[^\s"'<>|]*/g,
  /(?:^|(?<=[\s("'`]))~[\\/][^\s"'<>|]*/g,
  /(?:^|(?<=[\s("'`]))\/(?:Users|home|var|tmp|etc|mnt|opt|root|private|Volumes|usr)\/[^\s"'<>|]*/g,
  /\S*\\\S*/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
  (t) => t.replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, (w) => (/\d/.test(w) && /[A-Za-z]/.test(w) ? '' : w)),
]

function clean(v, max) {
  if (typeof v !== 'string') return ''
  let s = v
  for (const re of SCRUBS) s = typeof re === 'function' ? re(s) : s.replace(re, '')
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const n = max || 120
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined)
const ms = (v) => num(v, 0, 8.64e15)
const pct = (v) => num(v, 0, 1000)
const flag = (v) => (v === true ? true : v === false ? false : undefined)
const pickOf = (list) => (v) => (typeof v === 'string' && list.includes(v) ? v : undefined)
const text = (max) => (v) => clean(v, max) || undefined
const chatIdOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : undefined)
const acct = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v) && !/\.settings$/i.test(v) ? v : undefined)

const FIELDS = {
  switch: { by: pickOf(BY), from: acct, fromLabel: text(60), to: acct, toLabel: text(60), asked: flag, chat: text(120), limit: pickOf(LIMITS),
    resetAt: ms, toUsed: pct, fromUsed: pct, threshold: pct, pick: pickOf(['room', 'order']), waited: flag },
  stop: { chatId: chatIdOf, chat: text(120), accountLabel: text(60), limit: pickOf(LIMITS), resetAt: ms, lateMs: ms, asked: flag },
  wait: { chatId: chatIdOf, chat: text(120), accountLabel: text(60), resetAt: ms, toLabel: text(60), asked: flag },
  waitend: { chatId: chatIdOf, chat: text(120), how: pickOf(['cancelled', 'off', 'moved', 'skipped', 'declined']), resetAt: ms },
  continue: { chatId: chatIdOf, chat: text(120), how: pickOf(['reset', 'switched', 'again']), accountLabel: text(60), stoppedAt: ms, asked: flag,
    outcome: pickOf(['sent', 'continued', 'replied', 'limited', 'failed', 'closed', 'manual']) },
  phone: { chatId: chatIdOf, chat: text(120), count: (v) => num(v, 1, 100000), until: ms, preview: text(PREVIEW_MAX) },
  phonestart: { chatId: chatIdOf, chat: text(120), accountLabel: text(60) },
  keepalive: { accountLabel: text(60), ok: flag },
  lastday: { accountLabel: text(60) },
  roomagain: { accountLabel: text(60) },
}

function shape(entry, at) {
  if (!isObj(entry) || !FIELDS[entry.kind]) return null
  const e = { at: ms(at !== undefined ? at : entry.at) }
  if (e.at === undefined) return null
  e.kind = entry.kind
  for (const [k, fn] of Object.entries(FIELDS[entry.kind])) {
    const v = fn(entry[k])
    if (v !== undefined) e[k] = v
  }
  if (e.kind === 'switch' && (!e.by || !e.to)) return null
  return e
}

function filePath(root) { return path.join(root, FILE) }

const cache = new Map()

function blank(now) { return { v: 1, seq: 0, seenAt: now, keys: {}, entries: [] } }

function normalize(j, now) {
  const s = blank(now)
  if (!isObj(j)) return s
  s.seq = Number.isInteger(j.seq) && j.seq >= 0 ? j.seq : 0
  s.seenAt = typeof j.seenAt === 'number' ? j.seenAt : now
  if (isObj(j.keys)) for (const [k, v] of Object.entries(j.keys)) if (typeof v === 'number') s.keys[k] = v
  if (Array.isArray(j.entries)) s.entries = j.entries.filter((e) => isObj(e) && typeof e.id === 'string' && typeof e.at === 'number' && FIELDS[e.kind])
  return s
}

function read(root, now) {
  const f = filePath(root)
  let st
  try { st = fs.statSync(f) } catch { cache.delete(f); return blank(now || Date.now()) }
  const stamp = st.mtimeMs + ':' + st.size
  const hit = cache.get(f)
  if (hit && hit.stamp === stamp) return hit.data
  const data = normalize(fsx.readJsonLoose(f, null), now || Date.now())
  cache.set(f, { stamp, data })
  return data
}

const held = []
const HELD_MAX = 200
const WAIT_MS = 250
const BUSY_PAUSE_MS = 2000
const busyUntil = new Map()

function load(f, t) {
  if (!fs.existsSync(f)) return blank(t)
  let err = null
  for (let i = 0; i < 2; i++) {
    try { return normalize(fsx.readJsonForWrite(f).data, t) } catch (e) { err = e; if (i === 0) fsx.sleepSync(25) }
  }
  if (!err || err.code !== 'EUNREADABLEJSON') return null
  try {
    const dir = path.dirname(f)
    const base = path.basename(f) + '.bad-'
    for (const n of fs.readdirSync(dir)) if (n.startsWith(base)) fs.rmSync(path.join(dir, n), { force: true })
    fs.renameSync(f, path.join(dir, base + new Date(t).toISOString().slice(0, 10)))
  } catch { return null }
  return blank(t)
}

function apply(root, job) {
  if (Date.now() < (busyUntil.get(root) || 0)) return { ok: false }
  const release = locks.acquireSync(root, LOCK, { staleMs: 10000, waitMs: WAIT_MS })
  if (!release) { busyUntil.set(root, Date.now() + BUSY_PAUSE_MS); return { ok: false } }
  try {
    busyUntil.delete(root)
    const f = filePath(root)
    cache.delete(f)
    const exists = fs.existsSync(f)
    const s = load(f, job.t)
    if (!s) return { ok: false }
    const mine = held.filter((h) => h.root === root)
    let dirty = !exists
    for (const h of mine) if (h.fn(s, h.t) !== undefined) dirty = true
    const out = job.fn(s, job.t)
    if (out !== undefined) dirty = true
    if (!dirty) { for (const h of mine) held.splice(held.indexOf(h), 1); return { ok: true, out: null, wrote: false } }
    const cut = job.t - KEEP_MS
    s.entries = s.entries.filter((e) => e.at >= cut)
    if (s.entries.length > MAX_ENTRIES) s.entries = s.entries.slice(s.entries.length - MAX_ENTRIES)
    for (const [k, at] of Object.entries(s.keys)) if (at < cut) delete s.keys[k]
    const over = Object.keys(s.keys).length - MAX_KEYS
    if (over > 0) for (const k of Object.keys(s.keys).sort((a, b) => s.keys[a] - s.keys[b]).slice(0, over)) delete s.keys[k]
    fsx.writeJsonAtomic(f, s, { mode: 0o600, forceMode: true, indent: 0 })
    for (const h of mine) held.splice(held.indexOf(h), 1)
    return { ok: true, out: out === undefined ? null : out, wrote: true }
  } finally { release() }
}

function change(root, fn, now) {
  const job = { root, fn, t: now || Date.now() }
  const r = apply(root, job)
  if (r.ok) return r.out
  held.push(job)
  if (held.length > HELD_MAX) held.shift()
  return null
}

function flush(root) {
  if (!held.some((h) => h.root === root)) return false
  const r = apply(root, { root, fn: () => undefined, t: Date.now() })
  return !!(r.ok && r.wrote)
}

const sorted = (s) => { s.entries.sort((a, b) => a.at - b.at) }

function stamped(s, e, key, chat) {
  const out = Object.assign({ id: String(++s.seq) }, e)
  if (key) { out.k = key; s.keys[key] = e.at }
  if (chat) out.c = String(chat).slice(0, 80)
  return out
}

function record(root, entry, opts) {
  const o = opts || {}
  const t = o.now || Date.now()
  const e = shape(entry, entry && entry.at !== undefined ? entry.at : t)
  if (!e) return null
  const key = typeof o.key === 'string' && o.key ? o.key.slice(0, 200) : null
  return change(root, (s) => {
    if (key && s.keys[key] !== undefined) return undefined
    if (e.kind === 'switch') {
      const last = s.entries.filter((x) => x.kind === 'switch').pop()
      const near = last && last.to === e.to && Math.abs(last.at - e.at) < SEEN_FIX_MS
      if (near && e.by === 'seen' && last.by !== 'seen') return undefined
      if (near && e.by !== 'seen' && last.by === 'seen') s.entries = s.entries.filter((x) => x !== last)
    }
    const made = stamped(s, e, key, o.chat)
    s.entries.push(made)
    sorted(s)
    return made.id
  }, t)
}

function update(root, key, patch) {
  if (typeof key !== 'string' || !isObj(patch)) return false
  return change(root, (s) => {
    const e = s.entries.find((x) => x.k === key)
    if (!e) return undefined
    let changed = false
    for (const [k, fn] of Object.entries(FIELDS[e.kind])) {
      if (!(k in patch)) continue
      const v = fn(patch[k])
      if (v !== undefined && e[k] !== v) { e[k] = v; changed = true }
    }
    return changed ? true : undefined
  }) === true
}

function hasKey(root, key) { return read(root).keys[key] !== undefined }

const PHONE_SENDERS = ['Awaydesk', 'Remote CC Hub', 'Claude Hub']
const typedMark = (name) => 'Typed by the user on their phone and sent through ' + name + ', their own app on this PC.'
const scheduledMark = (name) => 'Scheduled earlier by the user on their phone, and sent at the time they picked by ' + name + ', their own app on this PC.'
const PHONE_MARKS = PHONE_SENDERS.flatMap((n) => [typedMark(n), scheduledMark(n)])
const PHONE_OLD_MARK = 'Typed by the user on their phone, sent through Claude Hub (their own app on this PC):'

const FILES_HEAD = 'Attached from the phone (saved on this PC):'
const FILES_LINE = /^- .*[\\/]uploads[\\/][0-9a-f-]{36}[\\/]([^\\/]+)$/
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|heic|heif|bmp)$/i

function withoutFiles(words) {
  const at = words.lastIndexOf(FILES_HEAD)
  if (at < 0) return words
  const lines = words.slice(at + FILES_HEAD.length).split('\n').map((l) => l.trim()).filter(Boolean)
  const names = lines.map((l) => (FILES_LINE.exec(l) || [])[1])
  if (!names.length || names.some((n) => !n)) return words
  const said = words.slice(0, at).trim()
  if (said) return said
  return names.every((n) => IMAGE_EXT.test(n)) ? 'a photo from your phone' : 'a file from your phone'
}

function phoneText(body, sender) {
  const b = String(body || '').trim()
  for (const m of PHONE_MARKS) {
    const end = '(' + m + ')'
    if (b.endsWith(end)) return withoutFiles(b.slice(0, -end.length).trim())
  }
  const i = b.indexOf(PHONE_OLD_MARK)
  if (i !== -1) return withoutFiles(b.slice(i + PHONE_OLD_MARK.length).trim())
  return PHONE_SENDERS.includes(sender) ? withoutFiles(b) : null
}

function phoneIn(rec) {
  if (!isObj(rec) || rec.isSidechain) return null
  let origin = null
  if (rec.type === 'attachment' && isObj(rec.attachment) && rec.attachment.type === 'queued_command') origin = rec.attachment.origin
  else if (rec.type === 'user' && rec.isMeta) origin = rec.origin
  if (!isObj(origin) || origin.kind !== 'peer') return null
  const words = phoneText(origin.body, origin.name)
  if (words === null) return null
  const at = Date.parse(rec.timestamp)
  if (!Number.isFinite(at)) return null
  return { at, key: String(rec.uuid || rec.timestamp), words }
}

const phoneKey = (chatId, recKey) => 'phone:' + String(chatId).slice(0, 80) + ':' + String(recKey).slice(0, 120)

function recordPhone(root, msg) {
  if (!isObj(msg) || typeof msg.chatId !== 'string' || !Number.isFinite(msg.at)) return null
  const key = phoneKey(msg.chatId, msg.key)
  const preview = clean(msg.words, PREVIEW_MAX) || undefined
  return change(root, (s) => {
    if (s.keys[key] !== undefined) return undefined
    s.keys[key] = msg.at
    const last = s.entries.filter((x) => x.kind === 'phone' && x.c === msg.chatId && msg.at >= x.at - PHONE_GROUP_MS && msg.at - (x.until || x.at) <= PHONE_GROUP_MS).pop()
    if (last) {
      last.count = (last.count || 1) + 1
      last.until = Math.max(last.until || last.at, msg.at)
      if (msg.at < last.at) { last.at = msg.at; if (preview) last.preview = preview }
      sorted(s)
      return last.id
    }
    const e = shape({ kind: 'phone', chatId: msg.chatId, chat: msg.chat, count: 1, until: msg.at, preview }, msg.at)
    if (!e) return undefined
    const made = stamped(s, e, null, msg.chatId)
    s.entries.push(made)
    sorted(s)
    return made.id
  })
}

function publicEntry(e) {
  const { k, c, ...rest } = e
  return rest
}

function list(root, opts) {
  const o = opts || {}
  const limit = o.limit || 150
  const cut = Date.now() - KEEP_MS
  const all = read(root).entries.filter((e) => e.at >= cut)
  let end = all.length
  if (o.before !== undefined && o.before !== null) {
    const i = all.findIndex((e) => e.id === String(o.before))
    if (i === -1) return { entries: [], more: false }
    end = i
  }
  const start = Math.max(0, end - limit)
  return { entries: all.slice(start, end).reverse().map(publicEntry), more: start > 0 }
}

function since(root, from, to) {
  const t = typeof to === 'number' ? to : Infinity
  const cut = Date.now() - KEEP_MS
  return read(root).entries.filter((e) => e.at >= cut && (e.at >= from || (e.until || 0) >= from) && e.at <= t).reverse().map(publicEntry)
}

function unseen(root) {
  const s = read(root)
  let n = 0
  for (let i = s.entries.length - 1; i >= 0 && s.entries[i].at > s.seenAt; i--) n++
  return n
}

function markSeen(root, at) {
  const t = at || Date.now()
  return change(root, (s) => {
    if (t <= s.seenAt) return undefined
    s.seenAt = t
    return true
  }) === true
}

function clear(root, now) {
  const t = now || Date.now()
  return change(root, (s) => { s.entries = []; s.seenAt = t; return true }, t) === true
}

function awayPath(root) { return path.join(root, AWAY_FILE) }

function readAway(root) {
  const j = fsx.readJsonLoose(awayPath(root), null)
  return { lastFocused: isObj(j) && typeof j.lastFocused === 'number' ? j.lastFocused : null,
    told: isObj(j) && typeof j.told === 'number' ? j.told : null }
}

function comeBack(root, now, after) {
  const t = now || Date.now()
  const gap = after === undefined ? AWAY_AFTER_MS : after
  const release = locks.acquireSync(root, AWAY_LOCK, { staleMs: 10000, waitMs: WAIT_MS })
  if (!release) return null
  try {
    const st = readAway(root)
    let out = null
    if (st.lastFocused !== null && t - st.lastFocused >= gap && st.told !== st.lastFocused) out = { from: st.lastFocused, to: t }
    fsx.writeJsonAtomic(awayPath(root), { lastFocused: Math.max(t, st.lastFocused || 0), told: out ? out.from : st.told }, { mode: 0o600, forceMode: true, indent: 0 })
    return out
  } finally { release() }
}

const small = (e) => e.kind === 'keepalive' || e.kind === 'roomagain' || (e.kind === 'switch' && e.by === 'seen')

const needsYou = (e) => e.kind === 'keepalive' && e.ok === false

function awayEntries(entries) {
  return entries.filter((e) => !small(e) || needsYou(e))
}

const LIMIT_WORDS = { session: '5-hour limit', weekly: 'weekly limit', model: 'weekly limit for that model' }
const qt = (t) => '“' + (clean(t, 120) || 'a chat') + '”'
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)

function span(msec) {
  const m = Math.max(1, Math.round(msec / 60000))
  if (m < 60) return m + ' min'
  const hr = Math.floor(m / 60)
  if (hr >= 48) return Math.round(hr / 24) + ' days'
  if (hr >= 10) return Math.round(m / 60) + ' h'
  return hr + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '')
}

const NEEDS = ['replied', 'failed', 'closed', 'manual']

function awayLines(entries, clock) {
  const es = awayEntries(entries)
  const lines = []
  const who = (e, k) => clean(e[k + 'Label'], 60) || clean(e[k], 40) || 'another account'
  const chatsOf = (list) => [...new Set(list.map((e) => clean(e.chat, 120)))]
  const waiting = []
  const settled = new Set()
  for (const e of es) {
    if (e.kind === 'continue' || e.kind === 'waitend') settled.add(e.chat)
    if (e.kind === 'wait' && !settled.has(e.chat)) waiting.push(e)
  }
  const needs = (e) => e.kind === 'continue' && NEEDS.includes(e.outcome)
  const nc = chatsOf(es.filter(needs))
  if (nc.length) lines.push(nc.length === 1 ? qt(nc[0]) + ' still needs you.' : plural(nc.length, 'chat', 'chats') + ' still need you' + (nc.length <= 3 ? ': ' + nc.map(qt).join(', ') : '') + '.')
  const stopped = chatsOf(es.filter((e) => e.kind === 'stop'))
  if (stopped.length) lines.push(plural(stopped.length, 'chat', 'chats') + ' stopped at limits' + (stopped.length <= 2 ? ': ' + stopped.map(qt).join(' and ') : '') + '.')
  const ac = es.filter((e) => e.kind === 'switch' && e.by === 'autocontinue' && !e.asked)
  const cont = chatsOf(es.filter((e) => e.kind === 'continue' && !e.asked && !needs(e)))
  if (ac.length || cont.length) {
    const first = ac.length ? (ac.length > 1 ? 'Auto-continue switched accounts ' + ac.length + ' times, the last to ' : 'Auto-continue switched to ') + who(ac[0], 'to') : ''
    const second = cont.length ? (ac.length ? 'and ' : 'Auto-continue ') + 'continued ' + (cont.length === 1 ? '1 chat' : cont.length + ' chats') : ''
    lines.push([first, second].filter(Boolean).join(' ') + '.')
  }
  const early = es.filter((e) => e.kind === 'switch' && e.by === 'early' && !e.asked)
  if (early.length) lines.push(early.length === 1 ? 'Switched early from ' + who(early[0], 'from') + ' to ' + who(early[0], 'to') + '.' : 'Switched early ' + early.length + ' times, last to ' + who(early[0], 'to') + '.')
  if (waiting.length) lines.push(waiting.length === 1 ? qt(waiting[0].chat) + ' is waiting for a limit to reset, until ' + clock(waiting[0].resetAt) + '.' : plural(waiting.length, 'chat is', 'chats are') + ' waiting for a limit to reset.')
  const ph = es.filter((e) => e.kind === 'phone')
  const phn = ph.reduce((n, e) => n + (e.count || 1), 0)
  const phs = es.filter((e) => e.kind === 'phonestart')
  if (phn || phs.length) {
    const pc = chatsOf(ph)
    lines.push([phn ? plural(phn, 'message', 'messages') + ' came from your phone' + (pc.length > 1 ? ', in ' + pc.length + ' chats' : '') : '',
      phs.length ? plural(phs.length, 'chat was', 'chats were') + ' started from your phone' : ''].filter(Boolean).join('. ') + '.')
  }
  const ka = es.filter((e) => e.kind === 'keepalive' && e.ok).length
  if (ka) lines.push('Keep alive started ' + plural(ka, 'new 5-hour window', 'new 5-hour windows') + '.')
  const ld = es.filter((e) => e.kind === 'lastday')
  if (ld.length) lines.push(ld.length === 1 ? who(ld[0], 'accountLabel') + '’s main login swapped places with its pinning login.' : plural(ld.length, 'account swapped', 'accounts swapped') + ' its main login with its pinning login.')
  if (lines.length > 6) { const rest = lines.length - 5; lines.length = 5; lines.push('And ' + plural(rest, 'more thing', 'more things') + ' in the log.') }
  return lines
}

function awayText(entries, from, to, clock) {
  const lines = awayLines(entries, clock)
  if (!lines.length) return ''
  return 'While you were away (' + span(Math.max(1, to - from)) + '): ' + lines.join(' ')
}

module.exports = {
  FILE, AWAY_FILE, KEEP_MS, MAX_ENTRIES, AWAY_AFTER_MS, PHONE_GROUP_MS, PREVIEW_MAX, LIMIT_WORDS,
  PHONE_SENDERS, PHONE_MARKS, PHONE_OLD_MARK, FILES_HEAD,
  clean, shape, record, update, flush, recordPhone, phoneKey, hasKey, phoneText, phoneIn,
  list, since, unseen, markSeen, clear, filePath, read,
  comeBack, awayEntries, awayLines, awayText, span,
}
