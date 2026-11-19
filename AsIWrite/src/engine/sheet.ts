// Structured Text Sheet ("텍스트 양식") parser / serializer.
//
// [이름]
// [분류] 윌
// [외형]
// [성향 및 특성]
// -
// [초기 무드] 95

import { speciesFromText } from "./appearance";
import type { AgentKind } from "./types";

export interface CharacterSheet {
  name: string;
  category: string;
  appearance: string;
  traits: string[];
  mood: number;
  job?: string;
  treasure?: string; // 애착 물건
}

export interface SheetParseResult {
  sheet: CharacterSheet;
  kind: AgentKind;
  warnings: string[];
}

const FIELD = /^\s*\[(.+?)\]\s*(.*)$/;

export function parseSheet(text: string): SheetParseResult {
  const warnings: string[] = [];
  const sheet: CharacterSheet = {
    name: "",
    category: "윌",
    appearance: "",
    traits: [],
    mood: 60,
  };
  let current: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(FIELD);
    if (m) {
      const key = m[1].replace(/\s/g, "");
      const val = m[2].trim();
      current = key;
      if (key === "이름" || key === "name") sheet.name = val;
      else if (key === "분류" || key === "종류") sheet.category = val || "윌";
      else if (key === "외형" || key === "외모") sheet.appearance = val;
      else if (key === "직업" || key === "역할" || key === "job") sheet.job = val;
      else if (key.startsWith("애착") || key === "보물" || key === "소중한물건") sheet.treasure = val;
      else if (key.startsWith("초기무드") || key === "무드") {
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) sheet.mood = Math.max(0, Math.min(100, n));
        else warnings.push("초기 무드는 0~100 사이 숫자여야 해요.");
      } else if (key.startsWith("성향") || key.startsWith("특성")) {
        if (val) sheet.traits.push(val.replace(/^[-•*]\s*/, ""));
      } else warnings.push(`알 수 없는 항목: [${m[1]}]`);
      continue;
    }
    // continuation lines
    if (current && (current.startsWith("성향") || current.startsWith("특성"))) {
      const t = line.replace(/^[-•*·]\s*/, "").trim();
      if (t) sheet.traits.push(t);
    } else if (current === "외형" || current === "외모") {
      sheet.appearance += (sheet.appearance ? ", " : "") + line;
    }
  }

  if (!sheet.name) {
    warnings.push("[이름]이 비어 있어요.");
    sheet.name = "이름 없는 존재";
  }
  if (sheet.traits.length === 0)
    warnings.push("[성향 및 특성]이 하나도 없어요.");

  const kind: AgentKind = /^(윌|will|사람|인간|person|human|주민)/i.test(sheet.category)
    ? "person"
    : speciesFromText(sheet.category)
      ? "animal"
      : /(동물|짐승|animal|생물|몬스터|용|드래곤)/i.test(sheet.category)
        ? "animal"
        : "person";
  return { sheet, kind, warnings };
}

export function serializeSheet(s: CharacterSheet): string {
  return [
    `[이름] ${s.name}`,
    `[분류] ${s.category}`,
    `[외형] ${s.appearance}`,
    ...(s.job ? [`[직업] ${s.job}`] : []),
    ...(s.treasure ? [`[애착 물건] ${s.treasure}`] : []),
    `[성향 및 특성]`,
    ...s.traits.map((t) => `- ${t}`),
    `[초기 무드] ${Math.round(s.mood)}`,
  ].join("\n");
}
