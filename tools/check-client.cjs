#!/usr/bin/env node
'use strict';
/* tools/check-client.cjs — lib/client.js 的离线契约 + 状态机验证（零依赖，Node CJS）。
 *
 * 不加载任何宿主文件：用 vm.Script 执行 lib/client.js，注入假的 window.__ModuleLoader__、
 * 极简 React 假实现（createElement + useState/useEffect/useRef/useCallback 的真实假钩子运行时）、
 * 假 fetch（内存版 Obsidian 宿主 API，按 SPEC §5 的响应形状）与假 ctx（记录 slots 注册）。
 *
 * 验证内容：
 *  A. 静态契约：只 require('react')、无 ESM 语句、只用允许的 hooks、无 CSS/style 标签、
 *     不引用未声明的 ctx 服务、必需 data-obsidian-* 属性出现在源码里。
 *  B. 模块契约：loader 调用一次且 id 正确；exports.apply / exports.inject === ['slots']。
 *  C. 注册契约：apply 通过 slots.inject 注册 sidebar.panellist（id/order/label）与 main（key）。
 *  D. 渲染状态机：loading / 网络失败 error / 非 2xx error / 重试恢复 ready；
 *     并在 ready 后走一遍 编辑→保存、新建、二次确认移回收站、选中笔记、追加、搜索、今日日记、在 Obsidian 打开。
 *  E. 数据属性：三态与各交互态的渲染树里 data-obsidian-* 与 action 枚举齐全；每棵树都有面板根，无白屏。
 *  F. 网络纪律：所有请求 URL 都以 /dsh-obsidian/api 开头；整个过程无未捕获 rejection。
 *
 * 用法：node tools/check-client.cjs   （退出码 0 = 全部 PASS；1 = 有 FAIL）
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const CLIENT_PATH = path.join(REPO, 'lib', 'client.js');
const API_PREFIX = '/dsh-obsidian/api';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
	try {
		const value = fn();
		if (value instanceof Promise) throw new Error('同步 check 不允许返回 Promise，请用 checkAsync');
		passed += 1;
		console.log('PASS ' + name);
	} catch (error) {
		failed += 1;
		failures.push(name);
		console.log('FAIL ' + name);
		console.log('     ' + String((error && error.stack) || error).split('\n').join('\n     '));
	}
}

async function checkAsync(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log('PASS ' + name);
	} catch (error) {
		failed += 1;
		failures.push(name);
		console.log('FAIL ' + name);
		console.log('     ' + String((error && error.stack) || error).split('\n').join('\n     '));
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ════════════════════════════════════════════════════════════════════
   一、极简 React 假实现：createElement + 钩子运行时 + 递归渲染成可检查的树
   ════════════════════════════════════════════════════════════════════ */
const ELEMENT = Symbol.for('react.element');

function createReactStub() {
	const HOOKS = { runtime: null };
	const allowed = new Set();

	function activeRuntime() {
		if (HOOKS.runtime === null) throw new Error('非法 hook 调用：当前不在组件渲染过程中');
		return HOOKS.runtime;
	}

	const react = {
		createElement(type, config) {
			const props = {};
			let key = null;
			if (config && typeof config === 'object') {
				for (const name of Object.keys(config)) {
					if (name === 'key') key = config[name] == null ? null : String(config[name]);
					else props[name] = config[name];
				}
			}
			const children = Array.prototype.slice.call(arguments, 2);
			if (children.length === 1) props.children = children[0];
			else if (children.length > 1) props.children = children;
			return { $$typeof: ELEMENT, type, key, props };
		},
		useState(initial) {
			allowed.add('useState');
			const runtime = activeRuntime();
			const index = runtime.hookIndex++;
			if (!(index in runtime.states)) runtime.states[index] = typeof initial === 'function' ? initial() : initial;
			const setValue = (next) => {
				const previous = runtime.states[index];
				const value = typeof next === 'function' ? next(previous) : next;
				if (Object.is(value, previous)) return;
				runtime.states[index] = value;
				runtime.dirty = true;
			};
			return [runtime.states[index], setValue];
		},
		useEffect(effect, deps) {
			allowed.add('useEffect');
			const runtime = activeRuntime();
			const index = runtime.hookIndex++;
			const previous = runtime.effectDeps[index];
			let changed;
			if (previous === undefined) changed = true;
			else if (!Array.isArray(deps) || !Array.isArray(previous)) changed = true;
			else changed = deps.length !== previous.length || deps.some((dep, depIndex) => !Object.is(dep, previous[depIndex]));
			runtime.effectDeps[index] = Array.isArray(deps) ? deps.slice() : null;
			if (changed) runtime.pendingEffects.push({ index, effect });
		},
		useRef(initial) {
			allowed.add('useRef');
			const runtime = activeRuntime();
			const index = runtime.hookIndex++;
			if (!(index in runtime.refs)) runtime.refs[index] = { current: initial };
			return runtime.refs[index];
		},
		useCallback(callback) {
			allowed.add('useCallback');
			const runtime = activeRuntime();
			runtime.hookIndex += 1;
			return callback;
		}
	};

	return {
		react,
		allowedHooks: allowed,
		setActive(runtime) { HOOKS.runtime = runtime; }
	};
}

/* 把 createElement 结果渲染成可断言的普通树：
 *   { kind: 'host', tag, props（不含 children）, children: [...] }
 *   { kind: 'text', text }
 *   { kind: 'fragment', children }
 */
function renderNode(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return null;
	if (typeof node === 'string') return { kind: 'text', text: node };
	if (typeof node === 'number') return { kind: 'text', text: String(node) };
	if (Array.isArray(node)) {
		return { kind: 'fragment', children: node.map((child) => renderNode(child)).filter(Boolean) };
	}
	if (typeof node !== 'object' || !('$$typeof' in node)) return null;
	const type = node.type;
	const props = node.props || {};
	if (typeof type === 'function') return renderNode(type(props));
	const clean = {};
	for (const name of Object.keys(props)) {
		if (name === 'children') continue;
		clean[name] = props[name];
	}
	const rawChildren = props.children;
	const children = rawChildren === undefined ? [] : Array.isArray(rawChildren) ? rawChildren : [rawChildren];
	return { kind: 'host', tag: String(type), props: clean, children: children.map((child) => renderNode(child)).filter(Boolean) };
}

function createRuntime(reactApi) {
	const runtime = {
		hookIndex: 0,
		states: [],
		refs: [],
		effectDeps: [],
		effectCleanups: [],
		pendingEffects: [],
		effectErrors: [],
		dirty: false,
		component: null,
		props: null,
		lastTree: null
	};

	function renderPass() {
		runtime.hookIndex = 0;
		runtime.pendingEffects = [];
		runtime.dirty = false;
		reactApi.setActive(runtime);
		try {
			runtime.lastTree = renderNode(reactApi.react.createElement(runtime.component, runtime.props));
		} finally {
			reactApi.setActive(null);
		}
	}

	function executeEffects() {
		const queued = runtime.pendingEffects;
		runtime.pendingEffects = [];
		for (const item of queued) {
			const previousCleanup = runtime.effectCleanups[item.index];
			if (typeof previousCleanup === 'function') {
				runtime.effectCleanups[item.index] = null;
				try { previousCleanup(); } catch (error) { runtime.effectErrors.push(error); }
			}
			let cleanup = null;
			try {
				cleanup = item.effect();
			} catch (error) {
				runtime.effectErrors.push(error);
			}
			runtime.effectCleanups[item.index] = typeof cleanup === 'function' ? cleanup : null;
		}
	}

	async function flush() {
		for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
	}

	return {
		runtime,
		mount(component, props) {
			runtime.component = component;
			runtime.props = props || {};
			renderPass();
			return runtime.lastTree;
		},
		async settle(options) {
			const maxRenders = (options && options.maxRenders) || 40;
			executeEffects();
			for (let index = 0; index < maxRenders; index += 1) {
				await flush();
				if (runtime.effectErrors.length > 0) throw runtime.effectErrors[0];
				if (!runtime.dirty) return runtime.lastTree;
				renderPass();
				executeEffects();
			}
			throw new Error('面板状态未收敛（超过 ' + maxRenders + ' 次渲染），可能存在渲染内 setState 循环');
		}
	};
}

/* ── 树检查小工具 ─────────────────────────────────────────────────── */
function walk(tree, visit) {
	if (!tree) return;
	if (tree.kind === 'text') return;
	if (tree.kind === 'fragment') {
		for (const child of tree.children) walk(child, visit);
		return;
	}
	visit(tree);
	for (const child of tree.children) walk(child, visit);
}

function findAll(tree, predicate) {
	const found = [];
	walk(tree, (node) => {
		if (predicate(node)) found.push(node);
	});
	return found;
}

function propNodes(tree, name, value) {
	return findAll(tree, (node) => {
		if (!node.props || !Object.prototype.hasOwnProperty.call(node.props, name)) return false;
		if (value === undefined) return true;
		return node.props[name] === value;
	});
}

function buttonByAction(tree, action, extra) {
	const candidates = findAll(tree, (node) => node.tag === 'button' && node.props && node.props['data-obsidian-action'] === action);
	if (!extra) return candidates[0];
	return candidates.find((node) => Object.keys(extra).every((name) => node.props[name] === extra[name]));
}

function textContent(node) {
	if (!node) return '';
	if (node.kind === 'text') return node.text;
	if (node.kind === 'fragment') return node.children.map(textContent).join('');
	return node.children.map(textContent).join('');
}

function click(node) {
	assert.ok(node, '找不到要点击的节点');
	assert.equal(typeof node.props.onClick, 'function', '节点没有 onClick 处理器');
	return node.props.onClick();
}

function change(node, value) {
	assert.ok(node, '找不到要输入的节点');
	assert.equal(typeof node.props.onChange, 'function', '节点没有 onChange 处理器');
	return node.props.onChange({ currentTarget: { value }, target: { value } });
}

/* 查看器里的笔记路径在内部节点上（data-obsidian-note-path），不在查看器根节点。 */
function renderedNotePath(tree) {
	const viewer = propNodes(tree, 'data-obsidian-note')[0];
	if (!viewer) return undefined;
	const pathNode = propNodes(viewer, 'data-obsidian-note-path')[0];
	return pathNode ? pathNode.props['data-obsidian-note-path'] : undefined;
}

function collectDataProps(tree) {
	const names = new Set();
	const actions = new Set();
	walk(tree, (node) => {
		if (!node.props) return;
		for (const name of Object.keys(node.props)) {
			if (!name.startsWith('data-obsidian-')) continue;
			names.add(name);
			if (name === 'data-obsidian-action' && typeof node.props[name] === 'string') actions.add(node.props[name]);
		}
	});
	return { names, actions };
}

/* ════════════════════════════════════════════════════════════════════
   二、假宿主 API（内存 vault；响应形状严格按 SPEC §5）
   ════════════════════════════════════════════════════════════════════ */
function formatDate(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return year + '-' + month + '-' + day;
}

function createFakeHost() {
	const notes = new Map();

	function baseName(notePath) {
		const parts = String(notePath).split('/');
		return parts[parts.length - 1].replace(/\.md$/i, '');
	}

	function firstHeading(content) {
		const line = String(content || '').split('\n').find((entry) => /^#\s+/.test(entry));
		return line ? line.replace(/^#\s+/, '').trim() : '';
	}

	function makeNote(notePath, content, tags) {
		const text = typeof content === 'string' ? content : '';
		return {
			path: notePath,
			title: firstHeading(text) || baseName(notePath),
			frontmatter: {},
			frontmatterRaw: '',
			tags: Array.isArray(tags) ? tags.slice() : [],
			links: [],
			content: text,
			size: Buffer.byteLength(text, 'utf8'),
			mtime: Date.now(),
			truncated: false
		};
	}

	function normalizePath(raw) {
		let value = String(raw == null ? '' : raw).replace(/\\/g, '/').replace(/^\/+/, '');
		if (value.length === 0) return '';
		if (!/\.md$/i.test(value)) value += '.md';
		return value;
	}

	notes.set('欢迎.md', makeNote('欢迎.md', '# 欢迎\n\n这是欢迎笔记。', ['入门']));
	notes.set('01-笔记/第一条.md', makeNote('01-笔记/第一条.md', '# 第一条\n\n第一条笔记的内容。', ['工作']));
	notes.set('日记/2026-11-19.md', makeNote('日记/2026-11-19.md', '# 2026-11-19\n\n昨天的日记。', []));
	notes.set('首页.md', makeNote('首页.md', '# 首页\n\n仓库首页。', ['导航']));

	function treeEntries() {
		const names = Array.from(notes.keys()).sort();
		const folders = new Set();
		for (const name of names) {
			const parts = name.split('/');
			for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'));
		}
		const entries = [];
		for (const folder of Array.from(folders).sort()) {
			entries.push({ path: folder, name: folder.split('/').pop(), type: 'folder' });
		}
		for (const name of names) {
			const note = notes.get(name);
			entries.push({ path: name, name: name.split('/').pop(), type: 'note', size: note.size, mtime: note.mtime, title: note.title });
		}
		return entries;
	}

	function respond(payload, ok, status) {
		const code = typeof status === 'number' ? status : (ok ? 200 : 400);
		return Promise.resolve({ ok: Boolean(ok), status: code, json: () => Promise.resolve(payload) });
	}

	function fail(code, message, status) {
		return respond({ ok: false, error: { code, message } }, false, status);
	}

	const host = {
		vaultPath: 'C:\\Fake\\Obsidian Vault',
		failMode: 'ok', /* 'ok' | 'reject' | 'http-503' */
		statusAvailable: true,
		requests: [],
		fetch(url, options) {
			const method = options && typeof options.method === 'string' ? options.method.toUpperCase() : 'GET';
			const rawUrl = String(url);
			let parsed;
			try {
				parsed = new URL(rawUrl, 'http://127.0.0.1');
			} catch (error) {
				parsed = null;
			}
			const pathname = parsed ? parsed.pathname : rawUrl;
			let body = null;
			if (options && typeof options.body === 'string') {
				try { body = JSON.parse(options.body); } catch (error) { body = { __invalid: options.body }; }
			}
			host.requests.push({ url: rawUrl, method, pathname, search: parsed ? parsed.search : '', body });

			if (host.failMode === 'reject') return Promise.reject(new Error('模拟网络故障'));
			if (host.failMode === 'http-503') return fail('vault-unavailable', '仓库不可用（模拟）', 503);
			if (!pathname.startsWith(API_PREFIX)) return fail('not-found', '未知路由：' + pathname, 404);

			const route = pathname.slice(API_PREFIX.length) || '/';
			const query = parsed ? parsed.searchParams : new URLSearchParams('');

			if (method === 'GET' && route === '/health') {
				return respond({
					ok: true,
					vaultPath: host.vaultPath,
					toolsRegistered: ['obsidian_status', 'obsidian_list', 'obsidian_read', 'obsidian_search', 'obsidian_write', 'obsidian_manage', 'obsidian_daily', 'obsidian_tags', 'obsidian_links', 'obsidian_open'],
					version: '0.1.0'
				}, true, 200);
			}
			if (method === 'GET' && route === '/status') {
				if (!host.statusAvailable) {
					return respond({
						ok: true,
						available: false,
						vaultPath: null,
						name: '',
						noteCount: 0,
						folderCount: 0,
						totalBytes: 0,
						daily: { folder: '', format: 'YYYY-MM-DD', template: '' },
						obsidianConfig: { appJson: null, corePlugins: null, dailyNotes: null },
						error: { code: 'vault-unavailable', message: 'Obsidian vault 不可用：请设置插件配置 vaultPath 或环境变量 DSH_OBSIDIAN_VAULT。' }
					}, true, 200);
				}
				let totalBytes = 0;
				for (const note of notes.values()) totalBytes += note.size;
				return respond({
					ok: true,
					vaultPath: host.vaultPath,
					name: 'Obsidian Vault',
					noteCount: notes.size,
					folderCount: 2,
					totalBytes,
					daily: { folder: '日记', format: 'YYYY-MM-DD', template: '' },
					obsidianConfig: { appJson: {}, corePlugins: {}, dailyNotes: null }
				}, true, 200);
			}
			if (method === 'GET' && route === '/tree') {
				return respond({ ok: true, dir: '', entries: treeEntries(), truncated: false }, true, 200);
			}
			if (method === 'GET' && route === '/note') {
				const relPath = String(query.get('path') || '');
				if (!notes.has(relPath)) return fail('not-found', '笔记不存在：' + relPath, 404);
				return respond({ ok: true, note: notes.get(relPath) }, true, 200);
			}
			if (method === 'POST' && route === '/note') {
				const payload = body || {};
				const relPath = normalizePath(payload.path);
				if (!relPath) return fail('invalid-path', '路径不能为空', 400);
				const mode = typeof payload.mode === 'string' ? payload.mode : 'create';
				if (mode === 'create') {
					if (notes.has(relPath)) return fail('exists', '文件已存在：' + relPath, 409);
					const note = makeNote(relPath, payload.content, payload.tags);
					notes.set(relPath, note);
					return respond({ ok: true, result: { path: relPath, mode, created: true, bytes: note.size, backupPath: null } }, true, 200);
				}
				if (!notes.has(relPath)) return fail('not-found', '笔记不存在：' + relPath, 404);
				const existing = notes.get(relPath);
				let nextContent;
				if (mode === 'append') nextContent = existing.content + String(payload.content || '');
				else if (mode === 'prepend') nextContent = String(payload.content || '') + existing.content;
				else nextContent = String(payload.content == null ? '' : payload.content);
				const nextTags = payload.tags === undefined ? existing.tags : payload.tags;
				const note = makeNote(relPath, nextContent, nextTags);
				notes.set(relPath, note);
				return respond({ ok: true, result: { path: relPath, mode, created: false, bytes: note.size, backupPath: null } }, true, 200);
			}
			if (method === 'GET' && route === '/search') {
				const rawQuery = String(query.get('q') || '');
				const needle = rawQuery.toLowerCase();
				const limit = Number(query.get('limit') || 50);
				const results = [];
				for (const [notePath, note] of notes) {
					if (needle.length === 0) continue;
					const titleHit = String(note.title || '').toLowerCase().indexOf(needle) >= 0;
					const contentHit = String(note.content || '').toLowerCase().indexOf(needle) >= 0;
					if (!titleHit && !contentHit) continue;
					results.push({
						path: notePath,
						title: note.title,
						line: contentHit ? 2 : 1,
						snippet: '…' + rawQuery + '…',
						score: titleHit ? 100 : 40,
						matched: titleHit ? 'title' : 'content'
					});
				}
				return respond({ ok: true, total: results.length, truncated: false, results: results.slice(0, limit) }, true, 200);
			}
			if (method === 'POST' && route === '/manage') {
				const payload = body || {};
				const relPath = normalizePath(payload.path);
				if (payload.action === 'trash') {
					if (!notes.has(relPath)) return fail('not-found', '笔记不存在：' + relPath, 404);
					notes.delete(relPath);
					return respond({ ok: true, result: { action: 'trash', path: relPath, trashPath: '.trash/' + Date.now() + '-' + relPath.split('/').pop(), hard: Boolean(payload.hard) } }, true, 200);
				}
				if (payload.action === 'move') {
					const to = normalizePath(payload.to);
					if (!notes.has(relPath)) return fail('not-found', '笔记不存在：' + relPath, 404);
					if (notes.has(to) && payload.overwrite !== true) return fail('exists', '目标已存在：' + to, 409);
					const note = notes.get(relPath);
					notes.delete(relPath);
					note.path = to;
					notes.set(to, note);
					return respond({ ok: true, result: { action: 'move', from: relPath, to } }, true, 200);
				}
				return fail('bad-request', '未知 manage 动作', 400);
			}
			if (route === '/daily') {
				const date = formatDate(new Date());
				const dailyPath = '日记/' + date + '.md';
				if (method === 'GET') {
					const note = notes.get(dailyPath);
					return respond({
						ok: true,
						daily: { path: dailyPath, date, created: false, content: note ? note.content : '', appended: false, bytes: note ? note.size : 0 }
					}, true, 200);
				}
				if (method === 'POST') {
					const payload = body || {};
					const created = !notes.has(dailyPath);
					if (created) notes.set(dailyPath, makeNote(dailyPath, '# ' + date + '\n\n', []));
					const note = notes.get(dailyPath);
					if (payload.mode === 'append' && payload.content) {
						const appended = makeNote(dailyPath, note.content + String(payload.content), note.tags);
						notes.set(dailyPath, appended);
					}
					const finalNote = notes.get(dailyPath);
					return respond({
						ok: true,
						daily: { path: dailyPath, date, created, content: finalNote.content, appended: Boolean(payload.mode === 'append' && payload.content), bytes: finalNote.size }
					}, true, 200);
				}
			}
			if (method === 'GET' && route === '/tags') {
				return respond({ ok: true, tags: [], total: 0 }, true, 200);
			}
			if (method === 'GET' && route === '/links') {
				return respond({ ok: true, path: String(query.get('path') || ''), outgoing: [], backlinks: [], unresolved: [] }, true, 200);
			}
			if (method === 'POST' && route === '/open') {
				const payload = body || {};
				const relPath = normalizePath(payload.path);
				if (!notes.has(relPath)) return fail('not-found', '笔记不存在：' + relPath, 404);
				return respond({
					ok: true,
					result: { path: relPath, uri: 'obsidian://open?vault=Obsidian%20Vault&file=' + encodeURIComponent(relPath.replace(/\.md$/i, '')), opened: true }
				}, true, 200);
			}
			return fail('not-found', '未知路由：' + method + ' ' + route, 404);
		}
	};

	return { host, notes, normalizePath, formatDate };
}

/* ════════════════════════════════════════════════════════════════════
   三、假 ctx（记录 slots.inject / register / effect）
   ════════════════════════════════════════════════════════════════════ */
function createFakeCtx() {
	const state = { injections: [], registrations: [], effects: [], getCalls: [] };
	const ctx = {
		slots: {
			inject(name, callback) {
				if (typeof callback !== 'function') throw new Error('slots.inject 第二个参数必须是函数');
				state.injections.push({ name, callback });
				return () => { state.disposals = (state.disposals || 0) + 1; };
			},
			register(def, component) {
				if (!def || typeof def !== 'object') throw new Error('slots.register 缺少 slot 定义');
				state.registrations.push({ def, component });
				return () => { state.disposals = (state.disposals || 0) + 1; };
			}
		},
		effect(callback, label) {
			if (typeof callback !== 'function') throw new Error('ctx.effect 需要函数');
			const disposer = callback();
			state.effects.push({ label, disposer });
			return disposer;
		},
		get(name) {
			state.getCalls.push(name);
			return undefined;
		}
	};
	return { ctx, state };
}

/* 模拟 Cordis 在 slot 就绪后调用 inject 回调（普通函数或 generator）。 */
function activateInjections(state) {
	for (const injection of state.injections) {
		const tag = Object.prototype.toString.call(injection.callback);
		if (tag === '[object GeneratorFunction]') {
			const iterator = injection.callback();
			if (iterator && typeof iterator.next === 'function') iterator.next();
		} else {
			injection.callback();
		}
	}
}

/* ════════════════════════════════════════════════════════════════════
   四、加载 lib/client.js
   ════════════════════════════════════════════════════════════════════ */
function loadClient(reactApi, host) {
	const source = fs.readFileSync(CLIENT_PATH, 'utf8');
	const loadCalls = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(def) { loadCalls.push(def); }
			}
		},
		console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
		fetch: (url, options) => host.fetch(url, options),
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval
	};
	const context = vm.createContext(sandbox);
	vm.runInContext(source, context, { filename: CLIENT_PATH });

	assert.equal(loadCalls.length, 1, 'window.__ModuleLoader__.load 应被调用一次，实际：' + loadCalls.length);
	const definition = loadCalls[0];
	const required = [];
	const exportsObject = definition.factory((name) => {
		required.push(name);
		if (name === 'react') return reactApi.react;
		throw new Error('客户端 require 了未声明依赖：' + name);
	});
	return { source, loadCalls, definition, required, exportsObject };
}

/* ════════════════════════════════════════════════════════════════════
   五、主流程
   ════════════════════════════════════════════════════════════════════ */
async function main() {
	const unhandled = [];
	process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

	/* ── 0. 文件存在 ─────────────────────────────────────────────── */
	check('文件：lib/client.js 存在且非空', () => {
		assert.ok(fs.existsSync(CLIENT_PATH), '缺少 lib/client.js');
		const size = fs.statSync(CLIENT_PATH).size;
		assert.ok(size > 4000, 'client.js 体积异常（' + size + ' 字节）');
	});

	const reactApi = createReactStub();
	const fake = createFakeHost();
	const host = fake.host;
	const client = loadClient(reactApi, host);
	const source = client.source;

	/* ── A. 静态契约 ─────────────────────────────────────────────── */
	const requireNames = Array.from(source.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)).map((match) => match[2]);
	check("静态：只 require('react')", () => {
		assert.deepEqual(Array.from(new Set(requireNames)), ['react']);
	});
	check('静态：无 ESM import/export 语句（经典脚本）', () => {
		assert.equal((source.match(/^\s*(?:import|export)\s+/gm) || []).length, 0);
	});
	check('静态：只用允许的 React hooks（useState/useEffect/useCallback/useRef）', () => {
		const used = Array.from(new Set(Array.from(source.matchAll(/(?:^|[^A-Za-z0-9_$.])(use[A-Z][A-Za-z0-9_]*)\s*\(/g)).map((match) => match[1])));
		const allowed = new Set(['useState', 'useEffect', 'useCallback', 'useRef']);
		for (const hook of used) assert.ok(allowed.has(hook), '使用了未允许的 hook：' + hook);
		assert.ok(used.includes('useState'), '面板应使用 useState');
		assert.ok(used.includes('useEffect'), '面板应使用 useEffect');
	});
	check('静态：无 CSS 文件、无 style 标签注入（内联样式）', () => {
		assert.equal((source.match(/\.css\b/g) || []).length, 0, '引用了 .css');
		assert.equal((source.match(/createElement\(\s*['"]style['"]/g) || []).length, 0, '创建了 <style> 标签');
	});
	check('静态：未引用未声明的 ctx 服务（只允许 slots/effect/get）', () => {
		const services = Array.from(new Set(Array.from(source.matchAll(/ctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)).map((match) => match[1])));
		const allowed = new Set(['slots', 'effect', 'get']);
		for (const service of services) assert.ok(allowed.has(service), '引用了未声明/不允许的 ctx 服务：ctx.' + service);
	});
	check('静态：SPEC §6 必需 data-obsidian-* 属性出现在源码中', () => {
		const required = [
			'data-obsidian-panel', 'data-obsidian-state', 'data-obsidian-vault', 'data-obsidian-tree',
			'data-obsidian-note-item', 'data-obsidian-note-path', 'data-obsidian-action',
			'data-obsidian-search', 'data-obsidian-error'
		];
		for (const name of required) assert.ok(source.includes(name), '源码缺少属性 ' + name);
	});
	check('静态：API 前缀唯一且固定为 /dsh-obsidian/api', () => {
		assert.ok(source.includes("const API_BASE = '/dsh-obsidian/api';"), '缺少 API_BASE 常量');
		assert.equal((source.match(/['"]\/dsh-obsidian\/api['"]/g) || []).length, 1, 'API 前缀应只定义一次');
	});

	/* ── B. 模块契约 ─────────────────────────────────────────────── */
	check('loader：window.__ModuleLoader__.load 恰好调用一次', () => {
		assert.equal(client.loadCalls.length, 1);
	});
	check('loader：id === dsh-plugin-obsidian', () => {
		assert.equal(client.definition.id, 'dsh-plugin-obsidian');
		assert.equal(typeof client.definition.factory, 'function');
	});
	check("exports：apply 为函数且 inject === ['slots']", () => {
		assert.equal(typeof client.exportsObject.apply, 'function');
		assert.deepEqual(Array.from(client.exportsObject.inject), ['slots']);
		assert.equal(Object.prototype.toString.call(client.exportsObject), '[object Module]');
	});
	check("require：factory 只请求 'react'", () => {
		assert.deepEqual(Array.from(new Set(client.required)), ['react']);
	});

	/* ── C. 注册契约 ─────────────────────────────────────────────── */
	const fakeCtx = createFakeCtx();
	check('apply：执行不抛错且通过 slots.inject 注册 sidebar.panellist + main', () => {
		client.exportsObject.apply(fakeCtx.ctx);
		activateInjections(fakeCtx.state);
		assert.deepEqual(fakeCtx.state.injections.map((entry) => entry.name), ['sidebar.panellist', 'main']);
	});
	const sidebarRegistration = fakeCtx.state.registrations.find((entry) => entry.def.name === 'sidebar.panellist');
	const mainRegistration = fakeCtx.state.registrations.find((entry) => entry.def.name === 'main');
	check('sidebar.panellist：id/order/label 符合 SPEC', () => {
		assert.ok(sidebarRegistration, '缺少 sidebar.panellist 注册');
		assert.equal(sidebarRegistration.def.name, 'sidebar.panellist');
		assert.equal(sidebarRegistration.def.id, 'dsh-obsidian');
		assert.equal(sidebarRegistration.def.order, 6);
		assert.equal(typeof sidebarRegistration.def.label, 'function');
		assert.equal(sidebarRegistration.def.label(), 'Obsidian');
		assert.equal(typeof sidebarRegistration.component, 'function');
	});
	check('main：key === dsh-obsidian 且组件为函数', () => {
		assert.ok(mainRegistration, '缺少 main 注册');
		assert.equal(mainRegistration.def.name, 'main');
		assert.equal(mainRegistration.def.key, 'dsh-obsidian');
		assert.equal(typeof mainRegistration.component, 'function');
	});
	check('apply：不读取未声明的 ctx 服务（ctx.get 未被调用）', () => {
		assert.deepEqual(fakeCtx.state.getCalls, []);
	});
	check('apply：重复调用不抛错（幂等注册尝试）', () => {
		const again = createFakeCtx();
		assert.doesNotThrow(() => {
			client.exportsObject.apply(again.ctx);
			activateInjections(again.state);
		});
		assert.equal(again.state.registrations.length, 2);
	});

	/* PanelIcon 单独浅渲染 */
	const iconRuntime = createRuntime(reactApi);
	check('PanelIcon：渲染内联 SVG 图标', () => {
		const tree = iconRuntime.mount(sidebarRegistration.component);
		const svg = findAll(tree, (node) => node.tag === 'svg');
		assert.equal(svg.length, 1, 'PanelIcon 应渲染一个 svg');
		assert.ok(svg[0].children.length > 0, 'svg 应有 path 子节点');
	});

	/* ── D. 面板渲染状态机 ───────────────────────────────────────── */
	const pageComponent = mainRegistration.component;
	const trees = [];
	const renderedStates = new Set();

	host.failMode = 'reject';
	const runtime = createRuntime(reactApi);
	const loadingTree = runtime.mount(pageComponent);
	trees.push(loadingTree);
	renderedStates.add('loading');

	await checkAsync('loading：首帧 data-obsidian-state="loading" 且显示加载中', () => {
		const root = propNodes(loadingTree, 'data-obsidian-panel', 'root')[0];
		assert.ok(root, '缺少面板根节点 data-obsidian-panel="root"');
		assert.equal(root.props['data-obsidian-state'], 'loading');
		const rootNodes = findAll(loadingTree, (node) => node.props && node.props['data-obsidian-panel'] === 'root');
		assert.equal(rootNodes.length, 1, '面板根应唯一');
		assert.ok(textContent(loadingTree).includes('正在连接 Obsidian 仓库'), 'loading 文案缺失');
		assert.equal(propNodes(loadingTree, 'data-obsidian-error').length, 0, 'loading 态不应有错误节点');
	});

	const errorTree = await runtime.settle();
	trees.push(errorTree);
	renderedStates.add('error');
	await checkAsync('error（网络失败）：进入 error 态并给出可读错误 + 重试', () => {
		const root = propNodes(errorTree, 'data-obsidian-panel', 'root')[0];
		assert.ok(root, 'error 态缺少面板根（白屏）');
		assert.equal(root.props['data-obsidian-state'], 'error');
		const errorNode = propNodes(errorTree, 'data-obsidian-error')[0];
		assert.ok(errorNode, 'error 态缺少 data-obsidian-error');
		const errorText = textContent(errorNode);
		assert.ok(errorText.includes('网络请求失败'), '错误文案应说明网络失败，实际：' + errorText);
		const retry = propNodes(errorTree, 'data-obsidian-retry')[0];
		assert.ok(retry, 'error 态缺少重试按钮');
		assert.equal(typeof retry.props.onClick, 'function');
		assert.ok(textContent(retry).includes('重试'));
	});

	/* 非 2xx / ok:false 也应进入 error 态 */
	host.failMode = 'http-503';
	const runtime503 = createRuntime(reactApi);
	runtime503.mount(pageComponent);
	const error503Tree = await runtime503.settle();
	trees.push(error503Tree);
	await checkAsync('error（HTTP 503 + ok:false）：也进入 error 态并带错误 code', () => {
		const root = propNodes(error503Tree, 'data-obsidian-panel', 'root')[0];
		assert.ok(root);
		assert.equal(root.props['data-obsidian-state'], 'error');
		const text = textContent(propNodes(error503Tree, 'data-obsidian-error')[0] || error503Tree);
		assert.ok(text.includes('vault-unavailable') || text.includes('仓库不可用'), '错误文案应包含宿主错误信息，实际：' + text);
	});

	/* 宿主契约：vault 不可用时 /status 仍返回 ok:true + available:false + error（vault.status()） */
	host.failMode = 'ok';
	host.statusAvailable = false;
	const runtimeUnavailable = createRuntime(reactApi);
	await runtimeUnavailable.mount(pageComponent);
	const unavailableTree = await runtimeUnavailable.settle();
	trees.push(unavailableTree);
	renderedStates.add('error');
	await checkAsync('error（vault 不可用）：/status 报 available:false 时直接进 error 并给出引导', () => {
		const root = propNodes(unavailableTree, 'data-obsidian-panel', 'root')[0];
		assert.ok(root);
		assert.equal(root.props['data-obsidian-state'], 'error');
		const text = textContent(propNodes(unavailableTree, 'data-obsidian-error')[0] || unavailableTree);
		assert.ok(text.includes('不可用') && text.includes('DSH_OBSIDIAN_VAULT'), '错误文案应提示 vault 路径配置，实际：' + text);
	});
	host.statusAvailable = true;

	/* 重试 → ready */
	host.failMode = 'ok';
	const requestsBeforeRetry = host.requests.length;
	const retryButton = propNodes(errorTree, 'data-obsidian-retry')[0];
	const readyTree = await (async () => {
		click(retryButton);
		return runtime.settle();
	})();
	trees.push(readyTree);
	renderedStates.add('ready');
	await checkAsync('retry：点击重试后重新请求并恢复 ready', () => {
		assert.ok(host.requests.length > requestsBeforeRetry, '重试没有发出新请求');
		const root = propNodes(readyTree, 'data-obsidian-panel', 'root')[0];
		assert.ok(root);
		assert.equal(root.props['data-obsidian-state'], 'ready');
	});

	const readyRoot = propNodes(readyTree, 'data-obsidian-panel', 'root')[0];
	await checkAsync('ready：data-obsidian-vault 为仓库路径、显示笔记数', () => {
		assert.ok(readyRoot);
		assert.equal(readyRoot.props['data-obsidian-vault'], host.vaultPath);
		const vaultNodes = propNodes(readyTree, 'data-obsidian-vault', host.vaultPath);
		assert.ok(vaultNodes.length >= 1);
		assert.ok(textContent(vaultNodes[0]).includes('篇笔记'), '顶栏应显示笔记数');
	});

	const treeNodes = propNodes(readyTree, 'data-obsidian-tree');
	const noteItems = propNodes(readyTree, 'data-obsidian-note-item');
	await checkAsync('ready：目录树含 note-item（每项都有 data-obsidian-note-path）', () => {
		assert.equal(treeNodes.length, 1, 'ready 态应有一个 data-obsidian-tree 容器');
		assert.ok(noteItems.length >= 2, '目录树笔记项应 ≥ 2，实际：' + noteItems.length);
		for (const item of noteItems) {
			assert.equal(item.tag, 'button');
			const notePath = item.props['data-obsidian-note-path'];
			assert.equal(typeof notePath, 'string');
			assert.ok(notePath.length > 0);
			assert.equal(typeof item.props.onClick, 'function');
		}
		const folders = propNodes(readyTree, 'data-obsidian-folder');
		assert.ok(folders.length >= 1, '目录树应支持文件夹折叠');
	});

	await checkAsync('ready：自动载入第一篇笔记（GET /note + 查看器）', () => {
		const noteRequests = host.requests.filter((request) => request.method === 'GET' && request.pathname === API_PREFIX + '/note');
		assert.ok(noteRequests.length >= 1, 'ready 后应自动 GET 一篇笔记');
		const viewer = propNodes(readyTree, 'data-obsidian-note')[0];
		assert.ok(viewer, '缺少 data-obsidian-note 查看区');
		const renderedPath = renderedNotePath(readyTree);
		assert.ok(typeof renderedPath === 'string' && renderedPath.length > 0);
		const lastNoteRequest = noteRequests[noteRequests.length - 1];
		const requestedPath = new URLSearchParams(lastNoteRequest.search).get('path');
		assert.equal(requestedPath, renderedPath, 'GET /note 的 path 应与查看器一致');
		const treePaths = noteItems.map((item) => item.props['data-obsidian-note-path']);
		assert.ok(treePaths.includes(renderedPath), '查看器路径应来自目录树');
		assert.ok(textContent(viewer).length > 0, '查看器应有标题/正文');
	});

	await checkAsync('ready：顶栏与查看器操作按钮齐全（refresh/new/daily/edit/append/open/trash）', () => {
		for (const action of ['refresh', 'new', 'daily', 'edit', 'append', 'open', 'trash']) {
			assert.ok(buttonByAction(readyTree, action), 'ready 态缺少 data-obsidian-action="' + action + '" 按钮');
		}
		const searchInput = propNodes(readyTree, 'data-obsidian-search')[0];
		assert.ok(searchInput, '缺少 data-obsidian-search 搜索框');
		assert.equal(typeof searchInput.props.onChange, 'function');
	});

	/* 编辑 → 保存 */
	let editorTree;
	await checkAsync('edit：点「编辑」进入 textarea 编辑态并出现「保存」', async () => {
		click(buttonByAction(readyTree, 'edit'));
		editorTree = await runtime.settle();
		trees.push(editorTree);
		const input = propNodes(editorTree, 'data-obsidian-editor-input')[0];
		assert.ok(input, '编辑态缺少 textarea');
		assert.equal(input.tag, 'textarea');
		assert.ok(buttonByAction(editorTree, 'save'), '编辑态缺少「保存」按钮');
	});

	let savedTree;
	await checkAsync('save：POST /note mode=overwrite 并回读刷新', async () => {
		const editorInput = propNodes(editorTree, 'data-obsidian-editor-input')[0];
		const marker = '<!-- check-client 保存标记 -->';
		change(editorInput, '# 覆盖后的标题\n\n' + marker);
		/* 输入后必须先渲染（真实 UI 中用户打字也会触发渲染），否则保存闭包里的 draft 还是旧值。 */
		const refreshedEditorTree = await runtime.settle();
		const notePostsBefore = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/note').length;
		const saveButton = buttonByAction(refreshedEditorTree, 'save');
		assert.ok(saveButton, '刷新后的编辑态缺少「保存」按钮');
		click(saveButton);
		savedTree = await runtime.settle();
		trees.push(savedTree);
		const posts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/note');
		assert.ok(posts.length > notePostsBefore, '保存没有发出 POST /note');
		const request = posts[posts.length - 1];
		assert.equal(request.body.mode, 'overwrite');
		assert.ok(String(request.body.content).includes('保存标记'), 'POST 内容应包含编辑后的正文');
		assert.ok(propNodes(savedTree, 'data-obsidian-editor-input').length === 0, '保存后应退出编辑态');
		assert.ok(propNodes(savedTree, 'data-obsidian-note').length === 1, '保存后应回到查看态');
	});

	/* 新建笔记 */
	let newFormTree;
	await checkAsync('new：点「新建笔记」出现表单（路径/标题/内容/标签）', async () => {
		click(buttonByAction(savedTree, 'new'));
		newFormTree = await runtime.settle();
		trees.push(newFormTree);
		assert.ok(propNodes(newFormTree, 'data-obsidian-new-form').length === 1, '缺少新建表单');
		for (const attr of ['data-obsidian-new-path', 'data-obsidian-new-title', 'data-obsidian-new-content', 'data-obsidian-new-tags']) {
			assert.ok(propNodes(newFormTree, attr).length === 1, '新建表单缺少 ' + attr);
		}
	});

	let createdTree;
	let createdPath;
	await checkAsync('new：提交 POST /note mode=create 并自动打开新笔记', async () => {
		change(propNodes(newFormTree, 'data-obsidian-new-path')[0], '01-笔记/检查器新建');
		change(propNodes(newFormTree, 'data-obsidian-new-title')[0], '检查器新建标题');
		change(propNodes(newFormTree, 'data-obsidian-new-content')[0], '正文里先写一句话。');
		change(propNodes(newFormTree, 'data-obsidian-new-tags')[0], '验证, 自动化');
		/* 填入表单后先渲染一次，让提交按钮拿到最新的表单状态。 */
		const filledFormTree = await runtime.settle();
		const submit = propNodes(filledFormTree, 'data-obsidian-new-submit')[0];
		assert.ok(submit, '缺少新建提交按钮');
		assert.equal(submit.props['data-obsidian-action'], 'new');
		click(submit);
		createdTree = await runtime.settle();
		trees.push(createdTree);
		const posts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/note' && request.body && request.body.mode === 'create');
		assert.ok(posts.length >= 1, '没有发出 POST /note mode=create');
		const request = posts[posts.length - 1];
		assert.equal(request.body.path, '01-笔记/检查器新建');
		assert.deepEqual(request.body.tags, ['验证', '自动化']);
		assert.ok(String(request.body.content).startsWith('# 检查器新建标题'), '标题应自动写成正文首行 # 标题');
		createdPath = fake.normalizePath('01-笔记/检查器新建');
		assert.ok(fake.notes.has(createdPath), '宿主侧应创建笔记文件');
		const renderedPath = renderedNotePath(createdTree);
		assert.equal(renderedPath, createdPath, '创建后应自动打开新笔记');
		const bannerMessages = propNodes(createdTree, 'data-obsidian-message');
		assert.ok(bannerMessages.some((node) => textContent(node).includes('已创建')), '应显示创建成功提示');
	});

	/* 移回收站：二次确认 */
	let confirmTree;
	await checkAsync('trash：先出二次确认面板，不直接删', async () => {
		click(buttonByAction(createdTree, 'trash'));
		confirmTree = await runtime.settle();
		trees.push(confirmTree);
		assert.ok(propNodes(confirmTree, 'data-obsidian-confirm-trash').length === 1, '缺少二次确认面板');
		const trashPosts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/manage');
		assert.equal(trashPosts.length, 0, '二次确认前不应发出 POST /manage');
	});

	let trashedTree;
	await checkAsync('trash：确认后 POST /manage action=trash 并清空选中', async () => {
		const confirmButton = buttonByAction(confirmTree, 'trash', { 'data-obsidian-confirm': '1' });
		assert.ok(confirmButton, '确认面板缺少确认按钮');
		click(confirmButton);
		trashedTree = await runtime.settle();
		trees.push(trashedTree);
		const posts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/manage');
		assert.ok(posts.length >= 1, '没有发出 POST /manage');
		const request = posts[posts.length - 1];
		assert.equal(request.body.action, 'trash');
		assert.equal(request.body.path, createdPath);
		assert.equal(fake.notes.has(createdPath), false, '宿主侧笔记应被移入回收站');
		assert.equal(propNodes(trashedTree, 'data-obsidian-note').length, 0, '移回收站后不应还有笔记查看区');
		assert.ok(propNodes(trashedTree, 'data-obsidian-empty').length >= 1, '应回到空状态引导');
	});

	/* 重新选中一篇笔记 */
	let selectedTree;
	await checkAsync('select：点目录树笔记项触发 GET /note 并显示内容', async () => {
		const items = propNodes(trashedTree, 'data-obsidian-note-item');
		assert.ok(items.length >= 1, '目录树应有笔记项');
		const target = items.find((item) => item.props['data-obsidian-note-path'] === '欢迎.md') || items[0];
		const targetPath = target.props['data-obsidian-note-path'];
		click(target);
		selectedTree = await runtime.settle();
		trees.push(selectedTree);
		const viewer = propNodes(selectedTree, 'data-obsidian-note')[0];
		assert.ok(viewer);
		assert.equal(renderedNotePath(selectedTree), targetPath);
		assert.ok(textContent(viewer).includes('欢迎'), '查看器应显示笔记正文');
	});

	/* 追加 */
	let appendPanelTree;
	await checkAsync('append：点「追加」出现追加输入框', async () => {
		click(buttonByAction(selectedTree, 'append'));
		appendPanelTree = await runtime.settle();
		trees.push(appendPanelTree);
		assert.ok(propNodes(appendPanelTree, 'data-obsidian-append-input').length === 1, '缺少追加输入框');
	});

	let appendedTree;
	await checkAsync('append：确认后 POST /note mode=append', async () => {
		const input = propNodes(appendPanelTree, 'data-obsidian-append-input')[0];
		const marker = '追加标记 check-client';
		change(input, marker);
		const filledAppendTree = await runtime.settle();
		const confirm = buttonByAction(filledAppendTree, 'append', { 'data-obsidian-confirm': '1' });
		assert.ok(confirm, '缺少确认追加按钮');
		click(confirm);
		appendedTree = await runtime.settle();
		trees.push(appendedTree);
		const posts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/note' && request.body && request.body.mode === 'append');
		assert.ok(posts.length >= 1, '没有发出 POST /note mode=append');
		const request = posts[posts.length - 1];
		assert.equal(request.body.path, '欢迎.md');
		assert.ok(String(request.body.content).includes(marker));
		assert.ok(fake.notes.get('欢迎.md').content.includes(marker), '宿主侧正文应已追加');
	});

	/* 搜索（走服务器 /search） */
	let searchTree;
	await checkAsync('search：输入 ≥2 字符走 GET /search 并显示结果', async () => {
		const searchInput = propNodes(appendedTree, 'data-obsidian-search')[0];
		change(searchInput, '欢迎');
		/* 先渲染一次让搜索 effect 起防抖定时器，再等过 250ms 防抖，最后再收敛到结果态。 */
		await runtime.settle();
		await sleep(400);
		searchTree = await runtime.settle();
		trees.push(searchTree);
		const queries = host.requests.filter((request) => request.method === 'GET' && request.pathname === API_PREFIX + '/search');
		assert.ok(queries.length >= 1, '没有发出 GET /search');
		const last = queries[queries.length - 1];
		assert.equal(new URLSearchParams(last.search).get('q'), '欢迎');
		assert.ok(propNodes(searchTree, 'data-obsidian-search-results').length === 1, '缺少搜索结果容器');
		const results = propNodes(searchTree, 'data-obsidian-search-result');
		assert.ok(results.length >= 1, '搜索结果应至少一条');
		assert.ok(results.some((node) => node.props['data-obsidian-note-path'] === '欢迎.md'));
	});

	/* 今日日记 */
	let dailyTree;
	let dailyPath;
	await checkAsync('daily：点「今日日记」POST /daily 并打开今日笔记', async () => {
		click(buttonByAction(searchTree, 'daily'));
		dailyTree = await runtime.settle();
		trees.push(dailyTree);
		const posts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/daily');
		assert.ok(posts.length >= 1, '没有发出 POST /daily');
		const viewer = propNodes(dailyTree, 'data-obsidian-note')[0];
		assert.ok(viewer, '今日日记应自动打开');
		dailyPath = renderedNotePath(dailyTree);
		assert.ok(String(dailyPath).startsWith('日记/'), '今日日记应位于日记目录，实际：' + dailyPath);
		assert.ok(fake.notes.has(dailyPath), '宿主侧应创建今日日记文件');
	});

	/* 在 Obsidian 中打开 */
	let openTree;
	await checkAsync('open：点「在 Obsidian 中打开」POST /open 并提示成功', async () => {
		click(buttonByAction(dailyTree, 'open'));
		openTree = await runtime.settle();
		trees.push(openTree);
		const posts = host.requests.filter((request) => request.method === 'POST' && request.pathname === API_PREFIX + '/open');
		assert.ok(posts.length >= 1, '没有发出 POST /open');
		assert.equal(posts[posts.length - 1].body.path, dailyPath);
		const messages = propNodes(openTree, 'data-obsidian-message');
		assert.ok(messages.some((node) => textContent(node).includes('已在 Obsidian 中打开')), '应提示已打开');
	});

	/* ── E. 数据属性 / 无白屏 / 网络纪律 / 未捕获异常 ────────────── */
	await checkAsync('渲染：每棵渲染树都有唯一的面板根节点（永不白屏）', () => {
		assert.ok(trees.length >= 10, '应覆盖至少 10 个渲染态，实际：' + trees.length);
		for (const tree of trees) {
			const roots = propNodes(tree, 'data-obsidian-panel', 'root');
			assert.equal(roots.length, 1, '某个渲染态缺少/重复 data-obsidian-panel="root"');
			assert.ok(['loading', 'ready', 'error'].includes(roots[0].props['data-obsidian-state']), '非法 data-obsidian-state：' + roots[0].props['data-obsidian-state']);
		}
	});

	await checkAsync('渲染：三态 data-obsidian-state 全覆盖（loading/error/ready）', () => {
		assert.deepEqual(Array.from(renderedStates).sort(), ['error', 'loading', 'ready']);
	});

	await checkAsync('渲染：SPEC §6 必需 data-obsidian-* 属性在渲染树中齐全', () => {
		const names = new Set();
		for (const tree of trees) {
			const collected = collectDataProps(tree);
			for (const name of collected.names) names.add(name);
		}
		const required = [
			'data-obsidian-panel', 'data-obsidian-state', 'data-obsidian-vault', 'data-obsidian-tree',
			'data-obsidian-note-item', 'data-obsidian-note-path', 'data-obsidian-action',
			'data-obsidian-search', 'data-obsidian-error', 'data-obsidian-note'
		];
		for (const name of required) assert.ok(names.has(name), '渲染树缺少属性 ' + name);
	});

	await checkAsync('渲染：data-obsidian-action 枚举全覆盖（refresh/new/daily/edit/save/append/open/trash）', () => {
		const actions = new Set();
		for (const tree of trees) {
			for (const action of collectDataProps(tree).actions) actions.add(action);
		}
		const required = ['refresh', 'new', 'daily', 'edit', 'save', 'append', 'open', 'trash'];
		for (const action of required) assert.ok(actions.has(action), '缺少 data-obsidian-action="' + action + '"');
	});

	await checkAsync('网络：所有请求 URL 都以 /dsh-obsidian/api 开头', () => {
		assert.ok(host.requests.length >= 10, '请求数量异常：' + host.requests.length);
		for (const request of host.requests) {
			assert.ok(String(request.url).startsWith(API_PREFIX), '非法请求 URL：' + request.url);
			assert.ok(request.method === 'GET' || request.method === 'POST', '非法方法：' + request.method);
		}
	});

	await checkAsync('网络：未捕获 rejection 数为 0（面板内消化所有网络失败）', async () => {
		await sleep(30);
		assert.deepEqual(unhandled.map((reason) => String((reason && reason.message) || reason)), []);
	});

	/* ── 汇总 ────────────────────────────────────────────────────── */
	console.log('');
	if (failed > 0) {
		console.log('FAILED CHECKS: ' + failures.join(', '));
		console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
		process.exitCode = 1;
	} else {
		console.log('RESULT: ' + passed + ' passed, 0 failed');
		process.exitCode = 0;
	}
}

main().catch((error) => {
	console.error('FATAL 检查器自身失败：');
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
