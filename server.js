// Mesa RPG — servidor (Express + Socket.IO)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3777;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'mesas.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
// convite: /m/CODIGO abre direto a tela de entrar nessa mesa
app.get('/m/:code', (req, res) => res.redirect('/?mesa=' + encodeURIComponent(String(req.params.code).toUpperCase().slice(0, 10))));
app.get('/api/mesa/:code', (req, res) => {
  const m = mesas[String(req.params.code).toUpperCase()];
  if (!m) return res.status(404).json({ ok: false });
  res.json({ ok: true, code: m.code, nome: m.nome, mestreNome: m.mestreNome, jogadores: Object.keys(m.players).length });
});
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 });

// ---------- estado ----------
let mesas = {};
try { mesas = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { mesas = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(mesas), (e) => { if (!e) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); });
  }, 300);
}

const DICE = [4, 6, 8, 10, 12, 20, 100];
const ATTRS = ['forca', 'agilidade', 'inteligencia', 'vitalidade', 'destreza', 'sorte'];
const id = (n = 8) => crypto.randomBytes(n).toString('hex');
const newCode = () => {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => L[crypto.randomInt(L.length)]).join(''); } while (mesas[c]);
  return c;
};
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const num = (v, min = -99999, max = 999999) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0; };
const now = () => Date.now();
const pushCap = (arr, item, cap = 100) => { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); };

function emptySheet(name) {
  return { personagem: name || '', classe: '', nivel: 1, pvAtual: 10, pvMax: 10, manaAtual: 5, manaMax: 5,
    atributos: Object.fromEntries(ATTRS.map((a) => [a, 0])), inventario: '', anotacoes: '' };
}
function cleanSheet(s, prev) {
  s = s || {}; const out = { ...prev };
  if ('personagem' in s) out.personagem = str(s.personagem, 60);
  if ('classe' in s) out.classe = str(s.classe, 60);
  for (const k of ['nivel', 'pvAtual', 'pvMax', 'manaAtual', 'manaMax']) if (k in s) out[k] = num(s[k]);
  if (s.atributos) { out.atributos = { ...prev.atributos }; for (const a of ATTRS) if (a in s.atributos) out.atributos[a] = num(s.atributos[a]); }
  if ('inventario' in s) out.inventario = str(s.inventario, 4000);
  if ('anotacoes' in s) out.anotacoes = str(s.anotacoes, 4000);
  return out;
}

const MODE = (v) => (v === 'off' ? 'off' : 'on');
// Registro do Mestre: tudo que acontece na mesa. NUNCA é enviado para jogadores.
function logEvent(m, e) {
  m.log = m.log || [];
  const entry = { id: id(5), ts: now(), ...e };
  pushCap(m.log, entry, 5000); save();
  io.to(`m:${m.code}:mestre`).emit('log', entry);
  return entry;
}
const who = (m, ctx) => {
  if (ctx.role === 'mestre') return { from: 'mestre', fromNome: m.mestreNome + ' (Mestre)' };
  const p = m.players[ctx.playerId];
  return { from: p.id, fromNome: p.sheet.personagem && p.sheet.personagem !== p.nome ? `${p.nome} (${p.sheet.personagem})` : p.nome };
};
const nomeDe = (m, pid) => (pid === 'mestre' ? m.mestreNome + ' (Mestre)' : m.players[pid]?.nome || '?');

// Voz (WebRTC mesh): participantes por mesa, chave = socket.id
const voice = {}; // code -> { sid: { sid, who, nome, muted, speaking, mode } }
const voiceList = (code) => Object.values(voice[code] || {});

const online = {}; // code -> { playerId|'mestre': count }
const isOnline = (code, who) => (online[code]?.[who] || 0) > 0;
function playerList(m) {
  return Object.values(m.players).map((p) => ({ id: p.id, nome: p.nome, personagem: p.sheet.personagem, online: isOnline(m.code, p.id) }));
}
function publicState(m, role, playerId) {
  const base = { code: m.code, nome: m.nome, mestreNome: m.mestreNome, mestreOnline: isOnline(m.code, 'mestre'),
    scene: m.scene, rolls: m.rolls.slice(-30), narration: m.narration.slice(-50), chat: m.chat.slice(-100), players: playerList(m) };
  if (role === 'mestre') {
    return { ...base, role, sheets: Object.fromEntries(Object.values(m.players).map((p) => [p.id, p.sheet])), privates: m.privates.slice(-200),
      dms: (m.dms || []).slice(-300), log: (m.log || []).slice(-500), voice: voiceList(m.code) };
  }
  const p = m.players[playerId];
  return { ...base, role, playerId, nomeJogador: p.nome, sheets: { [p.id]: p.sheet }, privates: m.privates.filter((x) => x.to === p.id).slice(-100),
    dms: (m.dms || []).filter((x) => x.from === p.id || x.to === p.id).slice(-300), voice: voiceList(m.code) };
}
const broadcastPlayers = (m) => io.to('m:' + m.code).emit('players', { players: playerList(m), mestreOnline: isOnline(m.code, 'mestre') });

function rollDice(spec, mod) {
  const dice = [];
  for (const sides of DICE) {
    const q = num(spec?.[sides], 0, 50);
    for (let i = 0; i < q; i++) dice.push({ sides, value: crypto.randomInt(1, sides + 1) });
  }
  const m = num(mod, -999, 999);
  const total = dice.reduce((a, d) => a + d.value, 0) + m;
  const expr = DICE.filter((s) => num(spec?.[s], 0, 50) > 0).map((s) => `${num(spec[s], 0, 50)}d${s}`).join(' + ') + (m ? (m > 0 ? ` + ${m}` : ` - ${-m}`) : '');
  return { dice, mod: m, total, expr };
}

function saveImageDataUrl(dataUrl) {
  const mt = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl || '');
  if (!mt) return null;
  const buf = Buffer.from(mt[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return null;
  const name = id(10) + '.' + (mt[1] === 'jpeg' ? 'jpg' : mt[1]);
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  let ctx = null; // { code, role, playerId }
  const mesa = () => {
    const m = ctx ? mesas[ctx.code] : null;
    if (m && ctx.role === 'player' && !m.players[ctx.playerId]) return null;
    return m;
  };
  const isMestre = () => ctx?.role === 'mestre';
  const fail = (cb, msg) => typeof cb === 'function' && cb({ ok: false, erro: msg });
  const ok = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data });

  function attach(code, role, playerId) {
    ctx = { code, role, playerId };
    socket.join('m:' + code);
    socket.join(role === 'mestre' ? `m:${code}:mestre` : `m:${code}:p:${playerId}`);
    const who = role === 'mestre' ? 'mestre' : playerId;
    online[code] = online[code] || {};
    online[code][who] = (online[code][who] || 0) + 1;
    broadcastPlayers(mesas[code]);
  }

  socket.on('mesa:create', (d, cb) => {
    if (ctx) return fail(cb, 'Já conectado a uma mesa.');
    const code = newCode();
    const m = { code, nome: str(d?.nomeMesa, 60) || 'Mesa de ' + (str(d?.mestreNome, 40) || 'Mestre'), mestreNome: str(d?.mestreNome, 40) || 'Mestre',
      mestreToken: id(16), createdAt: now(), scene: { title: 'A aventura vai começar...', desc: 'Aguarde o mestre preparar a cena.', image: '', ts: now() },
      players: {}, rolls: [], narration: [], chat: [], privates: [] };
    mesas[code] = m; save();
    attach(code, 'mestre');
    ok(cb, { token: m.mestreToken, state: publicState(m, 'mestre') });
  });

  socket.on('mesa:join', (d, cb) => {
    if (ctx) return fail(cb, 'Já conectado a uma mesa.');
    const code = str(d?.code, 10).toUpperCase().trim();
    const m = mesas[code];
    if (!m) return fail(cb, 'Mesa não encontrada. Confira o código.');
    const nome = str(d?.nome, 40).trim();
    if (!nome) return fail(cb, 'Digite seu nome.');
    const p = { id: id(6), nome, token: id(16), sheet: emptySheet(nome), joinedAt: now() };
    m.players[p.id] = p; save();
    attach(code, 'player', p.id);
    io.to(`m:${code}:mestre`).emit('sheet', { playerId: p.id, sheet: p.sheet });
    logEvent(m, { type: 'entrada', from: p.id, fromNome: p.nome, text: `${p.nome} entrou na mesa` });
    ok(cb, { token: p.token, state: publicState(m, 'player', p.id) });
  });

  socket.on('auth', (d, cb) => {
    if (ctx) return fail(cb, 'Já conectado.');
    const m = mesas[str(d?.code, 10).toUpperCase()];
    const token = str(d?.token, 64);
    if (!m || !token) return fail(cb, 'Sessão inválida.');
    if (token === m.mestreToken) {
      attach(m.code, 'mestre');
      return ok(cb, { state: publicState(m, 'mestre') });
    }
    const p = Object.values(m.players).find((x) => x.token === token);
    if (!p) return fail(cb, 'Sessão inválida.');
    attach(m.code, 'player', p.id);
    ok(cb, { state: publicState(m, 'player', p.id) });
  });

  socket.on('scene:set', (d, cb) => {
    const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Apenas o mestre pode mudar a cena.');
    let image = m.scene.image;
    if (d?.imageData) { image = saveImageDataUrl(d.imageData); if (!image) return fail(cb, 'Imagem inválida ou muito grande.'); }
    else if (typeof d?.imageUrl === 'string') {
      const u = d.imageUrl.trim();
      if (u && !/^https?:\/\//i.test(u) && !u.startsWith('/uploads/')) return fail(cb, 'URL de imagem inválida.');
      image = str(u, 1000);
    }
    m.scene = { title: str(d?.title ?? m.scene.title, 120), desc: str(d?.desc ?? m.scene.desc, 3000), image, ts: now(), detail: null };
    m.gallery = m.gallery || [];
    if (image && !m.gallery.includes(image)) { m.gallery.unshift(image); m.gallery = m.gallery.slice(0, 30); }
    save();
    io.to('m:' + m.code).emit('scene', m.scene);
    logEvent(m, { type: 'cena', from: 'mestre', fromNome: m.mestreNome + ' (Mestre)', text: `Nova cena: ${m.scene.title}${m.scene.desc ? ' — ' + m.scene.desc : ''}`, image: image || '' });
    ok(cb, { scene: m.scene, gallery: m.gallery });
  });

  // Detalhe da cena: foto de perto OU zoom numa região da imagem principal (a cena principal continua visível)
  socket.on('scene:detail', (d, cb) => {
    const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Apenas o mestre pode mostrar detalhes.');
    if (d?.clear) { m.scene.detail = null; save(); io.to('m:' + m.code).emit('scene', m.scene); return ok(cb, { scene: m.scene }); }
    const text = str(d?.text, 1000);
    let det;
    if (d?.kind === 'zoom') {
      if (!m.scene.image) return fail(cb, 'A cena não tem imagem para dar zoom.');
      const f = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
      det = { kind: 'zoom', x: f(d.x, 0, 100), y: f(d.y, 0, 100), zoom: f(d.zoom || 3, 1.5, 8), text, ts: now() };
    } else {
      let image = '';
      if (d?.imageData) { image = saveImageDataUrl(d.imageData); if (!image) return fail(cb, 'Imagem inválida ou muito grande.'); }
      else if (typeof d?.imageUrl === 'string' && (/^https?:\/\//i.test(d.imageUrl) || d.imageUrl.startsWith('/uploads/'))) image = str(d.imageUrl, 1000);
      if (!image) return fail(cb, 'Escolha a foto do detalhe.');
      det = { kind: 'foto', image, text, ts: now() };
      m.gallery = m.gallery || []; if (!m.gallery.includes(image)) m.gallery.unshift(image);
    }
    m.scene.detail = det; save();
    io.to('m:' + m.code).emit('scene', m.scene);
    logEvent(m, { type: 'cena', from: 'mestre', fromNome: m.mestreNome + ' (Mestre)', text: `Detalhe mostrado (${det.kind === 'zoom' ? 'zoom na imagem' : 'foto'})${text ? ': ' + text : ''}`, image: det.image || m.scene.image });
    ok(cb, { scene: m.scene });
  });

  socket.on('gallery:get', (_d, cb) => { const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Sem permissão.'); ok(cb, { gallery: m.gallery || [] }); });

  socket.on('dice:roll', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    const r = rollDice(d?.dice, d?.mod);
    if (!r.dice.length) return fail(cb, 'Escolha pelo menos um dado.');
    const p = ctx.playerId ? m.players[ctx.playerId] : null;
    const roll = { id: id(5), ts: now(), by: isMestre() ? 'mestre' : ctx.playerId, byNome: isMestre() ? `${m.mestreNome} (Mestre)` : (p.sheet.personagem || p.nome),
      label: str(d?.label, 80), target: isMestre() && d?.target && m.players[d.target] ? d.target : null, ...r };
    if (roll.target) roll.targetNome = m.players[roll.target].sheet.personagem || m.players[roll.target].nome;
    pushCap(m.rolls, roll, 100); save();
    io.to('m:' + m.code).emit('roll', roll);
    logEvent(m, { type: 'dado', from: roll.by, fromNome: roll.byNome, text: `${roll.label ? roll.label + ': ' : ''}${roll.expr} = ${roll.total} [${roll.dice.map((x) => x.value).join(', ')}]${roll.targetNome ? ' (para ' + roll.targetNome + ')' : ''}` });
    ok(cb, { roll });
  });

  socket.on('sheet:get', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    const pid = str(d?.playerId, 20);
    if (!isMestre() && pid !== ctx.playerId) return fail(cb, 'Você só pode ver a sua própria ficha.');
    const p = m.players[pid]; if (!p) return fail(cb, 'Jogador não encontrado.');
    ok(cb, { playerId: pid, sheet: p.sheet });
  });

  socket.on('sheets:all', (_d, cb) => {
    const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Apenas o mestre vê todas as fichas.');
    ok(cb, { sheets: Object.fromEntries(Object.values(m.players).map((p) => [p.id, p.sheet])) });
  });

  socket.on('sheet:update', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    const pid = str(d?.playerId, 20);
    if (!isMestre() && pid !== ctx.playerId) return fail(cb, 'Você só pode editar a sua própria ficha.');
    const p = m.players[pid]; if (!p) return fail(cb, 'Jogador não encontrado.');
    p.sheet = cleanSheet(d?.sheet, p.sheet); save();
    io.to(`m:${m.code}:p:${pid}`).to(`m:${m.code}:mestre`).emit('sheet', { playerId: pid, sheet: p.sheet });
    broadcastPlayers(m);
    ok(cb, { sheet: p.sheet });
  });

  socket.on('mestre:say', (d, cb) => {
    const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Apenas o mestre.');
    const text = str(d?.text, 2000).trim(); if (!text) return fail(cb, 'Mensagem vazia.');
    if (d?.mode === 'off') {
      const to = str(d?.to, 20);
      if (to === 'all') {
        const msg = { id: id(5), ts: now(), mode: 'off', to: 'all', text };
        pushCap(m.narration, msg, 200); save();
        io.to('m:' + m.code).emit('narration', msg);
        logEvent(m, { type: 'narracao', mode: 'off', from: 'mestre', fromNome: m.mestreNome + ' (Mestre)', to: 'all', toNome: 'Mesa toda', text });
        return ok(cb);
      }
      const p = m.players[to]; if (!p) return fail(cb, 'Escolha o jogador.');
      const msg = { id: id(5), ts: now(), to, toNome: p.nome, text };
      pushCap(m.privates, msg, 500); save();
      io.to(`m:${m.code}:p:${to}`).to(`m:${m.code}:mestre`).emit('private', msg);
      logEvent(m, { type: 'narracao', mode: 'off', from: 'mestre', fromNome: m.mestreNome + ' (Mestre)', to, toNome: p.nome, text });
      return ok(cb);
    }
    const msg = { id: id(5), ts: now(), mode: 'on', personagem: str(d?.personagem, 60), text };
    pushCap(m.narration, msg, 200); save();
    io.to('m:' + m.code).emit('narration', msg);
    logEvent(m, { type: 'narracao', mode: 'on', from: 'mestre', fromNome: m.mestreNome + ' (Mestre)', personagem: msg.personagem, text });
    ok(cb);
  });

  socket.on('chat:send', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    if (isMestre()) return fail(cb, 'O chat é só dos jogadores. Use a narração.');
    const text = str(d?.text, 1000).trim(); if (!text) return fail(cb, 'Mensagem vazia.');
    const p = m.players[ctx.playerId];
    const msg = { id: id(5), ts: now(), from: p.id, nome: p.nome, personagem: p.sheet.personagem, mode: MODE(d?.mode), text };
    pushCap(m.chat, msg, 300); save();
    io.to('m:' + m.code).emit('chat', msg);
    logEvent(m, { type: 'chat', mode: msg.mode, ...who(m, ctx), to: 'all', toNome: 'Grupo', text });
    ok(cb);
  });

  // Mensagem direta jogador -> jogador. Só remetente, destinatário e mestre recebem.
  socket.on('dm:send', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    if (isMestre()) return fail(cb, 'O mestre usa a mensagem OFF para falar em particular.');
    const to = str(d?.to, 20);
    if (to === ctx.playerId || !m.players[to]) return fail(cb, 'Escolha outro jogador.');
    const text = str(d?.text, 1000).trim(); if (!text) return fail(cb, 'Mensagem vazia.');
    const p = m.players[ctx.playerId];
    const msg = { id: id(5), ts: now(), from: p.id, fromNome: p.nome, to, toNome: m.players[to].nome, mode: MODE(d?.mode), text };
    m.dms = m.dms || []; pushCap(m.dms, msg, 2000); save();
    io.to(`m:${m.code}:p:${p.id}`).to(`m:${m.code}:p:${to}`).to(`m:${m.code}:mestre`).emit('dm', msg);
    logEvent(m, { type: 'dm', mode: msg.mode, from: p.id, fromNome: p.nome, to, toNome: msg.toNome, text });
    ok(cb, { msg });
  });

  // Transcrição de voz (feita no navegador). Vai só para o Registro do Mestre.
  socket.on('transcript:add', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    const text = str(d?.text, 2000).trim(); if (!text) return fail(cb, 'Vazio.');
    const e = logEvent(m, { type: 'voz', mode: MODE(d?.mode), ...who(m, ctx), text, conf: Number(d?.conf) || undefined });
    ok(cb, { id: e.id });
  });

  socket.on('log:get', (_d, cb) => {
    const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Apenas o mestre vê o registro.');
    ok(cb, { log: m.log || [] });
  });

  // ---------- voz: sinalização WebRTC ----------
  const voiceLeave = () => {
    if (!ctx || !voice[ctx.code]?.[socket.id]) return;
    delete voice[ctx.code][socket.id];
    socket.leave(`m:${ctx.code}:voz`);
    io.to('m:' + ctx.code).emit('voice:peers', voiceList(ctx.code));
    io.to(`m:${ctx.code}:voz`).emit('voice:left', { sid: socket.id });
  };
  socket.on('voice:join', (d, cb) => {
    const m = mesa(); if (!m) return fail(cb, 'Não conectado.');
    voice[m.code] = voice[m.code] || {};
    if (Object.keys(voice[m.code]).length >= 8 && !voice[m.code][socket.id]) return fail(cb, 'A voz está cheia (máx. 8).');
    const existing = voiceList(m.code).filter((v) => v.sid !== socket.id);
    const w = who(m, ctx);
    voice[m.code][socket.id] = { sid: socket.id, who: w.from, nome: isMestre() ? m.mestreNome + ' (Mestre)' : m.players[ctx.playerId].nome, muted: !!d?.muted, speaking: false, mode: MODE(d?.mode) };
    socket.join(`m:${m.code}:voz`);
    io.to('m:' + m.code).emit('voice:peers', voiceList(m.code));
    ok(cb, { peers: existing, me: socket.id });
  });
  socket.on('voice:leave', (_d, cb) => { voiceLeave(); ok(cb); });
  socket.on('voice:state', (d) => {
    if (!ctx || !voice[ctx.code]?.[socket.id]) return;
    const v = voice[ctx.code][socket.id];
    if ('muted' in (d || {})) v.muted = !!d.muted;
    if ('speaking' in (d || {})) v.speaking = !!d.speaking;
    if ('mode' in (d || {})) v.mode = MODE(d.mode);
    io.to('m:' + ctx.code).emit('voice:state', v);
  });
  // repassa offer/answer/ice SOMENTE para o socket alvo, e só se ambos estão na voz da mesma mesa
  socket.on('voice:signal', (d, cb) => {
    if (!ctx || !voice[ctx.code]?.[socket.id]) return fail(cb, 'Entre na voz primeiro.');
    const to = str(d?.to, 40);
    if (!voice[ctx.code][to] || to === socket.id) return fail(cb, 'Destino fora da voz.');
    io.to(to).emit('voice:signal', { from: socket.id, data: d.data });
    ok(cb);
  });

  socket.on('player:kick', (d, cb) => {
    const m = mesa(); if (!m || !isMestre()) return fail(cb, 'Apenas o mestre.');
    const p = m.players[str(d?.playerId, 20)]; if (!p) return fail(cb, 'Jogador não encontrado.');
    delete m.players[p.id]; save();
    io.to(`m:${m.code}:p:${p.id}`).emit('kicked');
    io.in(`m:${m.code}:p:${p.id}`).socketsLeave('m:' + m.code);
    for (const v of voiceList(m.code)) if (v.who === p.id) { delete voice[m.code][v.sid]; io.to(`m:${m.code}:voz`).emit('voice:left', { sid: v.sid }); }
    io.to('m:' + m.code).emit('voice:peers', voiceList(m.code));
    logEvent(m, { type: 'entrada', from: 'mestre', fromNome: m.mestreNome + ' (Mestre)', text: `${p.nome} foi removido da mesa` });
    broadcastPlayers(m);
    ok(cb);
  });

  socket.on('disconnect', () => {
    if (!ctx) return;
    voiceLeave();
    const who = ctx.role === 'mestre' ? 'mestre' : ctx.playerId;
    if (online[ctx.code]?.[who]) online[ctx.code][who]--;
    if (mesas[ctx.code]) broadcastPlayers(mesas[ctx.code]);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Mesa RPG rodando em http://localhost:${PORT}`));
