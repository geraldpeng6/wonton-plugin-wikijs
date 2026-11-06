# 云吞插件：Wiki.js

开发流程见[插件开发指南](https://github.com/geraldpeng6/wonton-docs/blob/main/develop.md)。

Wiki.js（[js.wiki](https://js.wiki)，AGPL-3.0）是自托管的知识库：页面、层级目录、Markdown 和所见即所得编辑器，按组分配
读写权限。这个插件把它装进云吞：网页经核心网关打开，登录走核心的身份提供方，打开就是主人自己的知识库；数据用镜像自带的
SQLite，一个文件。

插件用上游官方镜像 `ghcr.io/requarks/wiki` 的 2.x 稳定版，按清单列表（index）的摘要固定；界面语言默认中文。

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

Wiki.js 2.x 没有环境变量或命令行的初始化开关，初始化只能走它自己的安装向导。`init` 一次性服务在第一次安装时用它的接口
走完向导（站点地址、本地管理员、关闭遥测），再把登录换成核心的 OIDC、默认语言设成中文；已经配置过时向导接口返回 404，
脚本只核对身份和站点设置，所以重建容器也会跑。

- 向导建的本地管理员 `admin@wonton.local` 是底座，密码由核心生成、只给初始化脚本用，界面上不显示登录表单，登录走 OIDC；
  Wiki.js 不允许删掉第一个账号，它就留在用户列表里。
- 访客组没有权限，打开插件网页会转到登录，接着自动走核心的 OIDC；要给不登录的人看，在管理里给访客组加读权限。
- 主人首次登录时应用按邮箱自动建账号并进 Administrators 组。Wiki.js 的账号必须有邮箱，而核心只在主人配了邮箱时才发
  email 声明，所以清单引用了 `${WONTON_OWNER_EMAIL:?}`：没配的主人装不上，报错会说明。
- 内置搜索按标题、描述和路径匹配，不搜正文；用 SQLite 时这是唯一不用多一个服务的搜索。
- 中文界面语言包不在镜像里，首次打开时从上游的 Graph 节点下载，需要 `network.egress`；断网时界面停在英文。

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
