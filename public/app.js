/* Mesa RPG — cliente v2 */
(() => {
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const DICE = [4, 6, 8, 10, 12, 20, 100];
const ATTRS = [['forca', 'Força'], ['agilidade', 'Agilidade'], ['inteligencia', 'Inteligência'], ['vitalidade', 'Vitalidade'], ['destreza', 'Destreza'], ['sorte', 'Sorte']];
const LS_SESS = 'mesaRpg.sessions', LS_CUR = 'mesaRpg.current', LS_MODE = 'mesaRpg.mode';
const tagHtml = (mode) => mode ? `<span class="tag ${mode}">${mode === 'off' ? 'OFF' : 'ON'}</span>` : '';

const socket = io({ transports: ['websocket', 'polling'] });
let S = null;
let currentTab = 'cena';
let selSheet = null;
let mode = localStorage.getItem(LS_MODE) === 'off' ? 'off' : 'on'; // ON = personagem, OFF = fora de cena
let conv = 'grupo';      // conversa aberta no chat: 'grupo' ou id do jogador (DM) / 'a|b' para o mestre
let logFilter = 'tudo';
const pick = Object.fromEntries(DICE.map((d) => [d, 0]));

// ---------- PWA ----------
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hidden'); });
$('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').classList.add('hidden'); };

// ---------- util ----------
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
function emit(ev, data) { return new Promise((res) => socket.emit(ev, data, (r) => res(r || { ok: false, erro: 'Sem resposta' }))); }
const sessions = () => { try { return JSON.parse(localStorage.getItem(LS_SESS)) || []; } catch { return []; } };
function saveSession(s) { const l = sessions().filter((x) => !(x.code === s.code && x.role === s.role)); l.unshift(s); localStorage.setItem(LS_SESS, JSON.stringify(l.slice(0, 8))); localStorage.setItem(LS_CUR, JSON.stringify(s)); }
function dropSession(code, token) { localStorage.setItem(LS_SESS, JSON.stringify(sessions().filter((x) => !(x.code === code && x.token === token)))); }
const cur = () => { try { return JSON.parse(localStorage.getItem(LS_CUR)); } catch { return null; } };
const isM = () => S?.role === 'mestre';
const pName = (id) => { if (id === 'mestre') return S.mestreNome + ' (Mestre)'; const p = S.players.find((x) => x.id === id); return p ? p.nome : 'Jogador'; };
const inviteUrl = () => `${location.origin}/m/${S.code}`;
const inviteText = () => `🎲 ${S.mestreNome} te convidou para a mesa de RPG "${S.nome}". Toque no link para entrar (código ${S.code}):`;

// ---------- modo ON/OFF (vale para voz, chat e mensagens diretas) ----------
function setMode(m) {
  mode = m === 'off' ? 'off' : 'on'; localStorage.setItem(LS_MODE, mode);
  for (const el of [$('#modeBtn'), $('#chatMode')]) { el.classList.toggle('on', mode === 'on'); el.classList.toggle('off', mode === 'off'); }
  $('#modeBtn').textContent = mode === 'on' ? '🎭 ON' : '💬 OFF';
  $('#chatMode').textContent = mode === 'on' ? '🎭' : '💬';
  $$('#modeSeg button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
  $('#persLabel').classList.toggle('hidden', mode !== 'on'); $('#toLabel').classList.toggle('hidden', mode !== 'off');
  $('#sayText').placeholder = mode === 'on' ? 'Narre a cena ou fale como um personagem...' : 'Fale fora de cena, com um jogador ou com a mesa...';
  if (V.joined) socket.emit('voice:state', { mode });
}
const toggleMode = () => { setMode(mode === 'on' ? 'off' : 'on'); toast(mode === 'on' ? '🎭 ON: falando como personagem' : '💬 OFF: falando fora de cena'); };
$('#modeBtn').onclick = toggleMode; $('#chatMode').onclick = toggleMode;
$$('#modeSeg button').forEach((b) => b.onclick = () => setMode(b.dataset.mode));

// ---------- home / convite ----------
function renderRecent() {
  const l = sessions();
  $('#recent').classList.toggle('hidden', !l.length);
  $('#recentList').innerHTML = l.map((s, i) => `<div class="recent-item"><div><b>${esc(s.label)}</b><div class="small">${s.role === 'mestre' ? '👑 Mestre' : '🧙 Jogador'} · #${esc(s.code)}</div></div><button class="btn primary" data-i="${i}">Voltar</button></div>`).join('');
  $$('#recentList button').forEach((b) => b.onclick = () => resume(l[b.dataset.i]));
}
async function resume(s) {
  const r = await emit('auth', { code: s.code, token: s.token });
  if (!r.ok) { if (r.erro === 'Já conectado.') { location.reload(); return; } toast(r.erro || 'Não foi possível voltar.'); dropSession(s.code, s.token); localStorage.removeItem(LS_CUR); renderRecent(); return; }
  saveSession(s); enter(r.state);
}
$('#joinCode').addEventListener('input', (e) => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
$('#joinForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await emit('mesa:join', { code: $('#joinCode').value, nome: $('#joinName').value });
  if (!r.ok) return toast(r.erro);
  saveSession({ code: r.state.code, token: r.token, role: 'player', label: `${r.state.nome} — ${r.state.nomeJogador}` });
  history.replaceState(null, '', '/');
  enter(r.state);
};
$('#createForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await emit('mesa:create', { mestreNome: $('#mName').value, nomeMesa: $('#mMesa').value });
  if (!r.ok) return toast(r.erro);
  saveSession({ code: r.state.code, token: r.token, role: 'mestre', label: r.state.nome });
  history.replaceState(null, '', '/');
  enter(r.state);
  toast('Mesa criada! Agora convide os jogadores.', 3500);
  switchTab('mesa');
};
$('#showCreate').onclick = () => { $('#createForm').classList.remove('hidden'); $('#showCreate').classList.add('hidden'); $('#createForm').scrollIntoView({ behavior: 'smooth' }); };
const qp = (new URLSearchParams(location.search).get('mesa') || '').toUpperCase();
async function setupInvite() {
  if (!qp) return;
  $('#joinCode').value = qp;
  $('#createForm').classList.add('hidden'); $('#showCreate').classList.remove('hidden');
  $('#joinCodeLabel').classList.add('hidden');
  $('#joinTitle').textContent = 'Entrar na mesa';
  try {
    const r = await (await fetch('/api/mesa/' + encodeURIComponent(qp))).json();
    if (r.ok) { $('#invite').classList.remove('hidden'); $('#invMesa').textContent = r.nome; $('#invMestre').textContent = `Mestre: ${r.mestreNome} · ${r.jogadores} jogador(es)`; }
    else { toast('Convite inválido ou mesa encerrada.'); $('#joinCodeLabel').classList.remove('hidden'); }
  } catch { }
  $('#joinName').focus();
}

// ---------- entrar ----------
function enter(state) {
  S = state; S.dms = S.dms || []; S.log = S.log || []; S.voice = S.voice || [];
  document.body.classList.toggle('is-mestre', isM());
  $('#home').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#mesaNome').textContent = S.nome;
  $('#mesaCode').textContent = S.code; $('#bigCode').textContent = S.code;
  const rb = $('#roleBadge'); rb.textContent = isM() ? '👑 Mestre' : '🧙 ' + S.nomeJogador; rb.classList.toggle('mestre', isM());
  if (isM()) selSheet = selSheet && S.sheets[selSheet] ? selSheet : null; else selSheet = S.playerId;
  const url = inviteUrl();
  $('#inviteUrl').textContent = url;
  $('#waBtn').href = 'https://wa.me/?text=' + encodeURIComponent(`${inviteText()}\n${url}`);
  $('#mailBtn').href = `mailto:?subject=${encodeURIComponent('Convite para a mesa de RPG ' + S.nome)}&body=${encodeURIComponent(`${inviteText()}\n\n${url}\n\nDica: no celular, abra o link e use "Adicionar à tela inicial" para instalar o app.`)}`;
  renderScene(false); renderNarr(); renderRolls(); renderConv(); renderPlayers(); renderSheets(); renderPriv(); renderDicePicker(); renderLog(); renderVoice();
  setMode(mode);
  switchTab(currentTab === 'registro' && !isM() ? 'cena' : currentTab);
  if (V.joined) rejoinVoice();
}

function switchTab(t) {
  currentTab = t;
  $$('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + t));
  $$('nav.bottom button').forEach((b) => { b.classList.toggle('active', b.dataset.tab === t); if (b.dataset.tab === t) $('.bdg', b).classList.remove('on'); });
  if (t === 'registro') renderLog();
  if (t === 'chat') renderConv();
  if (t === 'chat') setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 30); else window.scrollTo(0, 0);
}
$$('nav.bottom button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
const ping = (tab) => { if (currentTab !== tab) $(`nav.bottom button[data-tab=${tab}] .bdg`).classList.add('on'); };

$('#leaveBtn').onclick = () => {
  if (!confirm('Sair desta mesa? Você poderá voltar pela tela inicial (neste aparelho).')) return;
  leaveVoice(); localStorage.removeItem(LS_CUR); location.href = '/';
};
async function share() {
  const url = inviteUrl();
  if (navigator.share) { try { await navigator.share({ title: 'Mesa RPG — ' + S.nome, text: inviteText(), url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  copyInvite();
}
async function copyInvite() { const t = `${inviteText()}\n${inviteUrl()}`; try { await navigator.clipboard.writeText(t); toast('Convite copiado!'); } catch { prompt('Copie o convite:', t); } }
$('#codeBtn').onclick = () => isM() ? share() : copyInvite(); $('#shareBtn').onclick = share; $('#copyBtn').onclick = copyInvite;

// ---------- cena + detalhe ----------
function renderScene(flash = true) {
  const sc = S.scene;
  $('#sceneTitle').textContent = sc.title || '';
  $('#sceneDesc').textContent = sc.desc || '';
  const img = $('#sceneImg');
  if (sc.image) img.src = sc.image; else img.removeAttribute('src');
  $('#sceneImgWrap').classList.toggle('has', !!sc.image);
  const det = sc.detail, card = $('#detailCard'), mark = $('#zoomMark');
  card.classList.toggle('hidden', !det); $('#clearDetailBtn').classList.toggle('hidden', !det);
  mark.classList.add('hidden');
  if (det) {
    const di = $('#detailImg');
    if (det.kind === 'zoom') {
      di.style.backgroundImage = `url("${sc.image}")`; di.style.backgroundSize = `${det.zoom * 100}%`; di.style.backgroundPosition = `${zpos(det.x, det.zoom)}% ${zpos(det.y, det.zoom)}%`;
      mark.style.left = det.x + '%'; mark.style.top = det.y + '%'; mark.classList.remove('hidden');
    } else { di.style.backgroundImage = `url("${det.image}")`; di.style.backgroundSize = 'cover'; di.style.backgroundPosition = 'center'; }
    $('#detailText').textContent = det.text || '';
    di.onclick = () => viewImg(det.kind === 'zoom' ? sc.image : det.image);
  }
  if (flash) { const el = $('.scene'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}
// posição do background que CENTRALIZA o ponto (x%,y%) com zoom z
const zpos = (v, z) => Math.max(0, Math.min(100, ((v / 100) * z - 0.5) / (z - 1) * 100));
function viewImg(src) { if (!src) return; const v = document.createElement('div'); v.className = 'img-view'; v.innerHTML = `<img src="${esc(src)}">`; v.onclick = () => v.remove(); document.body.appendChild(v); }
$('#sceneImgWrap').onclick = () => viewImg(S.scene.image);
let pendingImg;
function setPreview(sel, src) { const p = $(sel); p.style.backgroundImage = src ? `url("${src.replace(/"/g, '%22')}")` : ''; p.classList.toggle('has', !!src); }
$('#editSceneBtn').onclick = async () => {
  $('#scTitle').value = S.scene.title || ''; $('#scDesc').value = S.scene.desc || ''; $('#scUrl').value = '';
  pendingImg = undefined; setPreview('#scPreview', S.scene.image);
  $('#sceneModal').classList.remove('hidden');
  const r = await emit('gallery:get');
  $('#gallery').innerHTML = (r.gallery || []).map((u) => `<div data-u="${esc(u)}" style="background-image:url('${esc(u)}')"></div>`).join('');
  $$('#gallery div').forEach((d) => d.onclick = () => { pendingImg = { url: d.dataset.u }; setPreview('#scPreview', d.dataset.u); });
};
$$('[data-close]').forEach((b) => b.onclick = () => b.closest('.modal').classList.add('hidden'));
$('#scNoImg').onclick = () => { pendingImg = { url: '' }; setPreview('#scPreview', ''); };
$('#scUrl').addEventListener('input', (e) => { const u = e.target.value.trim(); if (/^https?:\/\//i.test(u)) { pendingImg = { url: u }; setPreview('#scPreview', u); } });
$('#scFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const data = await resizeImage(f, 1600, 0.85); pendingImg = { data }; setPreview('#scPreview', data); } catch { toast('Não consegui ler essa imagem.'); }
  e.target.value = '';
};
function resizeImage(file, max, q) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => {
      let { width: w, height: h } = im; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, 0, 0, w, h);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', q));
    };
    im.onerror = rej; im.src = url;
  });
}
$('#scSave').onclick = async () => {
  const b = $('#scSave'); b.disabled = true; b.textContent = 'Enviando...';
  const d = { title: $('#scTitle').value, desc: $('#scDesc').value };
  if (pendingImg?.data) d.imageData = pendingImg.data; else if (pendingImg) d.imageUrl = pendingImg.url;
  const r = await emit('scene:set', d);
  b.disabled = false; b.textContent = 'Mostrar para todos';
  if (!r.ok) return toast(r.erro);
  $('#sceneModal').classList.add('hidden'); toast('Cena enviada para a mesa!');
};
// detalhe
let det = { kind: 'zoom', x: 50, y: 30, zoom: 3, img: null };
function detUpdate() {
  $$('#detSeg button').forEach((b) => b.classList.toggle('active', b.dataset.k === det.kind));
  $('#detZoom').classList.toggle('hidden', det.kind !== 'zoom'); $('#detFoto').classList.toggle('hidden', det.kind !== 'foto');
  const mk = $('#detPickMark'); mk.style.left = det.x + '%'; mk.style.top = det.y + '%';
  $('#detZoomVal').textContent = det.zoom + '×';
  const pv = $('#detZoomPrev'); pv.style.backgroundImage = S.scene.image ? `url("${S.scene.image}")` : ''; pv.style.backgroundSize = det.zoom * 100 + '%'; pv.style.backgroundPosition = `${zpos(det.x, det.zoom)}% ${zpos(det.y, det.zoom)}%`;
}
$('#detailBtn').onclick = () => {
  det = { kind: S.scene.image ? 'zoom' : 'foto', x: 50, y: 30, zoom: 3, img: null };
  $('#detPickImg').src = S.scene.image || ''; $('#detText').value = ''; $('#detUrl').value = ''; setPreview('#detFotoPrev', '');
  $('#detZoomRange').value = 3; detUpdate(); $('#detailModal').classList.remove('hidden');
};
$$('#detSeg button').forEach((b) => b.onclick = () => { if (b.dataset.k === 'zoom' && !S.scene.image) return toast('A cena não tem imagem. Use "Outra foto".'); det.kind = b.dataset.k; detUpdate(); });
$('#detPick').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); det.x = Math.round((e.clientX - r.left) / r.width * 1000) / 10; det.y = Math.round((e.clientY - r.top) / r.height * 1000) / 10; detUpdate(); };
$('#detZoomRange').oninput = (e) => { det.zoom = +e.target.value; detUpdate(); };
$('#detFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { det.img = { data: await resizeImage(f, 1600, 0.85) }; setPreview('#detFotoPrev', det.img.data); } catch { toast('Não consegui ler essa imagem.'); } e.target.value = ''; };
$('#detUrl').addEventListener('input', (e) => { const u = e.target.value.trim(); if (/^https?:\/\//i.test(u)) { det.img = { url: u }; setPreview('#detFotoPrev', u); } });
$('#detSave').onclick = async () => {
  const d = { kind: det.kind, text: $('#detText').value };
  if (det.kind === 'zoom') Object.assign(d, { x: det.x, y: det.y, zoom: det.zoom });
  else if (det.img?.data) d.imageData = det.img.data; else if (det.img?.url) d.imageUrl = det.img.url; else return toast('Escolha a foto do detalhe.');
  const b = $('#detSave'); b.disabled = true; const r = await emit('scene:detail', d); b.disabled = false;
  if (!r.ok) return toast(r.erro);
  $('#detailModal').classList.add('hidden'); toast('Detalhe enviado para a mesa!');
};
$('#clearDetailBtn').onclick = async () => { const r = await emit('scene:detail', { clear: true }); if (!r.ok) toast(r.erro); };

// ---------- narração do mestre ----------
function narrHtml(m) {
  if (m.mode === 'on') return `<div class="msg on"><div class="who"><span>🎭 ${esc(m.personagem || 'Narrador')}</span><span>${hhmm(m.ts)}</span></div>${esc(m.text)}</div>`;
  return `<div class="msg off"><div class="who"><span>💬 Mestre (off) · para a mesa</span><span>${hhmm(m.ts)}</span></div>${esc(m.text)}</div>`;
}
function privHtml(m) {
  const w = isM() ? `💬 Off para ${esc(pName(m.to) || m.toNome)}` : '💬 Mestre (off) · só para você';
  return `<div class="msg off"><div class="who"><span>${w}</span><span>${hhmm(m.ts)}</span></div>${esc(m.text)}</div>`;
}
function renderNarr() {
  const items = [...S.narration.map((m) => ({ ...m, k: 'n' })), ...(isM() ? [] : S.privates.map((m) => ({ ...m, k: 'p' })))].sort((a, b) => b.ts - a.ts);
  $('#narrFeed').innerHTML = items.length ? items.map((m) => m.k === 'n' ? narrHtml(m) : privHtml(m)).join('') : '<div class="empty-txt">O mestre ainda não narrou nada.</div>';
}
function renderPriv() { const html = S.privates.slice().reverse().map(privHtml).join('') || '<div class="empty-txt">Nenhuma mensagem.</div>'; $('#privFeed').innerHTML = html; $('#privFeedM').innerHTML = html; }
$('#sayBtn').onclick = async () => {
  const text = $('#sayText').value.trim(); if (!text) return;
  const r = await emit('mestre:say', { mode, text, personagem: $('#sayPers').value, to: $('#sayTo').value });
  if (!r.ok) return toast(r.erro);
  $('#sayText').value = ''; toast(mode === 'on' ? 'Narração enviada' : 'Mensagem off enviada');
};

// ---------- dados ----------
function renderDicePicker() {
  $('#diceGrid').innerHTML = DICE.map((d) => `<div class="die" data-d="${d}"><span class="qty"></span><div class="shape">d${d}</div><div class="pm"><button type="button" data-a="-1">−</button><button type="button" data-a="1">+</button></div></div>`).join('');
  $$('#diceGrid .die').forEach((el) => {
    const d = +el.dataset.d;
    $('.shape', el).onclick = () => { pick[d] = Math.min(50, pick[d] + 1); updPick(); };
    $$('.pm button', el).forEach((b) => b.onclick = () => { pick[d] = Math.max(0, Math.min(50, pick[d] + +b.dataset.a)); updPick(); });
  });
  updPick();
}
function exprOf() { const m = +$('#mod').value || 0; const parts = DICE.filter((d) => pick[d] > 0).map((d) => `${pick[d]}d${d}`); if (!parts.length) return ''; return parts.join(' + ') + (m ? (m > 0 ? ` + ${m}` : ` − ${-m}`) : ''); }
function updPick() { $$('#diceGrid .die').forEach((el) => { const q = pick[el.dataset.d]; el.classList.toggle('sel', q > 0); $('.qty', el).textContent = q; }); $('#exprPreview').textContent = exprOf() || 'Nenhum dado escolhido'; }
$$('[data-mod]').forEach((b) => b.onclick = () => { $('#mod').value = (+$('#mod').value || 0) + +b.dataset.mod; updPick(); });
$('#mod').oninput = updPick;
$('#clearDice').onclick = () => { DICE.forEach((d) => pick[d] = 0); $('#mod').value = 0; $('#rollLabel').value = ''; updPick(); };
$('#rollBtn').onclick = async () => {
  if (!exprOf()) return toast('Escolha pelo menos um dado.');
  const b = $('#rollBtn'); b.disabled = true;
  const r = await emit('dice:roll', { dice: pick, mod: +$('#mod').value || 0, label: $('#rollLabel').value, target: isM() ? $('#rollTarget').value : '' });
  b.disabled = false; if (!r.ok) toast(r.erro);
};
function diceHtml(r) { return r.dice.map((d) => `<span class="dv ${d.value === d.sides ? 'max' : d.value === 1 ? 'min' : ''}">${d.value}<small>d${d.sides}</small></span>`).join('') + (r.mod ? `<span class="dv">${r.mod > 0 ? '+' : ''}${r.mod}<small>mod</small></span>` : ''); }
function rollWho(r) { return `${esc(r.byNome)}${r.target ? ` → para ${esc(pName(r.target) || r.targetNome)}` : ''}`; }
function renderRolls() {
  const last = S.rolls[S.rolls.length - 1], lr = $('#lastRoll');
  if (!last) { lr.className = 'last-roll empty'; lr.innerHTML = '<div class="lr-hint">Escolha os dados e role!</div>'; }
  else { lr.className = 'last-roll'; lr.innerHTML = `<div class="lr-by">${rollWho(last)} · ${hhmm(last.ts)}</div>${last.label ? `<div class="lr-label">${esc(last.label)}</div>` : ''}<div class="lr-total">${last.total}</div><div class="small">${esc(last.expr)}</div><div class="lr-dice">${diceHtml(last)}</div>`; }
  $('#rollHist').innerHTML = S.rolls.slice(0, -1).reverse().map((r) => `<div class="msg"><div class="hist-item"><div><div class="who">${rollWho(r)} · ${hhmm(r.ts)}</div>${r.label ? `<b>${esc(r.label)}</b><br>` : ''}<span class="small">${esc(r.expr)}</span><div class="lr-dice" style="justify-content:flex-start">${diceHtml(r)}</div></div><div class="t">${r.total}</div></div></div>`).join('') || '<div class="empty-txt">Sem rolagens anteriores.</div>';
}
function rollFx(r) {
  const fx = $('#rollFx'); fx.innerHTML = `<div><div class="big">${r.total}</div><div class="cap">🎲 ${esc(r.byNome)}${r.label ? ' · ' + esc(r.label) : ''}<br><span class="small">${esc(r.expr)}</span></div></div>`;
  fx.classList.remove('hidden'); clearTimeout(fx._h); fx._h = setTimeout(() => fx.classList.add('hidden'), 1600);
  if (navigator.vibrate) navigator.vibrate(60);
}

// ---------- jogadores ----------
function initials(n) { return esc((n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()); }
function renderPlayers() {
  const mestre = `<div class="pcard"><div class="avatar">👑<span class="dot ${S.mestreOnline ? '' : 'off'}"></span></div><div class="pinfo"><b>${esc(S.mestreNome)}</b><span class="small">Mestre</span></div></div>`;
  $('#playerList').innerHTML = mestre + (S.players.map((p) => `<div class="pcard"><div class="avatar">${initials(p.personagem || p.nome)}<span class="dot ${p.online ? '' : 'off'}"></span></div><div class="pinfo"><b>${esc(p.nome)}${p.id === S.playerId ? ' (você)' : ''}</b><span class="small">${esc(p.personagem || 'sem personagem')} · ${p.online ? 'online' : 'offline'}</span></div>${isM() ? `<button class="btn danger" data-kick="${p.id}">Remover</button>` : (p.id !== S.playerId ? `<button class="btn ghost" data-dm="${p.id}">✉️</button>` : '')}</div>`).join('') || '<div class="empty-txt">Nenhum jogador ainda. Toque em "Convidar jogadores"!</div>');
  $$('[data-kick]').forEach((b) => b.onclick = async () => { if (confirm('Remover este jogador da mesa?')) { const r = await emit('player:kick', { playerId: b.dataset.kick }); if (!r.ok) toast(r.erro); } });
  $$('[data-dm]').forEach((b) => b.onclick = () => { conv = b.dataset.dm; renderConv(); switchTab('chat'); });
  if (isM()) {
    const opts = S.players.map((p) => `<option value="${p.id}">${esc(p.nome)}${p.personagem && p.personagem !== p.nome ? ' — ' + esc(p.personagem) : ''}</option>`).join('');
    const st = $('#sayTo'), sv = st.value; st.innerHTML = `<option value="all">Toda a mesa (fora de cena)</option>` + opts; if ([...st.options].some((o) => o.value === sv)) st.value = sv;
    const rt = $('#rollTarget'), rv = rt.value; rt.innerHTML = `<option value="">Mesa toda</option>` + opts; if ([...rt.options].some((o) => o.value === rv)) rt.value = rv;
  }
  renderConvChips();
}

// ---------- fichas ----------
function renderSheets() { renderSheetList(); renderEditor(); }
function renderSheetList() {
  if (!isM()) return;
  const ids = Object.keys(S.sheets);
  if (selSheet && !S.sheets[selSheet]) selSheet = null;
  $('#sheetList').innerHTML = `<h3 class="section" style="margin-top:4px">Fichas da mesa (${ids.length})</h3>` + (ids.map((id) => {
    const s = S.sheets[id]; const p = S.players.find((x) => x.id === id) || {};
    const pv = s.pvMax ? Math.max(0, Math.min(100, s.pvAtual / s.pvMax * 100)) : 0, mn = s.manaMax ? Math.max(0, Math.min(100, s.manaAtual / s.manaMax * 100)) : 0;
    return `<div class="pcard ${id === selSheet ? 'active' : ''}" data-sid="${id}"><div class="avatar">${initials(s.personagem || p.nome)}<span class="dot ${p.online ? '' : 'off'}"></span></div><div class="pinfo"><b>${esc(s.personagem || p.nome)}</b><span class="small">${esc(s.classe || 'sem classe')} · Nv ${s.nivel} · Jogador: ${esc(p.nome || '')}</span><div class="bar"><i style="width:${pv}%"></i></div><div class="bar mana"><i style="width:${mn}%"></i></div></div><div class="small">${s.pvAtual}/${s.pvMax}</div></div>`;
  }).join('') || '<div class="empty-txt">Quando os jogadores entrarem, as fichas aparecem aqui.</div>');
  $$('#sheetList [data-sid]').forEach((el) => el.onclick = () => { selSheet = selSheet === el.dataset.sid ? null : el.dataset.sid; renderSheets(); if (selSheet) $('#sheetEditor').scrollIntoView({ behavior: 'smooth' }); });
}
function field(k, label, type = 'text', v = '') { return `<label>${label}<input data-k="${k}" type="${type}" ${type === 'number' ? 'inputmode="numeric"' : 'maxlength="60"'} value="${esc(v)}"></label>`; }
function renderEditor() {
  const ed = $('#sheetEditor');
  if (!selSheet || !S.sheets[selSheet]) { ed.innerHTML = isM() ? '' : '<div class="empty-txt">Ficha não encontrada.</div>'; return; }
  const s = S.sheets[selSheet], owner = S.players.find((p) => p.id === selSheet);
  ed.innerHTML = `<div class="card sheet" data-for="${selSheet}">
    <div class="sheet-head"><h2>📜 ${isM() ? 'Ficha de ' + esc(owner?.nome || '') : 'Minha ficha'}</h2><div class="save-st" id="saveSt"></div></div>
    ${field('personagem', 'Nome do personagem', 'text', s.personagem)}
    <div class="grid2">${field('classe', 'Classe / Profissão', 'text', s.classe)}${field('nivel', 'Nível', 'number', s.nivel)}</div>
    <div class="grid2">${field('pvAtual', '❤️ PV atual', 'number', s.pvAtual)}${field('pvMax', 'PV máximo', 'number', s.pvMax)}</div>
    <div class="grid2">${field('manaAtual', '🔷 Mana atual', 'number', s.manaAtual)}${field('manaMax', 'Mana máxima', 'number', s.manaMax)}</div>
    <h3 class="section">Atributos</h3>
    <div class="grid3 attr">${ATTRS.map(([k, l]) => `<label>${l}<input data-attr="${k}" type="number" inputmode="numeric" value="${esc(s.atributos[k])}"></label>`).join('')}</div>
    <label>🎒 Inventário<textarea data-k="inventario" rows="4" maxlength="4000" placeholder="Itens, armas, moedas...">${esc(s.inventario)}</textarea></label>
    <label>✍️ Anotações / Livros<textarea data-k="anotacoes" rows="4" maxlength="4000" placeholder="História, pistas, livros estudados, magias...">${esc(s.anotacoes)}</textarea></label>
  </div>`;
  $$('#sheetEditor input, #sheetEditor textarea').forEach((el) => el.addEventListener('input', () => queueSave(el)));
}
let saveT = null, dirty = {};
function queueSave(el) {
  const pid = el.closest('[data-for]').dataset.for;
  dirty.pid = pid; dirty.sheet = dirty.sheet || {};
  const val = el.type === 'number' ? (+el.value || 0) : el.value;
  if (el.dataset.attr) { dirty.sheet.atributos = dirty.sheet.atributos || {}; dirty.sheet.atributos[el.dataset.attr] = val; } else dirty.sheet[el.dataset.k] = val;
  $('#saveSt').textContent = 'Salvando...'; clearTimeout(saveT); saveT = setTimeout(flushSave, 600);
}
async function flushSave() { if (!dirty.pid) return; const d = dirty; dirty = {}; const r = await emit('sheet:update', { playerId: d.pid, sheet: d.sheet }); const st = $('#saveSt'); if (st) st.textContent = r.ok ? '✓ Salvo' : '⚠ ' + r.erro; }
const editing = () => { const a = document.activeElement; return a && $('#sheetEditor').contains(a); };
function applySheetUpdate(pid, sheet) {
  S.sheets[pid] = sheet; const p = S.players.find((x) => x.id === pid); if (p) p.personagem = sheet.personagem;
  if (isM()) { if (!editing()) renderSheets(); else renderSheetList(); }
  else if (!editing() && !dirty.pid) renderEditor();
}

// ---------- chat: grupo + mensagens diretas ----------
const dmKey = (a, b) => [a, b].sort().join('|');
function renderConvChips() {
  let chips = [['grupo', '👥 Grupo']];
  if (isM()) {
    const pairs = [...new Set(S.dms.map((d) => dmKey(d.from, d.to)))];
    chips = chips.concat(pairs.map((k) => [k, '✉️ ' + k.split('|').map(pName).join(' ↔ ')]));
  } else chips = chips.concat(S.players.filter((p) => p.id !== S.playerId).map((p) => [p.id, '✉️ ' + p.nome]));
  if (!chips.some((c) => c[0] === conv)) conv = 'grupo';
  $('#convChips').innerHTML = chips.map(([k, l]) => `<button type="button" data-c="${esc(k)}" class="${k === conv ? 'active' : ''}">${esc(l)}<i class="${unread[k] ? 'on' : ''}"></i></button>`).join('');
  $$('#convChips button').forEach((b) => b.onclick = () => { conv = b.dataset.c; renderConv(); });
}
const unread = {};
function convMsgs() {
  if (conv === 'grupo') return S.chat;
  if (isM()) return S.dms.filter((d) => dmKey(d.from, d.to) === conv);
  return S.dms.filter((d) => (d.from === S.playerId && d.to === conv) || (d.to === S.playerId && d.from === conv));
}
function chatHtml(m) {
  const mine = m.from === S.playerId;
  const nome = m.nome ? (m.personagem && m.personagem !== m.nome ? `${m.nome} (${m.personagem})` : m.nome) : (m.fromNome + (isM() ? ' → ' + m.toNome : ''));
  return `<div class="msg ${mine ? 'mine' : ''} ${conv !== 'grupo' ? 'dm' : ''}"><div class="who"><span>${esc(nome)}${tagHtml(m.mode)}</span><span>${hhmm(m.ts)}</span></div>${esc(m.text)}</div>`;
}
function renderConv() {
  delete unread[conv]; renderConvChips();
  const isDm = conv !== 'grupo';
  $('#chatNote').textContent = isM()
    ? (isDm ? 'Conversa privada entre jogadores. Só eles dois e você (mestre) veem.' : 'Conversa dos jogadores. Você acompanha tudo aqui e no Registro.')
    : (isDm ? `Só você, ${pName(conv)} e o mestre veem esta conversa.` : 'Conversa da mesa. Use 🎭 ON para falar como personagem e 💬 OFF fora de cena.');
  $('#chatText').placeholder = isDm ? `Mensagem privada para ${pName(conv)}...` : 'Mensagem para o grupo...';
  const list = convMsgs();
  $('#chatFeed').innerHTML = list.map(chatHtml).join('') || '<div class="empty-txt">Nenhuma mensagem ainda.</div>';
  if (currentTab === 'chat') window.scrollTo(0, document.body.scrollHeight);
}
$('#chatForm').onsubmit = async (e) => {
  e.preventDefault(); const t = $('#chatText'); const text = t.value.trim(); if (!text) return;
  t.value = '';
  const r = conv === 'grupo' ? await emit('chat:send', { text, mode }) : await emit('dm:send', { to: conv, text, mode });
  if (!r.ok) { toast(r.erro); t.value = text; }
};

// ---------- Registro do Mestre ----------
const LOG_TYPES = [['tudo', 'Tudo'], ['voz', '🎙 Voz'], ['chat', '💬 Chat'], ['dm', '✉️ Privado'], ['narracao', '🎭 Narração'], ['dado', '🎲 Dados'], ['cena', '🏰 Cena']];
const LOG_ICON = { voz: '🎙', chat: '💬', dm: '✉️', narracao: '🎭', dado: '🎲', cena: '🏰', entrada: '🚪' };
function logHtml(e) {
  const dest = e.type === 'dm' ? ` → ${esc(e.toNome)}` : e.type === 'narracao' && e.mode === 'off' ? ` → ${esc(e.toNome)}` : '';
  const nome = e.type === 'narracao' && e.personagem ? `${esc(e.fromNome)} como ${esc(e.personagem)}` : esc(e.fromNome);
  return `<div class="msg ${e.type}"><div class="who"><span>${LOG_ICON[e.type] || '•'} ${nome}${dest}${tagHtml(e.mode)}</span><span>${hhmm(e.ts)}</span></div>${esc(e.text)}${e.image && e.type === 'cena' ? `<img class="lg-img" src="${esc(e.image)}" alt="">` : ''}</div>`;
}
function renderLog() {
  if (!isM()) return;
  $('#logChips').innerHTML = LOG_TYPES.map(([k, l]) => `<button type="button" data-f="${k}" class="${k === logFilter ? 'active' : ''}">${l}</button>`).join('');
  $$('#logChips button').forEach((b) => b.onclick = () => { logFilter = b.dataset.f; renderLog(); });
  const list = S.log.filter((e) => logFilter === 'tudo' || e.type === logFilter).slice().reverse();
  $('#logFeed').innerHTML = list.map(logHtml).join('') || '<div class="empty-txt">Nada registrado ainda.</div>';
}
$('#exportLog').onclick = async () => {
  const r = await emit('log:get'); if (!r.ok) return toast(r.erro);
  const txt = r.log.map((e) => `[${new Date(e.ts).toLocaleString('pt-BR')}] ${(e.type || '').toUpperCase()}${e.mode ? ' ' + e.mode.toUpperCase() : ''} ${e.fromNome || ''}${e.toNome ? ' -> ' + e.toNome : ''}: ${e.text}`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = `registro-${S.code}.txt`; a.click();
};

// ---------- VOZ (WebRTC mesh) + transcrição ----------
const V = { joined: false, stream: null, muted: false, pcs: {}, ice: {}, me: null, ac: null, speaking: false, rec: null, recOn: false, ptt: false };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
function renderVoice() {
  const list = S?.voice || [];
  $('#voiceJoin').classList.toggle('hidden', V.joined);
  for (const id of ['#muteBtn', '#voiceLeave']) $(id).classList.toggle('hidden', !V.joined);
  $('#pttBtn').classList.toggle('hidden', !V.joined || !SR);
  $('#muteBtn').classList.toggle('muted', V.muted); $('#muteBtn').textContent = V.muted ? '🔇' : '🎙';
  $('#voicePeers').innerHTML = list.length ? list.map((v) => `<div class="vp ${v.speaking && !v.muted ? 'speaking' : ''}" title="${esc(v.nome)}">${v.who === 'mestre' ? '👑' : initials(v.nome)}<span class="md">${v.mode === 'off' ? '💬' : '🎭'}</span>${v.muted ? '<span class="m">🔇</span>' : ''}</div>`).join('') : `<span class="vp-empty">${V.joined ? '' : 'Ninguém na voz'}</span>`;
  document.documentElement.style.setProperty('--vbh', $('#voiceBar').offsetHeight + 'px');
}
function stt(msg) { const l = $('#sttLine'); l.textContent = msg || ''; l.classList.toggle('hidden', !msg); renderVoice(); }
async function joinVoice() {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast('Este navegador não suporta voz.');
  try { V.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { return toast('Permita o uso do microfone para entrar na voz.'); }
  V.joined = true; V.muted = false;
  startMeter();
  await rejoinVoice();
  startRec();
  if (!SR) stt('📝 Transcrição automática indisponível neste navegador (use Chrome no Android). Use o chat de texto ou o microfone do teclado.');
}
async function rejoinVoice() {
  for (const sid of Object.keys(V.pcs)) closePeer(sid);
  const r = await emit('voice:join', { muted: V.muted, mode });
  if (!r.ok) { toast(r.erro); leaveVoice(); return; }
  V.me = r.me;
  for (const p of r.peers) makePeer(p.sid, true);
  renderVoice();
}
function leaveVoice() {
  if (!V.joined) return;
  V.joined = false; stopRec();
  socket.emit('voice:leave', {}, () => {});
  for (const sid of Object.keys(V.pcs)) closePeer(sid);
  V.stream?.getTracks().forEach((t) => t.stop()); V.stream = null;
  if (V.ac) { V.ac.close(); V.ac = null; }
  stt(''); renderVoice();
}
function makePeer(sid, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  V.pcs[sid] = pc; V.ice[sid] = [];
  V.stream.getTracks().forEach((t) => pc.addTrack(t, V.stream));
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('voice:signal', { to: sid, data: { type: 'ice', c: e.candidate } }); };
  pc.ontrack = (e) => {
    let a = document.getElementById('a-' + sid);
    if (!a) { a = document.createElement('audio'); a.id = 'a-' + sid; a.autoplay = true; a.playsInline = true; $('#remoteAudio').appendChild(a); }
    a.srcObject = e.streams[0]; a.play().catch(() => toast('Toque na tela para ouvir a voz.'));
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') toast('Não foi possível conectar a voz com um participante (rede restrita).'); };
  if (initiator) pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => socket.emit('voice:signal', { to: sid, data: { type: 'sdp', sdp: pc.localDescription } }));
  return pc;
}
function closePeer(sid) { try { V.pcs[sid]?.close(); } catch { } delete V.pcs[sid]; delete V.ice[sid]; document.getElementById('a-' + sid)?.remove(); }
socket.on('voice:signal', async ({ from, data }) => {
  if (!V.joined || !data) return;
  let pc = V.pcs[from];
  try {
    if (data.type === 'sdp') {
      if (data.sdp.type === 'offer') { if (pc) closePeer(from); pc = makePeer(from, false); }
      if (!pc) return;
      await pc.setRemoteDescription(data.sdp);
      for (const c of V.ice[from] || []) await pc.addIceCandidate(c).catch(() => {});
      V.ice[from] = [];
      if (data.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); socket.emit('voice:signal', { to: from, data: { type: 'sdp', sdp: pc.localDescription } }); }
    } else if (data.type === 'ice') {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(data.c).catch(() => {}); else (V.ice[from] = V.ice[from] || []).push(data.c);
    }
  } catch (e) { console.warn('sinal', e); }
});
socket.on('voice:left', ({ sid }) => closePeer(sid));
socket.on('voice:peers', (list) => { if (!S) return; S.voice = list; renderVoice(); });
socket.on('voice:state', (v) => { if (!S) return; const i = S.voice.findIndex((x) => x.sid === v.sid); if (i >= 0) S.voice[i] = v; else S.voice.push(v); renderVoice(); });
function startMeter() {
  try {
    V.ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = V.ac.createAnalyser(); an.fftSize = 512; V.ac.createMediaStreamSource(V.stream).connect(an);
    const buf = new Uint8Array(an.fftSize); let quiet = 0;
    const tick = () => {
      if (!V.ac) return;
      an.getByteTimeDomainData(buf); let sum = 0; for (const b of buf) sum += (b - 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      const on = !V.muted && rms > 6;
      if (on) quiet = 0; else quiet++;
      const speaking = on || (V.speaking && quiet < 4);
      if (speaking !== V.speaking) { V.speaking = speaking; socket.emit('voice:state', { speaking }); }
      setTimeout(tick, 120);
    };
    tick();
  } catch { }
}
$('#voiceJoin').onclick = joinVoice;
$('#voiceLeave').onclick = leaveVoice;
$('#muteBtn').onclick = () => {
  V.muted = !V.muted; V.stream?.getAudioTracks().forEach((t) => t.enabled = !V.muted);
  socket.emit('voice:state', { muted: V.muted, speaking: false });
  if (V.muted) stopRec(); else startRec();
  renderVoice();
};
// transcrição contínua (Web Speech API). Cada frase final vai para o Registro do Mestre com o modo ON/OFF.
function sendTranscript(text, conf) { text = text.trim(); if (!text) return; emit('transcript:add', { text, mode, conf }); stt(`📝 Você ${mode === 'on' ? '(ON)' : '(OFF)'}: ${text}`); }
function makeRec(continuous) {
  const r = new SR(); r.lang = 'pt-BR'; r.continuous = continuous; r.interimResults = true; r.maxAlternatives = 1;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) sendTranscript(res[0].transcript, res[0].confidence); else interim += res[0].transcript;
    }
    if (interim) stt('📝 ' + interim);
  };
  return r;
}
function startRec() {
  if (!SR || !V.joined || V.muted || V.recOn) return;
  V.recOn = true;
  const run = () => {
    if (!V.recOn) return;
    try {
      V.rec = makeRec(true);
      V.rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { V.recOn = false; stt('📝 Transcrição bloqueada pelo navegador. Use o botão ✍️ (segure para ditar).'); } };
      V.rec.onend = () => { if (V.recOn) setTimeout(run, 250); };
      V.rec.start(); if (!$('#sttLine').textContent) stt('📝 Transcrição ligada — sua fala vai para o registro do mestre.');
    } catch { V.recOn = false; }
  };
  run();
}
function stopRec() { V.recOn = false; try { V.rec?.stop(); } catch { } V.rec = null; }
// alternativa: segurar para ditar (push-to-talk), para navegadores em que a transcrição contínua falha
const ptt = $('#pttBtn');
ptt.addEventListener('pointerdown', (e) => {
  e.preventDefault(); if (!SR) return;
  stopRec(); ptt.classList.add('rec'); stt('📝 Ditando... solte para enviar');
  V.ptt = makeRec(false); V.ptt.onend = () => { ptt.classList.remove('rec'); V.ptt = null; if (!V.muted) startRec(); };
  try { V.ptt.start(); } catch { }
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) ptt.addEventListener(ev, () => { try { V.ptt?.stop(); } catch { } });

// ---------- eventos do servidor ----------
socket.on('connect', async () => {
  $('#connDot').classList.remove('off');
  const c = cur();
  if (c && (S || !qp || c.code === qp)) {
    const r = await emit('auth', { code: c.code, token: c.token });
    if (r.ok) enter(r.state); else if (!S) { localStorage.removeItem(LS_CUR); dropSession(c.code, c.token); renderRecent(); }
  }
});
socket.on('disconnect', () => { $('#connDot').classList.add('off'); for (const sid of Object.keys(V.pcs)) closePeer(sid); });
socket.on('scene', (sc) => { if (!S) return; const newDet = sc.detail && sc.detail.ts !== S.scene.detail?.ts; S.scene = sc; renderScene(); ping('cena'); if (currentTab !== 'cena') toast(newDet ? '🔍 O mestre mostrou um detalhe' : '🏰 Nova cena: ' + (sc.title || '')); if (navigator.vibrate) navigator.vibrate(40); });
socket.on('narration', (m) => { if (!S) return; S.narration.push(m); renderNarr(); ping('cena'); if (currentTab !== 'cena') toast(m.mode === 'on' ? '🎭 Nova narração' : '💬 Aviso do mestre'); });
socket.on('private', (m) => { if (!S) return; S.privates.push(m); renderNarr(); renderPriv(); if (!isM()) { ping('cena'); toast('💬 Mensagem off do mestre para você', 3000); if (navigator.vibrate) navigator.vibrate([60, 40, 60]); } });
socket.on('roll', (r) => { if (!S) return; S.rolls.push(r); if (S.rolls.length > 30) S.rolls.shift(); renderRolls(); rollFx(r); ping('dados'); });
socket.on('chat', (m) => { if (!S) return; S.chat.push(m); if (conv === 'grupo') renderConv(); else { unread.grupo = 1; renderConvChips(); } ping('chat'); });
socket.on('dm', (m) => {
  if (!S) return; S.dms.push(m);
  const k = isM() ? dmKey(m.from, m.to) : (m.from === S.playerId ? m.to : m.from);
  if (conv === k) renderConv(); else { unread[k] = 1; renderConvChips(); }
  if (!isM() && m.from !== S.playerId) { ping('chat'); toast(`✉️ Mensagem privada de ${m.fromNome}`); }
});
socket.on('log', (e) => { if (!S || !isM()) return; S.log.push(e); if (S.log.length > 1000) S.log.shift(); if (currentTab === 'registro') renderLog(); else ping('registro'); });
socket.on('players', (d) => { if (!S) return; S.players = d.players; S.mestreOnline = d.mestreOnline; if (!isM() && !S.players.some((p) => p.id === S.playerId)) return; renderPlayers(); if (isM()) { for (const id of Object.keys(S.sheets)) if (!S.players.some((p) => p.id === id)) delete S.sheets[id]; if (editing()) renderSheetList(); else renderSheets(); } });
socket.on('sheet', ({ playerId, sheet }) => { if (!S) return; applySheetUpdate(playerId, sheet); if (isM()) ping('fichas'); });
socket.on('kicked', () => { leaveVoice(); const c = cur(); if (c) dropSession(c.code, c.token); localStorage.removeItem(LS_CUR); alert('Você foi removido da mesa pelo mestre.'); location.href = '/'; });

renderRecent();
setupInvite();
setMode(mode);
})();
