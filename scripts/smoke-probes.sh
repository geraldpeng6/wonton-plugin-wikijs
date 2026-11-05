# scripts/smoke.sh 的一项一项探测，跟着插件走。没写的项会 FAIL 并给出写法，不会默认放行。
#
# 页面：web_assert 从标准输入读页面，命中的确是应用的真实页面时返回 0。
# 身份：identity_check 用应用自己的“当前用户”接口断言认出的是用户管理员。没有用户体系时写 IDENTITY_NA=1，
#       并在 SMOKE_NOTE 里写原因。dweb / web_get 是带用户会话的请求助手，可继续走应用自己的登录链。
# 工具：MCP_TOOL 写一个只读工具名（可带插件前缀），MCP_ARGS 是 JSON 参数；mcp_assert 从标准输入读调用结果。
#       要断言多个工具时改成写 mcp_check；调用前要备数据时写 before_mcp。
# 装之前要准备（如先配出口代理）：写 before_install。

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
