const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

let cached

function newestNvm(home) {
  const base = path.join(home, '.nvm', 'versions', 'node')
  let versions = []
  try { versions = fs.readdirSync(base) } catch { return [] }
  const key = (v) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0)
  versions.sort((a, b) => { const x = key(a); const y = key(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] })
  return versions.map((v) => path.join(base, v, 'bin', 'claude'))
}

function candidates(home) {
  if (process.platform === 'win32') {
    return [
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules',
        '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.exe'),
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, '.asdf', 'shims', 'claude'),
    path.join(home, 'Library', 'pnpm', 'claude'),
    path.join(home, '.local', 'share', 'pnpm', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    ...newestNvm(home),
    '/usr/bin/claude',
  ]
}

function fromPath() {
  try {
    const out = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .sort((a, b) => (b.endsWith('.exe') ? 1 : 0) - (a.endsWith('.exe') ? 1 : 0))[0] || null
  } catch { return null }
}

function fromLoginShell() {
  if (process.platform === 'win32') return null
  const sh = process.env.SHELL || '/bin/zsh'
  try {
    const out = cp.execFileSync(sh, ['-lic', 'command -v claude'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const hit = out.split(/\r?\n/).map((x) => x.trim()).filter((x) => path.isAbsolute(x)).pop()
    return hit && fs.existsSync(hit) ? hit : null
  } catch { return null }
}

function resolveBin() {
  if (cached) return cached
  const home = os.homedir()
  for (const c of candidates(home)) if (fs.existsSync(c)) return (cached = c)
  const hit = fromPath() || fromLoginShell()
  if (hit) cached = hit
  return hit || null
}

function isDefaultDir(configDir) {
  if (!configDir) return true
  const a = path.resolve(configDir)
  const b = path.resolve(os.homedir(), '.claude')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function envFor(configDir, extra) {
  const env = { ...process.env, ...(extra || {}) }
  const setAside = env.CLAUDESWITCHER_SECURESTORAGE_CONFIG_DIR
  delete env.CLAUDESWITCHER_SECURESTORAGE_CONFIG_DIR
  if (isDefaultDir(configDir)) {
    delete env.CLAUDE_CONFIG_DIR
    if (setAside !== undefined && env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = setAside
  } else {
    env.CLAUDE_CONFIG_DIR = configDir
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  }
  return env
}

function authStatus(configDir, timeout = 30000) {
  const bin = resolveBin()
  if (!bin) return { ok: false, error: 'claude CLI not found on PATH' }
  const r = cp.spawnSync(bin, ['auth', 'status', '--json'], {
    env: envFor(configDir), encoding: 'utf8', windowsHide: true, timeout,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  })
  if (r.error) return { ok: false, error: r.error.message }
  let j
  try { j = JSON.parse((r.stdout || '').trim()) } catch {
    return { ok: false, error: (r.stderr || '').trim() || `claude exited ${r.status}` }
  }
  return {
    ok: true,
    loggedIn: !!j.loggedIn,
    email: j.email || null,
    orgName: j.orgName || null,
    subscriptionType: j.subscriptionType || null,
    authMethod: j.authMethod || null,
  }
}

module.exports = { resolveBin, envFor, authStatus, candidates }
