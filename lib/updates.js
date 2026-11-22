const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')

const fsx = require('./fsx')
const locks = require('./locks')

const REPO = 'clumsyboss/switcher-for-claude-code'
const HOST = 'api.github.com'
const API_PATH = '/repos/' + REPO + '/releases/latest'
const RELEASES_URL = 'https://github.com/' + REPO + '/releases'
const USER_AGENT = 'switcher-for-claude-code'
const STATE_FILE = 'updates.json'
const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 10000
const MAX_BYTES = 1024 * 1024
const LATER_MS = 7 * DAY_MS
const NOTES_MAX = 220
const UPDATE_COMMAND = 'workbench.extensions.installExtension'
const OPEN_PAGE_COMMAND = 'extension.open'

function parseVersion(s) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(s == null ? '' : s).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

function releaseUrl(version) {
  return parseVersion(version) ? RELEASES_URL + '/tag/v' + parseVersion(version).join('.') : RELEASES_URL
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function plainText(s) {
  return String(s == null ? '' : s)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTITIES[e])
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\b(?:https?|ftp|file|vscode|command|data|javascript):\S+/gi, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,3}[.)]\s+)/, '')
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/(^|[\s(])[*_]+(?=\S)|(?<=\S)[*_]+(?=[\s).,;:!?]|$)/g, '$1')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cut(text, max) {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (stop >= max * 0.5) return head.slice(0, stop + 1)
  const space = head.lastIndexOf(' ')
  return (space >= max * 0.5 ? head.slice(0, space) : head).replace(/[\s,;:.\-]+$/, '') + '…'
}

function notesSummary(body, max) {
  const lines = String(body == null ? '' : body).slice(0, 20000).split(/\r?\n/)
  const out = []
  let inList = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { if (out.length) break; continue }
    if (/^#{1,6}\s/.test(line) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line) || /^```/.test(line)) { if (out.length) break; continue }
    const item = /^(?:[-*+]|\d{1,3}[.)])\s+/.test(line)
    if (out.length && item !== inList) break
    inList = item
    const t = plainText(line)
    if (t) out.push(t)
    if (item && out.length >= 2) break
  }
  return cut(out.join(' '), max || NOTES_MAX)
}

function interpret(res) {
  if (!res || typeof res !== 'object') return { error: 'no answer' }
  if (res.error) return { error: String(res.error).slice(0, 200) }
  if (res.status === 304) return { notModified: true }
  if (res.status !== 200) return { error: 'HTTP ' + res.status }
  const etag = res.headers && typeof res.headers.etag === 'string' && res.headers.etag.length <= 200 ? res.headers.etag : null
  let j
  try { j = JSON.parse(String(res.body)) } catch { return { release: null, etag } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { release: null, etag }
  if (j.draft === true || j.prerelease === true) return { release: null, etag }
  const v = parseVersion(j.tag_name)
  const at = typeof j.published_at === 'string' ? Date.parse(j.published_at) : NaN
  if (!v || !Number.isFinite(at)) return { release: null, etag }
  return { release: { version: v.join('.'), publishedAt: at, notes: notesSummary(typeof j.body === 'string' ? j.body : '') }, etag }
}

function defaultRequest(opts) {
  const o = opts || {}
  const local = o.local && typeof o.local === 'object' && Number.isInteger(o.local.port) ? o.local : null
  const limit = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? Math.min(o.timeoutMs, TIMEOUT_MS) : TIMEOUT_MS
  return new Promise((resolve) => {
    let done = false
    let req = null
    let hard = null
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(hard)
      resolve(r)
      if (r.status === 0 && req) { try { req.destroy() } catch {  } }
    }
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }
    if (o.etag) headers['If-None-Match'] = o.etag
    hard = setTimeout(() => finish({ status: 0, error: 'timed out' }), limit)
    if (hard.unref) hard.unref()
    try {
      const target = local ? { hostname: '127.0.0.1', port: local.port } : { hostname: HOST }
      req = (local ? http : https).request({ ...target, path: API_PATH, method: 'GET', headers, timeout: limit }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (d) => {
          size += d.length
          if (size > MAX_BYTES) { finish({ status: 0, error: 'answer too large' }); return }
          chunks.push(d)
        })
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers || {}, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (e) => finish({ status: 0, error: e.message }))
        res.on('close', () => finish({ status: 0, error: 'closed' }))
      })
    } catch (e) { finish({ status: 0, error: e.message }); return }
    req.on('error', (e) => finish({ status: 0, error: e.message }))
    req.on('timeout', () => finish({ status: 0, error: 'timed out' }))
    req.end()
  })
}

function stateFile(dir) { return path.join(dir, STATE_FILE) }

function readState(dir) {
  let j = {}
  try { j = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) } catch { j = {} }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {}
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const ver = (x) => (parseVersion(x) ? parseVersion(x).join('.') : null)
  const r = j.latest
  const latest = r && typeof r === 'object' && ver(r.version) && num(r.publishedAt) !== null
    ? { version: ver(r.version), publishedAt: r.publishedAt, notes: typeof r.notes === 'string' ? cut(plainText(r.notes), NOTES_MAX) : '',
      seenAt: num(r.seenAt) }
    : null
  const l = j.later
  return {
    checkedAt: num(j.checkedAt),
    etag: typeof j.etag === 'string' && j.etag.length <= 200 ? j.etag : null,
    latest,
    error: typeof j.error === 'string' ? j.error.slice(0, 200) : null,
    later: l && typeof l === 'object' && ver(l.version) && num(l.until) !== null ? { version: ver(l.version), until: l.until } : null,
    seen: ver(j.seen),
  }
}

function writeState(dir, patch) {
  const next = Object.assign(readState(dir), patch)
  fsx.writeJsonAtomic(stateFile(dir), next, { mode: 0o644 })
  return next
}

function withSeenAt(prev, release, now) {
  if (!release) return null
  const same = prev && prev.latest && prev.latest.version === release.version && prev.latest.seenAt !== null
  return { ...release, seenAt: same ? prev.latest.seenAt : now }
}

async function check(dir, enabled, deps) {
  const d = deps || {}
  const now = typeof d.now === 'number' ? d.now : Date.now()
  const log = typeof d.log === 'function' ? d.log : () => {}
  const mem = d.memory && typeof d.memory === 'object' ? d.memory : {}
  const limit = typeof d.timeoutMs === 'number' && d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS
  if (!enabled || !dir) return { asked: false, state: dir ? readState(dir) : null }
  let st = readState(dir)
  const recent = (t) => typeof t === 'number' && t <= now && now - t < DAY_MS
  const due = (s) => !recent(s.checkedAt) && !recent(mem.askedAt)
  if (!due(st)) return { asked: false, state: st }
  let release
  try { release = locks.tryAcquire(dir, 'update-check', 60000) } catch { release = null }
  if (!release) return { asked: false, state: st }
  try {
    st = readState(dir)
    if (!due(st)) return { asked: false, state: st }
    mem.askedAt = now
    const request = typeof d.request === 'function' ? d.request : defaultRequest
    let res
    let timer = null
    try {
      res = await Promise.race([
        Promise.resolve().then(() => request({ etag: st.etag && st.latest ? st.etag : null, timeoutMs: limit })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 0, error: 'timed out' }), limit + 1000); if (timer.unref) timer.unref() }),
      ])
    } catch (e) { res = { status: 0, error: (e && e.message) || 'failed' } } finally { clearTimeout(timer) }
    const r = interpret(res)
    let patch
    if (r.error) {
      log('update check: ' + r.error + '; trying again tomorrow')
      patch = { checkedAt: now, error: r.error }
    } else if (r.notModified) patch = { checkedAt: now, error: null }
    else patch = { checkedAt: now, error: null, latest: withSeenAt(st, r.release, now), etag: r.release ? r.etag : null }
    let state
    try { state = writeState(dir, patch) } catch (e) {
      log('update check: could not save the answer (' + ((e && e.message) || e) + '); this window asks again tomorrow')
      state = Object.assign(readState(dir), patch)
    }
    return r.error ? { asked: true, state, error: r.error } : { asked: true, state }
  } finally { release() }
}

function installInfo(extensionsJsonText, id) {
  let list
  try { list = JSON.parse(String(extensionsJsonText)) } catch { return { found: false, pinned: false, source: null } }
  if (!Array.isArray(list)) return { found: false, pinned: false, source: null }
  const want = String(id || '').toLowerCase()
  const e = list.find((x) => x && x.identifier && typeof x.identifier.id === 'string' && x.identifier.id.toLowerCase() === want)
  if (!e) return { found: false, pinned: false, source: null }
  const m = e.metadata && typeof e.metadata === 'object' ? e.metadata : {}
  return { found: true, pinned: m.pinned === true, source: typeof m.source === 'string' ? m.source : null,
    version: parseVersion(e.version) ? parseVersion(e.version).join('.') : null }
}

function extensionsListFile(extensionPath, globalStoragePath) {
  if (typeof globalStoragePath === 'string' && globalStoragePath) {
    const gs = path.dirname(globalStoragePath)
    const profile = path.dirname(gs)
    if (path.basename(gs).toLowerCase() === 'globalstorage' && path.basename(path.dirname(profile)).toLowerCase() === 'profiles') {
      return path.join(profile, 'extensions.json')
    }
  }
  return typeof extensionPath === 'string' && extensionPath ? path.join(path.dirname(extensionPath), 'extensions.json') : null
}

function autoUpdateOff(value) {
  return value === false || value === 'off' || value === 'onlySelectedExtensions'
}

function newerSaved(state, current) {
  return !!(state && state.latest && parseVersion(current) && compare(state.latest.version, current) > 0)
}

function noticeFor(state, current, opts) {
  const o = opts || {}
  if (!o.enabled || !newerSaved(state, current)) return null
  const r = state.latest
  const cur = parseVersion(current)
  const now = typeof o.now === 'number' ? o.now : Date.now()
  if (parseVersion(r.version)[0] > cur[0] + 1) {
    const confirmed = r.seenAt !== null && r.seenAt !== undefined && typeof state.checkedAt === 'number' && state.checkedAt - r.seenAt >= DAY_MS
    if (!confirmed) return null
  }
  if (parseVersion(o.installed) && compare(o.installed, r.version) >= 0) return { restart: true, version: r.version, current: cur.join('.') }
  if (state.later && state.later.version === r.version && now < state.later.until && now >= state.later.until - LATER_MS) return null
  if (!o.wontUpdateItself && now - r.publishedAt < DAY_MS) return null
  return { version: r.version, current: cur.join('.'), notes: r.notes || '', url: releaseUrl(r.version) }
}

function later(dir, version, now) {
  if (!parseVersion(version)) return readState(dir)
  const t = typeof now === 'number' ? now : Date.now()
  return writeState(dir, { later: { version: parseVersion(version).join('.'), until: t + LATER_MS } })
}

function changelogHeadlines(text, version, max) {
  const lines = String(text || '').split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim() === '## ' + version)
  if (at === -1) return []
  const out = []
  for (let i = at + 1; i < lines.length && out.length < (max || 3); i++) {
    if (/^##\s/.test(lines[i])) break
    const m = /^\s*[-*]\s+\*\*(.+?)\*\*/.exec(lines[i])
    if (m) {
      const t = plainText(m[1]).replace(/[\s.,;:]+$/, '')
      if (t) out.push(t)
    }
  }
  return out
}

function whatsNewFor(dir, version, opts) {
  const o = opts || {}
  if (!dir || !parseVersion(version)) return null
  const st = readState(dir)
  if (!st.seen) {
    if (o.firstInstall) { try { writeState(dir, { seen: version }) } catch {  } return null }
  } else if (compare(st.seen, version) >= 0) return null
  return { version: parseVersion(version).join('.'), items: changelogHeadlines(o.changelog, version, 3) }
}

function seenWhatsNew(dir, version) {
  if (!parseVersion(version)) return readState(dir)
  const st = readState(dir)
  if (st.seen && compare(st.seen, version) >= 0) return st
  return writeState(dir, { seen: parseVersion(version).join('.') })
}

async function runUpdate(deps) {
  const d = deps || {}
  const log = typeof d.log === 'function' ? d.log : () => {}
  const target = parseVersion(d.target) ? parseVersion(d.target).join('.') : null
  const url = releaseUrl(target)
  let reason
  try {
    await d.executeCommand(UPDATE_COMMAND, d.id)
    let now = null
    try { now = typeof d.installedVersion === 'function' ? d.installedVersion() : null } catch { now = null }
    if (now === null || !target || compare(now, target) >= 0) return { done: 'installed', reason: null, message: messageFor('installed', null, target, d.current) }
    reason = 'notInStore'
    log('update: the store gave ' + now + ', not ' + target)
  } catch (e) {
    reason = 'noStore'
    log('update: the editor could not install from its store: ' + ((e && e.message) || e))
  }
  try {
    await d.executeCommand(OPEN_PAGE_COMMAND, d.id)
    return { done: 'page', reason, message: messageFor('page', reason, target, d.current) }
  } catch (e) { log('update: could not open the extension\'s page: ' + ((e && e.message) || e)) }
  try {
    const ok = await d.openExternal(url)
    if (ok !== false) return { done: 'browser', reason, message: messageFor('browser', reason, target, d.current) }
  } catch (e) { log('update: could not open the release page: ' + ((e && e.message) || e)) }
  return { done: 'none', reason, message: messageFor('none', reason, target, d.current) }
}

function messageFor(done, reason, target, current) {
  const v = target || 'the new version'
  if (done === 'installed') {
    return 'Switcher ' + v + ' is installed from the editor\'s extension store, in place of the copy that was installed before. ' +
      'The editor will ask to restart extensions to start using it; until then this window keeps running ' + (current || 'the version it has') + '.'
  }
  const why = reason === 'notInStore'
    ? 'The editor\'s extension store doesn\'t have Switcher ' + v + ' yet'
    : 'The editor couldn\'t install Switcher ' + v + ' from its extension store'
  if (done === 'page') return why + ', so the Switcher\'s page in Extensions is open: update it there, or try again later.'
  if (done === 'browser') return why + ', so the release\'s page is open in your browser. Download the .vsix file there and install it with Extensions, ⋯, Install from VSIX.'
  return why + '. Get it from ' + RELEASES_URL + '.'
}

module.exports = {
  REPO, HOST, API_PATH, RELEASES_URL, USER_AGENT, STATE_FILE, DAY_MS, TIMEOUT_MS, MAX_BYTES, LATER_MS, UPDATE_COMMAND, OPEN_PAGE_COMMAND,
  parseVersion, compare, releaseUrl, plainText, cut, notesSummary, interpret, defaultRequest,
  stateFile, readState, writeState, check, installInfo, extensionsListFile, autoUpdateOff, newerSaved, noticeFor, later,
  changelogHeadlines, whatsNewFor, seenWhatsNew, runUpdate, messageFor,
}
