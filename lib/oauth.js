const https = require('https')

const TOKEN_HOST = 'platform.claude.com'
const TOKEN_PATH = '/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPES = [
  'user:profile', 'user:inference', 'user:sessions:claude_code',
  'user:mcp_servers', 'user:file_upload', 'user:plugins',
]

function body(refreshToken) {
  return {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
  }
}

function request(refreshToken, timeoutMs) {
  const payload = JSON.stringify(body(refreshToken))
  return new Promise((resolve) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path: TOKEN_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs || 30000,
    }, (res) => {
      let data = ''
      res.on('data', (d) => { data += d })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timed out' }) })
    req.end(payload)
  })
}

function interpret(res, previous, now) {
  const t = now || Date.now()
  let data = null
  try { data = res.body ? JSON.parse(res.body) : null } catch {  }

  if (res.status === 200) {
    if (!data || typeof data.access_token !== 'string' || !(Number(data.expires_in) > 0)) {
      return { ok: false, reason: 'the renewal response had no usable token' }
    }
    const scopes = typeof data.scope === 'string' && data.scope.trim()
      ? data.scope.trim().split(/\s+/) : (previous && previous.scopes)
    const rtExpires = Number(data.refresh_token_expires_in) > 0
      ? t + Number(data.refresh_token_expires_in) * 1000
      : (previous && previous.refreshTokenExpiresAt)
    return {
      ok: true,
      oauth: {
        ...(previous || {}),
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' && data.refresh_token
          ? data.refresh_token : previous.refreshToken,
        expiresAt: t + Number(data.expires_in) * 1000,
        refreshTokenExpiresAt: rtExpires,
        scopes,
      },
    }
  }

  if (res.status === 400 || res.status === 401) {
    const err = data && data.error
    const code = typeof err === 'string' ? err : (err && (err.type || err.code)) || ''
    const msg = (data && (data.error_description || (err && err.message))) || ''
    return {
      ok: false,
      rejected: true,
      reason: 'the saved login was rejected' + (code || msg ? ' (' + [code, msg].filter(Boolean).join(': ') + ')' : ''),
    }
  }
  if (res.status === 0) return { ok: false, reason: res.error || 'network error' }
  return { ok: false, reason: 'the token server returned HTTP ' + res.status }
}

module.exports = { request, interpret, body, TOKEN_HOST, TOKEN_PATH, CLIENT_ID, SCOPES }
