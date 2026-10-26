/**
 * dsh-input-history —— 浏览器半。
 *
 * 在输入框按 ↑ 像终端一样翻出本会话发过的消息：↑ 取上一条，↓ 往回走，改过字就
 * 退出浏览态。数据全部来自公开 slot props：
 *
 *   - 会话消息：useConversation 里 'chat' 视图的 legacy.nodes，
 *     取 kind 'user' / 'steering'（回合开场与回合中插话，都是真人发的），
 *     content 里 type 'text' 的块按序拼成纯文本；
 *   - 写入草稿：inputActions.setDraft（整体替换，撤掉引用 chip 也符合直觉——
 *     翻出来的就是要从头编辑的历史原文）；
 *   - 按键接管：window 捕获阶段的 keydown（最早一跳）。只在事件目标就是输入框
 *     的 contenteditable、按的是 ↑/↓ 时才考虑；草稿非空时还要求光标在首行行首，
 *     免得把「在草稿里移动光标」抢走。触发菜单（/、@ 补全）开着、IME 组合中、
 *     输入框忙（claimed/submitting）时全部让路。
 *
 * 界面上不留任何东西：只注册一个永远返回 null 的 dock 组件，它的作用是拿到
 * inputActions / useInput / useConversation 这几样数据面。
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

		// #region 模块态
		/** 当前可见会话的输入面；由 dock 组件在渲染时发布。 */
		const current = {
			sessionId: undefined,
			inputActions: undefined,
			draft: "",
			phase: "plain",
			/** 本会话去重后的历史消息（新→旧），从 chat 视图快照提取。 */
			history: [],
			/** 浏览态游标：-1 未浏览；0 = 最新一条，越大越旧。 */
			cursor: -1,
			/** 进入浏览态之前的草稿，↓ 越界时原样还回去。 */
			savedDraft: "",
		};
		/** 最近一次按键判定的结果，配合 __internals.reason 排查用。 */
		let lastReason = "idle";
		let keyInstalled = false;
		let historySessionId;
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
		 * 判据：编辑器根节点带 `data-composer-input`（composer 自己的稳定语义标记，
		 * 与样式哈希无关）；老版本 DSH 没有这个属性时退回 composer 输入类名。
		 * 会话页里其他 contenteditable（行内改标题等）不算。
		 * @param {EventTarget | null} target keydown 的目标。
		 * @returns {boolean} true 表示在输入框里。
		 */
		function isComposerTarget(target) {
			const el = target && typeof target === "object" && target.nodeType === 1 ? target : null;
			if (el === null || typeof el.closest !== "function") return false;
			const editable = el.closest("[contenteditable]");
			if (editable === null || editable.getAttribute("contenteditable") === "false") return false;
			if (editable.hasAttribute("data-composer-input")) return true;
			if (typeof editable.classList === "object" && editable.classList !== null) {
				for (const name of editable.classList) {
					if (name.endsWith("_input")) return true;
				}
			}
			return false;
		}

		/**
		 * 输入框文本行的矩形，按视觉顺序取首行与末行。
		 * 用 selectNodeContents 的 Range 取——它对块级元素返回的是**每一行文本**
		 * 的盒子；直接取元素的 getClientRects() 只会得到含 padding 的边框盒，
		 * 拿它比光标位置会永远偏出一整段 padding。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {DOMRect[]} 行矩形；空输入框可能是 0 个。
		 */
		function lineRects(editable) {
			const doc = editable.ownerDocument ?? (typeof document === "undefined" ? null : document);
			if (doc === null || typeof doc.createRange !== "function") return [];
			const range = doc.createRange();
			range.selectNodeContents(editable);
			const rects = [];
			for (const rect of range.getClientRects()) {
				if (rect.height > 0) rects.push(rect);
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
			// 全零盒子通常是空行里量不到光标，不代表位置，交给调用方按「放行」处理。
			return box.width === 0 && box.height === 0 && box.top === 0 && box.left === 0 ? null : box;
		}

		/**
		 * 光标是否在首行行首。
		 * 量不出来时返回 true：宁可让 ↑ 进历史，也不要出现「按了没反应」的死键。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {boolean} true 表示在首行行首。
		 */
		function caretAtFirstLine(editable) {
			const sel = typeof window === "undefined" ? null : window.getSelection();
			if (sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return true;
			const rects = lineRects(editable);
			if (rects.length === 0) return true;
			const caret = caretRect(sel);
			if (caret === null) return true;
			const first = rects[0];
			// 行判定允许半个行高的浮动（字体度量误差）。
			if (caret.top > first.top + first.height / 2) return false;
			// 首行里也要在最左：往右挪过字就是「在改这条草稿」，不抢。
			return caret.left <= first.left + 2;
		}

		/**
		 * 输入框此刻能不能被历史接管：触发菜单开着、IME 组合中、忙阶段都让路。
		 * @param {HTMLElement} editable 输入框元素。
		 * @returns {boolean} true 表示可以接管。
		 */
		function composerFree(editable) {
			if (editable.hasAttribute("data-composer-composing")) return false;
			if (editable.getAttribute("aria-haspopup") === "menu") return false;
			if (typeof document !== "undefined" && document.querySelector("[data-trigger-menu]") !== null) return false;
			if (current.phase !== "plain") return false;
			return true;
		}
		// #endregion

		// #region 浏览动作
		/**
		 * 写草稿并进入/移动浏览态。
		 * @param {number} next 新游标；越界（<0 或 >= 长度）表示退出并还原暂存草稿。
		 * @returns {boolean} 是否真的写了草稿。
		 */
		function browse(next) {
			const actions = current.inputActions;
			if (actions === undefined || typeof actions.setDraft !== "function") return false;
			if (next >= current.history.length || next < 0) {
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
				else refocusComposer();
				return true;
			} catch {
				resetBrowsing();
				return false;
			}
		}

		/**
		 * 把焦点还给输入框：整体替换草稿可能让编辑器失焦，失焦后下一次 ↑ 就
		 * 不再以输入框为目标了。只在输入框已经存在且没在焦点上时补一下。
		 * @returns {void}
		 */
		function refocusComposer() {
			if (typeof document === "undefined") return;
			const box = document.querySelector("[data-composer-input]");
			if (box === null || typeof box.focus !== "function") return;
			if (document.activeElement === box) return;
			box.focus();
		}

		/**
		 * keydown 处理：命中条件全部满足时接管，否则放行。
		 * @param {KeyboardEvent} ev keydown 事件。
		 * @returns {void}
		 */
		function onKeyDown(ev) {
			if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
			if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return last();
			if (ev.isComposing === true) return last("composing");
			const editable = composerOf(ev.target);
			if (editable === null) return last("not-composer");
			if (!composerFree(editable)) return last("busy");
			ensureSession();
			if (current.history.length === 0) return last("no-history");

			// 浏览态里 ↑↓ 翻动；手改草稿由 dock 渲染侦测兜底退出。
			if (current.cursor >= 0) {
				const next = ev.key === "ArrowUp" ? current.cursor + 1 : current.cursor - 1;
				if (browse(next)) {
					ev.preventDefault();
					ev.stopPropagation();
				}
				return last("browsing");
			}

			if (ev.key === "ArrowDown") {
				// 空草稿按 ↓：已在最新一条之外，本来就没得走，吞掉这键。
				if (draftIsEmpty()) {
					ev.preventDefault();
					ev.stopPropagation();
				}
				return last("down-idle");
			}

			// 未在浏览态：草稿为空时直接进历史（最常用的那条路，不做任何光标测量）；
			// 草稿非空时只有光标已在首行行首才进——否则 ↑ 仍是移动光标。
			if (!draftIsEmpty() && !caretAtFirstLine(editable)) return last("caret-mid-draft");
			if (browse(0)) {
				ev.preventDefault();
				ev.stopPropagation();
				return last("entered");
			}
			return last("set-draft-failed");
		}

		/**
		 * 记下判定结果（排查用），本身返回 undefined 方便 return last(...)。
		 * @param {string} [reason] 判定说明。
		 * @returns {void}
		 */
		function last(reason) {
			lastReason = reason ?? "handled";
		}

		/**
		 * 事件目标所在的输入框元素。
		 * @param {EventTarget | null} target keydown 的目标。
		 * @returns {HTMLElement | null} 输入框元素，不是输入框时 null。
		 */
		function composerOf(target) {
			if (!isComposerTarget(target)) return null;
			const el = /** @type {HTMLElement} */ (target);
			return /** @type {HTMLElement} */ (el.closest("[contenteditable]"));
		}

		/**
		 * 草稿是否可当作空（只有空白也算空：不挡住 ↑）。
		 * @returns {boolean} true 表示空。
		 */
		function draftIsEmpty() {
			return typeof current.draft !== "string" || current.draft.trim() === "";
		}

		/** 安装全局 keydown 捕获；重复调用无副作用。 */
		function installKeydown() {
			if (keyInstalled) return;
			const host = typeof window === "undefined" ? null : window;
			if (host === null || typeof host.addEventListener !== "function") return;
			keyInstalled = true;
			// window 捕获是最早的一跳：先于 document 与 React 根容器上的处理器。
			host.addEventListener("keydown", onKeyDown, true);
		}

		/** 卸载 keydown 捕获。 */
		function uninstallKeydown() {
			if (!keyInstalled) return;
			keyInstalled = false;
			const host = typeof window === "undefined" ? null : window;
			if (host !== null && typeof host.removeEventListener === "function") host.removeEventListener("keydown", onKeyDown, true);
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

		// #region dock 组件
		/**
		 * 数据面组件：不画任何东西，只在渲染时发布输入面、维护历史快照、侦测
		 * 草稿被手改后退出浏览态。
		 * @param {object} props slot 标准 props。
		 * @returns {null} 永远不渲染。
		 */
		function HistoryDock(props) {
			const { sessionId, inputActions, useInput, useConversation, useSession } = props;
			current.sessionId = sessionId;
			if (inputActions !== undefined) current.inputActions = inputActions;
			const state = typeof useInput === "function" ? useInput((s) => s) : undefined;
			const draft = state && typeof state === "object" ? state.draft : "";
			const phase = state && typeof state === "object" ? state.phase : "plain";
			const editing = draft !== current.draft;
			current.draft = typeof draft === "string" ? draft : "";
			current.phase = typeof phase === "string" ? phase : "plain";
			// 草稿和当前浏览的消息不一样了，说明用户改了字：退出浏览态（下次 ↑ 重新
			// 进入，savedDraft 已被重置清空，不会把旧草稿还回来）。
			if (current.cursor >= 0 && editing && current.draft !== current.history[current.cursor]) resetBrowsing();

			// 换会话先作废浏览态与旧历史；灌入前用 useSession 的权威 sessionId 复核
			// 快照归属——换会话的过渡帧里 useConversation 给的可能还是上一个会话的
			// 窗口，绝不能让它冒充新会话的历史。
			ensureSession();
			const sessionSnap = typeof useSession === "function" ? useSession((s) => (s && typeof s === "object" ? s.sessionId : undefined)) : undefined;
			const sessionMatches = sessionSnap === undefined || sessionSnap === sessionId;
			const chat = typeof useConversation === "function" ? useConversation((c) => (c && c.views ? c.views.get("chat") : undefined)) : undefined;
			if (sessionMatches) syncHistory(extractHistory(chat));
			else current.history = [];

			return null;
		}
		// #endregion

		// #region 插件体
		/** 依赖的客户端服务。 */
		const inject = ["slots"];

		/**
		 * 客户端插件体：注册数据面组件，安装全局按键接管。
		 * @param {object} ctx 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.input.dock",
						id: "dsh-input-history",
						order: 50,
					},
					HistoryDock,
				),
			);

			installKeydown();
			ctx.effect(() => () => uninstallKeydown(), "dsh-input-history: keydown listener");

			// 给 host 半打一张卡：服务端能据此确认浏览器半真的跑起来了。
			try {
				void fetch("/plugin/dsh-input-history/health?client=1", { cache: "no-store" }).catch(() => {});
			} catch {
				/* 非浏览器环境或路由缺失时静默 */
			}

			// 排查入口：控制台里 __dshInputHistory.state 看历史条数/游标，
			// __dshInputHistory.reason() 看最近一次按键为什么被放行。
			if (typeof window !== "undefined") {
				window.__dshInputHistory = {
					state: current,
					reason: () => lastReason,
					probe: () => ({
						history: current.history.length,
						cursor: current.cursor,
						draft: current.draft,
						composer: typeof document === "undefined" ? 0 : document.querySelectorAll("[data-composer-input]").length,
					}),
				};
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
			lineRects,
			composerFree,
			browse,
			onKeyDown,
			installKeydown,
			uninstallKeydown,
			syncHistory,
			state: current,
			resetBrowsing,
			reason: () => lastReason,
		};
		return module.exports;
	},
});
