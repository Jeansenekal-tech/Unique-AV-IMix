// Tiny DOM helpers: element builder, modals, floating panels, menus, toasts.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(msg, type = 'info', ms = 4000) {
  const el = h('div', { class: `toast ${type}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// Modal dialog. Returns { el, close, body }.
export function modal({ title, body, buttons = [], width, onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const foot = buttons.length
    ? h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', {
      class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
      onclick: async () => {
        const r = await b.onClick?.();
        if (r !== false) close();
      },
    }, b.label)))
    : null;
  const box = h('div', { class: 'modal', style: width ? { width: `${width}px` } : null },
    h('div', { class: 'modal-head' }, h('span', null, title), h('button', { class: 'x-btn', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    foot);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  return { el: box, close };
}

const panels = new Map();
// Non-modal floating panel (singleton per id). Returns { el, body, close }.
export function panel(id, { title, body, width = 420, x, y, onClose }) {
  if (panels.has(id)) {
    const p = panels.get(id);
    p.close();
    return null;
  }
  const close = () => {
    el.remove();
    panels.delete(id);
    onClose?.();
  };
  const head = h('div', { class: 'modal-head' }, h('span', null, title), h('button', { class: 'x-btn', onclick: close }, '×'));
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const el = h('div', { class: 'panel', style: { width: `${width}px`, left: `${x ?? window.innerWidth / 2 - width / 2}px`, top: `${y ?? 90}px` } }, head, bodyEl);
  let drag = null;
  head.addEventListener('mousedown', (e) => {
    drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    el.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
    el.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
  });
  window.addEventListener('mouseup', () => {
    drag = null;
  });
  document.body.append(el);
  const p = { el, body: bodyEl, close };
  panels.set(id, p);
  return p;
}

export function contextMenu(x, y, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu' }, items.map((it) => (it === '-'
    ? h('div', { class: 'menu-sep' })
    : h('div', {
      class: 'menu-item',
      onclick: () => {
        menu.remove();
        it.action();
      },
    }, it.label))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  setTimeout(() => {
    const off = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        window.removeEventListener('mousedown', off, true);
      }
    };
    window.addEventListener('mousedown', off, true);
  });
  return menu;
}

export function tabs(defs, initial = 0) {
  const bar = h('div', { class: 'tabs' });
  const content = h('div');
  const wrap = h('div', null, bar, content);
  const show = (i) => {
    [...bar.children].forEach((t, j) => t.classList.toggle('active', i === j));
    content.replaceChildren(defs[i].render());
  };
  defs.forEach((d, i) => bar.append(h('div', { class: 'tab', onclick: () => show(i) }, d.label)));
  show(initial);
  return wrap;
}

// Range slider row: label + range + value
export function slider(label, value, { min = 0, max = 1, step = 0.01, fmt = (v) => Number(v).toFixed(2), onInput }) {
  const val = h('span', { class: 'val' }, fmt(value));
  const input = h('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      val.textContent = fmt(e.target.value);
      onInput(Number(e.target.value));
    },
  });
  return [h('label', null, label), h('div', { class: 'row' }, input, val)];
}

export function fmtTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

export function fmtShort(ms) {
  const t = Math.max(0, ms / 1000);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${Math.floor((t * 10) % 10)}`;
}

export function hexToRgb01(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgb01ToHex(c) {
  return `#${c.slice(0, 3).map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

// window.prompt() is not available in Electron – modal replacement.
export function promptText(title, value = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value, style: { width: '100%' } });
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const m = modal({
      title,
      body: input,
      width: 420,
      onClose: () => finish(null),
      buttons: [{ label: 'Cancel', onClick: () => finish(null) }, { label: 'OK', primary: true, onClick: () => finish(input.value) }],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        finish(input.value);
        m.close();
      }
    });
    setTimeout(() => input.select());
  });
}
