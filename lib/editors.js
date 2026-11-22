const fs = require('fs')
const path = require('path')

const fsx = require('./fsx')

const FILE = 'editors.json'

function filePath(root) { return path.join(root, FILE) }

function read(root) {
  const v = fsx.readJsonLoose(filePath(root), [])
  if (!Array.isArray(v)) return []
  return v.filter((e) => e && typeof e.user === 'string' && typeof e.ext === 'string' && path.isAbsolute(e.user) && path.isAbsolute(e.ext))
    .map((e) => ({ user: e.user, ext: e.ext }))
}

function userRootOf(dir) {
  if (typeof dir !== 'string' || !dir) return dir
  const up = path.dirname(dir)
  const user = path.dirname(up)
  return path.basename(up).toLowerCase() === 'profiles' && path.basename(user).toLowerCase() === 'user' ? user : dir
}

function userDirOf(globalStorage) {
  if (typeof globalStorage !== 'string' || !globalStorage) return null
  const d = path.dirname(path.dirname(globalStorage))
  return path.basename(path.dirname(globalStorage)).toLowerCase() === 'globalstorage' ? userRootOf(d) : null
}

function real(p) {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

const same = (a, b) => {
  const x = real(a)
  const y = real(b)
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function record(root, user, ext) {
  try {
    if (!user || !ext || !path.isAbsolute(user) || !path.isAbsolute(ext)) return false
    user = userRootOf(user)
    ext = real(ext)
    const list = read(root)
    const had = list.find((e) => same(e.user, user))
    if (had && same(had.ext, ext)) return false
    const next = list.filter((e) => !same(e.user, user)).concat([{ user, ext }])
    fsx.writeFileAtomic(filePath(root), JSON.stringify(next, null, 2) + '\n')
    return true
  } catch { return false }
}

function forget(root, ext) {
  try {
    const list = read(root)
    const next = list.filter((e) => !same(e.ext, ext))
    if (next.length === list.length) return false
    fsx.writeFileAtomic(filePath(root), JSON.stringify(next, null, 2) + '\n')
    return true
  } catch { return false }
}

function othersInstalled(root, ext) {
  const there = (p) => {
    try { return fs.statSync(p).isDirectory() } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) }
  }
  return read(root).filter((e) => !same(e.ext, ext) && there(e.ext))
}

module.exports = { FILE, filePath, read, userDirOf, userRootOf, record, forget, othersInstalled, same }
