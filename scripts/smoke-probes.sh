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
