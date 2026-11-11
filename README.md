# 云吞插件：Wiki.js

开发流程见[插件开发指南](https://github.com/wontonapp/wonton-docs/blob/main/develop.md)。

Wiki.js（[js.wiki](https://js.wiki)，AGPL-3.0）是自托管的知识库：页面、层级目录、Markdown 和所见即所得编辑器，按组分配
读写权限。这个插件把它装进云吞：网页经核心网关打开，登录走核心的身份提供方，打开就是主人自己的知识库；数据存在同一个包里的
PostgreSQL 里。

插件用上游官方镜像 `ghcr.io/requarks/wiki` 的 3.x 稳定版，按清单列表（index）的摘要固定；界面语言默认中文。

## 图标来源与许可

`icon.png` 取自 Wiki.js 2.5.317 的官方 PNG（`client/static/favicons/android-chrome-256x256.png`），未用图片模型生成；来源、
版权、处理方式、上游 AGPL-3.0 全文和商标说明见 [NOTICE](NOTICE)。

该标志为 Wiki.js 项目及其权利人的商标，仅用于识别本插件所集成的应用；本插件不代表 Wiki.js 官方，
也不表示获得 Wiki.js 的合作、认可或背书。

## 先跑起来

```bash
scripts/dev.sh up
scripts/dev.sh install
```

`up` 在本机起一套云吞并打印它的地址，用 `scripts/dev.sh token` 输出的用户令牌登录；`install` 列出插件要的权限，确认后
装上并打印插件网页的地址。

装上以后打开插件网页，经核心的身份提供方登录，直接进知识库。

## 登录与初始化

Wiki.js 3.x 第一次启动时按 `ADMIN_EMAIL`/`ADMIN_PASS` 建根管理员，没有安装向导。`init` 一次性服务随每次创建容器重跑：
用这个本地管理员登录，把登录换成核心的 OIDC、站点地址信任核心的反代、默认语言设成中文；已经设过的写同样的值。

- 根管理员 `admin@wonton.local` 是底座，密码由核心生成、只给初始化脚本用，界面上不显示登录表单，登录走 OIDC。
- 登录回调地址里带策略的 UUID，而清单里的回调是静态的，所以 `init` 把 OIDC 策略的 id 固定成清单里写的那个值。
- 访客组默认没有读权限，打开插件网页会转到登录，接着自动走核心的 OIDC；要给不登录的人看，在管理里给访客组加读权限。
- 主人首次登录时应用按邮箱自动建账号并进 Administrators 组。Wiki.js 的账号必须有邮箱，而核心只在主人配了邮箱时才发
  email 声明，所以清单引用了 `${WONTON_OWNER_EMAIL:?}`：没配的主人装不上，报错会说明。
- 搜索是 PostgreSQL 的全文检索，标题、描述和正文都搜。
- 中文界面语言包不在镜像里，首次打开时从上游的仓库下载，需要 `network.egress`；断网时界面停在英文。

## 从 2.x 升级

3.x 换了数据库和表结构，读不了 2.x 的 SQLite，也不能原地升级。装上新版本后 `init` 会把 2.x 的数据搬进 PostgreSQL：
读数据目录里的 `wiki.sqlite`，经 3.x 的导入接口写一遍（用户、组、目录、页面和版本），搬完写 `/data/.wonton-imported-2x`
标记，之后的重建不再搬。附件、评论、导航和设置这次不搬。

2.x 的库里有附件或评论时，`init` 先数一遍再停：不升级、不改 2.x 的数据，报错写明发现多少个附件、多少条评论。
没有这些数据的升级直接过。

- 停下的条件是附件（2.x 上传的文件和图片）和评论，有任何一个就停，数量在报错里。
- 确认不要它们：在插件页把“升级时丢弃附件和评论”填 `1` 再装一次（也可以给插件传变量
  `WIKIJS_UPGRADE_DROP_ATTACHMENTS_COMMENTS=1`，或在数据目录里建 `.wonton-drop-attachments-comments` 文件）。
  写上以后开关一直有效，附件和评论就不搬，其余照常。
- 要它们：先在 2.x 的管理区 → Utilities → “Export for Wiki.js 3.x” 导出一个 `.wkbackup`，确认包下载到手上，
  再按上一条继续；升到 3.x 以后在 3.x 的管理区 → Utilities 里导入这个包。
- 迁移失败时安装停下并写明原因，数据都还在 `wiki.sqlite` 里；修好再重装一次会重跑（导入幂等，按邮箱、路径和派生 id 去重）。
  自动搬迁失败时，也可以在 3.x 的管理区 → Utilities 里手动导入事先导出的包。
- 页面文字会立刻在，HTML 由 3.x 重新渲染：渲染排队，一条一条来，页面多时会慢一会儿。
- 确认数据都在以后，可以删掉数据目录里的 `wiki.sqlite`。
- 2.x 的用户按邮箱对到 OIDC 登录上；2.x 的本地密码哈希原样带过来，本地登录仍可用。模块设置、安全设置和站点地址不导入，
  由 `init` 按云吞的约定重设，界面语言也保持原来的主语言（新装才默认中文）。

## 仓库里有什么

| 路径 | 内容 |
| --- | --- |
| `docker-compose.yml` | 插件本身：compose 加上 `x-wonton` 清单 |
| `icon.png`、`config/` | 清单和 compose 引用的文件：图标、交给应用的配置和一次性初始化脚本 |
| `screenshots/` | 商店详情页里的截图 |
| `scripts/check.sh` | 检查插件包，规则和安装时一样 |
| `scripts/dev.sh` | 开发环境：起一套云吞，装、重装、卸载插件，看日志 |
| `scripts/smoke-probes.sh` | `scripts/dev.sh smoke` 对这个插件逐项的探测 |
| `scripts/publish.sh` | 发布一个版本：打 tag、推送 |
| `AGENTS.md` | 给人和 AI 编程代理的规则 |
| `LICENSE`、`NOTICE` | 插件许可证、上游 AGPL-3.0 许可证和商标声明 |
