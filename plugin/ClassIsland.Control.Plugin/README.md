# ClassIsland Control Plugin

ClassIsland Control 的设备端插件。插件仅使用 `ClassIsland.PluginSdk` 提供的公开接口，不反射或依赖 `ClassIsland.Services.*`。

首个兼容基线：ClassIsland 2.1.1.1 / Plugin SDK 2.1.1.1 / API 2.0.0.0。

## 点名悬浮窗

常驻的长方形悬浮窗（背景高斯模糊、整窗可拖动，鼠标与 Windows 触摸共用同一套指针事件）：

- 「抽人」：抽 1 人，屏幕中央弹出名字框，默认 3 秒后淡出。
- 「多人」：下拉选 2–6 人，结果按「多人基准秒数 + 每多一人 1 秒」停留更久。
- 抽中后同时经插件的提醒提供方拉起 ClassIsland 提醒（可关）。

名单只由集控端下发（本地缓存 `rollcall.json`，由轮询里的 `rollCallRevision` 决定何时重新拉取），设备端不可编辑。窗口宽高、不透明度、停留时长、窗口位置都在「设置 → 点名 → 点名悬浮窗」里调整。