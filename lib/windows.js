const fs = require('fs')
const os = require('os')
const path = require('path')

const credstore = require('./credstore')
const store = require('./store')
const fsx = require('./fsx')

const SHARED = [
  'projects', 'sessions', 'session-env', 'file-history', 'tasks', 'todos', 'plans',
  'agents', 'commands',
]

const SYNCED = 'settings.synced.json'

const SEED_KEYS = [
  'projects', 'mcpServers', 'hasCompletedOnboarding', 'lastOnboardingVersion',
  'bypassPermissionsModeAccepted', 'autoUpdates', 'installMethod', 'editorMode', 'verbose',
]

function home(opts) { return (opts && opts.home) || os.homedir() }
function claudeDir(opts) { return path.join(home(opts), '.claude') }
function windowsRoot(root) { return path.join(root, 'windows') }
function windowDir(root, name) {
  if (!store.validName(name)) throw new Error('Invalid account name: ' + name)
  return path.join(windowsRoot(root), name)
}

function norm(p) {
  const r = path.resolve(String(p).replace(/^\\\\\?\\/, ''))
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function readJson(file, fallback) { return fsx.readJsonLoose(file, fallback) }

function writeAtomic(file, text) {
  fsx.writeFileAtomic(file, text, { mode: 0o600, forceMode: true })
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
}

function removeLink(p) {
  try { fs.unlinkSync(p) } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EISDIR') fs.rmdirSync(p)
    else if (e.code !== 'ENOENT') throw e
  }
}

function nameForDir(root, dir) {
  if (!dir) return null
  if (isWindowDir(root, dir)) {
    const name = path.basename(path.resolve(dir))
    return store.validName(name) ? name : null
  }
  return store.nameForConfigDir(root, dir) || null
}

function isWindowDir(root, dir) {
  return !!dir && norm(path.dirname(path.resolve(dir))) === norm(windowsRoot(root))
}

function ensureLinks(root, name, opts) {
  const dir = windowDir(root, name)
  const shared = claudeDir(opts)
  const done = []
  for (const item of SHARED) {
    const target = path.join(shared, item)
    fs.mkdirSync(target, { recursive: true })
    const link = path.join(dir, item)
    let st = null
    try { st = fs.lstatSync(link) } catch {  }
    if (st && st.isSymbolicLink()) {
      let to = null
      try { to = fs.readlinkSync(link) } catch {  }
      if (to && norm(path.resolve(dir, to)) === norm(target)) { done.push(item); continue }
      removeLink(link)
    } else if (st) {
      fs.renameSync(link, link + '.moved-aside-' + Date.now())
    }
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    done.push(item)
  }
  return done
}

function linksHealthy(root, name, opts) {
  const dir = windowDir(root, name)
  return SHARED.every((item) => {
    const link = path.join(dir, item)
    if (!isLink(link)) return false
    try { return norm(path.resolve(dir, fs.readlinkSync(link))) === norm(path.join(claudeDir(opts), item)) } catch { return false }
  })
}

function seedConfig(root, name, opts) {
  const file = path.join(windowDir(root, name), '.claude.json')
  if (fs.existsSync(file)) return false
  let src
  try { src = fsx.readJsonForWrite(path.join(home(opts), '.claude.json')).data } catch { return false }
  const seed = {}
  for (const k of SEED_KEYS) if (src[k] !== undefined) seed[k] = src[k]
  writeAtomic(file, JSON.stringify(seed, null, 2))
  return true
}

function syncSettings(root, name, opts) {
  let global
  try { global = fsx.readJsonForWrite(path.join(claudeDir(opts), 'settings.json')).data } catch { return false }
  const next = { ...global }
  if (store.remoteManaged(root)) {
    delete next.disableRemoteControl
    if (store.getRemote(root, name) === 'off') next.disableRemoteControl = true
  }
  if (store.artifactsManaged(root)) {
    delete next.enableArtifact
    if (store.getArtifacts(root, name) === 'off') next.enableArtifact = false
  }
  const dir = windowDir(root, name)
  const file = path.join(dir, 'settings.json')
  const syncedFile = path.join(dir, SYNCED)
  const current = readJson(file, null)
  const base = readJson(syncedFile, null)

  const out = { ...next }
  if (current && typeof current === 'object' && base && typeof base === 'object') {
    const managed = new Set()
    if (store.remoteManaged(root)) managed.add('disableRemoteControl')
    if (store.artifactsManaged(root)) managed.add('enableArtifact')
    for (const k of new Set([...Object.keys(current), ...Object.keys(base)])) {
      if (managed.has(k)) continue
      if (JSON.stringify(current[k]) === JSON.stringify(base[k])) continue
      if (k in current) out[k] = current[k]
      else delete out[k]
    }
  }

  const text = JSON.stringify(out, null, 2) + '\n'
  let currentText = null
  try { currentText = fs.readFileSync(file, 'utf8') } catch {  }
  writeAtomic(syncedFile, JSON.stringify(next, null, 2) + '\n')
  if (currentText === text) return false
  writeAtomic(file, text)
  return true
}

function prepare(root, name, opts) {
  const dir = windowDir(root, name)
  fs.mkdirSync(dir, { recursive: true })
  store.lockdown(dir)
  ensureLinks(root, name, opts)
  seedConfig(root, name, opts)
  syncSettings(root, name, opts)
  return dir
}

function loginState(root, name, opts) {
  try { return credstore.exists(windowDir(root, name), opts) ? 'yes' : 'no' } catch { return 'unknown' }
}

function hasLogin(root, name, opts) { return loginState(root, name, opts) === 'yes' }

function identity(root, name) {
  const cfg = readJson(path.join(windowDir(root, name), '.claude.json'), null)
  const o = cfg && cfg.oauthAccount
  return o ? { email: o.emailAddress || null, org: o.organizationName || null } : null
}

const KEEP_ON_FORGET = ['CLAUDE.md', 'skills', 'output-styles', 'history.jsonl']
const BACKUPS_KEPT = 5

function renameRetrying(from, to) {
  const deadline = Date.now() + 1500
  for (;;) {
    try { fs.renameSync(from, to); return } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || Date.now() > deadline) throw e
      fsx.sleepSync(50)
    }
  }
}

function settingsChangedHere(dir) {
  const cur = readJson(path.join(dir, 'settings.json'), null)
  const base = readJson(path.join(dir, SYNCED), null)
  return !!cur && !!base && JSON.stringify(cur) !== JSON.stringify(base)
}

function remove(root, name, opts) {
  const dir = windowDir(root, name)
  if (!fs.existsSync(dir)) return false
  credstore.remove(dir, opts)

  const keep = fs.readdirSync(dir).filter((e) => !isLink(path.join(dir, e)) &&
    (KEEP_ON_FORGET.includes(e) || e.includes('.moved-aside-') || (e === 'settings.json' && settingsChangedHere(dir))))
  let dest = null
  if (keep.length) {
    const backups = path.join(root, 'backups')
    dest = path.join(backups, 'window-' + name + '-' + new Date().toISOString().replace(/[:.]/g, '-'))
    fs.mkdirSync(dest, { recursive: true })
    for (const e of keep) renameRetrying(path.join(dir, e), path.join(dest, e))
    try {
      const mine = fs.readdirSync(backups).filter((f) => f.startsWith('window-' + name + '-') &&
        f.length === ('window-' + name + '-').length + 24).sort()
      for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) fs.rmSync(path.join(backups, old), { recursive: true, force: true })
    } catch {  }
  }

  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (isLink(p)) removeLink(p)
  }
  if (fs.readdirSync(dir).some((e) => isLink(path.join(dir, e)))) {
    throw new Error('Refusing to delete ' + dir + ': a link is still in it')
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return dest || true
}

function decide(root, folder, env, opts) {
  const launched = env && env.CLAUDE_CONFIG_DIR && String(env.CLAUDE_CONFIG_DIR).trim()
  if (launched) {
    return { source: 'launch', dir: launched, name: nameForDir(root, launched), ready: true }
  }
  const name = folder ? store.getPin(root, folder) : null
  if (!name) return { source: null }
  const dir = windowDir(root, name)
  const login = loginState(root, name, opts)
  if (login === 'no') return { source: 'pin', name, dir, ready: false, problem: 'no-login' }
  if (login === 'unknown') return { source: 'pin', name, dir, ready: true, problem: 'login-unknown' }
  return { source: 'pin', name, dir, ready: true }
}

function launchEnv(dir, base) {
  const env = { ...(base || process.env) }
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k)) delete env[k]
  env.CLAUDE_CONFIG_DIR = dir
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  return env
}

module.exports = {
  SHARED, SEED_KEYS, loginState,
  windowsRoot, windowDir, claudeDir, nameForDir, isWindowDir,
  ensureLinks, linksHealthy, seedConfig, syncSettings, prepare, hasLogin, identity, remove,
  decide, launchEnv, removeLink, isLink,
}
