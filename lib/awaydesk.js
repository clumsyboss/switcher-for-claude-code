const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')

const fsx = require('./fsx')
const locks = require('./locks')

const EXTENSION_ID = 'clumsyboss.awaydesk'
const PAIR_COMMAND = 'awaydesk.pair'
const OPEN_COMMAND = 'extension.open'
const USER_AGENT = 'switcher-for-claude-code'
const STATE_FILE = 'awaydesk.json'
const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 10000
const MAX_BYTES = 1024 * 1024

const STORES = {
  marketplace: { host: 'marketplace.visualstudio.com', path: '/_apis/public/gallery/extensionquery', method: 'POST' },
  openvsx: { host: 'open-vsx.org', path: '/api/clumsyboss/awaydesk', method: 'GET' },
}

function storeFor(appName) {
  return /^visual studio code(?: - insiders)?$/i.test(String(appName == null ? '' : appName).trim()) ? 'marketplace' : 'openvsx'
}

function marketplaceQuery() {
  return JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }], pageNumber: 1, pageSize: 1 }], flags: 0 })
}

function interpret(store, res) {
  if (!res || typeof res !== 'object') return { error: 'no answer' }
  if (res.error) return { error: String(res.error).slice(0, 200) }
  if (store === 'openvsx' && res.status === 404) return { listed: false }
  if (res.status !== 200) return { error: 'HTTP ' + res.status }
  let j
  try { j = JSON.parse(String(res.body)) } catch { return { error: 'unreadable answer' } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'unreadable answer' }
  if (store === 'marketplace') {
    const r = Array.isArray(j.results) ? j.results[0] : null
    if (!r || !Array.isArray(r.extensions)) return { error: 'unreadable answer' }
    return { listed: r.extensions.some((e) => e && e.publisher && String(e.publisher.publisherName).toLowerCase() === 'clumsyboss' &&
      String(e.extensionName).toLowerCase() === 'awaydesk') }
  }
  if (j.error) return { listed: false }
  return { listed: String(j.namespace).toLowerCase() === 'clumsyboss' && String(j.name).toLowerCase() === 'awaydesk' }
}

function defaultRequest(opts) {
  const o = opts || {}
  const store = STORES[o.store] ? o.store : 'openvsx'
  const where = STORES[store]
  const local = o.local && typeof o.local === 'object' && Number.isInteger(o.local.port) ? o.local : null
  const limit = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? Math.min(o.timeoutMs, TIMEOUT_MS) : TIMEOUT_MS
  const body = where.method === 'POST' ? marketplaceQuery() : null
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
    const headers = { 'User-Agent': USER_AGENT, Accept: store === 'marketplace' ? 'application/json;api-version=3.0-preview.1' : 'application/json' }
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body) }
    hard = setTimeout(() => finish({ status: 0, error: 'timed out' }), limit)
    if (hard.unref) hard.unref()
    try {
      const target = local ? { hostname: '127.0.0.1', port: local.port } : { hostname: where.host }
      req = (local ? http : https).request({ ...target, path: where.path, method: where.method, headers, timeout: limit }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (d) => {
          size += d.length
          if (size > MAX_BYTES) { finish({ status: 0, error: 'answer too large' }); return }
          chunks.push(d)
        })
        res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (e) => finish({ status: 0, error: e.message }))
        res.on('close', () => finish({ status: 0, error: 'closed' }))
      })
    } catch (e) { finish({ status: 0, error: e.message }); return }
    req.on('error', (e) => finish({ status: 0, error: e.message }))
    req.on('timeout', () => finish({ status: 0, error: 'timed out' }))
    if (body) req.write(body)
    req.end()
  })
}

function stateFile(dir) { return path.join(dir, STATE_FILE) }

function readState(dir) {
  let j = {}
  try { j = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) } catch { j = {} }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {}
  const out = {}
  for (const s of Object.keys(STORES)) {
    const e = j[s]
    out[s] = e && typeof e === 'object' && typeof e.checkedAt === 'number' && Number.isFinite(e.checkedAt)
      ? { checkedAt: e.checkedAt, listed: e.listed === true, error: typeof e.error === 'string' ? e.error.slice(0, 200) : null }
      : null
  }
  return out
}

function writeState(dir, store, entry) {
  const next = Object.assign(readState(dir), { [store]: entry })
  fsx.writeJsonAtomic(stateFile(dir), next, { mode: 0o644 })
  return next
}

async function check(dir, store, enabled, deps) {
  const d = deps || {}
  const now = typeof d.now === 'number' ? d.now : Date.now()
  const log = typeof d.log === 'function' ? d.log : () => {}
  const mem = d.memory && typeof d.memory === 'object' ? d.memory : {}
  const limit = typeof d.timeoutMs === 'number' && d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS
  if (!STORES[store]) store = 'openvsx'
  if (!enabled || !dir) return { asked: false, listed: false }
  const recent = (t) => typeof t === 'number' && t <= now && now - t < DAY_MS
  const saved = () => readState(dir)[store]
  const due = (e) => !(e && recent(e.checkedAt)) && !recent(mem[store])
  let st = saved()
  if (!due(st)) return { asked: false, listed: !!(st && st.listed) }
  let release
  try { release = locks.tryAcquire(dir, 'awaydesk-check', 60000) } catch { release = null }
  if (!release) return { asked: false, listed: !!(st && st.listed) }
  try {
    st = saved()
    if (!due(st)) return { asked: false, listed: !!(st && st.listed) }
    mem[store] = now
    const request = typeof d.request === 'function' ? d.request : defaultRequest
    let res
    let timer = null
    try {
      res = await Promise.race([
        Promise.resolve().then(() => request({ store, timeoutMs: limit })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 0, error: 'timed out' }), limit + 1000); if (timer.unref) timer.unref() }),
      ])
    } catch (e) { res = { status: 0, error: (e && e.message) || 'failed' } } finally { clearTimeout(timer) }
    const r = interpret(store, res)
    const entry = r.error
      ? { checkedAt: now, listed: !!(st && st.listed), error: r.error }
      : { checkedAt: now, listed: r.listed, error: null }
    if (r.error) log('Awaydesk store check: ' + r.error + '; trying again tomorrow')
    try { writeState(dir, store, entry) } catch (e) {
      log('Awaydesk store check: could not save the answer (' + ((e && e.message) || e) + '); this window asks again tomorrow')
    }
    return r.error ? { asked: true, listed: entry.listed, error: r.error } : { asked: true, listed: entry.listed }
  } finally { release() }
}

function savedListed(dir, store) {
  try { const e = readState(dir)[STORES[store] ? store : 'openvsx']; return !!(e && e.listed) } catch { return false }
}

function modeFor(opts) {
  const o = opts || {}
  if (o.installed) return 'connect'
  if (o.platform !== 'win32') return 'other'
  return o.listed ? 'get' : 'soon'
}

module.exports = {
  EXTENSION_ID, PAIR_COMMAND, OPEN_COMMAND, USER_AGENT, STATE_FILE, DAY_MS, TIMEOUT_MS, MAX_BYTES, STORES,
  storeFor, marketplaceQuery, interpret, defaultRequest, stateFile, readState, writeState, check, savedListed, modeFor,
}
