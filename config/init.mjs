// 首次安装时替主人走完 Wiki.js 的安装向导：上游 2.x 没有环境变量或命令行的初始化开关，向导是唯一的入口。
// 向导建好的本地管理员只当底座，登录换成核心的身份提供方，打开网页即是主人；它的密码抄进数据目录给 init 用。
// 已经配置过时向导接口返回 404，脚本接着核对身份和站点设置，所以每次创建容器都跑一遍也安全。
//
// 失败就退出非 0：安装回滚，错误里写清是哪一步。

import { readFile, writeFile } from 'node:fs/promises'

const BASE = 'http://wiki:3000'
// 本地管理员的地址：不能和主人的邮箱相同，OIDC 首次登录要按邮箱建新账号。
const ADMIN_EMAIL = 'admin@wonton.local'
// 管理员的密码落在数据目录里：核心的密钥可能换掉，用同一个值登录才不会被上一次安装挡住。
const PASSWORD_FILE = '/data/admin-password'
const TITLE = '知识库'

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

async function request(method, path, body, jwt, opts = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (jwt) headers.authorization = `Bearer ${jwt}`
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
    ...opts,
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text)
  // 首页是 HTML，其余接口都是 JSON。
  return response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text
}

// 只重试传输失败和 5xx：4xx 是配置写错了，重试也没用。
async function retry(label, run, attempts = 90, delay = 2000) {
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

async function graphql(query, variables, jwt) {
  const data = await request('POST', '/graphql', { query, variables }, jwt)
  if (data.errors?.length) throw new HttpError(500, data.errors.map((e) => e.message).join('；'))
  return data.data
}

// 每个 mutation 都带 responseResult，成功与否看它。
function done(result) {
  const status = result?.responseResult
  if (!status?.succeeded) throw new Error(status?.message ?? '响应里没有 responseResult')
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

async function finalize(password) {
  const body = {
    siteUrl: env('WONTON_APP_URL').replace(/\/+$/, ''),
    adminEmail: ADMIN_EMAIL,
    adminPassword: password,
    telemetry: false,
  }
  const result = await retry('完成安装向导', async () => {
    try {
      return await request('POST', '/finalize', body)
    } catch (err) {
      // 已经配置过：向导只在自己的进程里挂着，正常启动后就是 404。
      if (err instanceof HttpError && err.status === 404) return { ok: true, configured: true }
      throw err
    }
  }, 30, 2000)
  if (!result.ok) throw new Error(`安装向导失败：${result.error ?? '没有说明'}`)
  if (!result.configured) await writeFile(PASSWORD_FILE, password + '\n', { mode: 0o600 })
  console.log(result.configured ? '已经有配置，跳过安装向导' : '安装向导完成')
  return !result.configured
}

// 向导结束后 Wiki.js 会在同一个进程里重启成正常服务，起来之前请求会失败或拿不到令牌，都要重试。
async function login(password) {
  return retry('登录本地管理员', async () => {
    const data = await graphql(
      'mutation($username:String!,$password:String!){ authentication { login(username:$username, password:$password, strategy:"local"){ jwt responseResult{ message } } } }',
      { username: ADMIN_EMAIL, password },
    )
    const result = data?.authentication?.login
    if (!result?.jwt) throw new HttpError(500, `登录响应里没有令牌（${result?.responseResult?.message ?? '没有说明'}）`)
    return result.jwt
  // 登录接口限每分钟 5 次，重试比它慢不然一直撞。
  }, 15, 15000)
}

const enabled = (strategy, patch) => ({ ...strategy, ...patch })

// 用 OIDC 认人，本地留着启用但界面上藏起来（root 管理员在它上面，删不掉，登录接口也还要用）。别的登录方式原样保留。
async function useOidc(jwt) {
  const { activeStrategies } = (await graphql(
    '{ authentication { activeStrategies { key strategy { key } displayName order isEnabled selfRegistration domainWhitelist autoEnrollGroups config { key value } } } }',
    {},
    jwt,
  )).authentication
  const value = (text) => JSON.stringify({ v: text })
  const oidcConfig = [
    ['clientId', env('WONTON_OIDC_CLIENT_ID')],
    ['clientSecret', env('WONTON_OIDC_CLIENT_SECRET')],
    ['authorizationURL', env('WONTON_OIDC_AUTH_URL')],
    ['tokenURL', env('WONTON_OIDC_TOKEN_URL')],
    ['userInfoURL', env('WONTON_OIDC_USERINFO_URL')],
    ['issuer', env('WONTON_OIDC_ISSUER')],
    // 核心只在主人配了邮箱时发 email 声明，邮箱是 Wiki.js 的账号必填项。
    ['emailClaim', 'email'],
    ['displayNameClaim', 'name'],
  ].map(([key, text]) => ({ key, value: value(text) }))

  // activeStrategies 把配置包成 prop 对象放在 value 里，updateStrategies 只读它的 v。
  const resend = ({ strategy, ...rest }) => ({
    ...rest,
    strategyKey: strategy.key,
    config: rest.config.map((entry) => ({ key: entry.key, value: JSON.stringify({ v: JSON.parse(entry.value).value }) })),
  })
  const strategies = activeStrategies.map(resend).map((strategy) => {
    if (strategy.key === 'oidc') {
      // 主人首次登录时自动建账号，直接进 Administrators 组。
      return enabled(strategy, { order: 0, isEnabled: true, selfRegistration: true, autoEnrollGroups: [1], config: oidcConfig })
    }
    // 留着启用：它的登录接口是 init 每次登录要用的；界面上被 hideLocal 藏起来，autoLogin 也只跳第一个策略。
    if (strategy.key === 'local') return enabled(strategy, { order: 1, isEnabled: true })
    return enabled(strategy, { order: strategy.order + 1 })
  })
  if (!strategies.some((strategy) => strategy.key === 'oidc')) {
    strategies.push({
      key: 'oidc',
      strategyKey: 'oidc',
      displayName: 'Wonton',
      order: 0,
      isEnabled: true,
      selfRegistration: true,
      domainWhitelist: [],
      autoEnrollGroups: [1],
      config: oidcConfig,
    })
  }
  done((await graphql(
    'mutation($strategies:[AuthenticationStrategyInput]!){ authentication { updateStrategies(strategies:$strategies){ responseResult{ succeeded message } } } }',
    { strategies },
    jwt,
  )).authentication.updateStrategies)
}

// 站点地址跟着插件网页地址走；打开网页直接进 OIDC，不显示登录页。
async function configureSite(jwt) {
  const args = {
    host: env('WONTON_APP_URL').replace(/\/+$/, ''),
    authAutoLogin: true,
    authHideLocal: true,
    securityTrustProxy: true,
  }
  const types = { host: 'String', title: 'String', authAutoLogin: 'Boolean', authHideLocal: 'Boolean', securityTrustProxy: 'Boolean' }
  // 标题只在还是上游默认值时写：向导中途失败过（配置已写、标题还是默认）也能补上，主人改过的不覆盖。
  const { title } = (await graphql('{ site { config { title } } }', {}, jwt)).site.config
  if (title === 'Wiki.js' || !title) args.title = TITLE
  const decl = Object.keys(args).map((name) => `$${name}:${types[name]}`).join(',')
  const fields = Object.keys(args).map((name) => `${name}:$${name}`).join(',')
  done((await graphql(
    `mutation(${decl}){ site { updateConfig(${fields}){ responseResult{ succeeded message } } } }`,
    args,
    jwt,
  )).site.updateConfig)
}

// 访客组不给权限：首页不再是匿名可见的空页面，打开插件网页会被跳到登录，再由 autoLogin 交给 OIDC。
async function closeToGuests(jwt) {
  done((await graphql(
    'mutation { groups { update(id:2, name:"Guests", redirectOnLogin:"", permissions:[], pageRules:[]){ responseResult{ succeeded message } } } }',
    {},
    jwt,
  )).groups.update)
}

// 默认中文：界面语言包不在镜像里，从上游的 Graph 节点下载。断网时下载不到就用英文，界面照样能用，不因此让安装失败。
async function useChinese(jwt) {
  const localeState = async () => (await graphql('{ localization { config { locale } locales { code isInstalled } } }', {}, jwt)).localization
  let state = await localeState()
  if (!state.locales.some((locale) => locale.code === 'zh')) {
    console.log('上游没有中文语言包，界面留在英文')
    return
  }
  if (!state.locales.find((locale) => locale.code === 'zh').isInstalled) {
    done((await graphql(
      'mutation { localization { downloadLocale(locale:"zh"){ responseResult{ succeeded message } } } }',
      {},
      jwt,
    )).localization.downloadLocale)
    state = await localeState()
    // 下载任务自己吞掉网络错误，成功与否看语言包有没有装上。
    if (!state.locales.find((locale) => locale.code === 'zh')?.isInstalled) {
      console.log('中文语言包没下下来，界面留在英文')
      return
    }
  }
  // 安装向导写的是 en；主人自己在设置里选过的语言不覆盖。
  if (state.config.locale !== 'en') return
  done((await graphql(
    'mutation { localization { updateLocale(locale:"zh", autoUpdate:true, namespacing:false, namespaces:[]){ responseResult{ succeeded message } } } }',
    {},
    jwt,
  )).localization.updateLocale)
}

// 没配置时 GraphQL 还不存在（404），这时看安装向导的页面。配置好以后首页会转登录，而登录地址在容器里解析不了，
// 所以不能在配置好以后去探首页。
async function waitReady() {
  await retry('等 Wiki.js 响应', async () => {
    try {
      const data = await request('POST', '/graphql', { query: '{ __typename }' })
      if (!data?.data) throw new HttpError(500, 'GraphQL 还没就绪')
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) throw err
      const page = await request('GET', '/', undefined, undefined, { redirect: 'manual' })
      if (typeof page !== 'string' || !page) throw new HttpError(500, '安装向导的页面是空的')
    }
  }, 150, 2000)
}

async function main() {
  await waitReady()
  const password = await localPassword()
  const fresh = await finalize(password)
  const jwt = await login(password)
  await useOidc(jwt)
  await configureSite(jwt)
  if (fresh) await closeToGuests(jwt)
  try {
    await useChinese(jwt)
  } catch (err) {
    console.log(`中文界面没设上，界面留在英文：${err.message}`)
  }
  console.log('初始化完成')
}

main().catch((err) => {
  console.error(`init 失败：${err.message}`)
  process.exit(1)
})
