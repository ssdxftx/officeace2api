# officeace2api 快速开始

> 完整说明以 [README.md](README.md) 为准。本文只保留最短路径。

## 先确认：桌面端不是必需的

- **不装 OfficeAce 桌面端也能用**：打开控制台 →「账号池」→「换个账号登录」，用浏览器登录一次即可。
- 装了桌面端会更省事：服务能自动发现本机已登录的账号，老的「一键授权」入口也能用。
- 桌面端只影响「自动发现」和「一键授权」；不影响自助登录、手工导入、通用 OpenAI 反代。

## 1. 环境

- Windows（启动脚本是 `.cmd`；核心是纯 Node，其他系统可以 `node src/index.mjs`，但自动发现/DPAPI 仅 Windows）
- Node.js ≥ 20；没装 Node 也可以让启动脚本使用 OfficeAce 自带的 `tools\node\node.exe`

## 2. 启动

```bash
git clone https://github.com/Q-shuang-dot/officeace2api.git
cd officeace2api
```

双击 **`start.cmd`**。首次启动会自动生成：

- `config.json`（含面板口令、默认 API Key）
- `data\`、`logs\` 目录

启动横幅会打印面板地址和 `?token=`，别丢掉。

## 3. 加账号（第一次必须做）

打开控制台 →「账号池」：

- **推荐**：点「换个账号登录」，浏览器里登录一次，账号自动进池并自动续期。
- 已装桌面端：服务启动时可能已经自动发现账号，先看一眼账号池。
- 有现成凭据：点「导入账号」，贴 `baseUrl` + `Authorization`。

> 没装桌面端时，账号池默认是空的；不先加号，`/v1` 没有可转发的上游。

## 4. 接入客户端

| 项 | 填什么 |
|---|---|
| Base URL | `http://127.0.0.1:7864/v1` |
| API Key | `config.json` 里的 `apiKeys`（默认 `sk-officeace`，给别人用前务必改掉） |
| Model | 面板「接入信息」一键复制，或看 `GET /v1/models` |

> 用 `127.0.0.1`，不要用 `localhost`：服务只监听 IPv4，浏览器可能先试 IPv6 的 `[::1]`。

## 5. 常驻与排错

- 开机自启：双击 `install-autostart.cmd`
- 打开面板：双击 `open-panel.cmd`（会自动带口令）
- 日志：`logs\server.log`
- 端口被占：双击 `free-port.cmd`
- 测试：`npm test`（纯测试，干净 clone 可跑）；集成测试见 [CONTRIBUTING.md](CONTRIBUTING.md)

更多配置、账号迁移、常见问题见 [README.md](README.md)。
