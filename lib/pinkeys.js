const fs = require('fs')
const path = require('path')
const https = require('https')

const fsx = require('./fsx')
const store = require('./store')

const DIR = 'pinkeys'
const YEAR_MS = 365 * 24 * 3600e3
const KEY = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/

function dir(root) { return path.join(root, DIR) }
function keyFile(root, name) {
  if (!store.validName(name)) throw new Error('Invalid account name: ' + name)
  return path.join(dir(root), name + '.key')
}
function metaFile(root, name) { return path.join(dir(root), name + '.json') }

function validKey(key) { return typeof key === 'string' && KEY.test(key.trim()) }

function has(root, name) {
  try { return validKey(fs.readFileSync(keyFile(root, name), 'utf8')) } catch { return false }
}

function info(root, name) {
  if (!has(root, name)) return null
  let m = {}
  try { m = JSON.parse(fs.readFileSync(metaFile(root, name), 'utf8')) } catch {  }
  const createdAt = typeof m.createdAt === 'number' ? m.createdAt : (() => {
    try { return fs.statSync(keyFile(root, name)).mtimeMs } catch { return Date.now() }
  })()
  return { createdAt, expiresAt: createdAt + YEAR_MS }
}

function set(root, name, key, now) {
  const k = String(key || '').trim()
  if (!validKey(k)) throw new Error('Not a pin key')
  fs.mkdirSync(dir(root), { recursive: true })
  store.lockdown(dir(root))
  fsx.writeFileAtomic(keyFile(root, name), k + '\n', { mode: 0o600 })
  fsx.writeFileAtomic(metaFile(root, name), JSON.stringify({ createdAt: now || Date.now() }) + '\n', { mode: 0o600 })
}

function remove(root, name) {
  let gone = false
  for (const f of [keyFile(root, name), metaFile(root, name)]) {
    try { fs.rmSync(f); gone = true } catch {  }
  }
  return gone
}

function names(root) {
  let list = []
  try { list = fs.readdirSync(dir(root)) } catch { return [] }
  return list.filter((f) => f.endsWith('.key')).map((f) => f.slice(0, -4)).filter((n) => store.validName(n) && has(root, n))
}

function check(key, deps) {
  const request = (deps && deps.request) || defaultRequest
  return request(String(key || '').trim()).then(({ status, body }) => {
    if (status === 403 && /scope/i.test(body || '')) return 'ok'
    if (status === 200) return 'ok'
    if (status === 401) return 'rejected'
    return 'unknown'
  }, () => 'unknown')
}

function defaultRequest(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET', timeout: 15000,
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timed out')) })
    req.end()
  })
}

module.exports = { DIR, YEAR_MS, dir, keyFile, validKey, has, info, set, remove, names, check }
