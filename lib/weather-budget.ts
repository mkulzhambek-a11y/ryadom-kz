// Настройки «погодного» бюджета рекламы Meta.
//
// Правило: если температура в городе в этот день не выше порога города (coldAt),
// дневной бюджет ставится на 120% от обычного (base). Если теплее — ровно base.
// Повышение не накапливается: скрипт каждый раз считает от base, а не от текущего бюджета.
//
// У каждого города два списка:
//   adSets    — группы объявлений, у которых дневной бюджет задан на уровне группы;
//   campaigns — кампании, у которых дневной бюджет задан на уровне кампании.
// Для каждого ID указан обычный дневной бюджет (base) в валюте рекламного аккаунта, то есть в долларах.
// Города с пустыми списками пропускаются.

export type Target = {
  /** ID группы объявлений или кампании, строкой */
  id: string;
  /** Обычный дневной бюджет в валюте аккаунта */
  base: number;
  /** Подпись для журнала, на работу не влияет */
  note?: string;
  /** Временный бюджет на период (даты по Алматы, включительно). В эти дни вместо base берётся base периода. */
  periods?: { from: string; to: string; base: number; note?: string }[];
};

/** Обычный бюджет на дату с учётом временных периодов */
export function baseFor(t: Target, day: string): { base: number; period?: string } {
  const p = t.periods?.find((x) => x.from <= day && day <= x.to);
  return p ? { base: p.base, period: `${p.from}…${p.to}${p.note ? ` (${p.note})` : ""}` } : { base: t.base };
}

// Октябрьское перераспределение 1,5 млн ₸ (≈ $3 559) с 14 октября (17 дней по плану + сегодня), курс ≈ 429 ₸/$
// С 16 октября — пересмотр под магазины, которые проседают по продажам (тот же общий бюджет в день).
const OCT = (base14: number, note14: string, base17: number, note17: string) => [
  { from: "2026-10-14", to: "2026-10-15", base: base14, note: note14 },
  { from: "2026-10-16", to: "2026-10-31", base: base17, note: note17 },
];

export type WeatherCity = {
  name: string;
  latitude: number;
  longitude: number;
  /** Температурный порог, °C: при этой температуре и ниже бюджет повышается */
  coldAt: number;
  adSets: Target[];
  campaigns: Target[];
};

/** На сколько процентов повышать бюджет в холодный день. Скрипт не примет значение больше MAX_BOOST_PERCENT. */
export const BOOST_PERCENT = 20;
export const MAX_BOOST_PERCENT = 50;

/**
 * Какую температуру дня сравнивать с порогом:
 *   "max"  — дневной максимум (самое тёплое время дня не теплее порога);
 *   "mean" — среднюю за сутки;
 *   "min"  — ночной минимум.
 */
export const TEMPERATURE_METRIC: "max" | "mean" | "min" = "max";

/** Повышать ли бюджет ещё и в дождь или снег, даже если тепло. Сейчас выключено: решает только температура. */
export const BOOST_ON_PRECIPITATION = false;
/** Сколько миллиметров осадков за день считать дождливым днём (работает при BOOST_ON_PRECIPITATION = true) */
export const RAIN_MM_THRESHOLD = 1;
/** Сколько сантиметров снега за день считать снежным днём (работает при BOOST_ON_PRECIPITATION = true) */
export const SNOW_CM_THRESHOLD = 0.1;

export const weatherCities: WeatherCity[] = [
  { name: "Алматы", latitude: 43.2389, longitude: 76.8897, coldAt: 12, adSets: [], campaigns: [{ id: "52591545249708", base: 180, note: "ALMATY_LEAD_5KM", periods: OCT(256, "+$76: Mega, Dostyk Plaza, Forum", 240, "Forum, ADK, Aport East, Mega Park — приоритет") }] },
  { name: "Астана", latitude: 51.1694, longitude: 71.4491, coldAt: 10, adSets: [], campaigns: [{ id: "52591532135508", base: 100, note: "AST_LEAD", periods: OCT(148, "+$48 на Mega Silk Way", 165, "Mega Silk Way и Хан Шатыр поровну") }] },
  { name: "Шымкент", latitude: 42.3417, longitude: 69.5901, coldAt: 12, adSets: [], campaigns: [{ id: "52591169995908", base: 15, note: "SHYM_LEAD", periods: OCT(36, "+$21 Shymkent Plaza", 25, "план выполняется — часть бюджета на отстающих") }] },
  { name: "Караганда", latitude: 49.8047, longitude: 73.1094, coldAt: 10, adSets: [], campaigns: [{ id: "52591529088708", base: 20, note: "KAR_LEAD", periods: OCT(51, "+$31: Global City +21, ЦУМ +10", 51, "приоритет ЦУМ") }] },
  { name: "Атырау", latitude: 47.0945, longitude: 51.9238, coldAt: 12, adSets: [], campaigns: [{ id: "52591191799308", base: 15, note: "ATYRAU_LEAD", periods: OCT(24, "резерв +$9 Infinity", 20, "часть бюджета на отстающих") }] },
  { name: "Актау", latitude: 43.6532, longitude: 51.1975, coldAt: 12, adSets: [], campaigns: [{ id: "52591191071908", base: 15, note: "AKTAU_LEAD", periods: OCT(24, "резерв +$9 Saya Park", 20, "часть бюджета на отстающих") }] },
  { name: "Усть-Каменогорск", latitude: 49.9483, longitude: 82.6275, coldAt: 10, adSets: [], campaigns: [{ id: "52591217076308", base: 15, note: "OSKEMEN_LEAD" }] },
  { name: "Петропавловск", latitude: 54.8753, longitude: 69.1628, coldAt: 10, adSets: [], campaigns: [{ id: "52591189143108", base: 15, note: "PETR_LEAD", periods: OCT(31, "+$16 Dostyq Mall", 40, "Dostyq Mall проседает") }] },
  { name: "Уральск", latitude: 51.2333, longitude: 51.3667, coldAt: 10, adSets: [], campaigns: [{ id: "52591187768508", base: 10, note: "ORAL_LEAD", periods: [{ from: "2026-10-16", to: "2026-10-31", base: 20, note: "Уральск проседает" }] }] },
];
