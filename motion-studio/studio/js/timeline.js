// timeline.js — the studio timeline (DOM, own code, no libraries): ruler with a scrub
// playhead, the camera row with shots, and keyframe rows. Mouse and finger work the same
// through Pointer Events. Every drag ends as ONE command (set_keyframe / set_camera with
// "from"), so undo treats a human drag like an AI command.

class StudioTimeline {
    constructor(app, root) {
        this.app = app;
        this.root = root;
        this.body = root.querySelector('.tl-body');
        this.pps = 50;          // px per second
        this.rows = [];
        this._drag = null;
        this.body.addEventListener('pointermove', e => this._move(e));
        this.body.addEventListener('pointerup', e => this._up(e));
        this.body.addEventListener('pointercancel', e => this._up(e));
        window.addEventListener('resize', () => this.render());
    }

    // Rows from the document: camera, then speed of path objects, then behavior params with keys.
    _rowsOf(doc) {
        const rows = [{ kind: 'camera', label: StudioText.t('rowCamera'), color: '#0A6C7A' }];
        for (const o of doc.objects) {
            if (o.path) rows.push({ kind: 'key', target: o.id, prop: 'speed', label: o.name, sub: 'скорость', color: o.outfit === 'runner' ? '#ff6b4a' : '#1f3550' });
        }
        for (const b of doc.behaviors) {
            const o = doc.objects.find(x => x.id === b.hunter);
            const name = o ? o.name : b.hunter;
            rows.push({ kind: 'key', target: b.id, prop: 'aggression', label: name, sub: 'агрессия', color: '#1f3550' });
            if (doc.keyframes.some(k => k.target === b.id && k.prop === 'lane')) rows.push({ kind: 'key', target: b.id, prop: 'lane', label: name, sub: 'полоса', color: '#1f3550' });
        }
        return rows;
    }

    render() {
        const doc = this.app.doc;
        const D = doc.duration;
        const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tl-label')) || 128;
        const avail = Math.max(120, this.body.clientWidth - labelW - 2 * StudioTimeline.PAD - 2);
        this.pps = Math.max(26, avail / D);
        const W = Math.ceil(D * this.pps) + 2 * StudioTimeline.PAD;
        this.rows = this._rowsOf(doc);
        const grid = document.createElement('div');
        grid.className = 'tl-grid';
        grid.style.width = (labelW + W) + 'px';
        // ruler
        const ruler = this._row('', null, 'tl-ruler');
        const rt = ruler.querySelector('.tl-track');
        const step = this.pps < 40 ? 2 : 1;
        for (let s = 0; s <= D + 1e-6; s += 0.5) {
            const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
            if (!major && this.pps < 40) continue;
            const tk = document.createElement('div');
            tk.className = 'tick' + (major ? '' : ' minor');
            tk.style.left = (StudioTimeline.PAD + s * this.pps) + 'px';
            if (major) tk.textContent = s + ' с';
            rt.appendChild(tk);
        }
        rt.addEventListener('pointerdown', e => this._down(e, { type: 'scrub' }));
        grid.appendChild(ruler);
        // rows
        for (const r of this.rows) {
            const row = this._row(r.label, r.color, 'tl-row', r.sub);
            const tr = row.querySelector('.tl-track');
            if (r.kind === 'camera') this._shots(tr, doc);
            else this._keys(tr, doc, r);
            grid.appendChild(row);
        }
        const ph = document.createElement('div');
        ph.className = 'playhead';
        grid.appendChild(ph);
        this.playhead = ph;
        this.labelW = labelW;
        this.body.replaceChildren(grid);
        this.updatePlayhead();
    }

    // Short name for narrow screens: "Преследователь 1" -> "Пресл. 1".
    static shortLabel(label) {
        return String(label).split(' ').map(w => w.length > 8 ? w.slice(0, 5) + '.' : w).join(' ');
    }

    _row(label, color, cls, sub) {
        const row = document.createElement('div');
        row.className = cls;
        const l = document.createElement('div');
        l.className = 'tl-label';
        if (color) {
            const d = document.createElement('span');
            d.className = 'dot';
            d.style.background = color;
            l.appendChild(d);
        }
        const nm = document.createElement('span');
        nm.className = 'nm';
        const b = document.createElement('b');
        const full = document.createElement('span');
        full.className = 'full';
        full.textContent = label;
        const short = document.createElement('span');
        short.className = 'short';
        short.textContent = StudioTimeline.shortLabel(label);
        b.append(full, short);
        nm.appendChild(b);
        if (sub) { const sm = document.createElement('small'); sm.textContent = sub; nm.appendChild(sm); }
        l.appendChild(nm);
        l.title = label + (sub ? ' · ' + sub : '');
        const tr = document.createElement('div');
        tr.className = 'tl-track';
        row.append(l, tr);
        return row;
    }

    _shots(tr, doc) {
        const shots = doc.camera.shots;
        shots.forEach((s, i) => {
            const end = i + 1 < shots.length ? shots[i + 1].t : doc.duration;
            const el = document.createElement('div');
            el.className = 'shot ' + s.mode + (this._isSel('shot', s.t) ? ' sel' : '');
            el.style.left = (StudioTimeline.PAD + s.t * this.pps) + 'px';
            el.style.width = Math.max(10, (end - s.t) * this.pps - 2) + 'px';
            el.textContent = StudioText.cameraMode(s.mode);
            el.title = StudioText.cameraMode(s.mode) + ', ' + StudioText.fmtTime(s.t) + ' с';
            el.addEventListener('pointerdown', e => this._down(e, { type: 'shot', shot: s, el }));
            tr.appendChild(el);
        });
    }

    _keys(tr, doc, r) {
        const keys = doc.keyframes.filter(k => k.target === r.target && k.prop === r.prop);
        // the curve of the value under the keys (speed or aggression), normalized to the row
        const kind = doc.objects.some(o => o.id === r.target) ? 'object' : 'behavior';
        const range = StudioSchema.KEY_PROPS[kind][r.prop];
        const rec = kind === 'object' ? doc.objects.find(o => o.id === r.target) : doc.behaviors.find(b => b.id === r.target);
        const fn = StudioKeys.of(doc, r.target, r.prop, rec && rec[r.prop] != null ? rec[r.prop] : (r.prop === 'speed' ? 0 : range[0]));
        const W = doc.duration * this.pps, svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'speedline');
        svg.setAttribute('viewBox', '0 0 ' + Math.max(1, W) + ' 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.width = W + 'px';
        svg.style.left = StudioTimeline.PAD + 'px';
        svg.style.height = 'calc(100% - 8px)';
        let d = 'M0 100';
        for (let x = 0; x <= W; x += 4) {
            const v = fn(x / this.pps), u = (v - range[0]) / Math.max(1e-6, range[1] - range[0]);
            d += ' L' + x.toFixed(1) + ' ' + (100 - Math.max(0, Math.min(1, u)) * 92).toFixed(1);
        }
        d += ' L' + W.toFixed(1) + ' 100 Z';
        const p = document.createElementNS(svgNS, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
        tr.appendChild(svg);
        for (const k of keys) {
            const el = document.createElement('div');
            el.className = 'key' + (this._isSel('key', k.t, r) ? ' sel' : '');
            el.style.left = (StudioTimeline.PAD + k.t * this.pps) + 'px';
            el.title = r.label + ': ' + k.value + ' в ' + StudioText.fmtTime(k.t) + ' с';
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', el.title);
            el.addEventListener('pointerdown', e => this._down(e, { type: 'key', key: k, row: r, el }));
            tr.appendChild(el);
        }
        tr.addEventListener('pointerdown', (e) => {
            if (e.target === tr || e.target.tagName === 'svg' || e.target.tagName === 'path') this.app.select({ kind: 'row', target: r.target, prop: r.prop });
        });
    }

    _isSel(kind, t, r) {
        const s = this.app.sel;
        if (!s || s.kind !== kind || Math.abs(s.t - t) > 0.005) return false;
        return kind === 'shot' || (s.target === r.target && s.prop === r.prop);
    }

    _tAt(e) {
        const rect = this.body.getBoundingClientRect();
        const x = e.clientX - rect.left + this.body.scrollLeft - this.labelW - StudioTimeline.PAD;
        return Math.max(0, Math.min(this.app.doc.duration, x / this.pps));
    }

    _down(e, d) {
        e.preventDefault();
        e.stopPropagation();
        try { this.body.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
        this._drag = Object.assign({ id: e.pointerId, x0: e.clientX, moved: false, base: this.app.doc }, d);
        if (d.type === 'scrub') { this.app.pause(); this.app.seek(this._tAt(e)); }
    }

    _move(e) {
        const d = this._drag;
        if (!d || d.id !== e.pointerId) return;
        if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
        if (!d.moved) return;
        const t = Math.round(this._tAt(e) * 20) / 20;   // 0.05 s grid
        if (d.type === 'scrub') { this.app.seek(this._tAt(e)); return; }
        if (d.type === 'key') {
            d.el.style.left = (StudioTimeline.PAD + t * this.pps) + 'px';
            d.cmd = { cmd: 'set_keyframe', target: d.row.target, prop: d.row.prop, t, value: d.key.value, from: d.key.t };
        } else if (d.type === 'shot') {
            d.el.style.left = (StudioTimeline.PAD + t * this.pps) + 'px';
            const s = Object.assign({}, d.shot, { cmd: 'set_camera', t, from: d.shot.t });
            d.cmd = s;
        }
        if (d.cmd) {
            const r = StudioCommands.apply(d.base, d.cmd);
            if (r.ok) this.app.preview(r.doc);
        }
    }

    _up(e) {
        const d = this._drag;
        if (!d || d.id !== e.pointerId) return;
        this._drag = null;
        if (d.type === 'scrub') return;
        if (!d.moved) {
            if (d.type === 'key') { this.app.select({ kind: 'key', target: d.row.target, prop: d.row.prop, t: d.key.t }); this.app.seek(d.key.t); }
            if (d.type === 'shot') { this.app.select({ kind: 'shot', t: d.shot.t }); this.app.seek(d.shot.t + 0.01); this.app.ui.tab('camera'); }
            return;
        }
        if (d.cmd) {
            this.app.previewEnd();
            const res = this.app.run([d.cmd], { from: d.base, quiet: true });
            if (res.ok && d.type === 'key') this.app.select({ kind: 'key', target: d.row.target, prop: d.row.prop, t: d.cmd.t });
            if (res.ok && d.type === 'shot') this.app.select({ kind: 'shot', t: d.cmd.t });
        }
    }

    updatePlayhead() {
        if (this.playhead) this.playhead.style.left = (this.labelW + StudioTimeline.PAD + this.app.t * this.pps) + 'px';
    }
}

StudioTimeline.PAD = 10;   // px before 0 s and after the end: keys at the edges stay whole
