# officeace2api

**简体中文** | [English](README.en.md)

[![tests](https://github.com/Q-shuang-dot/officeace2api/actions/workflows/tests.yml/badge.svg)](https://github.com/Q-shuang-dot/officeace2api/actions/workflows/tests.yml)
[![release](https://img.shields.io/github/v/release/Q-shuang-dot/officeace2api)](https://github.com/Q-shuang-dot/officeace2api/releases)

> 本项目在 [LINUX DO](https://linux.do) 社区发布与交流，感谢佬友支持。

把一个模型网关反代成一整套标准 **OpenAI 兼容 API**，并自带一个中文控制台。

**零依赖** —— 只用 Node.js 内置模块，不用 `npm install`。

> **30 秒启动（Windows）**：`git clone` 本仓库 → 双击 `start.cmd` → 打开
> `http://127.0.0.1:7864/admin`。首次启动会自动生成面板口令，详见「二、快速开始」。

> 💡 **账号来源**：面板里「换个账号登录」自己就能完成授权（PKCE + 华为云回调 + DPoP 换 token，
> 全在 `src/oauth.mjs` 里实现），**不需要装桌面端**。装了 **OfficeAce 桌面端**（华为云 DevEco
> Studio 助手）会更省事：服务能自动发现本机已登录的账号，老的「一键授权」入口也能用。

## 💬 参与贡献（有问题 / 建议 / 想改代码，看这里）

欢迎改进本项目！三条路：

- **只是想问问题 / 聊玩法** → 去
  [Discussions](https://github.com/Q-shuang-dot/officeace2api/discussions)，
  不适合开 Issue 的内容放这里。
- **反馈 Bug / 提建议** → 直接开
  [Issue](https://github.com/Q-shuang-dot/officeace2api/issues/new/choose)，
  有对应模板，不用写代码。
- **想改代码** → 先读 **[CONTRIBUTING.md](CONTRIBUTING.md)**，再 Fork → 建分支 → 提 PR。

> ⚠️ 动手前务必确认三条硬规矩：**零 npm 依赖**、**`.cmd` 必须纯 ASCII 无 BOM**、
> **`data/` 和 `logs/` 不许进提交**。详见 CONTRIBUTING.md 第一节。

> 🔐 发现的是**安全漏洞**（凭据泄漏、鉴权绕过等）请走
> [私下报告](https://github.com/Q-shuang-dot/officeace2api/security/advisories/new)，
> 不要开公开 Issue。

![控制台](docs/panel-accounts.png)

---

## 一、有什么功能

### API 层

| 能力 | 说明 |
|---|---|
| `/v1/chat/completions` | 流式 SSE + 非流式 |
| `/v1/models` | 模型列表 |
| Function Calling | 工具调用原样透传 |
| `reasoning_content` | 推理模型的思维链，单独字段返回 |
| `usage` | token 统计（含 `reasoning_tokens`、`cached_tokens`） |
| `X-Request-Id` / `Server-Timing` | 每个请求都有可复制的 ID；流式返回首包耗时，非流式返回总耗时 |

任何能填 Base URL 的客户端都能接：Cherry Studio、NextChat、LobeChat、Cline、Roo Code、
Continue、Cursor、Dify、沉浸式翻译、OpenAI SDK……

### 控制台（`http://127.0.0.1:7864/admin`）

> 控制台默认带**面板口令**校验（首次启动自动生成，见下面的「快速开始」）。
> 打开时地址要带 `?token=`，或者请求头带 `x-admin-token`。
> 想退回"本机自用不校验"，把 `config.json` 里的 `admin.token` 改成 `""` 即可。
> （`open-panel.cmd` 会自动带上口令，日常用不用手记。）

**本机自用建议**：把带口令的地址存成书签。面板前端会从 URL 读口令并发到每个请求上，
所以收藏夹里点开就直接进，不用每次去翻 `config.json`。

| 菜单 | 干什么 |
|---|---|
| **概览** | 一屏看运行状态、剩余积分、今日签到和最近调用（失败调用直接显示原因） |
| **账号池** | 多账号的凭据、剩余积分、健康度一览；批量续期 / 签到 / 停用；**导出凭证**（换电脑用）/ 导入 |
| **用量** | 请求数、token 消耗、近 7 天走势、失败原因分类；调用记录带错误码、请求 ID 和重试链，可复制诊断 |
| **积分构成** | 每个账号还剩多少积分 —— 直接问云端，不是估算 |
| **模型与档位** | 模型清单、别名、隐藏、手工补录；**账号 × 模型可用性矩阵**；自带测试台 |
| **接入信息** | 各种客户端该填什么，一键复制 JSON / .env / curl |
| **运行日志** | 实时日志，按级别过滤 |
| **配置** | 改端口、API Key、上游、刷新间隔，存回 `config.json` |

### 自动化

- **多账号号池**：首包延迟 + 在途数调度、会话黏性（长上下文尽量命中上游缓存）、满员短队列、限流指数退避、连续失败熔断、积分熔断（余额见底的号自动跳过）；冷却/熔断/黏性会落盘，重启不重置
- **模型兜底**：`models.fallback` 里配好备用模型，主模型 429/5xx 时自动换一个重试
- **凭据自动续期**：临时凭据到期前自动换新，不用管
- **换电脑搬家**：一键导出全部账号凭证（可加口令加密），新机器一键导入，不用重新登录
- **每日自动签到**：定时领积分
- **批量注册**：给一批手机号自动注册 + 开通（可选，要接短信验证码）
- **开机自启 + 看门狗**：注册成 Windows 计划任务，进程挂了自动拉起来

---

## 二、快速开始

### 1. 环境要求

- **Windows**（启动脚本是批处理；核心是纯 Node，非 Windows 可以 `node src/index.mjs` 直接起，但桌面端自动发现和 DPAPI 解密是 Windows 专属）
- **Node.js ≥ 20**

没装 Node 也行 —— 如果你装了 OfficeAce 桌面端，启动脚本会自动用它的
`<安装目录>\tools\node\node.exe`（版本 22+）。查找顺序是：
`data\node.txt` → PATH 上的 node → 各盘 `OfficeAce\tools\node\node.exe`。

### 2. 拉下来

```bash
git clone https://github.com/Q-shuang-dot/officeace2api.git
cd officeace2api
```

不想用 git 也行：从 [Releases](https://github.com/Q-shuang-dot/officeace2api/releases) 下载
`officeace2api-vX.Y.Z.zip`，解压后同样双击 `start.cmd`。

第一次启动会自动生成 `config.json` 和 `data\` 目录，不用手工建。

### 3. 启动

双击 **`start.cmd`**（临时启动，关窗口不影响）：

```
[OK] service is up

  OpenAI base : http://127.0.0.1:7864/v1
  Admin panel : http://127.0.0.1:7864/admin?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  API key     : see "apiKeys" in config.json  (default: sk-officeace)
  Log file    : logs\server.log
```

> 控制台地址后面那串 `?token=` 是**面板口令**，首次启动自动生成并写进 `config.json`。
> 别丢掉它 —— 没有它打开面板只会看到 401。（`open-panel.cmd` 会自动带上，不用手记。）

> ⚠️ **不要直接在命令行里 `node src/index.mjs` 然后就关窗口** —— 窗口一关进程跟着死，
> 浏览器会 `ERR_CONNECTION_REFUSED`。要临时用就双击 `start.cmd`。

### 4. 加账号（**第一步是必须做的**）

**先看一眼「账号池」页再决定走哪条路** —— 它可能是空的，也可能启动完就已经有号了：

- **装了 OfficeAce 桌面端**（本机版或便携版）：服务一启动就会自动扫到那上面的账号，
  `账号池` 页直接列出来，**不用手工加**。扫的位置是 `~\.office-claw\`、各盘的
  `<盘>:\软件\OfficeAce\.office-claw`（以及 `OFFICEACE_INSTALL_DIR` 指定的目录）。
  注意后几个是**绝对路径，不跟 `USERPROFILE` 走**。
- **没装的机器**：池子是空的，**反代转发不了任何请求**，得用下面三条路之一。

**① 面板自助登录（推荐，不需要装桌面端）**

打开控制台 →「账号池」页 → 点 **「换个账号登录」** → 浏览器里用你自己的账号登录一次，
账号自动进池、自动续期。这条链路是这个项目自己实现的：自己拼授权链接（PKCE）→ 华为云
回调 → 轮询云端取 code → DPoP 签名换 token（`src/oauth.mjs`），**全程不碰桌面端**。

**② 借用已经登录过的 OfficeAce 桌面端**

> 装了桌面端才有这条路（搜索「OfficeAce」或从华为应用市场获取）。

登录它、随便发一条对话，然后双击 `stop.cmd` 再 `start.cmd` —— 它会自动把凭据抠出来。

> 💡 面板里还有个老的「一键授权」入口（`/admin/api/auth/*`）和注册流水线里的自动授权，
> 那两条是让**本机桌面端**去换授权链接的，没装桌面端就用不了；用上面 ① 就够。

**③ 兜底：手工导入**

如果你有现成的 `baseUrl` + `Authorization`（从其他地方获取），到「账号池」页点「导入账号」直接贴进去。

> 控制台里能随时看到每个号的**剩余积分**和健康度。余额见底的号会被自动跳过（积分熔断）。

### 5. 打开控制台

双击 **`open-panel.cmd`** —— 它会从 `config.json` 现算地址（含面板口令），
服务没起还会先自动拉起来。

> ⚠️ 用 **`127.0.0.1`**，别用 `localhost`。服务只监听 IPv4，而浏览器解析 `localhost`
> 会优先试 IPv6 的 `[::1]`，那里没人接 → 直接连接被拒。

### 6. 接入客户端

| 项 | 填什么 |
|---|---|
| Base URL | `http://127.0.0.1:7864/v1` |
| API Key | `sk-officeace`（**给别人用之前请在控制台「配置」里改掉**） |
| Model | 点「接入信息」一键复制，或看 `/v1/models` |

---

## 三、后台常驻（开机自启）

双击 **`install-autostart.cmd`**，注册成 Windows 计划任务 `officeace2api`：

```
[OK] scheduled task 'officeace2api' installed
[OK] will start automatically at every logon
[OK] running: http://127.0.0.1:7864/healthz
```

好处：**不依赖任何命令行窗口**，关窗口、注销、重启都不会掉，每次登录自动拉起。
任务里还套了一层看门狗（`tools\watchdog.ps1`），进程无论怎么死都会被重新拉起。

不要自启了就双击 **`remove-autostart.cmd`** 卸载。

### 常用命令

| 双击 | 作用 |
|---|---|
| `start.cmd` | 启动（已装任务就走任务，没装就后台拉起） |
| `stop.cmd` | 停止 |
| `status.cmd` | 看健康状态 + 模型列表 |
| `open-panel.cmd` | 打开控制台（服务没起会先自动启动） |
| `free-port.cmd` | 清理端口占用（启动不起来时先双击它） |
| `export-accounts.cmd` | **导出全部账号凭证**（换电脑用，可加口令加密） |
| `import-accounts.cmd` | **在新电脑导入凭证**（把导出的文件拖到它上面） |
| `install-autostart.cmd` | 装成开机自启 |
| `remove-autostart.cmd` | 卸载自启 |

> 容器 / 服务器部署（镜像拉取、Docker Compose、HTTPS、备份迁移、排障）见下面
> 「四、容器部署（Docker / 服务器）」。Windows 上的后台常驻继续用本节这套脚本。

---

## 四、容器部署（Docker / 服务器）

项目本体是纯 Node.js、零 npm 依赖，镜像体积不大，适合放在 Linux 服务器上长期运行。
镜像由 GitHub Actions 在每次推送 `main` 和 `v*` tag 时自动构建，发布到 GitHub Container Registry
（工作流见 `.github/workflows/docker.yml`）：

| 标签 | 对应版本 |
|---|---|
| `ghcr.io/ssdxftx/officeace2api:latest` | 默认分支最新构建 |
| `ghcr.io/ssdxftx/officeace2api:main` | `main` 分支最新构建 |
| `ghcr.io/ssdxftx/officeace2api:sha-<7位提交>` | 某一次提交 |
| `ghcr.io/ssdxftx/officeace2api:1.2.3` | `v1.2.3` tag（同时带 `1.2`、`1`） |

镜像同时发布 `linux/amd64` 和 `linux/arm64`，普通云主机、ARM 服务器都可以直接拉。

### 4.1 能力边界

| 能力 | 容器里 |
|---|---|
| 面板自助登录（PKCE + 云端轮询） | 可用 |
| 导入 / 导出账号包 | 可用 |
| 手工上游（任意 OpenAI 兼容服务） | 可用 |
| 自动发现本机 OfficeAce 桌面端 | 不可用（Windows 专属） |
| DPAPI 解密凭据 | 不可用（Windows 专属） |
| `start.cmd` / 计划任务 / 看门狗 | 不可用，改用容器重启策略 |

`data/` 里是单实例状态：实例锁、一次性 refresh_token 链、签到记录、用量统计。一个数据目录只跑一个容器，
横向扩容会让两个实例互相覆盖。`docker compose` 默认就是一个副本，保持这个设置即可。

### 4.2 准备工作

服务器要求：

- Linux，`amd64` 或 `arm64`
- Docker 20.10 以上，Docker Compose v2（使用 `docker compose` 子命令）
- 出站网络：访问华为云 OAuth / 模型网关，或你自己的上游
- 一个域名（可选，用于 HTTPS）

先生成两个密钥并记下来，面板和客户端都会用到：

```bash
# 面板口令，打开 /admin 时用
export OFFICEACE2API_ADMIN_TOKEN=$(openssl rand -base64 32)

# 客户端调用 /v1 时的 API Key，可以写多个，用逗号分隔
export OFFICEACE2API_KEYS=sk-$(openssl rand -hex 24)

echo "$OFFICEACE2API_ADMIN_TOKEN"
echo "$OFFICEACE2API_KEYS"
```

### 4.3 方式一：docker compose（推荐）

1. 建目录并进入：

```bash
mkdir -p /opt/officeace2api
cd /opt/officeace2api
```

2. 取仓库里的 `docker-compose.yml`：

```bash
curl -fsSL https://raw.githubusercontent.com/ssdxftx/officeace2api/main/docker-compose.yml -o docker-compose.yml
```

3. 写一个 `.env`，让 compose 自动读取密钥：

```bash
cat > .env <<'EOF'
OFFICEACE2API_ADMIN_TOKEN=替换成刚生成的口令
OFFICEACE2API_KEYS=替换成刚生成的 API Key
EOF
chmod 600 .env
```

4. 启动并观察日志：

```bash
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

5. 从日志里取面板地址：

```bash
docker compose logs officeace2api | grep '面板口令'
```

日志里会出现类似 `面板口令 xxxx（在 config.json 的 admin.token，可改）` 的一行。

默认 compose 把端口绑在 `127.0.0.1`，两种访问方式：

- 本机建 SSH 隧道：`ssh -L 7864:127.0.0.1:7864 用户@服务器`，然后打开 `http://127.0.0.1:7864/admin?token=你的口令`
- 把 compose 里 `ports` 改成 `"7864:7864"` 再 `docker compose up -d`，然后打开 `http://服务器IP:7864/admin?token=你的口令`。
  直连公网前先看 4.9 和 4.10 的密钥与 TLS 要求

`docker compose up` 会在当前目录创建 `data/` 和 `logs/` 并挂进容器，账号、用量、配置都落在
`data/`，删除容器后重新 `up` 数据仍在。

### 4.4 方式二：docker run

不使用 compose 时，先建好目录，再执行：

```bash
mkdir -p /opt/officeace2api/data /opt/officeace2api/logs
cd /opt/officeace2api

docker run -d \
  --name officeace2api \
  --restart unless-stopped \
  -p 127.0.0.1:7864:7864 \
  -e OFFICEACE2API_ADMIN_TOKEN="$OFFICEACE2API_ADMIN_TOKEN" \
  -e OFFICEACE2API_KEYS="$OFFICEACE2API_KEYS" \
  -e TZ=Asia/Shanghai \
  -v "$PWD/data:/app/data" \
  -v "$PWD/logs:/app/logs" \
  ghcr.io/ssdxftx/officeace2api:latest
```

`-p 127.0.0.1:7864:7864` 把端口只绑在本机，公网访问交给反向代理（见 4.9）。
需要直接暴露时改成 `-p 7864:7864`，并把两个密钥都换成足够长的随机值。

常用管理命令：

```bash
docker ps --filter name=officeace2api
docker logs -f --tail=100 officeace2api
docker restart officeace2api
docker stop officeace2api
```

### 4.5 方式三：本地构建镜像

仓库根目录有 `Dockerfile`，改完代码可以直接构建：

```bash
git clone https://github.com/ssdxftx/officeace2api.git
cd officeace2api

docker build -t officeace2api:local .

docker run -d \
  --name officeace2api \
  --restart unless-stopped \
  -p 127.0.0.1:7864:7864 \
  -e OFFICEACE2API_ADMIN_TOKEN="$OFFICEACE2API_ADMIN_TOKEN" \
  -e OFFICEACE2API_KEYS="$OFFICEACE2API_KEYS" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/logs:/app/logs" \
  officeace2api:local
```

构建多架构镜像（需要 buildx 和可推送的镜像仓库）：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/officeace2api:dev \
  --push .
```

### 4.6 目录、配置与持久化

容器里固定使用两个目录：

| 容器路径 | 内容 | 是否必须挂载 |
|---|---|---|
| `/app/data` | 配置、账号、用量、积分历史、实例锁 | 必须 |
| `/app/logs` | `server.log`、`server.err.log` | 建议 |

`OFFICEACE2API_CONFIG` 默认指向 `/app/data/config.json`，配置随账号一起备份即可。
首次启动时如果没有配置文件，会自动生成一份；没有指定 `OFFICEACE2API_ADMIN_TOKEN` 时会自动生成面板口令。

容器以 root 启动入口脚本，把 `data/`、`logs/` 的属主改成 `node`，再用 `node` 用户运行服务。
宿主机目录由 Docker 创建成 root 所有也能正常工作；重启容器会自动修正属主。

支持的环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OFFICEACE2API_HOST` | `0.0.0.0` | 监听地址 |
| `OFFICEACE2API_PORT` | `7864` | 监听端口，改动后同步 compose 的端口映射 |
| `OFFICEACE2API_KEYS` | `sk-officeace` | 客户端 API Key，逗号分隔 |
| `OFFICEACE2API_ADMIN_TOKEN` | 首次启动自动生成 | 面板口令 |
| `OFFICEACE2API_CONFIG` | `/app/data/config.json` | 配置文件路径 |
| `OFFICEACE2API_BASE_URL` | 空 | 手工上游地址，用于通用反代 |
| `OFFICEACE2API_AUTHORIZATION` | 空 | 手工上游鉴权头 |
| `TZ` | 容器默认 UTC | 日志与统计使用的时区，建议 `Asia/Shanghai` |

面板里保存的设置会写回 `/app/data/config.json`，重启后仍然生效。环境变量优先级更高，
每次启动都会覆盖同名配置项。

### 4.7 接入客户端

面板起来后，把下面的值填进 Cherry Studio、NextChat、LobeChat、Cline、Cursor、OpenAI SDK 等客户端：

| 项 | 值 |
|---|---|
| Base URL | 反向代理后填 `https://ai.example.com/v1`；直连填 `http://服务器IP:7864/v1`（需要把 compose 端口改成 `7864:7864`） |
| API Key | `OFFICEACE2API_KEYS` 里的任意一个 |
| Model | 面板「接入信息」一键复制，或访问 `/v1/models` |

号池为空时 `/v1/models` 返回空列表，先按 4.8 加账号。

### 4.8 加账号

容器里推荐用面板自助登录：

1. 打开面板：默认绑定 `127.0.0.1` 时用 SSH 隧道访问；配好域名后直接访问 `https://ai.example.com/admin?token=你的口令`
2. 进入「账号池」
3. 点「导入账号」，再点「换个账号登录」
4. 在浏览器里完成华为云登录，面板会自动轮询并把账号收进号池

也可以：

- 「导入账号」里直接粘贴 `baseUrl` 和 `Authorization`
- 「导入账号」里选择「从文件导入」，导入另一台机器导出的账号包
- 编辑 `/app/data/config.json`，填 `upstream.baseUrl` 和 `upstream.authorization`，然后重启容器

通用 OpenAI 反代示例（使用自己的上游，不需要华为账号）：

```json
{
  "upstream": {
    "autoDiscover": false,
    "baseUrl": "https://你的上游/v1",
    "authorization": "Bearer sk-xxxx"
  }
}
```

对应的环境变量写法：

```bash
docker run -d \
  --name officeace2api \
  --restart unless-stopped \
  -p 127.0.0.1:7864:7864 \
  -e OFFICEACE2API_ADMIN_TOKEN="$OFFICEACE2API_ADMIN_TOKEN" \
  -e OFFICEACE2API_KEYS="$OFFICEACE2API_KEYS" \
  -e OFFICEACE2API_BASE_URL=https://你的上游/v1 \
  -e OFFICEACE2API_AUTHORIZATION="Bearer sk-xxxx" \
  -v "$PWD/data:/app/data" \
  -v "$PWD/logs:/app/logs" \
  ghcr.io/ssdxftx/officeace2api:latest
```

### 4.9 反向代理与 HTTPS

公网部署建议把 7864 只绑在 `127.0.0.1`，由 Nginx 或 Caddy 终止 TLS。

Nginx 示例（流式响应需要关闭缓冲）：

```nginx
server {
    listen 443 ssl http2;
    server_name ai.example.com;

    ssl_certificate     /etc/letsencrypt/live/ai.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.example.com/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:7864;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE：关闭缓冲并拉长超时
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}

server {
    listen 80;
    server_name ai.example.com;
    return 301 https://$host$request_uri;
}
```

Caddy 示例（自动申请证书）：

```caddyfile
ai.example.com {
    reverse_proxy 127.0.0.1:7864 {
        flush_interval -1
    }
}
```

同机反向代理会把请求来源识别为 `127.0.0.1`，`/healthz` 因此会附带 `root` 和 `pid` 字段。
只在本机访问 `/healthz`，或在代理层限制它，可以避免这两个信息出现在公网。

### 4.10 备份、迁移与升级

账号和配置都在 `data/`，备份它即可：

```bash
docker compose stop
tar -czf officeace2api-data-$(date +%F).tar.gz data/
docker compose start
```

`data/` 里是明文凭据：`refresh-state.json` 含临时 AK/SK，`oauth-accounts.json` 含 refreshToken
和 DPoP 私钥，`config.json` 含面板口令和 API Key。备份包按密钥对待，存放在受控位置。

迁移到新服务器：把整个 `data/` 拷过去，用同一个 `OFFICEACE2API_ADMIN_TOKEN` 启动。
refresh_token 是一次性的，同一份 `data/` 在两台机器上同时运行会互相烧掉授权链，
迁移时先把旧容器停掉。

升级：

```bash
cd /opt/officeace2api
docker compose pull
docker compose up -d
docker compose ps
curl -s http://127.0.0.1:7864/healthz
```

回滚到某个提交对应的镜像：

```bash
docker pull ghcr.io/ssdxftx/officeace2api:sha-68b3724
```

把 compose 里的 `image` 改成这个 tag，再执行 `docker compose up -d`。
生产环境建议固定具体 tag，避免 `latest` 随构建漂移。

### 4.11 健康检查与排障

```bash
# 容器状态和健康检查结果
docker compose ps

# 实时日志
docker compose logs -f --tail=200

# 健康接口
curl -s http://127.0.0.1:7864/healthz | python3 -m json.tool
```

`/healthz` 的 `status` 有两种取值：

- `ok`：至少有一条可用凭据
- `degraded`：服务本身正常，号池里还没有可用账号；加完账号后会变成 `ok`

`docker ps` 里健康检查探的也是这个接口，返回 HTTP 200 即视为健康。

常见问题：

| 现象 | 原因与处理 |
|---|---|
| 浏览器 401 | 面板地址缺少 `?token=`，或口令与 `data/config.json` 的 `admin.token` 不一致 |
| `/v1/models` 返回 401 | 客户端没带 `Authorization: Bearer <OFFICEACE2API_KEYS>` |
| `/v1/models` 返回空列表 | 号池为空，按 4.8 加账号 |
| 容器反复重启 | `docker compose logs` 查看端口占用或配置解析错误 |
| 写文件权限错误 | 确认挂载的是目录；`docker compose down && docker compose up -d` 会重新修正属主 |
| 日志时间不是本地时间 | 加环境变量 `TZ=Asia/Shanghai` |
| 面板能打开但登录账号失败 | 容器需要出站访问华为云，检查 DNS 和防火墙 |
| 流式响应卡住 | 反向代理没关缓冲，按 4.9 加 `proxy_buffering off` |
| 拉取镜像 403 | GHCR 包权限被改成私有；在 GitHub 包设置里改回 public，或 `docker login ghcr.io` |

容器模式与 Windows 模式共用同一套 `data/` 格式，把 `data/` 搬过去即可继续使用。
DPAPI 加密的凭据文件在 Linux 上解不开，先在旧机器面板「导出凭证」，再到容器里导入。

---

## 五、怎么加账号

五种方式，日常用第 ① 种就够；换电脑看第 ② 种。

### ① 面板自助登录（推荐）

控制台 →「账号池」→ 右上角 **「导入账号」** → 弹出对话框：

| 按钮 | 什么时候用 |
|---|---|
| **开始登录** | 给**已有**的号续授权（云端会话还在，不用重填密码） |
| **换个账号登录** | **再加一个新号**（第二个、第三个……会先登出再让你登新的） |

点完在浏览器里登录，**登录完自己就进号池了**，不用回来点任何按钮。

### ② 换电脑 / 重装系统：一键搬走全部凭证

**不用挨个重新登录。** 旧机器导出 → 拷一个文件 → 新机器导入，账号、别名、启停状态、续期链一起过去。

1. **旧机器**双击 `export-accounts.cmd`（或控制台「账号池」→ **「导出凭证」**）；
   输入一个口令（**强烈建议**，留空就是明文），生成
   `accounts-backup\officeace2api-accounts-<机器名>-<时间>-locked.json`
2. 把这个文件拷到新机器（U 盘、微信传给自己都行）
3. **新机器**双击 `import-accounts.cmd`，把文件**拖到窗口里**，输入同一个口令
4. 新机器双击 `start.cmd`，打开控制台看「账号池」——号都在，积分能读出来就完事了
5. **旧机器上把这个号停掉**（或整机 `stop.cmd`），别再让它续期，见下面 `[!]`

面板上也能做：控制台「账号池」→「导入账号」弹窗底部有「从文件导入」一行（选文件 + 填口令）。

> `[!]` refresh_token 是**一次性的**。同一个 token 被两台机器轮流使用会撞 `STS5.1806`，
> 两边都得重新登录。所以「导出」等于**搬家**，不是「复制一份两边一起用」。
> 想两台机器同时用同一个号，就在两边各登录一次（那是两条独立的授权链）。

包里有什么：账号档案（长期 Basic 鉴权）、24 小时临时 AK/SK、refresh_token、
DPoP 私钥、续期链（含已作废 token 的黑名单）、别名、启停状态。
加密用 AES-256-GCM + scrypt（口令不落盘，忘了就只能重新登录）。

### ③ 从别的机器搬**单个**账号（手工）

只想搬一个号、或者手上只有 `models.json`：

把 `models.json` 里的 `api_base` 和 `custom_headers.Authorization`
填进「导入账号 → 从别的机器搬账号」即可。

### ④ 批量注册

控制台 →「配置 → 授权 / 注册 → 批量注册」：给一批手机号，
服务自动注册华为云账号 + 开通 + 拉进号池。需要接一个短信验证码来源（手工填码或 HTTP 接口）。

### ⑤ 自动发现本机已登录的账号

如果你本机装过 OfficeAce 桌面端并登录过，启动时会自动把它的账号捞进号池，**零配置**。
（所以「换电脑」以后，只要新机器上也装了 OfficeAce 并登过号，两边会自动合并，不会重复。）

---

## 六、必须装 OfficeAce 客户端吗？

**加账号不需要。** 只有两件事需要桌面端：自动抠本机已有账号的凭据、以及老的「一键授权」入口
（`/admin/api/auth/*`，注册流水线的自动授权也复用它）。

| 你的情况 | 要 OfficeAce 桌面端吗 | 要做什么 |
|---|---|---|
| 只想加自己的号（浏览器里登录一次） | **不需要** | 面板「换个账号登录」，见上面第 ① 条 |
| 本机已装桌面端且登过号 | 有就更省事 | 启动即用，自动发现，不用手工加 |
| 想用注册流水线，注册完自动进池 | 目前要（那条路走「一键授权」） | 装桌面端；或注册完用 ① 手工登一次 |
| 没装，但有现成的 `baseUrl` + `Authorization` | 不需要 | 面板「导入账号」贴进去 |
| 只想反代**别的** OpenAI 兼容服务 | **不需要**，华为账号也不用 | `config.json` 里填 `upstream.baseUrl` + `upstream.authorization` |

最后一种情况等于把它当一个通用的 OpenAI 兼容反代来用：

```json
{
  "upstream": {
    "autoDiscover": false,
    "baseUrl": "https://你的上游/v1",
    "authorization": "Bearer sk-xxxxxxxx"
  }
}
```

控制台「配置」页也有这两个输入框（手工上游地址 / 手工鉴权头），填完保存即可。

### 不想让它扫本机：`discover.enabled`

默认 `true` —— 启动时会扫 `~\.office-claw`、各盘 `<盘>:\软件\OfficeAce\.office-claw`
等位置，把本机 OfficeAce 上的账号收进号池。只想用手工导入 / 手工上游的账号，就关掉：

```json
{ "discover": { "enabled": false } }
```

关掉之后账号来源只剩三处：`data\` 里自己登进来的、面板手工导入的、`upstream` 手工上游。

> ⚠️ 别把它和 `upstream.autoDiscover: false` 搞混：后者**只关「每 45 秒的定时重扫」**，
> 启动扫描照跑。所以"只想当反代"的人如果本机装过 OfficeAce，账号会被悄悄收进号池 ——
> 那两个开关是两件事，都关才干净。

---

## 七、常见问题

**Q：浏览器打不开，`ERR_CONNECTION_REFUSED`？**
用 `127.0.0.1:7864`，别用 `localhost:7864`。服务只绑 IPv4，浏览器优先试 IPv6 会直接拒。

**Q：`status.cmd` 说服务挂了，怎么办？**
双击 `start.cmd`，或 `install-autostart.cmd` 交给计划任务托管。日志见 `logs\server.log`。

**Q：双击 `start.cmd` 没反应 / 起不来？**
最常见的原因是端口被占。**启动前会自动清一次**（`tools/free-port.ps1`）：
端口上是没退干净的本服务实例、或者别的程序，都会先被清掉再启动；如果上面已经有一个
**健康的本服务**在跑，它不会去动。清不掉或想知道是谁占着，双击 `free-port.cmd`；
全过程记在 `logs/port-clean.log`。

**Q：客户端返回空正文，但有 200？**
上游把 `max_tokens` 当成「推理 + 正文」的总预算。推理模型的思维链会先把预算吃光，
正文就空了。设 `config.json` 的 `models.minMaxTokens`（默认 1024）让服务自动补足预算。
详见 [技术笔记](docs/技术笔记.md)。

**Q：面板日志里一堆 `上游中断流 ... "error":"client disconnected"`，是不是号坏了？**
不是。`client disconnected` 是**调用方（客户端）在响应写完之前先断开**时，服务自己
abort 上游请求带出来的原因 —— 常见于客户端超时重试、用户点停止、切换会话/模型。
它和上游 RST / `upstream timeout` 是两回事，不会罚凭据、也不该记成上游故障。

两种要分开看：

- **回复已经完整、客户端才挂断**：`finish_reason` 已经出现过，只是客户端不等尾巴上的
  usage 帧和 `[DONE]`。DSH / pi-ai 这类客户端拿到 `finish_reason` 就结束消费，所以
  带 `tool_calls` 的步骤特别常见（正文 0 字、只有 reasoning + tool_call，日志里
  `tokens:0` 不代表失败）。这类现在记成正常请求，行尾带
  `note=client-closed-after-finish`，照常计入「用量」。
- **真中途断了**：没看到 `finish_reason`。记 `INFO 客户端已断开...`，带
  `seq / request_id / src / ua / elapsedMs`，方便看是哪个客户端断的、对应哪个
  `X-Request-Id`；不罚凭据、不计熔断。

流式请求如果 3 秒还没等到首包，服务会先回 `200 + SSE 头` 并每 10 秒
发一个 `: ping` 注释帧，避免客户端在等 HTTP 头时超时；可用 `config.json` 的
`upstream.earlyHeaderMs` 调整（设 `0` 关闭，回到"等首帧再发头"）。

**Q：长上下文怎么尽量省钱/降延迟？**
同一个会话尽量固定到同一个账号，才能命中上游的 prefix cache。`config.json` 的
`pool.sessionTtlSeconds` 控制黏性时长（默认 1800 秒，设 0 关闭）；客户端如果支持，
也可以直接带 `x-session-id` 请求头。面板「用量」页会显示缓存命中率
（上游不返回 `cached_tokens` 时显示 0%，不影响请求）。

**Q：服务重启后，限流冷却和会话黏性会丢吗？**
不会。`data/pool-state.json` 会保存冷却、熔断等级、连续失败数、被拒模型和会话黏性，启动时只恢复仍在有效期内的条目。文件里**不存 Authorization、也不存原始会话 key**（只存不可逆哈希），删除该文件即可手动重置号池状态。状态超过 7 天会自动忽略，避免拿过期结论做调度。

**Q：某个号连续 5xx，会不会每个请求都先打它一次？**
不会。连续 `pool.breakerThreshold` 次（默认 3）账号级失败后，该号进入熔断：`pool.breakerCooldownMs` 起（默认 60 秒）按 2 倍递增，封顶 `pool.breakerMaxMs`（默认 15 分钟）；成功一次即清零。429 仍按 `quota.cooldownOnRateLimitMs` 起做指数退避，封顶 `quota.cooldownOnRateLimitMaxMs`（默认 10 分钟）。400/401/413 和客户端主动断开不会计进熔断。

**Q：客户端报错时怎么快速定位日志？**
每个响应都带 `X-Request-Id`，错误 JSON 里也有 `request_id`；把这一串贴到面板日志搜索/`logs\server.log` 里就能找到同一次请求。`Server-Timing` 还会给流式首包（`ttfb;dur=...`）或非流式总耗时（`total;dur=...`）。

**Q：主模型被限流，能自动换备用模型吗？**
可以，在 `config.json` 里配（默认关闭）：

```json
"models": {
  "fallback": {
    "deepseek-v4.1-flash": ["deepseek-v4.1-flash-1017", "glm-5.3-flash"]
  }
}
```

主模型在 429 / 5xx / 凭据耗尽时才会兜底；400/401/413 不换模型（换了也救不了）。成功时响应头 `X-Fallback-Model` 会标明实际用的备用模型。

**Q：模型列表里有些模型打不通？**
上游网关的目录 ≠ 每个都有权限。打不通的会返回 400 `model_not_available`，
具体哪些能用见 [技术笔记](docs/技术笔记.md)。

**Q：改了 `config.json` 要重启吗？**
端口/监听地址要重启；其余在控制台点「保存」即时生效。

**Q：换了电脑（或重装系统），账号要重新登录一遍吗？**
不用。旧机器双击 `export-accounts.cmd` 导出（建议设口令），把文件拷到新机器，
双击 `import-accounts.cmd` 把文件拖进去即可，见 [四、②](#-换电脑--重装系统一键搬走全部凭证)。
**记得在旧机器上停掉这些号**——refresh_token 是一次性的，两台机器抢同一份会撞 `STS5.1806`。

**Q：数据存在哪？会上传吗？**
全在本机：`data\`（账号状态、用量、积分历史）和 `logs\`。这两个目录已在 `.gitignore` 里，
不会进仓库。服务不做任何外部上报。

---

## 八、目录结构

```
officeace2api/
├── start.cmd / stop.cmd / status.cmd      启动、停止、查看
├── install-autostart.cmd                  装成开机自启
├── open-panel.cmd                         打开控制台
├── free-port.cmd                          清理端口占用（启动不起来先双击它）
├── export-accounts.cmd                    导出全部账号凭证（换电脑用）
├── import-accounts.cmd                    在新电脑导入凭证（把文件拖到它上面）
├── accounts-backup/                       导出的搬运包落这儿（不进仓库：里面是凭据！）
├── config.json                            配置（首次启动自动生成，不进仓库）
├── Dockerfile / docker-compose.yml        容器镜像与部署示例
├── docker/docker-entrypoint.sh            容器入口（修正挂载目录属主后降权）
├── .github/workflows/docker.yml           推送到 main / tag 时自动构建并推 GHCR
├── src/                                   服务本体
│   ├── index.mjs       入口
│   ├── server.mjs      HTTP 路由与 API 实现
│   ├── http-utils.mjs  请求 ID / SSE 头 / JSON 响应 / 背压
│   ├── routing.mjs     会话黏性 key / Retry-After 解析
│   ├── pool.mjs        号池与轮询
│   ├── quota.mjs       积分查询 / 签到 / 熔断
│   ├── refresh.mjs     凭据自动续期
│   ├── bundle.mjs      账号搬运包（换电脑：导出/导入 + 加密 + 合并规则）
│   ├── admin.html      控制台前端（单文件）
│   └── ...
├── tools/                                 排障脚本、回归测试、看门狗
│   ├── free-port.ps1   端口占用清理（start/stop/看门狗共用同一份判断）
│   ├── watchdog.ps1    计划任务的守护载荷（崩了自动拉起）
│   └── service.ps1     计划任务安装 / 启停 / 状态
├── docs/                                  控制台截图 + 技术笔记
├── data/                                  运行期数据（不进仓库）
│   └── register-tasks.json                注册队列落盘（重启不丢任务）
└── logs/                                  日志（不进仓库；server.log 与 server.err.log 都留 3 份）
                                           另有 port-clean.log 记端口清理动作
```

---

## 九、更多

- **[Releases](https://github.com/Q-shuang-dot/officeace2api/releases)** —— 每个版本自动附带
  `officeace2api-vX.Y.Z.zip` + `SHA256SUMS.txt`；解压后直接跑，不用 `git clone`。
- **[docs/技术笔记.md](docs/技术笔记.md)** —— 实现原理、OAuth/PKCE 链路、
  DPAPI 解密、V11-HMAC-SHA256 签名、推理模型 token 预算、踩过的坑，都在这里。
- `npm test` —— 全量纯测试（28 个脚本，干净 clone 可跑；不碰真实服务）
- `node tools/test-config-env.mjs` —— 环境变量覆盖配置（20 项：容器注入监听地址/端口/Key/
  上游/面板口令，空串等于没设，DEFAULTS 不会被上一次加载污染）
- `npm run test:integration -- --base http://127.0.0.1:7864` —— 面板接口 + 端到端冒烟（会改测试实例的配置）
- `node tools/test-routing.mjs` —— 路由纯函数（7 项：显式会话 ID / system 变化不破黏性 /
  Retry-After 秒数与 HTTP 日期）
- `node tools/test-http-utils.mjs` —— HTTP 头与请求 ID（7 项：SSE 不写假 `Server-Timing` /
  有 ttfb 才写 / JSON CORS 暴露头 / 请求 ID 不重复）
- `node tools/test-stream-e2e.mjs` —— 流式链路 E2E（17 项，假上游 + 真 `createApp`：
  正常 SSE / 主模型 429 兜底 / 客户端 abort 后归还号池在途 / 400 不罚号 / 请求 ID / Server-Timing）
- `node tools/test-pool-scheduler.mjs` —— 号池调度器（20 项：会话黏性 / EWMA /
  每模型 EWMA / 在途软上限 / 短队列 / Retry-After / 调度计数）
- `node tools/test-pool-persistence.mjs` —— 号池状态持久化与熔断（21 项：5xx 连败熔断 /
  指数退避 / 429 退避 / 跨实例恢复冷却与黏性 / 状态文件不含密钥 / 损坏与过期状态兜底）
- `node tools/test-usage-cache.mjs` —— 缓存 token 统计（5 项）
- `node tools/test-call-diagnostics.mjs` —— 失败调用诊断字段（9 项：请求 ID / 错误码 /
  HTTP 状态 / 重试链 / 落盘后仍可读）
- `node tools/test-admin.mjs --base http://127.0.0.1:7864` —— 控制台接口自测（**集成测试，必须显式给测试实例**；含配置卫生：死配置检测、
  日志时间用本机时区、周期发现只在变化时说话、面板轮询后台停打、口令换 Cookie、
  上游错误体装在 SSE 帧里也要能解析出 `code`/`message`、面板载荷不许把 `usage.recent`
  整份重复装一遍、日志增量接口只回新行）
- `node tools/test-dpapi.mjs` —— DPAPI 解密链（13 项，起子进程真解密：真 blob 往返 /
  缓存 / 连续失败进冷却）
- `node tools/test-register.mjs` —— 批量注册状态机（36 项，不碰网络：去重 / 暂停不跑 /
  `view()` 脱敏 / 落盘与恢复）
- `node tools/test-logger.mjs` —— 日志落盘与滚动（16 项：留 3 代历史 / 本机时间列 vs
  UTC 的 `ts` / `keepRecent` 裁剪 / debug 按级别挡 / 序号单调递增 /
  `getLogsSince()` 只回新行、无新增回空、序号倒退时回尾部）
- `node tools/test-tps.mjs` —— 日志里 `tps`（输出 token/秒）的算法（11 项：只用
  `completion_tokens` 不掺提示词 / 分母从首字算起 / 窗口太短给 `null` 而不是 0 / 缺数据不猜）
- `node tools/test-logfmt.mjs` —— 对话日志一行式格式（17 项：字段顺序 / 缺值一律 `-` /
  UA 里的换行与引号不许把一行拆开 / 超长截断 / `::ffff:` 前缀剥掉 / 重试才出现 `try=N`）
- `node tools/test-max-tokens.mjs` —— 推理预算改写规则的单元测试（71 项）
- `node tools/test-account-bundle.mjs` —— 账号搬运包（76 项，全在临时目录里跑：加密往返 /
  口令错与篡改都必须失败 / 过期凭据被丢掉 / 死名单并集 / 「本机有活链就不被覆盖」/
  「导回原机器不长出假身份」/ 老的 `oauth-accounts.json` 也能导 / 备份只留最新 3 份）
- `node tools/test-backup-prune.mjs` —— 搬运包与导入备份的清理（30 项，真跑两个 CLI：
  不超上限就一个都不删 / 刚写出来的那份必须保住（mtime 相同也保）/ 删的是最老的 /
  `--check` 一个字节都不写 / 非交互时不许弹资源管理器 / 真 `data\` 不许被碰）
- `node tools/test-discover-switch.mjs` —— 「要不要扫本机」开关 `discover.enabled`（12 项，
  正反两面对照：开着时假 home 里的号扫得出来 / 关掉后连本机真实安装目录也一个都不读 /
  关掉后 `/healthz` 说 0 个账号且手工上游照旧能转发 / 拨回去又能扫到）
- `node tools/test-models.mjs` —— 模型注册表的大小写与去重（14 项：大小写归一 / 上游给
  同一模型两个拼法时只留一条 / 未知名字不许被"造"出来 / 别名与隐藏也大小写不敏感）
- `node tools/test-exports.mjs` —— 源码卫生：`src` 里每个 `export` 都必须有人消费（9 项；
  含四个"这套判定本身还活着吗"的对照：一定被 import 的名字 / 编造的名字 /
  多行 import 里的名字 / 消费者索引规模）
- `node tools/test-model-probe.mjs` —— 模型可用性探测的单元测试（54 项，含 **4b**：
  号池没变时只复核"打不通"的那批 —— 上游后来开了权限要能自己放回 `/v1/models`）
- `node tools/test-authflow-poll.mjs` —— 一键授权的轮询节奏测试（27 项，把 `node:https` 换成假的**数请求次数**：
  未到点不碰云端 / 四路并发只发一次 / 被限流就指数退避到 60 秒封顶 / 「还没好」不许被记成事件）
- `node tools/stress-deep41.mjs` —— 大批量压测：长会话 / 长上下文 / 高并发 / 全模型混打（会真花额度，`--all` 拉满）
- `node tools/diag-empty-window.mjs` —— 撞「推理吃光预算、正文为空」那个窗口
- `node tools/diag-upstream-limits.mjs` —— 摸上游的两条上限：messages 5000 条 / token 窗口
- `node tools/diag-body-too-large.mjs` —— 超大请求体应该回 413 而不是 429
- `node tools/diag-admin-auth.mjs` —— 核对面板鉴权（不带 / 对 / 错口令，以及 ?token= 那条路）
- `node tools/diag-portability.mjs` —— 看 data/ 里的凭据形态（判断能不能拷贝给别人）
- `node tools/diag-local-daily.mjs` —— **本机日常自用体检**：八个菜单的真实接口 + 面板调的路径是否都存在
- `node tools/diag-panel-api.mjs` —— **把面板的 `api()` 抠出来真跑**（验 `{json:{…}}` 和 `{json:true, body}` 两种写法）
- `node tools/diag-fresh-clone.mjs` —— **模拟别人 clone 下来**：只拷 git 跟踪的文件到干净目录起服务
- `node tools/diag-ghost-accounts.mjs` —— 证明 `labels` 不会造出"幽灵账号"

## License

[MIT](LICENSE)
