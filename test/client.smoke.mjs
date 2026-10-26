/**
 * 浏览器半的冒烟测试：不依赖真浏览器，只验证
 *   1. bundle 用的是 __ModuleLoader__.load({id, factory}) 契约；
 *   2. factory 只 require("react")，别无可疑依赖；
 *   3. apply() 能对着最小 ctx 跑通（dock 注册 + window 捕获安装），且不渲染任何界面；
 *   4. 历史提取：只认 user/steering 的 text 块，seq 去重、连发折叠、新→旧；
 *   5. 按键状态机：空草稿直接进入（不测量光标），↑↓ 翻动，↓ 越界还原暂存草稿；
 *   6. 让路条件：非输入框目标、触发菜单开着、IME 组合、忙阶段、草稿非空且光标不在首行行首；
 *   7. 回归：光标行判定必须用文本行矩形（Range），不能用元素的边框盒（含 padding）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'lib', 'client.js');
const source = fs.readFileSync(bundlePath, 'utf8');

/** 挂在 window 上的当前选区；用例按场景替换。 */
let currentSelection = null;
/** window 上的 keydown 监听器清单，installKeydown 后可手动派发。 */
const keydownListeners = [];

/**
 * 造一个够用的 DOM 节点桩。
 * @param {string} tag 标签名。
 * @param {Record<string, unknown>} [extra] 额外字段。
 * @returns {object} 节点桩。
 */
function node(tag, extra = {}) {
	return {
		tagName: String(tag).toUpperCase(),
		nodeType: 1,
		dataset: {},
		style: {},
		children: [],
		className: '',
		textContent: '',
		tabIndex: 0,
		lines: [],
		getClientRects: () => [],
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		classList: {
			set: new Set(),
			contains(name) { return this.set.has(name); },
			add(name) { this.set.add(name); },
			remove(name) { this.set.delete(name); },
			[Symbol.iterator]() { return this.set[Symbol.iterator](); },
		},
		attributes: new Map(),
		getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
		setAttribute(name, value) { this.attributes.set(name, String(value)); },
		hasAttribute(name) { return this.attributes.has(name); },
		toggleAttribute() {},
		removeAttribute(name) { this.attributes.delete(name); },
		append(...kids) { this.children.push(...kids); },
		appendChild(kid) { this.children.push(kid); return kid; },
		replaceChildren() { this.children = []; },
		remove() {},
		addEventListener() {},
		removeEventListener() {},
		focus() {},
		contains() { return false; },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		closest(selector) {
			// 桩上最近的可编辑祖先就是自己（测试里只对输入框元素派发按键）。
			if (selector === '[contenteditable]' && this.attributes.has('contenteditable')) return this;
			return null;
		},
		...extra,
	};
}

/**
 * 造一个输入框元素桩。
 * 关键：元素自身的 getClientRects 给的是**含 padding 的边框盒**（left 0），
 * 文本行矩形在 lines 里（left 14 = padding-left）；光标判定必须用后者。
 * @param {{multiLine?: boolean}} [options] 行数与形状。
 * @returns {object} 输入框桩。
 */
function composerNode({ multiLine = true } = {}) {
	const el = node('div');
	el.setAttribute('contenteditable', 'true');
	el.setAttribute('data-composer-input', '');
	// 元素边框盒：left 0、宽 400、高 40（padding 14 在左侧）。
	el.getClientRects = () => [{ top: 0, left: 0, right: 400, bottom: 40, width: 400, height: 40 }];
	// 文本行：行高 20，首行 top 10、左 14；第二行 top 30。
	el.lines = multiLine
		? [
			{ top: 10, left: 14, right: 300, bottom: 30, width: 286, height: 20 },
			{ top: 30, left: 14, right: 300, bottom: 50, width: 286, height: 20 },
		]
		: [{ top: 10, left: 14, right: 300, bottom: 30, width: 286, height: 20 }];
	return el;
}

/**
 * 造一个选区桩：光标在给定位置。
 * @param {{collapsed?: boolean, top?: number, left?: number}} [options] 光标位置。
 * @returns {object} 选区桩。
 */
function selectionStub({ collapsed = true, top = 10, left = 14 } = {}) {
	const rect = { top, left, right: left + 1, bottom: top + 20, width: 1, height: 20 };
	return {
		rangeCount: 1,
		isCollapsed: collapsed,
		getRangeAt() {
			return {
				cloneRange() {
					return {
						collapse() {},
						getClientRects: () => [rect],
						getBoundingClientRect: () => rect,
					};
				},
				endContainer: node('p'),
				endOffset: 0,
			};
		},
	};
}

const documentStub = {
	head: node('head'),
	body: node('body'),
	createElement: (tag) => node(tag),
	querySelector: () => null,
	querySelectorAll: () => [],
	addEventListener(_type, fn) { if (_type === 'keydown') keydownListeners.push(fn); },
	removeEventListener(_type, fn) {
		const at = keydownListeners.indexOf(fn);
		if (at >= 0) keydownListeners.splice(at, 1);
	},
	/** Range 桩：selectNodeContents 记下目标，行矩形从目标的 lines 取。 */
	createRange() {
		return {
			target: null,
			selectNodeContents(target) { this.target = target; },
			setEnd() {},
			getClientRects() { return this.target === null ? [] : this.target.lines; },
			getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
		};
	},
};

const windowStub = {
	setTimeout,
	clearTimeout,
	addEventListener(_type, fn) { if (_type === 'keydown') keydownListeners.push(fn); },
	removeEventListener(_type, fn) {
		const at = keydownListeners.indexOf(fn);
		if (at >= 0) keydownListeners.splice(at, 1);
	},
	getSelection: () => currentSelection,
	innerWidth: 1440,
	innerHeight: 900,
};

let loadedId;
let factory;
windowStub.__ModuleLoader__ = {
	load(entry) { loadedId = entry.id; factory = entry.factory; },
};

const sandbox = { window: windowStub, document: documentStub, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.equal(loadedId, 'dsh-input-history', 'bundle 必须以插件包名注册');
assert.equal(typeof factory, 'function', 'factory 必须是函数');

const ReactStub = {
	createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
};
const required = [];
const requireStub = (id) => {
	required.push(id);
	if (id === 'react') return ReactStub;
	throw new Error(`unexpected require: ${id}`);
};

const mod = factory(requireStub);
assert.deepEqual(required, ['react'], '除 react 外不应 require 其他模块');
assert.equal(typeof mod.apply, 'function', '必须导出 apply');
assert.equal(Array.from(mod.inject).join(','), 'slots', 'inject 只需 slots（界面全无、不用文案）');

const slots = [];
const effects = [];
const ctx = {
	effect(fn, label) {
		const dispose = fn();
		effects.push({ label, dispose });
		return () => (typeof dispose === 'function' ? dispose() : undefined);
	},
	slots: {
		inject(name, fn) { fn(); },
		register(spec, component) {
			slots.push({ spec, component });
			return () => {};
		},
	},
};

mod.apply(ctx);
assert.equal(slots.length, 1, '应注册一个 slot');
assert.equal(slots[0].spec.name, 'conversation.input.dock');
assert.equal(slots[0].spec.order, 50);
assert.equal(keydownListeners.length, 1, '应安装一个 keydown 监听（window 捕获）');
assert.equal(documentStub.head.children.length, 0, '不再注入任何样式');
assert.ok(windowStub.__dshInputHistory, '暴露排查入口');

const { __internals: api } = mod;

// ---- 历史提取 ----
const user = (seq, text) => ({ kind: 'user', seq, content: [{ type: 'text', text }] });
const steering = (seq, text) => ({ kind: 'steering', seq, content: [{ type: 'text', text }] });

const emptyChat = { legacy: { nodes: [] } };
assert.deepEqual(Array.from(api.extractHistory(emptyChat)), [], '空视图没有历史');
assert.deepEqual(Array.from(api.extractHistory(undefined)), [], 'undefined 安全');
assert.deepEqual(Array.from(api.extractHistory({ legacy: { nodes: [
	{ kind: 'assistant', seq: 3, content: [{ type: 'text', text: '回复' }] },
	{ kind: 'context', seq: 4, content: [{ type: 'text', text: '注入' }] },
] } })), [], 'assistant/context 不进历史');

const mixed = { legacy: { nodes: [
	user(1, '第一问'),
	{ kind: 'assistant', seq: 2, content: [{ type: 'text', text: '答复' }] },
	steering(3, '补充一句'),
	user(4, '第一问'), // 与 seq1 同文本但隔着 steering：两次真实发送，都保留
	{ kind: 'user', seq: 5, content: [{ type: 'text', text: '带图' }, { type: 'text', text: '第二问' }] },
	{ kind: 'user', seq: 6, content: [{ type: 'reasoning', text: 'x' }] }, // 无 text 块：跳过
] } };
const history = api.extractHistory(mixed);
assert.deepEqual(Array.from(history), ['带图\n第二问', '第一问', '补充一句', '第一问'], '新→旧；text 块拼接；隔着别的消息的同文不折叠');

// 紧挨着的同文（重试、重复物化）只留一条。
const retried = api.extractHistory({ legacy: { nodes: [user(1, '重试的话'), user(2, '重试的话')] } });
assert.deepEqual(Array.from(retried), ['重试的话'], '相邻同文折叠');

// 同 seq 覆盖（物化更新）取最后一次。
const updated = api.extractHistory({ legacy: { nodes: [user(1, '旧'), user(1, '新')] } });
assert.deepEqual(Array.from(updated), ['新'], '同 seq 以最新物化为准');

// ---- 数据面组件：发布输入面与历史，但永不渲染 ----
const calls = [];
const inputActions = {
	setDraft(text) { calls.push({ kind: 'setDraft', text }); },
	focus() {},
};

let conversationValue = mixed;
const mountProps = {
	sessionId: 'session-1',
	inputActions,
	useInput: (selector) => selector({ draft: '', draftRev: 1, phase: 'plain' }),
	useConversation: (selector) => selector({ views: { get: (target) => (target === 'chat' ? conversationValue : undefined) } }),
	useSession: (selector) => selector({ sessionId: 'session-1' }),
};

// 空会话当帧就挂载：快照归属由 useSession 复核。
const hidden = slots[0].component({ ...mountProps, sessionId: 'empty-session' });
assert.equal(hidden, null, '空会话不渲染');
assert.equal(api.state.history.length, 0, '空会话历史为空');

// 回到有历史的会话。
assert.equal(slots[0].component({ ...mountProps }), null, '有历史也不渲染（本插件没有任何界面）');
assert.equal(api.state.sessionId, 'session-1');
assert.equal(api.state.history.length, 4, '渲染时同步历史（含隔着 steering 的两次第一问）');
assert.equal(api.state.phase, 'plain');

// 过渡帧：sessionId 已切到新会话，而 useConversation 仍给着旧会话的窗口——
// 绝不能把旧会话的消息灌成新会话的历史。
slots[0].component({
	...mountProps,
	sessionId: 'session-2',
	useSession: (selector) => selector({ sessionId: 'session-1' }),
});
assert.equal(api.state.history.length, 0, '过渡帧不灌入旧会话快照');

// 新会话自己的快照跟上后正常灌入。
slots[0].component({
	...mountProps,
	sessionId: 'session-2',
	useSession: (selector) => selector({ sessionId: 'session-2' }),
	useConversation: (selector) => selector({ views: { get: (t) => (t === 'chat' ? { legacy: { nodes: [user(1, '另一个会话的话')] } } : undefined) } }),
});
assert.deepEqual(Array.from(api.state.history), ['另一个会话的话'], '归属校验通过后灌入本会话历史');

// ---- 按键状态机 ----
/** 清空内部浏览态与已记录的 setDraft 调用，供场景切换用。 */
function resetBrowsingState() {
	api.state.cursor = -1;
	api.state.savedDraft = '';
	calls.length = 0;
}

/**
 * 派发一次 keydown。
 * @param {string} key 键名。
 * @param {object} target 事件目标。
 * @param {Record<string, unknown>} [init] 事件字段覆盖。
 * @returns {object} 事件桩（吞键后 defaulted 为 true）。
 */
function press(key, target, init = {}) {
	return {
		key,
		target,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		preventDefault() { this.defaulted = true; },
		stopPropagation() { this.stopped = true; },
		...init,
	};
}

/** 让草稿为指定值（模拟一次渲染）。 */
function setDraft(value, extra = {}) {
	return slots[0].component({ ...mountProps, useInput: (selector) => selector({ draft: value, draftRev: 1, phase: 'plain', ...extra }) });
}

resetBrowsingState();
setDraft('');
// 回切主会话：会话 id 变了要重新灌历史。
slots[0].component({ ...mountProps });
assert.equal(api.state.history.length, 4, '回切主会话恢复完整历史');

const composer = composerNode();

// 让路：非输入框目标。
currentSelection = selectionStub();
let ev = press('ArrowUp', node('div'));
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '非输入框不接管');
assert.equal(api.state.cursor, -1);

// 让路：带修饰键。
ev = press('ArrowUp', composer, { ctrlKey: true });
keydownListeners[0](ev);
assert.ok(!ev.defaulted, 'Ctrl+↑ 不接管');

// 让路：触发菜单开着。
documentStub.querySelector = () => ({});
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '触发菜单开着不接管');
documentStub.querySelector = () => null;

// 让路：IME 组合中。
composer.setAttribute('data-composer-composing', '');
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(!ev.defaulted, 'IME 组合中不接管');
composer.removeAttribute('data-composer-composing');

// 让路：忙阶段。
api.state.phase = 'submitting';
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '提交中不接管');
api.state.phase = 'plain';

// ---- 回归：空草稿直接进入，不做光标测量 ----
setDraft('');
currentSelection = selectionStub({ top: 30 }); // 光标在第 2 行，也不该拦
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(ev.defaulted, '空草稿按 ↑ 必须进入浏览态（不看光标在哪一行）');
assert.equal(api.state.cursor, 0, 'cursor 指向最新一条');
assert.equal(calls.at(-1).text, '带图\n第二问');

// ↑ 继续翻旧。
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.equal(api.state.cursor, 1);
assert.equal(calls.at(-1).text, '第一问');

// ↓ 往回走。
ev = press('ArrowDown', composer);
keydownListeners[0](ev);
assert.equal(api.state.cursor, 0, '↓ 回到较新一条');

// ↓ 越过最新：还原进入前的草稿（进入时草稿为空）。
ev = press('ArrowDown', composer);
keydownListeners[0](ev);
assert.ok(ev.defaulted);
assert.equal(api.state.cursor, -1, '越过最新退出浏览态');
assert.equal(calls.at(-1).text, '', '空草稿还原为空');

// 未在浏览态、空草稿按 ↓：吞键但不改草稿。
calls.length = 0;
ev = press('ArrowDown', composer);
keydownListeners[0](ev);
assert.ok(ev.defaulted, '空草稿按 ↓ 吞键');
assert.equal(calls.length, 0, '↓ 不该写草稿');

// ---- 回归：带 padding 的输入框里光标行判定（真实 bug 的复现点）----
// 元素边框盒 left 是 0，文本行 left 是 14（padding），光标 left 是 14：
// 旧的「拿元素矩形比」永远判定失败，导致 ↑ 完全没反应。
setDraft('我正在打一半的话');
currentSelection = selectionStub({ top: 10, left: 14 });
assert.equal(api.caretAtFirstLine(composer), true, '光标在首行行首（padding 14 处）应判定为真');
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(ev.defaulted, '草稿非空但光标在首行行首：↑ 进历史');
assert.equal(api.state.savedDraft, '我正在打一半的话', '进入浏览态前暂存草稿');

// 翻到最旧（4 条历史：0..3），再 ↑ 停住，再 ↓ 越过边界 → 还原暂存草稿。
ev = press('ArrowUp', composer); keydownListeners[0](ev);
ev = press('ArrowUp', composer); keydownListeners[0](ev);
ev = press('ArrowUp', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, 3);
assert.equal(calls.at(-1).text, '第一问', '最旧一条是第一次发的第一问');
// 最旧一条再按 ↑：停住，绝不能当成越界去还原草稿。
const beforeOldest = calls.length;
ev = press('ArrowUp', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, 3, '↑ 翻到头就停住');
assert.equal(calls.length, beforeOldest, '翻到头不该写草稿');
assert.ok(!ev.defaulted, '翻到头不吞键（让光标自己动）');
ev = press('ArrowDown', composer); keydownListeners[0](ev);
ev = press('ArrowDown', composer); keydownListeners[0](ev);
ev = press('ArrowDown', composer); keydownListeners[0](ev);
ev = press('ArrowDown', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, -1);
assert.equal(calls.at(-1).text, '我正在打一半的话', '越界还原暂存草稿');

// 草稿非空 + 光标不在首行 → 让路（↑ 仍是移动光标）。
resetBrowsingState();
setDraft('第一行\n第二行');
currentSelection = selectionStub({ top: 30, left: 14 });
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '光标在第二行时 ↑ 不接管');
assert.equal(api.state.cursor, -1);

// 草稿非空 + 光标在首行但已往右挪 → 让路（在改这条草稿）。
currentSelection = selectionStub({ top: 10, left: 120 });
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '首行中间时不接管');

// 量不出光标（空行没有矩形）→ 放行进入，绝不制造死键。
currentSelection = { rangeCount: 0, isCollapsed: true, getRangeAt() { return null; } };
assert.equal(api.caretAtFirstLine(composer), true, '量不到光标时按可接管处理');

// ---- 浏览态中手改字 → 退出浏览态 ----
resetBrowsingState();
setDraft('');
slots[0].component({ ...mountProps });
currentSelection = selectionStub();
ev = press('ArrowUp', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, 0);
setDraft('第二问改');
assert.equal(api.state.cursor, -1, '手改字退出浏览态');

// ---- 旧版 DSH 兜底：没有 data-composer-input，靠 composer 输入类名识别 ----
const legacyComposer = composerNode({ multiLine: false });
legacyComposer.removeAttribute('data-composer-input');
legacyComposer.classList.add('uV2eYG_input');
assert.equal(api.isComposerTarget(legacyComposer), true, '类名兜底可用');
assert.equal(api.isComposerTarget(node('div')), false, '普通节点不算输入框');

// ---- 换会话清历史与浏览态 ----
slots[0].component({ ...mountProps, sessionId: 'session-2' });
assert.equal(api.state.history.length, 0, '换会话先清空，等新快照');
assert.equal(api.extractHistory(conversationValue).length, 4, '同一份视图重新可提取');

// 无 useConversation 的宿主：渲染不抛错。
const bare = slots[0].component({
	sessionId: 'session-3',
	inputActions,
	useInput: (selector) => selector({ draft: '', draftRev: 7, phase: 'plain' }),
	useSession: (selector) => selector({ sessionId: 'session-3' }),
});
assert.equal(bare, null);

// 排查入口可用。
assert.equal(typeof windowStub.__dshInputHistory.probe, 'function');
assert.equal(typeof windowStub.__dshInputHistory.reason, 'function');

// 卸载不应抛错，且把监听摘掉。
api.uninstallKeydown();
assert.equal(keydownListeners.length, 0, '卸载移除监听');

console.log('client smoke: ok');
