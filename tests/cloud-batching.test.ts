// fake browser bits + a fake Gemini, then the real storyteller
const store: Record<string, string> = { 'asiwrite.storyBackend': 'auto', 'asiwrite.apiProvider': 'gemini', 'asiwrite.apiKey': 'TESTKEY123456' };
(globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v), removeItem: (k: string) => delete store[k] };
(globalThis as any).location = { hostname: 'localhost' };
let gen = 0, list = 0, rate429 = false, dailyFor = '';
const used: string[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  if (/\/models\?key=/.test(url)) {
    list++;
    return new Response(JSON.stringify({ models: [{ name: 'models/gemini-9.9-pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-9.9-flash-lite', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
  }
  if (/generateContent/.test(url)) {
    gen++;
    used.push(url.match(/models\/([^:]+)/)?.[1] ?? '?');
    if (dailyFor && url.includes(dailyFor)) return new Response(JSON.stringify({ error: { message: 'Quota exceeded, quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }), { status: 429 });
    if (rate429) return new Response('{}', { status: 429 });
    const body = JSON.parse(init.body);
    const user = body.contents.at(-1).parts[0].text as string;
    const drafts = [...user.matchAll(/\[초안\] (.+)/g)].map((m) => m[1]);
    const out = drafts.length > 1 ? JSON.stringify(drafts.map((d) => d.replace(/요!$/, '요, 정말로요!'))) : drafts[0].replace(/요!$/, '요, 정말로요!');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('nope', { status: 404 });
};
const { storyteller } = await import('../src/ai/storyteller');
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));
storyteller.start();
ok(storyteller.state === 'ready' && storyteller.backend() === 'gemini', `cloud backend ready: ${storyteller.label()}`);
const done: string[] = [];
const names = ['영희', '철수', '민수', '하늘', '서연', '지호', '도윤', '보람', '가온', '노을'];
for (let i = 0; i < 10; i++) {
  const draft = `${names[i]} 씨, 오늘 날씨 좋네요!`;
  storyteller.enqueue({ key: `l${i}`, kind: 'line', messages: [{ role: 'system', content: '규칙' }, { role: 'user', content: `[화자] 누구\n[말투] 존댓말\n[초안] ${draft}\n다듬은 대사:` }], maxTokens: 60, ttl: 30000, priority: 0, draft, register: 'polite', names: [names[i]], onDone: (t) => done.push(t), onFail: () => done.push('FAIL') });
}
await new Promise((r) => setTimeout(r, 900));
ok(done.length === 10 && done.every((t) => /정말로요/.test(t)), `10 lines done: ${done.filter((t) => t !== 'FAIL').length} rewritten (e.g. "${done[3]}")`);
ok(gen <= 3, `…in ${gen} requests (8 per request), model picked from the list once (${list} list call): ${storyteller.label()}`);
ok(done.every((t, i) => t.includes(names[i]) || t === 'FAIL'), 'each rewrite went back to its own line');
// rate limited → back off, capacity drops
rate429 = true;
storyteller.enqueue({ key: 'x', kind: 'line', messages: [{ role: 'user', content: '[초안] 안녕하세요!' }], maxTokens: 60, ttl: 30000, priority: 0, draft: '안녕하세요!', onDone: () => {}, onFail: () => {} });
await new Promise((r) => setTimeout(r, 900)); // a lone line waits ~0.5 s for company first
ok(storyteller.capacity() < 0.5 && /429/.test(storyteller.label()), `429 → backs off (capacity ${storyteller.capacity()}, label "${storyteller.label()}")`);
// daily quota on the first model -> the next model takes over
rate429 = false;
(storyteller as any).cloudPauseUntil = 0; (storyteller as any).cloudSent = []; (storyteller as any).cloudPace.gemini = 6;
dailyFor = 'flash-lite';
const got: string[] = [];
const line = (k: string, who: string) => storyteller.enqueue({ key: k, kind: 'line', messages: [{ role: 'user', content: '[초안] ' + who + ' 씨, 안녕하세요!' }], maxTokens: 60, ttl: 30000, priority: 0, draft: who + ' 씨, 안녕하세요!', register: 'polite', names: [who], onDone: (t) => got.push(t), onFail: () => got.push('FAIL') });
line('d1', '민수');
await new Promise((r) => setTimeout(r, 900));
const afterSwitch = storyteller.label();
(storyteller as any).cloudPauseUntil = 0; (storyteller as any).cloudSent = []; (storyteller as any).cloudPace.gemini = 6;
line('d2', '철수');
await new Promise((r) => setTimeout(r, 900));
ok(/gemini-9.9-pro/.test(afterSwitch) && got.at(-1) !== 'FAIL' && used.at(-1) === 'gemini-9.9-pro', 'daily quota -> next model: "' + afterSwitch + '" then ' + used.slice(-2).join(' -> ') + ' (' + got.join(' | ') + ')');
ok(/오늘 요청 \d+회/.test(storyteller.label()), 'usage shown: ' + storyteller.label());
console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(0);
