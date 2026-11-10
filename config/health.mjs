// 健康检查：应用的就绪端点答得出来、数据库连得上，才算可用。
// 只探进程活着不够：数据库挂了应用照样监听端口；只探数据库也不够：应用启动没完成时库已经在那里。
import { createRequire } from 'node:module'

const require = createRequire('/wiki/backend/package.json')
const { Client } = require('pg')

const die = (message) => {
  console.error(message)
  process.exit(1)
}

let answer
try {
  answer = await fetch('http://127.0.0.1:3000/_ready', { signal: AbortSignal.timeout(8000) })
} catch (err) {
  die(`请求就绪端点失败：${err.message}`)
}
if (!answer.ok) die(`就绪端点答 ${answer.status}`)

const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
})
try {
  await client.connect()
  await client.query('SELECT 1')
} catch (err) {
  die(`数据库连不上：${err.message}`)
} finally {
  await client.end().catch(() => {})
}
