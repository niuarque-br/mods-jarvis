import * as THREE from "./vendor/three.module.min.js";

export const STATE_STYLES = {
  off: { mix: 0.3, speed: 0.15, spin: 0.03, amp: 0.04, glow: 0.25, red: 0, dim: 0.35 },
  listening: { mix: 0.15, speed: 0.35, spin: 0.08, amp: 0.1, glow: 0.7, red: 0, dim: 1 },
  thinking: { mix: 0.85, speed: 0.95, spin: 0.45, amp: 0.14, glow: 0.8, red: 0, dim: 1 },
  speaking: { mix: 0.45, speed: 0.6, spin: 0.12, amp: 0.12, glow: 1, red: 0, dim: 1 },
  error: { mix: 0, speed: 0.2, spin: 0.03, amp: 0.05, glow: 0.45, red: 1, dim: 0.8 },
};

const STYLE_KEYS = ["mix", "speed", "spin", "amp", "glow", "red", "dim"];

export function fibonacciShell(count, thickness = 0.15) {
  const positions = new Float32Array(count * 3);
  const randoms = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const r = 1 + (Math.random() - 0.5) * 2 * thickness;
    positions[i * 3] = Math.cos(theta) * ring * r;
    positions[i * 3 + 1] = y * r;
    positions[i * 3 + 2] = Math.sin(theta) * ring * r;
    randoms[i] = Math.random();
  }
  return { positions, randoms };
}

const NOISE = `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const PARTICLE_VERT = `
uniform float uFlow;
uniform float uAmp;
uniform float uLevel;
uniform float uSize;
uniform float uPixelRatio;
attribute float aRandom;
varying float vNoise;
varying float vAlpha;
${NOISE}
void main(){
  vec3 n = normalize(position);
  float f = snoise(position * 1.6 + vec3(0.0, uFlow * 0.6, uFlow * 0.4));
  float f2 = snoise(position * 3.5 - vec3(uFlow * 0.8));
  float disp = (uAmp + uLevel * 0.35) * f + 0.04 * f2 * (0.5 + uLevel);
  vec3 p = position + n * disp;
  vNoise = f;
  vAlpha = 0.7 + 0.3 * sin(uFlow * 4.0 + aRandom * 40.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.6 + aRandom * 0.8) * (1.0 + uLevel * 0.3) / -mv.z;
}
`;

const PARTICLE_FRAG = `
uniform float uMix;
uniform float uRed;
uniform float uDim;
varying float vNoise;
varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = exp(-d * d * 12.0) * vAlpha * 1.4;
  vec3 blue = vec3(0.23, 0.55, 1.0);
  vec3 gold = vec3(1.0, 0.76, 0.35);
  float g = clamp(smoothstep(-0.4, 0.6, vNoise) * 0.5 + uMix * 1.1 - 0.3, 0.0, 1.0);
  vec3 col = mix(blue, gold, g);
  col = mix(col, vec3(1.0, 0.3, 0.25) * 0.8, uRed);
  gl_FragColor = vec4(col * a * uDim, a * uDim);
}
`;

const CORE_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CORE_FRAG = `
uniform float uLevel;
uniform float uGlow;
uniform float uMix;
uniform float uRed;
uniform float uFlow;
varying vec2 vUv;
void main(){
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;
  float breathe = 0.04 * sin(uFlow * 2.0);
  float core = exp(-d * d * (9.0 - uLevel * 4.0 - breathe * 20.0)) * (0.7 + uLevel * 0.7);
  float halo = exp(-d * 2.6) * 0.35;
  vec3 col = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.86, 0.6), uMix * 0.7);
  col = mix(col, vec3(1.0, 0.4, 0.35), uRed);
  float i = (core + halo) * uGlow;
  gl_FragColor = vec4(col * i, i);
}
`;

export function createParticleOrb(canvas, levelFn, count = 6000) {
  const reduce = false;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  camera.position.z = 3.8;

  const shell = fibonacciShell(count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(shell.positions, 3));
  geometry.setAttribute("aRandom", new THREE.BufferAttribute(shell.randoms, 1));
  const particleUniforms = {
    uFlow: { value: 0 },
    uAmp: { value: STATE_STYLES.off.amp },
    uLevel: { value: 0 },
    uSize: { value: 24 },
    uPixelRatio: { value: 1 },
    uMix: { value: STATE_STYLES.off.mix },
    uRed: { value: 0 },
    uDim: { value: STATE_STYLES.off.dim },
  };
  const particles = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: particleUniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(particles);

  const coreUniforms = {
    uLevel: particleUniforms.uLevel,
    uMix: particleUniforms.uMix,
    uRed: particleUniforms.uRed,
    uFlow: particleUniforms.uFlow,
    uGlow: { value: STATE_STYLES.off.glow },
  };
  const core = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 2.2),
    new THREE.ShaderMaterial({
      uniforms: coreUniforms,
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(core);

  const style = { ...STATE_STYLES.off };
  let target = STATE_STYLES.off;
  let level = 0;
  let raf = 0;
  let last = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h || renderer.getPixelRatio() !== dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      particleUniforms.uPixelRatio.value = dpr;
    }
  }

  function frame(now) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    const k = 1 - Math.exp(-dt * 3);
    for (const key of STYLE_KEYS) style[key] += (target[key] - style[key]) * k;
    const raw = Math.max(0, Math.min(1, levelFn(now) || 0));
    level += (raw - level) * 0.18;
    const motion = reduce ? 0.15 : 1;
    particleUniforms.uFlow.value += dt * style.speed * motion;
    particleUniforms.uAmp.value = style.amp;
    particleUniforms.uLevel.value = level;
    particleUniforms.uMix.value = style.mix;
    particleUniforms.uRed.value = style.red;
    particleUniforms.uDim.value = style.dim;
    coreUniforms.uGlow.value = style.glow;
    if (!reduce) {
      particles.rotation.y += dt * style.spin;
      particles.rotation.x = Math.sin(now / 7000) * 0.25;
    }
    resize();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  return {
    start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    setState(name) { target = STATE_STYLES[name] || STATE_STYLES.off; },
  };
}
