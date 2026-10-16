// Перераспределение бюджета по магазинам (скрипт /api/budget-plan).
//
// Бюджеты кампаний на этот период уже прописаны в lib/weather-budget.ts (periods),
// их ставит скрипт погоды каждое утро, с +20% в холодные дни.
//
// Этот скрипт нужен для городов, где в одной кампании несколько магазинов (Алматы, Астана, Караганда):
// иначе Meta сама решит, на какой магазин тратить прибавку. Он ставит группе нужного магазина
// минимальный расход в день = её средний расход за базовую неделю + прибавка.
// После окончания периода минимумы снимаются.

export const budgetPlan = {
  from: "2026-10-14",
  to: "2026-10-31",

  // Неделя, по которой считается обычный расход магазина до прибавки
  baselineFrom: "2026-10-08",
  baselineTo: "2026-10-13",

  // Минимальный расход в день по магазину, $.
  // С 16 октября — фиксированные минимумы для магазинов, которые проседают по продажам.
  // extraUsd — «средний расход за базовую неделю + прибавка», minUsd — ровно столько.
  stores: [
    // Алматы, бюджет $240
    { store: "almaty-forum", minUsd: 30, note: "Forum — проседает" },
    { store: "almaty-adk", minUsd: 25, note: "ADK — проседает" },
    { store: "almaty-aport-east", minUsd: 25, note: "Aport East — проседает" },
    { store: "almaty-mega-park", minUsd: 25, note: "Mega Park — проседает" },
    { store: "almaty-mega", minUsd: 50, note: "Mega Alma-Ata — план выполняется, минимум ниже" },
    { store: "almaty-dostyk-plaza", minUsd: 20, note: "Dostyk Plaza — план выполняется, минимум ниже" },
    // Астана, бюджет $165
    { store: "astana-mega-silk-way", minUsd: 60, note: "Mega Silk Way — проседает" },
    { store: "astana-khan-shatyr", minUsd: 60, note: "Хан Шатыр — проседает" },
    // Караганда, бюджет $51
    { store: "karaganda-tsum", minUsd: 22, note: "ЦУМ — проседает" },
    { store: "karaganda-global-city", minUsd: 18, note: "Global City" },
  ] as { store: string; minUsd?: number; extraUsd?: number; note: string }[],

  // Сумма минимумов в кампании не больше этой доли её бюджета — чтобы остальным магазинам тоже оставалось
  maxShareOfCampaign: 0.8,
};
