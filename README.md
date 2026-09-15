# ClassIsland Control

ClassIsland 的单学校、千台内集中管理控制平面，由 Nuxt/Nitro、Node.js、SQLite WAL 和 ClassIsland 插件组成。

## 当前边界

插件只使用 `ClassIsland.PluginSdk 2.1.1.1` 的公开类型。不会引用 `ClassIsland.Services.*`、反射内部实现、执行任意脚本、浏览文件或扩展为操作系统远控。没有公开接口的宿主设置、宿主更新及硬锁会在能力目录中明确标记为不支持。

## 启动

要求 Node.js 22.22.2 或更高版本（推荐 24.15 或更新版本）。

```bash
npm ci
npm run build
npm start
```

首次访问 `/setup` 创建管理员。公网部署应设置高熵 `CLASSISLAND_CONTROL_BOOTSTRAP_TOKEN`，并由可信反向代理提供 HTTPS。数据默认保存在 `./data`。

Docker：

```bash
docker compose up -d --build
```

## 设备接入

接入凭据按次消耗，批量凭据最多可注册 `maxUses` 台设备。插件在发起注册请求前就先把 ECDSA 密钥对持久化到插件目录，之后的重试复用同一身份；服务端对「同一公钥 + 同一凭据」的重复注册按幂等重放处理：返回既有设备、不再消耗令牌。这样注册响应丢失既不会产生孤儿设备，也不会额外耗尽批量接入次数；已吊销的凭据无论是否重放都会被拒绝。

设备一旦完成接入，本机侧不存在任何解除入口：插件设置页不提供取消接入或改接其他集控的操作，写入层会把服务器地址、设备身份与密钥折回锁定值（直接改写 `settings.json` / `state.json` 同样无效），并以设备私钥签名的入网封条 `identity.seal.json` 作为权威副本。封条同时写入插件配置目录、配置根下的 `.control-seals` 与 `%LOCALAPPDATA%\ClassIslandControl` 三处，任一副本验签通过即可在启动时恢复接入身份并回写主副本；只有集控端下发 `enrollment.release.v1` 命令、且设备终态回执已被服务端接收后，设备才清除身份与全部封条副本。

设备与集控端的连接模式由管理端逐台指定（`devices.transport`）：设备详情弹窗里的「连接方式」直接切换，或在设备页用「选择目标」圈定多台设备后批量「改轮询 / 改长连接」。`http` 是短轮询 `POST /api/v1/agent/poll`，`websocket` 是常驻长连接 `POST /api/v1/agent/ws`（Nitro 协议升级）。两种传输提交的是**同一份签名信封**——签名负载固定为 `POST /api/v1/agent/poll`，长连接把信封放进 `{"type":"poll","envelope":{…}}`，服务端以 `{"type":"poll-result","keyId":…,"signature":…,"body":"…原始签名正文…"}` 回带——因此序列窗口、重放缓存、命令投递与审计语义完全一致，长连接只是省掉每次轮询的 TCP/TLS 握手；响应里嵌套字符串而非重新序列化，是为了让客户端能逐字节校验服务端签名。每次响应都会回带服务端期望的 `transport`，设备在下一轮自动切换传输。插件端不提供改连接方式的入口，写入层会把该字段折回服务端下发的值，只有集控端能改。

## 楼栋部署

首页按「楼栋 → 楼层 → 教室」维护部署视图：设备经 `room_devices` 绑定到唯一教室（一台设备同一时刻只属于一间教室），删除楼栋、楼层、教室或设备时分配关系级联清理。视图只显示当前账号组织范围内可见的设备，且不参与策略解析——设备的有效策略仍由组织、标签与设备作用域决定，因此调整教室不会触发策略重算。增删改都就地完成，不再进二级弹窗：`＋ 楼栋`、`＋ 楼层`、`＋ 教室` 分别嵌在看板对应层级上（`＋ 教室` 就在该楼层行内），双击楼栋标签、点楼层或教室上的「改名」即可就地重命名，删除走二次确认弹窗，教室卡片上的 `＋ 设备` 直接进入该教室的设备调整。

教室与楼层上的复选直接写入全局目标选择，与「选择目标」弹窗同源；选中后看板顶部给出发布策略、发布课表、下发配置、发布任务四个入口，深链到对应页面并自动展开该页的下发/创建面板（`?new=1`、`?publish=1`）；单击教室名进入该教室的设备调整，单击教室内的设备卡片即弹窗列出该设备命中的全部策略层（学校 → 组织 → 标签 → 设备）、生效与已应用修订、最后上报时间与同步状态，写操作的反馈一律走土司提示。

## 点名名单

点名名单在管理端「点名」页维护（表 `rollcall_rosters`），随轮询下发到设备端的点名悬浮窗。同一作用域只保留一份名单，重复保存即为覆盖；设备按 **设备 → 最近的祖先组织 → 全校** 解析，一层都没命中时得到空名单。每次写入或删除都会分配一个全局单调的 `revision`，设备在轮询请求里回带已应用的修订，只有修订不一致时响应才携带整份名单，因此日常轮询不会重复传输名单本体。名单只读下发，设备端不提供本地编辑入口。

设备端插件提供常驻的点名悬浮窗：长方形、背景高斯模糊、整窗可拖动（鼠标与 Windows 触摸走同一套指针事件）。蓝色「抽人」在屏幕中央弹出名字框，默认 3 秒后淡出；「多人」是 2–6 人的下拉选项，多人结果按「基准秒数 + 每多一人 1 秒」停留更久。抽中后除名字框外还会经插件自带的提醒提供方拉起 ClassIsland 提醒。悬浮窗的宽高、不透明度、单人/多人停留时长与是否提醒都在「设置 → 点名 → 点名悬浮窗」二级菜单里调整，窗口位置由拖动记忆、可一键重置；设备端不提供解除集控的入口，这条约束不受本功能影响。

## 插件

```bash
dotnet build plugin/ClassIsland.Control.Plugin/ClassIsland.Control.Plugin.csproj -c Release
```

启用 `CreateCipx` 后，插件包位于 `plugin/ClassIsland.Control.Plugin/cipx/ClassIsland.Control.Plugin.cipx`。调试时使用官方模板的 `-epp $(TargetDir)` 启动配置。

最近一次本地 Release 构建的 `.cipx` 校验和（会随源码变化）：

- SHA-256 `82938458E967594C5E0836CBA5365D1AF44B59BFE55C9345BF5C46B9BF6FCC81`
- MD5 `8FBC828053225DD886592F3635123BE6`

## 任务编排

任务通过 `/api/v1/admin/tasks` 创建，支持三种目标解析：显式设备、组织子树、标签。选择器在创建事务内解析为不可变设备快照，并过滤禁用、越权或不存在的目标；任务创建后设备加入/退出组织或标签不会改变已下发的受众。创建支持请求幂等：请求体 `idempotencyKey` 或 `Idempotency-Key` 头按调用者隔离，同键同请求回放原任务（`deduplicated: true`），同键不同请求返回 `409`；数据库唯一约束保证同一任务对同一设备只会有一条命令。

任务状态机（`tasks.state`）：

`scheduled → running → {paused} → {cancelling} → completed | partial_failure | failed | expired | cancelled | draft`

- `pause` 冻结 TTL：记录 `paused_at`，暂停期间不推进过期、租约回收或重试；`resume` 按暂停时长整体平移任务与未终态命令的截止时间。
- `cancel` 对未投递（`pending`）命令直接置 `cancelled`；对已投递（`offered`/`received`/`running`）命令转入 `cancelling`，等设备确认或租约/过期超时后才落 `cancelled`，避免“已取消后重新变 offered”的竞态。
- 分批与灰度：`task_batches` 逐批激活，只有当前批次全部终态且无失败时才放量下一批；失败比例达到 `failure_threshold` 时自动取消剩余命令。
- 重试：区分投递重试（`offered` 租约过期回收为 `pending`）与执行重试（`failed` 且未达 `max_attempts` 时，按 `next_attempt_at` 退避后回到 `pending`）。
- 所有终态入口（ACK、取消、过期、暂停恢复）都会在同一个事务内重算命令、批次与父任务状态。

设备每次轮询的响应包含逐条 ACK 回执 `acknowledgements: [{ commandId, status, reason?, state? }]`：`accepted`/`already-recorded` 表示结果已被服务端接收，插件才会从本地 outbox 删除该回执；`rejected`（如 `terminal-conflict`）会保留结果并告警，避免“管理员已取消但副作用已发生”被静默丢弃。

## 策略下发

策略按 `school → organization → tag → device` 优先级合并，并支持 JSON Pointer 锁定。`policy_state.desired_epoch` 单调递增：任何策略激活或设备组织/标签变化都会 +1，因此即使有效修订号回退（如移除标签后 R10 → R1）也会触发设备重同步。

发布表单只要求「勾选要下发的节 + 选配置」：名称可留空，留空时按作用域自动命名（如「设备 · DESKTOP-XXX 策略」），避免一批修订重名；锁定路径与手工 JSON 收在「更多（可选）」里，设置覆盖（不动 / 锁定 / 解锁）保持直接可见。
策略支持两种发布模式（`policy_revisions.mode`）：默认 `replace`——本次文档整体成为该目标的策略；打开「追加到目标已有策略」后为 `append`——服务端以该作用域当前有效修订为基线深合并本次文档（对象递归、数组与标量整体替换），锁取并集，因此只勾选要改的项即可，其余内容保持原样。设置覆盖按项三态（不动 / 锁定 / 解锁）：不动的项不写入本次文档，锁定/解锁只覆盖该项（`allowExitManagement` 写入时取反）。

发布使用乐观并发（CAS）：请求携带 `baseRevision`（0 表示该作用域尚无策略），与当前有效修订不一致时返回 409。设备在每次轮询上报 `policyEpoch`、`policyHash` 与逐节 `appliedSections`；管理端设备详情据此对比 desired（按当前策略实时解析）与 applied（设备上报值），显示 `已同步` 或 `漂移待重同步`；超过 45 秒未上报的显示 `离线未上报`，避免把已停机的历史设备误读成“正在重同步”。

锁的语义需明确：`resolvePolicy` 的 JSON Pointer 锁是**服务端层间合并锁**——在 `school → organization → tag → device` 合并时阻止低层覆盖/删除高校定的子树；公开 SDK 不提供宿主硬锁，因此设备侧是软锁：客户端按 `policyEpoch`/`policyHash` 周期上报并以 `driftCount` 触发收敛，等价于基于内容 hash 的 reconcile。

`settings` 节是例外：它由宿主自带的 `IManagementService.Policy` 硬锁执行，可分别锁定档案整体、课表、时间表、科目、应用设置、启动画面自定义、调试菜单、彩蛋，以及“本机退出集控”。插件把最近一次服务端签名过的轮询正文落盘为策略快照（与封条相同的三副本），启动时先校验签名再重新施加设置锁定，因此本地改写或删除宿主的 `Policy.json` 后重启仍会回到锁定状态；伪造快照会因签名不匹配被拒绝。集控端通过 `POST /api/v1/admin/devices/{id}/release` 下发解除命令，设备仅在回执被服务端接收后清除本地接入身份。

`time` 节调控设备时钟，由插件经宿主 `Settings.TimeOffsetSeconds` 持久化：`{"time":{"offsetSeconds":n}}` 写入固定偏移（正数提前、负数延后，服务端限制 ±86400 秒，插件写入前同样夹取），`{"time":{"auto":true}}` 让设备持续对齐集控端时钟——插件在每次成功轮询后用 `serverTimeUtc` 减去半个往返时延得到集控端当前时刻，与宿主当前时间求差并累加到现有偏移上闭环校正（差值小于 1 秒不动，避免每轮轮询都触发宿主落盘），因此宿主基准无论来自系统时间还是 NTP 都收敛到同一目标。撤下该节（策略文档不再含 `time`）即恢复接管前记录的本机偏移，且只回退真正被改过的部分；时间偏移与设置锁定一样来自服务端签名的策略快照，本地改写 `Settings.json` 后重启会被折回。设备需上报 `time.offset.persist.v1` 能力（宿主不提供时间偏移设置时该节不上报），任务编排中的同名能力可一次性下发固定偏移或自动对齐。

## 配置库

新建配置只需填名称与类型，创建后直接进入可视化编辑器搭建内容；导入现有 JSON 是创建对话框里的可选项，不必先手写文档。档案与组件布局用结构化控件编辑，自动化与插件设置在该编辑器的 JSON 分页里编辑。导航的「配置」分类把这四种配置各做成一个入口：课表指向课表
页，组件布局、自动化工作流、插件设置各是配置库的类型页（`/configurations/components`、
`/configurations/automation`、`/configurations/plugin`），只列本类型的模板与修订；配置库入口不再
单独出现，全量列表仍在 `/configurations`。

课表编辑器有与 ClassIsland 同源的「快装」：把 Excel 里框选的课表直接粘进弹窗（也可以上传 CSV/TXT 或拖入文件），首行星期、首列节次（`第3节` / `三` / `08:00-08:45`）自动识别，一次把科目、时间点与整周课表补齐；任课教师写在 `语文(张老师)` 里，已有科目按名称复用，写入可选「覆盖」或「仅填空」，确认前有一张可逐列改星期的预览表。网格右侧常驻一面科目墙：点中任意格子后直接点科目即可写入，不必先展开下拉框；键盘上还能按数字或科目首字直选，`0` 或 Delete 清空，方向键换格。墙上的「选完跳下一格」开关决定写完后是否自动前进到下一节，状态记在本机，填一整天不用碰鼠标。
配置按 `(configurationId, revision, documentHash)` 版本化保存：`detail/history/diff/rollback` 完整保留历史，回滚会复制旧文档生成更高 revision。写入（含设备回传 `config-requests`）统一经过版本化结构校验：根必须是对象、`schemaVersion` 为 1..1000 的正整数（缺省补 1）、该类型的顶层节必须是对象；超出大小限制直接拒绝。

## 权限与范围

所有 `/api/v1/admin/**` 路由先经统一登录校验，再按路由显式调用 `requirePermission`；写操作（非 GET）额外要求同源 `Origin`，避免 CSRF。

角色权限矩阵（`server/utils/permissions.ts`）：

- `owner`：全部权限。
- `admin`：仪表盘、设备与接入、组织、策略、配置、任务、系统与用户的读写，以及审计读。
- `operator`：仪表盘、设备读写、任务读写与审计读。
- `auditor`：仅 `audit.read`；`viewer`：仪表盘、设备、组织、策略、配置、任务与系统的只读。

组织范围用 `users.scope_org_node_id` 表达：`owner` 始终是全校范围，其余账号被限定在该组织节点子树内。设备、组织、任务的读查询统一经 `deviceScopeFilter`/`visibleOrgNodeIds` 过滤，写目标经 `assertDeviceInScope`/`assertOrgNodeInScope` 逐项校验，越权按“不存在”返回 404；策略、配置库、系统与备份等全校级资源要求全校范围（`assertSchoolWideScope`）。用户创建、改角色、禁用、启用、删除与改范围见 `server/api/v1/admin/users`，角色或状态变化会撤销该用户的活动会话。

范围模型刻意采用「单角色 + 单组织水位线」而非 `(user, role, scopeType, scopeId)` 多绑定表：这已覆盖“只读账号不得读取全校数据”“操作员不得对范围外设备下发任务”两个目标风险；单校部署下多角色多范围绑定属于超出当前边界的复杂度，需要时再演进。

## 审计
所有管理写操作经 `withAuditedTransaction` 与业务写入同事务追加审计事件（`audit_events` 哈希链，含 `previous_hash`/`event_hash`）。`GET /api/v1/admin/audit` 支持游标分页与 `action/targetType/actorId` 过滤，逐条返回 `details` 与 `previousHash`；`GET /api/v1/admin/audit/verify` 从头重算并校验每条事件哈希，返回 `verified/lastSequence/lastHash/count`，断链或内容改写会以 409 返回首个断点。

设备终态 ACK（`command.ack`）、终态冲突（`command.ack.conflict`）、任务收敛（`task.completed`/`failed`/`partial_failure`/`expired`/`cancelled`）以及设备策略收敛/漂移（`policy.applied`/`policy.drift`）都会形成审计事件。后台调度器每 60 秒用服务端签名私钥对审计链头签名并落库（`audit_checkpoints`）；`verify` 响应附带 `latestCheckpoint`、`checkpointMatchesHead`、`checkpointVerified`，即使整条链被重写并重算哈希，也无法伪造与已记录检查点一致的签名。

## 开发校验

```bash
npm run typecheck
npm test
npm run build
npm run jcs:verify
npm run protocol:verify
dotnet build plugin/ClassIsland.Control.Plugin/ClassIsland.Control.Plugin.csproj
```

## 协议契约（C#→TS）

`plugin/ClassIsland.Control.Plugin/Services/ProtocolContracts.cs` 是控制平面线上 DTO 与序列化选项的唯一来源。`tools/ProtocolVectors` 直接编译该文件，用真实的 `System.Text.Json` 输出生成 `shared/protocol-vectors.json`；`tests/protocol-contract.test.ts` 再把每条字节送入服务端 Zod schema，确保“插件实际写出的报文”始终能被服务端接受。

- 可空字段（`keyThumbprint`、`capabilities`、`appliedSections`、ACK 的 `result`）在为空时**省略键**，不写 `null`；因为 `shared/schemas.ts` 使用 `.optional()`，显式 `null` 会被拒绝。
- 重新生成：`npm run protocol:vectors`；漂移校验（不改文件，发现过期即失败）：`npm run protocol:verify`。
- 该测试含反向校验：曾通过临时关闭 `DefaultIgnoreCondition` 复现 4 项失败，证明契约测试并非空跑。

## 备份与恢复

管理端「系统」页可创建一致性备份 bundle，或使用离线脚本：

```bash
npm run backup                                  # 生成 data/backups/backup-<时间戳>/
node scripts/restore.mjs data/backups/backup-... # 停止服务后恢复
```

bundle 由 SQLite 在线备份快照、服务端签名密钥和 `manifest.json`（格式版本、schema 版本、key ID、逐文件 SHA-256 与长度）组成，恢复前会逐项校验哈希、完整性与迁移版本。恢复必须离线执行：先将现有文件移入 `.restore-stash-*`，再原子替换。签名私钥与数据库必须一起恢复，否则所有已接入设备都会拒绝新的服务端身份。

## 供应链

```bash
npm run sbom   # 生成 sbom.cdx.json（CycloneDX 1.5）
```

发布前应重新生成 SBOM、运行 `npm audit`、校验 `.cipx` 与发布包哈希，并在全新目录验证 `node .output/server/index.mjs`。
## 设计原则

- 白色为主、蓝色为辅的原创工业信息风格：页面底为浅蓝灰、卡片纯白、强调色只用一种蓝（`--accent` #2563eb）；非衬线、大圆角、纯色色阶，卡片无阴影和描边。
- 设计令牌与共享控件集中在 `app/assets/css/main.css`：控件高度 `--control-h`（44px）/`--control-h-sm`（36px），控件圆角 `--radius-control`（14px）/`--radius-control-sm`（12px），列表行与内嵌块 `--radius-row`（14px），卡片 `--radius-md`（22px）。按钮与文本框字号由全局基线统一，各页只保留自己的排版差异；次要操作统一用 `.ghost`。
- 页面标题统一使用 `PageHeading`，破坏性操作统一使用 `ConfirmDialog`，过程反馈统一使用 `useToast`；不新增浏览器原生弹窗。
- 不使用渐变；磨砂只用于跨层顶栏、抽屉和对话框。
- 300/200ms 可中断过渡，支持键盘、焦点恢复和 reduced-motion。
- 中文优先；使用 `@nuxtjs/i18n` 和 `i18n/locales/` 管理界面文案，状态文案同时说明原因和下一步。
