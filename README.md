<div align="center">

# ClassIsland Control

**单学校、千台以内的 ClassIsland 集中管理控制平面**

![Node](https://img.shields.io/badge/Node-%E2%89%A522.22.2-339933?logo=nodedotjs&logoColor=white)
![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs&logoColor=white)
![.NET](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-GPL--3.0-3DA639?logo=gnu&logoColor=white)

Web 管理端（Nuxt/Nitro · SQLite WAL）+ 设备插件（.NET · ClassIsland Plugin SDK 2.1.0.1）

</div>

## ✨ 能力

| 模块 | 说明 |
| --- | --- |
| 🏫 楼栋部署 | 楼栋 → 楼层 → 教室 可视化看板；行内增删改，设备绑定唯一教室 |
| 🧩 策略下发 | `school → organization → tag → device` 分层合并，支持整体替换与追加覆盖、JSON Pointer 锁定 |
| 🗓 课表 | 可视化编辑与常驻快速选择器，一键发布到选中设备 |
| 📚 配置库 | 档案 / 组件布局 / 课表 / 设置 四类配置，可视化编辑器，可导入现有 JSON |
| 📣 任务编排 | 显式设备 / 组织子树 / 标签三种目标解析，支持分批灰度、暂停、取消与重试 |
| 🎲 点名 | 管理端维护名单，设备端悬浮窗「抽人 / 多人」，随轮询增量下发 |
| 🧯 崩溃上报 | 设备未处理异常随轮询上报，按指纹归组统计、看堆栈、可清理 |
| 🔐 权限与审计 | 单角色 + 组织水位线；哈希链审计 + 服务端签名检查点 |

## 🚀 快速开始

要求 Node.js ≥ 22.22.2（推荐 24.15+）。

```bash
npm ci && npm run build && npm start
```

首次访问 `/setup` 创建管理员；数据默认保存在 `./data`。公网部署请设置高熵 `CLASSISLAND_CONTROL_BOOTSTRAP_TOKEN`，并由可信反向代理提供 HTTPS。

<details>
<summary>或用 Docker</summary>

```bash
docker compose up -d --build
```

</details>

## 🔌 设备接入

- 接入凭据按次消耗；「同一公钥 + 同一凭据」的重复注册按幂等重放处理，不重复扣次，已吊销凭据一律拒绝。
- 设备完成接入后本机不存在解除入口：写入层把服务器地址、设备身份与密钥折回锁定值，并以设备私钥签名的 `identity.seal.json` 存三处副本。只有集控端下发 `enrollment.release.v1`、且终态回执已被接收，设备才清除身份。
- 连接方式由管理端逐台指定（`devices.transport`）：`http` 为短轮询 `POST /api/v1/agent/poll`，`websocket` 为长连接 `POST /api/v1/agent/ws`。两者提交同一份签名信封，序列窗口、重放缓存与审计语义完全一致。

## 📦 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务 |
| `npm run build` / `npm start` | 构建 / 运行生产服务 |
| `npm run typecheck` | 类型检查 |
| `npm test` | 单元测试（vitest） |
| `npm run protocol:verify` | 校验 C# → TS 协议向量是否漂移 |
| `npm run jcs:verify` | 校验 JCS 规范向量 |
| `npm run backup` / `npm run restore` | 离线备份 / 恢复 |
| `npm run sbom` | 生成 CycloneDX 1.5 SBOM |

插件构建（产物 `plugin/ClassIsland.Control.Plugin/cipx/*.cipx`，校验和见 `cipx/checksums.md`）：

```bash
dotnet build plugin/ClassIsland.Control.Plugin/ClassIsland.Control.Plugin.csproj -c Release
```

调试时使用官方模板的 `-epp $(TargetDir)` 启动配置。

## 🗂 目录

```text
app/      Web 管理端（页面、组件、设计令牌 app/assets/css/main.css）
server/   服务端（API、迁移、策略解析、审计）
shared/   前后端共享 schema 与协议向量
plugin/   ClassIsland 设备插件
tools/    C# 协议 / JCS 向量生成器
tests/    vitest 用例
scripts/  备份与恢复
```

## 🧠 设计要点

- **策略**：`policy_state.desired_epoch` 单调递增，有效修订号回退也会触发重同步；发布使用乐观并发（`baseRevision` 不一致返回 409）；设备上报 `policyEpoch` / `policyHash` / `appliedSections` 以判定已同步、漂移或离线。
- **锁定**：服务端 JSON Pointer 锁只作用于层间合并；`settings` 节由宿主 `IManagementService.Policy` 硬锁执行，插件以服务端签名快照为准，本地改写 `Policy.json` 重启后仍被折回。
- **时间**：`time` 节支持固定偏移与自动对齐集控端时钟，撤下该节即回退本机原值。
- **审计**：管理写操作与业务写入同事务落 `audit_events` 哈希链，后台每 60 秒对链头签名并存入 `audit_checkpoints`。
- **权限**：「单角色 + 单组织水位线」模型，范围外目标按不存在返回 404。
- **备份**：bundle 含 SQLite 在线快照、服务端签名密钥与逐文件 SHA-256 清单；恢复必须离线执行，签名私钥与数据库必须一起恢复。

## 🎨 界面规范

- **配色**：白色为主、蓝色为辅（`--accent` `#2563eb`）；卡片纯白、无阴影描边；不使用渐变，磨砂只用于跨层顶栏、抽屉与对话框。
- **交互**：标题统一 `PageHeading`，破坏性操作统一 `ConfirmDialog`，过程反馈统一 `useToast`，不新增浏览器原生弹窗。
- **令牌**：设计令牌集中在 `app/assets/css/main.css`；文案中文优先，由 `@nuxtjs/i18n` 管理。

## 📄 相关文档

- [设备插件说明](plugin/ClassIsland.Control.Plugin/README.md)
- [协议向量](shared/protocol-vectors.json) · [JCS 向量](shared/jcs-vectors.json)

## 📜 许可证

以 [GPL-3.0](LICENSE) 授权：可自由使用、修改与分发，但分发修改版或衍生作品时须以同一许可证开源并保留版权声明，且不提供任何担保。

---

<div align="center"><sub>GPL-3.0 · ClassIsland Control</sub></div>