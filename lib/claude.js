const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

let cached

function resolveBin() {
  if (cached !== undefined) return cached
  const home = os.homedir()
  const candidates = process.platform === 'win32'
    ? [
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules',
        '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.exe'),
    ]
    : [
      path.join(home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
      '/usr/bin/claude',
    ]
  for (const c of candidates) if (fs.existsSync(c)) return (cached = c)
  try {
    const out = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    const hit = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .sort((a, b) => (b.endsWith('.exe') ? 1 : 0) - (a.endsWith('.exe') ? 1 : 0))[0]
    if (hit) return (cached = hit)
  } catch {  }
  return (cached = null)
}

function isDefaultDir(configDir) {
  if (!configDir) return true
  const a = path.resolve(configDir)
  const b = path.resolve(os.homedir(), '.claude')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function envFor(configDir, extra) {
  const env = { ...process.env, ...(extra || {}) }
  if (isDefaultDir(configDir)) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = configDir
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

module.exports = { resolveBin, envFor, authStatus }
