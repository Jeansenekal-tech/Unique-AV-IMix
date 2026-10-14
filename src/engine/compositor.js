// GPU compositor: renders every input into its own layer, then builds the
// multiview thumbnails, the preview monitor and finally the program output
// (transitions, overlay channels, stingers, fade-to-black).
import { createProgram, createTexture, RenderTarget, SHADERS } from './gl.js';

const THUMB_W = 320;
const THUMB_H = 180;

export class Compositor {
  constructor(canvas, mixer) {
    this.canvas = canvas;
    this.mixer = mixer;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      desynchronized: false,
    });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.pInput = createProgram(gl, SHADERS.FRAG_INPUT);
    this.pCopy = createProgram(gl, SHADERS.FRAG_COPY);
    this.pSolid = createProgram(gl, SHADERS.FRAG_SOLID);
    this.pTrans = createProgram(gl, SHADERS.FRAG_TRANSITION);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.sources = new Map(); // inputId -> { tex, w, h, swap }
    this.base = new Map(); // inputId -> RenderTarget
    this.composed = new Map(); // inputId -> RenderTarget
    this.stingerTex = createTexture(gl);
    this.previewCanvas = null;
    this.frameCount = 0;
    this.resize(canvas.width, canvas.height);
  }

  resize(w, h) {
    this.W = w;
    this.H = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const rt of this.base.values()) rt.resize(w, h);
    for (const rt of this.composed.values()) rt.resize(w, h);
  }

  dispose(inputId) {
    const s = this.sources.get(inputId);
    if (s) this.gl.deleteTexture(s.tex);
    this.sources.delete(inputId);
    this.base.get(inputId)?.dispose();
    this.base.delete(inputId);
    this.composed.get(inputId)?.dispose();
    this.composed.delete(inputId);
  }

  // ------------------------------------------------------------------ draw
  target(rt) {
    const { gl } = this;
    if (rt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb);
      gl.viewport(0, 0, rt.w, rt.h);
      this.flip = 1;
      this.res = [rt.w, rt.h];
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.W, this.H);
      this.flip = -1;
      this.res = [this.W, this.H];
    }
  }

  clear(r = 0, g = 0, b = 0, a = 1) {
    const { gl } = this;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  use(p, rect, uv = [0, 0, 1, 1], scale = [1, 1]) {
    const { gl } = this;
    gl.useProgram(p.program);
    gl.uniform4fv(p.u.u_rect, rect);
    gl.uniform2fv(p.u.u_res, this.res);
    gl.uniform4fv(p.u.u_uv, uv);
    gl.uniform1f(p.u.u_flip, this.flip);
    gl.uniform2fv(p.u.u_scale, scale);
  }

  quad() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  drawTex(tex, rect, alpha = 1, uv, scale) {
    const { gl } = this;
    this.use(this.pCopy, rect, uv, scale);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.pCopy.u.u_tex, 0);
    gl.uniform1f(this.pCopy.u.u_alpha, alpha);
    this.quad();
  }

  drawSolid(rect, rgba) {
    this.use(this.pSolid, rect);
    this.gl.uniform4fv(this.pSolid.u.u_color, rgba);
    this.quad();
  }

  // ------------------------------------------------------- source upload
  upload(input) {
    const { gl } = this;
    const src = input.videoSource();
    if (!src || src.kind === 'none' || src.kind === 'colour') return null;
    let s = this.sources.get(input.id);
    if (!s) {
      s = { tex: createTexture(gl), w: 0, h: 0, swap: 0, version: -1 };
      this.sources.set(input.id, s);
    }
    const needs = src.always || src.version !== s.version;
    if (!needs) return s.w ? s : null;
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    try {
      if (src.kind === 'element') {
        if (!src.width || !src.height) return s.w ? s : null;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.el);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        s.w = src.width;
        s.h = src.height;
        s.swap = 0;
      } else if (src.kind === 'pixels') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
        s.w = src.width;
        s.h = src.height;
        s.swap = src.bgra ? 1 : 0;
      }
      s.version = src.version;
    } catch (e) {
      // e.g. video not yet decodable
      return s.w ? s : null;
    }
    return s;
  }

  // Destination rectangle for a source of size sw×sh inside the output.
  layout(input, sw, sh) {
    const { W, H } = this;
    const st = input.settings;
    let dw;
    let dh;
    if (st.fit === 'stretch') {
      dw = W;
      dh = H;
    } else {
      const s = st.fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      dw = sw * s;
      dh = sh * s;
    }
    dw *= st.zoom;
    dh *= st.zoom;
    const cx = W / 2 + (st.panX * W) / 2;
    const cy = H / 2 - (st.panY * H) / 2;
    const c = st.crop;
    const rect = [cx - dw / 2 + c.l * dw, cy - dh / 2 + c.t * dh, dw * (1 - c.l - c.r), dh * (1 - c.t - c.b)];
    const uv = [c.l, c.t, 1 - c.l - c.r, 1 - c.t - c.b];
    return { rect, uv };
  }

  renderBase(input) {
    const { gl } = this;
    let rt = this.base.get(input.id);
    if (!rt) {
      rt = new RenderTarget(gl, this.W, this.H);
      this.base.set(input.id, rt);
    }
    this.target(rt);
    this.clear(0, 0, 0, 0);
    const st = input.settings;
    const src = input.videoSource();
    if (!src) return rt;
    if (src.kind === 'colour') {
      const c = src.color;
      this.drawSolid([0, 0, this.W, this.H], [c[0], c[1], c[2], (c[3] ?? 1) * st.opacity]);
      return rt;
    }
    const s = this.upload(input);
    if (!s) return rt;
    const { rect, uv } = this.layout(input, s.w, s.h);
    if (rect[2] <= 0 || rect[3] <= 0) return rt;
    const p = this.pInput;
    this.use(p, rect, uv);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.uniform1i(p.u.u_tex, 0);
    gl.uniform1f(p.u.u_swap, s.swap);
    gl.uniform1f(p.u.u_opacity, st.opacity);
    const cc = st.color;
    gl.uniform1f(p.u.u_brightness, cc.brightness);
    gl.uniform1f(p.u.u_contrast, cc.contrast);
    gl.uniform1f(p.u.u_saturation, cc.saturation);
    gl.uniform1f(p.u.u_hue, (cc.hue * Math.PI) / 180);
    gl.uniform1f(p.u.u_gamma, cc.gamma || 1);
    const k = st.key;
    gl.uniform1i(p.u.u_keyMode, k.mode === 'chroma' ? 1 : k.mode === 'luma' ? 2 : 0);
    gl.uniform3fv(p.u.u_keyColor, k.color);
    gl.uniform1f(p.u.u_similarity, k.similarity);
    gl.uniform1f(p.u.u_smoothness, k.smoothness);
    gl.uniform1f(p.u.u_spill, k.spill);
    gl.uniform2fv(p.u.u_luma, [k.lumaLow, k.lumaHigh]);
    this.quad();
    return rt;
  }

  renderComposed(input) {
    let rt = this.composed.get(input.id);
    if (!rt) {
      rt = new RenderTarget(this.gl, this.W, this.H);
      this.composed.set(input.id, rt);
    }
    this.target(rt);
    this.clear(0, 0, 0, 0);
    const base = this.base.get(input.id);
    if (base) this.drawTex(base.tex, [0, 0, this.W, this.H]);
    for (const layer of input.settings.layers) {
      if (!layer.enabled || !layer.inputId) continue;
      const lb = this.base.get(layer.inputId);
      if (!lb) continue;
      const r = [layer.x * this.W, layer.y * this.H, layer.w * this.W, layer.h * this.H];
      if (layer.border > 0) {
        const b = layer.border;
        this.drawSolid([r[0] - b, r[1] - b, r[2] + 2 * b, r[3] + 2 * b], layer.borderColor || [1, 1, 1, 1]);
      }
      this.drawTex(lb.tex, r, 1);
    }
    return rt;
  }

  texFor(id) {
    if (!id) return null;
    const c = this.composed.get(id);
    const input = this.mixer.getInput(id);
    if (c && input && input.hasLayers()) return c.tex;
    const b = this.base.get(id);
    return b ? b.tex : null;
  }

  // ------------------------------------------------------------ the frame
  frame(now, { thumbs = false } = {}) {
    const m = this.mixer;
    this.frameCount++;
    const needed = new Set();
    const addNeeded = (id) => {
      const inp = id && m.getInput(id);
      if (!inp) return;
      needed.add(inp.id);
      for (const l of inp.settings.layers) if (l.enabled && l.inputId && m.getInput(l.inputId)) needed.add(l.inputId);
    };
    addNeeded(m.programId);
    addNeeded(m.previewId);
    if (m.trans) {
      addNeeded(m.trans.from);
      addNeeded(m.trans.to);
    }
    for (const ov of m.overlays) if (ov.inputId && ov.state !== 'off') addNeeded(ov.inputId);
    if (thumbs) for (const inp of m.inputs) addNeeded(inp.id);
    for (const id of m.extraRenders) addNeeded(id);

    // 1. base layers
    for (const id of needed) {
      const inp = m.getInput(id);
      if (inp && inp.hasVideo) this.renderBase(inp);
    }
    // 2. composed (multi-layer) inputs
    for (const id of needed) {
      const inp = m.getInput(id);
      if (inp && inp.hasVideo && inp.hasLayers()) this.renderComposed(inp);
    }

    // 3. multiview thumbnails (atlas on the back buffer, copied to tiles)
    if (thumbs) this.renderThumbs();

    // 4. preview
    if (this.previewCanvas) {
      this.target(null);
      this.clear(0, 0, 0, 1);
      const t = this.texFor(m.previewId);
      if (t) this.drawTex(t, [0, 0, this.W, this.H]);
      if (m.settings.previewOverlays) this.drawOverlays(now);
      const pc = this.previewCanvas;
      pc.ctx.drawImage(this.canvas, 0, 0, this.W, this.H, 0, 0, pc.width, pc.height);
    }

    // 5. program (left on the canvas → monitor, recording, streaming)
    this.renderProgram(now);
  }

  renderThumbs() {
    const m = this.mixer;
    const cols = Math.max(1, Math.floor(this.W / THUMB_W));
    const rows = Math.max(1, Math.floor(this.H / THUMB_H));
    const per = cols * rows;
    const list = m.inputs.filter((i) => i.thumbCtx);
    for (let start = 0; start < list.length; start += per) {
      this.target(null);
      this.clear(0, 0, 0, 1);
      const batch = list.slice(start, start + per);
      batch.forEach((inp, i) => {
        const x = (i % cols) * THUMB_W;
        const y = Math.floor(i / cols) * THUMB_H;
        const t = inp.hasVideo ? this.texFor(inp.id) : null;
        if (t) this.drawTex(t, [x, y, THUMB_W, THUMB_H]);
      });
      batch.forEach((inp, i) => {
        const x = (i % cols) * THUMB_W;
        const y = Math.floor(i / cols) * THUMB_H;
        if (!inp.hasVideo) return;
        const c = inp.thumbCtx.canvas;
        inp.thumbCtx.drawImage(this.canvas, x, y, THUMB_W, THUMB_H, 0, 0, c.width, c.height);
      });
    }
  }

  drawOverlays(now) {
    const m = this.mixer;
    for (let i = 0; i < m.overlays.length; i++) {
      const v = m.overlayVisual(i, now);
      if (!v || v.alpha <= 0) continue;
      const t = this.texFor(m.overlays[i].inputId);
      if (!t) continue;
      this.drawTex(t, [v.dx * this.W, v.dy * this.H, this.W, this.H], v.alpha, undefined, [v.scale, v.scale]);
    }
  }

  renderProgram(now) {
    const { gl } = this;
    const m = this.mixer;
    this.target(null);
    this.clear(0, 0, 0, 1);
    const full = [0, 0, this.W, this.H];
    const tr = m.trans;
    if (tr && tr.def.id === 'stinger') {
      const st = m.stingerState(now);
      const id = st && st.cut ? tr.to : tr.from;
      const t = this.texFor(id);
      if (t) this.drawTex(t, full);
    } else if (tr && tr.def.id >= 0) {
      const p = this.pTrans;
      this.use(p, full);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texFor(tr.from) || this.emptyTex());
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texFor(tr.to) || this.emptyTex());
      gl.uniform1i(p.u.u_a, 0);
      gl.uniform1i(p.u.u_b, 1);
      gl.uniform1f(p.u.u_p, m.transProgress(now));
      gl.uniform1i(p.u.u_type, tr.def.id);
      gl.uniform2fv(p.u.u_dir, tr.def.dir || [1, 0]);
      gl.uniform3fv(p.u.u_dip, tr.def.dip || [0, 0, 0]);
      gl.disable(gl.BLEND);
      this.quad();
      gl.enable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
    } else {
      const t = this.texFor(m.programId);
      if (t) this.drawTex(t, full);
    }

    this.drawOverlays(now);

    // stinger graphic on top
    if (tr && tr.def.id === 'stinger') {
      const v = m.stingerVideo(tr.def.stinger);
      if (v && v.readyState >= 2 && v.videoWidth) {
        gl.bindTexture(gl.TEXTURE_2D, this.stingerTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
        } catch {
          /* ignore */
        }
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        this.drawTex(this.stingerTex, full);
      }
    }

    const ftb = m.ftbAlpha(now);
    if (ftb > 0) this.drawSolid(full, [0, 0, 0, ftb]);
  }

  emptyTex() {
    if (!this._empty) this._empty = createTexture(this.gl);
    return this._empty;
  }
}
