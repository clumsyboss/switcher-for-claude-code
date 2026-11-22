const fs = require('fs')
const os = require('os')
const path = require('path')

const KEY = 'claudeCode.claudeProcessWrapper'
const PRODUCTS = ['Code', 'Code - Insiders', 'Cursor', 'Cursor Nightly', 'Windsurf', 'Windsurf - Next', 'VSCodium', 'VSCodium - Insiders',
  'Code - OSS', 'Antigravity', 'Kiro', 'Trae', 'Positron']

function pathFor(platform) { return platform === 'win32' ? path.win32 : path.posix }

function userDirs(opts) {
  const o = opts || {}
  const platform = o.platform || process.platform
  const home = o.home || os.homedir()
  const env = o.env || process.env
  const p = pathFor(platform)
  let base
  if (platform === 'win32') base = env.APPDATA || p.join(home, 'AppData', 'Roaming')
  else if (platform === 'darwin') base = p.join(home, 'Library', 'Application Support')
  else base = env.XDG_CONFIG_HOME || p.join(home, '.config')
  return PRODUCTS.map((name) => p.join(base, name, 'User'))
}

function settingsFiles(opts, dirs) {
  const p = pathFor((opts && opts.platform) || process.platform)
  const out = []
  for (const dir of dirs || userDirs(opts)) {
    out.push(p.join(dir, 'settings.json'))
    let profiles = []
    try { profiles = fs.readdirSync(p.join(dir, 'profiles')) } catch {  }
    for (const id of profiles) out.push(p.join(dir, 'profiles', id, 'settings.json'))
  }
  return out
}

function pointsInto(value, binDir, platform) {
  if (typeof value !== 'string' || !value) return false
  const p = pathFor(platform)
  const fold = platform === 'win32' || platform === 'darwin'
  const norm = (x) => { let s = p.normalize(platform === 'win32' ? x.replace(/\//g, '\\') : x); if (fold) s = s.toLowerCase(); return s }
  const v = norm(value)
  const d = norm(binDir)
  if (!p.isAbsolute(v)) return false
  const rel = p.relative(d, v)
  return !!rel && !rel.startsWith('..') && !p.isAbsolute(rel)
}

function tokens(text) {
  const out = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') { i++; continue }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue }
    if ('{}[]:,'.includes(c)) { out.push({ t: c, start: i, end: i + 1 }); i++; continue }
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; if (text[j] === '\n') return null; j++ }
      if (j >= n) return null
      out.push({ t: 'str', start: i, end: j + 1 })
      i = j + 1
      continue
    }
    let j = i
    while (j < n && !/[\s{}[\]:,"/]/.test(text[j])) j++
    if (j === i) j = i + 1
    out.push({ t: 'lit', start: i, end: j })
    i = j
  }
  return out
}

function str(text, tok) {
  try { return JSON.parse(text.slice(tok.start, tok.end)) } catch { return null }
}

function wholeLine(text, s, e) {
  const ls = text.lastIndexOf('\n', s - 1) + 1
  let le = text.indexOf('\n', e)
  le = le < 0 ? text.length : le
  if (/^[ \t]*$/.test(text.slice(ls, s)) && /^[ \t\r]*$/.test(text.slice(e, le))) return [ls, le < text.length ? le + 1 : le]
  while (e < le && (text[e] === ' ' || text[e] === '\t')) e++
  return [s, e]
}

function removeOnce(text, binDir, platform) {
  const toks = tokens(text)
  if (!toks || !toks.length || toks[0].t !== '{') return null
  let depth = 0
  let hit = -1
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i]
    if (k.t === '{' || k.t === '[') depth++
    else if (k.t === '}' || k.t === ']') depth--
    else if (depth === 1 && k.t === 'str' && toks[i + 1] && toks[i + 1].t === ':' && toks[i + 2] && toks[i + 2].t === 'str' &&
      toks[i + 3] && (toks[i + 3].t === ',' || toks[i + 3].t === '}') && (toks[i - 1].t === '{' || toks[i - 1].t === ',') &&
      str(text, k) === KEY && pointsInto(str(text, toks[i + 2]), binDir, platform)) hit = i
  }
  if (hit < 0) return null
  const key = toks[hit]
  const val = toks[hit + 2]
  const next = toks[hit + 3]
  const prev = toks[hit - 1]
  const cuts = []
  if (next.t === ',') {
    if (/^\s*$/.test(text.slice(val.end, next.start))) cuts.push(wholeLine(text, key.start, next.end))
    else { cuts.push([next.start, next.end]); cuts.push(wholeLine(text, key.start, val.end)) }
  } else {
    cuts.push(wholeLine(text, key.start, val.end))
    if (prev.t === ',') cuts.push([prev.start, prev.end])
  }
  cuts.sort((a, b) => b[0] - a[0])
  let out = text
  for (const [s, e] of cuts) out = out.slice(0, s) + out.slice(e)
  return out
}

function removeWrapperSetting(text, binDir, platform) {
  let cur = text
  let changed = false
  for (let n = 0; n < 20; n++) {
    const next = removeOnce(cur, binDir, platform || process.platform)
    if (next === null) break
    cur = next
    changed = true
  }
  return changed ? cur : null
}

function writeInPlace(file, text) {
  const real = fs.realpathSync(file)
  const mode = fs.statSync(real).mode & 0o777
  const tmp = real + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    fs.writeFileSync(tmp, text, { mode })
    fs.renameSync(tmp, real)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch {  }
    throw e
  }
}

function lib(name) {
  try { return require(path.join(__dirname, '..', 'lib', name)) } catch { return null }
}

function ownUserDirs(o, root, ext) {
  const editors = lib('editors.js')
  if (!editors) return userDirs(o)
  let list = []
  let others = []
  try { list = editors.read(root); others = editors.othersInstalled(root, ext) } catch {  }
  const up = (d) => (editors.userRootOf ? editors.userRootOf(d) : d)
  const own = list.filter((e) => editors.same(e.ext, ext)).map((e) => up(e.user))
  if (own.length) return own.filter((d, i) => own.findIndex((x) => editors.same(x, d)) === i)
  const all = [...userDirs(o), ...list.map((e) => up(e.user))]
  return all.filter((d, i) => all.findIndex((x) => editors.same(x, d)) === i && !others.some((e) => editors.same(up(e.user), d)))
}

function cleanShared(root, home, ext) {
  const file = path.join(home, '.claude', 'settings.json')
  try {
    const editors = lib('editors.js')
    const others = editors ? editors.othersInstalled(root, ext) : []
    if (others.length) return { file, changed: false, skipped: 'installed in another editor' }
    const store = lib('store.js')
    const artifacts = lib('artifacts.js')
    if (!store || !artifacts) return null
    const added = store.getArtifactsAdded(root)
    const active = store.getActive(root)
    const wroteOff = !!active && store.getArtifacts(root, active) === 'off'
    if (!added && !wroteOff) return null
    const r = artifacts.setOff(false, { home, keepKey: !wroteOff }, root)
    return { file, changed: !!(r && r.changed) }
  } catch (e) {
    return { file, changed: false, error: String((e && e.code) || (e && e.message) || e) }
  }
}

function run(opts) {
  const results = []
  try {
    const o = opts || {}
    const platform = o.platform || process.platform
    const home = o.home || os.homedir()
    const root = o.root || pathFor(platform).join(home, '.claude-switcher')
    const ext = o.ext || path.join(__dirname, '..')
    const binDir = pathFor(platform).join(root, 'bin')
    const oo = Object.assign({}, o, { platform, home })
    let files = o.files
    if (!files) { try { files = settingsFiles(oo, ownUserDirs(oo, root, ext)) } catch { files = settingsFiles(oo) } }
    for (const file of files) {
      try {
        let text
        try { text = fs.readFileSync(file, 'utf8') } catch { continue }
        if (!text.includes(KEY)) { results.push({ file, changed: false }); continue }
        const next = removeWrapperSetting(text, binDir, platform)
        if (next === null) { results.push({ file, changed: false }); continue }
        writeInPlace(file, next)
        results.push({ file, changed: true })
      } catch (e) {
        results.push({ file, changed: false, error: String((e && e.code) || (e && e.message) || e) })
      }
    }
    if (o.shared !== false) {
      const s = cleanShared(root, home, ext)
      if (s) results.push(Object.assign({ shared: true }, s))
    }
    const editors = lib('editors.js')
    if (editors) editors.forget(root, ext)
  } catch {  }
  return results
}

module.exports = { KEY, PRODUCTS, userDirs, settingsFiles, pointsInto, tokens, removeWrapperSetting, run }

if (require.main === module) {
  try {
    for (const r of run()) {
      if (r.changed || r.error) {
        console.log((r.changed ? (r.shared ? 'removed the Artifacts deny rules from ' : 'removed the pin wrapper setting from ') : 'could not update ') + r.file + (r.error ? ' (' + r.error + ')' : ''))
      }
    }
  } catch {  }
  process.exitCode = 0
}
