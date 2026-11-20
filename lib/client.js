/* dsh-plugin-obsidian — DSH Web GUI 浏览器面板（客户端半区）
 *
 * 契约（SPEC §1.2 / §6）：
 *   window.__ModuleLoader__.load({ id: 'dsh-plugin-obsidian', factory })
 *   exports.apply(ctx) / exports.inject = ['slots']
 *   只用 react；不 import 任何包、不读写 document/localStorage、不写 CSS 文件（全部内联样式）；
 *   所有网络请求同源走 /dsh-obsidian/api/*（SPEC §5）。
 *
 * 面板状态机（data-obsidian-state）：
 *   loading -> 读取 GET /status + GET /tree（并自动选中第一篇笔记）
 *   error   -> 任一请求网络失败 / 非 2xx / ok!==true；显示可读原因 + 「重试」按钮（data-obsidian-action="refresh"）
 *   ready   -> 左树 + 搜索、右栏笔记查看/编辑/追加、顶栏刷新/今日日记/新建笔记
 * 任何请求都在面板内转成 { ok, status, payload }，不抛未捕获拒绝；错误一律渲染在面板里，永不白屏。
 *
 * 已知限制（README 由 Lead 汇总）：正文用 <pre> 原样显示，不做 Markdown 渲染。
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-obsidian',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useRef } = react;

		const PANEL_ID = 'dsh-obsidian';
		const PANEL_LABEL = 'Obsidian';
		const API_BASE = '/dsh-obsidian/api';

		/* ── 主题变量（浅色/深色都由 DSW 变量驱动；无 CSS 文件） ─────────── */
		const C = {
			label: 'var(--dsw-alias-label-primary, inherit)',
			label2: 'var(--dsw-alias-label-secondary, rgba(110,110,110,1))',
			label3: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.95))',
			border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
			border1: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
			sep: 'var(--dsw-alias-separator-secondary, rgba(128,128,128,.22))',
			bg1: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
			bg3: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.10))',
			error: 'var(--dsw-alias-state-error-primary, #dc2626)',
			success: 'var(--dsw-alias-state-success-primary, #16a34a)',
			warn: 'var(--dsw-alias-state-warning-primary, #d97706)'
		};

		const s = {
			root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.label, fontSize: '13px', lineHeight: '1.55', background: 'var(--dsw-alias-bg-layer-2, transparent)', fontFamily: 'inherit' },
			topbar: { flex: 'none', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid ' + C.sep },
			brand: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 },
			title: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
			vaultBox: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0, maxWidth: '46%', color: C.label3, fontSize: '11.5px' },
			vaultPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
			count: { flex: 'none', color: C.label3, fontVariantNumeric: 'tabular-nums' },
			actions: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' },
			btn: { font: 'inherit', fontSize: '12.5px', lineHeight: '18px', padding: '5px 11px', borderRadius: '7px', border: '1px solid ' + C.border, background: 'transparent', color: C.label, cursor: 'pointer' },
			btnPrimary: { font: 'inherit', fontSize: '12.5px', lineHeight: '18px', padding: '5px 11px', borderRadius: '7px', border: '1px solid ' + C.border, background: C.bg3, color: C.label, cursor: 'pointer', fontWeight: 600 },
			btnDanger: { font: 'inherit', fontSize: '12.5px', lineHeight: '18px', padding: '5px 11px', borderRadius: '7px', border: '1px solid ' + C.border, background: 'transparent', color: C.error, cursor: 'pointer' },
			btnDangerStrong: { font: 'inherit', fontSize: '12.5px', lineHeight: '18px', padding: '5px 11px', borderRadius: '7px', border: '1px solid ' + C.error, background: 'transparent', color: C.error, cursor: 'pointer', fontWeight: 600 },
			bannerInfo: { flex: 'none', margin: '0', padding: '7px 16px', borderBottom: '1px solid ' + C.border1, color: C.label2, fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			bannerError: { flex: 'none', margin: '0', padding: '7px 16px', borderBottom: '1px solid ' + C.border1, color: C.error, fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			body: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' },
			side: { width: '290px', flex: 'none', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', borderRight: '1px solid ' + C.sep, overflow: 'hidden' },
			search: { width: '100%', boxSizing: 'border-box', height: '32px', border: '1px solid ' + C.border, background: C.bg1, color: C.label, font: 'inherit', fontSize: '12.5px', borderRadius: '7px', outline: 'none', padding: '0 10px' },
			sideNote: { margin: '0 2px', color: C.label3, fontSize: '11.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			searchResults: { flex: 'none', maxHeight: '42%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px', borderBottom: '1px solid ' + C.border1, paddingBottom: '6px' },
			tree: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
			treeList: { margin: 0, padding: 0, listStyle: 'none' },
			treeLi: { margin: 0, padding: 0 },
			folderRow: { width: '100%', display: 'block', textAlign: 'left', font: 'inherit', fontSize: '12px', fontWeight: 600, color: C.label2, background: 'transparent', border: 0, cursor: 'pointer', padding: '4px 6px 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
			noteRow: { width: '100%', display: 'block', textAlign: 'left', font: 'inherit', fontSize: '12.5px', color: C.label, background: 'transparent', border: '1px solid transparent', borderRadius: '6px', cursor: 'pointer', padding: '4px 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
			noteRowSelected: { background: C.bg3, borderColor: C.border },
			noteName: { display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' },
			noteMeta: { display: 'block', color: C.label3, fontSize: '10.5px', lineHeight: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
			center: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', color: C.label3 },
			muted: { margin: 0, color: C.label3, fontSize: '12.5px' },
			errorBox: { flex: 'none', margin: '14px', padding: '12px 14px', border: '1px solid ' + C.border, borderRadius: '9px', background: C.bg1, color: C.error, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '9px' },
			errorText: { margin: 0, color: C.error, fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			noteWrap: { display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', minHeight: 0, padding: '12px 16px', overflow: 'hidden' },
			noteHead: { flex: 'none', display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' },
			noteHeadMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' },
			noteTitle: { margin: 0, fontSize: '16px', fontWeight: 600, lineHeight: '22px', wordBreak: 'break-word' },
			notePath: { color: C.label3, fontSize: '11.5px', wordBreak: 'break-all' },
			noteActions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
			tagRow: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' },
			tag: { fontSize: '11px', lineHeight: '16px', padding: '0 7px', borderRadius: '999px', background: C.bg3, color: C.label2 },
			noteBody: { flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: '12px 14px', border: '1px solid ' + C.border1, borderRadius: '9px', background: C.bg1, color: C.label, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace', fontSize: '12.5px', lineHeight: '1.7', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			inlinePanel: { flex: 'none', display: 'flex', flexDirection: 'column', gap: '7px', padding: '9px 10px', border: '1px solid ' + C.border, borderRadius: '9px', background: C.bg1 },
			dangerPanel: { flex: 'none', display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: '1px solid ' + C.error, borderRadius: '9px', background: C.bg1, color: C.label },
			rowRight: { display: 'flex', alignItems: 'center', gap: '7px', justifyContent: 'flex-end', flexWrap: 'wrap' },
			textarea: { width: '100%', boxSizing: 'border-box', minHeight: '80px', resize: 'vertical', border: '1px solid ' + C.border, background: 'var(--dsw-alias-bg-layer-1, transparent)', color: C.label, font: 'inherit', fontSize: '12.5px', lineHeight: '1.6', borderRadius: '8px', outline: 'none', padding: '8px 10px' },
			editor: { flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none', border: '1px solid ' + C.border, background: C.bg1, color: C.label, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace', fontSize: '12.5px', lineHeight: '1.7', borderRadius: '9px', outline: 'none', padding: '10px 12px' },
			form: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px' },
			formTitle: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
			field: { display: 'flex', flexDirection: 'column', gap: '4px' },
			label: { color: C.label2, fontSize: '12px' },
			input: { width: '100%', boxSizing: 'border-box', height: '32px', border: '1px solid ' + C.border, background: C.bg1, color: C.label, font: 'inherit', fontSize: '12.5px', borderRadius: '7px', outline: 'none', padding: '0 10px' },
			preview: { margin: 0, color: C.label3, fontSize: '11.5px' }
		};

		/* ── 纯函数小工具 ──────────────────────────────────────────────── */

		function baseName(path) {
			const text = String(path || '');
			const parts = text.split('/');
			const name = parts[parts.length - 1] || text;
			return name.replace(/\.md$/i, '');
		}

		function asArray(value) {
			return Array.isArray(value) ? value : [];
		}

		function errorMessage(result, fallback) {
			if (result && result.networkError) return '网络请求失败：' + result.networkError;
			const payload = result && result.payload;
			if (payload && payload.error && typeof payload.error === 'object') {
				const message = typeof payload.error.message === 'string' && payload.error.message ? payload.error.message : fallback;
				const code = typeof payload.error.code === 'string' && payload.error.code ? payload.error.code : '';
				return code ? message + '（' + code + '）' : message;
			}
			if (result && result.status) return fallback + '（HTTP ' + result.status + '）';
			return fallback;
		}

		function isOk(result) {
			return Boolean(result && result.ok && result.payload && result.payload.ok === true);
		}

		/* 所有请求都在这里转成结构化结果：网络失败/JSON 解析失败都不会向外抛。 */
		function requestJson(url, options) {
			let pending;
			try {
				pending = fetch(url, options);
			} catch (error) {
				pending = Promise.reject(error);
			}
			return Promise.resolve(pending).then((response) => {
				const status = response && typeof response.status === 'number' ? response.status : 0;
				const ok = Boolean(response && response.ok);
				let parsed;
				try {
					parsed = response && typeof response.json === 'function' ? Promise.resolve(response.json()) : Promise.resolve(null);
				} catch (error) {
					parsed = Promise.reject(error);
				}
				return parsed.then(
					(payload) => ({ ok, status, payload: payload || null }),
					() => ({ ok, status, payload: null })
				);
			}).catch((error) => ({
				ok: false,
				status: 0,
				payload: null,
				networkError: String((error && error.message) || error || '网络请求失败')
			}));
		}

		function apiGet(path) {
			return requestJson(API_BASE + path, { method: 'GET' });
		}

		function apiPost(path, body) {
			return requestJson(API_BASE + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body === undefined ? {} : body)
			});
		}

		/* 目录树：把 list() 的扁平 entries 组装成可折叠层级（容忍缺父目录的条目）。 */
		function buildTree(entries) {
			const root = { path: '', name: '', type: 'folder', children: [] };
			const known = new Map();
			known.set('', root);
			for (const entry of asArray(entries)) {
				if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
				const segments = entry.path.split('/');
				let parentPath = '';
				for (let i = 0; i < segments.length - 1; i++) {
					const current = segments.slice(0, i + 1).join('/');
					if (!known.has(current)) {
						const folder = { path: current, name: segments[i], type: 'folder', children: [], synthetic: true };
						known.set(current, folder);
						const parent = known.get(parentPath);
						if (parent && parent.children) parent.children.push(folder);
					}
					parentPath = current;
				}
				if (known.has(entry.path)) continue;
				const node = { path: entry.path, name: entry.name || baseName(entry.path), type: entry.type === 'folder' ? 'folder' : 'note', title: entry.title };
				if (node.type === 'folder') node.children = [];
				known.set(entry.path, node);
				const parent = known.get(parentPath);
				if (parent && parent.children) parent.children.push(node);
			}
			const sortNodes = (nodes) => {
				nodes.sort((left, right) => {
					const leftFolder = left.type === 'folder' ? 0 : 1;
					const rightFolder = right.type === 'folder' ? 0 : 1;
					if (leftFolder !== rightFolder) return leftFolder - rightFolder;
					return String(left.title || left.name || left.path).localeCompare(String(right.title || right.name || right.path), 'zh-Hans-CN');
				});
				for (const node of nodes) {
					if (node.type === 'folder' && node.children) sortNodes(node.children);
				}
			};
			sortNodes(root.children || []);
			return root.children || [];
		}

		function filterTree(nodes, query) {
			const out = [];
			for (const node of asArray(nodes)) {
				if (!node) continue;
				if (node.type === 'folder') {
					const selfHit = String(node.name || '').toLowerCase().indexOf(query) >= 0;
					const children = filterTree(node.children, query);
					if (selfHit || children.length > 0) out.push(Object.assign({}, node, { children: selfHit ? asArray(node.children) : children }));
				} else {
					const haystack = (String(node.title || '') + ' ' + String(node.name || '') + ' ' + String(node.path || '')).toLowerCase();
					if (haystack.indexOf(query) >= 0) out.push(node);
				}
			}
			return out;
		}

		/* ── 图标（内联 SVG，无 CSS 文件） ─────────────────────────────── */
		function PanelIcon() {
			return h('svg', {
				viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
				style: { display: 'block', flex: 'none' }, 'aria-hidden': 'true'
			},
				h('path', { d: 'M8 1.6 13 4v8L8 14.4 3 12V4z', stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }),
				h('path', { d: 'M5.4 6h5.2M5.4 8.2h5.2M5.4 10.4h3.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' })
			);
		}

		/* ── 目录树组件（纯展示，无 hooks） ────────────────────────────── */
		function Tree(props) {
			const nodes = asArray(props.nodes);
			return h('ul', { style: s.treeList },
				nodes.map((node) => h(TreeRow, {
					key: String(node && node.path),
					node,
					selectedPath: props.selectedPath,
					expanded: props.expanded,
					onToggle: props.onToggle,
					onSelect: props.onSelect
				}))
			);
		}

		function TreeRow(props) {
			const node = props.node;
			if (!node) return null;
			if (node.type === 'folder') {
				const open = props.expanded[node.path] !== false;
				return h('li', { style: s.treeLi },
					h('button', {
						type: 'button',
						style: s.folderRow,
						title: node.path,
						'data-obsidian-folder': '1',
						'data-obsidian-folder-path': node.path,
						onClick: () => props.onToggle(node.path)
					}, (open ? '▾ ' : '▸ ') + String(node.name || baseName(node.path)) + (node.children && node.children.length ? '（' + node.children.length + '）' : '')),
					open && node.children && node.children.length > 0
						? h(Tree, { nodes: node.children, selectedPath: props.selectedPath, expanded: props.expanded, onToggle: props.onToggle, onSelect: props.onSelect })
						: null
				);
			}
			const selected = props.selectedPath === node.path;
			return h('li', { style: s.treeLi },
				h('button', {
					type: 'button',
					style: selected ? Object.assign({}, s.noteRow, s.noteRowSelected) : s.noteRow,
					title: node.path,
					'data-obsidian-note-item': '1',
					'data-obsidian-note-path': node.path,
					onClick: () => props.onSelect(node.path)
				},
					h('span', { style: s.noteName }, String(node.title || node.name || baseName(node.path))),
					h('span', { style: s.noteMeta }, String(node.path))
				)
			);
		}

		/* ── 笔记查看组件（纯展示，无 hooks） ──────────────────────────── */
		function NoteViewer(props) {
			const note = props.note;
			if (!note) return null;
			const tags = asArray(note.tags);
			return h('div', { style: s.noteWrap, 'data-obsidian-note': '1' },
				h('div', { style: s.noteHead },
					h('div', { style: s.noteHeadMain },
						h('h3', { style: s.noteTitle }, String(note.title || baseName(note.path))),
						h('div', { style: s.notePath, 'data-obsidian-note-path': String(note.path || '') }, String(note.path || '')),
						tags.length > 0
							? h('div', { style: s.tagRow }, tags.map((tag) => h('span', { key: 'tag:' + String(tag), style: s.tag, 'data-obsidian-tag': String(tag) }, '#' + String(tag))))
							: null
					),
					h('div', { style: s.noteActions },
						h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'edit', onClick: props.onEdit, disabled: Boolean(props.busy) }, '编辑'),
						h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'append', onClick: props.onAppendToggle, disabled: Boolean(props.busy) }, '追加'),
						h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'open', onClick: props.onOpen, disabled: Boolean(props.busy) }, '在 Obsidian 中打开'),
						h('button', { type: 'button', style: s.btnDanger, 'data-obsidian-action': 'trash', onClick: props.onTrash, disabled: Boolean(props.busy) }, '移回收站')
					)
				),
				note.truncated ? h('p', { style: s.muted }, '（文件较大，正文已截断显示；可点「在 Obsidian 中打开」查看全文。）') : null,
				h('pre', { style: s.noteBody }, String(note.content || '')),
				props.appendOpen
					? h('div', { style: s.inlinePanel },
						h('textarea', {
							style: s.textarea,
							rows: 4,
							value: props.appendDraft,
							placeholder: '要追加到笔记末尾的内容',
							'data-obsidian-append-input': '1',
							onChange: props.onAppendChange
						}),
						h('div', { style: s.rowRight },
							h('button', { type: 'button', style: s.btnPrimary, 'data-obsidian-action': 'append', 'data-obsidian-confirm': '1', onClick: props.onAppendSubmit, disabled: Boolean(props.busy) }, '确认追加'),
							h('button', { type: 'button', style: s.btn, 'data-obsidian-dismiss': 'append', onClick: props.onAppendCancel }, '取消')
						)
					)
					: null,
				props.trashConfirm
					? h('div', { style: s.dangerPanel, 'data-obsidian-confirm-trash': '1' },
						h('p', { style: { margin: 0, fontSize: '12.5px' } }, '确认把「' + String(note.title || note.path) + '」移入回收站？移入后可在 .trash 中找回。'),
						h('div', { style: s.rowRight },
							h('button', { type: 'button', style: s.btnDangerStrong, 'data-obsidian-action': 'trash', 'data-obsidian-confirm': '1', onClick: props.onTrashConfirm, disabled: Boolean(props.busy) }, '确认移入回收站'),
							h('button', { type: 'button', style: s.btn, 'data-obsidian-dismiss': 'trash', onClick: props.onTrashCancel }, '取消')
						)
					)
					: null
			);
		}

		/* ── 编辑器组件（纯展示，无 hooks） ────────────────────────────── */
		function NoteEditor(props) {
			const note = props.note;
			if (!note) return null;
			return h('div', { style: s.noteWrap, 'data-obsidian-note': '1', 'data-obsidian-editor': '1' },
				h('div', { style: s.noteHead },
					h('div', { style: s.noteHeadMain },
						h('h3', { style: s.noteTitle }, String(note.title || baseName(note.path))),
						h('div', { style: s.notePath, 'data-obsidian-note-path': String(note.path || '') }, String(note.path || '') + ' · 编辑中')
					)
				),
				h('textarea', {
					style: s.editor,
					value: props.draft,
					'data-obsidian-editor-input': '1',
					onChange: props.onChange
				}),
				h('div', { style: s.rowRight },
					h('span', { style: s.preview }, '保存会整篇覆盖正文（宿主会自动备份旧内容）'),
					h('button', { type: 'button', style: s.btnPrimary, 'data-obsidian-action': 'save', onClick: props.onSave, disabled: Boolean(props.busy) }, '保存'),
					h('button', { type: 'button', style: s.btn, 'data-obsidian-dismiss': 'edit', onClick: props.onCancel }, '取消')
				)
			);
		}

		/* ── 新建笔记表单（纯展示，无 hooks） ──────────────────────────── */
		function NewNoteForm(props) {
			const form = props.form || {};
			return h('div', { style: s.form, 'data-obsidian-new-form': '1' },
				h('h3', { style: s.formTitle }, '新建笔记'),
				h('label', { style: s.field },
					h('span', { style: s.label }, '路径（含目录，可省略 .md）'),
					h('input', {
						style: s.input,
						value: form.path || '',
						placeholder: '例如 01-笔记/新想法',
						'data-obsidian-new-path': '1',
						onChange: (event) => props.onField('path', event)
					})
				),
				h('label', { style: s.field },
					h('span', { style: s.label }, '标题（可选，会自动写成正文第一行 # 标题）'),
					h('input', {
						style: s.input,
						value: form.title || '',
						placeholder: '例如 新想法',
						'data-obsidian-new-title': '1',
						onChange: (event) => props.onField('title', event)
					})
				),
				h('label', { style: s.field },
					h('span', { style: s.label }, '内容'),
					h('textarea', {
						style: s.textarea,
						rows: 8,
						value: form.content || '',
						placeholder: '正文（可留空）',
						'data-obsidian-new-content': '1',
						onChange: (event) => props.onField('content', event)
					})
				),
				h('label', { style: s.field },
					h('span', { style: s.label }, '标签（逗号分隔，可留空）'),
					h('input', {
						style: s.input,
						value: form.tags || '',
						placeholder: '例如 工作, 想法',
						'data-obsidian-new-tags': '1',
						onChange: (event) => props.onField('tags', event)
					})
				),
				h('div', { style: s.rowRight },
					h('button', { type: 'button', style: s.btnPrimary, 'data-obsidian-action': 'new', 'data-obsidian-new-submit': '1', onClick: props.onSubmit, disabled: Boolean(props.busy) }, '创建笔记'),
					h('button', { type: 'button', style: s.btn, 'data-obsidian-dismiss': 'new', onClick: props.onCancel }, '取消')
				)
			);
		}

		/* ── 主面板 ────────────────────────────────────────────────────── */
		function ObsidianPage() {
			const [pageState, setPageState] = useState('loading');
			const [status, setStatus] = useState(null);
			const [entries, setEntries] = useState([]);
			const [pageError, setPageError] = useState('');
			const [banner, setBanner] = useState(null);
			const [reloadKey, setReloadKey] = useState(0);
			const [selectedPath, setSelectedPath] = useState(null);
			const [noteState, setNoteState] = useState({ status: 'idle' });
			const [noteReloadKey, setNoteReloadKey] = useState(0);
			const [searchQuery, setSearchQuery] = useState('');
			const [searchState, setSearchState] = useState({ status: 'idle', results: [] });
			const [expanded, setExpanded] = useState({});
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState('');
			const [appendOpen, setAppendOpen] = useState(false);
			const [appendDraft, setAppendDraft] = useState('');
			const [trashConfirm, setTrashConfirm] = useState(false);
			const [newOpen, setNewOpen] = useState(false);
			const [newForm, setNewForm] = useState({ path: '', title: '', content: '', tags: '' });
			const [busy, setBusy] = useState(false);
			const mountedRef = useRef(true);

			useEffect(() => {
				mountedRef.current = true;
				return () => { mountedRef.current = false; };
			}, []);

			/* ① 启动 / 刷新：GET status + GET tree；OK 后自动选中第一篇笔记。 */
			useEffect(() => {
				let alive = true;
				setPageState('loading');
				setPageError('');
				Promise.all([apiGet('/status'), apiGet('/tree?depth=3&limit=500')])
					.then((results) => {
						if (!alive) return;
						const statusResult = results[0];
						const treeResult = results[1];
						if (!isOk(statusResult)) {
							setPageState('error');
							setPageError(errorMessage(statusResult, '无法读取 Obsidian 仓库状态'));
							return;
						}
						const statusPayload = statusResult.payload;
						/* 宿主在 vault 不可用时仍返回 ok:true，但带 available:false + error（SPEC §5 + vault.status）。 */
						if (statusPayload.available === false || (statusPayload.error && typeof statusPayload.error === 'object')) {
							setPageState('error');
							setPageError(statusPayload.error && typeof statusPayload.error.message === 'string' && statusPayload.error.message
								? statusPayload.error.message
								: 'Obsidian 仓库不可用：请先在插件配置或环境变量 DSH_OBSIDIAN_VAULT 中指定 vault 路径。');
							return;
						}
						if (!isOk(treeResult)) {
							setPageState('error');
							setPageError(errorMessage(treeResult, '无法读取笔记目录'));
							return;
						}
						setStatus(statusResult.payload);
						const list = asArray(treeResult.payload.entries);
						setEntries(list);
						setPageState('ready');
						const firstNote = list.find((entry) => entry && entry.type === 'note' && typeof entry.path === 'string');
						if (firstNote) setSelectedPath((previous) => previous || firstNote.path);
					})
					.catch((error) => {
						if (!alive) return;
						setPageState('error');
						setPageError('加载面板失败：' + String((error && error.message) || error));
					});
				return () => { alive = false; };
			}, [reloadKey]);

			/* ② 选中笔记后 GET note。 */
			useEffect(() => {
				if (!selectedPath) return undefined;
				let alive = true;
				setNoteState({ status: 'loading' });
				apiGet('/note?path=' + encodeURIComponent(selectedPath))
					.then((result) => {
						if (!alive) return;
						const payload = result.payload;
						if (isOk(result) && payload && payload.note && typeof payload.note === 'object') {
							setNoteState({ status: 'ready', note: payload.note });
						} else {
							setNoteState({ status: 'error', error: errorMessage(result, '读取笔记失败') });
						}
					})
					.catch((error) => {
						if (!alive) return;
						setNoteState({ status: 'error', error: '读取笔记失败：' + String((error && error.message) || error) });
					});
				return () => { alive = false; };
			}, [selectedPath, noteReloadKey]);

			/* ③ 搜索：1 个字符只看本地树；2 个字符以上防抖后 GET search。 */
			useEffect(() => {
				const query = searchQuery.trim();
				if (query.length < 2) {
					setSearchState({ status: 'idle', results: [] });
					return undefined;
				}
				let alive = true;
				setSearchState({ status: 'loading', results: [] });
				const timer = setTimeout(() => {
					apiGet('/search?q=' + encodeURIComponent(query) + '&limit=50')
						.then((result) => {
							if (!alive) return;
							const payload = result.payload;
							if (isOk(result) && payload && Array.isArray(payload.results)) {
								setSearchState({ status: 'ready', results: payload.results });
							} else {
								setSearchState({ status: 'error', results: [], error: errorMessage(result, '搜索失败') });
							}
						})
						.catch((error) => {
							if (!alive) return;
							setSearchState({ status: 'error', results: [], error: '搜索失败：' + String((error && error.message) || error) });
						});
				}, 250);
				return () => { alive = false; clearTimeout(timer); };
			}, [searchQuery]);

			const currentNote = noteState.status === 'ready' && noteState.note && typeof noteState.note === 'object' ? noteState.note : null;
			const vaultPath = status && typeof status.vaultPath === 'string' ? status.vaultPath : '';
			const noteCount = status && typeof status.noteCount === 'number' ? status.noteCount : asArray(entries).filter((entry) => entry && entry.type === 'note').length;
			const treeNodes = buildTree(entries);
			const localQuery = searchQuery.trim().toLowerCase();
			const visibleNodes = localQuery ? filterTree(treeNodes, localQuery) : treeNodes;

			/* 静默刷新：只更新 status/tree，不把整页打回 loading。 */
			const reloadTreeSilently = () => {
				return Promise.all([apiGet('/status'), apiGet('/tree?depth=3&limit=500')])
					.then((results) => {
						if (!mountedRef.current) return;
						if (isOk(results[0])) setStatus(results[0].payload);
						if (isOk(results[1])) setEntries(asArray(results[1].payload.entries));
					})
					.catch(() => {});
			};

			/* 所有写操作的统一包装：busy 闸门 + 面板内错误横幅（不向外抛）。 */
			const runAction = (task) => {
				setBusy(true);
				setBanner(null);
				return Promise.resolve()
					.then(task)
					.catch((error) => {
						setBanner({ kind: 'error', text: '操作失败：' + String((error && error.message) || error) });
					})
					.then(() => {
						if (mountedRef.current) setBusy(false);
					});
			};

			const refresh = () => {
				setBanner(null);
				setReloadKey((value) => value + 1);
				setNoteReloadKey((value) => value + 1);
			};

			const selectNote = (path) => {
				if (typeof path !== 'string' || path.length === 0) return;
				setSelectedPath(path);
				setEditing(false);
				setAppendOpen(false);
				setTrashConfirm(false);
				setBanner(null);
			};

			const toggleFolder = (path) => {
				setExpanded((previous) => Object.assign({}, previous, { [path]: previous[path] === false ? true : false }));
			};

			const openDaily = () => {
				if (pageState !== 'ready') return;
				void runAction(() => apiPost('/daily', { mode: 'create' }).then((result) => {
					const daily = isOk(result) && result.payload.daily && typeof result.payload.daily === 'object' ? result.payload.daily : null;
					if (!daily || typeof daily.path !== 'string' || daily.path.length === 0) {
						setBanner({ kind: 'error', text: errorMessage(result, '打开今日日记失败') });
						return;
					}
					setSelectedPath(daily.path);
					setNoteReloadKey((value) => value + 1);
					setEditing(false);
					setAppendOpen(false);
					setTrashConfirm(false);
					setBanner({ kind: 'info', text: '已打开今日日记：' + daily.path });
					return reloadTreeSilently();
				}));
			};

			const openNewForm = () => {
				if (pageState !== 'ready') return;
				setNewOpen(true);
				setEditing(false);
				setAppendOpen(false);
				setTrashConfirm(false);
				setNewForm({ path: '', title: '', content: '', tags: '' });
				setBanner(null);
			};

			const changeNewField = (field, event) => {
				const value = event && event.currentTarget ? String(event.currentTarget.value || '') : '';
				setNewForm((previous) => Object.assign({}, previous, { [field]: value }));
			};

			const submitNewNote = () => {
				const path = String(newForm.path || '').trim();
				if (!path) {
					setBanner({ kind: 'error', text: '请先填写笔记路径。' });
					return;
				}
				const title = String(newForm.title || '').trim();
				let content = String(newForm.content || '');
				if (title && !/^#\s/.test(content.trim())) content = '# ' + title + '\n\n' + content;
				const tags = String(newForm.tags || '').split(/[,，、\s]+/).map((tag) => tag.replace(/^#/, '').trim()).filter((tag) => tag.length > 0);
				void runAction(() => apiPost('/note', { path, content, mode: 'create', tags }).then((result) => {
					const created = isOk(result) && result.payload.result && typeof result.payload.result === 'object' ? result.payload.result : null;
					if (!created) {
						setBanner({ kind: 'error', text: errorMessage(result, '创建笔记失败') });
						return;
					}
					const createdPath = typeof created.path === 'string' && created.path ? created.path : path;
					setNewOpen(false);
					setNewForm({ path: '', title: '', content: '', tags: '' });
					setBanner({ kind: 'info', text: '已创建笔记：' + createdPath });
					setSelectedPath(createdPath);
					setNoteReloadKey((value) => value + 1);
					setEditing(false);
					return reloadTreeSilently();
				}));
			};

			const startEdit = () => {
				if (!currentNote) return;
				setDraft(String(currentNote.content || ''));
				setEditing(true);
				setAppendOpen(false);
				setTrashConfirm(false);
				setBanner(null);
			};

			const cancelEdit = () => {
				setEditing(false);
				setDraft('');
			};

			const saveNote = () => {
				if (!currentNote) return;
				const path = String(currentNote.path || '');
				void runAction(() => apiPost('/note', { path, content: draft, mode: 'overwrite', backup: true }).then((result) => {
					if (!isOk(result)) {
						setBanner({ kind: 'error', text: errorMessage(result, '保存笔记失败') });
						return;
					}
					setEditing(false);
					setBanner({ kind: 'info', text: '已保存：' + path });
					setNoteReloadKey((value) => value + 1);
					return reloadTreeSilently();
				}));
			};

			const toggleAppend = () => {
				setAppendOpen((open) => !open);
				setAppendDraft('');
				setTrashConfirm(false);
			};

			const changeAppend = (event) => {
				setAppendDraft(event && event.currentTarget ? String(event.currentTarget.value || '') : '');
			};

			const submitAppend = () => {
				if (!currentNote) return;
				const path = String(currentNote.path || '');
				const content = String(appendDraft || '');
				if (content.trim().length === 0) {
					setBanner({ kind: 'error', text: '追加内容为空。' });
					return;
				}
				void runAction(() => apiPost('/note', { path, content: '\n\n' + content, mode: 'append', backup: true }).then((result) => {
					if (!isOk(result)) {
						setBanner({ kind: 'error', text: errorMessage(result, '追加失败') });
						return;
					}
					setAppendOpen(false);
					setAppendDraft('');
					setBanner({ kind: 'info', text: '已追加到：' + path });
					setNoteReloadKey((value) => value + 1);
					return reloadTreeSilently();
				}));
			};

			const openInObsidian = () => {
				if (!currentNote) return;
				const path = String(currentNote.path || '');
				void runAction(() => apiPost('/open', { path }).then((result) => {
					const opened = isOk(result) && result.payload.result && typeof result.payload.result === 'object' ? result.payload.result : null;
					if (!opened) {
						setBanner({ kind: 'error', text: errorMessage(result, '无法在 Obsidian 中打开') });
						return;
					}
					if (opened.opened === true) setBanner({ kind: 'info', text: '已在 Obsidian 中打开。' });
					else setBanner({ kind: 'error', text: typeof opened.hint === 'string' && opened.hint ? opened.hint : '无法唤起 Obsidian，请手动打开。' });
				}));
			};

			const askTrash = () => {
				setTrashConfirm(true);
				setAppendOpen(false);
			};

			const cancelTrash = () => setTrashConfirm(false);

			const confirmTrash = () => {
				if (!currentNote) return;
				const path = String(currentNote.path || '');
				void runAction(() => apiPost('/manage', { action: 'trash', path }).then((result) => {
					if (!isOk(result)) {
						setBanner({ kind: 'error', text: errorMessage(result, '移入回收站失败') });
						return;
					}
					setTrashConfirm(false);
					setSelectedPath(null);
					setNoteState({ status: 'idle' });
					setEditing(false);
					setAppendOpen(false);
					setBanner({ kind: 'info', text: '已移入回收站：' + path });
					return reloadTreeSilently();
				}));
			};

			/* ── 渲染 ──────────────────────────────────────────────────── */
			const header = h('div', { style: s.topbar, 'data-obsidian-topbar': '1' },
				h('div', { style: s.brand },
					h(PanelIcon, null),
					h('h2', { style: s.title, 'data-obsidian-title': '1' }, PANEL_LABEL)
				),
				h('div', { style: s.vaultBox, 'data-obsidian-vault': vaultPath, title: vaultPath || '正在读取仓库…' },
					h('span', { style: s.vaultPath }, vaultPath || '正在读取仓库…'),
					h('span', { style: s.count, 'data-obsidian-count': String(noteCount) }, noteCount + ' 篇笔记')
				),
				h('div', { style: s.actions },
					h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'refresh', onClick: refresh, disabled: Boolean(busy) }, '刷新'),
					h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'daily', onClick: openDaily, disabled: pageState !== 'ready' || Boolean(busy) }, '今日日记'),
					h('button', { type: 'button', style: s.btnPrimary, 'data-obsidian-action': 'new', onClick: openNewForm, disabled: pageState !== 'ready' || Boolean(busy) }, '新建笔记')
				)
			);

			const bannerNode = banner
				? h('p', banner.kind === 'error'
					? { style: s.bannerError, 'data-obsidian-error': String(banner.text) }
					: { style: s.bannerInfo, 'data-obsidian-message': String(banner.text) }, String(banner.text))
				: null;

			let body;
			if (pageState === 'loading') {
				body = h('div', { style: s.center, 'data-obsidian-loading': '1' },
					h('p', { style: s.muted }, '正在连接 Obsidian 仓库…')
				);
			} else if (pageState === 'error') {
				const text = pageError || '无法加载 Obsidian 仓库';
				body = h('div', { style: s.errorBox, 'data-obsidian-error': text },
					h('p', { style: s.errorText }, text),
					h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'refresh', 'data-obsidian-retry': '1', onClick: refresh }, '重试')
				);
			} else {
				const searchPanel = (() => {
					if (searchState.status === 'loading') return h('p', { style: s.sideNote }, '正在搜索…');
					if (searchState.status === 'error') return h('p', { style: s.sideNote, 'data-obsidian-error': String(searchState.error || '搜索失败') }, String(searchState.error || '搜索失败'));
					if (searchState.status !== 'ready') return null;
					if (searchState.results.length === 0) return h('p', { style: s.sideNote }, '没有匹配的笔记。');
					return h('div', { style: s.searchResults, 'data-obsidian-search-results': '1' },
						searchState.results.map((item) => {
							const path = String((item && item.path) || '');
							return h('button', {
								key: 'search:' + path,
								type: 'button',
								style: s.noteRow,
								title: path,
								'data-obsidian-search-result': '1',
								'data-obsidian-note-path': path,
								onClick: () => selectNote(path)
							},
								h('span', { style: s.noteName }, String((item && item.title) || baseName(path))),
								h('span', { style: s.noteMeta }, path + (item && typeof item.line === 'number' ? ' · 第 ' + item.line + ' 行' : '')),
								item && typeof item.snippet === 'string' && item.snippet ? h('span', { style: s.noteMeta }, item.snippet) : null
							);
						})
					);
				})();

				const side = h('aside', { style: s.side, 'data-obsidian-side': '1' },
					h('input', {
						type: 'search',
						style: s.search,
						value: searchQuery,
						placeholder: '搜索笔记（输入 2 个字符以上走服务器搜索）',
						'aria-label': '搜索笔记',
						'data-obsidian-search': '1',
						onChange: (event) => setSearchQuery(event && event.currentTarget ? String(event.currentTarget.value || '') : '')
					}),
					searchPanel,
					h('div', { style: s.tree, 'data-obsidian-tree': '1' },
						treeNodes.length === 0
							? h('p', { style: s.sideNote }, '仓库里还没有笔记，点右上角「新建笔记」开始。')
							: visibleNodes.length === 0
								? h('p', { style: s.sideNote }, '没有匹配的笔记。')
								: h(Tree, { nodes: visibleNodes, selectedPath, expanded, onToggle: toggleFolder, onSelect: selectNote })
					)
				);

				let main;
				if (newOpen) {
					main = h(NewNoteForm, { form: newForm, busy, onField: changeNewField, onSubmit: submitNewNote, onCancel: () => setNewOpen(false) });
				} else if (noteState.status === 'loading') {
					main = h('div', { style: s.center, 'data-obsidian-loading-note': '1' }, h('p', { style: s.muted }, '正在读取笔记…'));
				} else if (noteState.status === 'error') {
					const text = noteState.error || '读取笔记失败';
					main = h('div', { style: s.errorBox, 'data-obsidian-error': text },
						h('p', { style: s.errorText }, text),
						h('button', { type: 'button', style: s.btn, 'data-obsidian-action': 'refresh', onClick: () => setNoteReloadKey((value) => value + 1) }, '重试')
					);
				} else if (!currentNote) {
					main = h('div', { style: s.center, 'data-obsidian-empty': '1' },
						h('p', { style: s.muted }, '从左侧选择一篇笔记，或点击「新建笔记」。')
					);
				} else if (editing) {
					main = h(NoteEditor, {
						note: currentNote,
						draft,
						busy,
						onChange: (event) => setDraft(event && event.currentTarget ? String(event.currentTarget.value || '') : ''),
						onSave: saveNote,
						onCancel: cancelEdit
					});
				} else {
					main = h(NoteViewer, {
						note: currentNote,
						busy,
						appendOpen,
						appendDraft,
						trashConfirm,
						onEdit: startEdit,
						onAppendToggle: toggleAppend,
						onAppendChange: changeAppend,
						onAppendSubmit: submitAppend,
						onAppendCancel: () => { setAppendOpen(false); setAppendDraft(''); },
						onOpen: openInObsidian,
						onTrash: askTrash,
						onTrashConfirm: confirmTrash,
						onTrashCancel: cancelTrash
					});
				}

				body = h('div', { style: s.body }, side, h('main', { style: s.main, 'data-obsidian-main': '1' }, main));
			}

			return h('div', {
				style: s.root,
				'data-obsidian-panel': 'root',
				'data-obsidian-state': pageState,
				'data-obsidian-vault': vaultPath
			}, header, bannerNode, body);
		}

		/* ── 客户端入口 ────────────────────────────────────────────────── */
		function apply(ctx) {
			try {
				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: PANEL_ID,
					order: 6,
					label: () => PANEL_LABEL
				}, PanelIcon));
				ctx.slots.inject('main', function* () {
					yield ctx.slots.register({ name: 'main', key: PANEL_ID }, ObsidianPage);
				});
			} catch (error) {
				if (typeof console !== 'undefined' && console.error) console.error('[dsh-plugin-obsidian] 客户端面板注册失败', error);
			}
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	}
});
