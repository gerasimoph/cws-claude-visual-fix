// Element anchors: selector candidates captured at comment time and
// re-anchoring after reload/HMR (PRD §26): selectors → role + text.
(() => {
  'use strict';
  const BF = (globalThis.BF ||= {});
  if (BF.anchor) return;

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-component', 'data-slot'];
  const LABEL_ATTRS = ['aria-label', 'name', 'title', 'alt', 'placeholder', 'role'];
  // Generated class names (CSS modules, styled-components, emotion…) are unstable.
  const HASHED_CLASS = /^(css|sc|jsx|emotion|svelte|astro|tw)-[a-zA-Z0-9]{4,}$|__[a-zA-Z0-9_-]{5}$|^_[a-zA-Z0-9]{5,}$|^[a-zA-Z]{1,3}[0-9][a-zA-Z0-9]{4,}$/;

  function norm(s, max = 120) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function textOf(el) {
    if (!el) return '';
    return norm(el.innerText ?? el.textContent);
  }

  function isOwnUi(el) {
    return !!el?.closest?.('browser-feedback-root');
  }

  function idOk(id) {
    return !!id && id.length < 60 && !/^[:_]?r[0-9a-z]*:?$|^:|\d{3,}|^radix-|^headlessui-|^mui-/.test(id);
  }

  function stableClasses(el) {
    return [...(el.classList || [])].filter((c) => c.length < 48 && !HASHED_CLASS.test(c) && !/\d{4,}/.test(c));
  }

  function unique(selector, el) {
    try {
      const m = document.querySelectorAll(selector);
      return m.length === 1 && m[0] === el;
    } catch { return false; }
  }

  function attrSelector(tag, name, value) {
    return `${tag}[${name}="${CSS.escape(value)}"]`;
  }

  function structuralPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur !== el && idOk(cur.id) && unique(`#${CSS.escape(cur.id)}`, cur)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tag = cur.localName;
      const parent = cur.parentElement;
      if (!parent || tag === 'body') { parts.unshift(tag); break; }
      const same = [...parent.children].filter((c) => c.localName === tag);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function selectorCandidates(el) {
    const out = [];
    const tag = el.localName;
    const push = (kind, selector) => { if (!out.some((c) => c.selector === selector)) out.push({ kind, selector }); };

    if (idOk(el.id) && unique(`#${CSS.escape(el.id)}`, el)) push('id', `#${CSS.escape(el.id)}`);
    for (const a of TEST_ATTRS) {
      const v = el.getAttribute(a);
      if (v && unique(attrSelector(tag, a, v), el)) { push('test-id', attrSelector(tag, a, v)); break; }
    }
    for (const a of LABEL_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 80 && unique(attrSelector(tag, a, v), el)) { push('attr', attrSelector(tag, a, v)); break; }
    }
    const cls = stableClasses(el).slice(0, 4);
    if (cls.length) {
      const sel = tag + cls.map((c) => `.${CSS.escape(c)}`).join('');
      if (unique(sel, el)) push('class', sel);
      else if (el.parentElement) {
        const parentCls = stableClasses(el.parentElement).slice(0, 2);
        const parentSel = idOk(el.parentElement.id) ? `#${CSS.escape(el.parentElement.id)}` : el.parentElement.localName + parentCls.map((c) => `.${CSS.escape(c)}`).join('');
        if (unique(`${parentSel} > ${sel}`, el)) push('class', `${parentSel} > ${sel}`);
      }
    }
    push('path', structuralPath(el));
    return out;
  }

  const IMPLICIT_ROLES = {
    a: (el) => (el.hasAttribute('href') ? 'link' : null), button: () => 'button', nav: () => 'navigation', main: () => 'main',
    header: () => 'banner', footer: () => 'contentinfo', aside: () => 'complementary', form: () => 'form', img: () => 'img',
    ul: () => 'list', ol: () => 'list', li: () => 'listitem', table: () => 'table', select: () => 'combobox', textarea: () => 'textbox',
    h1: () => 'heading', h2: () => 'heading', h3: () => 'heading', h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    dialog: () => 'dialog', section: () => 'region', article: () => 'article',
    input: (el) => ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider', search: 'searchbox' }[el.type] || 'textbox'),
  };

  function roleOf(el) {
    return el.getAttribute('role') || IMPLICIT_ROLES[el.localName]?.(el) || null;
  }

  function accessibleName(el) {
    const label = el.getAttribute('aria-label');
    if (label) return norm(label, 80);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (norm(t)) return norm(t, 80);
    }
    if (el.id && el.labels?.length) return norm(el.labels[0].textContent, 80);
    return norm(el.getAttribute('alt') || el.getAttribute('title') || textOf(el), 80);
  }

  function create(el) {
    return {
      selectors: selectorCandidates(el),
      tag: el.localName,
      text: textOf(el),
      role: roleOf(el),
      name: accessibleName(el),
      path: location.pathname,
    };
  }

  // Returns { el, method } or null.
  function resolve(anchor) {
    if (!anchor) return null;
    let pathMatch = null;
    for (const c of anchor.selectors || []) {
      let m;
      try { m = document.querySelectorAll(c.selector); } catch { continue; }
      if (m.length !== 1 || m[0].localName !== anchor.tag || isOwnUi(m[0])) continue;
      if (c.kind !== 'path') return { el: m[0], method: c.kind };
      // Structural paths drift when siblings are inserted; only trust them
      // outright if the text still matches.
      if (!anchor.text || textOf(m[0]) === anchor.text) return { el: m[0], method: 'path' };
      pathMatch = m[0];
    }
    const byText = findByRoleAndText(anchor);
    if (byText) return { el: byText, method: 'text' };
    if (pathMatch) return { el: pathMatch, method: 'path-weak' };
    return null;
  }

  function findByRoleAndText(anchor) {
    if (!anchor.tag || (!anchor.text && !anchor.name)) return null;
    const all = document.getElementsByTagName(anchor.tag);
    if (all.length > 5000) return null;
    const hits = [];
    for (const el of all) {
      if (isOwnUi(el)) continue;
      if (anchor.text && textOf(el) === anchor.text) hits.push(el);
      else if (!anchor.text && anchor.name && accessibleName(el) === anchor.name) hits.push(el);
      if (hits.length > 1) return null;
    }
    return hits[0] || null;
  }

  BF.anchor = { create, resolve, textOf, roleOf, accessibleName, norm, isOwnUi, structuralPath };
})();
