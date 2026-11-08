// 把 2.x 的数据目录搬进 3.x：2.x 的库是 SQLite，3.x 只认 PostgreSQL，不能原地升级，只能走 3.x 的导入接口
// （导入按包里的 NDJSON 流一条条喂，格式见上游 dev/specs/wkbackup.md）。这里按那份规格直接读 SQLite 生成记录，
// 不上传包：记录就是 2.x 的表行，重命名、路径改写、id 派生都由导入器自己做。
//
// 先搬人跟组（页面要作者），再搬目录、页面和版本；附件、评论、导航和设置这次不搬，由调用方报出来。
// 失败就让异常冒出去：数据都还在 wiki.sqlite 里，重跑一次导入是幂等的（页面按路径、用户按邮箱、版本按派生 id）。

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const DB_FILE = process.env.WIKI2_DB ?? '/data/wiki.sqlite'
// 一批多少条：规矩是 500 条、16 MiB 封顶，页面一条可能有几 MB，取小一点省得撞 413。
const BATCH_RECORDS = 200
const BATCH_BYTES = 4 * 1024 * 1024

const STREAMS = ['locales', 'groups', 'users', 'tree', 'pages', 'page-history']
const INSTANCE = new Set(['locales', 'groups', 'users'])
const INCLUDES = ['pages', 'history', 'users', 'groups']

// SQLite 的布尔列进来是 0/1，导入器按 `=== true` 判断，先转回真布尔。
const bool = (value) => value === true || value === 1 || value === '1' || value === 'true'

const json = (text, fallback) => {
  if (!text) return fallback
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params)
}

// 2.x 的行原样带过去，只把 JSON 列解成结构、把用户的分组摊平成 id 列表（导入器按那个找组）。
function* records(db, stream) {
  switch (stream) {
    case 'locales':
      yield* rows(db, 'SELECT * FROM locales')
      break
    case 'groups':
      for (const row of rows(db, 'SELECT * FROM groups')) {
        yield {
          ...row,
          isSystem: bool(row.isSystem),
          permissions: json(row.permissions, []),
          pageRules: json(row.pageRules, []),
        }
      }
      break
    case 'users':
      for (const row of rows(db, 'SELECT * FROM users')) {
        const groups = rows(db, 'SELECT groupId FROM userGroups WHERE userId = ?', row.id).map(
          (entry) => entry.groupId,
        )
        yield {
          ...row,
          providerKey: row.providerId,
          groups,
          isSystem: bool(row.isSystem),
          isActive: bool(row.isActive),
          isVerified: bool(row.isVerified),
          tfaIsActive: bool(row.tfaIsActive),
          mustChangePwd: bool(row.mustChangePwd),
        }
      }
      break
    case 'tree':
      for (const row of rows(db, 'SELECT * FROM pageTree WHERE isFolder = 1')) {
        yield { ...row, isFolder: true, isPrivate: bool(row.isPrivate) }
      }
      break
    case 'pages':
      for (const row of rows(db, 'SELECT * FROM pages')) {
        yield {
          ...row,
          isPublished: bool(row.isPublished),
          isPrivate: bool(row.isPrivate),
          tags: json(row.tags, []),
        }
      }
      break
    case 'page-history':
      for (const row of rows(db, 'SELECT * FROM pageHistory')) {
        yield { ...row, isPublished: bool(row.isPublished), tags: json(row.tags, []) }
      }
      break
  }
}

function count(db, table, where = '') {
  return db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get().n
}

async function send(request, path, body) {
  return request('POST', path, body)
}

// 分批发：记录攒到条数或字节上限就发一批。
async function push(request, path, list) {
  let batch = []
  let bytes = 0
  let total = 0
  const flush = async () => {
    if (batch.length < 1) return
    const result = await send(request, path, { records: batch })
    total += result?.imported ?? batch.length
    batch = []
    bytes = 0
  }
  for (const record of list) {
    const size = JSON.stringify(record).length
    if (batch.length >= BATCH_RECORDS || bytes + size > BATCH_BYTES) await flush()
    batch.push(record)
    bytes += size
  }
  await flush()
  return total
}

export function hasV2Data() {
  const db = new DatabaseSync(DB_FILE, { readOnly: true })
  try {
    return count(db, 'pages') > 0
  } finally {
    db.close()
  }
}

export async function migrateV2({ request, siteId, appUrl }) {
  const db = new DatabaseSync(DB_FILE, { readOnly: true })
  try {
    // 老库的 locales 没有 isActive/isPrimary 这些列，全取回来按有的字段排：主语言放最前。
    const localeCodes = rows(db, 'SELECT * FROM locales').sort(
      (a, b) => Number(b.isActive ?? 0) - Number(a.isActive ?? 0) || Number(b.isPrimary ?? 0) - Number(a.isPrimary ?? 0),
    )
    const site = rows(db, "SELECT * FROM settings WHERE key IN ('title', 'host')").reduce(
      (acc, row) => ({ ...acc, [row.key]: json(row.value, {})?.v ?? '' }),
      {},
    )
    const manifest = {
      format: 'wkbackup',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      generator: { product: 'wiki.js', version: '2.5', exporter: 'wonton-plugin' },
      // 实例 id 要稳定：重跑时派生出来的版本 id 才是同一批。
      source: {
        kind: 'wikijs2',
        instanceId: createHash('sha256').update(appUrl ?? DB_FILE).digest('hex').slice(0, 32),
        baseUrl: appUrl,
      },
      streams: Object.fromEntries(
        ['locales', 'groups', 'users'].map((name) => [
          name,
          { schema: 1, path: `streams/${name}.ndjson`, count: count(db, name) },
        ]),
      ),
      sites: [
        {
          id: 'default',
          title: site.title ?? '',
          hostname: site.host,
          locales: localeCodes.map((entry) => entry.code),
          streams: {
            tree: { schema: 1, path: 'sites/default/tree.ndjson', count: count(db, 'pageTree', 'WHERE isFolder = 1') },
            pages: { schema: 1, path: 'sites/default/pages.ndjson', count: count(db, 'pages') },
            'page-history': {
              schema: 1,
              path: 'sites/default/page-history.ndjson',
              count: count(db, 'pageHistory'),
            },
          },
        },
      ],
      options: { includes: INCLUDES },
      warnings: [],
    }

    const preflight = await send(request, '/api/import/preflight', { manifest, siteId })
    if (!preflight.ok) throw new Error(`导入预检失败：${preflight.errors.join('；')}`)

    const session = await send(request, '/api/import/sessions', {
      source: manifest.source.kind,
      sourceInstanceId: manifest.source.instanceId,
      sites: [{ sourceId: 'default', siteId }],
      includes: INCLUDES,
      htmlConversion: 'markdown',
    })

    const totals = {}
    // 顺序是导入器要求的：人跟组先到，页面才有作者；版本跟页面走。
    for (const stream of STREAMS) {
      const path = INSTANCE.has(stream)
        ? `/api/import/sessions/${session.id}/streams/${stream}`
        : `/api/import/sessions/${session.id}/sites/${siteId}/streams/${stream}`
      totals[stream] = await push(request, path, records(db, stream))
    }

    const summary = await send(request, `/api/import/sessions/${session.id}/finish`, {})
    return { totals, summary, title: site.title ?? '' }
  } finally {
    db.close()
  }
}
