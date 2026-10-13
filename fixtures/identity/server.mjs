// Identity fixture: a local server that distinguishes authenticated from anonymous requests, for the
// Phase 5 Step 3 identity-aware execution tests. It never has a vulnerability — it only lets the tests
// prove that a session's material (cookie / bearer / header) was injected ONLY same-origin, that the
// right identity was authenticated, that anonymous still works, and that no secret leaks into Audivra.
//
//   GET /public     → 200 { ok: true }                     (always; proves anonymous works)
//   GET /me         → 200 { authenticated, who } | 401      (recognizes a registered session/token/header)
//   GET /echo       → 200 { headers }                       (what actually reached the server)
//   GET /login      → 200 an HTML login form (#username, #password, button[type=submit])
//   POST /login     → 302 /dashboard + Set-Cookie sid       (on a correct username/password)
//   GET /dashboard  → 200 (with [data-user-menu]) | 302 /login
//
// Credentials are registered by the test on the returned object: `sessions` (sid value → who),
// `tokens` (bearer value → who), `headerSecrets` ("name: value" → who) and `users` (username → {password, sid, who}).
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export function startIdentityFixture({ port = 0, label = 'identity' } = {}) {
  const hits = new Map()
  const requests = [] // { method, path, headers, authenticatedAs }
  const sessions = new Map() // sid value → who
  const tokens = new Map() // bearer token value → who
  const headerSecrets = new Map() // "name: value" (lower-cased name) → who
  const users = new Map() // username → { password, sid, who }

  const cookie = (header, name) => {
    for (const part of (header ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k === name) return v.join('=')
    }
    return null
  }
  const whoFor = (req) => {
    const sid = cookie(req.headers.cookie, 'sid')
    if (sid && sessions.has(sid)) return sessions.get(sid)
    const auth = req.headers.authorization
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && tokens.has(auth.slice(7))) return tokens.get(auth.slice(7))
    for (const [key, who] of headerSecrets) {
      const [name, value] = key.split(': ')
      if (req.headers[name] === value) return who
    }
    return null
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
      const who = whoFor(req)
      requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers }, authenticatedAs: who })
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      if (url.pathname === '/public') return json(200, { ok: true })
      if (url.pathname === '/echo') return json(200, { headers: req.headers })
      if (url.pathname === '/me') return who ? json(200, { authenticated: true, who }) : json(401, { authenticated: false })

      if (url.pathname === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end(
          `<!doctype html><html><body><form method="post" action="/login">` +
            `<input id="username" name="username"/><input id="password" name="password" type="password"/>` +
            `<button type="submit">Sign in</button></form></body></html>`,
        )
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          const form = new URLSearchParams(raw)
          const account = users.get(form.get('username') ?? '')
          if (account && account.password === form.get('password')) {
            sessions.set(account.sid, account.who)
            res.writeHead(302, { location: '/dashboard', 'set-cookie': `sid=${account.sid}; Path=/; HttpOnly` })
            return res.end('ok')
          }
          json(401, { error: 'bad credentials' })
        })
        return
      }
      if (url.pathname === '/dashboard') {
        if (who) {
          res.writeHead(200, { 'content-type': 'text/html' })
          return res.end(`<!doctype html><html><body><div data-user-menu>${who}</div></body></html>`)
        }
        res.writeHead(302, { location: '/login' })
        return res.end('login')
      }
      json(404, { error: 'not found' })
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port
      resolve({
        server,
        label,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        hits,
        requests,
        sessions,
        tokens,
        headerSecrets,
        users,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startIdentityFixture({ port: Number(process.env.IDENTITY_FIXTURE_PORT ?? 4342) })
  console.log(`Identity fixture listening on ${url}`)
}
