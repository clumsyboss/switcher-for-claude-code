const fs = require('fs')
const path = require('path')

const fsx = require('./fsx')
const store = require('./store')

const FILE = 'chat-pins.tsv'
const WRAPPER_FILE = 'pins.tsv'
const ENV = 'CLAUDESWITCHER_PINS'
const ID = /^[A-Za-z0-9-]{8,64}$/

function file(root) { return path.join(root, FILE) }
function wrapperFile(root) { return path.join(root, WRAPPER_FILE) }

function validId(id) { return typeof id === 'string' && ID.test(id) }

function read(root) {
  let text = ''
  try { text = fs.readFileSync(file(root), 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const [id, name, title] = line.split('\t')
    if (validId(id) && store.validName(name)) out.push({ id, name, title: title || null })
  }
  return out
}

function write(root, pins) {
  const text = pins.map((p) => [p.id, p.name, p.title || ''].join('\t')).join('\n') + (pins.length ? '\n' : '')
  fsx.writeFileAtomic(file(root), text)
}

function set(root, id, name, title) {
  if (!validId(id)) throw new Error('Not a chat id: ' + id)
  if (!store.validName(name)) throw new Error('Invalid account name: ' + name)
  const t = title ? String(title).replace(/[\t\r\n]+/g, ' ').trim().slice(0, 120) : null
  write(root, read(root).filter((p) => p.id !== id).concat([{ id, name, title: t }]))
}

function remove(root, id) {
  const pins = read(root)
  const left = pins.filter((p) => p.id !== id)
  if (left.length !== pins.length) write(root, left)
  return left.length !== pins.length
}

function forget(root, name) {
  const pins = read(root)
  const left = pins.filter((p) => p.name !== name)
  if (left.length !== pins.length) write(root, left)
}

function loginLine(name, login) {
  if (!login || typeof login !== 'object') return null
  const at = login.expiresAt
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
  if (typeof login.dir !== 'string' || !login.dir || /[\t\r\n]/.test(login.dir)) return null
  return ['login', name, String(Math.floor(at)), login.dir].join('\t')
}

function writeWrapperFile(root, folderPins, loginOf) {
  const logins = new Map()
  const lineFor = (name) => {
    if (!logins.has(name)) {
      let l = null
      try { l = store.validName(name) ? loginLine(name, loginOf(name)) : null } catch { l = null }
      logins.set(name, l)
    }
    return logins.get(name)
  }
  const pinLines = []
  for (const p of read(root)) if (lineFor(p.name)) pinLines.push(['chat', p.id, p.name].join('\t'))
  for (const f of folderPins || []) {
    if (!f || !f.folder || /[\t\r\n]/.test(f.folder) || !store.validName(f.name) || !lineFor(f.name)) continue
    pinLines.push(['folder', f.folder, f.name].join('\t'))
  }
  const lines = [...logins.values()].filter(Boolean).concat(pinLines)
  fsx.writeFileAtomic(wrapperFile(root), lines.join('\n') + (lines.length ? '\n' : ''))
  return pinLines.length
}

function pinFor(lines, sessionId, cwd, platform) {
  const win = (platform || process.platform) === 'win32'
  const norm = (p) => { let x = String(p || '').replace(/[\\/]+$/, ''); if (win) x = x.replace(/\//g, '\\').toLowerCase(); return x }
  const sep = win ? '\\' : '/'
  let folderHit = null
  for (const line of lines) {
    const [kind, key, name] = line.split('\t')
    if (kind === 'chat' && sessionId && key === sessionId) return name
    if (kind === 'folder' && cwd) {
      const f = norm(key)
      const c = norm(cwd)
      if ((c === f || c.startsWith(f + sep)) && (!folderHit || f.length > folderHit.len)) folderHit = { name, len: f.length }
    }
  }
  return folderHit ? folderHit.name : null
}

function wrapperName(platform) { return (platform || process.platform) === 'win32' ? 'claude-wrapper.exe' : 'claude-wrapper.sh' }

function installWrapper(root, extensionDir, platform) {
  const name = wrapperName(platform)
  const src = path.join(extensionDir, 'wrapper', name)
  if (!fs.existsSync(src)) return null
  const dest = path.join(root, 'bin', name)
  const data = fs.readFileSync(src)
  let same = false
  try { same = fs.readFileSync(dest).equals(data) } catch {  }
  if (!same) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fsx.writeFileAtomic(dest, data)
  }
  if ((platform || process.platform) !== 'win32') { try { fs.chmodSync(dest, 0o755) } catch {  } }
  return dest
}

function samePath(a, b) {
  if (!a || !b) return false
  const n = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

function wrapperAction(current, ours, anyPins) {
  const isOurs = samePath(current, ours)
  if (current && !isOurs) return 'foreign'
  if (anyPins) return isOurs ? 'keep' : 'on'
  return isOurs ? 'off' : 'keep'
}

function tabMatches(label, title) {
  const even = (v) => String(v || '').replace(/\s+/g, ' ').trim()
  const l = even(label)
  const t = even(title)
  if (!l || !t) return false
  if (l.endsWith('\u2026')) {
    const start = l.slice(0, -1).trimEnd()
    return start !== '' && t !== start && t.startsWith(start)
  }
  return l === t
}

function sessionIdOf(args) {
  let sid = null
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if ((a === '--resume' || a === '--session-id') && i + 1 < args.length) sid = args[i + 1]
    else if (a.startsWith('--resume=')) sid = a.slice(9)
    else if (a.startsWith('--session-id=')) sid = a.slice(13)
  }
  return validId(sid) ? sid : null
}

function projectSlug(folder) { return String(folder).replace(/[^A-Za-z0-9]/g, '-') }

function titleOf(fp) {
  let fd
  let raw = null
  let prompt = null
  try {
    fd = fs.openSync(fp, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')
    let custom = null
    let ai = null
    for (const m of text.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)) custom = m[1]
    for (const m of text.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)) ai = m[1]
    for (const m of text.matchAll(/"type":"last-prompt","lastPrompt":"((?:[^"\\]|\\.)*)"/g)) prompt = m[1]
    raw = custom || ai
  } catch { return null } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {  } }
  const decode = (s) => { try { return JSON.parse('"' + s + '"') } catch { return null } }
  if (raw) return decode(raw)
  const last = prompt ? (decode(prompt) || '').replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return last || firstPromptOf(fp)
}

function chatFile(projectsRoot, id) {
  if (!validId(id)) return null
  let dirs = []
  try { dirs = fs.readdirSync(projectsRoot) } catch { return null }
  for (const d of dirs) {
    const f = path.join(projectsRoot, d, id + '.jsonl')
    if (fs.existsSync(f)) return f
  }
  return null
}

function firstPromptOf(fp) {
  let fd
  try {
    fd = fs.openSync(fp, 'r')
    const len = Math.min(fs.fstatSync(fd).size, 256 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"type":"user"')) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (!j || j.type !== 'user' || j.isMeta || j.isSidechain || !j.message) continue
      const c = j.message.content
      const parts = typeof c === 'string' ? [c]
        : Array.isArray(c) && !c.some((x) => x && x.type === 'tool_result')
          ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text) : []
      const text = parts.map((t) => t.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ')).join(' ').replace(/\s+/g, ' ').trim()
      if (!text || text.startsWith('<')) continue
      return text.slice(0, 200)
    }
    return null
  } catch { return null } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {  } }
}

function listChats(projectsRoot, folder, max) {
  const dir = path.join(projectsRoot, projectSlug(folder))
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const chats = []
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    const id = n.slice(0, -6)
    if (!validId(id)) continue
    let at = 0
    try { at = fs.statSync(path.join(dir, n)).mtimeMs } catch { continue }
    chats.push({ id, at, file: path.join(dir, n) })
  }
  chats.sort((a, b) => b.at - a.at)
  return chats.slice(0, max || 30).map((c) => ({ id: c.id, at: c.at, title: titleOf(c.file) }))
}

module.exports = {
  FILE, WRAPPER_FILE, ENV, file, wrapperFile, validId, read, set, remove, forget, writeWrapperFile, pinFor,
  wrapperName, installWrapper, wrapperAction, samePath, sessionIdOf, tabMatches,
  projectSlug, titleOf, listChats, chatFile,
}
