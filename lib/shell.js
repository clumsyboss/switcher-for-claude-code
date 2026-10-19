function terminalSpec(bin, args, platform) {
  const list = (args || []).map(String)
  const p = platform || process.platform
  if (p === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return { shellPath: 'cmd.exe', shellArgs: ['/d', '/c', bin, ...list] }
  }
  return { shellPath: bin, shellArgs: list }
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 &&
    /^[A-Za-z0-9._+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/.test(email)
}

function invoke(bin, args, platform) {
  const p = platform || process.platform
  if (p === 'win32') {
    const q = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "''") + "'"
    return '& ' + [bin, ...(args || [])].map(q).join(' ')
  }
  const q = (s) => "'" + String(s).split("'").join("'\\''") + "'"
  return [bin, ...(args || [])].map(q).join(' ')
}

module.exports = { terminalSpec, validEmail, invoke }
