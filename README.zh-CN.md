# 中国象棋 · 联机对战

[![ci](https://github.com/cyjx007/xiangqi-online/actions/workflows/ci.yml/badge.svg)](https://github.com/cyjx007/xiangqi-online/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**跑在 Cloudflare Workers 上的双人中国象棋，开房间就能下，不需要注册。**

[English](README.md) · 中文

前端是纯静态页面，**直接双击 `index.html` 就能本地双人对弈**；部署后自动获得联机能力。
每一步落子都由服务端的 Durable Object 校验，客户端无法走非法棋，也无法伪造棋局。

这是一个小型的业余项目，不是排位或比赛平台。房间码就是唯一的访问控制，没有账号、段位
或持久化的用户资料。

## 特性

- **本地 / 联机二合一**：同一个前端，本地模式无需联网，联机模式走 WebSocket
- **完整走子规则**：马腿、象眼、炮翻山、兵过河、将帅不能照面、士象不出九宫
- **胜负判定**：将军、将死、困毙（无子可动）自动识别
- **中文棋谱**：每步自动生成记谱（如「炮八平五」「马2进3」），实时同步给双方
- **服务端权威校验**：落子合法性由 Durable Object 判定，非法棋直接被拒
- **席位保护**：同一身份重复连接会顶掉旧连接，避免两个窗口抢同一方
- **断线自动重连**：指数退避重连，重连期间界面会提示状态
- 棋盘 Canvas 绘制，适配手机触控

## 依赖

- 支持 Canvas 与 WebSocket 的现代浏览器。
- Node.js 20 或更新版本，以及 npm（仅部署时需要）。
- 已启用 Workers 与 Durable Objects 的 Cloudflare 账号；免费计划对朋友间对局足够。
- 仓库中不包含任何 API key 或密钥。

## 本地运行

直接双击 `index.html`。走子、将军、棋谱、悔棋、重开全部可用。

本地模式额外支持**悔棋**和**重新开局**——这两个功能在联机模式下不可用，因为需要双方协商。

如果想用 HTTP 而不是 `file://` 打开：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

联机模式需要 Worker，本地调试请用下面的 `wrangler dev`。

## 部署到 Cloudflare Workers

```bash
npm install
npx wrangler login
npx wrangler deploy
```

部署完会输出 `https://xiangqi.<你的子域>.workers.dev`。

为什么是 Workers 而不是 Pages：房间状态依赖 Durable Objects，Pages Functions 不支持
DO 绑定。Workers Static Assets 让页面和 WebSocket 由同一个 Worker 提供。

本地调试用 `npx wrangler dev`，会起一个带真实 Durable Objects 的服务。

## 怎么玩

1. 一方点「创建房间」，拿到房间码
2. 点「复制」把邀请链接发给对方，或直接告诉对方房间码
3. 对方输入房间码点「加入」
4. 建房者执红先走，加入者执黑

联机模式**没有观战位**：房间坐满两人后，第三人加入会被拒绝。

## 规则实现

走子规则集中在 `rules.js`，浏览器和 Worker **共用同一份**（UMD 写法，两边都能加载），
所以本地判定和服务端判定不会出现分歧。

- `legalMovesFor(board, r, c)` — 返回某个棋子的所有合法落点，已过滤掉「走完之后自己被将军」的情况
- `gameStatus(board, side)` — 判断该方是否被将军、是否已无子可动（将死 / 困毙）
- `formatMove(...)` — 生成中文记谱

坐标是 `[row, col]`，10 行 9 列，红方在下方（row 9），红先。

## 房间与座位

| 规则 | 值 | 说明 |
| --- | --- | --- |
| 房间闲置回收 | 24 小时 | 双方都离线且 24 小时无活动，房间连同棋谱一起清空 |
| 座位接管 | 5 分钟 | 某方断线超过 5 分钟且没有活跃连接，新玩家可接管该座位 |
| 消息限流 | 120 条/分钟 | 超出后服务端返回「操作太频繁」 |
| 单条消息上限 | 2000 字符 | 超出直接拒绝 |

玩家身份存在 `sessionStorage`：**刷新页面身份保留，关掉标签页则丢失**。如果房间两个座位
都占着，重开需要等 5 分钟让座位被接管。

服务端还会校验 `Origin`，只接受同源连接，防止其他网站直接连过来占房间。

## 技术实现

- **房间隔离**：一个房间码 = 一个 Durable Object 实例（`GameRoom`），单点强一致
- **持久化**：整盘状态存在 DO storage，DO 被回收后自动恢复
- **实时同步**：WebSocket Hibernation API，空闲时不消耗 CPU 时间
- **状态广播**：每次走子后广播完整棋盘 + 棋谱，前端只负责渲染
- **静态资源**：Workers Static Assets，按 `.assetsignore` 排除后端文件

### 项目结构

```text
index.html       页面结构
app.js           前端逻辑（本地模式 + 联机模式）
rules.js         象棋规则引擎（浏览器 / Worker 共用）
worker.js        Worker + GameRoom Durable Object
wrangler.toml    部署配置
.assetsignore    排除不进静态资源的文件
```

## 限制

- 联机模式不提供悔棋、重开或求和，需要时请退出房间重新创建
- 没有观战位
- 没有账号、段位、匹配或持久化历史
- 目前没有自动化测试或 CI
- 房间码为 4–8 位字母数字，知道房间码的人都能加入
- 受 Cloudflare 免费计划的 Durable Objects 额度限制

## 许可证

[MIT](LICENSE)。
