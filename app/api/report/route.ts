import { adCities } from "@/lib/store-addresses";

// Отчёт по рекламе Meta и событиям сайта по городам.
// Открывается в браузере: https://<проект>.vercel.app/api/report?key=<REPORT_KEY>
// Период по умолчанию — с 1-го числа текущего месяца по сегодня. Можно задать: &from=2026-10-01&to=2026-10-31
// &format=csv — скачать таблицу по дням для Excel.
//
// Откуда цифры:
//   расход, показы, клики по ссылке — статистика кампаний Meta (по городу кампании);
//   WhatsApp, 2ГИС, Kaspi — события пикселя на сайте (WhatsApp_…, Gis_…, Kaspi_…) по дням.
//   События пикселя — все посетители сайта, а не только пришедшие из рекламы.
//
// Переменные окружения: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID (уже есть),
//   REPORT_KEY — пароль для открытия отчёта, META_PIXEL_ID — по умолчанию 1599079054414806.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Json = Record<string, any>;
// только кампании LEAD, ведущие на сайт
type Row = { msgs: number; spend: number; impressions: number; linkClicks: number; wa: number; gis: number; kaspi: number };
const empty = (): Row => ({ msgs: 0, spend: 0, impressions: 0, linkClicks: 0, wa: 0, gis: 0, kaspi: 0 });

const TZ_OFFSET_H = 5; // Алматы/Астана, UTC+5
const CITY_BY_CAMPAIGN: [RegExp, string][] = [
  [/^almaty/i, "almaty"],
  [/^(astana|ast[_\s-])/i, "astana"],
  [/^shym/i, "shymkent"],
  [/^kar/i, "karaganda"],
  [/^atyrau/i, "atyrau"],
  [/^aktau/i, "aktau"],
  [/^(oskemen|ust)/i, "ust-kamenogorsk"],
  [/^petr/i, "petropavlovsk"],
  [/^(oral|ural)/i, "uralsk"],
];
// Старые кампании: город указан кодом внутри названия, например "AW KRG | SENT | 25-60 MOM | Stat"
const CITY_CODES: Record<string, string> = {
  ATA: "almaty", ALA: "almaty", ALMATY: "almaty",
  AST: "astana", ASTANA: "astana", NQZ: "astana",
  KRG: "karaganda", KAR: "karaganda", KARAGANDA: "karaganda",
  SHYM: "shymkent", SHM: "shymkent", CIT: "shymkent",
  ATYRAU: "atyrau", GUW: "atyrau", AKTAU: "aktau", SCO: "aktau",
  UKK: "ust-kamenogorsk", OSKEMEN: "ust-kamenogorsk",
  PPK: "petropavlovsk", PETRO: "petropavlovsk",
  URAL: "uralsk", ORAL: "uralsk", URA: "uralsk",
  ALL: "all",
};
// Кампании, которые ведут не на сайт kotofeyi.site
const isOtherCampaign = (name: string) => /^\s*(AW|LID)\b/i.test(name) || /taplink|kaspi\s*magazin/i.test(name);
function campaignCity(name: string): string | undefined {
  const byPrefix = CITY_BY_CAMPAIGN.find(([re]) => re.test(name))?.[1];
  if (byPrefix && !isOtherCampaign(name)) return byPrefix;
  const tokens = name.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  return tokens.map((t) => CITY_CODES[t]).find(Boolean) ?? byPrefix;
}

const cityName = (slug: string) =>
  adCities.find((c) => c.slug === slug)?.name ?? (slug === "home" ? "Главная страница" : slug === "all" ? "Все города (общие кампании)" : slug);
const storeToCity = new Map<string, string>();
const storeName = new Map<string, string>();
for (const c of adCities) for (const s of c.stores) {
  storeToCity.set(s.id.replace(/-/g, "_"), c.slug);
  storeName.set(s.id.replace(/-/g, "_"), s.ru.replace(/^📍\s*/, "").split(",").slice(0, 2).join(","));
}
const citySlugByUnderscore = new Map(adCities.map((c) => [c.slug.replace(/-/g, "_"), c.slug]));

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); isoDay(d) <= to; d = new Date(d.getTime() + 86400000)) out.push(isoDay(d));
  return out;
}
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const money = (n: number) => "$" + n.toFixed(2);
const per = (spend: number, n: number) => (n > 0 && spend > 0 ? money(spend / n) : "—");
const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1).replace(".", ",") + "%" : "—");

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = process.env.REPORT_KEY;
  if (!key || url.searchParams.get("key") !== key) return new Response("Нет доступа", { status: 401 });

  const token = process.env.META_ACCESS_TOKEN!;
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const rawAccount = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = rawAccount.startsWith("act_") ? rawAccount : `act_${rawAccount}`;
  const pixelId = process.env.META_PIXEL_ID || "1599079054414806";
  const enc = encodeURIComponent;

  // Период: сегодня считаем по времени Алматы
  const nowLocal = new Date(Date.now() + TZ_OFFSET_H * 3600000);
  const today = isoDay(nowLocal);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : today.slice(0, 8) + "01";
  let to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : today;
  if (to > today) to = today;
  const days = daysBetween(from, to).slice(0, 62);

  const get = async (u: string): Promise<Json> => {
    const data = await fetch(u, { cache: "no-store" }).then((r) => r.json());
    if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
    return data;
  };
  const getAll = async (u: string): Promise<Json[]> => {
    const out: Json[] = [];
    let next: string | undefined = u;
    while (next) {
      const page: Json = await get(next);
      out.push(...(page.data ?? []));
      next = page.paging?.next;
    }
    return out;
  };

  // город → день → показатели
  const byCityDay = new Map<string, Map<string, Row>>();
  const cell = (city: string, day: string) => {
    if (!byCityDay.has(city)) byCityDay.set(city, new Map());
    const m = byCityDay.get(city)!;
    if (!m.has(day)) m.set(day, empty());
    return m.get(day)!;
  };
  const byStore = new Map<string, { wa: number; gis: number }>();
  const storeSpend = new Map<string, { spend: number; clicks: number }>(); // магазин → расход групп LEAD
  const unmatchedSets = new Map<string, number>(); // группы, где не понял магазин → расход
  const errors: string[] = [];
  const unmapped = new Set<string>();
  const otherRows: Json[] = []; // старые кампании за весь период

  // 1. Расход по кампаниям
  try {
    const rows = await getAll(
      `${graph}/${account}/insights?level=campaign&time_increment=1&fields=${enc("campaign_name,spend,impressions,inline_link_clicks,actions")}` +
        `&time_range=${enc(JSON.stringify({ since: from, until: to }))}&limit=500&access_token=${enc(token)}`,
    );
    for (const r of rows) {
      const name = String(r.campaign_name ?? "");
      if (isOtherCampaign(name)) continue; // старые кампании — отдельной таблицей
      const city = campaignCity(name);
      if (!city) {
        unmapped.add(name);
        continue;
      }
      const c = cell(city, r.date_start);
      c.spend += Number(r.spend ?? 0);
      c.impressions += Number(r.impressions ?? 0);
      c.linkClicks += Number(r.inline_link_clicks ?? 0);
      c.msgs += Number((r.actions ?? []).find((x: Json) => x.action_type === "onsite_conversion.messaging_conversation_started_7d")?.value ?? 0);
    }
  } catch (e) {
    errors.push(`Статистика кампаний: ${(e as Error).message}`);
  }

  // 1б. Старые кампании (охват, Taplink, Kaspi) — итог за период, отдельно от LEAD
  try {
    const rows = await getAll(
      `${graph}/${account}/insights?level=campaign&fields=${enc("campaign_name,spend,impressions,reach,frequency,inline_link_clicks,cpm,actions")}` +
        `&time_range=${enc(JSON.stringify({ since: from, until: to }))}&limit=500&access_token=${enc(token)}`,
    );
    for (const r of rows) if (isOtherCampaign(String(r.campaign_name ?? ""))) otherRows.push(r);
    otherRows.sort((a, b) => Number(b.spend) - Number(a.spend));
  } catch (e) {
    errors.push(`Прочие кампании: ${(e as Error).message}`);
  }

  // Результаты старых кампаний из поля actions
  const act = (r: Json, types: string[]) => {
    for (const t of types) {
      const a = (r.actions ?? []).find((x: Json) => x.action_type === t);
      if (a) return Number(a.value ?? 0);
    }
    return 0;
  };
  const messages = (r: Json) => act(r, ["onsite_conversion.messaging_conversation_started_7d"]);
  const webLeads = (r: Json) => act(r, ["offsite_conversion.fb_pixel_lead", "lead", "onsite_web_lead"]);

  // 1в. Расход по группам объявлений → по магазинам
  try {
    const rows = await getAll(
      `${graph}/${account}/insights?level=adset&fields=${enc("campaign_name,adset_name,spend,inline_link_clicks")}` +
        `&time_range=${enc(JSON.stringify({ since: from, until: to }))}&limit=500&access_token=${enc(token)}`,
    );
    for (const r of rows) {
      const camp = String(r.campaign_name ?? "");
      if (isOtherCampaign(camp)) continue;
      const setName = String(r.adset_name ?? "").toLowerCase().trim();
      let store: string | undefined;
      let len = 0;
      for (const c of adCities)
        for (const st of c.stores)
          for (const key of [st.id, ...(st.aliases ?? [])])
            if (setName.startsWith(key) && key.length > len) {
              store = st.id.replace(/-/g, "_");
              len = key.length;
            }
      if (!store) {
        const city = adCities.find((c) => c.slug === campaignCity(camp));
        if (city?.stores.length === 1) store = city.stores[0].id.replace(/-/g, "_");
      }
      const spend = Number(r.spend ?? 0);
      if (!store) {
        const label = `${camp} / ${r.adset_name}`;
        unmatchedSets.set(label, (unmatchedSets.get(label) ?? 0) + spend);
        continue;
      }
      const cur = storeSpend.get(store) ?? { spend: 0, clicks: 0 };
      cur.spend += spend;
      cur.clicks += Number(r.inline_link_clicks ?? 0);
      storeSpend.set(store, cur);
    }
  } catch (e) {
    errors.push(`Расход по магазинам: ${(e as Error).message}`);
  }

  // 2. События пикселя по дням
  try {
    for (const day of days) {
      const start = Math.floor(new Date(day + "T00:00:00Z").getTime() / 1000) - TZ_OFFSET_H * 3600;
      const buckets = await getAll(
        `${graph}/${pixelId}/stats?aggregation=event&start_time=${start}&end_time=${start + 86400}&access_token=${enc(token)}`,
      );
      for (const b of buckets) {
        for (const item of b.data ?? []) {
          const ev = String(item.value ?? "");
          const n = Number(item.count ?? 0);
          let m: RegExpMatchArray | null;
          if ((m = ev.match(/^(WhatsApp|Gis)_(.+)$/))) {
            const store = m[2];
            const city = storeToCity.get(store);
            if (!city) continue;
            const c = cell(city, day);
            const s = byStore.get(store) ?? { wa: 0, gis: 0 };
            if (m[1] === "WhatsApp") {
              c.wa += n;
              s.wa += n;
            } else {
              c.gis += n;
              s.gis += n;
            }
            byStore.set(store, s);
          } else if ((m = ev.match(/^Kaspi_(.+)$/))) {
            const city = citySlugByUnderscore.get(m[1]) ?? m[1];
            cell(city, day).kaspi += n;
          }
        }
      }
    }
  } catch (e) {
    errors.push(`События пикселя: ${(e as Error).message}`);
  }

  const cityOrder = [...adCities.map((c) => c.slug), "all", "home"].filter((s) => byCityDay.has(s));
  const total = (city: string) => {
    const t = empty();
    for (const r of byCityDay.get(city)?.values() ?? []) for (const k of Object.keys(t) as (keyof Row)[]) t[k] += r[k];
    return t;
  };
  const grand = empty();
  for (const c of cityOrder) {
    const t = total(c);
    for (const k of Object.keys(grand) as (keyof Row)[]) grand[k] += t[k];
  }

  // CSV по дням
  if (url.searchParams.get("format") === "csv") {
    const lines = ["Дата;Город;Расход $;Показы;Клики по рекламе;WhatsApp;2ГИС;Kaspi;Обращения (WA+2ГИС);Начатые переписки"];
    for (const day of days)
      for (const c of cityOrder) {
        const r = byCityDay.get(c)?.get(day);
        if (r)
          lines.push(
            [day, cityName(c), r.spend.toFixed(2).replace(".", ","), r.impressions, r.linkClicks, r.wa, r.gis, r.kaspi, r.wa + r.gis, r.msgs].join(";"),
          );
      }
    return new Response("﻿" + lines.join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="kotofey-report-${from}-${to}.csv"` },
    });
  }

  const cityRows = cityOrder
    .map((c) => {
      return summaryRow(esc(cityName(c)), total(c));
    })
    .join("");

  function summaryRow(label: string, t: Row, tag = "td") {
    const leads = t.wa + t.gis;
    const cells = [
      money(t.spend),
      t.impressions.toLocaleString("ru-RU"),
      t.linkClicks.toLocaleString("ru-RU"),
      pct(t.linkClicks, t.impressions),
      per(t.spend, t.linkClicks),
      t.wa, t.gis, t.kaspi,
      `<b>${leads}</b>`,
      pct(leads, t.linkClicks),
      per(t.spend, t.wa), per(t.spend, t.gis),
      `<b>${per(t.spend, leads)}</b>`,
      per(t.spend, leads + t.kaspi),
      t.msgs || "—",
      per(t.spend, t.msgs),
    ];
    return `<tr><th>${label}</th>${cells.map((x) => `<${tag}>${x}</${tag}>`).join("")}</tr>`;
  }
  const dayHead = days.map((d) => `<th>${d.slice(8)}.${d.slice(5, 7)}</th>`).join("");
  const metricRows = (label: string, pick: (r: Row) => number, fmt: (n: number) => string = String) =>
    cityOrder
      .map((c) => `<tr><th>${esc(cityName(c))}</th>${days.map((d) => `<td>${fmt(pick(byCityDay.get(c)?.get(d) ?? empty()))}</td>`).join("")}</tr>`)
      .join("");

  const storeIds = [...new Set([...storeSpend.keys(), ...byStore.keys()])];
  const days1 = Math.max(1, days.length);
  const storeRows = storeIds
    .map((id) => ({ id, s: byStore.get(id) ?? { wa: 0, gis: 0 }, m: storeSpend.get(id) ?? { spend: 0, clicks: 0 } }))
    .sort((a, b) => b.m.spend - a.m.spend)
    .map(
      ({ id, s, m }) =>
        `<tr><th>${esc(storeName.get(id) ?? id)}</th><td>${money(m.spend)}</td><td>${m.spend ? money(m.spend / days1) : "—"}</td><td>${m.clicks}</td><td>${s.wa}</td><td>${s.gis}</td><td><b>${s.wa + s.gis}</b></td><td>${per(m.spend, s.wa + s.gis)}</td></tr>`,
    )
    .join("");
  const unmatchedNote = unmatchedSets.size
    ? `<p>Группы, где не удалось понять магазин (расход не вошёл в таблицу): ${[...unmatchedSets].map(([n, v]) => `${esc(n)} — ${money(v)}`).join("; ")}</p>`
    : "";

  const monthNames = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  const monthLinks: string[] = [];
  for (let y = 2026, m = 9; `${y}-${String(m + 1).padStart(2, "0")}` <= today.slice(0, 7); m === 11 ? (y++, (m = 0)) : m++) {
    const first = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const last = isoDay(new Date(Date.UTC(y, m + 1, 0)));
    const active = from === first && (to === last || to === today);
    monthLinks.push(active ? `<b>${monthNames[m]} ${y}</b>` : `<a href="?key=${enc(key)}&from=${first}&to=${last}">${monthNames[m]} ${y}</a>`);
  }
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Котофей: реклама по городам</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px;color:#13233a;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p{margin:4px 0;color:#55657c;font-size:14px}
.wrap{max-width:1200px;margin:0 auto}.scroll{overflow-x:auto}
table{border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;min-width:100%}
th,td{padding:7px 10px;border-bottom:1px solid #e3e9f1;text-align:right;white-space:nowrap}
th:first-child{text-align:left;position:sticky;left:0;background:#fff}thead th{background:#e8f1fb;color:#12305a;font-weight:600}
tfoot th,tfoot td{font-weight:700;border-top:2px solid #12305a}
.err{background:#fff3f0;border:1px solid #f3b4a8;padding:10px 12px;border-radius:8px;color:#8a1c0b;margin:12px 0}
form{margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:14px}input,button{font:inherit;padding:6px 8px}
a{color:#2969b1}
</style></head><body><div class="wrap">
<h1>Реклама и обращения по городам</h1>
<p>Период: ${from} — ${to}. Обновлено: ${esc(new Date(Date.now() + TZ_OFFSET_H * 3600000).toISOString().replace("T", " ").slice(0, 16))} (время Алматы).</p>
<p>Месяц: ${monthLinks.join(" · ")}</p>
<form><input type="hidden" name="key" value="${esc(key)}">с <input type="date" name="from" value="${from}"> по <input type="date" name="to" value="${to}"><button>Показать</button>
<a href="?key=${enc(key)}&from=${from}&to=${to}&format=csv">Скачать по дням (CSV для Excel)</a></form>
${errors.map((e) => `<div class="err">${esc(e)}</div>`).join("")}
<h2>Итого за период</h2>
<div class="scroll"><table><thead><tr><th>Город</th><th>Расход</th><th>Показы</th><th>Клики<br>по рекламе</th><th>CTR</th><th>Цена<br>клика</th><th>WhatsApp</th><th>2ГИС</th><th>Kaspi</th><th>Обращения<br>(WA+2ГИС)</th><th>Конверсия<br>клик → обращение</th><th>Цена<br>WhatsApp</th><th>Цена<br>2ГИС</th><th>Цена<br>обращения</th><th>Цена<br>с Kaspi</th><th>Начатые<br>переписки</th><th>Цена<br>переписки</th></tr></thead>
<tbody>${cityRows}</tbody>
<tfoot>${summaryRow("Всего", grand)}</tfoot></table></div>
<p>Только кампании LEAD, которые ведут на сайт. Старые кампании — в отдельной таблице внизу.</p>
<h2>Обращения (WhatsApp + 2ГИС) по дням</h2>
<div class="scroll"><table><thead><tr><th>Город</th>${dayHead}</tr></thead><tbody>${metricRows("", (r) => r.wa + r.gis)}</tbody></table></div>
<h2>Kaspi по дням</h2>
<div class="scroll"><table><thead><tr><th>Город</th>${dayHead}</tr></thead><tbody>${metricRows("", (r) => r.kaspi)}</tbody></table></div>
<h2>Расход по дням (кампании LEAD)</h2>
<div class="scroll"><table><thead><tr><th>Город</th>${dayHead}</tr></thead><tbody>${metricRows("", (r) => r.spend, (n) => (n ? "$" + n.toFixed(0) : "—"))}</tbody></table></div>
<h2>По магазинам за период</h2>
<div class="scroll"><table><thead><tr><th>Магазин</th><th>Расход</th><th>В среднем<br>за день</th><th>Клики<br>по рекламе</th><th>WhatsApp</th><th>2ГИС</th><th>Обращения</th><th>Цена<br>обращения</th></tr></thead><tbody>${storeRows}</tbody></table></div>
<p>Расход — по группам объявлений кампаний LEAD (одна группа — один магазин). В городах с одним магазином весь расход города относится к нему.</p>
${unmatchedNote}
<h2>Старые кампании (охват, Taplink, Kaspi) — отдельно от LEAD</h2>
${otherRows.length ? `<div class="scroll"><table><thead><tr><th>Кампания</th><th>Город</th><th>Расход</th><th>Показы</th><th>Охват</th><th>Частота</th><th>CPM</th><th>Клики по ссылке</th><th>CTR</th><th>Цена клика</th><th>Начатые переписки</th><th>Цена переписки</th><th>Web lead</th><th>Цена lead</th></tr></thead><tbody>${otherRows
  .map((r) => {
    const spend = Number(r.spend ?? 0), imp = Number(r.impressions ?? 0), clicks = Number(r.inline_link_clicks ?? 0);
    const city = campaignCity(String(r.campaign_name));
    return `<tr><th>${esc(r.campaign_name)}</th><td style="text-align:left">${city ? esc(cityName(city)) : "—"}</td><td>${money(spend)}</td><td>${imp.toLocaleString("ru-RU")}</td><td>${Number(r.reach ?? 0).toLocaleString("ru-RU")}</td><td>${Number(r.frequency ?? 0).toFixed(2).replace(".", ",")}</td><td>${r.cpm ? money(Number(r.cpm)) : "—"}</td><td>${clicks.toLocaleString("ru-RU")}</td><td>${pct(clicks, imp)}</td><td>${per(spend, clicks)}</td><td>${messages(r) || "—"}</td><td>${per(spend, messages(r))}</td><td>${webLeads(r) || "—"}</td><td>${per(spend, webLeads(r))}</td></tr>`;
  })
  .join("")}</tbody><tfoot><tr><th>Всего</th><td></td><td>${money(otherRows.reduce((a, r) => a + Number(r.spend ?? 0), 0))}</td><td>${otherRows.reduce((a, r) => a + Number(r.impressions ?? 0), 0).toLocaleString("ru-RU")}</td><td></td><td></td><td></td><td>${otherRows.reduce((a, r) => a + Number(r.inline_link_clicks ?? 0), 0).toLocaleString("ru-RU")}</td><td></td><td></td><td>${otherRows.reduce((a, r) => a + messages(r), 0)}</td><td></td><td>${otherRows.reduce((a, r) => a + webLeads(r), 0)}</td><td></td></tr></tfoot></table></div>` : "<p>За период расхода нет.</p>"}
<p style="margin-top:20px">WhatsApp, 2ГИС и Kaspi — клики на сайте по данным пикселя. Сейчас трафик на сайт идёт только из рекламы в Facebook и Instagram, поэтому эти клики — результат рекламы. Расход, показы и клики по рекламе — из статистики кампаний Meta.</p>
<p>6 октября примерно с 12:00 до 21:45 события на сайте не записывались (сбой GTM), вечером 6-го и 7 октября часть событий могла задвоиться.</p>

${unmapped.size ? `<p>Кампании без города (не вошли в таблицу): ${esc([...unmapped].join(", "))}</p>` : ""}
</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
