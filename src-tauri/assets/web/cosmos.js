// The dashboard's other face: every runner as a body in orbit, state read as
// color and motion instead of a word in a list. WebGL2 by hand — no library,
// because this ships inside the binary and has to stay small enough to open
// over a phone tunnel.

const COLORS = {
  idle: [0.55, 0.58, 0.64],
  streaming: [0.43, 0.76, 1.0],
  tool_running: [0.55, 0.62, 1.0],
  awaiting_input: [0.96, 0.62, 0.04],
  error: [0.94, 0.27, 0.27],
  running: [0.29, 0.87, 0.5],
  exited: [0.29, 0.34, 0.38],
};

const LABEL = {
  idle: "parado",
  streaming: "escrevendo",
  tool_running: "usando ferramenta",
  awaiting_input: "esperando você",
  error: "erro",
  running: "rodando",
  exited: "encerrado",
  offline: "desligado",
};

const VERT = `#version 300 es
layout(location=0) in vec2 quad;
layout(location=1) in vec3 center;
layout(location=2) in float radius;
layout(location=3) in vec3 tint;
layout(location=4) in vec2 look;

uniform mat4 uViewProj;
uniform vec3 uRight;
uniform vec3 uUp;

out vec2 vUv;
out vec3 vTint;
out float vGlow;
out float vAlpha;

void main() {
  vUv = quad;
  vTint = tint;
  vGlow = look.x;
  vAlpha = look.y;
  vec3 world = center + uRight * quad.x * radius + uUp * quad.y * radius;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vTint;
in float vGlow;
in float vAlpha;
out vec4 outColor;

const float CORE = 0.42;

void main() {
  float d = length(vUv);
  if (d > 1.0) discard;

  vec3 rgb = vec3(0.0);
  float a = 0.0;

  if (d < CORE) {
    // Sphere reconstructed from the billboard: the disc is its silhouette, so
    // z falls out of the circle equation and a normal comes for free.
    float k = d / CORE;
    float z = sqrt(max(0.0, 1.0 - k * k));
    vec3 n = normalize(vec3(vUv / CORE, z));
    vec3 lightDir = normalize(vec3(-0.45, 0.62, 0.65));
    float lambert = max(dot(n, lightDir), 0.0);
    float rim = pow(1.0 - z, 2.6);
    vec3 body = vTint * (0.28 + 0.72 * lambert) + vTint * rim * 0.9;
    body += vec3(1.0) * pow(lambert, 22.0) * 0.55;
    float edge = smoothstep(CORE, CORE - 0.035, d);
    rgb = body;
    a = edge;
  }

  float halo = exp(-pow((d - CORE) * 3.4, 2.0)) * vGlow;
  rgb += vTint * halo * 1.35;
  a += halo * 0.55;

  a *= vAlpha;
  outColor = vec4(rgb * a, a);
}`;

const LINE_VERT = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in float fade;
uniform mat4 uViewProj;
out float vFade;
void main() {
  vFade = fade;
  gl_Position = uViewProj * vec4(pos, 1.0);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in float vFade;
uniform vec3 uTint;
uniform float uAlpha;
out vec4 outColor;
void main() {
  float a = vFade * uAlpha;
  outColor = vec4(uTint * a, a);
}`;

const STAR_VERT = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in float size;
uniform mat4 uViewProj;
out float vSize;
void main() {
  vSize = size;
  gl_Position = uViewProj * vec4(pos, 1.0);
  gl_PointSize = size;
}`;

const STAR_FRAG = `#version 300 es
precision highp float;
in float vSize;
out vec4 outColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, d) * 0.5;
  outColor = vec4(vec3(0.72, 0.78, 0.95) * a, a);
}`;

// ------------------------------------------------------------------ math

function mat4Multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, target, up) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ------------------------------------------------------------------ gl

function compile(gl, vertSrc, fragSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vertSrc],
    [gl.FRAGMENT_SHADER, fragSrc],
  ]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader");
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "link");
  }
  return prog;
}

// ------------------------------------------------------------------ scene

// Deterministic per-id jitter, so a runner keeps its place in the sky across
// reloads instead of jumping every time the list is re-fetched.
function hashUnit(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function statusOf(r) {
  if (!r.live) return "offline";
  return r.status || "idle";
}

export function createCosmos(canvas, overlay) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!gl) return null;

  const orbProg = compile(gl, VERT, FRAG);
  const lineProg = compile(gl, LINE_VERT, LINE_FRAG);
  const starProg = compile(gl, STAR_VERT, STAR_FRAG);

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const instBuf = gl.createBuffer();
  const orbVao = gl.createVertexArray();
  gl.bindVertexArray(orbVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const STRIDE = 9 * 4;
  const layout = [
    [1, 3, 0],
    [2, 1, 12],
    [3, 3, 16],
    [4, 2, 28],
  ];
  for (const [loc, size, offset] of layout) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);

  const orbitBuf = gl.createBuffer();
  const orbitVao = gl.createVertexArray();
  gl.bindVertexArray(orbitVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, orbitBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
  gl.bindVertexArray(null);

  const starVao = gl.createVertexArray();
  const starBuf = gl.createBuffer();
  gl.bindVertexArray(starVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
  {
    const N = 320;
    const data = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const u = hashUnit("star-x" + i);
      const v = hashUnit("star-y" + i);
      const w = hashUnit("star-z" + i);
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const rad = 46 + w * 26;
      data[i * 4] = rad * Math.sin(phi) * Math.cos(theta);
      data[i * 4 + 1] = rad * Math.cos(phi) * 0.55;
      data[i * 4 + 2] = rad * Math.sin(phi) * Math.sin(theta);
      data[i * 4 + 3] = 1.0 + hashUnit("star-s" + i) * 2.0;
    }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
  gl.bindVertexArray(null);

  const uni = (prog, name) => gl.getUniformLocation(prog, name);
  const U = {
    orbVP: uni(orbProg, "uViewProj"),
    orbRight: uni(orbProg, "uRight"),
    orbUp: uni(orbProg, "uUp"),
    lineVP: uni(lineProg, "uViewProj"),
    lineTint: uni(lineProg, "uTint"),
    lineAlpha: uni(lineProg, "uAlpha"),
    starVP: uni(starProg, "uViewProj"),
  };

  let bodies = [];
  let orbits = [];
  let orbitCounts = [];
  let maxRadius = 8;
  let instances = new Float32Array(0);
  let labels = new Map();
  let onPick = () => {};
  let running = true;

  const cam = { yaw: 0.6, pitch: 0.52, dist: 22, targetDist: 22 };
  const pointers = new Map();
  let dragged = false;
  let pinchStart = 0;
  let userZoomed = false;
  let framed = false;

  function setState(state) {
    const projects = state.projects || [];
    const masterName = (state.master || "geral").toLowerCase();
    const next = [];
    const rings = [];

    const master = projects.find((p) => p.name.toLowerCase() === masterName);
    const ordered = master
      ? [master, ...projects.filter((p) => p !== master)]
      : projects;

    let ring = 0;
    for (const p of ordered) {
      const runners = p.runners || [];
      if (!runners.length) continue;
      const isMaster = p === master;
      const radius = isMaster ? 3.6 : 6.6 + ring * 3.1;
      const tilt = isMaster ? 0.1 : (hashUnit(p.id) - 0.5) * 0.42;
      if (isMaster) {
        if (runners.length > 1) rings.push({ radius, tilt, name: p.name });
      } else {
        rings.push({ radius, tilt, name: p.name });
        ring++;
      }
      runners.forEach((r, i) => {
        const centerBody =
          isMaster && r.name.toLowerCase() === masterName;
        next.push({
          id: r.id,
          name: r.name,
          project: p.name,
          kind: r.kind,
          status: statusOf(r),
          center: centerBody,
          radius: centerBody ? 0 : radius,
          tilt,
          size: centerBody
            ? 1.5
            : statusOf(r) === "offline"
              ? 0.4
              : r.kind === "shell"
                ? 0.54
                : 0.74,
          phase:
            (i / Math.max(runners.length, 1)) * Math.PI * 2 +
            hashUnit(r.id) * 0.9,
          speed: centerBody ? 0 : 0.32 / Math.max(radius, 1.6),
          screen: [0, 0],
          visible: false,
        });
      });
    }

    bodies = next;
    orbits = rings;
    maxRadius = rings.length ? rings[rings.length - 1].radius : 6;
    if (!userZoomed) {
      // Frame the live fleet, not the graveyard: most runners are off most of
      // the time, and they stay one pinch away instead of shrinking the rest.
      const liveRadius = bodies.reduce(
        (m, b) => (b.status === "offline" ? m : Math.max(m, b.radius)),
        0,
      );
      cam.targetDist = Math.max(
        22,
        Math.max(liveRadius * 2.6, maxRadius * 0.9) + 10,
      );
      // First fit lands where it belongs instead of easing in from a guess.
      if (!framed) {
        cam.dist = cam.targetDist;
        framed = true;
      }
    }
    instances = new Float32Array(bodies.length * 9);
    buildOrbitGeometry();
    syncLabels();
  }

  function buildOrbitGeometry() {
    const SEG = 96;
    const data = new Float32Array(orbits.length * (SEG + 1) * 4);
    orbitCounts = [];
    let o = 0;
    for (const ring of orbits) {
      for (let i = 0; i <= SEG; i++) {
        const t = (i / SEG) * Math.PI * 2;
        const x = Math.cos(t) * ring.radius;
        const z = Math.sin(t) * ring.radius;
        data[o++] = x;
        data[o++] = Math.sin(t) * Math.sin(ring.tilt) * ring.radius * 0.35;
        data[o++] = z;
        data[o++] = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(t * 2));
      }
      orbitCounts.push(SEG + 1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, orbitBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  function syncLabels() {
    const seen = new Set();
    for (const b of bodies) {
      seen.add(b.id);
      let el = labels.get(b.id);
      if (!el) {
        el = document.createElement("a");
        el.className = "orb-label";
        overlay.appendChild(el);
        labels.set(b.id, el);
      }
      el.href = `/r/${b.id}`;
      el.dataset.status = b.status;
      el.innerHTML = `<b></b><span></span>`;
      el.firstChild.textContent = b.name;
      el.lastChild.textContent = caption(b);
      el.classList.toggle("center", !!b.center);
      el.classList.toggle("dim", b.status === "offline");
    }
    for (const [id, el] of labels) {
      if (!seen.has(id)) {
        el.remove();
        labels.delete(id);
      }
    }
  }

  // Half the fleet answers to "claude", so a live orb carries its project.
  function caption(b) {
    if (b.status === "offline") return "";
    const label = LABEL[b.status] || b.status;
    const same = b.project.toLowerCase() === b.name.toLowerCase();
    return same || b.center ? label : `${b.project} · ${label}`;
  }

  function positionOf(b, t) {
    if (b.center) return [0, 0, 0];
    const a = b.phase + t * b.speed;
    const wobble = b.status === "error" ? Math.sin(t * 26) * 0.09 : 0;
    const x = Math.cos(a) * b.radius;
    const z = Math.sin(a) * b.radius;
    const y =
      Math.sin(a) * Math.sin(b.tilt) * b.radius * 0.35 +
      Math.sin(t * 0.7 + b.phase) * 0.12 +
      wobble;
    return [x, y, z];
  }

  function pulseOf(status, t, seed) {
    switch (status) {
      case "streaming":
        return { glow: 0.62 + 0.3 * Math.sin(t * 6.2 + seed), scale: 1.06 };
      case "tool_running":
        return { glow: 0.5 + 0.24 * Math.sin(t * 3.4 + seed), scale: 1.02 };
      case "awaiting_input": {
        const beat = 0.5 + 0.5 * Math.sin(t * 2.1 + seed);
        return { glow: 0.42 + 0.75 * beat * beat, scale: 1 + 0.14 * beat };
      }
      case "error":
        return { glow: 0.55 + 0.35 * Math.sin(t * 14), scale: 1.04 };
      case "running":
        return { glow: 0.34 + 0.08 * Math.sin(t * 1.6 + seed), scale: 1 };
      case "offline":
        return { glow: 0.05, scale: 0.86 };
      default:
        return { glow: 0.2 + 0.07 * Math.sin(t * 1.1 + seed), scale: 1 };
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function frame(now) {
    if (!running) return;
    const t = now / 1000;
    resize();

    const w = canvas.width;
    const h = canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.031, 0.039, 0.055, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    cam.dist += (cam.targetDist - cam.dist) * 0.08;
    const drift = pointers.size ? 0 : t * 0.035;
    const yaw = cam.yaw + drift;
    const eye = [
      Math.cos(cam.pitch) * Math.sin(yaw) * cam.dist,
      Math.sin(cam.pitch) * cam.dist,
      Math.cos(cam.pitch) * Math.cos(yaw) * cam.dist,
    ];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const proj = perspective(
      (48 * Math.PI) / 180,
      w / Math.max(h, 1),
      0.5,
      220,
    );
    const vp = mat4Multiply(proj, view);

    const fwd = normalize(sub([0, 0, 0], eye));
    const right = normalize(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);

    gl.useProgram(starProg);
    gl.uniformMatrix4fv(U.starVP, false, vp);
    gl.bindVertexArray(starVao);
    gl.drawArrays(gl.POINTS, 0, 320);

    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(U.lineVP, false, vp);
    gl.uniform3f(U.lineTint, 0.43, 0.76, 1.0);
    gl.uniform1f(U.lineAlpha, 0.16);
    gl.bindVertexArray(orbitVao);
    let start = 0;
    for (const count of orbitCounts) {
      gl.drawArrays(gl.LINE_STRIP, start, count);
      start += count;
    }

    const order = [];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const p = positionOf(b, t);
      b.world = p;
      const depth =
        (p[0] - eye[0]) * fwd[0] +
        (p[1] - eye[1]) * fwd[1] +
        (p[2] - eye[2]) * fwd[2];
      order.push([depth, i]);
      projectToScreen(b, p, vp, w, h);
    }
    order.sort((a, b) => b[0] - a[0]);

    let o = 0;
    for (const [, idx] of order) {
      const b = bodies[idx];
      const col = COLORS[b.status === "offline" ? "exited" : b.status] ||
        COLORS.idle;
      const pulse = pulseOf(b.status, t, b.phase);
      const size = b.size * pulse.scale * 2.35;
      instances[o++] = b.world[0];
      instances[o++] = b.world[1];
      instances[o++] = b.world[2];
      instances[o++] = size;
      instances[o++] = col[0];
      instances[o++] = col[1];
      instances[o++] = col[2];
      instances[o++] = pulse.glow;
      instances[o++] = b.status === "offline" ? 0.4 : 1;
    }

    gl.useProgram(orbProg);
    gl.uniformMatrix4fv(U.orbVP, false, vp);
    gl.uniform3f(U.orbRight, right[0], right[1], right[2]);
    gl.uniform3f(U.orbUp, up[0], up[1], up[2]);
    gl.bindVertexArray(orbVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bodies.length);
    gl.bindVertexArray(null);

    paintLabels();
    requestAnimationFrame(frame);
  }

  function projectToScreen(b, p, vp, w, h) {
    const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw <= 0.001) {
      b.visible = false;
      return;
    }
    const dpr = canvas.width / Math.max(canvas.clientWidth, 1);
    b.screen = [
      ((cx / cw) * 0.5 + 0.5) * (w / dpr),
      (1 - ((cy / cw) * 0.5 + 0.5)) * (h / dpr),
    ];
    b.visible = true;
  }

  function paintLabels() {
    for (const b of bodies) {
      const el = labels.get(b.id);
      if (!el) continue;
      if (!b.visible) {
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        continue;
      }
      const offset = b.center ? -38 : b.status === "offline" ? 13 : 20;
      const anchor = b.center ? "translate(-50%,-100%)" : "translate(-50%,0)";
      const x = Math.max(
        46,
        Math.min(canvas.clientWidth - 46, b.screen[0]),
      );
      el.style.transform = `${anchor} translate(${x}px, ${b.screen[1] + offset}px)`;
      el.style.opacity = b.status === "offline" ? "0.3" : "1";
      el.style.pointerEvents = "auto";
      if (el.dataset.status !== b.status) {
        el.dataset.status = b.status;
        el.lastChild.textContent = caption(b);
        el.classList.toggle("dim", b.status === "offline");
      }
    }
  }

  // ---------------------------------------------------------------- input

  canvas.addEventListener("pointerdown", (e) => {
    if (e.isPrimary) pointers.clear();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    dragged = false;
    if (pointers.size === 2) pinchStart = pinchDistance() || 1;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) {
      const dx = e.clientX - prev[0];
      const dy = e.clientY - prev[1];
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
      cam.yaw -= dx * 0.006;
      cam.pitch = Math.max(
        -1.25,
        Math.min(1.25, cam.pitch + dy * 0.005),
      );
    } else if (pointers.size === 2) {
      const d = pinchDistance();
      if (d && pinchStart) {
        cam.targetDist = clampDist(cam.targetDist * (pinchStart / d));
        pinchStart = d;
        dragged = true;
        userZoomed = true;
      }
    }
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size && !dragged) pick(e.clientX, e.clientY);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));
  canvas.addEventListener("lostpointercapture", (e) => {
    if (!pointers.size) return;
    pointers.delete(e.pointerId);
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cam.targetDist = clampDist(cam.targetDist * (1 + e.deltaY * 0.0015));
      userZoomed = true;
    },
    { passive: false },
  );

  function clampDist(d) {
    return Math.max(7, Math.min(maxRadius * 4 + 20, d));
  }

  function pinchDistance() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestD = 46;
    for (const b of bodies) {
      if (!b.visible) continue;
      const d = Math.hypot(b.screen[0] - x, b.screen[1] - y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best) onPick(best);
  }

  requestAnimationFrame(frame);

  return {
    setState,
    onPick(fn) {
      onPick = fn;
    },
    stop() {
      running = false;
    },
    resume() {
      if (running) return;
      running = true;
      requestAnimationFrame(frame);
    },
  };
}

export { LABEL as STATUS_LABEL };
