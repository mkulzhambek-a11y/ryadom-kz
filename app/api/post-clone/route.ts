import { NextResponse } from "next/server";
import { adCities, SITE_HOSTS, type AdCity } from "@/lib/store-addresses";
import { postCloneConfig as cfg } from "@/lib/post-clone";

// Копирует объявление из готового поста Instagram во все группы кампаний LEAD.
// Пост остаётся тем же, а кнопка в каждом городе ведёт на страницу своего города:
// kotofeyi.site/almaty, kotofeyi.site/astana и т. д. ИИ-улучшения выключены. Всё создаётся на паузе.
// Повторный запуск не создаёт дублей: группы, где объявление с таким названием уже есть, пропускаются.
//
// Запуск: Vercel → Settings → Cron Jobs → /api/post-clone → Run. Настройки — в lib/post-clone.ts.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Json = Record<string, any>;
const TIME_BUDGET_MS = 40_000;
const SITE = `https://${SITE_HOSTS[0]}`;
const STANDARD_ENHANCEMENTS_PARTS = ["image_touchups", "image_brightness_and_contrast", "image_templates", "text_optimizations", "inline_comment", "enhance_cta"];

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
const isOldCampaign = (name: string) => /^\s*(AW|LID)\b/i.test(name) || /taplink|kaspi\s*magazin/i.test(name);

// Магазин или город по началу названия (almaty-mega-…, almaty-…)
function detect(name: string): { city: AdCity; prefix: string } | null {
  const n = name.toLowerCase().trim();
  let best: { city: AdCity; prefix: string; len: number } | null = null;
  for (const city of adCities) {
    for (const store of city.stores)
      for (const key of [store.id, ...(store.aliases ?? [])])
        if (n.startsWith(key) && (!best || key.length > best.len)) best = { city, prefix: store.id, len: key.length };
    if (n.startsWith(city.slug) && (!best || city.slug.length > best.len)) best = { city, prefix: city.slug, len: city.slug.length };
  }
  return best && { city: best.city, prefix: best.prefix };
}
function cityFromCampaign(name: string): AdCity | undefined {
  const slug = CITY_BY_CAMPAIGN.find(([re]) => re.test(name))?.[1];
  return adCities.find((c) => c.slug === slug);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = process.env.META_ACCESS_TOKEN || "";
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `${process.env.META_GRAPH_URL || "https://graph.facebook.com"}/${version}`;
  const rawAccount = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = rawAccount ? (rawAccount.startsWith("act_") ? rawAccount : `act_${rawAccount}`) : "";
  const enc = encodeURIComponent;

  const finish = (body: Json, status = 200) => {
    console.log(JSON.stringify(body));
    return NextResponse.json(body, { status });
  };
  if (!token) return finish({ error: "нет META_ACCESS_TOKEN" }, 500);
  if (!account) return finish({ error: "нет META_AD_ACCOUNT_ID" }, 500);
  if (!cfg.templateAdId.trim()) return finish({ error: "в lib/post-clone.ts не задано templateAdId" }, 500);

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
  const summary = { adSets: 0, created: 0, exists: 0, skipped: 0, errors: 0, remaining: 0 };
  const report: Json[] = [];
  const links: Record<string, string> = {};

  try {
    // 1. Образец
    const tpl = await get(
      `${graph}/${cfg.templateAdId.trim()}?fields=${enc(
        "name,effective_status,conversion_domain,adset_id,creative{id,name,source_instagram_media_id,instagram_user_id,effective_instagram_media_id,call_to_action_type,link_url,url_tags,degrees_of_freedom_spec,object_story_spec}",
      )}&access_token=${enc(token)}`,
    );
    const c: Json = tpl.creative ?? {};
    const mediaId = c.source_instagram_media_id || c.effective_instagram_media_id;
    const igUser = c.instagram_user_id;
    if (c.object_story_spec || !mediaId) {
      return finish({ error: "образец не из готового поста Instagram — для таких объявлений есть скрипт /api/ad-clone", template: { name: tpl.name, creative: c } }, 500);
    }
    if (!igUser) return finish({ error: "у образца не указан аккаунт Instagram (instagram_user_id)", template: { name: tpl.name } }, 500);

    const tplDetected = detect(String(tpl.name ?? ""));
    const baseName = (cfg.adName.trim() || String(tpl.name ?? "пост").slice(tplDetected?.prefix.length ?? 0).replace(/^[\s\-_|·]+/, "")) || "пост";
    const button = cfg.button.trim() || c.call_to_action_type || "LEARN_MORE";

    // ИИ-улучшения: выключаем всё, что включено в образце
    const features: Json = {};
    for (const [k, v] of Object.entries<Json>(c.degrees_of_freedom_spec?.creative_features_spec ?? {})) {
      if (v?.enroll_status !== "OPT_IN") continue;
      if (k === "standard_enhancements") for (const p of STANDARD_ENHANCEMENTS_PARTS) features[p] = { enroll_status: "OPT_OUT" };
      else features[k] = { enroll_status: "OPT_OUT" };
    }

    // 2. Группы объявлений и уже существующие объявления
    const adSets = await getAll(
      `${graph}/${account}/adsets?fields=${enc("id,name,effective_status,campaign{id,name,effective_status}")}&limit=200&access_token=${enc(token)}`,
    );
    const ads = await getAll(`${graph}/${account}/ads?fields=${enc("id,name,adset_id")}&limit=500&access_token=${enc(token)}`);
    const adNamesBySet = new Map<string, string[]>();
    for (const a of ads) if (a.id !== cfg.templateAdId.trim()) adNamesBySet.set(a.adset_id, [...(adNamesBySet.get(a.adset_id) ?? []), String(a.name ?? "")]);

    const wanted = cfg.campaignNameContains.trim().toLowerCase();
    const creatives = new Map<string, string>(); // город → креатив

    for (const s of adSets) {
      const campName = String(s.campaign?.name ?? "");
      if (isOldCampaign(campName) || (wanted && !campName.toLowerCase().includes(wanted))) continue;
      const row: Json = { campaign: campName, adSet: s.name, adSetId: s.id };
      const live = s.effective_status === "ACTIVE";
      if (!live && !cfg.includePaused) {
        summary.skipped++;
        report.push({ ...row, action: `пропущено: группа не активна (${s.effective_status})` });
        continue;
      }
      const names = adNamesBySet.get(s.id) ?? [];
      const found = detect(String(s.name)) ?? names.map(detect).find(Boolean) ?? null;
      const city = found?.city ?? cityFromCampaign(campName);
      if (!city) {
        summary.skipped++;
        report.push({ ...row, action: "пропущено: не понял город по названию группы, объявлений и кампании" });
        continue;
      }
      summary.adSets++;
      const prefix = found && found.city.slug === city.slug ? found.prefix : city.slug;
      const adName = `${prefix}-${baseName}`.slice(0, 255);
      const link = `${SITE}/${city.slug}`;
      links[city.name] = link;
      Object.assign(row, { city: city.name, newAdName: adName, link });

      if (names.includes(adName)) {
        summary.exists++;
        report.push({ ...row, action: "такое объявление уже есть — пропускаю" });
        continue;
      }
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        summary.remaining++;
        continue;
      }
      try {
        let creativeId = creatives.get(city.slug);
        if (!creativeId) {
          const creative: Json = {
            name: `${city.slug}-${baseName}`.slice(0, 255),
            source_instagram_media_id: mediaId,
            instagram_user_id: igUser,
            call_to_action: { type: button, value: { link } },
            contextual_multi_ads: { enroll_status: "OPT_OUT" },
          };
          if (c.url_tags) creative.url_tags = c.url_tags;
          if (Object.keys(features).length) creative.degrees_of_freedom_spec = { creative_features_spec: features };
          creativeId = String((await post(`${account}/adcreatives`, creative)).id);
          creatives.set(city.slug, creativeId);
        }
        const created = await post(`${account}/ads`, {
          name: adName,
          adset_id: s.id,
          creative: { creative_id: creativeId },
          status: "PAUSED",
          conversion_domain: SITE_HOSTS[0],
        });
        summary.created++;
        report.push({ ...row, newAdId: created.id, creativeId, action: "объявление создано на паузе" });
      } catch (e) {
        summary.errors++;
        report.push({ ...row, error: (e as Error).message, action: "объявление не создано" });
      }
    }

    return finish({
      checkedAt: new Date().toISOString(),
      template: { name: tpl.name, instagramMediaId: mediaId, button },
      summary,
      note: summary.remaining ? `осталось ${summary.remaining} групп — нажмите Run ещё раз` : undefined,
      links,
      report,
    });
  } catch (e) {
    return finish({ error: (e as Error).message, summary, report }, 500);
  }
}
