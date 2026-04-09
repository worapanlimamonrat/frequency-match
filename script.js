const main = document.querySelector('.main');
const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
const infoEl = document.querySelector('.info');
const btnHear = document.querySelector('.btn-hear');

const LABEL_GAP = 10;
const LABEL_SIZE = 11;
const POINT_RADIUS = 7;
const PAD = { top: POINT_RADIUS, right: POINT_RADIUS, bottom: LABEL_GAP + LABEL_SIZE, left: 0 };
const DURATION = 2;
const C4_HZ = 261.63;

const DEFAULT_POINTS = [
    { x: 0,   y: 0.5 },
    { x: 0.5, y: 0.6 },
    { x: 1.5, y: 0.4 },
    { x: 2,   y: 0.5 },
];

const points = DEFAULT_POINTS.map(p => ({ ...p }));

let targetPoints = null;
let dragging = null;        // index into points[] (user curve), or null
let draggingTarget = null;  // index into targetPoints[] (phase 4 only), or null
let currentPlayTime = -1;
let playbackState = null;
let dragToneCtx = null;
let dragToneOsc = null;
let dragToneGain = null;
let targetPlayed = false;   // tracks if target sound has been played in phase 2

// --- frequency helpers ---

function yToHz(y) {
    return C4_HZ * Math.pow(2, y * 2);
}

function getInfoText(idx, p) {
    return `p${idx} (${p.x.toFixed(2)}s, ${Math.round(yToHz(p.y))}Hz)`;
}

// --- bezier helpers ---

function cubicBezierPoint(pts, t) {
    const mt = 1 - t;
    return {
        x: mt*mt*mt*pts[0].x + 3*mt*mt*t*pts[1].x + 3*mt*t*t*pts[2].x + t*t*t*pts[3].x,
        y: mt*mt*mt*pts[0].y + 3*mt*mt*t*pts[1].y + 3*mt*t*t*pts[2].y + t*t*t*pts[3].y,
    };
}

function getFreqAtTime(pts, t) {
    const N = 400;
    const samples = [];
    for (let i = 0; i <= N; i++) samples.push(cubicBezierPoint(pts, i / N));
    samples.sort((a, b) => a.x - b.x);
    if (t <= samples[0].x) return yToHz(samples[0].y);
    if (t >= samples[N].x) return yToHz(samples[N].y);
    for (let i = 0; i < samples.length - 1; i++) {
        if (samples[i].x <= t && t < samples[i + 1].x) {
            const alpha = (t - samples[i].x) / (samples[i + 1].x - samples[i].x);
            return yToHz(samples[i].y + alpha * (samples[i + 1].y - samples[i].y));
        }
    }
    return yToHz(0.5);
}

function computeScore() {
    const N = 100;
    let total = 0;
    for (let i = 0; i <= N; i++) {
        const t = (i / N) * DURATION;
        const centsErr = Math.abs(1200 * Math.log2(getFreqAtTime(points, t) / getFreqAtTime(targetPoints, t)));
        total += centsErr;
    }
    return Math.max(0, 10 * (1 - (total / (N + 1)) / 600));
}

function generateTarget() {
    return [
        { x: 0,   y: Math.random() },
        { x: 0.4 + Math.random() * 0.4, y: Math.random() },
        { x: 1.2 + Math.random() * 0.4, y: Math.random() },
        { x: 2,   y: Math.random() },
    ];
}

// --- audio playback ---

function stopPlayback() {
    if (playbackState) {
        if (playbackState.animFrameId) cancelAnimationFrame(playbackState.animFrameId);
        if (playbackState.oscillator) {
            playbackState.oscillator.onended = null;
            try { playbackState.oscillator.stop(); } catch(e) {}
        }
        if (playbackState.audioCtx) playbackState.audioCtx.close();
        playbackState = null;
    }
    currentPlayTime = -1;
    updateButtonStates();
    draw();
}

function startPlayback(pts, which) {
    stopPlayback();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.type = 'sine';

    const startTime = audioCtx.currentTime;
    const STEPS = 120;

    oscillator.frequency.setValueAtTime(getFreqAtTime(pts, 0), startTime);
    for (let i = 1; i <= STEPS; i++) {
        const t = (i / STEPS) * DURATION;
        oscillator.frequency.linearRampToValueAtTime(getFreqAtTime(pts, t), startTime + t);
    }

    // short gain ramp to eliminate clicks; no alpha blending with white progress line
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.5, startTime + 0.015);
    gainNode.gain.setValueAtTime(0.5, startTime + DURATION - 0.015);
    gainNode.gain.linearRampToValueAtTime(0, startTime + DURATION);

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + DURATION + 0.05);

    playbackState = { audioCtx, oscillator, gainNode, startTime, which, animFrameId: null };

    oscillator.onended = () => {
        if (playbackState && playbackState.oscillator === oscillator) {
            currentPlayTime = -1;
            playbackState = null;
            updateButtonStates();
            draw();
        }
    };

    updateButtonStates();
    animatePlayback();
}

function animatePlayback() {
    if (!playbackState) return;
    const elapsed = playbackState.audioCtx.currentTime - playbackState.startTime;
    currentPlayTime = Math.max(0, Math.min(elapsed, DURATION));
    draw();
    if (elapsed < DURATION) {
        playbackState.animFrameId = requestAnimationFrame(animatePlayback);
    }
}

// --- drag tone ---

function startDragTone(freq) {
    stopDragTone();
    dragToneCtx = new (window.AudioContext || window.webkitAudioContext)();
    dragToneOsc = dragToneCtx.createOscillator();
    dragToneGain = dragToneCtx.createGain();
    dragToneOsc.type = 'sine';
    dragToneOsc.frequency.setValueAtTime(freq, dragToneCtx.currentTime);
    dragToneGain.gain.setValueAtTime(0, dragToneCtx.currentTime);
    dragToneGain.gain.linearRampToValueAtTime(0.25, dragToneCtx.currentTime + 0.02);
    dragToneOsc.connect(dragToneGain);
    dragToneGain.connect(dragToneCtx.destination);
    dragToneOsc.start();
}

function updateDragTone(freq) {
    if (!dragToneCtx || !dragToneOsc) return;
    dragToneOsc.frequency.setValueAtTime(freq, dragToneCtx.currentTime);
}

function stopDragTone() {
    if (dragToneCtx) {
        const g = dragToneGain, o = dragToneOsc, c = dragToneCtx;
        g.gain.setValueAtTime(g.gain.value, c.currentTime);
        g.gain.linearRampToValueAtTime(0, c.currentTime + 0.05);
        setTimeout(() => { try { o.stop(); } catch(e) {} c.close(); }, 100);
        dragToneCtx = null;
        dragToneOsc = null;
        dragToneGain = null;
    }
}

// --- button state ---

function updateButtonStates() {
    const phase = main.dataset.phase;
    const playing = !!playbackState;
    if (phase === '2' || phase === '3') {
        btnHear.textContent = playing ? 'reset' : (phase === '2' ? 'play target' : 'play mine');
    }
    if (phase === '4') {
        const btnTarget = document.querySelector('.btn-play-target');
        const btnMine = document.querySelector('.btn-play-mine');
        if (playing) {
            btnTarget.textContent = playbackState.which === 'target' ? 'reset' : 'target';
            btnMine.textContent = playbackState.which === 'mine' ? 'reset' : 'mine';
        } else {
            btnTarget.textContent = 'target';
            btnMine.textContent = 'mine';
        }
    }
}

// --- canvas ---

function getGraphBounds() {
    ctx.font = `${LABEL_SIZE}px Lexend, sans-serif`;
    const yLabelWidth = ctx.measureText('C4').width;
    const gx = yLabelWidth + LABEL_GAP;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const gy = PAD.top;
    const gw = W - gx - PAD.right;
    const gh = H - PAD.top - PAD.bottom;
    return { gx, gy, gw, gh, W, H };
}

function toCanvas(p, b) {
    return {
        x: b.gx + (p.x / 2) * b.gw,
        y: b.gy + b.gh - p.y * b.gh,
    };
}

function toGraph(cx, cy, b) {
    return {
        x: ((cx - b.gx) / b.gw) * 2,
        y: (b.gy + b.gh - cy) / b.gh,
    };
}

function initCanvas() {
    const dpr = window.devicePixelRatio || 1;
    // Clear inline width so CSS/flex determines the current width (fixes stale width on resize)
    canvas.style.width = '';
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.scale(dpr, dpr);
    draw();
}

function drawTooltip(text, px, py, b) {
    const PAD_X = 8, PAD_Y = 5;
    ctx.font = '12px Lexend, sans-serif';
    const textW = ctx.measureText(text).width;
    const boxW = textW + PAD_X * 2;
    const boxH = 12 + PAD_Y * 2;

    let bx = px - boxW / 2;
    let by = py - POINT_RADIUS - 6 - boxH;

    // flip below the point if too close to top edge
    if (by < b.gy) by = py + POINT_RADIUS + 6;
    // clamp horizontally
    bx = Math.max(b.gx, Math.min(b.gx + b.gw - boxW, bx));

    ctx.fillStyle = '#fff';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + PAD_X, by + boxH / 2);
    ctx.font = `${LABEL_SIZE}px Lexend, sans-serif`;
}

function drawCurve(pts, b, curveColor, dotColor) {
    const cp = pts.map(p => toCanvas(p, b));

    ctx.strokeStyle = dotColor;
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(cp[0].x, cp[0].y);
    ctx.lineTo(cp[1].x, cp[1].y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cp[2].x, cp[2].y);
    ctx.lineTo(cp[3].x, cp[3].y);
    ctx.stroke();

    ctx.strokeStyle = curveColor;
    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cp[0].x, cp[0].y);
    ctx.bezierCurveTo(cp[1].x, cp[1].y, cp[2].x, cp[2].y, cp[3].x, cp[3].y);
    ctx.stroke();

    ctx.fillStyle = curveColor;
    ctx.setLineDash([]);
    cp.forEach(({ x, y }) => {
        ctx.beginPath();
        ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    });
}

function draw() {
    const b = getGraphBounds();
    const { gx, gy, gw, gh } = b;
    const phase = main.dataset.phase;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${LABEL_SIZE}px Lexend, sans-serif`;

    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx, gy + gh);
    ctx.lineTo(gx + gw, gy + gh);
    ctx.stroke();

    // labels
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText('0', gx, gy + gh + LABEL_GAP);
    ctx.fillText('2', gx + gw, gy + gh + LABEL_GAP);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('C6', 0, gy);
    ctx.fillText('C5', 0, gy + gh / 2);
    ctx.fillText('C4', 0, gy + gh);

    // target curve (phase 4, grey, drawn behind user curve)
    if (phase === '4' && targetPoints) {
        drawCurve(targetPoints, b, '#969696', 'rgba(150,150,150,0.45)');
    }

    // user curve (phases 3 & 4)
    if (phase === '3' || phase === '4') {
        drawCurve(points, b, '#fff', 'rgba(255,255,255,0.25)');
    }

    // progress line — same weight as y-axis but fully opaque white
    if (currentPlayTime >= 0) {
        const lineX = gx + (currentPlayTime / DURATION) * gw;
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lineX, gy);
        ctx.lineTo(lineX, gy + gh);
        ctx.stroke();
    }

    // tooltip — drawn last so it appears above everything
    if (infoEl.textContent) {
        let heldPt = null;
        if (dragging !== null) heldPt = toCanvas(points[dragging], b);
        else if (draggingTarget !== null && targetPoints) heldPt = toCanvas(targetPoints[draggingTarget], b);
        if (heldPt) drawTooltip(infoEl.textContent, heldPt.x, heldPt.y, b);
    }
}

// --- input ---

function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const src = e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function handleDown(e) {
    const phase = main.dataset.phase;
    if (phase !== '3' && phase !== '4') return;

    const pos = getPos(e);
    const b = getGraphBounds();
    dragging = null;
    draggingTarget = null;
    let minDist = Infinity;

    // Check user points
    points.map(p => toCanvas(p, b)).forEach((c, i) => {
        const d = Math.hypot(pos.x - c.x, pos.y - c.y);
        if (d < minDist && d < 20) { minDist = d; dragging = i; }
    });

    // Check target points in phase 4 if no user point grabbed
    if (dragging === null && phase === '4' && targetPoints) {
        targetPoints.map(p => toCanvas(p, b)).forEach((c, i) => {
            const d = Math.hypot(pos.x - c.x, pos.y - c.y);
            if (d < minDist && d < 20) { minDist = d; draggingTarget = i; }
        });
    }

    if (dragging !== null) {
        infoEl.textContent = getInfoText(dragging, points[dragging]);
        stopPlayback();
        startDragTone(yToHz(points[dragging].y));
        draw();
    } else if (draggingTarget !== null) {
        infoEl.textContent = getInfoText(draggingTarget, targetPoints[draggingTarget]);
        stopPlayback();
        startDragTone(yToHz(targetPoints[draggingTarget].y));
        draw();
    }
}

function handleMove(e) {
    const phase = main.dataset.phase;
    const isTouch = !!e.touches;

    // Cursor — mouse only (no cursor concept on touch)
    if (!isTouch) {
        if (phase === '3' || phase === '4') {
            const pos = getPos(e);
            const b = getGraphBounds();
            const allCp = points.map(p => toCanvas(p, b));
            if (phase === '4' && targetPoints) allCp.push(...targetPoints.map(p => toCanvas(p, b)));
            const isNear = allCp.some(c => Math.hypot(pos.x - c.x, pos.y - c.y) < 20);
            if (phase === '3') {
                canvas.style.cursor = isNear ? (dragging !== null ? 'grabbing' : 'grab') : 'default';
            } else {
                canvas.style.cursor = isNear ? 'pointer' : 'default';
            }
        } else {
            canvas.style.cursor = 'default';
        }
    }

    // Drag movement — only user points, only in phase 3
    if (dragging === null || phase !== '3') return;

    const pos = getPos(e);
    const b = getGraphBounds();
    const g = toGraph(pos.x, pos.y, b);
    g.x = Math.max(0, Math.min(2, g.x));
    g.y = Math.max(0, Math.min(1, g.y));
    if (dragging === 0) g.x = 0;
    if (dragging === 3) g.x = 2;

    points[dragging] = g;
    infoEl.textContent = getInfoText(dragging, points[dragging]);
    updateDragTone(yToHz(g.y));
    draw();
}

function handleUp() {
    if (dragging !== null || draggingTarget !== null) {
        stopDragTone();
        dragging = null;
        draggingTarget = null;
        infoEl.textContent = '';
        draw();
    }
}

canvas.addEventListener('mousedown', handleDown);
canvas.addEventListener('touchstart', e => { e.preventDefault(); handleDown(e); }, { passive: false });

window.addEventListener('mousemove', handleMove);
window.addEventListener('touchmove', e => { e.preventDefault(); handleMove(e); }, { passive: false });

window.addEventListener('mouseup', handleUp);
window.addEventListener('touchend', handleUp);

window.addEventListener('resize', () => {
    const phase = main.dataset.phase;
    if (phase === '2' || phase === '3' || phase === '4') initCanvas();
});

// --- Phase management ---

function setPhase(phase) {
    stopPlayback();
    stopDragTone();
    dragging = null;
    draggingTarget = null;
    infoEl.textContent = '';
    canvas.style.cursor = 'default';

    main.dataset.phase = phase;

    if (phase === '2') {
        targetPoints = generateTarget();
        for (let i = 0; i < 4; i++) points[i] = { ...DEFAULT_POINTS[i] };
        btnHear.textContent = 'play target';
        targetPlayed = false;
        main.dataset.targetPlayed = false;
        // Clear canvas before rAF to avoid flashing stale content
        canvas.width = 0;
        requestAnimationFrame(() => initCanvas());
    } else if (phase === '3') {
        btnHear.textContent = 'play mine';
        canvas.width = 0;
        requestAnimationFrame(() => initCanvas());
    } else if (phase === '4') {
        const score = computeScore();
        document.querySelector('.score-value').innerHTML =
            `${score.toFixed(2)} <span class="score-max">/ 10</span>`;
        canvas.width = 0;
        requestAnimationFrame(() => initCanvas());
    }
}

// --- Button events ---

document.querySelector('.btn-play').addEventListener('click', () => setPhase('2'));
document.querySelector('.btn-create').addEventListener('click', () => setPhase('3'));
document.querySelector('.btn-done').addEventListener('click', () => setPhase('4'));
document.querySelector('.btn-okay').addEventListener('click', () => setPhase('1'));

btnHear.addEventListener('click', () => {
    if (playbackState) {
        stopPlayback();
    } else if (main.dataset.phase === '2' && targetPoints) {
        startPlayback(targetPoints, 'target');
        targetPlayed = true;
        main.dataset.targetPlayed = true;
    } else if (main.dataset.phase === '3') {
        startPlayback(points, 'mine');
    }
});

document.querySelector('.btn-play-target').addEventListener('click', () => {
    if (playbackState && playbackState.which === 'target') {
        stopPlayback();
    } else {
        startPlayback(targetPoints, 'target');
    }
});

document.querySelector('.btn-play-mine').addEventListener('click', () => {
    if (playbackState && playbackState.which === 'mine') {
        stopPlayback();
    } else {
        startPlayback(points, 'mine');
    }
});
