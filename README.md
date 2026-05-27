# Pokemon Nuzlocke Tracker

一个面向宝可梦 Nuzlocke 挑战的本地状态追踪工具。目前主要适配 Radical Red / FireRed 系 ROM hack，可以从 mGBA Lua 脚本实时读取同行宝可梦、盒子宝可梦、HP、捕获地点等数据，并提供普通网页面板和 OBS 直播 overlay。

## 功能

- 实时读取 6 只同行宝可梦状态
- 读取 PC 盒子中的宝可梦
- 自动根据 HP 归 0 标记死亡
- 支持手动右键标记死亡或复活
- 根据 `metLocation` / `metMapsec` 汇总每个区域的捕获数量
- 每个区域默认限制 1 只，可在页面中单独修改
- 使用 Radical Red 数据源提供本地 sprite
- 提供 OBS 透明背景页面
- 提供随机 Roll 点小工具

## 环境要求

- Node.js 18 或更新版本
- mGBA，且需要支持 Lua 脚本
- Radical Red / FireRed 系 ROM hack
- 浏览器，推荐 Chrome / Edge
- 可选：OBS Studio，用于直播 overlay

本项目不需要安装 npm 依赖，server 使用 Node.js 内置模块运行。

## 启动 Server

在项目根目录运行：

```powershell
node server/index.js
```

默认端口：

- HTTP: `http://127.0.0.1:8787`
- mGBA TCP: `127.0.0.1:8765`

如果需要改端口：

```powershell
$env:HTTP_PORT='8788'
$env:TCP_PORT='8766'
node server/index.js
```

启动后可以打开：

- `http://127.0.0.1:8787/health`
- `http://127.0.0.1:8787/status`

如果还没有 mGBA 数据传入，`/status` 会返回 404，这是正常的。

## 接入 mGBA

1. 先启动 tracker server。
2. 打开 mGBA，并载入游戏。
3. 在 mGBA 中加载 Lua 脚本：

```text
adapters/radical-red/party_export.lua
```

脚本默认会连接：

```text
127.0.0.1:8765
```

如果你修改了 server 的 `TCP_PORT`，也需要同步修改 Lua 文件顶部的：

```lua
local EXPORT_HOST = "127.0.0.1"
local EXPORT_PORT = 8765
```

连接成功后，server 控制台会持续打印当前队伍摘要。

## 页面

### `/dashboard`

```text
http://127.0.0.1:8787/dashboard
```

普通状态面板，主要展示同行宝可梦的详细状态、技能、HP、努力值/个体值等信息。

### `/nuzlocke`

```text
http://127.0.0.1:8787/nuzlocke
```

Nuzlocke 主页面。

左侧展示所有宝可梦，包括同行和盒子中的宝可梦。同行宝可梦排在前面。鼠标悬停可以查看详细信息，右键可以手动标记死亡或复活。

右侧展示每个区域的捕获数量。默认每个区域限制 1 只宝可梦，如果超过限制会标红。你可以直接修改单个区域的数量限制。

右上角有 Roll 点工具，输入数字 `N` 后点击 `Roll`，会随机返回 `1 ~ N` 的整数。

### `/obs`

```text
http://127.0.0.1:8787/obs
```

OBS 直播用透明背景 overlay。

当前布局：

- 上方一排展示 6 只同行宝可梦
- 每只宝可梦有 HP progress bar
- 下方展示 Dead Box，最多显示 30 只死亡宝可梦
- 页面背景透明，适合 OBS Browser Source

OBS 建议设置：

- Browser Source URL: `http://127.0.0.1:8787/obs`
- Width: `610`
- Height: `700`
- 尽量不要在 OBS 里拖拽缩放来源
- 如果需要调整大小，优先修改页面 CSS，而不是在 OBS 中拉伸

## Nuzlocke 状态保存

Nuzlocke 附加状态保存在：

```text
.game/nuzlocke-state.json
```

这里会记录：

- 哪些宝可梦已死亡
- 每个区域的捕获数量限制

`/status` 仍然返回实时原始/enrich 后数据；Nuzlocke 页面会使用 server 侧维护的附加状态。

## 数据源与 Sprite

Radical Red adapter 使用：

```text
adapters/radical-red/data/data.js
```

作为主要数据来源。这个文件来自 Radical Red Pokedex 数据，并包含顶层 `sprites` 表。

server 会为宝可梦生成 `spriteUrl`：

- 如果 adapter 能提供 sprite，就使用本地 `/sprite` 路由
- 如果 adapter 没有 sprite loader，就 fallback 到默认 CDN sprite

本地 sprite 路由示例：

```text
http://127.0.0.1:8787/sprite?adapterId=radical-red&species=19
```

## 常见问题

### `/status` 返回 404

说明 server 还没有收到 mGBA Lua 脚本传来的数据。确认：

- server 已启动
- mGBA Lua 脚本已加载
- Lua 脚本中的 `EXPORT_PORT` 和 server 的 `TCP_PORT` 一致

### OBS 里画面比网页糊

通常是 OBS 对 Browser Source 做了缩放。建议：

- Browser Source 宽高设置为页面实际尺寸
- 右键来源，执行 `Transform -> Reset Transform`
- 确认 Scale 是 `1.0000`
- 不要在 OBS 预览里手动拉伸 overlay

### 死亡状态没有出现

宝可梦 HP 变成 0 时会自动标记死亡。也可以在 `/nuzlocke` 页面中右键宝可梦，手动标记死亡或复活。

## 目前适配范围

当前 adapter 主要针对 Radical Red / FireRed 系内存布局。其他 ROM hack 可能需要新增 adapter 或调整 Lua 内存地址。
