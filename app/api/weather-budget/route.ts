import { NextResponse } from "next/server";
import {
  BOOST_ON_PRECIPITATION,
  BOOST_PERCENT,
  MAX_BOOST_PERCENT,
  RAIN_MM_THRESHOLD,
  SNOW_CM_THRESHOLD,
  TEMPERATURE_METRIC,
  weatherCities,
  baseFor,
  type WeatherCity,
} from "@/lib/weather-budget";

// Скрипт вызывается по расписанию из vercel.json (Vercel Cron).
// Смотрит прогноз на сегодня: если в городе холодно (температура не выше порога города),
// ставит повышенный бюджет, иначе обычный. Считает всегда от обычного бюджета, без накопления.
//
// Переменные окружения (Vercel → Settings → Environment Variables):
//   CRON_SECRET            — пароль на запуск; Vercel сам подставляет его в вызов по расписанию
//   META_ACCESS_TOKEN      — токен системного пользователя Meta с правом ads_management
//   WEATHER_DRY_RUN        — пока не равно "false", скрипт ничего не меняет, только пишет отчёт
//   META_API_VERSION       — версия Graph API, по умолчанию v23.0
//   META_CURRENCY_OFFSET   — множитель минимальных единиц валюты, по умолчанию 100

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Forecast = { temp: number; tMax: number; tMin: number; tMean: number; rainMm: number; snowCm: number; cold: boolean; wet: boolean; boost: boolean };

async function getForecast(city: WeatherCity): Promise<Forecast> {
  const url =
    `${process.env.WEATHER_API_URL || "https://api.open-meteo.com"}/v1/forecast?latitude=${city.latitude}&longitude=${city.longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,snowfall_sum&timezone=auto&forecast_days=1`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Open-Meteo ответил ${res.status}`);
  const data = await res.json();
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const tMax = num(data?.daily?.temperature_2m_max?.[0]);
  const tMin = num(data?.daily?.temperature_2m_min?.[0]);
  const tMeanRaw = num(data?.daily?.temperature_2m_mean?.[0]);
  const tMean = Number.isNaN(tMeanRaw) ? (tMax + tMin) / 2 : tMeanRaw;
  const temp = TEMPERATURE_METRIC === "max" ? tMax : TEMPERATURE_METRIC === "min" ? tMin : tMean;
  // Без температуры решение не принимаем: лучше оставить бюджет как есть, чем поднять по ошибке
  if (Number.isNaN(temp)) throw new Error("в прогнозе нет температуры");
  const rainMm = Number(data?.daily?.precipitation_sum?.[0] ?? 0);
  const snowCm = Number(data?.daily?.snowfall_sum?.[0] ?? 0);
  const cold = temp <= city.coldAt;
  const wet = rainMm >= RAIN_MM_THRESHOLD || snowCm >= SNOW_CM_THRESHOLD;
  return { temp, tMax, tMin, tMean, rainMm, snowCm, cold, wet, boost: cold || (BOOST_ON_PRECIPITATION && wet) };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.META_ACCESS_TOKEN;
  const dryRun = process.env.WEATHER_DRY_RUN !== "false";
  const version = process.env.META_API_VERSION || "v23.0";
  const offset = Number(process.env.META_CURRENCY_OFFSET || 100);
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;

  const report: Record<string, unknown>[] = [];
  const todayAlmaty = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);

  if (!(BOOST_PERCENT > 0 && BOOST_PERCENT <= MAX_BOOST_PERCENT)) {
    const result = { dryRun, error: `BOOST_PERCENT должен быть от 1 до ${MAX_BOOST_PERCENT}`, report };
    console.log(JSON.stringify(result));
    return NextResponse.json(result, { status: 500 });
  }

  for (const city of weatherCities) {
    const targets = [
      ...city.adSets.map((t) => ({ ...t, level: "группа объявлений" })),
      ...city.campaigns.map((t) => ({ ...t, level: "кампания" })),
    ];
    if (targets.length === 0) continue;

    let forecast: Forecast;
    try {
      forecast = await getForecast(city);
    } catch (e) {
      // Нет прогноза — бюджет не трогаем
      report.push({ city: city.name, skipped: `нет прогноза: ${(e as Error).message}` });
      continue;
    }

    for (const t of targets) {
      const row: Record<string, unknown> = {
        city: city.name,
        level: t.level,
        id: t.id,
        note: t.note,
        temp: forecast.temp,
        coldAt: city.coldAt,
        tMax: forecast.tMax,
        tMin: forecast.tMin,
        rainMm: forecast.rainMm,
        snowCm: forecast.snowCm,
        mode: forecast.boost ? "повышенный" : "обычный",
      };
      const { base, period } = baseFor(t, todayAlmaty);
      row.base = base;
      if (period) row.period = period;
      if (!(base > 0)) {
        report.push({ ...row, skipped: "не задан обычный бюджет (base)" });
        continue;
      }
      // Целевой бюджет в минимальных единицах валюты (центах)
      const targetMinor = Math.round(base * offset * (forecast.boost ? 1 + BOOST_PERCENT / 100 : 1));
      row.targetBudget = targetMinor / offset;
      if (!token) {
        report.push({ ...row, skipped: "нет META_ACCESS_TOKEN" });
        continue;
      }
      try {
        const cur = await fetch(
          `${graph}/${t.id}?fields=name,daily_budget&access_token=${encodeURIComponent(token)}`,
          { cache: "no-store" },
        ).then((r) => r.json());
        if (cur.error) throw new Error(cur.error.message);
        row.name = cur.name;
        if (cur.daily_budget === undefined) {
          report.push({ ...row, skipped: "нет дневного бюджета: он задан на другом уровне (кампания или группа) либо это бюджет на весь срок" });
          continue;
        }
        row.currentBudget = Number(cur.daily_budget) / offset;
        if (Number(cur.daily_budget) === targetMinor) {
          report.push({ ...row, action: "без изменений" });
        } else if (dryRun) {
          report.push({ ...row, action: "тестовый режим: изменил бы" });
        } else {
          const body = new URLSearchParams({ daily_budget: String(targetMinor), access_token: token });
          const upd = await fetch(`${graph}/${t.id}`, { method: "POST", body }).then((r) => r.json());
          if (upd.error) throw new Error(upd.error.message);
          report.push({ ...row, action: "бюджет изменён" });
        }
      } catch (e) {
        report.push({ ...row, error: (e as Error).message });
      }
    }
  }

  const result = { dryRun, checkedAt: new Date().toISOString(), rule: `бюджет +${BOOST_PERCENT}% при температуре (${TEMPERATURE_METRIC}) не выше порога города`, report };
  console.log(JSON.stringify(result));
  return NextResponse.json(result);
}
