// Title / graphics templates, drawn with Canvas 2D at 1920×1080 design size
// and scaled to the output resolution.

export const DEFAULT_TITLE_STYLE = {
  font: 'Helvetica Neue',
  accent: '#e63946',
  primary: '#14213d',
  text: '#ffffff',
  bgOpacity: 0.9,
  animate: true,
  align: 'left',
  speed: 160, // ticker px/s
};

const fmt2 = (n) => String(Math.floor(n)).padStart(2, '0');

export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${fmt2(m)}:${fmt2(s)}` : `${fmt2(m)}:${fmt2(s)}`;
}

export function parseDuration(text) {
  const parts = String(text || '0').trim().split(':').map((x) => parseFloat(x) || 0);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s * 1000;
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function font(style, size, weight = 700) {
  return `${weight} ${size}px "${style.font}", "Helvetica Neue", Helvetica, Arial, sans-serif`;
}

function fitText(ctx, text, maxWidth, style, size, weight) {
  let s = size;
  ctx.font = font(style, s, weight);
  while (s > 12 && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = font(style, s, weight);
  }
  return s;
}

const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// Each template: fields[], draw(ctx, f, style, env) where env = { a (0..1 intro), now, state }
export const TITLE_TEMPLATES = {
  'Lower Third': {
    fields: [['Name', 'Jane Citizen'], ['Title', 'Producer, Unique AV']],
    animated: true,
    draw(ctx, f, st, { a }) {
      const e = easeOut(a);
      const x0 = st.align === 'right' ? 1920 - 120 - 900 : st.align === 'center' ? 510 : 120;
      const x = x0 - (1 - e) * 60;
      ctx.globalAlpha = e;
      const nameSize = fitText(ctx, f.Name, 820, st, 64);
      const w = Math.max(520, ctx.measureText(f.Name).width + 80);
      ctx.fillStyle = hexToRgba(st.accent, st.bgOpacity);
      ctx.fillRect(x, 820, w * e, 92);
      ctx.fillStyle = st.text;
      ctx.textBaseline = 'middle';
      ctx.font = font(st, nameSize);
      ctx.fillText(f.Name, x + 40, 868);
      fitText(ctx, f.Title, 820, st, 38, 500);
      const w2 = Math.max(420, ctx.measureText(f.Title).width + 80);
      ctx.fillStyle = hexToRgba(st.primary, st.bgOpacity);
      ctx.fillRect(x, 912, w2 * e, 64);
      ctx.fillStyle = st.text;
      ctx.fillText(f.Title, x + 40, 945);
    },
  },
  'Lower Third Modern': {
    fields: [['Name', 'Jane Citizen'], ['Title', 'Live from the studio']],
    animated: true,
    draw(ctx, f, st, { a }) {
      const e = easeOut(a);
      const x = st.align === 'right' ? 1920 - 140 - 820 : st.align === 'center' ? 550 : 140;
      ctx.globalAlpha = e;
      ctx.fillStyle = hexToRgba('#ffffff', st.bgOpacity);
      const h = 150;
      const y = 800 + (1 - e) * 40;
      ctx.fillRect(x, y, 820, h);
      ctx.fillStyle = st.accent;
      ctx.fillRect(x, y, 14, h);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = st.primary;
      fitText(ctx, f.Name, 760, st, 60);
      ctx.fillText(f.Name, x + 44, y + 72);
      ctx.fillStyle = '#555';
      fitText(ctx, f.Title, 760, st, 34, 500);
      ctx.fillText(f.Title, x + 44, y + 122);
    },
  },
  Headline: {
    fields: [['Headline', 'BREAKING NEWS'], ['Subtitle', 'Live coverage continues']],
    animated: true,
    draw(ctx, f, st, { a }) {
      const e = easeOut(a);
      ctx.globalAlpha = e;
      const g = ctx.createLinearGradient(0, 0, 0, 1080);
      g.addColorStop(0, hexToRgba(st.primary, st.bgOpacity));
      g.addColorStop(1, hexToRgba('#000000', st.bgOpacity));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = st.accent;
      ctx.fillRect(960 - 200 * e, 600, 400 * e, 8);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = st.text;
      fitText(ctx, f.Headline, 1700, st, 140, 800);
      ctx.fillText(f.Headline, 960, 560);
      fitText(ctx, f.Subtitle, 1600, st, 56, 400);
      ctx.fillText(f.Subtitle, 960, 690);
    },
  },
  Ticker: {
    fields: [['Label', 'LATEST'], ['Text', 'Welcome to Unique AV IMix  •  Add your headlines here  •  Scrolling ticker template']],
    animated: false,
    continuous: true,
    draw(ctx, f, st, { now, state }) {
      const y = 990;
      const h = 70;
      ctx.fillStyle = hexToRgba(st.primary, st.bgOpacity);
      ctx.fillRect(0, y, 1920, h);
      ctx.font = font(st, 38, 600);
      ctx.textBaseline = 'middle';
      const text = `${f.Text}     `;
      const tw = Math.max(1, ctx.measureText(text).width);
      if (state.tickerStart == null) state.tickerStart = now;
      const off = (((now - state.tickerStart) / 1000) * st.speed) % tw;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, 1920, h);
      ctx.clip();
      ctx.fillStyle = st.text;
      for (let x = 1920 - off - tw * Math.ceil(1920 / tw); x < 1920; x += tw) {
        if (x + tw > 0) ctx.fillText(text, x, y + h / 2);
      }
      ctx.restore();
      ctx.font = font(st, 36, 800);
      const lw = ctx.measureText(f.Label).width + 60;
      ctx.fillStyle = st.accent;
      ctx.fillRect(0, y, lw, h);
      ctx.fillStyle = st.text;
      ctx.fillText(f.Label, 30, y + h / 2);
    },
  },
  Clock: {
    fields: [['Label', ''], ['Format', '24h']],
    animated: false,
    continuous: true,
    draw(ctx, f, st) {
      const d = new Date();
      let h = d.getHours();
      let suffix = '';
      if (String(f.Format).toLowerCase().startsWith('12')) {
        suffix = h >= 12 ? ' PM' : ' AM';
        h = h % 12 || 12;
      }
      const t = `${fmt2(h)}:${fmt2(d.getMinutes())}:${fmt2(d.getSeconds())}${suffix}`;
      const label = f.Label ? `${f.Label}  ` : '';
      ctx.font = font(st, 54, 700);
      const w = ctx.measureText(label + t).width + 60;
      ctx.fillStyle = hexToRgba(st.primary, st.bgOpacity);
      ctx.fillRect(1920 - 60 - w, 50, w, 90);
      ctx.fillStyle = st.text;
      ctx.textBaseline = 'middle';
      ctx.fillText(label + t, 1920 - 60 - w + 30, 97);
    },
  },
  Countdown: {
    fields: [['Label', 'Starting in'], ['Duration', '05:00']],
    animated: false,
    continuous: true,
    draw(ctx, f, st, { state, now }) {
      const total = parseDuration(f.Duration);
      const elapsed = (state.cdElapsed || 0) + (state.cdRunning ? now - state.cdStartedAt : 0);
      const remaining = Math.max(0, total - elapsed);
      if (state.cdRunning && remaining <= 0) state.cdRunning = false;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = hexToRgba(st.primary, st.bgOpacity * 0.6);
      ctx.fillRect(560, 340, 800, 400);
      ctx.fillStyle = st.text;
      ctx.font = font(st, 56, 500);
      ctx.fillText(f.Label, 960, 450);
      ctx.font = font(st, 220, 800);
      ctx.fillStyle = remaining <= 10000 && remaining > 0 ? st.accent : st.text;
      ctx.fillText(formatDuration(remaining), 960, 660);
    },
  },
  Scoreboard: {
    fields: [['Home', 'HOME'], ['HomeScore', '0'], ['Away', 'AWAY'], ['AwayScore', '0'], ['Period', '1st'], ['Clock', '12:00']],
    animated: true,
    draw(ctx, f, st, { a }) {
      const e = easeOut(a);
      ctx.globalAlpha = e;
      const x = 80;
      const y = 60 - (1 - e) * 30;
      ctx.fillStyle = hexToRgba(st.primary, st.bgOpacity);
      ctx.fillRect(x, y, 760, 80);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = st.text;
      ctx.font = font(st, 38, 700);
      ctx.textAlign = 'left';
      ctx.fillText(String(f.Home).slice(0, 10), x + 24, y + 40);
      ctx.fillStyle = st.accent;
      ctx.fillRect(x + 220, y + 8, 84, 64);
      ctx.fillRect(x + 504, y + 8, 84, 64);
      ctx.fillStyle = st.text;
      ctx.textAlign = 'center';
      ctx.font = font(st, 46, 800);
      ctx.fillText(f.HomeScore, x + 262, y + 42);
      ctx.fillText(f.AwayScore, x + 546, y + 42);
      ctx.font = font(st, 38, 700);
      ctx.textAlign = 'right';
      ctx.fillText(String(f.Away).slice(0, 10), x + 490, y + 40);
      ctx.textAlign = 'center';
      ctx.font = font(st, 30, 600);
      ctx.fillText(f.Period, x + 640, y + 24);
      ctx.fillText(f.Clock, x + 640, y + 58);
    },
  },
  'Corner Bug': {
    fields: [['Text', 'LIVE']],
    animated: true,
    draw(ctx, f, st, { a, now }) {
      ctx.globalAlpha = easeOut(a);
      ctx.font = font(st, 44, 800);
      const w = ctx.measureText(f.Text).width + 90;
      ctx.fillStyle = hexToRgba(st.accent, st.bgOpacity);
      ctx.fillRect(1920 - 60 - w, 50, w, 76);
      ctx.fillStyle = st.text;
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      ctx.globalAlpha *= 0.6 + 0.4 * pulse;
      ctx.beginPath();
      ctx.arc(1920 - 60 - w + 34, 88, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = easeOut(a);
      ctx.textBaseline = 'middle';
      ctx.fillText(f.Text, 1920 - 60 - w + 58, 90);
    },
    continuous: true,
  },
  'Plain Text': {
    fields: [['Text', 'Your text here']],
    animated: true,
    draw(ctx, f, st, { a }) {
      ctx.globalAlpha = easeOut(a);
      ctx.textAlign = st.align === 'right' ? 'right' : st.align === 'left' ? 'left' : 'center';
      const x = st.align === 'right' ? 1820 : st.align === 'left' ? 100 : 960;
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = st.text;
      const lines = String(f.Text).split('\n');
      const size = fitText(ctx, lines.reduce((m, l) => (l.length > m.length ? l : m), ''), 1720, st, 96, 800);
      lines.forEach((line, i) => ctx.fillText(line, x, 540 + (i - (lines.length - 1) / 2) * size * 1.2));
    },
  },
  'Full Screen Slate': {
    fields: [['Title', 'We will be right back'], ['Message', 'Stay tuned']],
    animated: true,
    draw(ctx, f, st, { a, now }) {
      ctx.globalAlpha = easeOut(a);
      const g = ctx.createLinearGradient(0, 0, 1920, 1080);
      g.addColorStop(0, st.primary);
      g.addColorStop(1, st.accent);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let i = 0; i < 12; i++) {
        const r = 120 + i * 90 + ((now / 40) % 90);
        ctx.beginPath();
        ctx.arc(960, 540, r, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = st.text;
      ctx.textBaseline = 'alphabetic';
      fitText(ctx, f.Title, 1700, st, 120, 800);
      ctx.fillText(f.Title, 960, 520);
      fitText(ctx, f.Message, 1600, st, 52, 400);
      ctx.fillText(f.Message, 960, 620);
    },
    continuous: true,
  },
};

export function renderTitle(ctx, W, H, templateName, fields, style, env) {
  const tpl = TITLE_TEMPLATES[templateName] || TITLE_TEMPLATES['Plain Text'];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(W / 1920, H / 1080);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  try {
    tpl.draw(ctx, fields, { ...DEFAULT_TITLE_STYLE, ...style }, env);
  } finally {
    ctx.restore();
  }
}
