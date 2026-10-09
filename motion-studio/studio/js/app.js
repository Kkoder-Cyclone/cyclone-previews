// app.js — the studio: boot on top of ArcEngine, frame loop, play / pause / seek, undo, the
// side panel (prompt, scene, camera), free vs scene camera, video recording.
// window.studio — a small handle for tests and for the AI bridge of stage 2.

const StudioIO = {
    // Any document (a file, the built-in scene, a saved copy) is rebuilt through the COMMANDS:
    // a loaded file can carry nothing the command checks would refuse.
    docToCommands(src) {
        const c = [];
        c.push({ cmd: 'set_duration', value: src.duration });
        if (src.name) c.push({ cmd: 'set_param', target: 'scene', param: 'name', value: String(src.name) });
        if (src.camera && src.camera.blend != null) c.push({ cmd: 'set_param', target: 'scene', param: 'blend', value: src.camera.blend });
        for (const p of src.paths || []) c.push({ cmd: 'set_path', id: p.id, points: p.points });
        for (const o of src.objects || []) c.push(Object.assign({ cmd: 'add_object' }, o));
        for (const b of src.behaviors || []) c.push(Object.assign({ cmd: 'add_behavior' }, b));
        for (const k of src.keyframes || []) c.push({ cmd: 'set_keyframe', target: k.target, prop: k.prop, t: k.t, value: k.value });
        for (const s of (src.camera && src.camera.shots) || []) c.push(Object.assign({ cmd: 'set_camera' }, s));
        return c;
    },
    load(src) {
        const base = StudioSchema.empty();
        if (src && src.world && typeof src.world === 'object') {
            const seed = Number(src.world.seed);
            base.world = { type: 'city', seed: isFinite(seed) ? Math.max(1, Math.min(9999, Math.round(seed))) : 7 };
            const pl = src.world.plaza;
            if (Array.isArray(pl) && pl.length === 2 && pl.every(v => Number.isInteger(v) && v >= -1 && v <= 4)) base.world.plaza = pl.slice();
        }
        const res = StudioCommands.applyAll(base, this.docToCommands(src || {}));
        return { doc: res.doc, errors: res.results.filter(r => !r.ok) };
    }
};

class StudioApp {
    constructor() {
        this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('world3d'));
        this.t = 0;
        this.playing = false;
        this.recording = false;
        this.viewMode = 'scene';
        this.sel = null;
        this.previewDoc = null;
        this.ui = new StudioUI(this);
    }

    get doc() { return this.previewDoc || this.history.doc; }

    boot() {
        if (typeof STUDIO_SPRITES !== 'undefined') document.getElementById('sprites').innerHTML = STUDIO_SPRITES;
        this.ui.texts();
        if (!World3D.init(this.canvas)) { this.ui.fatal('3D недоступен: браузер не дал WebGL.'); return; }
        this.stage = new StudioStage(this.canvas);
        this.cam = new CameraController(this.stage.view, { terrain: this.stage.terrain, bounds: { w: 10400, h: 10400 }, free: true });
        let start = null;
        const saved = Store.get(StudioApp.STORE_KEY);
        if (saved) { try { start = StudioIO.load(JSON.parse(saved)); if (start.errors.length) start = null; } catch (e) { start = null; } }
        if (!start) start = StudioIO.load(STUDIO_SCENE_CHASE);
        if (start.errors.length) console.warn('Студия: в сцене отклонены команды', start.errors);
        this.history = new StudioHistory(start.doc);
        this.baked = StudioSim.bake(this.doc);
        this.timeline = new StudioTimeline(this, document.getElementById('timeline'));
        this.overlay = new StudioOverlay(this, document.getElementById('overlay'));
        this.ui.build();
        this.refresh();
        this.ready = this.stage.sync(this.doc).then(() => new Promise(r => this.stage.view.scene.executeWhenReady(() => r(undefined)))).then(() => {
            document.getElementById('loading').hidden = true;
            this.loaded = true;
        });
        let last = performance.now();
        World3D.engine.runRenderLoop(() => {
            const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            this.frame(dt);
        });
        window.addEventListener('resize', () => World3D.resize());
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => World3D.resize()).observe(this.canvas);
    }

    frame(dt) {
        if (this.playing) {
            // Wall-clock playback: a slow device drops frames, the film keeps its real speed.
            this.t = this._playT0 + (performance.now() - this._playWall0) / 1000;
            if (this.t >= this.doc.duration) {
                this.t = this.doc.duration;
                this.pause();
                if (this.recording) this.ui.stopRecording();
            }
        }
        this.drawAt(this.t, dt);
        this.ui.tick();
    }

    // Draw time t: actors, camera, shadows, the frame, the marks.
    drawAt(t, dt) {
        const scene = this.viewMode === 'scene';
        this.stage.show(this.baked, t, scene);
        if (scene) {
            const l = this.stage.lookAt, e = this.stage.eyeAt;
            this.stage.fitShadows(l[0], l[1], 1500 + e[2] * 0.5);
        } else {
            this.cam.update(dt || 0);
            this.stage.fitShadows(this.cam.target.x, this.cam.target.y, 2600);
        }
        World3D.renderFrame();
        this.overlay.update();
        this.timeline.updatePlayhead();
    }

    play() {
        if (this.t >= this.doc.duration - 1e-3) this.t = 0;
        this._playT0 = this.t;
        this._playWall0 = performance.now();
        this.playing = true;
        this.ui.syncPlay();
    }
    pause() { this.playing = false; this.ui.syncPlay(); }
    toggle() { if (this.playing) this.pause(); else this.play(); }
    restart() { this.t = 0; this._playT0 = 0; this._playWall0 = performance.now(); this.ui.syncPlay(); }
    seek(t) { this.t = Math.max(0, Math.min(this.doc.duration, t)); this._playT0 = this.t; this._playWall0 = performance.now(); this.ui.syncTime(); this.ui.renderCameraIfShotChanged(); }

    setView(mode) {
        if (mode === this.viewMode) return;
        this.viewMode = mode;
        if (mode === 'free') {
            const l = this.stage.lookAt || [5200, 5200, 0], e = this.stage.eyeAt || [5200, 9000, 4000];
            this.cam.lookAt(l[0], l[1]);
            this.cam.azimuth = Math.atan2(l[1] - e[1], l[0] - e[0]);
            this.cam.pitch = 55 * Math.PI / 180;
            this.cam.zoom = this.cam.zoomTarget = 0.12;
            this.cam.attach(this.canvas);
        } else {
            this.cam.detach();
        }
        this.ui.syncView();
    }

    // Apply commands (the AI's list or one human drag). -> { ok, results }
    run(cmds, opts) {
        const o = opts || {};
        const base = o.from || this.history.doc;
        const res = StudioCommands.applyAll(base, cmds);
        const okN = res.results.filter(r => r.ok).length;
        this.previewDoc = null;
        if (okN > 0) {
            this.history.push(res.doc);
            this.refresh();
        }
        if (!o.quiet) this.ui.showResults(res.results);
        return { ok: okN > 0, results: res.results };
    }

    preview(doc) {
        this.previewDoc = doc;
        this.baked = StudioSim.bake(doc);
    }
    previewEnd() { this.previewDoc = null; }

    undo() { if (this.history.undo()) this.refresh(); }
    redo() { if (this.history.redo()) this.refresh(); }

    refresh() {
        const doc = this.doc;
        this.baked = StudioSim.bake(doc);
        if (this.t > doc.duration) this.t = doc.duration;
        if (this.stage && this.loaded !== undefined) this.stage.sync(doc);
        if (this.sel && !this._selValid(this.sel)) this.sel = null;
        this.timeline.render();
        this.ui.renderAll();
        Store.set(StudioApp.STORE_KEY, JSON.stringify(doc));
    }

    _selValid(s) {
        const d = this.doc;
        if (s.kind === 'object') return d.objects.some(o => o.id === s.id);
        if (s.kind === 'shot') return d.camera.shots.some(x => Math.abs(x.t - s.t) < 0.005);
        if (s.kind === 'key') return d.keyframes.some(k => k.target === s.target && k.prop === s.prop && Math.abs(k.t - s.t) < 0.005);
        return true;
    }

    select(s) {
        this.sel = s;
        this.timeline.render();
        this.ui.renderAll();
    }

    // Which path the handles edit: the selected object's, else the first object with a path.
    editPath() {
        const d = this.doc;
        if (this.sel && this.sel.kind === 'object') {
            const o = d.objects.find(x => x.id === this.sel.id);
            if (o && o.path) return o.path;
        }
        const o = d.objects.find(x => x.path);
        return o ? o.path : (d.paths[0] ? d.paths[0].id : null);
    }

    shotIndexAt(t) {
        const s = this.doc.camera.shots;
        let k = -1;
        for (let i = 0; i < s.length; i++) if (t >= s[i].t - 1e-6) k = i;
        return k;
    }

    // Frame-exact render for tests and offline export: time t, no wall clock.
    renderAt(t) {
        this.pause();
        this.t = t;
        this.drawAt(t, 0);
    }
}
StudioApp.STORE_KEY = 'motion-studio/doc/v1';

// --- side panel, transport, header ------------------------------------------------------
class StudioUI {
    constructor(app) {
        this.app = app;
        this.$ = (id) => document.getElementById(id);
        this._shotK = -2;
        this._timeText = '';
    }

    texts() {
        for (const el of document.querySelectorAll('[data-t]')) el.textContent = StudioText.t(el.getAttribute('data-t'));
    }

    fatal(msg) {
        const l = this.$('loading');
        l.textContent = msg;
        console.warn(msg);
    }

    icon(id, cls) { return '<svg class="cy-ic ' + (cls || 's16') + '" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

    esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    build() {
        const a = this.app;
        this.$('play').addEventListener('click', () => a.toggle());
        this.$('restart').addEventListener('click', () => { a.restart(); });
        this.$('undo').addEventListener('click', () => a.undo());
        this.$('redo').addEventListener('click', () => a.redo());
        this.$('vScene').addEventListener('click', () => a.setView('scene'));
        this.$('vFree').addEventListener('click', () => a.setView('free'));
        this.$('record').addEventListener('click', () => (a.recording ? this.stopRecording() : this.startRecording()));
        this.$('addKey').addEventListener('click', () => this.addKeyNow());
        for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => this.tab(b.getAttribute('data-tab')));
        window.addEventListener('keydown', (e) => {
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
            if (e.code === 'Space') { e.preventDefault(); a.toggle(); }
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) a.redo(); else a.undo(); }
        });
        this.buildPrompt();
        this.syncView();
        this.syncPlay();
    }

    tab(name) {
        for (const b of document.querySelectorAll('[data-tab]')) {
            const on = b.getAttribute('data-tab') === name;
            b.classList.toggle('on', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        for (const p of ['prompt', 'scene', 'camera']) this.$('pane-' + p).classList.toggle('on', p === name);
    }

    syncPlay() {
        const p = this.$('play');
        p.innerHTML = this.icon(this.app.playing ? 'ms-pause' : 'ms-play', '') + '<span>' + StudioText.t(this.app.playing ? 'pause' : 'play') + '</span>';
        this.syncTime();
    }

    syncTime() {
        const a = this.app, txt = StudioText.fmtTime(a.t) + ' / ' + StudioText.fmtTime(a.doc.duration) + ' с';
        if (txt !== this._timeText) { this._timeText = txt; this.$('time').textContent = txt; }
    }

    syncView() {
        const free = this.app.viewMode === 'free';
        this.$('vScene').classList.toggle('on', !free);
        this.$('vFree').classList.toggle('on', free);
        this.badge();
    }

    badge() {
        const a = this.app, b = this.$('badge');
        b.classList.toggle('rec', a.recording);
        if (a.recording) { b.textContent = StudioText.t('recording') + ' · ' + StudioText.fmtTime(a.t) + ' с'; return; }
        if (a.viewMode === 'free') { b.textContent = StudioText.t('badgeFree'); return; }
        const k = a.shotIndexAt(a.t), s = a.doc.camera.shots[k];
        b.textContent = StudioText.t('badgeScene') + (s ? ' · ' + StudioText.cameraMode(s.mode) : '');
    }

    tick() {
        this.syncTime();
        this.badge();
        this.renderCameraIfShotChanged();
    }

    renderCameraIfShotChanged() {
        const k = this.app.shotIndexAt(this.app.t);
        if (k !== this._shotK) { this._shotK = k; if (!this.app.playing) this.renderCamera(); }
    }

    renderAll() {
        this.$('undo').disabled = !this.app.history.past.length;
        this.$('redo').disabled = !this.app.history.future.length;
        this.renderScene();
        this.renderCamera();
        this.syncTime();
    }

    // --- prompt tab ---
    buildPrompt() {
        const S = StudioText.S, pane = this.$('pane-prompt');
        pane.innerHTML =
            '<div class="hint">' + this.esc(S.promptHint) + '</div>' +
            '<label class="sr" for="prompt">Команды</label>' +
            '<textarea id="prompt" class="prompt" spellcheck="false" placeholder="' + this.esc(S.promptPlaceholder) + '"></textarea>' +
            '<div class="row"><button type="button" class="btn primary" id="applyBtn">' + this.icon('ms-send', '') + '<span>' + S.apply + '</span></button>' +
            '<button type="button" class="btn" id="exampleBtn">' + this.icon('ms-plus', '') + '<span>' + S.example + '</span></button></div>' +
            '<ul class="results" id="results"><li>' + this.esc(S.emptyResult) + '</li></ul>' +
            '<details class="ref"><summary>' + S.commandsHelp + '</summary><ul>' +
            S.ref.map(r => '<li><b>' + r[0] + '</b> — ' + this.esc(r[1]) + '<br><code>' + this.esc(r[2]) + '</code></li>').join('') +
            '</ul></details>';
        this.$('applyBtn').addEventListener('click', () => {
            const p = StudioCommands.parse(this.$('prompt').value);
            if (!p.ok) { this.showResults([{ ok: false, cmd: '', text: p.error }]); return; }
            this.app.run(p.commands);
        });
        this.$('exampleBtn').addEventListener('click', () => {
            this.$('prompt').value = JSON.stringify(StudioText.S.exampleCmds, null, 1);
        });
    }

    showResults(results) {
        const ok = results.filter(r => r.ok).length, bad = results.length - ok;
        const ul = this.$('results');
        ul.innerHTML = '<li><span><b>' + StudioText.t('okCount', ok) + '</b> · ' + StudioText.t('errCount', bad) + '</span></li>' +
            results.map(r => '<li class="' + (r.ok ? 'ok' : 'err') + '">' + this.icon(r.ok ? 'cy-status-ok' : 'cy-status-error', '') +
                '<span>' + (r.cmd ? '<b>' + this.esc(r.cmd) + '</b>: ' : '') + this.esc(r.text) + '</span></li>').join('');
    }

    // --- scene tab ---
    _slider(id, label, min, max, step, value) {
        return '<div class="field"><label for="' + id + '">' + this.esc(label) + '</label><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"><output for="' + id + '">' + value + '</output></div>';
    }
    _number(id, label, value, step) {
        return '<div class="field wide"><label for="' + id + '">' + this.esc(label) + '</label><input type="number" id="' + id + '" step="' + (step || 1) + '" value="' + value + '"></div>';
    }
    _bindSlider(id, onCommit) {
        const el = this.$(id);
        if (!el) return;
        const out = el.nextElementSibling;
        el.addEventListener('input', () => { if (out) out.textContent = el.value; });
        el.addEventListener('change', () => onCommit(Number(el.value)));
    }
    _bindNumber(id, onCommit) {
        const el = this.$(id);
        if (el) el.addEventListener('change', () => { const v = Number(el.value); if (isFinite(v)) onCommit(v); });
    }

    renderScene() {
        const a = this.app, d = a.doc, S = StudioText.S, pane = this.$('pane-scene');
        const sel = a.sel && a.sel.kind === 'object' ? d.objects.find(o => o.id === a.sel.id) : null;
        const color = o => (o.type !== 'person' ? '#b98a5a' : o.outfit === 'runner' ? '#ff6b4a' : '#1f3550');
        let h = '<div class="hint">' + this.esc(S.pathHint) + '</div>';
        h += '<div class="card"><h3>' + this.icon('ms-path') + S.objects + '</h3><div class="list">' +
            d.objects.map(o => '<button type="button" data-obj="' + o.id + '" class="' + (sel && sel.id === o.id ? 'on' : '') + '"><span class="dot" style="background:' + color(o) + '"></span>' +
                this.esc(o.name) + '<small>' + this.esc(S.roles[o.type] || o.type) + '</small></button>').join('') + '</div></div>';
        if (sel) {
            const beh = d.behaviors.find(b => b.hunter === sel.id);
            h += '<div class="card"><h3>' + this.esc(sel.name) + '</h3>';
            if (beh) {
                h += '<div class="hint">' + S.behavior + ': ' + this.esc(sel.name) + ' → ' + this.esc((d.objects.find(o => o.id === beh.prey) || {}).name || beh.prey) + '</div>';
                h += this._slider('b-aggression', StudioText.param('aggression'), 0, 1, 0.05, beh.aggression);
                h += this._slider('b-gap', StudioText.param('gap'), 100, 4000, 50, beh.gap);
                h += this._slider('b-minGap', StudioText.param('minGap'), 60, 2000, 20, beh.minGap);
                h += this._slider('b-maxSpeed', StudioText.param('maxSpeed'), 100, 1400, 10, beh.maxSpeed);
                h += this._slider('b-lane', StudioText.param('lane'), -300, 300, 10, beh.lane);
                h += this._slider('b-delay', StudioText.param('delay'), 0, 10, 0.1, beh.delay);
            } else if (sel.type === 'person') {
                h += '<div class="hint">Скорость бегуна задают ключи на шкале времени.</div>';
                h += this._slider('o-weave', StudioText.param('weave'), 0, 200, 2, sel.weave != null ? sel.weave : 24);
            } else {
                h += this._number('o-x', StudioText.param('x'), sel.x || 0, 10) + this._number('o-y', StudioText.param('y'), sel.y || 0, 10);
            }
            h += '</div>';
        }
        if (a.sel && a.sel.kind === 'key') {
            const k = d.keyframes.find(x => x.target === a.sel.target && x.prop === a.sel.prop && Math.abs(x.t - a.sel.t) < 0.005);
            if (k) {
                h += '<div class="card"><h3>' + this.icon('ms-key') + S.selectedKey + '</h3>' +
                    '<div class="hint">' + this.esc(k.target) + ' · ' + this.esc(StudioText.param(k.prop)) + ' · ' + StudioText.fmtTime(k.t) + ' с</div>' +
                    this._number('k-value', S.keyValue, k.value, k.prop === 'aggression' ? 0.05 : 10) +
                    '<div class="row"><button type="button" class="btn" id="k-del">' + this.icon('ms-trash', '') + '<span>' + S.deleteKey + '</span></button></div></div>';
            }
        }
        h += '<div class="card"><h3>' + this.icon('cy-metric-deadline') + S.data + '</h3>' + this._number('s-dur', StudioText.param('duration'), d.duration, 0.5) +
            '<div class="row"><button type="button" class="btn" id="saveJson">' + this.icon('ms-download', '') + '<span>' + S.saveJson + '</span></button>' +
            '<label class="btn" for="loadJson">' + this.icon('ms-upload', '') + '<span>' + S.loadJson + '</span></label><input type="file" id="loadJson" accept="application/json,.json" class="sr">' +
            '<button type="button" class="btn" id="resetScene">' + this.icon('ms-restart', '') + '<span>' + S.resetScene + '</span></button></div></div>';
        pane.innerHTML = h;

        for (const b of pane.querySelectorAll('[data-obj]')) b.addEventListener('click', () => a.select({ kind: 'object', id: b.getAttribute('data-obj') }));
        if (sel) {
            const beh = d.behaviors.find(b => b.hunter === sel.id);
            if (beh) for (const p of ['aggression', 'gap', 'minGap', 'maxSpeed', 'lane', 'delay']) this._bindSlider('b-' + p, v => a.run([{ cmd: 'set_param', target: beh.id, param: p, value: v }], { quiet: true }));
            this._bindSlider('o-weave', v => a.run([{ cmd: 'set_param', target: sel.id, param: 'weave', value: v }], { quiet: true }));
            this._bindNumber('o-x', v => a.run([{ cmd: 'set_param', target: sel.id, param: 'x', value: v }]));
            this._bindNumber('o-y', v => a.run([{ cmd: 'set_param', target: sel.id, param: 'y', value: v }]));
        }
        if (a.sel && a.sel.kind === 'key') {
            const s = a.sel;
            this._bindNumber('k-value', v => a.run([{ cmd: 'set_keyframe', target: s.target, prop: s.prop, t: s.t, value: v }]));
            const del = this.$('k-del');
            if (del) del.addEventListener('click', () => { a.run([{ cmd: 'remove_keyframe', target: s.target, prop: s.prop, t: s.t }]); a.select(null); });
        }
        this._bindNumber('s-dur', v => a.run([{ cmd: 'set_duration', value: v }]));
        this.$('saveJson').addEventListener('click', () => this.download(new Blob([JSON.stringify(a.doc, null, 2)], { type: 'application/json' }), 'scena-pogonya.json'));
        this.$('loadJson').addEventListener('change', (e) => this.loadFile(e.target.files && e.target.files[0]));
        this.$('resetScene').addEventListener('click', () => {
            const r = StudioIO.load(STUDIO_SCENE_CHASE);
            a.history.push(r.doc);
            a.sel = null;
            a.refresh();
        });
    }

    download(blob, name) {
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    loadFile(file) {
        if (!file) return;
        const r = new FileReader();
        r.onload = () => {
            let src;
            try { src = JSON.parse(String(r.result)); } catch (e) { this.showResults([{ ok: false, cmd: '', text: StudioText.t('fileError') + 'это не JSON' }]); this.tab('prompt'); return; }
            const errs = StudioSchema.check(src);
            if (errs.length) { this.showResults([{ ok: false, cmd: '', text: StudioText.t('fileError') + errs.join('; ') }]); this.tab('prompt'); return; }
            const res = StudioIO.load(src);
            this.app.history.push(res.doc);
            this.app.sel = null;
            this.app.refresh();
            if (res.errors.length) { this.showResults(res.errors); this.tab('prompt'); }
        };
        r.readAsText(file);
    }

    addKeyNow() {
        const a = this.app, d = a.doc;
        let target = 'runner', prop = 'speed';
        if (a.sel && (a.sel.kind === 'key' || a.sel.kind === 'row')) { target = a.sel.target; prop = a.sel.prop; }
        else if (a.sel && a.sel.kind === 'object') {
            const b = d.behaviors.find(x => x.hunter === a.sel.id);
            if (b) { target = b.id; prop = 'aggression'; }
            else if (d.objects.some(o => o.id === a.sel.id && o.path)) target = a.sel.id;
        }
        const rec = d.objects.find(o => o.id === target) || d.behaviors.find(b => b.id === target);
        if (!rec) return;
        const t = Math.round(a.t * 100) / 100;
        const v = StudioKeys.of(d, target, prop, rec[prop] != null ? rec[prop] : 0)(t);
        const value = prop === 'aggression' ? Math.round(v * 100) / 100 : Math.round(v);
        const r = a.run([{ cmd: 'set_keyframe', target, prop, t, value }], { quiet: true });
        if (r.ok) a.select({ kind: 'key', target, prop, t });
        this.tab('scene');
    }

    // --- camera tab ---
    renderCamera() {
        const a = this.app, d = a.doc, S = StudioText.S, pane = this.$('pane-camera');
        const k = a.shotIndexAt(a.t), s = d.camera.shots[k];
        const persons = d.objects.filter(o => o.type === 'person');
        let h = '';
        if (s) {
            h += '<div class="card"><h3>' + this.icon('ms-camera') + S.selectedShot + ' · ' + StudioText.fmtTime(s.t) + ' с</h3>' +
                '<div class="seg" role="group" aria-label="Режим камеры">' +
                ['follow', 'static', 'flyby'].map(m => '<button type="button" data-mode="' + m + '" class="' + (s.mode === m ? 'on' : '') + '">' + StudioText.cameraMode(m) + '</button>').join('') + '</div>' +
                '<div class="hint">' + this.esc(s.mode === 'follow' ? S.modeHintFollow : s.mode === 'static' ? S.modeHintStatic : S.modeHintFlyby) + '</div>';
            const F = StudioSchema.SHOT_FIELDS[s.mode];
            const g = f => (s[f] != null ? s[f] : F[f].def);
            h += '<div class="field wide"><label for="c-target">Цель камеры</label><select class="inp" id="c-target">' +
                (s.mode === 'static' && !s.target ? '<option value="">точка look</option>' : '') +
                persons.map(o => '<option value="' + o.id + '"' + (s.target === o.id ? ' selected' : '') + '>' + this.esc(o.name) + '</option>').join('') + '</select></div>';
            if (s.mode === 'follow') {
                h += this._slider('c-distance', StudioText.param('distance'), 100, 3000, 10, g('distance'));
                h += this._slider('c-height', StudioText.param('height'), 20, 4000, 10, g('height'));
                h += this._slider('c-angle', StudioText.param('angle'), -180, 180, 5, g('angle'));
                h += this._slider('c-lookAhead', StudioText.param('lookAhead'), -1500, 1500, 10, g('lookAhead'));
                h += this._slider('c-smooth', StudioText.param('smooth'), 0, 2, 0.05, g('smooth'));
            } else if (s.mode === 'static') {
                h += this._number('c-ex', 'Камера X, см', s.eye[0], 10) + this._number('c-ey', 'Камера Y, см', s.eye[1], 10) + this._number('c-eh', 'Высота камеры, см', s.eye[2], 10);
                h += '<div class="hint">' + this.esc(S.eyeHereHint) + '</div><div class="row"><button type="button" class="btn" id="c-here">' + this.icon('ms-orbit', '') + '<span>' + S.eyeHere + '</span></button></div>';
            } else {
                h += '<div class="hint">Точек пролёта: ' + s.keys.length + '. ' + this.esc(S.eyeHereHint) + '</div>' +
                    '<div class="row"><button type="button" class="btn" id="c-addfly">' + this.icon('ms-plus', '') + '<span>Точка пролёта отсюда</span></button></div>';
            }
            h += this._slider('c-fov', StudioText.param('fov'), 15, 100, 1, g('fov'));
            h += '<div class="field wide"><label for="c-trans">' + S.transition + '</label><select class="inp" id="c-trans">' +
                '<option value="smooth"' + (s.transition !== 'cut' ? ' selected' : '') + '>' + S.transSmooth + '</option>' +
                '<option value="cut"' + (s.transition === 'cut' ? ' selected' : '') + '>' + S.transCut + '</option></select></div>';
            h += this._number('c-start', S.shotStart, s.t, 0.1);
            h += '<div class="row"><button type="button" class="btn" id="c-add">' + this.icon('ms-plus', '') + '<span>' + S.addShot + '</span></button>' +
                '<button type="button" class="btn" id="c-del">' + this.icon('ms-trash', '') + '<span>' + S.deleteShot + '</span></button></div></div>';
        } else {
            h += '<div class="row"><button type="button" class="btn" id="c-add">' + this.icon('ms-plus', '') + '<span>' + S.addShot + '</span></button></div>';
        }
        h += '<div class="card"><h3>' + this.icon('cy-metric-deadline') + 'Все ракурсы</h3><div class="list">' +
            d.camera.shots.map((x, i) => '<button type="button" data-shot="' + x.t + '" class="' + (i === k ? 'on' : '') + '">' + StudioText.fmtTime(x.t) + ' с · ' + StudioText.cameraMode(x.mode) + '<small>' + this.esc(x.target ? ((d.objects.find(o => o.id === x.target) || {}).name || x.target) : '') + '</small></button>').join('') +
            '</div></div>';
        pane.innerHTML = h;
        this._shotK = k;

        for (const b of pane.querySelectorAll('[data-shot]')) b.addEventListener('click', () => { a.pause(); a.seek(Number(b.getAttribute('data-shot')) + 0.01); this.renderCamera(); });
        const add = this.$('c-add');
        if (add) add.addEventListener('click', () => {
            const base = s ? Object.assign({}, s) : { mode: 'follow', target: 'runner' };
            delete base.t;
            const t = Math.round(a.t * 10) / 10;
            if (s && Math.abs(s.t - t) < 0.05) return;
            a.run([Object.assign({ cmd: 'set_camera', t }, base)], { quiet: true });
        });
        if (!s) return;
        const set = (patch) => {
            const next = Object.assign({}, s, patch, { cmd: 'set_camera', from: s.t });
            for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
            a.run([next], { quiet: true });
        };
        for (const b of pane.querySelectorAll('[data-mode]')) b.addEventListener('click', () => this.switchMode(s, b.getAttribute('data-mode')));
        const tsel = this.$('c-target');
        if (tsel) tsel.addEventListener('change', () => set({ target: tsel.value || undefined }));
        for (const f of ['distance', 'height', 'angle', 'lookAhead', 'smooth', 'fov']) this._bindSlider('c-' + f, v => set({ [f]: v }));
        this._bindNumber('c-ex', v => set({ eye: [v, s.eye[1], s.eye[2]] }));
        this._bindNumber('c-ey', v => set({ eye: [s.eye[0], v, s.eye[2]] }));
        this._bindNumber('c-eh', v => set({ eye: [s.eye[0], s.eye[1], Math.max(0, v)] }));
        const here = this.$('c-here');
        if (here) here.addEventListener('click', () => set({ eye: this.currentEye() }));
        const fly = this.$('c-addfly');
        if (fly) fly.addEventListener('click', () => {
            const tr = Math.max(0, Math.round((a.t - s.t) * 10) / 10);
            const keys = s.keys.filter(x => Math.abs(x.t - tr) > 0.05).concat([{ t: tr, eye: this.currentEye() }]).sort((x, y) => x.t - y.t);
            set({ keys });
        });
        const tr = this.$('c-trans');
        if (tr) tr.addEventListener('change', () => set({ transition: tr.value }));
        this._bindNumber('c-start', v => set({ t: Math.max(0, Math.min(d.duration - 0.1, v)) }));
        this.$('c-del').addEventListener('click', () => a.run([{ cmd: 'remove_shot', t: s.t }], { quiet: true }));
    }

    // The eye of whatever camera the user looks through now: [x, y, h].
    currentEye() {
        const p = this.app.stage.view.camera.position;
        return [Math.round(p.x), Math.round(p.z), Math.max(20, Math.round(p.y))];
    }

    switchMode(s, mode) {
        if (s.mode === mode) return;
        const a = this.app, target = s.target || 'runner';
        const eye = this.currentEye();
        let shot;
        if (mode === 'follow') shot = { mode, target };
        else if (mode === 'static') shot = { mode, target, eye };
        else {
            const st = StudioSim.objectAt(a.baked, target, a.t) || { x: eye[0], y: eye[1] };
            shot = { mode, target, keys: [{ t: 0, eye }, { t: 3, eye: [Math.round((eye[0] + st.x) / 2), Math.round((eye[1] + st.y) / 2), Math.max(200, Math.round(eye[2] * 0.6))] }] };
        }
        a.run([Object.assign({ cmd: 'set_camera', t: s.t, from: s.t }, s.transition ? { transition: s.transition } : {}, shot)], { quiet: true });
    }

    // --- recording ---
    startRecording() {
        const a = this.app;
        if (!StudioRecorder.supported()) { this.showResults([{ ok: false, cmd: '', text: StudioText.t('noRecorder') }]); this.tab('prompt'); return; }
        a.setView('scene');
        a.pause();
        a.t = 0;
        a.drawAt(0, 0);
        this.rec = new StudioRecorder(a.canvas, 30);
        a.recording = true;
        this.$('record').classList.add('on');
        this.$('download').hidden = true;
        this.rec.start().then((blob) => {
            a.recording = false;
            this.$('record').classList.remove('on');
            window.studio.lastVideo = blob;
            const link = this.$('download');
            if (this._url) URL.revokeObjectURL(this._url);
            this._url = URL.createObjectURL(blob);
            link.href = this._url;
            link.hidden = false;
            this.badge();
        }).catch((e) => {
            a.recording = false;
            this.$('record').classList.remove('on');
            console.warn('Студия: запись не удалась', e);
        });
        a.play();
    }

    stopRecording() {
        if (this.rec) this.rec.stop();
        this.app.pause();
    }
}

window.studio = { app: null, lastVideo: null };
window.addEventListener('load', () => {
    const app = new StudioApp();
    window.studio.app = app;
    app.boot();
});
