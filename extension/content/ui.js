// In-page UI, isolated in a shadow root: selection highlight, comment
// composer, pins and the Review panel (PRD §16–17, §25). Pure view layer —
// all state and decisions live in main.js.
(() => {
  'use strict';
  const BF = (globalThis.BF ||= {});
  if (BF.UI) return;

  const STATUS_LABEL = {
    open: 'Open', sent: 'Sent to Claude', queued: 'Queued', working: 'Working', verifying: 'Verifying', fixed: 'Fixed',
    changed_check: 'Changed — check', no_change: 'No change', failed: 'Failed', accepted: 'Accepted',
  };
  const STATUS_ICON = { fixed: '✓', changed_check: '!', no_change: '–', failed: '×', accepted: '✓' };
  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl';

  const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; }
.hl { position: fixed; border: 2px solid #6366f1; background: rgba(99,102,241,.08); border-radius: 3px; pointer-events: none; display: none; }
.hl.ref { border-color: #f59e0b; background: rgba(245,158,11,.1); }
.hl.flash { border-color: #10b981; background: rgba(16,185,129,.12); }
.hl-label { position: absolute; top: -22px; left: -2px; background: #6366f1; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 3px; white-space: nowrap; }
.hl.ref .hl-label { background: #f59e0b; }
.ref-box { position: fixed; border: 2px dashed #f59e0b; border-radius: 3px; pointer-events: none; display: none; }
.pin { position: fixed; pointer-events: auto; cursor: pointer; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px 11px 11px 2px;
  display: flex; align-items: center; justify-content: center; gap: 3px; font-size: 12px; font-weight: 600; color: #fff; background: #111827;
  box-shadow: 0 1px 4px rgba(0,0,0,.35); border: 2px solid #fff; transform: translate(-4px, -18px); user-select: none; }
.pin[data-status=queued] { background: #6b7280; }
.pin[data-status=sent] { background: #4f46e5; }
.pin[data-status=working], .pin[data-status=verifying] { background: #2563eb; animation: pulse 1.2s ease-in-out infinite; }
.pin[data-status=verifying] { background: #7c3aed; }
.pin[data-status=fixed] { background: #059669; }
.pin[data-status=changed_check] { background: #d97706; }
.pin[data-status=no_change] { background: #6b7280; }
.pin[data-status=failed] { background: #dc2626; }
.pin[data-status=accepted] { background: #059669; opacity: .55; }
@keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(37,99,235,.25); } }
.card { position: fixed; pointer-events: auto; width: 320px; background: #fff; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06); padding: 10px; }
.card textarea { width: 100%; min-height: 64px; max-height: 200px; resize: vertical; border: 1px solid #d1d5db; border-radius: 6px; padding: 7px 8px; font: inherit; color: inherit; outline: none; }
.card textarea:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
.card .title { font-weight: 600; margin-bottom: 6px; display: flex; justify-content: space-between; gap: 8px; }
.card .target { color: #6b7280; font-size: 11px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.card .target span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .target button { flex: none; font-size: 11px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.hint { color: #9ca3af; font-size: 11px; }
.chip { display: inline-flex; align-items: center; gap: 4px; background: #fef3c7; color: #92400e; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: #111827; padding: 4px 9px; }
button:hover { background: #f3f4f6; }
button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; font-weight: 600; }
button.primary:hover { background: #4338ca; }
button.primary:disabled { background: #a5b4fc; border-color: #a5b4fc; cursor: default; }
button.link { border: none; background: none; color: #4f46e5; padding: 2px 4px; }
button.link:hover { text-decoration: underline; background: none; }
button.icon { border: none; background: none; padding: 0 4px; color: #6b7280; font-size: 15px; line-height: 1; }
.panel { position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: min(70vh, 560px); display: flex; flex-direction: column; pointer-events: auto;
  background: #fff; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06); overflow: hidden; }
.panel.collapsed .body, .panel.collapsed .foot, .panel.collapsed .conn { display: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f3f4f6; }
.head .name { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .count { color: #6b7280; font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
.dot.ok { background: #10b981; } .dot.warn { background: #f59e0b; } .dot.error { background: #ef4444; }
.conn { padding: 8px 12px; font-size: 12px; background: #f9fafb; border-bottom: 1px solid #f3f4f6; }
.conn.warn { background: #fffbeb; } .conn.error { background: #fef2f2; }
.conn .note { display: block; margin-top: 4px; color: #6b7280; }
.conn code { display: block; margin: 5px 0; padding: 5px 7px; background: #111827; color: #e5e7eb; border-radius: 5px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
.body { overflow-y: auto; flex: 1; }
.empty { padding: 18px 14px; color: #6b7280; font-size: 12px; text-align: center; }
.empty kbd { border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font: 11px ui-monospace, monospace; background: #fff; }
.item { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; cursor: pointer; }
.item:hover { background: #f9fafb; }
.item .line { display: flex; gap: 8px; align-items: flex-start; }
.item .n { font-weight: 600; color: #4f46e5; flex: none; }
.item .text { flex: 1; overflow-wrap: anywhere; }
.badge { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 9px; background: #f3f4f6; color: #374151; white-space: nowrap; }
.badge[data-status=sent] { background: #e0e7ff; color: #4338ca; }
.badge[data-status=working] { background: #dbeafe; color: #1d4ed8; } .badge[data-status=verifying] { background: #ede9fe; color: #6d28d9; }
.badge[data-status=fixed], .badge[data-status=accepted] { background: #d1fae5; color: #047857; }
.badge[data-status=changed_check] { background: #fef3c7; color: #b45309; } .badge[data-status=failed] { background: #fee2e2; color: #b91c1c; }
.meta { color: #6b7280; font-size: 11px; margin: 3px 0 0 18px; }
.summary { margin: 4px 0 0 18px; font-size: 12px; color: #374151; }
.diffs { margin: 3px 0 0 18px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #4b5563; }
.actions { margin: 4px 0 0 14px; display: flex; gap: 2px; }
.item .actions.secondary { display: none; }
.item:hover .actions.secondary { display: flex; }
.foot { padding: 10px 12px; display: flex; align-items: center; gap: 8px; border-top: 1px solid #f3f4f6; }
.fix-target { padding: 8px 12px 0; border-top: 1px solid #f3f4f6; font-size: 12px; color: #6b7280; }
.fix-target label { display: flex; align-items: center; gap: 6px; }
.fix-target select { flex: 1; min-width: 0; font: inherit; color: #111827; border: 1px solid #d1d5db; border-radius: 6px; padding: 3px 6px; background: #fff; }
.fix-target .warn { margin-top: 5px; color: #b45309; }
.fix-target + .foot { border-top: none; }
.foot .spacer { flex: 1; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #111827; color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity .2s; max-width: 80vw; }
.toast.show { opacity: 1; }
.selecting-tip { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #111827; color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; display: none; }
`;

  class UI {
    constructor(emit) {
      this.emit = emit;
      this.host = document.createElement('browser-feedback-root');
      this.host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${STYLES}</style><div class="layer">
        <div class="pins"></div>
        <div class="ref-box"></div>
        <div class="hl"><div class="hl-label"></div></div>
        <div class="selecting-tip">Click an element to comment · ↑ parent · ↓ child · Esc cancel</div>
        <div class="panel-slot"></div>
        <div class="card-slot"></div>
        <div class="toast"></div>
      </div>`;
      this.$ = (s) => this.root.querySelector(s);
      for (const type of ['keydown', 'keyup', 'keypress', 'input', 'wheel']) this.host.addEventListener(type, (e) => e.stopPropagation());
      this.root.addEventListener('click', (e) => this.onClick(e));
      this.root.addEventListener('change', (e) => {
        const el = e.composedPath()[0];
        if (el?.dataset?.act === 'target') { el.blur(); this.emit('target:change', { id: el.value }); }
      });
      this.mount();
    }

    mount() {
      if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    }

    contains(node) {
      return node === this.host || this.host.contains(node);
    }

    setHidden(hidden) {
      this.host.style.visibility = hidden ? 'hidden' : '';
    }

    // ---- highlight -----------------------------------------------------------

    showHighlight(el, { kind = 'select', text } = {}) {
      const hl = this.$('.hl');
      if (!el) { hl.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      hl.className = `hl${kind === 'ref' ? ' ref' : kind === 'flash' ? ' flash' : ''}`;
      const lbl = this.$('.hl-label');
      lbl.textContent = text || `${BF.capture.label(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      lbl.style.top = r.top < 26 ? `${r.height + 4}px` : '-22px';
    }

    hideHighlight() { this.$('.hl').style.display = 'none'; }

    flash(el) {
      this.showHighlight(el, { kind: 'flash' });
      clearTimeout(this._flashT);
      this._flashT = setTimeout(() => this.hideHighlight(), 1200);
    }

    showReferenceBox(el) {
      const box = this.$('.ref-box');
      if (!el) { box.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    }

    setSelecting(on, tip) {
      const t = this.$('.selecting-tip');
      t.style.display = on ? 'block' : 'none';
      if (tip) t.textContent = tip;
    }

    // ---- composer --------------------------------------------------------------

    openComposer(el, { reference = null, draft = '', sendHint = 'fix now' } = {}) {
      const slot = this.$('.card-slot');
      slot.innerHTML = `<div class="card composer">
        <div class="target"><span>${esc(BF.capture.summary(el))}</span><button class="link" data-act="composer-parent" title="Comment on the parent element instead">↑ Parent</button></div>
        <textarea placeholder="What should change?">${esc(draft)}</textarea>
        <div class="row">
          <span>${reference ? `<span class="chip">ref: ${esc(BF.capture.label(reference))} <button class="icon" data-act="ref-clear" title="Remove reference">×</button></span>` : `<button class="link" data-act="ref-pick" title="Point at another element, e.g. 'same height as this one'">+ Reference element</button>`}</span>
          <span class="hint">↵ add · ${MOD}↵ ${esc(sendHint)}</span>
        </div>
      </div>`;
      const card = slot.firstElementChild;
      this.place(card, el.getBoundingClientRect());
      const ta = card.querySelector('textarea');
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.emit('composer:cancel'); }
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          const text = ta.value.trim();
          if (text) this.emit('composer:submit', { text, send: e.metaKey || e.ctrlKey });
        }
      });
      ta.addEventListener('input', () => this.emit('composer:draft', { text: ta.value }));
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    }

    // ---- pin card --------------------------------------------------------------

    openPinCard(view, rect) {
      const slot = this.$('.card-slot');
      slot.innerHTML = `<div class="card pin-card">
        <div class="title"><span>${esc(CIRCLED[view.n - 1] || view.n)} ${esc(view.instruction)}</span><button class="icon" data-act="card-close">×</button></div>
        ${this.itemDetails(view)}
        <div class="row"><span class="badge" data-status="${view.status}">${esc(STATUS_LABEL[view.status])}</span><span>${this.itemActions(view)}</span></div>
      </div>`;
      this.place(slot.firstElementChild, rect || { left: innerWidth / 2 - 160, top: innerHeight / 3, bottom: innerHeight / 3, width: 0, height: 0 });
    }

    closeCard() { this.$('.card-slot').innerHTML = ''; }
    hasCard() { return !!this.$('.card-slot').firstElementChild; }
    cardIs(kind) { return !!this.$(`.card-slot .${kind}`); }

    place(card, r) {
      const w = 320;
      const h = card.offsetHeight || 140;
      let top = r.bottom + 8;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 8);
      const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    }

    // ---- pins ------------------------------------------------------------------

    renderPins(pins) {
      const layer = this.$('.pins');
      const seen = new Set();
      for (const p of pins) {
        seen.add(p.id);
        let node = layer.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
        if (!node) {
          node = document.createElement('div');
          node.className = 'pin';
          node.dataset.id = p.id;
          node.dataset.act = 'pin';
          layer.appendChild(node);
        }
        const content = `${p.n}${STATUS_ICON[p.status] ? ` ${STATUS_ICON[p.status]}` : ''}`;
        if (node.textContent !== content) node.textContent = content;
        node.dataset.status = p.status;
        node.title = `${STATUS_LABEL[p.status]} — ${p.instruction}`;
        if (!p.rect || p.rect.bottom < 0 || p.rect.top > innerHeight) { node.style.display = 'none'; continue; }
        node.style.display = 'flex';
        node.style.left = `${Math.min(innerWidth - 30, Math.max(4, p.rect.right - 10))}px`;
        node.style.top = `${Math.max(20, p.rect.top)}px`;
      }
      for (const node of [...layer.children]) if (!seen.has(node.dataset.id)) node.remove();
    }

    // ---- panel -----------------------------------------------------------------

    renderPanel(state) {
      const slot = this.$('.panel-slot');
      if (!state.open) { slot.innerHTML = ''; this._panelHtml = null; return; }
      // Don't rebuild while the session dropdown is open or nothing changed.
      if (this.root.activeElement?.dataset?.act === 'target') return;
      const scroll = slot.querySelector('.body')?.scrollTop || 0;
      const c = state.connection;
      const html = `<div class="panel${state.collapsed ? ' collapsed' : ''}">
        <div class="head">
          <span class="dot ${c.kind}"></span>
          <span class="name">Review · ${esc(state.title)}</span>
          <span class="count">${esc(state.countText)}</span>
          <button class="icon" data-act="panel-collapse" title="${state.collapsed ? 'Expand' : 'Collapse'}">${state.collapsed ? '▴' : '▾'}</button>
          <button class="icon" data-act="panel-close" title="Hide panel">×</button>
        </div>
        ${(c.text && c.text.trim()) || c.note ? `<div class="conn ${c.kind}">${esc(c.text)}${c.command ? `<code>${esc(c.command)}</code>` : ''}${(c.actions || []).map((a) => `<button class="link" data-act="conn" data-id="${esc(a.id)}">${esc(a.label)}</button>`).join(' ')}${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}</div>` : ''}
        <div class="body">${state.items.length ? state.items.map((v) => this.itemHtml(v)).join('') : `<div class="empty"><kbd>${isMac ? '⌥' : 'Alt'}</kbd> + click any element and write what should change.<br>Then <b>Copy for Claude</b> and paste it into Claude.<br>In DevTools device mode: <kbd>${isMac ? '⌥' : 'Alt'}⇧C</kbd>, then tap.</div>`}</div>
        ${state.target ? `<div class="fix-target"><label>Fix all →<select data-act="target">${state.target.options.map((o) => `<option value="${esc(o.id)}"${o.id === state.target.selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>${state.target.warning ? `<div class="warn">${esc(state.target.warning)}</div>` : ''}</div>` : ''}
        <div class="foot">
          <button class="primary" data-act="copy-md" ${state.copyCount ? '' : 'disabled'} title="Copy the comments with instructions, then paste into Claude">Copy for Claude${state.copyCount ? ` (${state.copyCount})` : ''}</button>
          ${state.running ? `<button disabled>Running ${state.running.done}/${state.running.total}</button>` : state.showFixAll ? `<button data-act="fix-all" ${state.fixAllCount ? '' : 'disabled'} title="Send to your Claude Code session directly">Fix all${state.fixAllCount ? ` (${state.fixAllCount})` : ''}</button>` : ''}
          <span class="spacer"></span>
          ${state.hasDone ? '<button class="link" data-act="clear-done" title="Remove accepted and closed comments">Clear done</button>' : ''}
        </div>
      </div>`;
      if (html === this._panelHtml && slot.firstElementChild) return;
      this._panelHtml = html;
      slot.innerHTML = html;
      const body = slot.querySelector('.body');
      if (body) body.scrollTop = scroll;
    }

    itemHtml(v) {
      return `<div class="item" data-act="item" data-id="${esc(v.id)}">
        <div class="line"><span class="n">${v.n}</span><span class="text">${esc(v.instruction)}</span><span class="badge" data-status="${v.status}">${esc(STATUS_LABEL[v.status])}</span></div>
        ${v.meta ? `<div class="meta">${esc(v.meta)}</div>` : ''}
        ${this.itemDetails(v)}
        ${this.itemActions(v) ? `<div class="actions${v.canAccept ? '' : ' secondary'}">${this.itemActions(v)}</div>` : ''}
      </div>`;
    }

    itemDetails(v) {
      let html = '';
      if (v.summary) html += `<div class="summary">${esc(v.summary)}</div>`;
      if (v.statusDetail && v.status !== 'fixed') html += `<div class="meta">${esc(v.statusDetail)}</div>`;
      if (v.diffs?.length) html += `<div class="diffs">${v.diffs.slice(0, 4).map((d) => `${esc(d.prop)}: ${esc(short(d.before))} → ${esc(short(d.after))}`).join('<br>')}</div>`;
      return html;
    }

    itemActions(v) {
      const a = [];
      if (v.canAccept) a.push(`<button class="link" data-act="accept" data-id="${esc(v.id)}">Accept</button>`);
      if (v.canRetry) a.push(`<button class="link" data-act="retry" data-id="${esc(v.id)}">Reopen</button>`);
      if (v.canDelete) a.push(`<button class="link" data-act="delete" data-id="${esc(v.id)}">Delete</button>`);
      return a.join('');
    }

    // ---- toast -----------------------------------------------------------------

    toast(text, ms = 2600) {
      const t = this.$('.toast');
      t.textContent = text;
      t.classList.add('show');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.remove('show'), ms);
    }

    onClick(e) {
      const target = e.composedPath().find((n) => n instanceof Element && n.dataset?.act);
      if (!target) return;
      e.stopPropagation();
      const { act, id } = target.dataset;
      const map = {
        pin: 'pin:click', item: 'item:focus', accept: 'item:accept', delete: 'item:delete', retry: 'item:retry',
        'fix-all': 'panel:fixall', 'copy-md': 'panel:copy', 'clear-done': 'panel:clearDone', 'panel-close': 'panel:close',
        'panel-collapse': 'panel:collapse', conn: 'conn:action', 'card-close': 'card:close', 'ref-pick': 'composer:pickReference', 'composer-parent': 'composer:parent', 'ref-clear': 'composer:clearReference',
      };
      if (map[act]) this.emit(map[act], { id, rect: target.getBoundingClientRect() });
    }
  }

  function short(v) {
    const s = String(v ?? '');
    return s.length > 40 ? `${s.slice(0, 40)}…` : s || '∅';
  }

  BF.UI = UI;
  BF.STATUS_LABEL = STATUS_LABEL;
})();
