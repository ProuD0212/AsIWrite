// What a conversation line is FOR, in words the storyteller can follow.
//
// The template ("저도 그거 진짜 좋아해요!") is only a skeleton. Sending the intent alongside it
// ("상대가 말한 고양이를 자기도 좋아한다며 반가워한다") lets a capable model (Gemini) reword
// freely — answer what was actually said, vary the phrasing — without losing the line's purpose.

import type { ConvoAct } from '../engine/World';

type Act = Omit<ConvoAct, 'by'> | undefined;
const o = (a: Act, fallback = '그것') => (a?.obj ? `'${a.obj}'` : fallback);

/** the line answers this (what the other person just said) */
function answering(a: Act, nameOf: (id: string) => string): string | null {
  if (!a) return null;
  switch (a.kind) {
    case 'greet': return a.ask ? '상대의 인사와 질문에 대답한다' : '상대의 인사를 받는다';
    case 'askBack': return '상대가 되물은 말에 대답한다';
    case 'like': return `상대가 좋아한다고 한 ${o(a)} 이야기에 반응한다`;
    case 'dislike': return `상대가 싫다고 한 ${o(a)} 이야기에 반응한다`;
    case 'dream': return `상대가 말한 꿈(${o(a)})을 듣고 반응한다`;
    case 'shared': return '취향이 같다며 반가워하는 상대에게 맞장구친다';
    case 'differ': return '취향이 다르다는 상대의 말에 반응한다';
    case 'askLike': return '"무엇을 좋아하냐"는 질문에 대답한다';
    case 'askWhy': return `"${a.obj ?? '그걸'} 왜 좋아하냐"는 질문에 대답한다`;
    case 'askWhyNot': return '"왜 싫어하냐"는 질문에 대답한다';
    case 'explained': return '상대가 좋아하게 된 이유를 듣고 반응한다';
    case 'cheered': return '응원해 준 상대에게 답한다';
    case 'comfort': return '위로해 주는 상대에게 답한다';
    case 'comforted': return '고마워하는 상대에게 답한다';
    case 'sad': return '힘들다고 털어놓은 상대에게 반응한다';
    case 'askSad': return '"무슨 일 있냐"는 걱정 어린 질문에 대답한다';
    case 'comfortNeeded': return '힘든 이야기를 꺼낸 상대에게 반응한다';
    case 'rumor': return '상대가 전해 준 소문에 반응한다';
    case 'secret': return '상대가 비밀로 털어놓은 짝사랑 이야기에 반응한다(비밀을 지켜 주겠다는 마음)';
    case 'monologue': return '상대가 길게 털어놓은 속마음에 다정하게 반응한다';
    case 'treasure': return '상대가 보여 준 소중한 물건 이야기에 반응한다';
    case 'gossipGood': return `자리에 없는 ${a.about?.map(nameOf).join(', ') || '사람'}을(를) 칭찬하는 상대의 말에 반응한다`;
    case 'gossipBad': return `자리에 없는 ${a.about?.map(nameOf).join(', ') || '사람'} 험담에 반응한다`;
    case 'recall': return `지난번에 나눈 ${o(a)} 이야기를 다시 꺼낸 상대에게 반응한다`;
    case 'happy': return '기분이 좋다는 상대에게 반응한다';
    case 'muse': return `상대가 들려준 자기 이야기(${o(a)})에 반응한다`;
    case 'birthdayWish': return '생일 축하를 받고 고마워한다';
    case 'birthdayNews': return '오늘이 생일이라는 상대를 축하한다';
  }
  return null;
}

/** the line itself does this */
function doing(a: Act, nameOf: (id: string) => string): string | null {
  if (!a) return null;
  switch (a.kind) {
    case 'greet': return a.ask ? '인사하며 안부를 묻는다' : '인사한다';
    case 'askBack': return '되묻는다';
    case 'like': return `자기가 좋아하는 ${o(a)} 이야기를 꺼낸다`;
    case 'dislike': return `자기가 싫어하는 ${o(a)}에 대해 솔직하게 말한다`;
    case 'dream': return `자기 꿈(${o(a)})을 말한다`;
    case 'shared': return '자기도 같은 걸 좋아한다며 반가워한다';
    case 'differ': return '자기는 취향이 다르다고 솔직하게, 하지만 무례하지 않게 말한다';
    case 'askLike': return '상대가 무엇을 좋아하는지 묻는다';
    case 'askWhy': return `상대가 ${o(a, '그걸')} 왜 좋아하는지 묻는다`;
    case 'askWhyNot': return '왜 싫은지 조심스럽게 묻는다';
    case 'explained': return '좋아하게 된 이유를 말한다';
    case 'cheered': return '상대를 응원한다';
    case 'comfort': return '기운 없어 보이는 상대를 위로한다';
    case 'comforted': return '위로받아 고마운 마음을 전한다';
    case 'sad': return '요즘 힘든 마음을 털어놓는다';
    case 'askSad': return '안색이 안 좋은 상대를 걱정하며 묻는다';
    case 'comfortNeeded': return '힘든 이야기를 꺼낸다';
    case 'rumor': return '들은 소문을 전한다(소문 내용은 그대로)';
    case 'secret': return '친한 친구에게만 짝사랑을 비밀로 털어놓는다';
    case 'monologue': return '속마음을 길게 털어놓는다';
    case 'treasure': return '자기 애착 물건 이야기를 한다';
    case 'gossipGood': return `자리에 없는 ${a.about?.map(nameOf).join(', ') || '사람'}을(를) 칭찬한다`;
    case 'gossipBad': return `자리에 없는 ${a.about?.map(nameOf).join(', ') || '사람'}에 대한 불만을 털어놓는다`;
    case 'recall': return `지난번에 나눈 ${o(a)} 이야기를 다시 꺼낸다`;
    case 'happy': return '요즘 기분이 좋다고 말한다';
    case 'muse': return `자기 이야기(${o(a)})를 들려준다`;
    case 'birthdayWish': return '상대의 생일을 축하한다';
    case 'birthdayNews': return '오늘이 자기 생일이라고 수줍게 알린다';
  }
  return null;
}

/** "상대의 질문에 대답한다 → 그리고 자기가 좋아하는 '고양이' 이야기를 꺼낸다" (or null when unknown) */
export function describeIntent(answered: Act, act: Act, nameOf: (id: string) => string, opener: boolean): string | null {
  const a = answering(answered, nameOf);
  const d = doing(act, nameOf);
  if (a && d) return `${a}. 그러면서 ${d}`;
  if (a) return a;
  if (d) return opener ? `대화를 시작하며 ${d}` : d;
  return opener ? '대화를 시작한다' : null;
}
