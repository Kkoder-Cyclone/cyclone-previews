// overlay.js — marks over the 3D view (SVG): the path of the selected object with drag
// handles, the trail to come, and name tags in the free camera. Points are projected with
// ArcEngine's View3D.projectToScreen; a drag goes back to the ground through
// View3D.pointerToGround. Mouse and finger: Pointer Events. A drag ends as one move_point command.

class StudioOverlay {
    constructor(app, svg) {
        this.app = app;
        this.svg = svg;
        this.ns = 'http://www.w3.org/2000/svg';
        this.pathEl = this._el('polyline', { class: 'path' });
        this.handles = [];
        this.tags = new Map();
        this._drag = null;
        svg.appendChild(this.pathEl);
        this.visible = true;
        window.addEventListener('pointermove', e => this._move(e));
        window.addEventListener('pointerup', e => this._up(e));
        window.addEventListener('pointercancel', e => this._up(e));
    }

    _el(tag, attrs) {
        const el = document.createElementNS(this.ns, tag);
        for (const k in attrs) el.setAttribute(k, attrs[k]);
        return el;
    }

    // Draw for the current frame. Cheap: ~150 projections.
    update() {
        const app = this.app, view = app.stage.view;
        const show = this.visible && !app.recording;
        this.svg.style.display = show ? '' : 'none';
        if (!show) return;
        const pathId = app.editPath();
        const path = pathId ? app.baked.paths.get(pathId) : null;
        const rect = this.svg.getBoundingClientRect();
        const W = rect.width, H = rect.height;
        view.refreshMatrices();
        if (path) {
            const pts = [];
            const step = Math.max(40, path.length / 220);
            for (let s = 0; s <= path.length; s += step) {
                const p = path.at(s), q = view.projectToScreen(p.x, p.y, 16);
                if (q && !q.behind) pts.push(q.x.toFixed(1) + ',' + q.y.toFixed(1));
                else if (pts.length) pts.push('');
            }
            this.pathEl.setAttribute('points', pts.filter(Boolean).join(' '));
        } else this.pathEl.setAttribute('points', '');
        // handles: one per control point; hidden while playing
        const doc = app.doc, rec = pathId ? doc.paths.find(p => p.id === pathId) : null;
        const n = rec && !app.playing ? rec.points.length : 0;
        while (this.handles.length < n) this._addHandle(this.handles.length);
        this.handles.forEach((h, i) => {
            if (i >= n) { h.g.style.display = 'none'; return; }
            const pt = (this._drag && this._drag.index === i && this._drag.live) ? this._drag.live : rec.points[i];
            const q = view.projectToScreen(pt[0], pt[1], 16);
            const vis = q && !q.behind && q.x > 6 && q.y > 6 && q.x < W - 6 && q.y < H - 6;
            h.g.style.display = vis ? '' : 'none';
            if (vis) h.g.setAttribute('transform', 'translate(' + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + ')');
        });
        // name tags over the actors (free camera, paused)
        const tagsOn = app.viewMode === 'free';
        for (const o of doc.objects) {
            if (o.type !== 'person') continue;
            let tag = this.tags.get(o.id);
            if (!tag) {
                tag = this._el('text', { class: 'tag', 'text-anchor': 'middle' });
                this.svg.appendChild(tag);
                this.tags.set(o.id, tag);
            }
            const st = tagsOn ? StudioSim.objectAt(app.baked, o.id, app.t) : null;
            const q = st ? view.projectToScreen(st.x, st.y, 230 * (o.scale || 1)) : null;
            if (q && !q.behind && q.x > 0 && q.x < W && q.y > 0 && q.y < H) {
                tag.textContent = o.name;
                tag.setAttribute('x', q.x.toFixed(1));
                tag.setAttribute('y', q.y.toFixed(1));
                tag.style.display = '';
            } else tag.style.display = 'none';
        }
        for (const [id, tag] of this.tags) if (!doc.objects.some(o => o.id === id)) { tag.remove(); this.tags.delete(id); }
    }

    _addHandle(i) {
        const g = this._el('g', {});
        const hit = this._el('circle', { r: 20, class: 'hit' });
        const c = this._el('circle', { r: 8, class: 'handle' });
        const title = this._el('title', {});
        title.textContent = 'Точка пути ' + (i + 1);
        c.appendChild(title);
        g.append(hit, c);
        const down = (e) => this._down(e, i, c);
        hit.addEventListener('pointerdown', down);
        c.addEventListener('pointerdown', down);
        this.svg.appendChild(g);
        this.handles.push({ g, c });
    }

    _down(e, index, c) {
        if (this.app.playing) return;
        e.preventDefault();
        e.stopPropagation();
        this._drag = { id: e.pointerId, index, c, base: this.app.doc, path: this.app.editPath(), live: null };
        c.classList.add('drag');
    }

    _move(e) {
        const d = this._drag;
        if (!d || d.id !== e.pointerId) return;
        const r = this.app.stage.canvas.getBoundingClientRect();
        const view = this.app.stage.view;
        view.refreshMatrices();
        const hit = view.pointerToGround(e.clientX - r.left, e.clientY - r.top, 0, null);
        if (!hit) return;
        const x = Math.round(Math.max(-1900, Math.min(12300, hit.x))), y = Math.round(Math.max(-1900, Math.min(12300, hit.y)));
        d.live = [x, y];
        d.cmd = { cmd: 'move_point', path: d.path, index: d.index, x, y };
        const res = StudioCommands.apply(d.base, d.cmd);
        if (res.ok) this.app.preview(res.doc);
    }

    _up(e) {
        const d = this._drag;
        if (!d || d.id !== e.pointerId) return;
        this._drag = null;
        d.c.classList.remove('drag');
        if (d.cmd) {
            this.app.previewEnd();
            this.app.run([d.cmd], { from: d.base, quiet: true });
        }
    }
}
