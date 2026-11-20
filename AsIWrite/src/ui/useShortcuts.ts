import { useEffect, useRef } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import type { Weather } from '../engine/types';
import { findShortcut } from './shortcuts';
import type { ToolbarModal } from './Toolbar';

interface Handlers {
  setModal: (m: ToolbarModal | null) => void;
  onFocusChat: () => void;
  setTrendOpen: (f: (v: boolean) => boolean) => void;
  setLogOpen: (f: (v: boolean) => boolean) => void;
  setTabNudge: (f: (v: { id: number; dir: number }) => { id: number; dir: number }) => void;
  setRumorFocus: (f: (v: number) => number) => void;
  modalOpen: boolean;
}

const WEATHER_CYCLE: Weather[] = ['clear', 'rain', 'snow', 'storm'];

/** Global in-game keyboard shortcuts (see ui/shortcuts.ts for the keymap). */
export function useShortcuts(game: Game, h: Handlers) {
  const ref = useRef(h);
  ref.current = h;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const H = ref.current;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (H.modalOpen || document.querySelector('[data-modal-open]')) return; // modal handles its own Esc
      const sc = findShortcut(e);
      if (!sc) return;
      e.preventDefault();
      const w = game.world;
      const run = (cmd: GameCommand) => game.toast(game.dispatch(cmd));
      const sel = w.agent(game.selectedId ?? undefined) ?? w.place(game.selectedId ?? undefined);
      const selWill = sel && sel.kind === 'person' ? sel : undefined;
      const needWill = () => game.toast({ ok: false, message: '먼저 윌을 선택해 주세요 (클릭 또는 Tab).' });

      switch (sc.id) {
        case 'chat':
          H.onFocusChat();
          break;
        case 'escape':
          if (game.editMode) game.setEditMode(false);
          else if (game.tool) game.tool = null;
          else if (game.selectedId) {
            game.camera.followId = null;
            game.select(null);
          } else H.setModal({ type: 'settings' });
          game.notify(true);
          break;
        case 'pause':
          run({ type: 'SYSTEM', action: game.paused ? 'RESUME' : 'PAUSE' });
          break;
        case 'speedHalf':
          run({ type: 'SYSTEM', action: 'SPEED', value: 0.5 });
          break;
        case 'speed1':
        case 'speed2':
        case 'speed3':
        case 'speed4':
        case 'speed5':
          // keys 1–5 → 1×, 2×, 3×, 5×, 10× (same list as Game.SPEEDS)
          run({ type: 'SYSTEM', action: 'SPEED', value: [1, 2, 3, 5, 10][Number(sc.id.slice(-1)) - 1] });
          break;
        case 'editMap':
          run({ type: 'SYSTEM', action: 'EDIT_MAP' });
          break;
        case 'skipNight':
          run({ type: 'SYSTEM', action: 'SKIP_NIGHT' });
          break;
        case 'groups':
          H.setModal({ type: 'groups' });
          break;
        case 'events':
          H.setModal({ type: 'events' });
          break;
        case 'rosterWill':
          H.setModal({ type: 'roster', kind: 'person' });
          break;
        case 'rosterAnimal':
          H.setModal({ type: 'roster', kind: 'animal' });
          break;
        case 'nextWill':
        case 'prevWill': {
          const wills = w.agents.filter((a) => a.kind === 'person').sort((a, b) => a.name.localeCompare(b.name, 'ko'));
          if (!wills.length) break;
          const i = wills.findIndex((a) => a.id === game.selectedId);
          const n = wills[(i + (sc.id === 'nextWill' ? 1 : -1) + wills.length) % wills.length];
          game.focus(n.id);
          break;
        }
        case 'follow':
          if (!game.selectedId) needWill();
          else {
            game.camera.followId = game.camera.followId === game.selectedId ? null : game.selectedId;
            game.toast({ ok: true, message: game.camera.followId ? '🎥 추적 시작' : '🎥 추적 해제' });
          }
          break;
        case 'home':
          game.camera.followId = null;
          game.centerOnTown();
          break;
        case 'tabPrev':
        case 'tabNext':
          H.setTabNudge((v) => ({ id: v.id + 1, dir: sc.id === 'tabNext' ? 1 : -1 }));
          break;
        case 'delete':
          if (sel && confirm(`${sel.name}을(를) 세상에서 지울까요?`)) run({ type: 'DELETE_ENTITY', target: { id: sel.id } });
          break;
        case 'spawnWill':
          H.setModal({ type: 'spawn', kind: 'person' });
          break;
        case 'spawnAnimal':
          H.setModal({ type: 'spawn', kind: 'animal' });
          break;
        case 'build':
          H.setModal({ type: 'spawn', kind: 'place' });
          break;
        case 'weather': {
          const next = WEATHER_CYCLE[(WEATHER_CYCLE.indexOf(w.meta.weather) + 1) % WEATHER_CYCLE.length];
          run({ type: 'SET_WEATHER', weather: next });
          break;
        }
        case 'world':
          H.setModal({ type: 'world' });
          break;
        case 'lightning':
          if (sel) run({ type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [{ id: sel.id }] });
          else {
            game.tool = {
              label: '⚡ 번개를 내릴 대상을 클릭하세요',
              build: (_x, _y, hit) => (hit ? { type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [{ id: hit.id }] } : null),
            };
            game.notify(true);
          }
          break;
        case 'meet':
          H.setModal({ type: 'meet' });
          break;
        case 'bless':
          if (selWill) run({ type: 'TRIGGER_EVENT', event: 'BLESS', targets: [{ id: selWill.id }] });
          else needWill();
          break;
        case 'gift':
          if (selWill) run({ type: 'TRIGGER_EVENT', event: 'GIFT', targets: [{ id: selWill.id }] });
          else needWill();
          break;
        case 'rumor':
          H.setTrendOpen(() => true);
          H.setRumorFocus((v) => v + 1);
          break;
        case 'research':
          H.setModal({ type: 'research' });
          break;
        case 'trends':
          H.setTrendOpen((v) => !v);
          break;
        case 'log':
          H.setLogOpen((v) => !v);
          break;
        case 'names':
          if (game.renderer) {
            game.renderer.showNames = !game.renderer.showNames;
            game.toast({ ok: true, message: game.renderer.showNames ? '이름표 보이기' : '이름표 숨기기' });
          }
          break;
        case 'help':
          H.setModal({ type: 'help' });
          break;
        case 'save':
          run({ type: 'SYSTEM', action: 'SAVE' });
          break;
        case 'undo':
          game.toast(game.undo());
          break;
        case 'load':
          H.setModal({ type: 'load' });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [game]);
}
