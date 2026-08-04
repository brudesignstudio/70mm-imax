/**
 * webgl.js — thin, allocation-free helpers over raw WebGL 1.
 *
 * WebGL 1 / GLSL ES 1.00 is targeted deliberately: it is the only
 * profile guaranteed on every iOS Safari and Android Chrome build
 * we care about, and nothing in this pipeline needs WebGL 2.
 */

export function getContext(canvas) {
  const opts = {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    // Required: the histogram samples the canvas and the gallery
    // grabs a thumbnail from it, both outside the draw call.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
    // Deliberately *not* desynchronized: the low-latency path makes
    // reading the canvas back unreliable on some mobile drivers,
    // and we read it every frame.
  };
  return canvas.getContext('webgl', opts) ||
         canvas.getContext('experimental-webgl', opts);
}

export function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed:\n${log}`);
  }
  return shader;
}

/**
 * Build a program and pre-resolve every uniform and attribute so the
 * render loop never calls getUniformLocation (which is slow).
 */
export function createProgram(gl, vertSrc, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPosition');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed:\n${log}`);
  }

  const uniforms = Object.create(null);
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

/**
 * A single full-screen triangle covering clip space. One triangle
 * beats two: no diagonal seam, fewer vertices, better quad
 * utilisation on tiled mobile GPUs.
 */
export function createFullscreenTriangle(gl) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     3, -1,
    -1,  3,
  ]), gl.STATIC_DRAW);
  return buffer;
}

/** A colour texture wrapped in a framebuffer, for offscreen passes. */
export function createRenderTarget(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { texture, framebuffer, width, height };
}

export function resizeRenderTarget(gl, rt, width, height) {
  if (rt.width === width && rt.height === height) return rt;
  gl.bindTexture(gl.TEXTURE_2D, rt.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  rt.width = width;
  rt.height = height;
  return rt;
}

export function destroyRenderTarget(gl, rt) {
  if (!rt) return;
  gl.deleteTexture(rt.texture);
  gl.deleteFramebuffer(rt.framebuffer);
}

/** Texture configured for streaming video frames (no mips, clamped). */
export function createVideoTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * A tileable RGB noise texture, generated once on the CPU and
 * uploaded a single time. The composite shader samples it instead
 * of computing three sin()-hash calls per pixel per frame — a
 * texture fetch is dramatically cheaper on a mobile GPU than three
 * transcendental calls, and the pattern only needs to *look* like
 * it re-rolls every frame, which the per-frame UV offset (see
 * FilmRenderer) already provides on top of a static texture.
 * REPEAT + NEAREST: it must tile seamlessly and stay crisp per texel.
 */
export function createGrainTexture(gl, size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = (Math.random() * 256) | 0;
    data[i * 4 + 1] = (Math.random() * 256) | 0;
    data[i * 4 + 2] = (Math.random() * 256) | 0;
    data[i * 4 + 3] = 255;
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return texture;
}

export function bindTexture(gl, texture, unit, location) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (location) gl.uniform1i(location, unit);
}
