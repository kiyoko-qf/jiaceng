(function () {
  'use strict';

  const D = window.CASE;
  const KEY = 'jiaceng.save.v3';
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const txt = (s) => esc(s).replace(/\n/g, '<br>');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowHM = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const CREEPY = /他睡得很沉|别抬头|他在上面|你终于|就在你头顶|新来的年轻人|他一直在|没有人住|在给你腾地方/;

  const SCENES = {};
  D.scenes.forEach((s) => { SCENES[s.id] = s; });

  function fresh() {
    return {
      scene: 'title', name: '', nameSet: false, volume: 55, effects: 2, tension: 0, flags: [],
      monitorSeen: false, ending: null, startedAt: 0, gateTries: 0, round: 0, listenScene: '', hintSeen: false,
    };
  }
  let S = fresh();
  let lastScene = null;
  let devMode = false;
  let chatToken = 0;
  let cctvRAF = null;
  let src = null;

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw); if (s && s.v === 3 && s.state) S = Object.assign(fresh(), s.state); }
  } catch (e) {}
  try { localStorage.removeItem('jiaceng.save.v2'); } catch (e) {}

  const params = new URLSearchParams(location.search);
  if (params.get('fresh')) { try { localStorage.removeItem(KEY); } catch (e) {} S = fresh(); }
  const dev = params.get('dev');
  if (dev) { devMode = true; S = Object.assign(fresh(), { scene: dev, name: '林秋' }); }

  function persist() { if (devMode) return; try { localStorage.setItem(KEY, JSON.stringify({ v: 3, state: S })); } catch (e) {} }

  function withName(line) {
    const n = (S.name || '').trim();
    return n ? line.replace('{name}', n) : line.replace('{name}，', '');
  }

  /* ================= 音频 ================= */
  const A = {
    ctx: null, master: null, bgmNodes: null, noise: null, noiseGain: null,
    drone: null, droneGain: null, heartTimer: null, muted: false,

    init() {
      if (this.ctx || !window.AudioContext) return;
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = (S.volume / 100) * 0.62;
      this.muted = S.volume <= 0;
      this.master.connect(ctx.destination);
    },
    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    setVolume(v) {
      this.muted = v <= 0;
      if (!this.ctx) return;
      const g = Math.max(0.0001, (v / 100) * 0.62);
      try {
        this.master.gain.cancelScheduledValues(this.ctx.currentTime);
        this.master.gain.linearRampToValueAtTime(g, this.ctx.currentTime + 0.12);
      } catch (e) {}
      if (v <= 0) { this.stopBgm(); this.static(false); this.heartbeat(false); this.stopDrone(); }
    },

    bgm(kind) {
      if (this.currentBgm === kind && this.bgmNodes) return;
      this.currentBgm = kind || null;
      if (!this.ctx || this.muted) return;
      this.stopBgm();
      if (!kind) return;
      const ctx = this.ctx, g = ctx.createGain();
      g.gain.value = 0; g.connect(this.master);

      if (kind === 'warm') {
        // 温柔的开场：三角波琶音 + 极低的铺底
        g.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 4);
        const pad = ctx.createOscillator(), pg = ctx.createGain();
        pad.type = 'sine'; pad.frequency.value = 130.81; pg.gain.value = 0.03;
        pad.connect(pg); pg.connect(g); pad.start();
        const seq = [261.63, 329.63, 392.0, 493.88, 392.0, 329.63];
        let i = 0;
        const note = () => {
          if (!this.ctx || this.muted) return;
          const t = this.ctx.currentTime;
          const o = this.ctx.createOscillator(), og = this.ctx.createGain();
          o.type = 'triangle'; o.frequency.value = seq[i % seq.length]; i++;
          og.gain.setValueAtTime(0.0001, t);
          og.gain.exponentialRampToValueAtTime(0.075, t + 0.04);
          og.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
          o.connect(og); og.connect(g);
          o.start(t); o.stop(t + 2);
        };
        note();
        this.bgmTimer = setInterval(note, 1500);
        this.bgmNodes = { g, oscs: [pad], timer: this.bgmTimer };
      } else {
        g.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 3);
        const oscs = [65.4, 98.0].map((f) => {
          const o = ctx.createOscillator();
          o.type = 'sawtooth'; o.frequency.value = f;
          const og = ctx.createGain(); og.gain.value = 0.02;
          o.connect(og); og.connect(g); o.start();
          return o;
        });
        this.bgmNodes = { g, oscs };
      }
    },
    stopBgm() {
      if (this.bgmTimer) { clearInterval(this.bgmTimer); this.bgmTimer = null; }
      if (!this.bgmNodes) return;
      const { g, oscs } = this.bgmNodes;
      try { g.gain.cancelScheduledValues(this.ctx.currentTime); g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.8); } catch (e) {}
      setTimeout(() => oscs.forEach((o) => { try { o.stop(); } catch (e) {} }), 900);
      this.bgmNodes = null;
    },
    muteAll() {
      this.muted = true;
      this.stopBgm(); this.static(false); this.heartbeat(false); this.stopDrone();
      if (!this.ctx) return;
      try { this.master.gain.cancelScheduledValues(this.ctx.currentTime); this.master.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15); } catch (e) {}
    },
    unmute() {
      this.muted = false;
      if (!this.ctx) return;
      try { this.master.gain.cancelScheduledValues(this.ctx.currentTime); this.master.gain.linearRampToValueAtTime(0.42, this.ctx.currentTime + 0.3); } catch (e) {}
    },
    paper() {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, len = ctx.sampleRate * 0.4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const s = ctx.createBufferSource(); s.buffer = buf;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
      const g = ctx.createGain(); g.gain.value = 0.07;
      s.connect(hp); hp.connect(g); g.connect(this.master); s.start();
    },
    creak() {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 1.6);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 1.9);
    },

    chime() {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, t = ctx.currentTime;
      [880, 1318].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.09, t + i * 0.09 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.22);
        o.connect(g); g.connect(this.master);
        o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.25);
      });
    },

    static(on) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      if (on) {
        if (this.muted || this.noise) return;
        const len = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const n = ctx.createBufferSource();
        n.buffer = buf; n.loop = true;
        const g = ctx.createGain(); g.gain.value = 0.035;
        n.connect(g); g.connect(this.master); n.start();
        this.noise = n; this.noiseGain = g;
      } else if (this.noise) {
        try { this.noise.stop(); } catch (e) {}
        this.noise = null; this.noiseGain = null;
      }
    },

    heartbeat(on) {
      if (this.heartTimer) { clearInterval(this.heartTimer); this.heartTimer = null; }
      if (!on || !this.ctx || this.muted) return;
      const beat = () => {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        [0, 0.28].forEach((d, i) => {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain();
          o.type = 'sine'; o.frequency.value = i === 0 ? 52 : 44;
          g.gain.setValueAtTime(0.0001, t + d);
          g.gain.exponentialRampToValueAtTime(0.16, t + d + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.2);
          o.connect(g); g.connect(this.master);
          o.start(t + d); o.stop(t + d + 0.22);
        });
      };
      beat();
      this.heartTimer = setInterval(beat, 1100);
    },

    droneLevel(v) {
      if (!this.ctx) return;
      if (!this.drone) {
        const o = this.ctx.createOscillator(), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter();
        o.type = 'sawtooth'; o.frequency.value = 46;
        lp.type = 'lowpass'; lp.frequency.value = 200;
        g.gain.value = 0;
        o.connect(lp); lp.connect(g); g.connect(this.master); o.start();
        this.drone = o; this.droneGain = g;
      }
      if (this.droneGain) this.droneGain.gain.value = this.muted ? 0 : 0.015 + v * 0.06;
    },
    stopDrone() {
      if (this.drone) { try { this.drone.stop(); } catch (e) {} this.drone = null; this.droneGain = null; }
    },

    cut() {
      if (!this.ctx) return;
      try { this.master.gain.cancelScheduledValues(this.ctx.currentTime); this.master.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.03); } catch (e) {}
    },
    restore() {
      if (!this.ctx) return;
      try { this.master.gain.linearRampToValueAtTime(0.42, this.ctx.currentTime + 0.6); } catch (e) {}
    },
    pan(freq, pan, dur, vol) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g);
      if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(this.master); }
      else g.connect(this.master);
      o.start(); o.stop(ctx.currentTime + dur + 0.05);
    },
  };

  function soundBtn() {
    return `<div class="tool-dock">
      <button class="tool-btn" data-act="open-saves">存档</button>
      <button class="tool-btn" data-act="open-settings">设置</button>
    </div>`;
  }

  function openSettings() {
    const modal = document.getElementById('modal-root');
    modal.innerHTML = `<div class="modal-back" data-close="1"><div class="modal">
      <h2>设置</h2>
      <label class="set-row"><span>音量</span><input type="range" id="vol" min="0" max="100" value="${S.volume}"><b id="vol-val">${S.volume}</b></label>
      <label class="set-row"><span>文字恐怖谷</span><input type="range" id="fx" min="1" max="3" step="1" value="${S.effects}"><b id="fx-val">${['小','中','大'][S.effects - 1]}</b></label>
      <p class="set-note">音量 0 即静音。文字效果影响闹鬼句的字号与抖动幅度。</p>
      <button class="btn ghost" data-act="close-modal">关上</button>
    </div></div>`;
    const vol = document.getElementById('vol'), volVal = document.getElementById('vol-val');
    const fx = document.getElementById('fx'), fxVal = document.getElementById('fx-val');
    vol.addEventListener('input', () => {
      S.volume = Number(vol.value);
      volVal.textContent = S.volume;
      A.setVolume(S.volume);
      persist();
    });
    fx.addEventListener('input', () => {
      S.effects = Number(fx.value);
      fxVal.textContent = ['小', '中', '大'][S.effects - 1];
      applyEffects();
      persist();
    });
  }

  function applyEffects() {
    const size = [30, 38, 48][S.effects - 1] || 38;
    document.documentElement.style.setProperty('--creep-size', size + 'px');
  }

  /* ================= 存档 ================= */
  const SLOT_KEY = 'jiaceng.slots.v1';
  function readSlots() {
    try { return JSON.parse(localStorage.getItem(SLOT_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeSlots(obj) { try { localStorage.setItem(SLOT_KEY, JSON.stringify(obj)); } catch (e) {} }

  function openSaves() {
    const slots = readSlots();
    const rows = [1, 2, 3, 4].map((i) => {
      const s = slots[i];
      const label = s ? `${esc(s.sceneTitle || s.scene)} · ${new Date(s.at).toLocaleString('zh-CN')}` : '空';
      return `<div class="slot">
        <div class="slot-info"><b>存档 ${i}</b><span>${label}</span></div>
        <div class="slot-acts">
          <button class="btn" data-act="save-slot" data-slot="${i}">存</button>
          <button class="btn" data-act="load-slot" data-slot="${i}" ${s ? '' : 'disabled'}>读</button>
          <button class="btn" data-act="del-slot" data-slot="${i}" ${s ? '' : 'disabled'}>删</button>
        </div>
      </div>`;
    }).join('');
    document.getElementById('modal-root').innerHTML = `<div class="modal-back" data-close="1"><div class="modal">
      <h2>存档 · 最多 4 个</h2>
      <p class="set-note">读取会回到存档时的场景，不会丢失当前进度文件（自动存档仍在）。</p>
      ${rows}
      <button class="btn ghost" data-act="close-modal">关上</button>
    </div></div>`;
  }

  function saveSlot(i) {
    const slots = readSlots();
    const scene = SCENES[S.scene];
    const label = scene
      ? (scene.title || (scene.lines && scene.lines[0]) || scene.act || scene.id)
      : '结局';
    slots[i] = Object.assign({}, S, {
      at: Date.now(),
      sceneTitle: String(label).slice(0, 18),
    });
    writeSlots(slots);
    A.chime();
    openSaves();
  }

  function loadSlot(i) {
    const slots = readSlots();
    if (!slots[i]) return;
    const s = Object.assign(fresh(), slots[i]);
    delete s.at; delete s.sceneTitle;
    S = s;
    A.init(); A.resume(); A.setVolume(S.volume);
    persist();
    chatToken += 1;
    document.getElementById('modal-root').innerHTML = '';
    render();
  }

  function delSlot(i) {
    const slots = readSlots();
    delete slots[i];
    writeSlots(slots);
    openSaves();
  }

  function showHeadphoneHint() {
    if (S.hintSeen) return;
    S.hintSeen = true; persist();
    const el = document.createElement('div');
    el.className = 'hint-toast';
    el.innerHTML = '<b>建议戴上耳机</b><span>左右声道会告诉你，它在哪一边。</span>';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 700); }, 5200);
    A.chime();
  }

  /* ================= 通用 ================= */
  function hud(scene) {
    return `<header class="hud">
      <div class="hud-title">夹层</div>
      <div class="hud-right">
        <span>${esc((scene && scene.act) || '')}</span>
        ${S.tension >= 5 ? '<span class="hud-alert">他注意到你了</span>' : ''}
      </div>
    </header>`;
  }

  function go(id) { S.scene = id; persist(); render(); }

  function namingScreen(scene) {
    return `${hud(scene)}
    <section class="screen story" style="max-width:720px">
      <p class="act">序</p>
      <p style="font-size:24px;color:var(--ink)">在开始之前，先告诉我——你是谁？</p>
      <div class="name-box" style="justify-content:flex-start;margin-top:26px">
        <span>你就是</span>
        <input id="nname" maxlength="8" value="${esc(S.name)}" placeholder="名字" autocomplete="off">
      </div>
      <p style="color:var(--faint);font-size:14px;margin-top:14px">不填也行，故事里会用「你」称呼你。</p>
      <div style="margin-top:34px"><button class="btn primary" data-act="set-name">开始搬家</button></div>
    </section>`;
  }

  function storyScreen(scene) {
    const lines = scene.lines.map((l, i) => {
      const cls = CREEPY.test(l) ? 'creepy' : (/^「/.test(l) ? 'whisper' : '');
      return `<p class="${cls}" style="animation-delay:${i * 170}ms">${txt(l)}</p>`;
    }).join('');
    return `${hud(scene)}
    <section class="screen story">
      <p class="act">${esc(scene.act || '')}</p>
      ${lines}
      <div style="margin-top:48px"><button class="btn primary" data-act="next">继续</button></div>
    </section>${soundBtn()}`;
  }

  function newSource() {
    const room = D.plan.rooms[Math.floor(Math.random() * D.plan.rooms.length)];
    src = { x: room.x + 50 + Math.random() * (room.w - 100), y: room.y + 50 + Math.random() * (room.h - 100) };
  }

  function listenScreen(scene) {
    if (!src) newSource();
    const rooms = D.plan.rooms.map((r) => `<div class="room" style="left:${(r.x / 1000) * 100}%;top:${(r.y / 600) * 100}%;width:${(r.w / 1000) * 100}%;height:${(r.h / 600) * 100}%">${esc(r.name)}</div>`).join('');
    return `${hud(scene)}
    <section class="screen">
      <p class="kicker">${esc(scene.act)} · 声音定位</p>
      <div class="story" style="margin-bottom:24px">${scene.intro.map((p, i) => `<p style="animation-delay:${i * 160}ms">${txt(p)}</p>`).join('')}</div>
      <div class="listen-wrap">
        <div class="plan" id="plan">${rooms}</div>
        <div class="meter-col"><div class="meter"><i id="meter"></i></div><div class="meter-label">震动</div></div>
      </div>
      <p class="listen-tip">移动鼠标或手指，手掌跟着天花板走。震动最强的地方点一下。</p>
      <div id="hit-area"></div>
    </section>${soundBtn()}`;
  }

  function bindListen(scene) {
    const plan = document.getElementById('plan');
    const meter = document.getElementById('meter');
    if (!plan || !src) return;
    meter.style.setProperty('--level', '0%');
    let done = false;
    const rect = () => plan.getBoundingClientRect();
    const point = (e) => (e.touches && e.touches[0]) ? e.touches[0] : e;

    function levelAt(cx, cy) {
      const r = rect();
      const x = ((cx - r.left) / r.width) * 1000;
      const y = ((cy - r.top) / r.height) * 600;
      return Math.max(0, Math.min(100, 100 - Math.hypot(x - src.x, y - src.y) / 4.2));
    }

    function onMove(ev) {
      if (done) return;
      const e = point(ev);
      const v = levelAt(e.clientX, e.clientY);
      meter.style.setProperty('--level', v + '%');
      A.droneLevel(v / 100);
    }

    function onTap(ev) {
      if (done) return;
      const e = point(ev);
      const v = levelAt(e.clientX, e.clientY);
      const r = rect();
      const cx = ((e.clientX - r.left) / r.width) * 100;
      const cy = ((e.clientY - r.top) / r.height) * 100;
      const rp = document.createElement('div');
      rp.className = 'ripple'; rp.style.left = cx + '%'; rp.style.top = cy + '%';
      plan.appendChild(rp); setTimeout(() => rp.remove(), 1000);

      const pan = (cx - 50) / 50;
      if (v >= 68) {
        done = true;
        A.pan(180, pan, 0.7, 0.09);
        const line = scene.hits[(S.round || 0)] || '';
        const last = (S.round || 0) + 1 >= scene.rounds;
        const area = document.getElementById('hit-area');
        if (area) area.innerHTML = `<div class="hit-text">${esc(line)}</div>
          <div style="margin-top:24px"><button class="btn primary" data-act="listen-next">${last ? '离开椅子' : '再听一次'}</button></div>`;
      } else {
        S.tension += 1;
        A.pan(90, pan, 0.4, 0.08);
        const area = document.getElementById('hit-area');
        if (area) area.innerHTML = `<div class="hit-text bad">太远了。它停了一下，像是在听你。</div>`;
        persist();
      }
    }

    plan.addEventListener('mousemove', onMove);
    plan.addEventListener('click', onTap);
    plan.addEventListener('touchmove', (ev) => { ev.preventDefault(); onMove(ev); }, { passive: false });
    plan.style.touchAction = 'none';
  }

  /* ================= 聊天 ================= */
  function chatScreen(scene) {
    const t = D.threads[scene.thread];
    chatToken += 1;
    const token = chatToken;
    setTimeout(() => startChat(scene, t, token), 350);
    return `${hud(scene)}
    <section class="screen" style="max-width:820px">
      <p class="kicker">${esc(scene.act)} · 手机</p>
      <div class="chat-window">
        <div class="chat-head"><b>${esc(t.title)}</b><span>${t.count} 人</span></div>
        <div class="chat-body" id="chat-body"></div>
        <div class="choices" id="choices" style="display:none"></div>
      </div>
    </section>${soundBtn()}`;
  }

  function avatarText(who) {
    const s = String(who || '?').replace(/^[\d\s:：]+/, '');
    return s.slice(0, 1) || '?';
  }

  function msgEl(m) {
    const mine = m.mine || m.who === '你';
    const el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '') + (m.who === '系统' ? ' system' : '');
    if (m.who === '系统') el.innerHTML = `<div class="bubble">${esc(m.text)}</div>`;
    else el.innerHTML = `<div class="avatar">${esc(avatarText(m.who))}</div>
      <div><div class="who">${esc(m.who)} · ${esc(m.time || '')}</div><div class="bubble">${esc(m.text)}</div></div>`;
    return el;
  }

  async function typing(body, token) {
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = '<div class="avatar">…</div><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    await sleep(650 + Math.random() * 450);
    if (token !== chatToken) { el.remove(); return false; }
    el.remove();
    return true;
  }

  async function startChat(scene, t, token) {
    const body = document.getElementById('chat-body');
    if (!body) return;
    for (const m of t.messages) {
      if (token !== chatToken) return;
      const ok = await typing(body, token);
      if (!ok) return;
      body.appendChild(msgEl(m));
      if (m.who !== '系统') A.chime();
      body.scrollTop = body.scrollHeight;
      await sleep(420);
    }
    const choices = document.getElementById('choices');
    if (choices && token === chatToken) {
      choices.style.display = 'flex';
      choices.innerHTML = t.choices.map((c, i) => `<button class="btn" data-act="choose" data-i="${i}">${esc(c.text)}</button>`).join('');
    }
  }

  async function chooseChat(scene, idx) {
    const t = D.threads[scene.thread];
    const c = t.choices[idx];
    const body = document.getElementById('chat-body');
    const choices = document.getElementById('choices');
    if (!body || !choices) return;
    choices.style.display = 'none';
    const token = ++chatToken;
    body.appendChild(msgEl({ who: '你', time: nowHM(), text: c.text.replace(/^「|」$/g, ''), mine: true }));
    body.scrollTop = body.scrollHeight;
    await sleep(380);
    for (const m of c.reply) {
      if (token !== chatToken) return;
      const ok = await typing(body, token);
      if (!ok) return;
      body.appendChild(msgEl(m));
      if (m.who !== '系统') A.chime();
      body.scrollTop = body.scrollHeight;
      await sleep(420);
    }
    S.tension += c.tension || 0;
    if (c.flag) S.flags.push(c.flag);
    persist();
    choices.style.display = 'flex';
    choices.innerHTML = '<button class="btn primary" data-act="next">继续</button>';
  }

  /* ================= 文档 ================= */
  function docScreen(scene) {
    const d = D.docs[scene.doc];
    const react = d.react ? `<div class="doc-react"><span class="avatar">你</span><div><div class="who">你 · 刚刚</div><div class="bubble">${esc(d.react.text)}</div></div></div>` : '';
    return `${hud(scene)}
    <section class="screen" style="max-width:780px">
      <p class="kicker">${esc(scene.act)} · 纸</p>
      <div class="doc">
        <h2>${esc(d.title)}</h2>
        <div class="meta">${esc(d.meta)}</div>
        <div class="body">${d.body.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
        <div class="foot">${esc(d.foot)}</div>
      </div>
      ${react}
      <div class="doc-actions"><button class="btn primary" data-act="next">放下</button></div>
    </section>${soundBtn()}`;
  }

  /* ================= 监控 ================= */
  function monitorScreen(scene) {
    return `${hud(scene)}
    <section class="screen" style="max-width:840px">
      <p class="kicker">${esc(scene.act)} · 回放</p>
      <p style="color:var(--soft);font-size:17px;margin-bottom:22px">你溜到楼下门卫室。老周睡着了，显示器还亮着。你拖动进度条，停在 02:58。</p>
      <div class="cctv">
        <canvas id="cctv" width="780" height="440"></canvas>
        <div class="cctv-bar"><span id="cctv-time">02:58:00</span><span class="rec">● REC</span></div>
      </div>
      <div id="cctv-note"></div>
      <div class="cctv-actions">
        <button class="btn primary" data-act="monitor-skip">快进 30 秒</button>
        <button class="btn" data-act="next">离开</button>
      </div>
    </section>${soundBtn()}`;
  }

  function bindMonitor() {
    const cv = document.getElementById('cctv');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const baseSec = 2 * 3600 + 58 * 60;
    let gameMin = 0, last = performance.now(), jumped = false, frozen = 0;
    A.static(true);

    const fmt = (t) => {
      const hh = Math.floor(t / 3600) % 24, mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60);
      return `0${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    };

    function draw(ts) {
      const dt = (ts - last) / 1000; last = ts;
      if (frozen > 0) { frozen -= dt; gameMin = 14; }
      else { gameMin += dt * 1.5; }
      if (gameMin > 24) gameMin = 24;

      const w = cv.width, h = cv.height;
      ctx.fillStyle = '#060708'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(130,140,150,.20)'; ctx.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        const y = 90 + i * 44;
        ctx.beginPath(); ctx.moveTo(110, y); ctx.lineTo(620, y); ctx.stroke();
      }
      ctx.strokeRect(110, 66, 510, 330);

      const img = ctx.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 30;
        img.data[i] += v; img.data[i + 1] += v; img.data[i + 2] += v;
      }
      ctx.putImageData(img, 0, 0);

      const el = document.getElementById('cctv-time');
      if (el) el.textContent = fmt(baseSec + gameMin * 60);

      if (gameMin >= 14 && gameMin < 17.5) {
        const cx = 516 + Math.sin(gameMin * 1.7) * 6;
        const cy = 262 + Math.sin(gameMin * 1.1) * 10;
        const sway = Math.sin(gameMin * 1.3) * 0.02;

        const glow = ctx.createRadialGradient(cx, cy - 20, 20, cx, cy - 20, 190);
        glow.addColorStop(0, 'rgba(168,40,28,.20)');
        glow.addColorStop(1, 'rgba(168,40,28,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - 200, cy - 220, 400, 440);

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(sway);
        ctx.scale(0.74, 1);
        ctx.filter = 'blur(2.5px)';
        ctx.fillStyle = 'rgba(168,40,28,.92)';
        // 头
        ctx.beginPath(); ctx.ellipse(0, -118, 19, 23, 0, 0, Math.PI * 2); ctx.fill();
        // 脖子
        ctx.fillRect(-8, -100, 16, 18);
        // 大衣
        ctx.beginPath();
        ctx.moveTo(-22, -92);
        ctx.quadraticCurveTo(-52, -84, -56, -44);
        ctx.lineTo(-46, 46);
        ctx.lineTo(-30, 104);
        ctx.lineTo(-12, 104);
        ctx.lineTo(-8, 40);
        ctx.lineTo(8, 40);
        ctx.lineTo(12, 104);
        ctx.lineTo(30, 104);
        ctx.lineTo(46, 46);
        ctx.lineTo(56, -44);
        ctx.quadraticCurveTo(52, -84, 22, -92);
        ctx.closePath(); ctx.fill();
        // 手臂
        ctx.beginPath(); ctx.ellipse(-52, -10, 9, 46, 0.12, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(52, -10, 9, 46, -0.12, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        // 不稳定的红色噪点
        ctx.fillStyle = 'rgba(190,60,44,.35)';
        for (let k = 0; k < 40; k++) {
          const px = cx + (Math.random() - 0.5) * 120;
          const py = cy - 60 + (Math.random() - 0.5) * 240;
          ctx.fillRect(px, py, 1.6, 1.6);
        }
        if (!jumped) {
          jumped = true;
          frozen = 4.5;
          A.cut(); A.static(false); A.heartbeat(true);
          const fl = document.createElement('div');
          fl.className = 'flash on';
          document.body.appendChild(fl);
          setTimeout(() => fl.remove(), 700);
          setTimeout(() => { A.restore(); A.heartbeat(false); }, 1500);
          if (!S.monitorSeen) {
            S.monitorSeen = true; persist();
            const note = document.getElementById('cctv-note');
            if (note) note.innerHTML = '<p class="hit-text" style="margin-top:14px">画面右下角，楼梯上多了一个人影。<b style="color:var(--red-soft)">红色</b>的，低着头，走得很慢。</p><p class="hit-text" style="margin-top:10px">他从五楼下来，走到二楼，就再也没出现过。同一时间，电梯没有动过。</p>';
          }
        }
      }

      ctx.fillStyle = 'rgba(255,255,255,.02)';
      for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
      cctvRAF = requestAnimationFrame(draw);
    }
    cctvRAF = requestAnimationFrame(draw);
    window.__monitorSkip = () => {
      if (gameMin < 13.5) gameMin = Math.min(13.9, gameMin + 0.5);
      else gameMin += 0.2;
    };
  }

  /* ================= 其它屏 ================= */
  function gateScreen(scene) {
    return `${hud(scene)}
    <section class="screen">
      <div class="gate">
        <p class="kicker">${esc(scene.act)}</p>
        <h2>主卧 · 检修口</h2>
        <p class="desc">${txt(D.gate.prompt)}</p>
        <div class="lock">
          <input id="code" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="····">
          <button class="btn primary" data-act="submit-code">开锁</button>
        </div>
        <p class="gate-msg" id="gate-msg"></p>
        <p class="gate-hint" id="gate-hint"></p>
      </div>
    </section>${soundBtn()}`;
  }

  function hatchScreen(scene) {
    const lines = D.hatch.lines.map((l, i) => `<p class="${CREEPY.test(l) ? 'hit' : ''}" style="animation-delay:${i * 220}ms">${txt(l)}</p>`).join('');
    return `${hud(scene)}
    <section class="screen">
      <p class="kicker">${esc(scene.act)} · 上面</p>
      <div class="hatch-lines">${lines}</div>
      <div style="margin-top:40px"><button class="btn primary" data-act="next">从椅子上下来</button></div>
    </section>${soundBtn()}`;
  }

  function metaScreen(scene) {
    const d = new Date();
    const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const lines = D.metaScene.lines.map((l, i) => `<p style="animation-delay:${i * 220}ms">${txt(l.replace('{date}', date).replace('{time}', time))}</p>`).join('');
    return `${hud(scene)}
    <section class="screen story">
      <p class="act">${esc(scene.act)}</p>
      ${lines}
      <p class="creepy" style="margin-top:30px">你抬起头，看见墙上那台老钟——它走的也是 ${esc(date)}。</p>
      <div style="margin-top:40px"><button class="btn primary" data-act="next">继续</button></div>
    </section>${soundBtn()}`;
  }

  function choiceScreen(scene) {
    return `${hud(scene)}
    <section class="screen">
      <div class="finale">
        <p class="kicker">终局</p>
        <h2>${esc(D.finale.question)}</h2>
        <div class="opts">
          ${D.finale.options.map((o) => `<button class="opt" data-act="ending" data-id="${o.id}"><span>${esc(o.text)}</span><small>${esc(o.hint)}</small></button>`).join('')}
        </div>
      </div>
    </section>${soundBtn()}`;
  }

  function endingScreen() {
    const e = D.endings[S.ending] || D.endings.A;
    const lines = e.lines.map((l, i) => `<p style="animation-delay:${i * 260}ms">${txt(withName(l))}</p>`).join('');
    const explainLines = (e.explain || '').split('。').filter(Boolean).map((s, i) => `<p class="explain-line" style="animation-delay:${i * 420}ms">${txt(s + '。')}</p>`).join('');
    return `<section class="ending"><div class="ending-inner">
      <p class="kicker">结局 ${esc(S.ending || 'A')}</p>
      <h1 class="flicker">${esc(e.title)}</h1>
      ${lines}
      ${e.explain ? `<div class="explain-wrap"><button class="btn ghost" data-act="explain">这个结局是什么意思？</button><div class="explain-box" id="explain-box" hidden>${explainLines}</div></div>` : ''}
      <div class="ending-actions">
        <button class="btn" data-act="to-review">看看这间屋子</button>
        <button class="btn" data-act="restart">再来一夜</button>
      </div>
    </div></section>`;
  }

  function reviewScreen() {
    return `${hud({ act: '复盘' })}
    <section class="screen">
      <p class="kicker">复盘</p>
      <h2 style="font-size:30px;letter-spacing:.16em;margin-bottom:10px">这间屋子</h2>
      <div>${D.review.facts.map((f) => `<div class="fact"><span class="fact-id">${f.id}</span><p>${esc(f.text)}</p></div>`).join('')}</div>
      <h3 style="font-size:20px;margin:38px 0 0;letter-spacing:.12em">你可能漏掉的细节</h3>
      <ul class="detail-list">${D.review.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      <p class="conclusion">${esc(D.review.conclusion)}</p>
      <div style="margin-top:32px;display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn" data-act="back-ending">回到结局</button>
        <button class="btn primary" data-act="restart">重新开始</button>
      </div>
    </section>`;
  }

  function titleScreen() {
    const hasSave = S.scene !== 'title';
    return `<section class="title-screen">
      <div class="door-number">第 5 层 · 501</div>
      <div class="big" aria-hidden="true">501</div>
      <div class="title-inner">
        <h1 class="flicker">夹层</h1>
        <p class="sub">你楼上是天台。那声音是谁？</p>
        <p class="meta">${esc(D.meta.minutes)} · 网页解谜 · 心理惊悚</p>
        <div class="title-actions">
          <button class="btn primary lg" data-act="start">${hasSave ? '继续' : '开始'}</button>
          ${hasSave ? '<button class="btn" data-act="restart">重新开始</button>' : ''}
        </div>
        <p class="title-note">建议戴耳机 · 进度自动保存 · v${esc(D.meta.version)}</p>
      </div>
    </section>${soundBtn()}`;
  }

  /* ================= 渲染 ================= */
  function render() {
    document.title = D.meta.title;
    applyEffects();
    chatToken += 1;
    if (cctvRAF) { cancelAnimationFrame(cctvRAF); cctvRAF = null; }
    A.static(false);
    A.heartbeat(false);
    A.stopDrone();
    if (S.volume <= 0) { A.stopBgm(); }
    else if (!A.ctx) { /* 首次点击后才初始化 */ }

    if (S.scene === 'title') { app.innerHTML = titleScreen(); lastScene = 'title'; return; }
    if (S.scene === 'review') { app.innerHTML = reviewScreen(); window.scrollTo(0, 0); lastScene = 'review'; return; }
    if (S.scene.indexOf('end-') === 0) { app.innerHTML = endingScreen(); window.scrollTo(0, 0); lastScene = S.scene; return; }

    const scene = SCENES[S.scene];
    if (!scene) { S.scene = 'title'; return render(); }

    if (scene.type === 'listen' && S.listenScene !== scene.id) { S.round = 0; S.listenScene = scene.id; src = null; }

    const map = {
      text: storyScreen, listen: listenScreen, chat: chatScreen, doc: docScreen,
      monitor: monitorScreen, gate: gateScreen, hatch: hatchScreen, meta: metaScreen,
      choice: choiceScreen, naming: namingScreen,
    };
    app.innerHTML = (map[scene.type] || storyScreen)(scene);
    if (lastScene !== S.scene) { window.scrollTo(0, 0); lastScene = S.scene; }

    if (scene.type === 'text') A.bgm(scene.bgm === 'warm' ? 'warm' : null);
    else if (scene.type === 'listen') A.bgm('night');
    else A.bgm(null);
    if (scene.type === 'listen') { bindListen(scene); showHeadphoneHint(); A.creak(); }
    if (scene.type === 'doc') A.paper();
    if (scene.type === 'monitor') bindMonitor();
    if (scene.type === 'gate') {
      const code = document.getElementById('code');
      if (code) { code.focus(); code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); }); }
    }
  }

  /* ================= 交互 ================= */
  function submitCode() {
    const input = document.getElementById('code');
    const value = (input && input.value ? input.value : '').trim();
    const msg = document.getElementById('gate-msg');
    const hint = document.getElementById('gate-hint');
    if (!value) return;
    if (value === D.gate.answers[0]) { A.chime(); return go('hatch1'); }
    S.gateTries += 1;
    if (msg) msg.textContent = D.gate.wrong;
    if (hint && S.gateTries >= 2) hint.textContent = '提示：' + D.gate.hint;
    if (input) { input.value = ''; input.focus(); }
    A.pan(83, 0, 0.3, 0.06);
  }

  function listenNext(scene) {
    const round = (S.round || 0) + 1;
    if (round >= scene.rounds) { S.round = 0; src = null; go(scene.next); }
    else { S.round = round; src = null; persist(); render(); }
  }

  function restart() {
    S = fresh(); src = null; chatToken += 1;
    if (cctvRAF) { cancelAnimationFrame(cctvRAF); cctvRAF = null; }
    persist(); render();
  }

  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('modal-back')) { modalRoot.innerHTML = ''; return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'start') {
      A.init(); A.resume(); A.setVolume(S.volume);
      if (S.scene === 'title') { S.scene = 'n0'; S.startedAt = Date.now(); }
      persist(); render(); return;
    }
    if (act === 'set-name') {
      const input = document.getElementById('nname');
      if (input) S.name = input.value.trim();
      S.nameSet = true;
      S.startedAt = S.startedAt || Date.now();
      A.init(); A.resume(); A.setVolume(S.volume);
      return go('s1');
    }
    if (act === 'restart') return restart();
    if (act === 'open-saves') return openSaves();
    if (act === 'open-settings') return openSettings();
    if (act === 'close-modal') { modalRoot.innerHTML = ''; return; }
    if (act === 'save-slot') return saveSlot(Number(el.dataset.slot));
    if (act === 'load-slot') return loadSlot(Number(el.dataset.slot));
    if (act === 'del-slot') return delSlot(Number(el.dataset.slot));

    const scene = SCENES[S.scene];
    if (act === 'next') { if (scene && scene.next) return go(scene.next); return; }
    if (act === 'listen-next') return listenNext(scene);
    if (act === 'explain') {
      const box = document.getElementById('explain-box');
      if (box) { box.hidden = !box.hidden; if (!box.hidden) A.chime(); }
      return;
    }
    if (act === 'choose') return chooseChat(scene, Number(el.dataset.i));
    if (act === 'submit-code') return submitCode();
    if (act === 'monitor-skip') { if (window.__monitorSkip) window.__monitorSkip(); return; }
    if (act === 'ending') { S.ending = el.dataset.id; S.scene = 'end-' + el.dataset.id; persist(); return render(); }
    if (act === 'to-review') { S.scene = 'review'; persist(); return render(); }
    if (act === 'back-ending') { S.scene = 'end-' + (S.ending || 'A'); persist(); return render(); }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modalRoot.innerHTML = ''; });

  if (devMode || params.get('debug')) {
    window.__JC = { get src() { return src; }, get S() { return S; }, go };
  }
  render();
})();
