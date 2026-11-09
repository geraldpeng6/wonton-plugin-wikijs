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

# 带附件升级必须停下：从升级起点重装一遍、写一页和一个附件，升到工作区版本要求失败且报出数量，
# 给了开关（数据目录里的标记文件，生产里是插件页那一项）再装一次要能过、页面还在。
# 只在端到端冒烟里跑一次；`dev.sh probes` 的 SMOKE_STATE 是目录，不在这里重装。
# 不管对错都要把环境装回来：后面的探针还得跑，环境半死不活时它们的失败会盖住这里的结论。
upgrade_guard() {
  local item=带附件升级停下 why="" out rc file dir count
  [[ -d "$SMOKE_STATE" ]] && return 0
  [[ -n "${upgrade_from:-}" ]] || { na "$item" "本仓库没有 tag，测不了升级"; return 0; }
  [[ ! -e "$SMOKE_STATE.guard-done" ]] || return 0
  dir="$SMOKE_DATA_DIR/apps/${SMOKE_PLUGIN_ID//./-}/data"
  say "$item：从 tag $upgrade_from 重新装一遍"
  if ! probes_dev uninstall --purge >>"$PROBES_LOG" 2>&1; then
    fail "$item" "卸掉当前装法失败，看 $PROBES_LOG 末尾：$(tail -c 200 "$PROBES_LOG" | tr '\n' ' ')"
    return 0
  fi
  if probes_dev_t 600 install --yes "$upgrade_from" >>"$PROBES_LOG" 2>&1 &&
    probes_status_wait "$PROBES_PLUGIN_ID" 40 >/dev/null; then
    if ! probes_dev session >>"$PROBES_LOG" 2>&1 || ! probes_web_url "$item"; then
      why="在 2.x 上建不了会话或拿不到网页地址"
    elif ! data_write; then
      why="在 2.x 上写页面失败"
    else
      file="$(mktemp)"
      printf 'wonton smoke attachment\n' >"$file"
      if ! out="$(curl -sS --noproxy '*' --fail-with-body -b "$SMOKE_JAR" \
        -F 'mediaUpload={"folderId":0}' -F "mediaUpload=@$file;filename=wonton-smoke.txt" "$(site_origin)/u")"; then
        why="2.x 上传附件失败：$(head -c 300 <<<"$out")"
      elif [[ "$out" != ok ]]; then
        why="2.x 上传附件没成功：$(head -c 300 <<<"$out")"
      fi
      rm -f "$file"
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
  probes_web_url "$item"
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
