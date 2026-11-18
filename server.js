// 极简静态服务器：/ → public/，/src/* → src/*（领域模块与浏览器共用）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const PORT = process.env.PORT || 8080

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let path
    if (url === '/') path = join(root, 'public/index.html')
    else if (url.startsWith('/src/')) path = join(root, url)
    else path = join(root, 'public', url)
    const norm = normalize(path)
    if (!norm.startsWith(root)) throw new Error('forbidden')
    const body = await readFile(norm)
    res.writeHead(200, { 'content-type': MIME[extname(norm)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}).listen(PORT, () => console.log(`供水分区水平衡分析: http://localhost:${PORT}`))
