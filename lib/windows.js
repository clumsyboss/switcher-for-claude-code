const fs = require('fs')
const os = require('os')
const path = require('path')

const credstore = require('./credstore')
const store = require('./store')

const SHARED = [
  'projects', 'sessions', 'session-env', 'file-history', 'tasks', 'todos', 'plans',
  'agents', 'commands',
]

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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
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
  const src = readJson(path.join(home(opts), '.claude.json'), {}) || {}
  const seed = {}
  for (const k of SEED_KEYS) if (src[k] !== undefined) seed[k] = src[k]
  writeAtomic(file, JSON.stringify(seed, null, 2))
  return true
}

function syncSettings(root, name, opts) {
  const global = readJson(path.join(claudeDir(opts), 'settings.json'), {}) || {}
  const next = { ...global }
  delete next.disableRemoteControl
  if (store.getRemote(root, name) === 'off') next.disableRemoteControl = true
  if (store.artifactsManaged(root)) {
    delete next.enableArtifact
    if (store.getArtifacts(root, name) === 'off') next.enableArtifact = false
  }
  const file = path.join(windowDir(root, name), 'settings.json')
  const text = JSON.stringify(next, null, 2) + '\n'
  let current = null
  try { current = fs.readFileSync(file, 'utf8') } catch {  }
  if (current === text) return false
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

function hasLogin(root, name, opts) {
  try { return credstore.exists(windowDir(root, name), opts) } catch { return false }
}

function identity(root, name) {
  const cfg = readJson(path.join(windowDir(root, name), '.claude.json'), null)
  const o = cfg && cfg.oauthAccount
  return o ? { email: o.emailAddress || null, org: o.organizationName || null } : null
}

function remove(root, name, opts) {
  const dir = windowDir(root, name)
  if (!fs.existsSync(dir)) return false
  try { credstore.remove(dir, opts) } catch {  }
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (isLink(p)) removeLink(p)
  }
  if (fs.readdirSync(dir).some((e) => isLink(path.join(dir, e)))) {
    throw new Error('Refusing to delete ' + dir + ': a link is still in it')
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

function decide(root, folder, env, opts) {
  const launched = env && env.CLAUDE_CONFIG_DIR && String(env.CLAUDE_CONFIG_DIR).trim()
  if (launched) {
    return { source: 'launch', dir: launched, name: nameForDir(root, launched), ready: true }
  }
  const name = folder ? store.getPin(root, folder) : null
  if (!name) return { source: null }
  const dir = windowDir(root, name)
  if (!hasLogin(root, name, opts)) return { source: 'pin', name, dir, ready: false, problem: 'no-login' }
  return { source: 'pin', name, dir, ready: true }
}

function launchEnv(dir, base) {
  const env = { ...(base || process.env) }
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k)) delete env[k]
  env.CLAUDE_CONFIG_DIR = dir
  return env
}

module.exports = {
  SHARED, SEED_KEYS,
  windowsRoot, windowDir, claudeDir, nameForDir, isWindowDir,
  ensureLinks, linksHealthy, seedConfig, syncSettings, prepare, hasLogin, identity, remove,
  decide, launchEnv, removeLink, isLink,
}
