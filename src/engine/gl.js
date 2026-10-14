// Low level WebGL helpers + all GLSL programs used by the compositor.
//
// Coordinate convention: every texture (uploaded sources and render targets)
// has v=0 at the TOP of the image. Rectangles are given in pixels with a
// top-left origin. u_flip makes render-target output follow the same rule.

const VERT = `
attribute vec2 a_pos;
uniform vec4 u_rect;   // x, y, w, h  (pixels, top-left origin)
uniform vec2 u_res;    // target size
uniform vec4 u_uv;     // u, v, w, h
uniform float u_flip;  // -1 to the screen, +1 into a framebuffer
uniform vec2 u_scale;  // extra scale around rect centre (for zoom transitions)
varying vec2 v_uv;
varying vec2 v_pos;
void main() {
  vec2 c = u_rect.xy + u_rect.zw * 0.5;
  vec2 p = u_rect.xy + a_pos * u_rect.zw;
  p = c + (p - c) * u_scale;
  vec2 clip = p / u_res * 2.0 - 1.0;
  clip.y *= u_flip;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = u_uv.xy + a_pos * u_uv.zw;
  v_pos = a_pos;
}`;

// Source → input layer. Handles BGRA swap, colour correction and keying.
// Output is premultiplied alpha.
const FRAG_INPUT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_swap;         // 1 = BGRA source
uniform float u_opacity;
uniform float u_brightness;   // -1..1
uniform float u_contrast;     // 0..2
uniform float u_saturation;   // 0..2
uniform float u_hue;          // radians
uniform float u_gamma;        // 0.2..3
uniform int u_keyMode;        // 0 none, 1 chroma, 2 luma
uniform vec3 u_keyColor;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;
uniform vec2 u_luma;          // low, high

vec2 chroma(vec3 c) {
  return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b,
               0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b);
}
vec3 hueShift(vec3 color, float h) {
  const vec3 k = vec3(0.57735);
  float c = cos(h);
  return color * c + cross(k, color) * sin(h) + k * dot(k, color) * (1.0 - c);
}
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  if (u_swap > 0.5) t = t.bgra;
  float a = t.a;
  vec3 rgb = a > 0.0 ? t.rgb / a : vec3(0.0);   // un-premultiply

  rgb = pow(max(rgb, 0.0), vec3(1.0 / u_gamma));
  rgb = (rgb - 0.5) * u_contrast + 0.5 + u_brightness;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, u_saturation);
  if (u_hue != 0.0) rgb = hueShift(rgb, u_hue);
  rgb = clamp(rgb, 0.0, 1.0);

  if (u_keyMode == 1) {
    float d = distance(chroma(rgb), chroma(u_keyColor));
    float base = d - u_similarity;
    float mask = pow(clamp(base / max(u_smoothness, 0.0001), 0.0, 1.0), 1.5);
    float spillVal = pow(clamp(base / max(u_spill, 0.0001), 0.0, 1.0), 1.5);
    float desat = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(desat), rgb, spillVal);
    a *= mask;
  } else if (u_keyMode == 2) {
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    a *= smoothstep(u_luma.x, u_luma.y, y);
  }
  a *= u_opacity;
  gl_FragColor = vec4(rgb * a, a);
}`;

// Plain textured quad (premultiplied in, premultiplied out).
const FRAG_COPY = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(u_tex, v_uv) * u_alpha;
}`;

const FRAG_SOLID = `
precision highp float;
uniform vec4 u_color;
void main() { gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a); }`;

// Two-source transitions. A = outgoing, B = incoming.
const FRAG_TRANSITION = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;
uniform int u_type;
uniform vec2 u_dir;      // direction for wipes / slides
uniform vec2 u_res;
uniform vec3 u_dip;

vec4 sampleIn(sampler2D t, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec4 c = texture2D(t, uv);
  return c + vec4(0.0, 0.0, 0.0, 1.0) * (1.0 - c.a);  // composite over black
}
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float a = rand(i), b = rand(i + vec2(1.0, 0.0)), c = rand(i + vec2(0.0, 1.0)), d = rand(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

void main() {
  vec2 uv = v_uv;
  float p = clamp(u_p, 0.0, 1.0);
  vec4 a = sampleIn(u_a, uv);
  vec4 b = sampleIn(u_b, uv);
  vec4 col = mix(a, b, p);

  if (u_type == 1) {               // wipe
    float s = 0.02;
    float pos = dot(uv - 0.5, u_dir) + 0.5;      // 0..1 along direction
    float edge = smoothstep(p * (1.0 + s) - s, p * (1.0 + s), pos);
    col = mix(b, a, edge);
  } else if (u_type == 2) {        // slide (B moves in over A)
    vec2 off = u_dir * (1.0 - p);
    vec2 buv = uv + off;
    col = (buv.x >= 0.0 && buv.x <= 1.0 && buv.y >= 0.0 && buv.y <= 1.0) ? sampleIn(u_b, buv) : a;
  } else if (u_type == 3) {        // push (both move)
    vec2 auv = uv - u_dir * p;
    vec2 buv = uv + u_dir * (1.0 - p);
    col = (buv.x >= 0.0 && buv.x <= 1.0 && buv.y >= 0.0 && buv.y <= 1.0) ? sampleIn(u_b, buv) : sampleIn(u_a, auv);
  } else if (u_type == 4) {        // zoom in B from centre
    float sc = max(p, 0.0001);
    vec2 buv = (uv - 0.5) / sc + 0.5;
    col = (buv.x >= 0.0 && buv.x <= 1.0 && buv.y >= 0.0 && buv.y <= 1.0) ? mix(a, sampleIn(u_b, buv), smoothstep(0.0, 0.3, p)) : a;
  } else if (u_type == 5) {        // cross zoom: A zooms through, B fades in
    float sc = 1.0 + p * 2.0;
    vec2 auv = (uv - 0.5) / sc + 0.5;
    vec4 az = sampleIn(u_a, auv);
    col = mix(az, b, smoothstep(0.2, 0.8, p));
  } else if (u_type == 6) {        // iris / circle
    vec2 d = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
    float r = p * 1.2;
    float e = smoothstep(r - 0.01, r, length(d));
    col = mix(b, a, e);
  } else if (u_type == 7) {        // dip to colour
    vec4 dip = vec4(u_dip, 1.0);
    col = p < 0.5 ? mix(a, dip, p * 2.0) : mix(dip, b, (p - 0.5) * 2.0);
  } else if (u_type == 8) {        // dissolve / luma noise
    float n = noise(uv * vec2(u_res.x / u_res.y, 1.0) * 12.0) * 0.7 + rand(uv) * 0.3;
    col = mix(a, b, smoothstep(n - 0.08, n + 0.08, p * 1.16 - 0.08));
  } else if (u_type == 9) {        // vertical/horizontal blinds
    float stripes = 10.0;
    float f = fract(dot(uv, abs(u_dir)) * stripes);
    col = f < p ? b : a;
  } else if (u_type == 10) {       // cube-ish 3D rotation (fake perspective)
    float ang = p;
    vec2 auv = vec2((uv.x) / max(1.0 - ang, 0.001), (uv.y - 0.5) / (1.0 - 0.15 * sin(ang * 3.14159)) + 0.5);
    vec2 buv = vec2((uv.x - (1.0 - ang)) / max(ang, 0.001), (uv.y - 0.5) / (1.0 - 0.15 * sin(ang * 3.14159)) + 0.5);
    col = uv.x < (1.0 - ang) ? sampleIn(u_a, auv) * (1.0 - 0.5 * ang) : sampleIn(u_b, buv) * (0.5 + 0.5 * ang);
    col.a = 1.0;
  }
  gl_FragColor = col;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile error: ${log}`);
  }
  return s;
}

export function createProgram(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link error: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, u: uniforms };
}

export function createTexture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  return t;
}

export class RenderTarget {
  constructor(gl, w, h) {
    this.gl = gl;
    this.tex = createTexture(gl);
    this.fb = gl.createFramebuffer();
    this.resize(w, h);
  }

  resize(w, h) {
    const { gl } = this;
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose() {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fb);
  }
}

export const SHADERS = { FRAG_INPUT, FRAG_COPY, FRAG_SOLID, FRAG_TRANSITION };
