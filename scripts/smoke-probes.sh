# shellcheck shell=bash
# Wiki.js：sso=oidc（网关身份提供方）；清单没有 mcp。

web_assert() { grep -q '知识库'; }   # 走完 OIDC 后落了应用真实页面，站点标题在其中

# 应用自己的“当前用户”查询：认出的必须是 OIDC 建的、带主人邮箱的账号。
identity_check() {
  local out
  out="$(web_get /graphql -X POST -H 'Content-Type: application/json' \
    -d '{"query":"{ users { profile { email providerKey } list { email providerKey } } }"}')" ||
    { echo "查询当前用户失败：$out"; return 1; }
  jq -e --arg e "$SMOKE_OWNER_EMAIL" \
    '.data.users.profile.email == $e and .data.users.profile.providerKey == "oidc"' <<<"$out" >/dev/null ||
    { echo "当前用户不是主人的 OIDC 账号：$out"; return 1; }
  # users.list 要 manage 权限：列得出来就是管理员
  jq -e '.data.users.list | length >= 1' <<<"$out" >/dev/null ||
    { echo "列不出用户，当前用户不是管理员：$out"; return 1; }
}

marker_file() { # SMOKE_STATE 在套件里是状态目录（e2e 传的是标记文件本身），标记放对应路径
  if [[ -d "$SMOKE_STATE" ]]; then printf '%s' "$SMOKE_STATE/wikijs-marker"; else printf '%s' "${SMOKE_STATE}.marker"; fi
}

wikijs_gql() { # <query JSON>：带会话调 GraphQL
  web_get /graphql -X POST -H 'Content-Type: application/json' -d "$1"
}

# 数据：页面就是用户数据（SQLite 在插件数据目录，重装保留）。data_write 用 GraphQL 建一个路径带
# 随机标记的页面，data_check 重装/升级后按 id 读回核对。
data_write() {
  local marker out page_id
  marker="wonton-smoke-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  out="$(wikijs_gql "$(jq -nc --arg m "$marker" \
    '{query:"mutation($p:String!){ pages { create(content:\"云吞冒烟标记\", description:\"\", editor:\"markdown\", isPrivate:false, isPublished:true, locale:\"en\", path:$p, tags:[], title:$p) { responseResult { succeeded errorCode message } page { id path } } } }", variables:{p:$m}}')")" ||
    { echo "create 请求失败：$out"; return 1; }
  jq -e '.errors == null' <<<"$out" >/dev/null || { echo "create 出错：$out"; return 1; }
  jq -e '.data.pages.create.responseResult.succeeded == true' <<<"$out" >/dev/null ||
    { echo "create 没成功：$(head -c 300 <<<"$out")"; return 1; }
  page_id="$(jq -r '.data.pages.create.page.id // empty' <<<"$out")"
  [[ -n "$page_id" ]] || { echo "create 没回页面 id：$(head -c 300 <<<"$out")"; return 1; }
  jq -nc --arg i "$page_id" --arg p "$marker" '{id:$i,path:$p}' >"$(marker_file)"
}

data_check() {
  local out page_id
  page_id="$(jq -r '.id // empty' "$(marker_file)" 2>/dev/null)" || true
  [[ -n "$page_id" ]] || { echo "没有 data_write 留下的页面 id"; return 1; }
  out="$(wikijs_gql "{\"query\":\"{ pages { single(id: \\\"$page_id\\\") { id path } } }\"}")" ||
    { echo "读页面失败：$out"; return 1; }
  jq -e --arg i "$page_id" '.errors == null and .data.pages.single.id == $i' <<<"$out" >/dev/null ||
    { echo "升级/重装后找不到页面 $page_id：$(head -c 300 <<<"$out")"; return 1; }
}
