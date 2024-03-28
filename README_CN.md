# Suno AI API

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

1. 打开浏览器的控制台：按下 F12，或者`开发者工具`
2. 选择`网络`标签
3. 刷新页面
4. 找到包含`client?_clerk_js_version`关键词的请求
5. 点击并切换到 Header 标签
6. 找到 Cookie，鼠标复制 Cookie 的值

<video src="https://github.com/gcui-art/suno-api/blob/feature-SunoAPI-kane/public/get-cookie-demo.mp4"></video>

[![视频标题](缩略图链接)](https://github.com/gcui-art/suno-api/blob/feature-SunoAPI-kane/public/get-cookie-demo.mp4)

### 2. 克隆并部署本项目

### 3. 配置 suno-api

### 4. 运行 suno api

### 5. 更加自由的创作

## API 说明

Suno API 目前主要实现了以下 API:

```bash
- `/api/generate`: 创建音乐
- `/api/custom_generate`: 创建音乐（自定义模式，支持设置歌词、音乐风格、设置标题等）
- `/api/get`: 获取音乐
- `/api/get_limit`: 获取配额信息
```

## 集成到到常见的自定义 Agent 中

### 集成到 GPTs

...

### 集成到 coze

...

### 集成到 Dify

## 贡献指南

## 许可证

LGPL-3.0 或更高版本

## 联系方式

- 联系我们：<support@gcui.art>
- 加入我们的 [Discord](https://...)
- 在 twitter 上关注我们: [@gcui](https://twitter.com/gcui_art)

## 相关链接

- 项目仓库: [github.com/gcui-art/suno-api](https://github.com/gcui-art/suno-api)
- Suno.ai 官网: [suno.ai](https://suno.ai)
