import { NextResponse } from "next/server";
import { cloneConfig } from "@/lib/campaign-clone";
import {
  adCities,
  PLACEHOLDERS_KZ,
  PLACEHOLDERS_RU,
  PLACEHOLDERS_STORE_KZ,
  PLACEHOLDERS_STORE_RU,
  SITE_HOSTS,
  type AdCity,
  type AdStore,
} from "@/lib/store-addresses";

// Создаёт кампанию по образцу другой: одна новая кампания для города из настроек,
// в ней по одной группе объявлений на каждый магазин города.
// Группа = копия группы-образца, но с гео «круг вокруг магазина» и событием этого магазина.
// Объявления = копии объявлений образца с новой ссылкой, текстом и названием.
// ИИ-настройки Meta выключаются. Всё создаётся на паузе. Настройки — в lib/campaign-clone.ts.
//
// Запуск: Vercel → Settings → Cron Jobs → /api/campaign-clone → Run.
//
// Переменные окружения:
//   CRON_SECRET, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID — уже есть
//   CAMPAIGN_CLONE_DRY_RUN — пока не равно "false", скрипт ничего не создаёт, только пишет отчёт
//   META_API_VERSION       — версия Graph API, по умолчанию v23.0

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIVE = ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES"];
const TIME_BUDGET_MS = 40_000;
// Что убираем из настроек группы при отказе Meta, шаг за шагом
const ADSET_LEVELS = [
  "все настройки как задумано",
  "без окна атрибуции из образца (Meta поставит стандартное)",
  "Advantage+ аудитория оставлена как в образце",
];
const CREATIVE_FIELDS = "id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags";
const ADSET_FIELDS =
  "id,name,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_strategy,bid_amount,promoted_object,targeting,attribution_spec,destination_type";
// ИИ-улучшения креатива, отключение которых Meta уже принимала для ваших объявлений
const AI_BASE = ["image_touchups", "image_brightness_and_contrast", "image_templates", "text_optimizations", "inline_comment", "enhance_cta"];
const AI_EXTRA = ["pac_relaxation", "pac_recomposition", "translate_voiceover", "video_filtering"];

type Json = Record<string, any>;
type Found = { city: AdCity; store: AdStore; len: number };

function detectStore(name: string): Found | null {
  const n = name.toLowerCase().trim();
  let best: Found | null = null;
  for (const city of adCities) {
    for (const store of city.stores) {
      for (const key of [store.id, ...(store.aliases ?? [])]) {
        if (n.startsWith(key) && (!best || key.length > best.len)) best = { city, store, len: key.length };
      }
    }
  }
  return best;
}

const eventName = (store: AdStore) => "Store_" + store.id.replace(/-/g, "_");

function fillPlaceholders(template: string, city: AdCity, store: AdStore): string {
  let out = template;
  for (const p of PLACEHOLDERS_RU) out = out.split(p).join(city.stores.map((s) => s.ru).join("\n"));
  for (const p of PLACEHOLDERS_KZ) out = out.split(p).join(city.stores.map((s) => s.kz).join("\n"));
  for (const p of PLACEHOLDERS_STORE_RU) out = out.split(p).join(store.ru);
  for (const p of PLACEHOLDERS_STORE_KZ) out = out.split(p).join(store.kz);
  return out;
}

// Меняет в тексте образца адреса магазинов на новые (один магазин или весь город).
// Узнаёт адрес любого магазина из таблицы, какого бы города он ни был: строки с адресами,
// идущие подряд, заменяются одним новым списком на том же языке.
const stripPin = (s: string) => s.replace(/^📍\s*/, "").trim();
const KNOWN_RU = new Set(adCities.flatMap((c) => c.stores.map((s) => stripPin(s.ru))));
const KNOWN_KZ = new Set(adCities.flatMap((c) => c.stores.map((s) => stripPin(s.kz))));

function swapAddress(text: string, to: AdStore[]): { text: string; swapped: boolean } {
  if (to.length === 0) return { text, swapped: false };
  const out: string[] = [];
  let run: "ru" | "kz" | null = null;
  let swapped = false;
  for (const line of text.split("\n")) {
    const bare = stripPin(line.trim());
    // один и тот же адрес может совпадать на двух языках — тогда продолжаем текущий блок
    const lang: "ru" | "kz" | null =
      run && (run === "ru" ? KNOWN_RU : KNOWN_KZ).has(bare) ? run : KNOWN_KZ.has(bare) ? "kz" : KNOWN_RU.has(bare) ? "ru" : null;
    if (lang) {
      if (run !== lang) {
        out.push(...to.map((s) => s[lang]));
        swapped = true;
      }
      run = lang;
    } else {
      out.push(line);
      run = null;
    }
  }
  return { text: out.join("\n"), swapped };
}

type Rewrite = { newText: string; newLink: string; city: AdCity; store: AdStore; from?: AdStore; swapped: boolean; sample?: string };

// Обходит креатив: меняет текст поста и ссылки назначения, остальное не трогает
function rewrite(value: any, key: string, inBodies: boolean, r: Rewrite): any {
  if (typeof value === "string") {
    if (key === "message" || (inBodies && key === "text")) {
      let out: string;
      if (r.newText) {
        out = fillPlaceholders(r.newText, r.city, r.store);
        r.swapped = true;
      } else {
        const res = swapAddress(value, cloneConfig.addressMode === "store" ? [r.store] : r.city.stores);
        out = res.text;
        if (res.swapped) r.swapped = true;
      }
      if (!r.sample) r.sample = out;
      return out;
    }
    if ((key === "link" || key === "website_url") && /^https?:\/\//i.test(value)) {
      if (r.newLink) return r.newLink;
      try {
        const u = new URL(value);
        if (SITE_HOSTS.includes(u.hostname)) {
          u.pathname = `/${r.city.slug}`;
          return u.toString();
        }
      } catch {
        // не ссылка — оставляем как есть
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, key, inBodies, r));
  if (value && typeof value === "object") {
    const res: Json = {};
    for (const [k, v] of Object.entries(value)) res[k] = rewrite(v, k, inBodies || k === "bodies", r);
    return res;
  }
  return value;
}

function buildCreative(src: Json, name: string, r: Rewrite): Json {
  const oss = rewrite(src.object_story_spec, "", false, r);
  // При чтении Meta отдаёт и хэш, и ссылку на картинку, а при записи принимает что-то одно
  if (oss.link_data?.image_hash) delete oss.link_data.picture;
  if (oss.video_data?.image_hash) delete oss.video_data.image_url;
  if (oss.photo_data?.image_hash) delete oss.photo_data.url;
  for (const att of oss.link_data?.child_attachments ?? []) if (att?.image_hash) delete att.picture;

  const copy: Json = { name: name.slice(0, 255), object_story_spec: oss };
  if (src.url_tags) copy.url_tags = src.url_tags;
  if (src.asset_feed_spec) {
    const afs = rewrite(src.asset_feed_spec, "", false, r);
    for (const img of afs.images ?? []) if (img?.hash) delete img.url;
    for (const v of afs.videos ?? []) if (v?.thumbnail_hash) delete v.thumbnail_url;
    copy.asset_feed_spec = afs;
  }

  // ИИ-улучшения креатива — выключены
  const srcFeatures: Json = src.degrees_of_freedom_spec?.creative_features_spec ?? {};
  const features: Json = {};
  for (const k of AI_BASE) features[k] = { enroll_status: "OPT_OUT" };
  for (const k of AI_EXTRA) if (k in srcFeatures) features[k] = { enroll_status: "OPT_OUT" };
  copy.degrees_of_freedom_spec = { creative_features_spec: features };
  // Показ в подборке вместе с объявлениями других рекламодателей — выключен
  copy.contextual_multi_ads = { enroll_status: "OPT_OUT" };
  return copy;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.META_ACCESS_TOKEN;
  const dryRun = process.env.CAMPAIGN_CLONE_DRY_RUN !== "false";
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const rawAccount = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = rawAccount ? (rawAccount.startsWith("act_") ? rawAccount : `act_${rawAccount}`) : "";
  const cfg = cloneConfig;
  const newText = cfg.text.trim();
  const newLink = cfg.link.trim();
  const newName = cfg.newCampaignName.trim();
  const city = adCities.find((c) => c.slug === cfg.targetCity.trim().toLowerCase());

  const finish = (body: Json, status = 200) => {
    console.log(JSON.stringify(body));
    return NextResponse.json(body, { status });
  };
  if (!token) return finish({ dryRun, error: "нет META_ACCESS_TOKEN" }, 500);
  if (!account) return finish({ dryRun, error: "нет META_AD_ACCOUNT_ID" }, 500);
  if (!cfg.sourceCampaignId.trim()) return finish({ dryRun, error: "в lib/campaign-clone.ts не задано sourceCampaignId" }, 500);
  if (!city) return finish({ dryRun, error: `targetCity: нет города ${cfg.targetCity}. Есть: ${adCities.map((c) => c.slug).join(", ")}` }, 500);
  if (!newName) return finish({ dryRun, error: "в lib/campaign-clone.ts не задано newCampaignName" }, 500);
  if (newLink && !/^https:\/\//i.test(newLink)) return finish({ dryRun, error: "link должен начинаться с https://" }, 500);
  if (!(cfg.radiusKm >= 1 && cfg.radiusKm <= 80)) return finish({ dryRun, error: "radiusKm должен быть от 1 до 80" }, 500);
  if (!(cfg.dailyBudgetUsd >= 0 && cfg.dailyBudgetUsd <= 1000)) return finish({ dryRun, error: "dailyBudgetUsd должен быть от 0 до 1000" }, 500);

  const enc = encodeURIComponent;
  const get = async (url: string): Promise<Json> => {
    const data = await fetch(url, { cache: "no-store" }).then((r) => r.json());
    if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
    return data;
  };
  const getAll = async (url: string): Promise<Json[]> => {
    const out: Json[] = [];
    let next: string | undefined = url;
    while (next) {
      const page: Json = await get(next);
      out.push(...(page.data ?? []));
      next = page.paging?.next;
    }
    return out;
  };
  const post = async (path: string, params: Json): Promise<Json> => {
    const body = new URLSearchParams({ access_token: token });
    for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const data = await fetch(`${graph}/${path}`, { method: "POST", body }).then((r) => r.json());
    if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
    return data;
  };

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;
  const summary = { adSets: 0, adSetsCreated: 0, adsCreated: 0, wouldCreateAdSets: 0, wouldCreateAds: 0, exists: 0, skipped: 0, errors: 0, remaining: 0 };
  const report: Json[] = [];
  const warnings: string[] = [];
  let sampleText: string | undefined;
  let sampleLink: string | undefined;

  try {
    // 1. Кампания-образец, её группа и объявления
    const sourceId = cfg.sourceCampaignId.trim();
    const src = await get(
      `${graph}/${sourceId}?fields=name,objective,buying_type,special_ad_categories,bid_strategy,daily_budget,lifetime_budget&access_token=${enc(token)}`,
    );
    if (src.name === newName) return finish({ dryRun, error: "новое название совпадает с кампанией-образцом — задайте другое" }, 500);
    if (src.lifetime_budget && !src.daily_budget) return finish({ dryRun, error: "у образца бюджет на весь срок — такой вариант скрипт не копирует" }, 500);
    const campaignHasBudget = Boolean(src.daily_budget);

    const srcAdSets = (await getAll(`${graph}/${sourceId}/adsets?fields=${enc(ADSET_FIELDS)}&limit=100&access_token=${enc(token)}`)).filter((s) =>
      LIVE.includes(s.effective_status),
    );
    if (srcAdSets.length === 0) return finish({ dryRun, error: "в кампании-образце нет активных групп объявлений" }, 500);
    const tplSet = srcAdSets[0];
    if (srcAdSets.length > 1) warnings.push(`в образце ${srcAdSets.length} активных групп — за основу взята «${tplSet.name}»`);
    if (tplSet.lifetime_budget && !tplSet.daily_budget) return finish({ dryRun, error: "у группы-образца бюджет на весь срок — такой вариант скрипт не копирует" }, 500);

    const tplAds = (
      await getAll(
        `${graph}/${tplSet.id}/ads?fields=${enc(`id,name,effective_status,conversion_domain,creative{${CREATIVE_FIELDS}}`)}&limit=50&access_token=${enc(token)}`,
      )
    ).filter((a) => LIVE.includes(a.effective_status));
    if (tplAds.length === 0) return finish({ dryRun, error: `в группе-образце «${tplSet.name}» нет активных объявлений` }, 500);

    const srcFound = detectStore(tplSet.name) ?? tplAds.map((a) => detectStore(a.name ?? "")).find(Boolean) ?? null;
    if (!srcFound && !newText) warnings.push("не понял, какой магазин в образце: адрес в тексте не заменю — задайте text в настройках");

    // 2. Событие оптимизации для каждого магазина
    const po: Json = tplSet.promoted_object ?? {};
    let conversions: Json[] = [];
    if (po.custom_conversion_id) {
      conversions = await getAll(`${graph}/${account}/customconversions?fields=id,name,rule&limit=200&access_token=${enc(token)}`);
    }
    const promotedFor = (store: AdStore): Json | null => {
      const ev = eventName(store);
      if (po.custom_conversion_id) {
        const hit = conversions.find((c) => c.name === ev) ?? conversions.find((c) => String(c.rule ?? "").includes(`"${ev}"`)) ?? conversions.find((c) => String(c.name ?? "").includes(ev));
        return hit ? { ...po, custom_conversion_id: hit.id } : null;
      }
      if (po.custom_event_str) return { ...po, custom_event_str: ev };
      return Object.keys(po).length ? { ...po } : {};
    };
    if (!po.custom_conversion_id && !po.custom_event_str) {
      warnings.push("группа-образец оптимизируется не на событие магазина — у новых групп будет та же цель, что у образца");
    }

    // 3. Новая кампания: ищем по названию, иначе создаём на паузе
    const campaigns = await getAll(`${graph}/${account}/campaigns?fields=id,name&limit=200&access_token=${enc(token)}`);
    const fixedId = (cfg.newCampaignId ?? "").trim();
    if (fixedId && fixedId === sourceId) return finish({ dryRun, error: "newCampaignId совпадает с кампанией-образцом" }, 500);
    let newCampaignId: string | undefined = fixedId || campaigns.find((c) => c.name === newName)?.id;
    const twins = campaigns.filter((c) => c.name === newName && c.id !== newCampaignId).map((c) => c.id);
    if (twins.length) warnings.push(`есть другие кампании с тем же названием: ${twins.join(", ")} — если они пустые, удалите их в Ads Manager`);
    const budgetMinor = cfg.dailyBudgetUsd > 0 ? String(Math.round(cfg.dailyBudgetUsd * 100)) : undefined;
    const head: Json = {
      sourceCampaign: src.name,
      templateAdSet: tplSet.name,
      templateAds: tplAds.map((a) => a.name),
      newCampaign: newName,
      city: city.name,
      radiusKm: cfg.radiusKm,
      budget: campaignHasBudget
        ? `на кампании: $${Number(budgetMinor ?? src.daily_budget) / 100} в день`
        : `на каждой группе: $${Number(budgetMinor ?? tplSet.daily_budget) / 100} в день`,
    };

    if (!newCampaignId && !dryRun) {
      const params: Json = { name: newName, objective: src.objective, status: "PAUSED", special_ad_categories: src.special_ad_categories ?? [] };
      if (src.buying_type) params.buying_type = src.buying_type;
      if (campaignHasBudget) {
        params.daily_budget = budgetMinor ?? src.daily_budget;
        if (src.bid_strategy) params.bid_strategy = src.bid_strategy;
      }
      try {
        newCampaignId = String((await post(`${account}/campaigns`, params)).id);
      } catch (e) {
        // Новые версии API требуют явно указать, что бюджет не общий на группы
        if (!/is_adset_budget_sharing_enabled/.test((e as Error).message)) throw e;
        newCampaignId = String((await post(`${account}/campaigns`, { ...params, is_adset_budget_sharing_enabled: false })).id);
      }
      head.campaignAction = "кампания создана на паузе";
    } else {
      head.campaignAction = newCampaignId ? "кампания с таким названием уже есть — дополняю её" : "тестовый режим: создал бы кампанию на паузе";
    }
    head.newCampaignId = newCampaignId;

    // 4. Что уже есть в новой кампании (чтобы повторный запуск не делал дубли)
    const existingAdSets = new Map<string, string>();
    const existingAds = new Map<string, Set<string>>();
    const existingAdIds = new Map<string, string>(); // «группа|название» → ID объявления
    const refreshIds = new Set((cfg.refreshAdIds ?? []).map((x) => String(x).trim()).filter(Boolean));
    const existingAdvantage = new Map<string, boolean>(); // у каких готовых групп включена Advantage+ аудитория
    if (newCampaignId) {
      for (const s of await getAll(`${graph}/${newCampaignId}/adsets?fields=id,name,targeting&limit=200&access_token=${enc(token)}`)) {
        existingAdSets.set(s.name, s.id);
        existingAdvantage.set(s.id, s.targeting?.targeting_automation?.advantage_audience === 1);
      }
      for (const ad of await getAll(`${graph}/${newCampaignId}/ads?fields=id,name,adset_id&limit=200&access_token=${enc(token)}`)) {
        if (!existingAds.has(ad.adset_id)) existingAds.set(ad.adset_id, new Set());
        existingAds.get(ad.adset_id)!.add(ad.name);
        existingAdIds.set(`${ad.adset_id}|${ad.name}`, ad.id);
      }
    }

    // Название объявления: префикс магазина-образца меняется на новый магазин, «Copy» убирается
    const adNameFor = (srcName: string, store: AdStore) => {
      const f = detectStore(srcName);
      const rest = (f ? srcName.trim().slice(f.len) : `-${srcName.trim()}`).replace(/\s*-\s*copy(\s*\d+)?\s*$/i, "");
      return `${store.id}${rest}`;
    };

    // Параметры группы. level — сколько необязательных настроек убрано (см. ADSET_LEVELS)
    const CORE_TARGETING = ["geo_locations", "age_min", "age_max", "genders", "locales", "publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "device_platforms", "flexible_spec", "exclusions", "custom_audiences", "excluded_custom_audiences", "targeting_automation"];
    const buildAdSetParams = (store: AdStore, promoted: Json, level: number): Json => {
      let targeting: Json = JSON.parse(JSON.stringify(tplSet.targeting ?? {}));
      const geo: Json = {
        custom_locations: [{ latitude: store.lat, longitude: store.lng, radius: cfg.radiusKm, distance_unit: "kilometer" }],
      };
      if (targeting.geo_locations?.location_types) geo.location_types = targeting.geo_locations.location_types;
      targeting.geo_locations = geo;
      // Служебные поля образца (age_range, brand_safety…, subscriber_universe) Meta через API не принимает
      targeting = Object.fromEntries(Object.entries(targeting).filter(([k]) => CORE_TARGETING.includes(k)));
      // Advantage+ аудитория — выключена, иначе алгоритм может выходить за круг, возраст и пол
      if (level < 2) targeting.targeting_automation = { advantage_audience: 0 };

      const params: Json = {
        name: store.id,
        campaign_id: newCampaignId,
        status: "PAUSED",
        billing_event: tplSet.billing_event,
        optimization_goal: tplSet.optimization_goal,
        targeting,
      };
      if (Object.keys(promoted).length) params.promoted_object = promoted;
      if (level < 1 && tplSet.attribution_spec) params.attribution_spec = tplSet.attribution_spec;
      if (tplSet.destination_type && tplSet.destination_type !== "UNDEFINED") params.destination_type = tplSet.destination_type;
      if (!campaignHasBudget) {
        params.daily_budget = budgetMinor ?? tplSet.daily_budget;
        if (tplSet.bid_strategy) params.bid_strategy = tplSet.bid_strategy;
      }
      if (tplSet.bid_amount) params.bid_amount = tplSet.bid_amount;
      return params;
    };
    let startLevel = 0;
    // Что есть в группе-образце — для диагностики, если Meta отклонит создание
    head.templateSettings = {
      targetingKeys: Object.keys(tplSet.targeting ?? {}),
      targetingAutomation: tplSet.targeting?.targeting_automation,
      placements: tplSet.targeting?.publisher_platforms ?? "автоматические (Advantage+)",
      attribution: tplSet.attribution_spec,
      destinationType: tplSet.destination_type,
      promotedObjectKeys: Object.keys(po),
      optimizationGoal: tplSet.optimization_goal,
      billingEvent: tplSet.billing_event,
    };

    // 5. По группе на каждый магазин города
    for (const store of city.stores) {
      summary.adSets++;
      const row: Json = { adSet: store.id };
      if (store.lat === undefined || store.lng === undefined) {
        summary.skipped++;
        report.push({ ...row, skipped: "не заданы координаты магазина в lib/store-addresses.ts" });
        continue;
      }
      const promoted = promotedFor(store);
      if (promoted === null) {
        summary.skipped++;
        report.push({ ...row, skipped: `не нашёл пользовательскую конверсию для события ${eventName(store)} — создайте её в Events Manager` });
        continue;
      }
      row.geo = `${store.lat}, ${store.lng}, радиус ${cfg.radiusKm} км`;
      row.event = po.custom_conversion_id || po.custom_event_str ? eventName(store) : "как у образца";
      const adNames = tplAds.map((a) => adNameFor(a.name ?? "", store));
      let newAdSetId = existingAdSets.get(store.id);

      if (!newAdSetId) {
        if (dryRun) {
          summary.wouldCreateAdSets++;
          summary.wouldCreateAds += adNames.length;
          // текст и ссылка для предпросмотра
          const r: Rewrite = { newText, newLink, city, store, from: srcFound?.store, swapped: false };
          const preview = buildCreative(tplAds[0].creative ?? {}, "preview", r);
          if (!sampleText) sampleText = r.sample;
          if (!sampleLink) sampleLink = preview.object_story_spec?.link_data?.link ?? preview.object_story_spec?.video_data?.call_to_action?.value?.link;
          report.push({ ...row, action: "тестовый режим: создал бы группу на паузе", ads: adNames, addressInText: r.swapped ? "заменён" : "НЕ заменён" });
          continue;
        }
        if (outOfTime()) {
          summary.remaining += 1 + adNames.length;
          continue;
        }
        try {
          // Meta может отклонить отдельные настройки с ошибкой «(#3) … capability»:
          // тогда пробуем ещё раз, по очереди убирая необязательные параметры.
          let lastError: Error | null = null;
          for (let level = startLevel; level < ADSET_LEVELS.length; level++) {
            try {
              const params = buildAdSetParams(store, promoted, level);
              newAdSetId = String((await post(`${account}/adsets`, params)).id);
              startLevel = level;
              lastError = null;
              break;
            } catch (e) {
              lastError = e as Error;
              if (!/\(#3\)|capability/i.test(lastError.message)) break;
            }
          }
          if (lastError || !newAdSetId) throw lastError ?? new Error("группа не создана");
          if (startLevel > 0) row.simplified = ADSET_LEVELS.slice(1, startLevel + 1);
          existingAdSets.set(store.id, newAdSetId);
          summary.adSetsCreated++;
          row.action = "группа создана на паузе";
        } catch (e) {
          summary.errors++;
          report.push({ ...row, error: (e as Error).message, action: "группа не создана" });
          continue;
        }
      } else {
        row.action = "группа уже есть";
        // Группы из прошлого запуска создались с включённой Advantage+ аудиторией — выключаем
        if (existingAdvantage.get(newAdSetId) && !dryRun && !outOfTime()) {
          try {
            await post(newAdSetId, { targeting: buildAdSetParams(store, promoted, 0).targeting });
            row.action = "группа уже есть, Advantage+ аудитория выключена";
          } catch (e) {
            summary.errors++;
            row.advantageError = `не удалось выключить Advantage+ аудиторию: ${(e as Error).message}`;
          }
        }
      }
      row.newAdSetId = newAdSetId;

      const adRows: Json[] = [];
      const have = existingAds.get(newAdSetId) ?? new Set<string>();
      for (let i = 0; i < tplAds.length; i++) {
        const ad = tplAds[i];
        const adName = adNames[i];
        if (have.has(adName)) {
          const existingId = existingAdIds.get(`${newAdSetId}|${adName}`);
          // Объявление из списка refreshAdIds: собираем креатив заново и подставляем в то же объявление
          if (existingId && refreshIds.has(existingId) && !dryRun && ad.creative?.object_story_spec) {
            if (outOfTime()) {
              summary.remaining++;
              continue;
            }
            try {
              const r: Rewrite = { newText, newLink, city, store, from: srcFound?.store, swapped: false };
              const creative = buildCreative(ad.creative, adName, r);
              const creativeId = String((await post(`${account}/adcreatives`, creative)).id);
              await post(existingId, { creative: { creative_id: creativeId } });
              adRows.push({ ad: adName, adId: existingId, action: "текст и ссылка обновлены", addressInText: r.swapped ? "заменён" : "НЕ заменён" });
              if (!r.swapped) summary.errors++;
            } catch (e) {
              summary.errors++;
              adRows.push({ ad: adName, adId: existingId, error: (e as Error).message });
            }
            continue;
          }
          summary.exists++;
          continue;
        }
        if (dryRun) {
          summary.wouldCreateAds++;
          adRows.push({ ad: adName, action: "тестовый режим: создал бы" });
          continue;
        }
        if (outOfTime()) {
          summary.remaining++;
          continue;
        }
        const creativeSrc: Json = ad.creative ?? {};
        if (!creativeSrc.object_story_spec) {
          summary.skipped++;
          adRows.push({ ad: adName, skipped: "объявление-образец сделано из готового поста — скопируйте его вручную" });
          continue;
        }
        try {
          const r: Rewrite = { newText, newLink, city, store, from: srcFound?.store, swapped: false };
          const creative = buildCreative(creativeSrc, adName, r);
          if (!sampleText) sampleText = r.sample;
          const creativeId = String((await post(`${account}/adcreatives`, creative)).id);
          const adParams: Json = { name: adName, adset_id: newAdSetId, creative: { creative_id: creativeId }, status: "PAUSED" };
          if (newLink) adParams.conversion_domain = new URL(newLink).hostname.replace(/^www\./, "");
          else if (ad.conversion_domain) adParams.conversion_domain = ad.conversion_domain;
          const created = await post(`${account}/ads`, adParams);
          summary.adsCreated++;
          have.add(adName);
          adRows.push({ ad: adName, newAdId: created.id, action: "создано на паузе", addressInText: r.swapped ? "заменён" : "НЕ заменён" });
          if (!r.swapped) warnings.push(`в объявлении ${adName} адрес не заменён — проверьте текст образца`);
        } catch (e) {
          summary.errors++;
          adRows.push({ ad: adName, error: (e as Error).message });
        }
      }
      report.push({ ...row, ads: adRows });
    }

    return finish({ dryRun, checkedAt: new Date().toISOString(), ...head, warnings, summary, sampleText, sampleLink, report });
  } catch (e) {
    return finish({ dryRun, error: (e as Error).message, warnings, summary, report }, 500);
  }
}
