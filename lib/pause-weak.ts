// Какие объявления выключить (скрипт /api/pause-weak).
// Обувь и пост «куртки» не выключаем — только слабые «−30% утепляйся».
// Основание — выгрузка Ads Manager за 1–15 октября: связки «город + креатив» с ценой результата
// заметно хуже лучшего креатива в этом же городе (расход от $15).

export type WeakRule = {
  /** Начало названия кампании */
  campaign: string;
  /** Креатив: "обувь-1" | "утепляйся-ru" | "утепляйся-kz" */
  creative: "обувь-1" | "обувь-2" | "утепляйся-ru" | "утепляйся-kz" | "пост-куртки";
  why: string;
};

export const weakRules: WeakRule[] = [
  { campaign: "KAR_LEAD", creative: "утепляйся-kz", why: "Караганда: $0,95 за результат, CTR 1,0% (лучший в городе — обувь 2, $0,47)" },
  { campaign: "ALMATY_LEAD_5KM", creative: "утепляйся-kz", why: "Алматы: $1,25 за результат (утепляйся RU — $0,97)" },
  { campaign: "PETR_LEAD", creative: "утепляйся-ru", why: "Петропавловск: $1,23 за результат (обувь 2 — $0,44)" },
  { campaign: "AKTAU_LEAD", creative: "утепляйся-ru", why: "Актау: $1,01 за результат (пост и обувь 2 — $0,49–0,50)" },
];

const isKz = (n: string) => /(^|[\s\-_])kz($|[\s\-_])/i.test(n);
export function creativeOf(adName: string): WeakRule["creative"] | null {
  const n = adName.toLowerCase();
  if (n.includes("пост-куртки")) return "пост-куртки";
  if (n.includes("обувь-1")) return "обувь-1";
  if (n.includes("обувь-2")) return "обувь-2";
  if (n.includes("утепляйся")) return isKz(n) ? "утепляйся-kz" : "утепляйся-ru";
  return null;
}
