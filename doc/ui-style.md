# 界面规范

面向贡献者。README 只讲用法，这里讲界面上东西长什么样、为什么长成这样。

## 配色

暖米白纸面 + 近黑文字，不是白底蓝字。所有颜色只从 `app/assets/css/main.css` 的令牌取，组件里不写字面色值。

- 底色三档：`--canvas`（页面）→ `--surface-1`（卡片）→ `--surface-2`/`--surface-3`（嵌套与表头）。
- 文字四档：`--ink`、`--ink-soft`、`--ink-muted`、`--ink-faint`，按层级递减对比，不靠改字号区分主次。
- 强调色 `--accent` `#946b3c`（暗色 `#c79a63`）只用于选中态、链接与关键数字，不当背景大片铺。
- 主按钮是深橄榄实心：`--fill` `#252820`，hover `--fill-hover` `#4b4a3b`，文字 `--fill-ink`。
- 状态色 `--good`/`--warning`/`--serious`/`--critical` 一律低饱和，不出现荧光感。
- 不用渐变；磨砂（`--surface-glass`）只用于跨层顶栏、抽屉与对话框。

## 形状与线条

- 直角。`--radius-*` 全部为 0，只有圆点（状态灯、头像）例外。
- 分隔靠 1px 发丝线：`--line` 常规、`--line-soft` 弱化、`--line-strong` 承压、`--line-ink` 深浅交界。
- 卡片不靠阴影自证，描边即边界；阴影只给真正浮起来的层（`--shadow-pop`）。

## 刻度

- 主操作 `--control-h` 46px，行内紧凑 `--control-h-sm` 34px，同一行内不混用。
- 微标签（eyebrow / kicker / micro）9–12px 配 0.6–1.7px 字距，用于节标题与脚注，不拿来写正文。

## 动效

- 时长：`--t-fast` 150ms 内容淡入，`--t-mid` 200ms 退场，`--t-enter` 300ms 浮层与页面进场。
- 曲线：进场 `--ease-enter` `cubic-bezier(0.22,1,0.36,1)`，退场 `--ease-exit`。选项卡指示条位移 180ms 同曲线。
- 只动 `transform` 与 `opacity`；不加视差、不做入场连环延迟。

## 主题

主题是手动开关：`document.documentElement.dataset.theme`，存 `localStorage["classisland-control-theme"]`，**不跟随 `prefers-color-scheme`**。

因此跟着主题换色的图形必须是内联 SVG 并用 `currentColor`；`<img>` / `<link>` 加载的 SVG 吃不到 `data-theme`，只能各自写 media query（`public/brand/*.svg` 就是这种孤立情况）。

## 组件复用

- 页面标题统一 `PageHeading`。
- 破坏性操作统一 `ConfirmDialog`，过程反馈统一 `useToast`，不新增浏览器原生 `alert`/`confirm`。
- 整卡可点：卡片本体即主要动作，次要动作放在卡片内的按钮上，不要做成只能点标题才有效。
- 长表单/长弹窗按选项卡分节，不堆成一页长滚。

## 文案

- 中文优先，走 `@nuxtjs/i18n`（`defaultLocale: "zh-CN"`，`strategy: "no_prefix"`，单语言文件 `i18n/locales/zh-CN.json`）。
- 不渲染原始英文枚举：经 `app/utils/labels.ts` 翻译；品牌名与协议诊断值除外。
- 界面上不放教程段落，不解释怎么操作；说不清的地方改进交互而不是补说明文字。

## 类名注意

`main.css` 里有全局 `.solid`（主按钮），它会设置 `color`。组件内的 SVG 或元素若也叫 `.solid`，就会跟着拿到按钮的文字色，`currentColor` 填出来的是 hover 态的白色。组件私有类一律起自己的名字（`AppLockup` 用 `.lockup`），不要复用全局类名。
