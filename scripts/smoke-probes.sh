# shellcheck shell=bash
# Wiki.js：sso=oidc（网关身份提供方）；清单没有 mcp。

# 走完 OIDC 后落了应用真实页面，站点标题在其中。
# 页面判完接着跑“带附件升级会停下”的整段场景（见 upgrade_guard），它自己做自己的成败记录。
web_assert() {
  local ok=0
  grep -q '知识库' || ok=1
  upgrade_guard
  return "$ok"
}

# 往 2.x 传一个附件：在容器里用 node 直连 3000，先拿本地管理员的 JWT 再 POST /u。
# 不走网关的原因：/u 只认 Authorization 头（2.x 的 extractJWT 对 /u 直接忽略 cookie），配置好的会话用不上；
# 本地管理员是根账号（Administrators 只有 manage:system，靠它的快捷放行过 write:assets）。
upload_attachment() { # <wiki 容器名>；输出 “UPLOAD <状态> <正文>” 或 “LOGIN_FAIL …”
  docker exec -i "$1" node -e '
const fs = require("node:fs")
const run = async () => {
  const pw = fs.readFileSync("/data/admin-password", "utf8").trim()
  const login = await fetch("http://localhost:3000/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `mutation($u:String!,$p:String!){authentication{login(username:$u,password:$p,strategy:"local"){jwt responseResult{message}}}}`,
      variables: { u: "admin@wonton.local", p: pw },
    }),
  })
  const data = await login.json()
  const jwt = data?.data?.authentication?.login?.jwt
  if (!jwt) {
    console.log(`LOGIN_FAIL ${login.status} ${JSON.stringify(data).slice(0, 300)}`)
    return
  }
  const form = new FormData()
  form.append("mediaUpload", JSON.stringify({ folderId: 0 }))
  form.append("mediaUpload", new Blob(["wonton smoke attachment\n"]), "wonton-smoke.txt")
  const res = await fetch("http://localhost:3000/u", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: form,
  })
  console.log(`UPLOAD ${res.status} ${await res.text()}`)
}
run().catch((err) => console.log(`ERROR ${err.message}`))
'
}

upgrade_guard() {
  local item=带附件升级停下 why="" out rc dir app wiki core_image count prev_url prev_origin
  [[ -d "$SMOKE_STATE" ]] && return 0
  [[ -n "${upgrade_from:-}" ]] || { na "$item" "本仓库没有 tag，测不了升级"; return 0; }
  [[ ! -e "$SMOKE_STATE.guard-done" ]] || return 0
  prev_url="${SMOKE_WEB_URL:-}"
  prev_origin="${SMOKE_WEB_ORIGIN:-}"
  app="$SMOKE_DATA_DIR/apps/${SMOKE_PLUGIN_ID//./-}"
  dir="$app/data"
  wiki="wonton-$SMOKE_INSTANCE--${SMOKE_PLUGIN_ID//./-}--wiki"
  say "$item：从 tag $upgrade_from 重新装一遍"
  # 只 uninstall 不 --purge：purge 会把密钥一起删掉，而失败的那次升级回滚会把密钥恢复成旧值，
  # 重试时又是新值，库就认不上了（password authentication failed for user "wiki"）。
  if ! probes_dev uninstall >>"$PROBES_LOG" 2>&1; then
    fail "$item" "卸掉当前装法失败，看 $PROBES_LOG 末尾：$(tail -c 200 "$PROBES_LOG" | tr '\n' ' ')"
    return 0
  fi
  # 数据目录是核心以 root 建的，宿主机删不动，借一个本地镜像里的 rm 删。
  core_image="$(sed -n 's/^WONTON_CORE_IMAGE=//p' "$SMOKE_DEV_STATE/.env" 2>/dev/null | tail -1)"
  [[ -n "$core_image" ]] || { fail "$item" "读不到核心镜像名（$SMOKE_DEV_STATE/.env）"; return 0; }
  docker run --rm --user 0 --entrypoint rm -v "$SMOKE_DATA_DIR:/host-data" "$core_image" \
    -rf "/host-data/apps/${SMOKE_PLUGIN_ID//./-}" >>"$PROBES_LOG" 2>&1 ||
    { fail "$item" "删不掉插件数据目录 $app"; return 0; }
  if probes_dev_t 600 install --yes "$upgrade_from" >>"$PROBES_LOG" 2>&1 &&
    probes_status_wait "$PROBES_PLUGIN_ID" 40 >/dev/null; then
    if ! probes_dev session >>"$PROBES_LOG" 2>&1 || ! probes_web_url "$item"; then
      why="在 2.x 上建不了会话或拿不到网页地址"
    elif ! data_write; then
      why="在 2.x 上写页面失败"
    else
      out="$(upload_attachment "$wiki")" || true
      case "$out" in
        'UPLOAD 200 ok') ;;
        UPLOAD\ *) why="2.x 上传附件被拒：$(head -c 200 <<<"$out")" ;;
        *) why="2.x 上传附件出错：$(head -c 200 <<<"$out")" ;;
      esac
    fi
  else
    why="装 tag $upgrade_from 失败"
  fi
  if [[ -z "$why" ]]; then
    # 核心等一次性服务跑完才算装好：init 停下时这里必须失败，报错里带 init 的日志末尾。
    if out="$(probes_dev_t 600 reinstall --yes 2>&1)"; then rc=0; else rc=$?; fi
    printf '%s\n' "$out" >>"$PROBES_LOG"
    if ((rc == 0)); then
      why="升级没有停下（reinstall 退出 0）"
    elif ! grep -q '个附件' <<<"$out"; then
      why="停下了，但报错里没有附件数量：$(tail -c 300 <<<"$out" | tr '\n' ' ')"
    elif ! grep -q WIKIJS_UPGRADE_DROP_ATTACHMENTS_COMMENTS <<<"$out"; then
      why="停下了，但报错没写怎么继续：$(tail -c 300 <<<"$out" | tr '\n' ' ')"
    fi
  fi
  mkdir -p "$dir"
  : >"$dir/.wonton-drop-attachments-comments"
  if ! probes_dev_t 900 reinstall --yes >>"$PROBES_LOG" 2>&1 ||
    ! probes_status_wait "$PROBES_PLUGIN_ID" 40 >/dev/null; then
    why="${why:+$why；}给了开关还是装不上"
  fi
  probes_dev session >>"$PROBES_LOG" 2>&1
  # 装不回来时插件列表里没有网页地址，别把先前的值冲成空：后面的探针照着报错更好懂。
  probes_web_url "$item"
  if [[ -n "$prev_url" && -z "$SMOKE_WEB_URL" ]]; then
    SMOKE_WEB_URL="$prev_url"
    SMOKE_WEB_ORIGIN="$prev_origin"
    export SMOKE_WEB_URL SMOKE_WEB_ORIGIN
  fi
  : >"$SMOKE_STATE.guard-done"
  if [[ -n "$why" ]]; then
    fail "$item" "$why，看 $PROBES_LOG 末尾：$(tail -c 300 "$PROBES_LOG" | tr '\n' ' ')"
    return 0
  fi
  count="$(grep -o '有 [0-9]* 个附件、[0-9]* 条评论' <<<"$out" | head -1)"
  pass "$item" "有附件时升级停下，报错写明数量（$count）；给开关后能升上去"
}

# 插件的网页地址可能带结尾斜杠，拼接口路径前先去掉，免得走出 `//_api` 落到应用外壳上。
site_origin() { printf '%s' "${SMOKE_WEB_URL%/}"; }

# 3.x 的自动登录在浏览器里由 JS 发起，curl 拿不到，直接走它的 authorize 路由跟完整个跳转链；
# 升级起点还是 2.x 时走 2.x 的 `/login/<策略>`。已有会话时再走一遍也安全。
oidc_login() {
  local target site resp status url
  if site="$(site_id)"; then
    target="$(site_origin)/_api/auth/4d18c8a0-1f2b-4a5e-9d0e-6c1f5a7b9c31/authorize?siteId=$site&redirect=%2F"
  else
    target="$(site_origin)/login/oidc"
  fi
  resp="$(mktemp)"
  status="$(curl -sS -L --noproxy '*' --max-time 90 -b "$SMOKE_JAR" -c "$SMOKE_JAR" -o "$resp" \
    -w '%{http_code} %{url_effective}' "$target")" ||
    { echo "OIDC 登录请求失败：$target"; rm -f "$resp"; return 1; }
  url="${status#* }"
  status="${status%% *}"
  if [[ "$status" != 2* && "$status" != 3* ]] || [[ "$url" != "$(site_origin)"* ]]; then
    echo "OIDC 登录没回到插件（HTTP $status，落在 $url）：$(head -c 300 "$resp")"
    rm -f "$resp"
    return 1
  fi
  rm -f "$resp"
}

# 应用自己的“当前用户”接口：认出的必须是主人本人、且是管理员。
identity_check() {
  local out
  oidc_login || return 1
  out="$(curl -sS --noproxy '*' --fail-with-body -b "$SMOKE_JAR" "$(site_origin)/_api/users/whoami")" || { echo "查询当前用户失败：$out"; return 1; }
  jq -e --arg e "$SMOKE_OWNER_EMAIL" '.authenticated == true and .email == $e' <<<"$out" >/dev/null ||
    { echo "当前用户不是主人的 OIDC 账号：$out"; return 1; }
  # 根管理员拿的是 manage:system
  jq -e '.permissions | index("manage:system") != null' <<<"$out" >/dev/null ||
    { echo "当前用户不是管理员：$out"; return 1; }
}

# 数据：建一个路径带随机标记的页面，升级/重装后读回。3.x 用 REST；升级起点还是 2.x 时走它的 GraphQL。
site_id() {
  curl -sS --noproxy '*' --fail-with-body -b "$SMOKE_JAR" "$(site_origin)/_api/sites/current" | jq -er '.id'
}

data_write() { # 用随机标记写一页，标记存进状态目录
  local marker site body
  # 3.x 的路径只留小写字母数字和连字符，标记也用小写，路径才对得上。
  marker="$(head -c 12 /dev/urandom | base64 | tr '[:upper:]' '[:lower:]' | tr -d '=+/' | head -c 16)"
  printf '%s' "$marker" >"$(marker_file)"
  oidc_login || return 1
  if site="$(site_id)" &&
    body="$(curl -sS --noproxy '*' --fail-with-body -b "$SMOKE_JAR" -X POST -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg p "wonton-smoke-$marker" --arg t "smoke $marker" --arg c "$marker" \
        '{path:$p,title:$t,editor:"markdown",content:$c,locale:"en"}')" \
      "$(site_origin)/_api/sites/$site/pages")"; then
    jq -er '.page.id' <<<"$body" >"$(marker_id_file)" || { echo "建页响应里没有 id：$body"; return 1; }
  else
    # 2.x（升级起点）：它的 GraphQL 建页
    body="$(curl -sS --noproxy '*' --fail-with-body -b "$SMOKE_JAR" -X POST -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg p "wonton-smoke-$marker" --arg t "smoke $marker" --arg c "$marker" \
        '{query:"mutation($path:String!,$title:String!,$content:String!){pages{create(path:$path,editor:\"markdown\",title:$title,description:\"\",content:$content,isPublished:true,isPrivate:false,locale:\"en\",tags:[]){responseResult{succeeded message} page{id}}}}",variables:{path:$p,title:$t,content:$c}}')" \
      "$(site_origin)/graphql")" ||
      { echo "建页失败：$body"; return 1; }
    jq -e '.data.pages.create.responseResult.succeeded' <<<"$body" >/dev/null ||
      { echo "建页失败：$body"; return 1; }
    jq -er '.data.pages.create.page.id' <<<"$body" >"$(marker_id_file)"
  fi
}

data_check() { # 按标记搜回页面：搜索建在正文上，页面还在、正文没丢才搜得到
  local marker site body
  marker="$(cat "$(marker_file)")"
  oidc_login || return 1
  site="$(site_id)" || { echo "取不到站点 id"; return 1; }
  body="$(curl -sS --noproxy '*' --fail-with-body -b "$SMOKE_JAR" \
    "$(site_origin)/_api/sites/$site/pages/search?query=$marker&locales=en")" ||
    { echo "搜索失败：$body"; return 1; }
  jq -e --arg p "wonton-smoke-$marker" '.results | map(.path) | index($p) != null' <<<"$body" >/dev/null ||
    { echo "搜不到页面 wonton-smoke-$marker：$(head -c 200 <<<"$body")"; return 1; }
}

marker_file() { # SMOKE_STATE 在 dev.sh probes 里是目录、在 e2e 里是文件，标记放旁边
  if [[ -d "$SMOKE_STATE" ]]; then
    printf '%s' "$SMOKE_STATE/wikijs-marker"
  else
    printf '%s' "${SMOKE_STATE}.marker"
  fi
}

marker_id_file() { printf '%s.id' "$(marker_file)"; }
