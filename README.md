# Wabicat 信息站

一个轻量的中文信息展示站，用于阅读经过整理的新闻、旅行灵感及其他信息。网页提供标题、摘要、正文、分类、发布时间和来源链接，并支持本地搜索。

## 设计思路

先用无需外部依赖的 Node.js 服务建立最小可用版本：网页负责公开阅读，JSON API 负责读取内容；后端按可扩展的信息记录保存内容。新增、编辑和删除接口使用管理员 Bearer token 保护，不把密钥写入代码或仓库。后续按实际需要再接入新闻、旅游等来源，并保留来源链接和发布时间；未经请求不会自动抓取或发布。

## 运行

- Node.js 18 或更新版本；不需要第三方 npm 包。
- 执行 `npm start`（或 `node server.js`）。默认监听 `3000` 端口，可用 `PORT` 修改。
- 配置强随机值 `ADMIN_API_KEY` 后才能启用写接口；不要提交密钥。
- 内容默认保存到 `data/items.json`。如果主机在重新部署时会清理应用目录，请用 `DATA_FILE` 指定持久化路径。

## API

公开读取：`GET /api/items`，返回 `{ "items": [...] }`。

健康检查：`GET /api/health`。

以下写入路由都要求 `Authorization: Bearer $ADMIN_API_KEY`（也支持 `X-Admin-Token`）。JSON 字段：`title`（必填，最多 180 字符）、`summary`（最多 500）、`body`（最多 12,000）、`category`（最多 60）、可选 `sourceUrl`（仅 http/https）。

- `POST /api/items`：新增信息，成功返回 `201`。
- `PATCH /api/items/:id` 或 `PUT /api/items/:id`：更新提供的字段。
- `DELETE /api/items/:id`：删除指定信息。

示例：

```sh
curl -X POST https://YOUR-HOST/api/items \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"示例资讯","summary":"简短摘要","body":"正文","category":"新闻","sourceUrl":"https://example.com/"}'
```

## 当前托管状态

Silly 免费主机上的网页和公开读取接口已部署；该主机当前没有配置应用所需的 `ADMIN_API_KEY`，因此线上写接口会返回 `503`，不会接受发布或管理请求。代码仍保留受保护的写接口；只有在托管环境提供安全的环境变量设置后，才应配置密钥并启用。

服务会校验 JSON 和来源网址、限制请求体大小、用原子替换保存内容，并以恒定时间比较管理员令牌。网页会转义内容后再显示。


## Private publishing key

The server reads a local `.env` file at startup for private settings such as `ADMIN_API_KEY`. Create that file in the hosting container (never commit it); `.gitignore` excludes `.env` and `.env.*`. Set `ADMIN_API_KEY` to a long random value, then restart the service. Send it only in the `Authorization: Bearer <key>` header when using the write API. Do not put the key in source files, the public website, a URL, or GitHub.

For local use, you can create `.env` with a line in this form:

```dotenv
ADMIN_API_KEY=replace-with-a-long-random-secret
```

Replace the example locally with a generated secret. Never use the example text as a real credential.
