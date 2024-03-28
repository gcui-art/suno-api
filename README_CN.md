# Suno AI API

![suno-api banner](https://github.com/gcui-art/suno-api/blob/main/public/suno-banner.png)

[English](./README.md) | [简体中文](./README_CN.md)

用 API 调用 suno.ai 的音乐生成服务，并且可以轻松集成到 GPTs 等 agent 中。

## 简介

Suno.ai v3 是一个令人惊叹的 AI 音乐服务，虽然官方还没有开放 API，但我们已经迫不及待的想在某些地方集成它的能力。
我们发现有一些用户也有类似需求，于是我们将这个项目开源了，希望你们喜欢。

## Demo

我们部署了一个示例，绑定了一个免费的 suno 账号，所以它每天有使用限制，但你可以看到它运行起来的样子：
[https://...](https://...)

## Features

- 完美的实现了 app.suno.ai 中的创作 API
- 支持 Custom Mode
- 一键部署到 vercel
- 除了标准 API，还适配了 GPTs、coze 等 Agent 平台的 API Schema，所以你可以把它当做一个 LLM 的工具/插件/Action，集成到任意 AI Agent 中。
- 宽松的开源协议，你可以随意的集成和修改。

## 如何开始使用？

### 1. 获取你的 app.suno.ai 账号的 cookie

1. 浏览器访问 [app.suno.ai](https://app.suno.ai)
2. 打开浏览器的控制台：按下 `F12` 或者`开发者工具`
3. 选择`网络`标签
4. 刷新页面
5. 找到包含`client?_clerk_js_version`关键词的请求
6. 点击并切换到 `Header` 标签
7. 找到 `Cookie` 部分，鼠标复制 Cookie 的值

![获取cookie](https://github.com/gcui-art/suno-api/blob/main/public/get-cookie-demo.gif)

### 2. 克隆并部署本项目

你可以选择自己喜欢的部署方式：

#### 部署到 Vercel

[button]

#### 本地运行

```bash
git clone https://github.com/gcui-art/suno-api.git
cd suno-api
npm install
```

### 3. 配置 suno-api

- 如果部署到了 Vercel，请在 Vercel 后台，添加环境变量 `SUNO_COOKIE`，值为第一步获取的 cookie。
- 如果在本地运行，请在 .env 文件中添加：

```bash
SUNO_COOKIE=<your-cookie>
```

### 4. 运行 suno api

- 如果部署到了 Vercel：
  - 请在 Vercel 后台，点击 `Deploy`，等待部署成功。
  - 访问 `https://<vercel分配的域名>/api/get_limit` API 进行测试
- 如果在本地运行：
  - 请运行 `npm run dev`
  - 访问 `http://localhost:3000/api/get_limit` API 进行测试
- 如果返回以下结果：

```json
{
  "credits_left": 0,
  "period": "string",
  "monthly_limit": 0,
  "monthly_usage": 0
}
```

则已经正常运行。

### 5. 使用 Suno API

你可以在 `<域名>/docs`查看详细的 API 文档。

## API 说明

Suno API 目前主要实现了以下 API:

```bash
- `/api/generate`: 创建音乐
- `/api/custom_generate`: 创建音乐（自定义模式，支持设置歌词、音乐风格、设置标题等）
- `/api/get`: 获取音乐
- `/api/get_limit`: 获取配额信息
```

详细文档请查看演示站点: [https://.../docs](https://.../docs)

## 集成到到常见的自定义 Agent 中

### 集成到 GPTs

...

### 集成到 coze

...

## 贡献指南

Fork 项目并提交 PR 即可。

## 许可证

LGPL-3.0 或更高版本

## 联系方式

- 联系我们：<support@gcui.art>
- 加入我们的 [Discord](https://...)
- 在 twitter 上关注我们: [@gcui](https://twitter.com/...)

## 相关链接

- 项目仓库: [github.com/gcui-art/suno-api](https://github.com/gcui-art/suno-api)
- Suno.ai 官网: [suno.ai](https://suno.ai)

## 声明

suno-api 是一个非官方的开源项目，仅供学习和研究使用。
