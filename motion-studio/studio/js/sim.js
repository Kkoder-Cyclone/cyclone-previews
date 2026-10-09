// sim.js — the studio's motion engine: scene document -> baked frames.
// Deterministic: the whole scene is stepped at a fixed 60 Hz from t = 0 once per edit, and
// play, scrub and video export all read the same frames. So scrubbing never drifts, the
// video does not depend on the device speed, and the AI and the human always see one result.
//
// Layers: StudioPath (smooth path through points, arc-length table), StudioKeys (monotone
// cubic keyframe curves, no overshoot), runner motion on a path, the "chase" behavior
// (a pursuer runs the prey's trail and closes the gap by its aggression), camera rigs
// (follow / static / flyby) with critically damped smoothing and blends between shots.

const STUDIO_HZ = 60;

class StudioPath {
    // points: [[x, y], ...] map px. A centripetal Catmull-Rom curve through all of them.
    constructor(points) {
        this.points = points.map(p => [p[0], p[1]]);
        const P = this.points, n = P.length;
        const samples = [];
        if (n === 1) samples.push([P[0][0], P[0][1]]);
        for (let i = 0; i < n - 1; i++) {
            const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
            const seg = Math.max(6, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 24));
            for (let k = (i === 0 ? 0 : 1); k <= seg; k++) samples.push(StudioPath.cr(p0, p1, p2, p3, k / seg));
        }
        this.xy = samples;
        this.len = [0];
        for (let i = 1; i < samples.length; i++) {
            this.len.push(this.len[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
        }
        this.length = this.len[this.len.length - 1];
    }

    // Centripetal Catmull-Rom (alpha 0.5): no loops and cusps at sharp street corners.
    static cr(p0, p1, p2, p3, t) {
        const d = (a, b) => Math.max(1e-3, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
        const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
        const u = t1 + (t2 - t1) * t;
        const L = (a, b, ta, tb) => {
            const w = (tb - ta) < 1e-6 ? 0 : (u - ta) / (tb - ta);
            return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
        };
        const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
        const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
        return L(B1, B2, t1, t2);
    }

    // Point and unit tangent at arc length s. Outside [0, length] — straight extension.
    at(s) {
        const xy = this.xy, len = this.len, n = xy.length;
        if (n < 2) return { x: xy[0][0], y: xy[0][1], tx: 1, ty: 0 };
        if (s <= 0) {
            const t = this._dir(0, 1);
            return { x: xy[0][0] + t[0] * s, y: xy[0][1] + t[1] * s, tx: t[0], ty: t[1] };
        }
        if (s >= this.length) {
            const t = this._dir(n - 2, n - 1), e = s - this.length;
            return { x: xy[n - 1][0] + t[0] * e, y: xy[n - 1][1] + t[1] * e, tx: t[0], ty: t[1] };
        }
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (len[mid] <= s) lo = mid; else hi = mid;
        }
        const w = (s - len[lo]) / Math.max(1e-6, len[hi] - len[lo]);
        const t = this._dir(lo, hi);
        return { x: xy[lo][0] + (xy[hi][0] - xy[lo][0]) * w, y: xy[lo][1] + (xy[hi][1] - xy[lo][1]) * w, tx: t[0], ty: t[1] };
    }

    _dir(a, b) {
        const dx = this.xy[b][0] - this.xy[a][0], dy = this.xy[b][1] - this.xy[a][1], l = Math.hypot(dx, dy) || 1;
        return [dx / l, dy / l];
    }
}

/** @satisfies {Record<string, any>} */
const StudioKeys = {
    // Keys [{t, value}] sorted by t -> function of time. Monotone cubic Hermite (Fritsch–Carlson):
    // smooth, and never overshoots between keys (a speed never dips below both neighbours).
    curve(keys, fallback) {
        if (!keys.length) return () => fallback;
        if (keys.length === 1) return () => keys[0].value;
        const n = keys.length, x = keys.map(k => k.t), y = keys.map(k => k.value);
        const d = [], m = new Array(n).fill(0);
        for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / Math.max(1e-6, x[i + 1] - x[i]));
        m[0] = d[0]; m[n - 1] = d[n - 2];
        for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
        for (let i = 0; i < n - 1; i++) {
            if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
            const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
            if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
        }
        return (t) => {
            if (t <= x[0]) return y[0];
            if (t >= x[n - 1]) return y[n - 1];
            let i = 0;
            while (i < n - 2 && t > x[i + 1]) i++;
            const h = x[i + 1] - x[i], u = (t - x[i]) / h, u2 = u * u, u3 = u2 * u;
            return (2 * u3 - 3 * u2 + 1) * y[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * y[i + 1] + (u3 - u2) * h * m[i + 1];
        };
    },

    // The curve of one animated property, or a constant.
    of(doc, target, prop, fallback) {
        const keys = doc.keyframes.filter(k => k.target === target && k.prop === prop).sort((a, b) => a.t - b.t);
        return this.curve(keys, fallback);
    }
};

/** @satisfies {Record<string, any>} */
const StudioMath = {
    angDiff(a, b) {   // shortest b - a
        let d = (b - a) % (2 * Math.PI);
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        return d;
    },
    ease(u) { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); },
    // Exponential approach with time constant tau (frame-rate independent).
    damp(cur, target, tau, dt) { return tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau)); },
    // Smooth pseudo-noise from a few sines: deterministic, no random.
    wobble(t, seed) { return 0.55 * Math.sin(t * 1.3 + seed * 1.7) + 0.3 * Math.sin(t * 2.9 + seed * 3.1) + 0.15 * Math.sin(t * 5.3 + seed * 0.7); }
};

/** @satisfies {Record<string, any>} */
const StudioSim = {
    STRIDE: 440,     // px of ground per run cycle (two steps) at scale 1
    // Frame layout per object: x, y, heading, speed, phase (run cycles), lean, active
    OF: 7,
    // Camera frame: eye x, y, h, look x, y, h, fov
    CF: 7,

    bake(doc) {
        const dt = 1 / STUDIO_HZ;
        const N = Math.max(2, Math.ceil(doc.duration * STUDIO_HZ) + 1);
        const paths = new Map(doc.paths.map(p => [p.id, new StudioPath(p.points)]));
        const out = { N, dt, duration: doc.duration, objects: new Map(), camera: new Float32Array(N * this.CF), paths, shots: [] };
        const hunters = new Map(doc.behaviors.filter(b => b.type === 'chase').map(b => [b.hunter, b]));

        // 1. Leaders: objects on their own path (and static props).
        const state = new Map();
        for (const o of doc.objects) {
            if (hunters.has(o.id)) continue;
            out.objects.set(o.id, this._bakeLeader(doc, o, paths.get(o.path), N, dt));
        }
        // 2. Pursuers, in an order that lets chains work (a hunter of a hunter).
        let pending = doc.objects.filter(o => hunters.has(o.id));
        for (let guard = 0; pending.length && guard < 8; guard++) {
            pending = pending.filter((o) => {
                const b = hunters.get(o.id);
                const prey = out.objects.get(b.prey);
                if (!prey) return true;
                out.objects.set(o.id, this._bakeHunter(doc, o, b, prey, N, dt));
                return false;
            });
        }
        for (const o of pending) out.objects.set(o.id, this._bakeLeader(doc, o, null, N, dt));   // broken chain: stands still
        // 3. Camera.
        this._bakeCamera(doc, out);
        return out;
    },

    _record(arr, i, x, y, h, v, phase, lean, active) {
        const k = i * this.OF;
        arr[k] = x; arr[k + 1] = y; arr[k + 2] = h; arr[k + 3] = v; arr[k + 4] = phase; arr[k + 5] = lean; arr[k + 6] = active;
    },

    _scale(o) { return o.scale > 0 ? o.scale : 1; },

    _bakeLeader(doc, o, path, N, dt) {
        const f = new Float32Array(N * this.OF);
        const D = Math.PI / 180;
        if (!path) {
            for (let i = 0; i < N; i++) this._record(f, i, o.x || 0, o.y || 0, (o.heading || 0) * D, 0, 0, 0, 1);
            return { frames: f, trail: null, s: null };
        }
        const speed = StudioKeys.of(doc, o.id, 'speed', o.speed || 0);
        const weave = StudioKeys.of(doc, o.id, 'weave', o.weave != null ? o.weave : 24);
        const sArr = new Float32Array(N);
        let s = o.start || 0, v = 0, heading = null, dist = 0, px = null, py = null, lean = 0;
        const seed = o.id.length * 1.37;
        for (let i = 0; i < N; i++) {
            const t = i * dt;
            const want = Math.max(0, speed(t));
            v = s >= path.length ? Math.max(0, v - 1400 * dt) : want;
            if (i > 0) s += v * dt;
            sArr[i] = s;
            const p = path.at(Math.min(s, path.length + 400));
            const off = weave(t) * StudioMath.wobble(t * 0.9, seed) * Math.min(1, v / 300);
            const x = p.x - p.ty * off, y = p.y + p.tx * off;
            ({ heading, lean } = this._turn(heading, lean, x, y, px, py, p, v, dt));
            if (px != null) dist += Math.hypot(x - px, y - py);
            px = x; py = y;
            this._record(f, i, x, y, heading, v, dist / (this.STRIDE * this._scale(o)), lean, 1);
        }
        return { frames: f, trail: path, s: sArr };
    },

    // Heading follows the actual motion with a turn-rate limit; lean into turns from the
    // centripetal acceleration (v * turn rate), clamped and smoothed.
    _turn(heading, lean, x, y, px, py, p, v, dt) {
        let target = Math.atan2(p.ty, p.tx);
        if (px != null && Math.hypot(x - px, y - py) > 0.5) target = Math.atan2(y - py, x - px);
        if (heading == null) return { heading: target, lean: 0 };
        const d = StudioMath.angDiff(heading, target);
        const maxTurn = 7 * dt;   // rad/s
        const turn = Math.max(-maxTurn, Math.min(maxTurn, d * Math.min(1, dt * 14)));
        const rate = turn / dt;
        const want = Math.max(-0.26, Math.min(0.26, rate * v * 0.00045));
        return { heading: heading + turn, lean: StudioMath.damp(lean, want, 0.12, dt) };
    },

    _bakeHunter(doc, o, b, prey, N, dt) {
        const f = new Float32Array(N * this.OF);
        if (!prey.trail) return this._bakeLeader(doc, o, null, N, dt);
        const path = prey.trail;
        const aggression = StudioKeys.of(doc, b.id, 'aggression', b.aggression);
        const laneK = StudioKeys.of(doc, b.id, 'lane', b.lane);
        const maxSpeedK = StudioKeys.of(doc, b.id, 'maxSpeed', b.maxSpeed);
        const seed = o.id.length * 2.11 + b.lane * 0.01;
        let s = prey.s[0] - b.gap, v = 0, heading = null, lean = 0, dist = 0, px = null, py = null, lane = laneK(0), gapCur = b.gap;
        for (let i = 0; i < N; i++) {
            const t = i * dt;
            const sp = prey.s[i], vp = prey.frames[i * this.OF + 3];
            if (t >= b.delay) {
                // Wanted gap: shrinks from gap toward minGap; aggression sets how fast.
                const ag = Math.max(0, Math.min(1, aggression(t)));
                gapCur = StudioMath.damp(gapCur, b.minGap + (b.gap - b.minGap) * (1 - ag) * 0.85, 2.6 - ag * 1.6, dt);
                const err = (sp - gapCur) - s;
                let want = vp + err * (0.8 + ag * 1.4);
                want = Math.max(0, Math.min(maxSpeedK(t), want));
                const a = Math.max(-b.accel * 1.5, Math.min(b.accel, (want - v) / dt));
                v += a * dt;
            } else {
                v = Math.max(0, v - b.accel * dt);
            }
            if (i > 0) s += v * dt;
            lane = StudioMath.damp(lane, laneK(t), 0.6, dt);
            const p = path.at(s);
            const off = lane + 28 * StudioMath.wobble(t * 1.1, seed) * Math.min(1, v / 300);
            const x = p.x - p.ty * off, y = p.y + p.tx * off;
            ({ heading, lean } = this._turn(heading, lean, x, y, px, py, p, v, dt));
            if (px != null) dist += Math.hypot(x - px, y - py);
            px = x; py = y;
            this._record(f, i, x, y, heading, v, dist / (this.STRIDE * this._scale(o)), lean, 1);
        }
        return { frames: f, trail: null, s: null };
    },

    // --- Camera -------------------------------------------------------------------------

    _bakeCamera(doc, out) {
        const shots = doc.camera.shots.slice().sort((a, b) => a.t - b.t);
        const N = out.N, dt = out.dt, CF = this.CF, cam = out.camera;
        const blend = doc.camera.blend != null ? doc.camera.blend : 0.7;
        if (!shots.length) {
            for (let i = 0; i < N; i++) cam.set([5200, 9000, 4200, 5200, 5200, 0, 50], i * CF);
            return;
        }
        // Each shot: poses over [its start, next start + blend].
        const poses = shots.map((s, k) => {
            const next = shots[k + 1];
            const i0 = Math.max(0, Math.floor(s.t * STUDIO_HZ));
            const i1 = Math.min(N - 1, next ? Math.ceil((next.t + blend) * STUDIO_HZ) + 1 : N - 1);
            return { i0, i1, data: this._rig(s, out, i0, i1, dt) };
        });
        for (let i = 0; i < N; i++) {
            const t = i * dt;
            let k = 0;
            while (k < shots.length - 1 && t >= shots[k + 1].t) k++;
            const cur = poses[k];
            const pose = this._poseAt(cur, i);
            if (k > 0 && (shots[k].transition || 'smooth') === 'smooth' && blend > 0 && t < shots[k].t + blend) {
                const prev = this._poseAt(poses[k - 1], i);
                const w = StudioMath.ease((t - shots[k].t) / blend);
                for (let j = 0; j < CF; j++) pose[j] = prev[j] + (pose[j] - prev[j]) * w;
            }
            cam.set(pose, i * CF);
        }
        out.shots = shots;
    },

    _poseAt(p, i) {
        const j = Math.max(p.i0, Math.min(p.i1, i)) - p.i0;
        return Array.from(p.data.subarray(j * this.CF, j * this.CF + this.CF));
    },

    _obj(out, id, i) {
        const o = out.objects.get(id);
        if (!o) return null;
        const k = Math.min(out.N - 1, i) * this.OF, f = o.frames;
        return { x: f[k], y: f[k + 1], h: f[k + 2], v: f[k + 3] };
    },

    _rig(s, out, i0, i1, dt) {
        const CF = this.CF, n = i1 - i0 + 1, data = new Float32Array(n * CF);
        const D = Math.PI / 180, F = StudioSchema.SHOT_FIELDS[s.mode];
        const g = (k) => (s[k] != null ? s[k] : (F[k] && F[k].def));
        let eye = null, look = null, camHead = null;
        for (let j = 0; j < n; j++) {
            const i = i0 + j, tRel = (i * dt) - s.t;
            let e, l;
            if (s.mode === 'follow') {
                const o = this._obj(out, s.target, i) || { x: 5200, y: 5200, h: 0, v: 0 };
                camHead = camHead == null ? o.h : camHead + StudioMath.angDiff(camHead, o.h) * (1 - Math.exp(-dt / Math.max(0.05, g('smooth') * 2.2)));
                const a = camHead + g('angle') * D;
                e = [o.x - Math.cos(a) * g('distance'), o.y - Math.sin(a) * g('distance'), g('height')];
                l = [o.x + Math.cos(camHead) * g('lookAhead'), o.y + Math.sin(camHead) * g('lookAhead'), g('lookHeight')];
            } else if (s.mode === 'static') {
                e = s.eye.slice();
                const o = s.target ? this._obj(out, s.target, i) : null;
                l = o ? [o.x, o.y, 100] : s.look.slice();
            } else {
                const keys = s.keys;
                e = this._flyPoint(keys, tRel, 'eye');
                const o = s.target ? this._obj(out, s.target, i) : null;
                l = o ? [o.x, o.y, g('lookHeight')] : (keys.some(k => k.look) ? this._flyPoint(keys.filter(k => k.look), tRel, 'look') : [e[0], e[1] + 1000, 0]);
            }
            const tau = s.mode === 'flyby' ? 0.08 : g('smooth');
            if (!eye) { eye = e; look = l; }
            else {
                eye = eye.map((v, q) => StudioMath.damp(v, e[q], tau, dt));
                look = look.map((v, q) => StudioMath.damp(v, l[q], Math.max(0.04, tau * 0.45), dt));
            }
            data.set([eye[0], eye[1], eye[2], look[0], look[1], look[2], g('fov')], j * CF);
        }
        return data;
    },

    // Catmull-Rom through flyby keys by time; eased at both ends.
    _flyPoint(keys, t, field) {
        const n = keys.length;
        if (t <= keys[0].t) return keys[0][field].slice();
        if (t >= keys[n - 1].t) return keys[n - 1][field].slice();
        let i = 0;
        while (i < n - 2 && t > keys[i + 1].t) i++;
        const u = (t - keys[i].t) / Math.max(1e-6, keys[i + 1].t - keys[i].t);
        const e = (i === 0 ? StudioMath.ease(u) * 0.5 + u * 0.5 : u);
        const p0 = keys[Math.max(0, i - 1)][field], p1 = keys[i][field], p2 = keys[i + 1][field], p3 = keys[Math.min(n - 1, i + 2)][field];
        return [0, 1, 2].map(q => 0.5 * ((2 * p1[q]) + (-p0[q] + p2[q]) * e + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * e * e + (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * e * e * e));
    },

    // Interpolated object state at time t (seconds).
    objectAt(baked, id, t) {
        const o = baked.objects.get(id);
        if (!o) return null;
        const fi = Math.max(0, Math.min(baked.N - 1, t * STUDIO_HZ));
        const a = Math.floor(fi), b = Math.min(baked.N - 1, a + 1), w = fi - a, f = o.frames, OF = this.OF;
        const A = a * OF, B = b * OF;
        return {
            x: f[A] + (f[B] - f[A]) * w,
            y: f[A + 1] + (f[B + 1] - f[A + 1]) * w,
            heading: f[A + 2] + StudioMath.angDiff(f[A + 2], f[B + 2]) * w,
            speed: f[A + 3] + (f[B + 3] - f[A + 3]) * w,
            phase: f[A + 4] + (f[B + 4] - f[A + 4]) * w,
            lean: f[A + 5] + (f[B + 5] - f[A + 5]) * w
        };
    },

    cameraAt(baked, t) {
        const fi = Math.max(0, Math.min(baked.N - 1, t * STUDIO_HZ));
        const a = Math.floor(fi), b = Math.min(baked.N - 1, a + 1), w = fi - a, c = baked.camera, CF = this.CF;
        const r = [];
        for (let j = 0; j < CF; j++) r.push(c[a * CF + j] + (c[b * CF + j] - c[a * CF + j]) * w);
        return { eye: [r[0], r[1], r[2]], look: [r[3], r[4], r[5]], fov: r[6] };
    }
};
