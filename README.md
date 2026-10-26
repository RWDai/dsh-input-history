# dsh-input-history

DSH（DeepSeek Harness）Web 插件：**在对话输入框按 ↑/↓，像终端一样翻出本会话发过的消息**。

↑ 取上一条，再按继续往前翻；↓ 往回走，走过最新一条就还原你进入前的草稿。改了字就退出浏览态（下次 ↑ 重新进入）。

**界面上不留任何东西**：没有提示条、没有按钮、没有图标，只有按键行为本身。

## 安装

**随 bundle**（推荐）：装 [dsh-rwdai-bundle](https://github.com/RWDai/dsh-rwdai-bundle) 即含本插件，插件页可单独开关。

**单独装**：在 DSH Web 的插件页 → 添加插件：

```
github:RWDai/dsh-input-history
```

或本地开发用 `link:` 指向本目录。装载成功的标志：

```bash
curl -s http://127.0.0.1:3080/plugin/dsh-input-history/health
# {"ok":true,"plugin":"dsh-input-history","version":"0.1.0","clientSeenAt":null}
```

## 键位与边界

| 操作 | 行为 |
|---|---|
| ↑（草稿为空） | 直接进入浏览态，取最新一条——不做任何光标测量 |
| ↑（草稿非空，光标在首行行首） | 暂存草稿后进入浏览态 |
| ↑（草稿非空，光标在别处） | 仍是移动光标，不打断输入 |
| ↑/↓（正在看历史） | 往更旧 / 更新翻 |
| ↓（越过最新一条） | 还原进入前的草稿并退出 |
| 改字 / 换会话 | 退出浏览态 |

以下场景一律让路，本插件不接管：

- `/`、`@` 触发菜单开着（`[data-trigger-menu]`）
- IME 组合中（`data-composer-composing`）
- 提交进行中（输入机 phase 非 `plain`）
- 修饰键（Ctrl/Alt/⌘）+↑/↓

## 数据从哪来

全部走公开 slot 契约，不碰内部对象：

- **历史**：slot 标准 props 的 `useConversation` → `'chat'` 视图快照 → `legacy.nodes`，取 `kind: 'user'`（回合开场）与 `kind: 'steering'`（回合中插话）节点的 `text` 块拼成纯文本；按 `seq` 去重，相邻同文折叠（重试、编辑器重复物化只留一条），新→旧排列。
- **写入**：`inputActions.setDraft` 整体替换（翻出来的就是要从头编辑的历史原文，引用 chip 一并撤掉是预期行为）。
- **归属校验**：渲染时用 `useSession` 的权威 sessionId 复核快照——会话切换的过渡帧里 `useConversation` 给的可能还是上一个会话的窗口，绝不能让它冒充新会话的历史。

历史只在浏览器内存里，不落盘、不上报；host 半只提供一个 `/health` 自检端点（浏览器半装载时会带 `client=1` 打一次卡，`clientSeenAt` 即上次浏览端加载时间）。

## 开发

```bash
cd dsh-input-history
npm test        # node test/host.smoke.mjs && node test/client.smoke.mjs
```

冒烟测试不依赖真浏览器：host 半真起 `node:http` 验证 `/health`；client 半在 `node:vm` 沙箱里跑 bundle，验证 Loader 契约、历史提取、按键状态机与全部让路分支。

### 排查

浏览器控制台里有 `__dshInputHistory`：

```js
__dshInputHistory.probe()   // { history, cursor, draft, composer }
__dshInputHistory.reason()  // 最近一次 ↑/↓ 为什么被放行，如 "entered" / "not-composer" / "caret-mid-draft"
```

- `composer: 0` → 页面上没找到 `[data-composer-input]`，说明这不是会话页。
- `history: 0` → 当前会话窗口里没有可翻的消息。
- `reason()` 一直 `not-composer` → 焦点不在输入框。

已知限制：草稿非空时的「光标是否在首行行首」靠 Range 的文本行矩形度量（不是元素的边框盒，后者含 padding 会偏出一整段），允许半个行高的浮动；量不出来时一律按可接管处理，宁可多翻一条也不做死键。
