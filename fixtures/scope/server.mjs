// Scope fixture: a deliberately boring local server for security-scope tests. It has no
// vulnerabilities and no content worth testing — only routes that exercise scope decisions:
//   /                       200
//   /allowed                200
//   /admin/panel            200 (used by path-exclusion tests)
//   /headers                200 with cookie and key headers (redaction tests)
//   /redirect/in-scope      302 → /allowed
//   /redirect/chain         302 → /redirect/in-scope
//   /redirect/other-host    302 → http://localhost:<port>/allowed   (same machine, different host name)
//   /redirect/other-port    302 → http://127.0.0.1:<?port>/allowed  (alternate port)
//   /redirect/subdomain     302 → http://sub.localhost:<port>/allowed
//   /redirect/external      302 → https://third-party.invalid/      (.invalid never resolves)
//   /redirect/downgrade     302 → http://127.0.0.1:<port>/allowed   (absolute, same origin)
//   /redirect/loop          302 → /redirect/loop
// Every request is counted, so tests can prove that denied destinations were never contacted.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export function startScopeFixture({ port = 0, label = 'primary' } = {}) {
  const hits = new Map()
  return new Promise((resolve, reject) => {
    let actualPort = port
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
      const redirect = (location) => {
        res.writeHead(302, { location, 'content-type': 'text/plain' })
        res.end(`Redirecting to ${location}`)
      }
      switch (url.pathname) {
        case '/redirect/in-scope':
          return redirect('/allowed')
        case '/redirect/chain':
          return redirect('/redirect/in-scope')
        case '/redirect/other-host':
          return redirect(`http://localhost:${actualPort}/allowed`)
        case '/redirect/other-port':
          return redirect(`http://127.0.0.1:${url.searchParams.get('port') ?? '9'}/allowed`)
        case '/redirect/subdomain':
          return redirect(`http://sub.localhost:${actualPort}/allowed`)
        case '/redirect/external':
          return redirect('https://third-party.invalid/')
        case '/redirect/downgrade':
          return redirect(`http://127.0.0.1:${actualPort}/allowed`)
        case '/redirect/loop':
          return redirect('/redirect/loop')
        case '/headers':
          res.writeHead(200, {
            'content-type': 'text/plain',
            'set-cookie': ['session=fixture-session-secret-value; HttpOnly', 'theme=dark'],
            'x-api-key': 'fixture-api-key-secret',
          })
          return res.end('headers')
        case '/':
        case '/allowed':
        case '/admin/panel':
          res.writeHead(200, { 'content-type': 'text/plain' })
          return res.end(`scope fixture (${label}) ${url.pathname}`)
        default:
          res.writeHead(404, { 'content-type': 'text/plain' })
          return res.end('not found')
      }
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        hits,
        total: () => [...hits.values()].reduce((a, b) => a + b, 0),
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.SCOPE_FIXTURE_PORT ?? 4341)
  const { url } = await startScopeFixture({ port })
  console.log(`Scope fixture listening on ${url}`)
}
