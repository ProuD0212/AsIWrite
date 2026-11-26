import { useEffect, useState } from 'react';
import { relayStats } from '../ai/relayHost';

type Status = { on: boolean; port?: number; urls?: string[]; error?: string };

/**
 * 🌐 다른 PC에서 접속 (임시) — asks the local dev/preview server (lanShare.ts) to open a LAN port.
 * Each PC runs its own world in its own browser; this only serves the game.
 */
export function SharePanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState('');
  const call = async (path = '', method = 'GET') => {
    setBusy(true);
    try {
      const r = await fetch(`/__share${path}`, { method });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(String(r.status));
      setSt(await r.json());
      setMissing(false);
    } catch {
      setMissing(true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void call();
  }, []);
  const remote = typeof location !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return (
    <div className="grid gap-2 rounded-lg border border-white/10 p-3 text-xs">
      <div className="font-semibold text-parch">🌐 다른 PC에서 접속 (임시 서버)</div>
      {remote ? (
        <p className="text-parch-dim">지금 다른 PC에서 접속해 있어요. 서버는 게임을 띄운 PC에서만 켜고 끌 수 있어요.</p>
      ) : missing ? (
        <p className="text-parch-dim">이 실행 방식에서는 쓸 수 없어요 — 게임 폴더에서 <code>npm run dev</code>(또는 <code>npm run build</code> 후 <code>npm run preview</code>)로 실행했을 때만 켤 수 있어요.</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => void call(st?.on ? '/stop' : '/start', 'POST')}
              className={`rounded-md px-3 py-1 font-semibold disabled:opacity-50 ${st?.on ? 'bg-rose-400/25 text-rose-100 hover:bg-rose-400/40' : 'bg-emerald-400/25 text-emerald-100 hover:bg-emerald-400/40'}`}
            >
              {busy ? '…' : st?.on ? '■ 서버 끄기' : '▶ 서버 켜기'}
            </button>
            <span className="text-parch-dim">{st?.on ? `켜짐 · 포트 ${st.port}` : '꺼짐 — 켜기 전에는 이 PC에서만 열려요'}</span>
          </div>
          {st?.error && <p className="text-rose-200">켜지 못했어요: {st.error}</p>}
          {st?.on && (
            <>
              <p className="text-parch-dim">같은 Wi-Fi(공유기)에 연결된 PC·태블릿의 브라우저 주소창에 입력하세요:</p>
              {(st.urls ?? []).length === 0 && <p className="text-amber-200">네트워크 주소를 찾지 못했어요. Wi-Fi/랜 연결을 확인해 주세요.</p>}
              {(st.urls ?? []).length > 0 && !(st.urls ?? []).some((u) => /\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(u)) && (
                <p className="rounded bg-amber-400/15 px-2 py-1 text-amber-100">⚠️ 이 PC는 공유기 안쪽 주소가 아니라 인터넷 주소로 연결돼 있어요. 방화벽이 막지 않으면 같은 Wi-Fi가 아닌 사람도 접속할 수 있으니, 필요한 동안만 짧게 켜 두세요.</p>
              )}
              {(st.urls ?? []).map((u, i) => (
                <div key={u} className="flex items-center gap-2">
                  <code className={`rounded bg-black/40 px-2 py-0.5 ${i === 0 ? 'text-glow' : 'text-parch-dim'}`}>{u}</code>
                  <button
                    className="text-parch-dim hover:text-parch"
                    onClick={() => {
                      void navigator.clipboard?.writeText(u);
                      setCopied(u);
                    }}
                  >
                    {copied === u ? '✓ 복사됨' : '복사'}
                  </button>
                </div>
              ))}
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-parch-dim">
                <li>다른 PC의 AI(이야기꾼·의미 모델)는 <b>이 PC가</b> 계산해요 — 이 탭을 닫지 말고, 이 탭에서 이야기꾼을 켜 두세요. 다른 창 뒤에 있어도 돼요. (지금까지 처리 {relayStats.served}건)</li>
                <li>처음 켤 때 Windows 방화벽 창이 뜨면 「개인 네트워크」 허용을 눌러 주세요.</li>
                <li>접속한 PC마다 각자의 세계가 따로 돌아가요(저장도 각 브라우저에).</li>
                <li>다른 PC는 보안 연결(https)이 아니라서 브라우저가 GPU(WebGPU)를 막을 수 있어요 — 그러면 이야기꾼이 더 작은 모델(CPU)로 자동 전환되거나 꺼져요.</li>
                <li>임시 기능이에요. 다 쓰면 끄거나 게임 서버를 닫으면 같이 닫혀요.</li>
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
