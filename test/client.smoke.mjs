/**
 * 浏览器半的冒烟测试：不依赖真浏览器，只验证
 *   1. bundle 用的是 __ModuleLoader__.load({id, factory}) 契约；
 *   2. factory 只 require("react")，别无可疑依赖；
 *   3. apply() 能对着最小 ctx 跑通（文案注册 + dock 注册 + 按键安装）；
 *   4. 历史提取：只认 user/steering 的 text 块，seq 去重、连发折叠、新→旧；
 *   5. 按键状态机：空草稿 + 光标边界进入浏览态，↑↓ 翻动，↓ 越界还原暂存草稿；
 *   6. 让路条件：非输入框目标、触发菜单开着、IME 组合、忙阶段、多行草稿中间。
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
/** keydown 监听器清单，installKeydown 后可手动派发。 */
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
    getClientRects: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    classList: {
      set: new Set(),
      contains(name) { return this.set.has(name); },
      add(name) { this.set.add(name); },
      remove(name) { this.set.delete(name); },
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

/** 造一个输入框元素桩：contenteditable + composer 样式类 + 两行文本矩形。 */
function composerNode() {
  const el = node('div');
  el.setAttribute('contenteditable', 'true');
  el.classList.add('uV2eYG_input');
  // 两行文本的首行/末行矩形，行高 20：首行 top 10，末行 top 50。
  el.getClientRects = () => [
    { top: 10, left: 20, right: 400, bottom: 30, width: 380, height: 20 },
    { top: 50, left: 20, right: 400, bottom: 70, width: 380, height: 20 },
  ];
  return el;
}

/** 造一个选区桩：光标在给定行边界。 */
function selectionStub({ collapsed = true, firstLine = false, lastLine = false } = {}) {
  return {
    rangeCount: 1,
    isCollapsed: collapsed,
    getRangeAt() {
      return {
        cloneRange() {
          return {
            collapse() {},
            getClientRects: () => [{ top: firstLine ? 10 : 50, left: 20, right: 60, bottom: 30, width: 40, height: 20 }],
            getBoundingClientRect: () => ({ top: firstLine ? 10 : 50, left: 20, right: firstLine ? 20 : 60, bottom: 30, width: firstLine ? 0 : 40, height: 20 }),
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
  createRange() {
    return {
      selectNodeContents() {},
      setEnd() {},
      getBoundingClientRect: () => ({ top: 50, left: 20, right: 60, bottom: 30, width: 40, height: 20 }),
    };
  },
};

const windowStub = {
  setTimeout,
  clearTimeout,
  addEventListener() {},
  removeEventListener() {},
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
assert.equal(Array.from(mod.inject).join(','), 'slots,locale', 'inject 必须是 slots + locale');

const dictionaries = [];
const slots = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
    return () => (typeof dispose === 'function' ? dispose() : undefined);
  },
  locale: {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts });
      return () => {};
    },
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
assert.equal(dictionaries.length, 1, '应注册一份文案');
assert.equal(dictionaries[0].ns, 'dshInputHistory');
assert.ok(dictionaries[0].dicts.zh && dictionaries[0].dicts.en, '中英文案都要有');
assert.equal(slots.length, 1, '应注册一个 slot');
assert.equal(slots[0].spec.name, 'conversation.input.dock');
assert.equal(slots[0].spec.order, 50);
assert.equal(keydownListeners.length, 1, '应安装一个 keydown 监听');

const { __internals: api } = mod;

// ---- 按键状态机 ----

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
  user(4, '第一问'),            // 与 seq1 同文本但隔着 steering：两次真实发送，都保留
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

// ---- dock 组件：发布输入面与历史 ----
const inputActions = {
  setDraft(text) { calls.push({ kind: 'setDraft', text }); },
  focus() {},
};
const calls = [];

let conversationValue = mixed;
const mountProps = {
  sessionId: 'session-1',
  inputActions,
  useInput: (selector) => selector({ draft: '', draftRev: 1, phase: 'plain' }),
  useConversation: (selector) => selector({ views: { get: (target) => (target === 'chat' ? conversationValue : undefined) } }),
  useSession: (selector) => selector({ sessionId: 'session-1' }),
  t: (key) => `t:${key}`,
};

// 空会话当帧就挂载：快照归属由 useSession 复核，空会话不渲染提示条。
const hidden = slots[0].component({ ...mountProps, sessionId: 'empty-session' });
assert.equal(hidden, null, '无历史时不渲染提示条');
assert.equal(api.state.history.length, 0, '空会话历史为空');

// 回到有历史的会话。
const tree = slots[0].component({ ...mountProps });
assert.equal(tree.type, 'div');
assert.equal(tree.props.className, 'dshhist-dock');
assert.equal(api.state.sessionId, 'session-1');
assert.equal(api.state.history.length, 4, 'dock 渲染时同步历史（含隔着 steering 的两次第一问）');
assert.equal(api.state.phase, 'plain');

// 过渡帧：sessionId 已切到新会话，而 useConversation 仍给着旧会话的窗口——
// 绝不能把旧会话的消息灌成新会话的历史。
const staleTree = slots[0].component({
  ...mountProps,
  sessionId: 'session-2',
  useSession: (selector) => selector({ sessionId: 'session-1' }),
});
assert.equal(staleTree, null, '过渡帧不渲染提示条');
assert.equal(api.state.history.length, 0, '过渡帧不灌入旧会话快照');

// 新会话自己的快照跟上后正常灌入。
const tree2 = slots[0].component({
  ...mountProps,
  sessionId: 'session-2',
  useSession: (selector) => selector({ sessionId: 'session-2' }),
  useConversation: (selector) => selector({ views: { get: (t) => (t === 'chat' ? { legacy: { nodes: [user(1, '另一个会话的话')] } } : undefined) } }),
});
assert.equal(tree2.type, 'div');
assert.deepEqual(Array.from(api.state.history), ['另一个会话的话'], '归属校验通过后灌入本会话历史');

// 回到主会话继续按键场景测试。
resetBrowsingState();
const mainTree = slots[0].component({ ...mountProps });
assert.equal(mainTree.type, 'div', '回切主会话渲染提示条');
assert.equal(api.state.history.length, 4, '回切主会话恢复完整历史');

/** 派发一次 keydown。 */
function press(key, target, init = {}) {
  return { key, target, altKey: false, ctrlKey: false, metaKey: false, preventDefault() { this.defaulted = true; }, ...init };
}

/** 清空内部浏览态与已记录的 setDraft 调用，供场景切换用。 */
function resetBrowsingState() {
  api.state.cursor = -1;
  api.state.savedDraft = '';
  calls.length = 0;
}

const composer = composerNode();

// 让路：非输入框目标。
currentSelection = selectionStub({ firstLine: true });
let ev = press('ArrowUp', node('div'));
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '非输入框不接管');
assert.equal(api.state.cursor, -1);

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

// 让路：光标不在首行（多行草稿中间——这里草稿为空但矩形声明非首行）。
currentSelection = selectionStub({ firstLine: false });
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(!ev.defaulted, '光标不在首行不接管');

// 进入浏览态：空草稿 + 光标在首行。
currentSelection = selectionStub({ firstLine: true });
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(ev.defaulted, '进入浏览态要吞掉按键');
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

// 带暂存草稿的还原：正在写一半的话，↑ 直接进入浏览态（暂存草稿），↓ 越界还原。
calls.length = 0;
slots[0].component({ ...mountProps, useInput: (selector) => selector({ draft: '我正在打一半的话', draftRev: 2, phase: 'plain' }) });
assert.equal(api.state.cursor, -1, '草稿非空渲染后仍是未浏览');
currentSelection = selectionStub({ firstLine: true });
ev = press('ArrowUp', composer);
keydownListeners[0](ev);
assert.ok(ev.defaulted);
assert.equal(api.state.savedDraft, '我正在打一半的话', '进入浏览态前暂存草稿');
// 翻到最旧（4 条历史：0..3，两次 ↑ 到 2），再 ↓ 两次越过边界 → 还原暂存草稿。
ev = press('ArrowUp', composer); keydownListeners[0](ev);
ev = press('ArrowUp', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, 2);
assert.equal(calls.at(-1).text, '补充一句', '最旧一条是补充一句');
ev = press('ArrowDown', composer); keydownListeners[0](ev);
ev = press('ArrowDown', composer); keydownListeners[0](ev);
ev = press('ArrowDown', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, -1);
assert.equal(calls.at(-1).text, '我正在打一半的话', '越界还原暂存草稿');

// 浏览态中手改字 → 退出浏览态。
calls.length = 0;
slots[0].component({ ...mountProps, useInput: (selector) => selector({ draft: '', draftRev: 4, phase: 'plain' }) });
currentSelection = selectionStub({ firstLine: true });
ev = press('ArrowUp', composer); keydownListeners[0](ev);
assert.equal(api.state.cursor, 0);
slots[0].component({ ...mountProps, useInput: (selector) => selector({ draft: '第二问改', draftRev: 5, phase: 'plain' }) });
assert.equal(api.state.cursor, -1, '手改字退出浏览态');

// 换会话清历史与浏览态（快照随会话一起换，等价于真实挂载顺序）。
slots[0].component({ ...mountProps, sessionId: 'session-2', useInput: (selector) => selector({ draft: '', draftRev: 6, phase: 'plain' }) });
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

// 卸载不应抛错。
api.uninstallKeydown();
assert.equal(keydownListeners.length, 0, '卸载移除监听');

console.log('client smoke: ok');
