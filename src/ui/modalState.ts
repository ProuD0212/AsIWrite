// How many dialogs are open right now (every <Modal> counts itself), and the player's
// "pause while a window is open" preference. The game loop asks `shouldHoldTime()`.

export const modalState = { open: 0 };

const KEY = 'asiwrite.pauseOnModal';

export function pauseOnModalSetting(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'; // default: on
  } catch {
    return true;
  }
}
export function setPauseOnModal(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function shouldHoldTime(): boolean {
  return modalState.open > 0 && pauseOnModalSetting();
}
