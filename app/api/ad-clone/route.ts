import { NextResponse } from "next/server";
import { adCities, PLACEHOLDERS_KZ, PLACEHOLDERS_RU, SITE_HOSTS, type AdCity } from "@/lib/store-addresses";

// Размножает объявление-образец на все группы объявлений с активной рекламой.
// В каждой копии метки {АДРЕСА_RU} и {АДРЕСА_KZ} заменяются на адреса всех магазинов города,
// ссылки на сайт переводятся на страницу города, ИИ-улучшения выключаются.
// Копии создаются на паузе.
//
// Запуск: Vercel → Settings → Cron Jobs → /api/ad-clone → Run.
//
// Переменные окружения:
//   CRON_SECRET, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID — уже есть
//   AD_CLONE_TEMPLATE_AD_ID — ID объявления-образца
//   AD_CLONE_NAME           — название акции латиницей или кириллицей, например утепляйся-2
//   AD_CLONE_DRY_RUN        — пока не равно "false", скрипт ничего не создаёт, только пишет отчёт
//   AD_CLONE_ONLY_CITY      — необязательно: один город для пробы, например uralsk
//   META_API_VERSION        — версия Graph API, по умолчанию v23.0

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIVE_STATUSES = ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES"];
const CREATIVE_FIELDS =
  "id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags";
const STANDARD_ENHANCEMENTS_PARTS = [
  "image_touchups",
  "image_brightness_and_contrast",
  "image_templates",
  "text_optimizations",
  "inline_comment",
  "enhance_cta",
];
const TIME_BUDGET_MS = 40_000;

type Json = Record<string, any>;

// Определяет город и магазин по названию группы или объявления (например almaty-adk-…)
function detect(name: string): { city: AdCity; prefix: string } | null {
  const n = name.toLowerCase().trim();
  let best: { city: AdCity; prefix: string; len: number } | null = null;
  for (const city of adCities) {
    for (const store of city.stores) {
      for (const key of [store.id, ...(store.aliases ?? [])]) {
        if (n.startsWith(key) && (!best || key.length > best.len)) best = { city, prefix: store.id, len: key.length };
      }
    }
    if (n.startsWith(city.slug) && (!best || city.slug.length > best.len)) {
      best = { city, prefix: city.slug, len: city.slug.length };
    }
  }
  return best && { city: best.city, prefix: best.prefix };
}

function hasPlaceholder(value: unknown): boolean {
  const s = JSON.stringify(value ?? "");
  return [...PLACEHOLDERS_RU, ...PLACEHOLDERS_KZ].some((p) => s.includes(p));
}

// Обходит весь креатив: подставляет адреса в тексты и страницу города в ссылки на сайт
function fill(value: any, city: AdCity, preview: { text?: string }): any {
  if (typeof value === "string") {
    let out = value;
    const ru = city.stores.map((s) => s.ru).join("\n");
    const kz = city.stores.map((s) => s.kz).join("\n");
    for (const p of PLACEHOLDERS_RU) out = out.split(p).join(ru);
    for (const p of PLACEHOLDERS_KZ) out = out.split(p).join(kz);
    if (out !== value && !preview.text) preview.text = out;
    if (/^https?:\/\//i.test(out)) {
      try {
        const u = new URL(out);
        if (SITE_HOSTS.includes(u.hostname)) {
          u.pathname = `/${city.slug}`;
          out = u.toString();
        }
      } catch {
        // не ссылка — оставляем как есть
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, city, preview));
  if (value && typeof value === "object") {
    const res: Json = {};
    for (const [k, v] of Object.entries(value)) res[k] = fill(v, city, preview);
    return res;
  }
  return value;
}

function buildCreative(template: Json, city: AdCity, name: string, preview: { text?: string }): Json {
  const oss = fill(template.object_story_spec, city, preview);
  // При чтении Meta отдаёт и хэш, и ссылку на картинку, а при записи принимает что-то одно
  if (oss.link_data?.image_hash) delete oss.link_data.picture;
  if (oss.video_data?.image_hash) delete oss.video_data.image_url;
  if (oss.photo_data?.image_hash) delete oss.photo_data.url;
  for (const att of oss.link_data?.child_attachments ?? []) if (att?.image_hash) delete att.picture;

  const copy: Json = { name: name.slice(0, 255), object_story_spec: oss };
  if (template.url_tags) copy.url_tags = template.url_tags;

  if (template.asset_feed_spec) {
    const afs = fill(template.asset_feed_spec, city, preview);
    for (const img of afs.images ?? []) if (img?.hash) delete img.url;
    for (const v of afs.videos ?? []) if (v?.thumbnail_hash) delete v.thumbnail_url;
    copy.asset_feed_spec = afs;
  }

  // Выключаем все ИИ-улучшения, которые включены в образце
  const src: Json = template.degrees_of_freedom_spec?.creative_features_spec ?? {};
  const features: Json = {};
  for (const key of Object.keys(src)) {
    if (src[key]?.enroll_status !== "OPT_IN") continue;
    if (key === "standard_enhancements") {
      for (const part of STANDARD_ENHANCEMENTS_PARTS) features[part] = { enroll_status: "OPT_OUT" };
    } else {
      features[key] = { enroll_status: "OPT_OUT" };
    }
  }
  if (Object.keys(features).length > 0) copy.degrees_of_freedom_spec = { creative_features_spec: features };
  return copy;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.META_ACCESS_TOKEN;
  const dryRun = process.env.AD_CLONE_DRY_RUN !== "false";
  const templateAdId = (process.env.AD_CLONE_TEMPLATE_AD_ID || "").trim();
  const promo = (process.env.AD_CLONE_NAME || "").trim();
  const onlyCity = (process.env.AD_CLONE_ONLY_CITY || "").trim().toLowerCase();
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const rawAccount = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = rawAccount ? (rawAccount.startsWith("act_") ? rawAccount : `act_${rawAccount}`) : "";

  const finish = (body: Json, status = 200) => {
    console.log(JSON.stringify(body));
    return NextResponse.json(body, { status });
  };

  if (!token) return finish({ dryRun, error: "нет META_ACCESS_TOKEN" }, 500);
  if (!account) return finish({ dryRun, error: "нет META_AD_ACCOUNT_ID" }, 500);
  if (!templateAdId) return finish({ dryRun, error: "нет AD_CLONE_TEMPLATE_AD_ID (ID объявления-образца)" }, 500);
  if (!promo) return finish({ dryRun, error: "нет AD_CLONE_NAME (название акции для имён объявлений)" }, 500);
  if (onlyCity && !adCities.some((c) => c.slug === onlyCity)) {
    return finish({ dryRun, error: `AD_CLONE_ONLY_CITY: нет города ${onlyCity}. Есть: ${adCities.map((c) => c.slug).join(", ")}` }, 500);
  }

  const get = async (url: string): Promise<Json> => {
    const data = await fetch(url, { cache: "no-store" }).then((r) => r.json());
    if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
    return data;
  };
  const post = async (path: string, params: Record<string, string>): Promise<Json> => {
    const body = new URLSearchParams({ ...params, access_token: token });
    const data = await fetch(`${graph}/${path}`, { method: "POST", body }).then((r) => r.json());
    if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
    return data;
  };

  const startedAt = Date.now();
  const report: Json[] = [];
  const summary = { adSets: 0, created: 0, wouldCreate: 0, exists: 0, unknown: 0, errors: 0, remaining: 0 };
  const texts: Record<string, string> = {};

  try {
    // 1. Образец
    const tpl = await get(
      `${graph}/${templateAdId}?fields=${encodeURIComponent(`name,effective_status,conversion_domain,creative{${CREATIVE_FIELDS}}`)}` +
        `&access_token=${encodeURIComponent(token)}`,
    );
    const template: Json = tpl.creative ?? {};
    if (!template.object_story_spec) {
      return finish({ dryRun, error: "образец сделан из готового поста — нужен образец, созданный в Ads Manager с загрузкой картинки или видео" }, 500);
    }
    if (!hasPlaceholder(template.object_story_spec) && !hasPlaceholder(template.asset_feed_spec)) {
      return finish({ dryRun, error: `в тексте образца нет меток ${PLACEHOLDERS_RU[0]} или ${PLACEHOLDERS_KZ[0]}` }, 500);
    }
    if (LIVE_STATUSES.includes(tpl.effective_status)) {
      return finish({ dryRun, error: "образец включён — поставьте его на паузу, иначе покупатели увидят метки вместо адресов" }, 500);
    }

    // 2. Все объявления кабинета: по ним находим группы с активной рекламой и уже существующие названия
    const ads: Json[] = [];
    let url: string | undefined =
      `${graph}/${account}/ads?fields=${encodeURIComponent("id,name,effective_status,adset{id,name}")}` +
      `&limit=200&access_token=${encodeURIComponent(token)}`;
    while (url) {
      const page: Json = await get(url);
      ads.push(...(page.data ?? []));
      url = page.paging?.next;
    }

    const adSets = new Map<string, { name: string; live: boolean; adNames: string[] }>();
    for (const ad of ads) {
      if (!ad.adset?.id) continue;
      const entry = adSets.get(ad.adset.id) ?? { name: String(ad.adset.name ?? ""), live: false, adNames: [] as string[] };
      entry.adNames.push(ad.name ?? "");
      if (LIVE_STATUSES.includes(ad.effective_status)) entry.live = true;
      adSets.set(ad.adset.id, entry);
    }

    // 3. Копия в каждую группу
    const creatives = new Map<string, string>(); // город → ID креатива, один на город
    for (const [adSetId, info] of adSets) {
      if (!info.live) continue;
      const found = detect(info.name) ?? info.adNames.map(detect).find(Boolean) ?? null;
      const row: Json = { adSetId, adSetName: info.name };
      if (!found) {
        summary.unknown++;
        report.push({ ...row, skipped: "не понял, какой это город: название группы и объявлений не начинается с города или магазина" });
        continue;
      }
      if (onlyCity && found.city.slug !== onlyCity) continue;
      summary.adSets++;

      const adName = `${found.prefix}-${promo}`;
      row.city = found.city.name;
      row.newAdName = adName;
      if (info.adNames.includes(adName)) {
        summary.exists++;
        report.push({ ...row, action: "такое объявление уже есть — пропускаю" });
        continue;
      }

      const preview: { text?: string } = {};
      const creative = buildCreative(template, found.city, `${found.city.slug}-${promo}`, preview);
      if (preview.text && !texts[found.city.name]) texts[found.city.name] = preview.text;

      if (dryRun) {
        summary.wouldCreate++;
        report.push({ ...row, action: "тестовый режим: создал бы объявление на паузе" });
        continue;
      }
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        summary.remaining++;
        continue;
      }

      try {
        let creativeId = creatives.get(found.city.slug);
        if (!creativeId) {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(creative)) params[k] = typeof v === "string" ? v : JSON.stringify(v);
          creativeId = String((await post(`${account}/adcreatives`, params)).id);
          creatives.set(found.city.slug, creativeId);
        }
        const adParams: Record<string, string> = {
          name: adName,
          adset_id: adSetId,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: "PAUSED",
        };
        if (tpl.conversion_domain) adParams.conversion_domain = tpl.conversion_domain;
        const created = await post(`${account}/ads`, adParams);
        summary.created++;
        report.push({ ...row, newAdId: created.id, creativeId, action: "объявление создано на паузе" });
      } catch (e) {
        summary.errors++;
        report.push({ ...row, error: (e as Error).message, action: "объявление не создано" });
      }
    }
  } catch (e) {
    return finish({ dryRun, error: (e as Error).message, summary, report }, 500);
  }

  return finish({ dryRun, onlyCity: onlyCity || undefined, checkedAt: new Date().toISOString(), summary, texts, report });
}
