// Teste automatizado: node test.js (servidor precisa estar rodando em PORT)
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:' + (process.env.PORT || 3777);
const assert = require('assert');
const mk = () => new Promise((r) => { const s = io(URL, { transports: ['websocket'], forceNew: true }); s.on('connect', () => r(s)); });
const call = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const wait = (s, ev, ms = 2000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, (x) => { clearTimeout(t); res(x); }); });
let pass = 0; const ok = (m) => { pass++; console.log('✓', m); };
(async () => {
  const M = await mk(), A = await mk(), B = await mk();
  const c = await call(M, 'mesa:create', { mestreNome: 'Danilo', nomeMesa: 'Teste' });
  assert(c.ok && /^[A-Z0-9]{5}$/.test(c.state.code)); ok('mestre cria mesa ' + c.state.code);
  const code = c.state.code;
  const bad = await call(A, 'mesa:join', { code: 'ZZZZZ', nome: 'x' }); assert(!bad.ok); ok('código inválido recusado');
  const a = await call(A, 'mesa:join', { code, nome: 'Ana' }); assert(a.ok); 
  const b = await call(B, 'mesa:join', { code, nome: 'Bruno' }); assert(b.ok); ok('2 jogadores entram');
  const aId = a.state.playerId, bId = b.state.playerId;
  assert.deepStrictEqual(Object.keys(b.state.sheets), [bId]); ok('estado inicial do jogador só traz a própria ficha');
  // cena
  const pa = wait(A, 'scene'), pb = wait(B, 'scene');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sc = await call(M, 'scene:set', { title: 'A Taverna', desc: 'Fumaça e cerveja', imageData: png }); assert(sc.ok);
  const [sa, sb] = await Promise.all([pa, pb]); assert(sa.title === 'A Taverna' && sb.image.startsWith('/uploads/')); ok('cena chega aos 2 jogadores com imagem');
  const img = await fetch(URL + sb.image); assert(img.ok); ok('imagem enviada é servida');
  const ns = await call(A, 'scene:set', { title: 'hack' }); assert(!ns.ok); ok('jogador não pode mudar cena');
  // dados
  const ra = wait(A, 'roll'), rb2 = wait(B, 'roll');
  const r = await call(M, 'dice:roll', { dice: { 6: 2, 20: 1 }, mod: 3, label: 'Ataque' }); assert(r.ok);
  const [x, y] = await Promise.all([ra, rb2]);
  assert(x.id === y.id && x.dice.length === 3 && x.total === x.dice.reduce((s, d) => s + d.value, 0) + 3 && x.expr === '2d6 + 1d20 + 3');
  assert(x.dice.every((d) => d.value >= 1 && d.value <= d.sides)); ok(`rolagem 2d6+1d20+3 transmitida: ${x.dice.map((d) => d.value).join(',')} = ${x.total}`);
  let all100 = (await call(M, 'dice:roll', { dice: { 100: 50 } })).roll.dice.every((d) => d.value >= 1 && d.value <= 100); assert(all100); ok('50d100 dentro do intervalo');
  const pr = await call(A, 'dice:roll', { dice: { 20: 1 } }); assert(pr.ok && pr.roll.byNome === 'Ana'); ok('jogador também rola');
  // fichas
  const g1 = await call(A, 'sheet:get', { playerId: bId }); assert(!g1.ok); ok('Ana NÃO consegue ler a ficha do Bruno');
  const u1 = await call(A, 'sheet:update', { playerId: bId, sheet: { pvAtual: 0 } }); assert(!u1.ok); ok('Ana NÃO consegue editar a ficha do Bruno');
  const g2 = await call(A, 'sheets:all'); assert(!g2.ok); ok('Ana NÃO consegue listar todas as fichas');
  let leaked = false; B.on('sheet', (s) => { if (s.playerId === aId) leaked = true; });
  const mSheet = wait(M, 'sheet');
  const u2 = await call(A, 'sheet:update', { playerId: aId, sheet: { personagem: 'Lyra', classe: 'Maga', atributos: { inteligencia: 9 } } }); assert(u2.ok && u2.sheet.atributos.inteligencia === 9);
  const ms = await mSheet; assert(ms.playerId === aId && ms.sheet.personagem === 'Lyra'); ok('Ana edita a própria ficha e o mestre recebe');
  await new Promise((r) => setTimeout(r, 300)); assert(!leaked); ok('Bruno não recebe a ficha da Ana');
  const all = await call(M, 'sheets:all'); assert(all.ok && all.sheets[aId] && all.sheets[bId]); ok('mestre vê todas as fichas');
  const mu = await call(M, 'sheet:update', { playerId: bId, sheet: { pvAtual: 3 } }); assert(mu.ok); ok('mestre edita ficha do Bruno');
  // on/off
  const pB = wait(B, 'private'); let aGotPriv = false; A.on('private', () => aGotPriv = true);
  assert((await call(M, 'mestre:say', { mode: 'off', to: bId, text: 'Só você vê a porta secreta.' })).ok);
  await pB; await new Promise((r) => setTimeout(r, 200)); assert(!aGotPriv); ok('mensagem OFF chega só ao Bruno');
  const nA = wait(A, 'narration'); await call(M, 'mestre:say', { mode: 'on', text: 'Bem-vindos!', personagem: 'Taverneiro' }); assert((await nA).personagem === 'Taverneiro'); ok('narração ON chega a todos');
  // chat
  const cB = wait(B, 'chat'); await call(A, 'chat:send', { text: 'Oi Bruno' }); assert((await cB).text === 'Oi Bruno'); ok('chat entre jogadores');
  assert(!(await call(M, 'chat:send', { text: 'x' })).ok); ok('mestre não fala no chat dos jogadores');
  // reconexão por token
  const A2 = await mk(); const re = await call(A2, 'auth', { code, token: a.token }); assert(re.ok && re.state.playerId === aId && re.state.role === 'player' && !re.state.sheets[bId]); ok('jogador reconecta com token (mesmo papel)');
  const M2 = await mk(); const rm = await call(M2, 'auth', { code, token: c.token }); assert(rm.ok && rm.state.role === 'mestre' && Object.keys(rm.state.sheets).length === 2); ok('mestre reconecta com token secreto');
  const X = await mk(); assert(!(await call(X, 'auth', { code, token: 'chute' })).ok); ok('token falso recusado');
  assert(re.state.privates.length === 0); const reB = await call(await mk(), 'auth', { code, token: b.token }); assert(reB.state.privates.length === 1); ok('histórico OFF só para o destinatário');

  // ================= v2 =================
  const C = await mk(); const cc = await call(C, 'mesa:join', { code, nome: 'Caio' }); assert(cc.ok); const cId = cc.state.playerId;
  // espiões: nenhum jogador pode receber o Registro do Mestre
  let logLeak = 0; for (const s of [A, B, C, A2]) s.on('log', () => logLeak++);
  const mLogs = []; M.on('log', (e) => mLogs.push(e));
  assert(!('log' in a.state) && !('log' in cc.state)); ok('estado do jogador não contém o registro do mestre');
  assert((await call(A, 'log:get')).ok === false); ok('jogador não consegue pedir o registro (log:get)');
  // DM privada entre Ana e Bruno
  let cGotDm = 0; C.on('dm', () => cGotDm++);
  const dmB = wait(B, 'dm'), dmM = wait(M, 'dm'), dmA = wait(A2, 'dm');
  const dm = await call(A2, 'dm:send', { to: bId, text: 'Bruno, não confie no taverneiro', mode: 'off' }); assert(dm.ok);
  const [gb, gm, ga] = await Promise.all([dmB, dmM, dmA]);
  assert(gb.text.includes('taverneiro') && gm.from === aId && gm.to === bId && ga.mode === 'off');
  await new Promise((r) => setTimeout(r, 250)); assert(cGotDm === 0); ok('DM Ana→Bruno chega a Bruno, Ana e mestre; Caio NÃO recebe');
  const reC = await call(await mk(), 'auth', { code, token: cc.token }); assert(reC.state.dms.length === 0); ok('histórico de DMs não vaza para o Caio ao reconectar');
  const reBB = await call(await mk(), 'auth', { code, token: b.token }); assert(reBB.state.dms.length === 1); ok('Bruno vê a DM no histórico');
  assert(!(await call(A2, 'dm:send', { to: aId, text: 'eu' })).ok && !(await call(M, 'dm:send', { to: aId, text: 'x' })).ok); ok('DM para si mesmo / mestre via DM recusadas');
  // transcrições com tag ON/OFF
  assert((await call(A2, 'transcript:add', { text: 'Eu abro a porta devagar', mode: 'on' })).ok);
  assert((await call(B, 'transcript:add', { text: 'Pessoal, vou pegar água', mode: 'off' })).ok);
  assert((await call(M, 'transcript:add', { text: 'A porta range', mode: 'on' })).ok);
  await new Promise((r) => setTimeout(r, 200));
  const lg = (await call(M, 'log:get')).log;
  const voz = lg.filter((e) => e.type === 'voz');
  assert(voz.length === 3 && voz[0].mode === 'on' && voz[0].from === aId && voz[1].mode === 'off' && voz[1].from === bId && voz[2].from === 'mestre' && voz.every((e) => e.ts));
  ok('transcrições salvas com falante, horário e tag ON/OFF');
  const types = new Set(lg.map((e) => e.type));
  for (const t of ['voz', 'chat', 'dm', 'narracao', 'dado', 'cena', 'entrada']) assert(types.has(t), 'faltou ' + t);
  ok('registro do mestre tem voz, chat, DM, narração, dados, cena e entradas');
  assert(mLogs.length > 0 && logLeak === 0); ok(`mestre recebe registro ao vivo (${mLogs.length} eventos); jogadores receberam 0`);
  const chatOff = wait(B, 'chat'); await call(A2, 'chat:send', { text: 'brb', mode: 'off' }); assert((await chatOff).mode === 'off'); ok('chat de texto carrega a tag OFF');
  // detalhe da cena
  const detA = wait(A2, 'scene'); assert((await call(M, 'scene:detail', { kind: 'zoom', x: 50, y: 12, zoom: 4, text: 'Um símbolo de serpente' })).ok);
  const sd = await detA; assert(sd.detail.kind === 'zoom' && sd.detail.y === 12 && sd.image && sd.title === 'A Taverna'); ok('detalhe (zoom) chega aos jogadores mantendo a cena principal');
  assert(!(await call(A2, 'scene:detail', { kind: 'zoom', x: 1, y: 1 })).ok); ok('jogador não pode mostrar detalhe');
  const detB = wait(B, 'scene'); assert((await call(M, 'scene:detail', { kind: 'foto', imageData: png, text: 'De perto' })).ok); assert((await detB).detail.image.startsWith('/uploads/')); ok('detalhe com segunda foto');
  // sinalização WebRTC só para o alvo
  const vA = await call(A2, 'voice:join', { mode: 'on' }), vB = await call(B, 'voice:join', {}), vC = await call(C, 'voice:join', {});
  assert(vA.ok && vB.ok && vC.ok && vC.peers.length === 2); ok('3 entram na voz; o novo recebe a lista de pares');
  let cSig = 0; C.on('voice:signal', () => cSig++);
  const sigB = wait(B, 'voice:signal');
  assert((await call(A2, 'voice:signal', { to: B.id, data: { type: 'sdp', sdp: { type: 'offer', sdp: 'x' } } })).ok);
  const sg = await sigB; assert(sg.from === A2.id && sg.data.sdp.type === 'offer');
  await new Promise((r) => setTimeout(r, 200)); assert(cSig === 0); ok('sinal WebRTC Ana→Bruno chega só ao Bruno');
  assert(!(await call(A2, 'voice:signal', { to: M.id, data: {} })).ok); ok('sinal para quem não está na voz é recusado');
  const O = await mk(); await call(O, 'mesa:create', { mestreNome: 'Outro' }); await call(O, 'voice:join', {});
  assert(!(await call(A2, 'voice:signal', { to: O.id, data: {} })).ok); ok('sinal para outra mesa é recusado');
  const stB = wait(B, 'voice:state'); A2.emit('voice:state', { muted: true, mode: 'off' }); const st = await stB; assert(st.muted && st.mode === 'off'); ok('estado da voz (mudo / modo) é transmitido');
  const left = wait(B, 'voice:left'); C.disconnect(); assert((await left).sid); ok('saída da voz avisada aos pares');
  // convite e sem limite de jogadores
  const inv = await fetch(URL + '/m/' + code.toLowerCase(), { redirect: 'manual' }); assert(inv.status === 302 && inv.headers.get('location') === '/?mesa=' + code); ok('link /m/CODIGO leva direto à entrada da mesa');
  const info = await (await fetch(URL + '/api/mesa/' + code)).json(); assert(info.ok && info.nome === 'Teste' && !('mestreToken' in info)); ok('API pública do convite não expõe segredos');
  const many = await Promise.all(Array.from({ length: 40 }, async (_, i) => { const s = await mk(); const r = await call(s, 'mesa:join', { code, nome: 'J' + i }); s.disconnect(); return r.ok; }));
  assert(many.every(Boolean)); ok('sem limite de jogadores (+40 entraram)');
  for (const f of ['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png']) assert((await fetch(URL + f)).ok, f);
  ok('PWA: manifest, service worker e ícones servidos');
  console.log(`\n${pass} testes passaram`); process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
