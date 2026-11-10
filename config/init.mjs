// 一次性初始化：把 Wiki.js 的登录接到核心的身份提供方，站点地址、中文界面和反代信任也跟着设好。
// 上游 3.x 首次启动从 ADMIN_EMAIL/ADMIN_PASS 建根管理员，安装向导没有了，场景统一走它的 REST 接口。
// 每一步都是写最终值，已经设过的再写一遍也一样；每次创建容器（安装、升级、重建）都跑。
//
// 失败就退出非 0：安装回滚，错误里写清是哪一步。

import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { hasV2Data, migrateV2, v2Leftovers } from './migrate2.mjs'

const BASE = 'http://wiki:3000/_api'
// 本地管理员的地址：不能和主人的邮箱相同，OIDC 首次登录要按邮箱建新账号。
const ADMIN_EMAIL = 'admin@wonton.local'
// 管理员的密码落在数据目录里：核心的密钥可能换掉，用同一个值登录才不会被上一次安装挡住。
const PASSWORD_FILE = '/data/admin-password'
// 上游 2.x 的库文件由 migrate2.mjs 搬进 PostgreSQL，搬完写这个标记。
const IMPORTED = '/data/.wonton-imported-2x'
// 附件和评论自动迁移不搬：确认不要它们的人留这个文件（或给同名变量），之后的重建不再问。
const DROP_FILE = '/data/.wonton-drop-attachments-comments'
const DROP_VAR = 'WIKIJS_UPGRADE_DROP_ATTACHMENTS_COMMENTS'
// 3.x 的登录回调地址里带策略的 UUID（/_api/auth/<id>/callback），而清单里的 redirect_paths 是静态的，
// 所以策略的 id 固定成这个值（建好以后在库里改），核心登记的回调才和 Wiki.js 发出的对得上。
const STRATEGY_ID = '4d18c8a0-1f2b-4a5e-9d0e-6c1f5a7b9c31'
const TITLE = '知识库'
// 内置本地登录策略的固定 id（上游 base.yml 的 systemIds.localAuthId）。
const LOCAL_STRATEGY_ID = '5a528c4c-0a82-4ad2-96a5-2b23811e6588'
const LOCALE = 'zh-CN'

const require = createRequire('/wiki/backend/package.json')
const { Client } = require('pg')

const env = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`没有 ${name}`)
  return value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}${body ? `：${body.slice(0, 300)}` : ''}`)
    this.status = status
  }
}

const cookieJar = new Map()

async function request(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookieJar.size > 0) headers.cookie = [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ')
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0]
    const at = pair.indexOf('=')
    if (at > 0) cookieJar.set(pair.slice(0, at), pair.slice(at + 1))
  }
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text)
  return text ? JSON.parse(text) : {}
}

// 只重试传输失败和 5xx：4xx 是配置写错了，重试也没用。
async function retry(label, run, attempts = 150, delay = 2000) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run()
    } catch (err) {
      last = err
      if (err instanceof HttpError && err.status < 500) throw new Error(`${label}：${err.message}`)
      await sleep(delay)
    }
  }
  throw new Error(`${label}：${last?.message ?? last}`)
}

async function sql(query, params) {
  const client = new Client({
    host: env('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    user: env('DB_USER'),
    password: env('DB_PASS'),
    database: env('DB_NAME'),
  })
  try {
    await client.connect()
    return (await client.query(query, params)).rows
  } finally {
    await client.end().catch(() => {})
  }
}

async function localPassword() {
  try {
    const saved = (await readFile(PASSWORD_FILE, 'utf8')).trim()
    if (saved) return saved
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return env('WONTON_SECRET_ADMIN_PASSWORD')
}

// 等应用答得出站点：站点在库里，答得出来就说明库已经建好、管理员和本地登录策略都种下了。
// `/_api/` 的根路径被 Swagger UI 占着，站点要从它自己的接口取；`current` 按请求的主机名找，兜底是 `*`。
async function waitReady() {
  let last
  for (let attempt = 1; attempt <= 150; attempt++) {
    try {
      const site = await request('GET', '/sites/current')
      if (site?.id) return
      last = new Error('站点接口里没有 id')
    } catch (err) {
      // 应用刚起来时路由可能还没挂好，404 也算没就绪。
      last = err
    }
    await sleep(2000)
  }
  throw new Error(`等 Wiki.js 响应：${last?.message ?? last}`)
}

async function login(password) {
  return retry(
    '登录本地管理员',
    async () => {
      const result = await request('PUT', `/sites/${siteId}/auth/login`, {
        strategyId: LOCAL_STRATEGY_ID,
        username: ADMIN_EMAIL,
        password,
      })
      if (!result?.ok) throw new HttpError(500, '登录响应里没有 ok')
    },
    15,
    15_000,
  )
}

async function useOidc(adminGroupId) {
  const config = {
    clientId: env('WONTON_OIDC_CLIENT_ID'),
    clientSecret: env('WONTON_OIDC_CLIENT_SECRET'),
    issuer: env('WONTON_OIDC_ISSUER'),
    useDiscovery: true,
    // 开发环境没有 TLS，签发方是插件网络里的 http 地址。
    allowInsecureHttp: true,
    // 核心只在主人配了邮箱时才发 email 声明，邮箱是 Wiki.js 的账号必填项。
    scopes: 'openid profile email',
    emailClaim: 'email',
    displayNameClaim: 'name',
  }
  const fields = { displayName: 'Wonton', isEnabled: true, autoEnrollGroups: [adminGroupId], config }

  const rows = await sql("SELECT id FROM authentication WHERE module = 'oidc'")
  const fixed = rows.find((row) => row.id === STRATEGY_ID)
  let renamed = false
  if (!fixed) {
    if (rows.length > 0) {
      // 早先一次跑到一半（策略建了、id 没改成固定值）：改过来就行，配置随后重写。
      await sql('UPDATE authentication SET id = $1 WHERE id = $2', [STRATEGY_ID, rows[0].id])
      renamed = true
    } else {
      const created = await request('POST', '/authentication/strategies', { module: 'oidc', ...fields })
      await sql('UPDATE authentication SET id = $1 WHERE id = $2', [STRATEGY_ID, created.id])
      renamed = true
    }
  }
  if (renamed) {
    // 进程里记的还是旧 id：建一条临时策略再删掉，两次都会重读策略表。
    const dummy = await request('POST', '/authentication/strategies', {
      module: 'local',
      displayName: 'reload',
    })
    await request('DELETE', `/authentication/strategies/${dummy.id}`)
  }
  // 再写一遍：密钥换了（保留数据重装）也能更新，顺带把这次的展示名等字段写最终值。
  await request('PUT', `/authentication/strategies/${STRATEGY_ID}`, fields)
}

// 站点：打开网页直接走身份提供方，本地登录只留给 init 和管理员兜底；标题只在还是上游默认值时改。
async function configureSite(site, siteId, imported) {
  const fields = {
    authStrategies: [
      { id: STRATEGY_ID, order: 0, isVisible: true },
      { id: LOCAL_STRATEGY_ID, order: 1, isVisible: false },
    ],
    auth: { ...site.auth, autoLogin: true, hideLocal: true },
  }
  // 导入时站点名已经换成 2.x 的名字，这里不覆盖。
  if (!imported && (site.title === 'Default Site' || !site.title)) fields.title = TITLE
  await request('PUT', `/sites/${siteId}`, fields)
}

// 默认中文：语言包不在镜像里，从上游的仓库下载。断网时留在英文，界面照样能用，不因此让安装失败。
async function useChinese(site, siteId) {
  const locales = await request('GET', '/locales')
  let zh = locales.find((locale) => locale.code === LOCALE)
  if (!zh || !zh.isInstalled) {
    await request('POST', '/locales/fetch')
    locales.splice(0, locales.length, ...(await request('GET', '/locales')))
    zh = locales.find((locale) => locale.code === LOCALE)
    if (!zh) {
      console.log('上游没有中文语言包，界面留在英文')
      return
    }
    if (!zh.isInstalled) {
      await request('POST', `/locales/${LOCALE}/install`)
      locales.splice(0, locales.length, ...(await request('GET', '/locales')))
      if (!locales.find((locale) => locale.code === LOCALE)?.isInstalled) {
        console.log('中文语言包没下下来，界面留在英文')
        return
      }
    }
  }
  const active = [...new Set([...(site.locales?.active ?? ['en']), LOCALE])]
  await request('PUT', `/sites/${siteId}`, { locales: { ...site.locales, primary: LOCALE, active } })
}

// 附件和评论自动迁移不搬：默认停下让人确认，确认过就写标记文件（变量给的也算）。报错里的数量是这次数据库里的。
async function dropAttachmentsComments() {
  const asked = process.env[DROP_VAR] === '1'
  const saved = await readFile(DROP_FILE, 'utf8').then(() => true, () => false)
  if (asked && !saved) await writeFile(DROP_FILE, `${DROP_VAR}=1\n`)
  return asked || saved
}

// 升级：数据目录里有 2.x 的库、这边的库还是空的，就把 2.x 搬过来。搬过一次就不再来（标记文件）。
async function importFromV2(siteId) {
  if (await readFile(IMPORTED, 'utf8').catch(() => '')) return false
  if (!hasV2Data()) return false
  const [{ count }] = await sql('SELECT count(*)::int AS count FROM pages')
  if (count > 0) {
    console.log('库里已经有页面，跳过 2.x 导入')
    return false
  }
  const { attachments, comments } = v2Leftovers()
  const drop = await dropAttachmentsComments()
  if ((attachments > 0 || comments > 0) && !drop) {
    throw new Error(
      `2.x 的库里有 ${attachments} 个附件、${comments} 条评论，自动迁移不搬这两样，先停在升级前（2.x 的库没动）。` +
        '要它们就先在 2.x 的管理区 → Utilities → “Export for Wiki.js 3.x” 导出一个 .wkbackup，' +
        `确认不要（或者包已经在手上）再设 ${DROP_VAR}=1（或建文件 ${DROP_FILE}）装一次。`,
    )
  }
  if (attachments > 0 || comments > 0) {
    console.log(`按开关不搬 2.x 的 ${attachments} 个附件、${comments} 条评论，继续导入`)
  }
  console.log('数据目录里有 2.x 的库，开始导入')
  const { totals, summary, title } = await migrateV2({ request, siteId, appUrl: env('WONTON_APP_URL') })
  console.log(`导入完成：${JSON.stringify(totals)}`)
  // 站点名跟着 2.x 的来，别让一次升级把主人起的名字改掉。
  if (title) await request('PUT', `/sites/${siteId}`, { title })
  for (const warning of summary?.warnings ?? []) console.log(`导入提醒：${warning}`)
  await writeFile(IMPORTED, JSON.stringify({ totals, at: new Date().toISOString() }) + '\n')
  return true
}

// 没配置过的策略对站点还不可见，登录也走不通；本地管理员是唯一的入口，它必须在站点上。
async function main() {
  await waitReady()
  const site = await request('GET', '/sites/current')
  siteId = site.id

  const password = await localPassword()
  await login(password)
  await request('PUT', '/system/security', { trustProxy: true })

  const [administrators] = await sql("SELECT id FROM groups WHERE name = 'Administrators'")
  if (!administrators) throw new Error('库里没有 Administrators 组')
  await useOidc(administrators.id)
  // 从 2.x 升上来看的是原来的页面，界面语言得跟着原来的主语言走；新装才设中文。
  const imported = await importFromV2(siteId)
  await configureSite(site, siteId, imported)
  // 自检：登录入口必须答 302 跳去身份提供方；不答说明策略没生效，装上也登不进。
  const entry = await fetch(`${BASE}/auth/${STRATEGY_ID}/authorize?siteId=${siteId}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  if (entry.status !== 302) {
    throw new Error(`OIDC 登录入口没就绪：HTTP ${entry.status} ${(await entry.text()).slice(0, 300)}`)
  }
  if (!imported) {
    try {
      await useChinese(site, siteId)
    } catch (err) {
      console.log(`中文界面没设上，界面留在英文：${err.message}`)
    }
  }
  if (!(await readFile(PASSWORD_FILE, 'utf8').catch(() => ''))) {
    await writeFile(PASSWORD_FILE, password + '\n', { mode: 0o600 })
  }
  console.log('初始化完成')
}

let siteId = ''

main().catch((err) => {
  console.error(`init 失败：${err.message}`)
  process.exit(1)
})
