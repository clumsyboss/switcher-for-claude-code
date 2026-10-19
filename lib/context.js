const fs = require('fs')
const os = require('os')
const path = require('path')

const TAIL_BYTES = 1024 * 1024
const HEAD_BYTES = 256 * 1024
const SMALL_WINDOW = 200000
const LARGE_WINDOW = 1000000

function projectsDir(home) { return path.join(home || os.homedir(), '.claude', 'projects') }

function hash31(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}

const KEY_MAX = 200

function projectKey(folder) {
  const full = String(folder)
  const k = full.replace(/[^A-Za-z0-9]/g, '-')
  return k.length <= KEY_MAX ? k : k.slice(0, KEY_MAX) + '-' + Math.abs(hash31(full)).toString(36)
}

function folderKeys(folder) {
  const keys = [projectKey(folder)]
  try {
    const real = fs.realpathSync.native(folder)
    if (real !== folder) keys.unshift(projectKey(real))
  } catch {  }
  return keys
}

function sameKey(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b }
function matches(folder, project) { return folderKeys(folder).some((k) => sameKey(k, project)) }

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, start)
    return buf.toString('utf8', 0, n)
  } finally { fs.closeSync(fd) }
}

function lines(text) {
  const out = []
  for (const l of text.split('\n')) {
    if (!l || l[0] !== '{') continue
    try { out.push(JSON.parse(l)) } catch {  }
  }
  return out
}

function titleFrom(entries) {
  let custom = null
  let ai = null
  for (const j of entries) {
    if (j.type === 'custom-title' && j.customTitle) custom = j.customTitle
    else if (j.type === 'ai-title' && j.aiTitle) ai = j.aiTitle
    else if (j.type === 'summary' && j.summary && !ai) ai = j.summary
  }
  return custom || ai
}

function firstPrompt(entries) {
  for (const j of entries) {
    if (j.type !== 'user' || j.isSidechain || !j.message) continue
    const c = j.message.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p && p.type === 'text') || {}).text : null
    if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').trim()
  }
  return null
}

const chatCache = new Map()

function readChat(file) {
  let st
  try { st = fs.statSync(file) } catch { chatCache.delete(file); return null }
  const hit = chatCache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.chat
  const chat = readChatNow(file, st)
  chatCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, chat })
  if (chatCache.size > 200) chatCache.delete(chatCache.keys().next().value)
  return chat
}

function readChatNow(file, st) {
  const tailStart = Math.max(0, st.size - TAIL_BYTES)
  const tail = lines(readSlice(file, tailStart, st.size - tailStart))
  let last = null
  let compact = null
  for (let i = tail.length - 1; i >= 0; i--) {
    const j = tail[i]
    if (!compact && j.type === 'system' && j.subtype === 'compact_boundary' && j.compactMetadata) compact = j
    if (j.type === 'assistant' && !j.isSidechain && j.message && j.message.usage && j.message.model !== '<synthetic>') { last = j; break }
  }
  if (!last) return null
  const u = last.message.usage
  const replyUsed = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
  const meta = compact ? compact.compactMetadata : null
  const used = meta && Number.isFinite(meta.postTokens) ? meta.postTokens : replyUsed
  const peak = Math.max(replyUsed, (meta && meta.preTokens) || 0)
  let title = titleFrom(tail)
  if (!title) {
    const head = lines(readSlice(file, 0, Math.min(HEAD_BYTES, st.size)))
    title = titleFrom(head) || firstPrompt(head)
  }
  return {
    id: path.basename(file, '.jsonl'),
    file,
    project: path.basename(path.dirname(file)),
    title: (title || 'Untitled chat').slice(0, 60),
    model: last.message.model || null,
    used,
    peak,
    at: Date.parse((compact || last).timestamp) || st.mtimeMs,
  }
}

function recentChats(opts) {
  const o = opts || {}
  const dir = o.dir || projectsDir(o.home)
  const maxAge = o.maxAgeMs || 7 * 86400e3
  const files = []
  let projects = []
  try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return [] }
  const now = o.now || Date.now()
  for (const p of projects) {
    let entries = []
    try { entries = fs.readdirSync(path.join(dir, p.name)) } catch { continue }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue
      const f = path.join(dir, p.name, e)
      try {
        const m = fs.statSync(f).mtimeMs
        if (now - m <= maxAge) files.push({ f, m })
      } catch {  }
    }
  }
  files.sort((a, b) => b.m - a.m)
  const out = []
  for (const { f } of files.slice(0, o.scan || 12)) {
    const c = readChat(f)
    if (c) out.push(c)
    if (out.length >= (o.limit || 8)) break
  }
  return out
}

function windows(chats, override) {
  const fixed = Number(override)
  const most = (c) => Math.max(c.used || 0, c.peak || 0)
  const big = new Set(chats.filter((c) => most(c) > SMALL_WINDOW && c.model).map((c) => c.model))
  return (chat) => {
    if (fixed > 0) return fixed
    if (most(chat) > SMALL_WINDOW || big.has(chat.model) || /\[1m\]/i.test(chat.model || '')) return LARGE_WINDOW
    return SMALL_WINDOW
  }
}

function withFill(chats, override) {
  const win = windows(chats, override)
  return chats.map((c) => {
    const limit = win(c)
    return { ...c, limit, pct: Math.max(0, Math.min(100, Math.round((c.used / limit) * 100))) }
  })
}

function accountOf(chat, ctx) {
  for (const [folder, name] of Object.entries(ctx.pins || {})) {
    if (matches(folder, chat.project)) return name
  }
  let owner = null
  for (const e of ctx.liveLog || []) {
    if (e.at <= chat.at) owner = e.name
    else break
  }
  return owner
}

function currentChat(chats, folder) {
  if (folder) {
    const here = chats.find((c) => matches(folder, c.project))
    if (here) return here
  }
  return chats[0] || null
}

function brailleBar(pct, chars) {
  const n = chars || 5
  const order = [0x40, 0x04, 0x02, 0x01, 0x80, 0x20, 0x10, 0x08]
  const dots = Math.round((n * 8 * Math.max(0, Math.min(100, pct))) / 100)
  let out = ''
  for (let c = 0; c < n; c++) {
    let code = 0x2800
    for (let d = 0; d < 8; d++) if (c * 8 + d < dots) code |= order[d]
    out += code === 0x2800 ? '⣀' : String.fromCharCode(code)
  }
  return out
}

const PALETTES = {
  dark: { empty: '#2b3138', g: ['#0e4429', '#006d32', '#26a641', '#39d353'], warn: '#cca700', bad: '#f14c4c' },
  light: { empty: '#ebedf0', g: ['#9be9a8', '#40c463', '#30a14e', '#216e39'], warn: '#bf8803', bad: '#e51400' },
}

function shade(k, filled) {
  const r = Math.abs((Math.sin(k * 12.9898) * 43758.5453) % 1)
  const v = (k / Math.max(1, filled)) * 0.75 + r * 0.4
  return v > 0.95 ? 3 : v > 0.7 ? 2 : v > 0.4 ? 1 : 0
}

function gridSvg(pct, o) {
  const cols = o.cols
  const rows = o.rows
  const size = o.size || 10
  const gap = o.gap || 3
  const pal = PALETTES[o.theme === 'light' ? 'light' : 'dark']
  const cells = cols * rows
  const filled = Math.round((cells * Math.max(0, Math.min(100, pct))) / 100)
  const hot = pct >= 95 ? pal.bad : pct >= 80 ? pal.warn : null
  const w = cols * (size + gap) - gap
  const h = rows * (size + gap) - gap
  let rects = ''
  for (let k = 0; k < cells; k++) {
    const x = (k % cols) * (size + gap)
    const y = Math.floor(k / cols) * (size + gap)
    let fill = pal.empty
    let op = ''
    if (k < filled) {
      const s = shade(k, filled)
      fill = hot || pal.g[s]
      if (hot) op = ' fill-opacity="' + [0.45, 0.6, 0.8, 1][s] + '"'
    }
    if (o.shuffle) {
      const a = pal.empty
      const b = pal.g[(k * 7) % 4]
      const begin = -((Math.abs(Math.sin(k * 78.233) * 43758.5453) % 1) * 1.6).toFixed(2)
      rects += '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="2" fill="' + fill + '">' +
        '<animate attributeName="fill" values="' + a + ';' + b + ';' + a + '" dur="1.6s" begin="' + begin + 's" repeatCount="indefinite"/></rect>'
    } else {
      rects += '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="2" fill="' + fill + '"' + op + '/>'
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + rects + '</svg>'
}

function svgDataUri(svg) { return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64') }

function fmtTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1e3) + 'k' }

const sessionCache = new Map()

function sessionStatus(sessionId, home) {
  const dir = path.join(home || os.homedir(), '.claude', 'sessions')
  let best = null
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return null }
  const seen = new Set()
  for (const n of names) {
    const file = path.join(dir, n)
    seen.add(file)
    let rec = sessionCache.get(file)
    try {
      const m = fs.statSync(file).mtimeMs
      if (!rec || rec.mtimeMs !== m) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'))
        rec = { mtimeMs: m, sessionId: j.sessionId, status: j.status, statusUpdatedAt: j.statusUpdatedAt || 0 }
        sessionCache.set(file, rec)
      }
    } catch { continue }
    if (rec.sessionId === sessionId && (!best || rec.statusUpdatedAt > best.statusUpdatedAt)) best = rec
  }
  for (const f of sessionCache.keys()) if (f.startsWith(dir) && !seen.has(f)) sessionCache.delete(f)
  return best ? best.status : null
}

function isCompactCommand(content) {
  return typeof content === 'string' && /^\/compact(\s|$)/.test(content.trim())
}

function isCompacting(chat, o) {
  const opts = o || {}
  if (!chat || !chat.file) return false
  if ((opts.status || sessionStatus(chat.id, opts.home)) !== 'busy') return false
  let st
  try { st = fs.statSync(chat.file) } catch { return false }
  const start = Math.max(0, st.size - 64 * 1024)
  const tail = lines(readSlice(chat.file, start, st.size - start))
  let removed = 0
  for (let i = tail.length - 1; i >= 0; i--) {
    const j = tail[i]
    if (j.type === 'queue-operation' && isCompactCommand(j.content)) {
      if (j.operation === 'remove') removed++
      else if (j.operation === 'enqueue') {
        if (!removed) return true
        removed--
      }
    }
    if (j.type === 'user' || j.type === 'assistant' || j.type === 'system') break
  }
  return chat.pct >= 85 && (opts.now || Date.now()) - st.mtimeMs > 10000
}

function fillFrame(i, chars) {
  const steps = 20
  const k = i % (2 * steps)
  return brailleBar(((k <= steps ? k : 2 * steps - k) / steps) * 100, chars)
}

module.exports = {
  sessionStatus, isCompacting, fillFrame,
  projectsDir, projectKey, folderKeys, readChat, recentChats, withFill, windows, accountOf, currentChat,
  brailleBar, gridSvg, svgDataUri, shade, fmtTokens, SMALL_WINDOW, LARGE_WINDOW,
}
