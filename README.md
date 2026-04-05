# Cloudflare Pages SMTP 邮件发送站点

这是一个可部署在 **Cloudflare Pages + Pages Functions** 的邮件发送网站。

## 功能

- 在网页上输入：收件人、主题、正文
- 通过 Cloudflare 环境变量 / 机密读取 SMTP 配置
- 支持调节发送数量（`count`）和速度（每封间隔 `intervalMs`）
- 后端限制最大批量，避免误操作

## 目录结构

- `index.html`：根路径入口（用于避免 Pages 根目录 404，自动跳转）
- `public/index.html`：前端页面
- `functions/api/send.ts`：发送邮件 API
- `wrangler.toml`：Cloudflare 配置（Node 兼容）

## 1) 安装依赖

```bash
npm install
```

## 2) 本地开发

> 如果你在 Cloudflare Pages 控制台使用 Git 自动部署，请将 **Build output directory** 设为 `public`。
> 当前仓库也提供了根路径 `index.html` 兜底，避免 `/` 直接访问出现 404。


```bash
npm run dev
```

## 3) 配置 SMTP（Cloudflare Pages）

在 Cloudflare Pages 项目设置中添加以下变量：

- `SMTP_HOST`（例如 `smtp.example.com`）
- `SMTP_PORT`（例如 `465` 或 `587`）
- `SMTP_SECURE`（`true` / `false`）
- `SMTP_USER`
- `SMTP_PASS`（建议设为 Secret）
- `SMTP_FROM`（例如 `no-reply@example.com`）

> 建议：`SMTP_PASS`、`SMTP_USER` 使用 Secrets；其余可放普通环境变量。

## 4) API 说明

`POST /api/send`

请求体示例：

```json
{
  "to": "user@example.com",
  "subject": "Test",
  "text": "hello",
  "count": 10,
  "intervalMs": 500
}
```

返回：

- `ok`: 成功发送数
- `failed`: 失败数
- `details`: 每封发送结果

## 注意事项

- 默认单次最多发送 `200` 封（可在代码中调整）
- 请确认 SMTP 服务商的速率限制，合理设置 `intervalMs`
- 该项目用于合法通知和测试用途，请勿滥用
