// 健康检查：应用答得出启动接口（站点、身份配置都在里面）且数据库连得上，才算可用。
// 只探进程活着不够：数据库挂了应用照样监听端口；只探数据库也不够：应用自己起了没、站点还认不认得出都看不到。
import { createRequire } from 'node:module'

const require = createRequire('/wiki/backend/package.json')
const { Client } = require('pg')

const die = (message) => {
  console.error(message)
  process.exit(1)
}

let answer
try {
  answer = await fetch('http://127.0.0.1:3000/_api/', { signal: AbortSignal.timeout(8000) })
} catch (err) {
  die(`请求启动接口失败：${err.message}`)
}
if (!answer.ok) die(`启动接口答 ${answer.status}`)
const body = await answer.text()
if (!body.includes('"site"')) die(`启动接口没有站点信息：${body.slice(0, 200)}`)

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
