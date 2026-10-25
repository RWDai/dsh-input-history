/**
 * dsh-input-history —— 浏览器半。
 *
 * 在输入框按 ↑ 像终端一样翻出本会话发过的消息：↑ 取上一条，↓ 往回走，改过字或
 * 重新聚焦就退出浏览态。数据全部来自公开 slot props：
 *
 *   - 会话消息：useConversation 里 'chat' 视图的 legacy.nodes，
 *     取 kind 'user' / 'steering'（回合开场与回合中插话，都是真人发的），
 *     content 里 type 'text' 的块按序拼成纯文本；
 *   - 写入草稿：inputActions.setDraft（整体替换，撤掉引用 chip 也符合直觉——
 *     翻出来的就是要从头编辑的历史原文）；
 *   - 按键接管：document 捕获阶段的 keydown。只在事件目标就是输入框的
 *     contenteditable、按的是 ↑/↓、且光标已在首行/末行边界时才拦
 *     （光标在中间时 ↑/↓ 仍是移动光标）；触发菜单（/、@ 补全）开着、
 *     IME 组合中、输入框忙（claimed/submitting）时全部让路。
 *
 * 不碰会话日志、不碰 host 状态，因此 host 半只剩一个健康检查。
 */
window.__ModuleLoader__.load({
	id: "dsh-input-history",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const NS = "dshInputHistory";

		// #region 文案
		const zh = {
			hint: "↑ 翻上一条",
			hintBrowsing: "↑↓ 浏览历史 · 再改字退出",
			browsingBadge: "历史 {n}/{total}",
		};
		const en = {
			hint: "↑ for previous message",
			hintBrowsing: "↑↓ browse history · edit to exit",
			browsingBadge: "History {n}/{total}",
		};
		// #endregion

		// #region 模块态
		/** 当前可见会话的输入面；由 dock 组件在渲染时发布。 */
		const current = {
			sessionId: undefined,
			inputActions: undefined,
			draft: "",
			phase: "plain",
			t: null,
			/** 本会话去重后的历史消息（新→旧），从 chat 视图快照提取。 */
			history: [],
			/** 浏览态游标：-1 未浏览；0 = 最新一条，越大越旧。 */
			cursor: -1,
			/** 进入浏览态之前的草稿，↓ 走过头（cursor 越过最旧）时还回去。 */
			savedDraft: "",
		};
		let stylesInstalled = false;
		let keyInstalled = false;
		let historySessionId;
		// #endregion

		// #region 文案
		/**
		 * 取原文案：优先用 slot 绑定的 translator，缺失时退回中文词表。
		 * @param {string} key 文案 key。
		 * @returns {string} 未插值的文案。
		 */
		function phrase(key) {
			const translate = current.t;
			const value = typeof translate === "function" ? translate(key) : undefined;
			if (typeof value === "string" && value !== "") return value;
			return zh[key] ?? key;
		}

		/**
		 * 取文案并做 `{name}` 插值。
		 * @param {string} key 文案 key。
		 * @param {Record<string, unknown>} [vars] 插值变量。
		 * @returns {string} 渲染文案。
		 */
		function t(key, vars) {
			let text = phrase(key);
			if (vars) {
				for (const name of Object.keys(vars)) text = text.split("{" + name + "}").join(String(vars[name]));
			}
			return text;
		}
		// #endregion

		// #region 历史提取
		/**
		 * 从一份 content 块列表里取纯文本：只拼 type 'text' 的块，其余跳过。
		 * @param {unknown} content 消息 content（ContentBlock 数组）。
		 * @returns {string} 纯文本。
		 */
		function textOfContent(content) {
			if (!Array.isArray(content)) return "";
			const parts = [];
			for (const block of content) {
				if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
					parts.push(block.text.trimEnd());
				}
			}
			// 整条两端裁剪：回车连发、结尾空行都不该进历史。
			const joined = parts.join("\n").trim();
			return joined;
		}

		/**
		 * 从 chat 视图快照提取本会话发过的消息（新→旧、去重）。
		 * 'user' 是回合开场消息，'steering' 是回合进行中插进去的话，都算；
		 * context 是注入物、assistant 是回复，都不算。快照窗口可能覆盖同一条
		 * 消息的多次物化，用 seq 去重，seq 大的视为更新。
		 * @param {unknown} chatSnapshot useConversation 里 'chat' 视图的快照。
		 * @returns {string[]} 消息文本，新→旧。
		 */
		function extractHistory(chatSnapshot) {
			if (chatSnapshot === null || typeof chatSnapshot !== "object") return [];
			const legacy = chatSnapshot.legacy;
			const nodes = legacy !== null && typeof legacy === "object" && Array.isArray(legacy.nodes) ? legacy.nodes : [];
			const bySeq = new Map();
			for (const node of nodes) {
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "user" && node.kind !== "steering") continue;
				if (typeof node.seq !== "number") continue;
				const text = textOfContent(node.content);
				if (text === "") continue;
				bySeq.set(node.seq, text);
			}
			const seqs = Array.from(bySeq.keys()).sort((a, b) => b - a);
			const texts = [];
			let previous;
			for (const seq of seqs) {
				const text = bySeq.get(seq);
				// 同文本连发（比如重试、编辑器重复物化）只留最新一条。
				if (text === previous) continue;
				previous = text;
				texts.push(text);
			}
			return texts;
		}

		/**
		 * 换会话判定：本帧 sessionId 与上一帧不同时作废浏览态与旧历史。
		 * 作废后本帧仍照常从快照灌入——slot 组件随会话重挂，首帧拿到的
		 * useConversation 就是本会话的窗口；真换会话时快照自然跟着换。
		 * @returns {boolean} 本帧是否发生了会话切换。
		 */
		function ensureSession() {
			if (historySessionId === current.sessionId) return false;
			historySessionId = current.sessionId;
			current.history = [];
			resetBrowsing();
			return true;
		}

		/** 退出浏览态并丢弃暂存草稿。 */
		function resetBrowsing() {
			current.cursor = -1;
			current.savedDraft = "";
		}
		// #endregion

		// #region 按键判定
		/**
		 * 事件目标是否是输入框的 contenteditable。
		 * 判据：可编辑元素，且类名带 composer 输入样式（.uV2eYG_input）——
		 * 会话页里其他 contenteditable（行内改标题等）不算。
		 * @param {EventTarget | null} target keydown 的目标。
		 * @returns {boolean} true 表示在输入框里。
		 */
		function isComposerTarget(target) {
			const el = target && typeof target === "object" && target.nodeType === 1 ? target : null;
			if (el === null) return false;
			if (typeof el.closest !== "function") return false;
			const editable = el.closest("[contenteditable]");
			if (editable === null || editable.getAttribute("contenteditable") === "false") return false;
			return editable.classList.contains("uV2eYG_input");
		}

		/**
		 * 光标是否已经顶到可视首行的开头（↑ 不该再移动光标）。
		 * 用 Range 拿光标的第一个矩形，和整段文本第一个矩形比 top 与位置。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {boolean} true 表示在首行行首。
		 */
		function caretAtFirstLine(editable) {
			const sel = typeof window !== "undefined" ? window.getSelection() : null;
			if (sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return false;
			const rects = textRects(editable);
			if (rects.length === 0) return true;
			const caret = caretRect(sel);
			if (caret === null) return false;
			const first = rects[0];
			// 首行判定允许半个行高的浮动（字体度量误差）。
			if (caret.top > first.top + first.height / 2) return false;
			return caret.left <= first.left + 1;
		}

		/**
		 * 光标是否已经落到底行末尾（↓ 不该再移动光标）。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {boolean} true 表示在末行行尾。
		 */
		function caretAtLastLine(editable) {
			const sel = typeof window !== "undefined" ? window.getSelection() : null;
			if (sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return false;
			const rects = textRects(editable);
			if (rects.length === 0) return true;
			const caret = caretRect(sel);
			if (caret === null) return false;
			const last = rects[rects.length - 1];
			if (caret.top < last.top - last.height / 2) return false;
			const range = sel.getRangeAt(0);
			// 光标在文档最末（selectNodeContents + 折叠到末尾等价）即行尾。
			const probe = document.createRange();
			probe.selectNodeContents(editable);
			probe.setEnd(range.endContainer, range.endOffset);
			return probe.getBoundingClientRect().right >= last.right - 1 || caret.right >= last.right - 1;
		}

		/**
		 * 输入框里非空文本行的矩形，按视觉顺序。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {DOMRect[]} 矩形列表。
		 */
		function textRects(editable) {
			const all = typeof editable.getClientRects === "function" ? editable.getClientRects() : [];
			const rects = [];
			for (const rect of all) {
				if (rect.width > 0 || rect.height > 0) rects.push(rect);
			}
			return rects;
		}

		/**
		 * 光标的可视矩形。
		 * @param {Selection} sel 浏览器选区。
		 * @returns {DOMRect | null} 光标矩形，拿不到时 null。
		 */
		function caretRect(sel) {
			const range = sel.getRangeAt(0);
			const direct = range.cloneRange();
			direct.collapse(false);
			const rects = direct.getClientRects();
			if (rects.length > 0) return rects[rects.length - 1];
			const box = direct.getBoundingClientRect();
			return box.width === 0 && box.height === 0 && box.top === 0 && box.left === 0 ? null : box;
		}

		/**
		 * 输入框此刻能不能被历史接管：触发菜单开着、IME 组合中、忙阶段都让路。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {boolean} true 表示可以接管。
		 */
		function composerFree(editable) {
			if (editable.hasAttribute("data-composer-composing")) return false;
			if (editable.getAttribute("aria-haspopup") === "menu") return false;
			if (document.querySelector("[data-trigger-menu]") !== null) return false;
			if (current.phase !== "plain") return false;
			return true;
		}
		// #endregion

		// #region 浏览动作
		/**
		 * 写草稿并进入/移动浏览态。
		 * @param {number} next 新游标；超出最旧一格表示退出并还原暂存草稿。
		 * @returns {boolean} 是否真的写了草稿。
		 */
		function browse(next) {
			const actions = current.inputActions;
			if (actions === undefined || typeof actions.setDraft !== "function") return false;
			if (next >= current.history.length) {
				// 越过最旧一格：还回进入浏览态前的草稿（savedDraft 总是字符串，
				// 空草稿还原成空串也是一次真实的 setDraft），并退出浏览态。
				const saved = typeof current.savedDraft === "string" ? current.savedDraft : "";
				try {
					actions.setDraft(saved);
					if (typeof actions.focus === "function") actions.focus();
				} catch {
					return false;
				}
				resetBrowsing();
				return true;
			}
			if (next < 0) {
				// 从最新一条往回越界：退出浏览态并还原进入前的草稿。
				const saved = typeof current.savedDraft === "string" ? current.savedDraft : "";
				try {
					actions.setDraft(saved);
					if (typeof actions.focus === "function") actions.focus();
				} catch {
					return false;
				}
				resetBrowsing();
				return true;
			}
			if (current.cursor < 0) current.savedDraft = current.draft;
			current.cursor = next;
			try {
				actions.setDraft(current.history[next]);
				if (typeof actions.focus === "function") actions.focus();
				return true;
			} catch {
				resetBrowsing();
				return false;
			}
		}

		/**
		 * keydown 处理：命中条件全部满足时接管，否则放行。
		 * @param {KeyboardEvent} ev keydown 事件。
		 */
		function onKeyDown(ev) {
			if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
			if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
			if (!isComposerTarget(ev.target)) return;
			const editable = /** @type {HTMLElement} */ (ev.target).closest("[contenteditable]");
			if (!composerFree(editable)) return;
			ensureSession();
			if (current.history.length === 0) return;
			if (current.cursor < 0) {
				// 未在浏览态：只有光标已在首行/末行才进入——多行草稿中间按 ↑/↓
				// 仍是移动光标，不打断输入。草稿非空也允许进入：进入时暂存，
				// ↓ 越界时原样还回（savedDraft 已同步，见 browse 与上方侦测）。
				if (ev.key === "ArrowUp" ? !caretAtFirstLine(editable) : !caretAtLastLine(editable)) return;
				if (ev.key === "ArrowUp") {
					if (browse(0)) ev.preventDefault();
				} else if (current.draft === "" && browse(current.history.length)) {
					// 空草稿按 ↓：没有可还的历史，还回空串等价于无事发生，但同样吞键。
					ev.preventDefault();
				}
				return;
			}
			// 浏览态里 ↑↓ 翻动；修改草稿由 draft 变化侦测（dock 渲染）兜底退出。
			if (ev.key === "ArrowUp") {
				if (current.cursor + 1 < current.history.length && browse(current.cursor + 1)) ev.preventDefault();
			} else if (browse(current.cursor - 1)) {
				ev.preventDefault();
			}
		}

		/** 安装全局 keydown 捕获；重复调用无副作用。 */
		function installKeydown() {
			if (keyInstalled) return;
			keyInstalled = true;
			document.addEventListener("keydown", onKeyDown, true);
		}

		/** 卸载 keydown 捕获。 */
		function uninstallKeydown() {
			if (!keyInstalled) return;
			keyInstalled = false;
			document.removeEventListener("keydown", onKeyDown, true);
		}

		/**
		 * 换会话或历史更新时核对浏览态：游标指的消息没了就退出。
		 * @param {string[]} history 最新历史。
		 */
		function syncHistory(history) {
			ensureSession();
			current.history = history;
			if (current.cursor >= history.length) resetBrowsing();
		}
		// #endregion

		// #region 提示条
		/** 注入一次样式。 */
		function installStyles() {
			if (stylesInstalled) return;
			stylesInstalled = true;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-input-history";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		// #endregion

		// #region dock 组件
		/**
		 * 输入框上方的提示条：平时只给一行浅色提示，浏览态里显示游标位置。
		 * 同时是数据面：发布输入面、维护会话历史快照、侦测草稿被手改后退出浏览态。
		 * @param {object} props slot 标准 props。
		 * @returns {object|null} React 元素或 null。
		 */
		function HistoryDock(props) {
			const { sessionId, inputActions, useInput, useConversation, useSession, t: translate } = props;
			current.sessionId = sessionId;
			if (inputActions !== undefined) current.inputActions = inputActions;
			if (typeof translate === "function") current.t = translate;
			const state = typeof useInput === "function" ? useInput((s) => s) : undefined;
			const draft = state && typeof state === "object" ? state.draft : "";
			const phase = state && typeof state === "object" ? state.phase : "plain";
			const editing = draft !== current.draft;
			current.draft = typeof draft === "string" ? draft : "";
			current.phase = typeof phase === "string" ? phase : "plain";
			// 草稿和当前浏览的消息不一样了，说明用户改了字：退出浏览态（下次 ↑ 重新进入，
			// savedDraft 已由重置清空，不会把旧草稿还回来）。
			if (current.cursor >= 0 && editing && current.draft !== current.history[current.cursor]) {
				resetBrowsing();
			}

			// 换会话先作废浏览态与旧历史；灌入前用 useSession 的权威 sessionId 复核
			// 快照归属——会话切换的过渡帧里 sessionId 已是新的，而 useConversation
			// 给的可能还是上一个会话的窗口，绝不能让它冒充新会话的历史。
			ensureSession();
			const sessionSnap = typeof useSession === "function" ? useSession((s) => (s && typeof s === "object" ? s.sessionId : undefined)) : undefined;
			const sessionMatches = sessionSnap === undefined || sessionSnap === sessionId;
			const chat = typeof useConversation === "function" ? useConversation((c) => (c && c.views ? c.views.get("chat") : undefined)) : undefined;
			if (sessionMatches) syncHistory(extractHistory(chat));
			else current.history = [];

			if (current.history.length === 0) return null;
			const browsing = current.cursor >= 0;
			const badge = browsing
				? t("browsingBadge", { n: String(current.history.length - current.cursor), total: String(current.history.length) })
				: t("hint");
			return React.createElement(
				"div",
				{ className: "dshhist-dock" + (browsing ? " dshhist-dock-on" : "") },
				React.createElement("span", { className: "dshhist-dock-glyph" }, "↑"),
				React.createElement("span", { className: "dshhist-dock-label" }, browsing ? t("hintBrowsing") : t("hint")),
				browsing ? React.createElement("span", { className: "dshhist-dock-badge" }, badge) : null,
			);
		}
		// #endregion

		// #region 样式
		const CSS = `
/* 与引用条同款：specific-menu 底 + elevation 面板阴影 + lg 圆角，宽度走 composer 变量。 */
.dshhist-dock{box-sizing:border-box;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(255,255,255,.08));display:flex;align-items:center;gap:8px;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,952px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));height:30px;margin:0 auto;padding:3px 10px;flex:none;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,#1f1f22);box-shadow:var(--dsw-elevation-panel,0 2px 12px rgba(0,0,0,.24));overflow:hidden}
.dshhist-dock-glyph{flex:none;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px;line-height:24px}
.dshhist-dock-label{flex:auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px;line-height:24px}
.dshhist-dock-badge{flex:none;padding:1px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#b3b3b3);font-size:11px;line-height:18px}
.dshhist-dock-on .dshhist-dock-label{color:var(--dsw-alias-label-primary,#eee)}
@media (max-width:700px){.dshhist-dock-label{display:none}}
`;
		// #endregion

		// #region 插件体
		/** 依赖的客户端服务。 */
		const inject = ["slots", "locale"];

		/**
		 * 客户端插件体：注册文案与提示条，安装全局按键接管。
		 * @param {object} ctx 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-input-history: dictionaries");

			// order 50：排在引用条（40）之后，最贴近输入框。
			ctx.slots.inject("conversation.input.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.input.dock",
						id: "dsh-input-history",
						order: 50,
						locale: NS,
					},
					HistoryDock,
				),
			);

			installStyles();
			installKeydown();
			ctx.effect(() => () => uninstallKeydown(), "dsh-input-history: keydown listener");

			// 给 host 半打一张卡：服务端能据此确认浏览器半真的跑起来了。
			try {
				void fetch("/plugin/dsh-input-history/health?client=1", { cache: "no-store" }).catch(() => {});
			} catch {
				/* 非浏览器环境或路由缺失时静默 */
			}
		}

		exports.HistoryDock = HistoryDock;
		exports.apply = apply;
		exports.inject = inject;
		// 供测试直接驱动内部原语。
		exports.__internals = {
			textOfContent,
			extractHistory,
			isComposerTarget,
			caretAtFirstLine,
			caretAtLastLine,
			composerFree,
			browse,
			onKeyDown,
			installKeydown,
			uninstallKeydown,
			syncHistory,
			state: current,
			resetBrowsing,
		};
		return module.exports;
	},
});
