const crypto = require('crypto')

const MAGIC_V1 = 'claude-switcher-move/1'
const MAGIC = 'claude-switcher-move/2'
const SCRYPT = {
  [MAGIC_V1]: { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  [MAGIC]: { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
}
const MIN_PASSPHRASE = 12

function keyFrom(passphrase, salt, magic) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT[magic])
}

function seal(obj, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error('Use a passphrase of at least ' + MIN_PASSPHRASE + ' characters.')
  }
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(passphrase, salt, MAGIC), iv, { authTagLength: 16 })
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return JSON.stringify({ magic: MAGIC, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
}

function b64(v, len) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return null
  const buf = Buffer.from(v, 'base64')
  return len === undefined || buf.length === len ? buf : null
}

function open(text, passphrase) {
  let f
  try { f = JSON.parse(text) } catch { throw new Error('This is not an account move file.') }
  if (!f || (f.magic !== MAGIC && f.magic !== MAGIC_V1)) throw new Error('This is not an account move file.')
  const salt = b64(f.salt, 16)
  const iv = b64(f.iv, 12)
  const tag = b64(f.tag, 16)
  const data = b64(f.data)
  if (!salt || !iv || !tag || !data) throw new Error('This move file is damaged.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(String(passphrase), salt, f.magic), iv, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  let out
  try {
    out = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Wrong passphrase, or the file was damaged on the way.')
  }
  const bundle = JSON.parse(out)
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.accounts)) throw new Error('This move file is damaged.')
  return bundle
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= (max || 200) ? v : null)
const validName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(n)
const validEmailish = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@"<>()[\]\\,;:]+@[^\s@"<>()[\]\\,;:]+$/.test(e)
const validUuid = (u) => typeof u === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(u)
const isoDate = (v) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null)

function validateAccount(a, checks) {
  const c = checks || {}
  if (!isObj(a) || !validName(a.name)) return { ok: false, reason: 'not a valid name' }

  const p = isObj(a.payload) ? a.payload : {}
  const creds = isObj(p.credentials) ? p.credentials : null
  const oauth = creds && isObj(creds.claudeAiOauth) ? creds.claudeAiOauth : null
  if (!oauth || !str(oauth.accessToken, 8192) || !str(oauth.refreshToken, 8192)) {
    return { ok: false, reason: 'no usable login in the file' }
  }
  if (oauth.expiresAt !== undefined && !Number.isFinite(oauth.expiresAt)) return { ok: false, reason: 'its login is damaged' }
  if (JSON.stringify(creds).length > 64 * 1024) return { ok: false, reason: 'its login is unreasonably large' }

  const id = isObj(p.identity) ? p.identity : {}
  const o = isObj(id.oauthAccount) ? id.oauthAccount : null
  const email = o && validEmailish(o.emailAddress) ? o.emailAddress : null
  const uuid = o && validUuid(o.accountUuid) ? o.accountUuid : null
  if (!email && !uuid) return { ok: false, reason: 'no account details in the file' }
  const oauthAccount = {}
  for (const [k, v] of Object.entries(o)) {
    if (/^[A-Za-z0-9_]{1,64}$/.test(k) && (typeof v === 'string' ? v.length <= 500 : typeof v === 'number' || typeof v === 'boolean' || v === null)) {
      oauthAccount[k] = v
    }
  }
  if (email) oauthAccount.emailAddress = email
  else delete oauthAccount.emailAddress
  if (uuid) oauthAccount.accountUuid = uuid
  else delete oauthAccount.accountUuid
  const identity = { oauthAccount }
  if (str(id.userID, 200)) identity.userID = id.userID

  const m = isObj(a.meta) ? a.meta : {}
  const meta = {
    email,
    org: str(oauthAccount.organizationName, 200),
    subscription: str(m.subscription, 50) || str(oauthAccount.seatTier, 50),
    capturedAt: isoDate(m.capturedAt) || isoDate(p.capturedAt) || new Date().toISOString(),
    accountUuid: uuid,
  }

  const d = isObj(a.display) ? a.display : {}
  const display = {}
  if (c.validLabel && c.validLabel(d.label) && d.label !== a.name) display.label = d.label
  if (c.validIcon && c.validIcon(d.icon)) display.icon = d.icon
  if (c.validColor && c.validColor(d.color)) display.color = d.color

  return {
    ok: true,
    account: {
      name: a.name,
      payload: { credentials: creds, identity, capturedAt: meta.capturedAt },
      meta,
      display,
      remote: a.remote === 'off' ? 'off' : 'on',
      artifacts: a.artifacts === 'off' ? 'off' : 'on',
    },
  }
}

module.exports = { MAGIC, MAGIC_V1, MIN_PASSPHRASE, seal, open, validateAccount }
