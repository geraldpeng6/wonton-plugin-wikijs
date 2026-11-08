# shellcheck shell=bash
# Wiki.js：sso=oidc（网关身份提供方）；清单没有 mcp。

web_assert() { grep -q '知识库'; }   # 走完 OIDC 后落了应用真实页面，站点标题在其中

# 应用自己的“当前用户”接口：认出的必须是主人本人、且是管理员。
identity_check() {
  local out
  out="$(web_get /_api/users/whoami)" || { echo "查询当前用户失败：$out"; return 1; }
  jq -e --arg e "$SMOKE_OWNER_EMAIL" '.authenticated == true and .email == $e' <<<"$out" >/dev/null ||
    { echo "当前用户不是主人的 OIDC 账号：$out"; return 1; }
  # 根管理员拿的是 manage:system
  jq -e '.permissions | index("manage:system") != null' <<<"$out" >/dev/null ||
    { echo "当前用户不是管理员：$out"; return 1; }
}

# 数据：建一个路径带随机标记的页面，升级/重装后读回。3.x 用 REST；升级起点还是 2.x 时走它的 GraphQL。
site_id() { web_get /_api/ | jq -er '.site.id'; }

data_write() { # 用随机标记写一页，标记存进状态目录
  local marker site body
  marker="$(head -c 12 /dev/urandom | base64 | tr -d '=+/' | head -c 16)"
  printf '%s' "$marker" >"$(marker_file)"
  if site="$(site_id)" &&
    body="$(web_get "/_api/sites/$site/pages" -X POST -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg p "wonton-smoke-$marker" --arg t "smoke $marker" --arg c "$marker" \
        '{path:$p,title:$t,editor:"markdown",content:$c,locale:"en"}')")"; then
    jq -er '.page.id' <<<"$body" >"$(marker_id_file)" || { echo "建页响应里没有 id：$body"; return 1; }
  else
    # 2.x（升级起点）：它的 GraphQL 建页
    body="$(web_get /graphql -X POST -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg p "wonton-smoke-$marker" --arg t "smoke $marker" --arg c "$marker" \
        '{query:"mutation($path:String!,$title:String!,$content:String!){pages{create(path:$path,editor:\"markdown\",title:$title,content:$content,tags:[]){responseResult{succeeded message} page{id}}}}",variables:{path:$p,title:$t,content:$c}}')")" ||
      { echo "建页失败：$body"; return 1; }
    jq -e '.data.pages.create.responseResult.succeeded' <<<"$body" >/dev/null ||
      { echo "建页失败：$body"; return 1; }
    jq -er '.data.pages.create.page.id' <<<"$body" >"$(marker_id_file)"
  fi
}

data_check() { # 按标记搜回页面：搜索建在正文上，页面还在、正文没丢才搜得到
  local marker site body
  marker="$(cat "$(marker_file)")"
  site="$(site_id)" || { echo "取不到站点 id"; return 1; }
  body="$(web_get "/_api/sites/$site/pages/search?query=$marker&locales=en")" ||
    { echo "搜索失败：$body"; return 1; }
  jq -e --arg p "wonton-smoke-$marker" 'map(.path) | index($p) != null' <<<"$body" >/dev/null ||
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
