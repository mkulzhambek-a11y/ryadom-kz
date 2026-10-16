import { NextResponse } from "next/server";

// Выключает ИИ-улучшения Advantage+ креатива во всех активных объявлениях кабинета.
// Креатив в Meta редактировать нельзя, поэтому скрипт создаёт копию креатива
// с выключенными улучшениями и подставляет её в объявление.
//
// Запуск: Vercel → Settings → Cron Jobs → /api/creative-fix → Run.
//
// Переменные окружения (Vercel → Settings → Environment Variables):
//   CRON_SECRET              — пароль на запуск (уже есть)
//   META_ACCESS_TOKEN        — токен системного пользователя Meta (уже есть)
//   META_AD_ACCOUNT_ID       — ID рекламного кабинета, например act_1234567890
//   CREATIVE_FIX_DRY_RUN     — пока не равно "false", скрипт ничего не меняет, только пишет отчёт
//   CREATIVE_FIX_ONLY_AD_ID  — необязательно: ID одного объявления, чтобы проверить на нём
//   META_API_VERSION         — версия Graph API, по умолчанию v23.0

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AD_STATUSES = ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES"];

const CREATIVE_FIELDS = [
  "id",
  "name",
  "object_story_spec",
  "object_story_id",
  "effective_object_story_id",
  "source_instagram_media_id",
  "instagram_user_id",
  "asset_feed_spec",
  "degrees_of_freedom_spec",
  "url_tags",
  "call_to_action_type",
  "link_url",
  "image_hash",
].join(",");

// Старый общий выключатель: в новых версиях API его нельзя записать, только по частям
const STANDARD_ENHANCEMENTS_PARTS = [
  "image_touchups",
  "image_brightness_and_contrast",
  "image_templates",
  "text_optimizations",
  "inline_comment",
  "enhance_cta",
];

const NAME_SUFFIX = " · без ИИ";

type Json = Record<string, any>;

function ratioLabel(w: number, h: number): string {
  const r = w / h;
  const known: [number, string][] = [
    [1, "1:1"],
    [0.8, "4:5"],
    [0.75, "3:4"],
    [0.5625, "9:16"],
    [1.91, "1.91:1"],
    [1.7778, "16:9"],
  ];
  const hit = known.find(([v]) => Math.abs(r - v) < 0.02);
  return hit ? hit[1] : `${r.toFixed(2)}:1`;
}

function enabledFeatures(creative: Json): string[] {
  const features: Json = creative?.degrees_of_freedom_spec?.creative_features_spec ?? {};
  return Object.keys(features).filter((k) => features[k]?.enroll_status === "OPT_IN");
}

// standard_enhancements — устаревший общий флаг: Meta продолжает показывать его включённым
// даже после отключения всех частей, поэтому сам по себе он не повод менять объявление
function needsFix(enabled: string[]): boolean {
  return enabled.some((k) => k !== "standard_enhancements");
}

function imageHashes(creative: Json): string[] {
  const out = new Set<string>();
  const oss = creative?.object_story_spec ?? {};
  for (const h of [
    creative?.image_hash,
    oss?.link_data?.image_hash,
    oss?.photo_data?.image_hash,
    oss?.video_data?.image_hash,
  ]) {
    if (h) out.add(h);
  }
  for (const att of oss?.link_data?.child_attachments ?? []) if (att?.image_hash) out.add(att.image_hash);
  for (const img of creative?.asset_feed_spec?.images ?? []) if (img?.hash) out.add(img.hash);
  return [...out];
}

function creativeKind(creative: Json): string {
  if (creative.object_story_spec) return "создано в Ads Manager";
  if (creative.source_instagram_media_id) return "готовый пост Instagram";
  if (creative.object_story_id || creative.effective_object_story_id) return "готовый пост Facebook";
  return "неизвестный тип";
}

// Собирает копию креатива с выключенными улучшениями. null — не знаем, как безопасно скопировать.
function buildCopy(creative: Json, optOut: string[]): Json | null {
  const features: Json = {};
  for (const key of optOut) {
    if (key === "standard_enhancements") {
      for (const part of STANDARD_ENHANCEMENTS_PARTS) features[part] = { enroll_status: "OPT_OUT" };
    } else {
      features[key] = { enroll_status: "OPT_OUT" };
    }
  }

  const baseName = String(creative.name ?? "Креатив").replace(NAME_SUFFIX, "");
  const copy: Json = {
    name: (baseName + NAME_SUFFIX).slice(0, 255),
    degrees_of_freedom_spec: { creative_features_spec: features },
  };
  if (creative.url_tags) copy.url_tags = creative.url_tags;

  if (creative.object_story_spec) {
    const oss = JSON.parse(JSON.stringify(creative.object_story_spec));
    // При чтении Meta отдаёт и хэш, и ссылку на картинку, а при записи принимает что-то одно
    if (oss.link_data?.image_hash) delete oss.link_data.picture;
    if (oss.video_data?.image_hash) delete oss.video_data.image_url;
    if (oss.photo_data?.image_hash) delete oss.photo_data.url;
    for (const att of oss.link_data?.child_attachments ?? []) if (att?.image_hash) delete att.picture;
    copy.object_story_spec = oss;

    if (creative.asset_feed_spec) {
      const afs = JSON.parse(JSON.stringify(creative.asset_feed_spec));
      for (const img of afs.images ?? []) if (img?.hash) delete img.url;
      for (const v of afs.videos ?? []) if (v?.thumbnail_hash) delete v.thumbnail_url;
      copy.asset_feed_spec = afs;
    }
    return copy;
  }

  if (creative.source_instagram_media_id && creative.instagram_user_id) {
    copy.source_instagram_media_id = creative.source_instagram_media_id;
    copy.instagram_user_id = creative.instagram_user_id;
    if (creative.call_to_action_type && creative.link_url) {
      copy.call_to_action = { type: creative.call_to_action_type, value: { link: creative.link_url } };
    } else if (creative.call_to_action_type) {
      return null; // у объявления есть кнопка, а ссылку прочитать не удалось — не рискуем
    }
    return copy;
  }

  const storyId = creative.object_story_id || creative.effective_object_story_id;
  if (storyId) {
    copy.object_story_id = storyId;
    return copy;
  }
  return null;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.META_ACCESS_TOKEN;
  const dryRun = process.env.CREATIVE_FIX_DRY_RUN !== "false";
  const onlyAdId = (process.env.CREATIVE_FIX_ONLY_AD_ID || "").trim();
  const version = process.env.META_API_VERSION || "v23.0";
  const graph = `https://graph.facebook.com/${version}`;
  const rawAccount = (process.env.META_AD_ACCOUNT_ID || "").trim();
  const account = rawAccount ? (rawAccount.startsWith("act_") ? rawAccount : `act_${rawAccount}`) : "";

  const finish = (body: Json, status = 200) => {
    console.log(JSON.stringify(body));
    return NextResponse.json(body, { status });
  };

  if (!token) return finish({ dryRun, error: "нет META_ACCESS_TOKEN" }, 500);
  if (!account) return finish({ dryRun, error: "нет META_AD_ACCOUNT_ID" }, 500);

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

  const report: Json[] = [];
  // Один креатив может стоять в нескольких объявлениях — копию делаем один раз
  const copies = new Map<string, string>();
  const summary = { ads: 0, withAi: 0, changed: 0, wouldChange: 0, clean: 0, skipped: 0, errors: 0, remaining: 0 };
  // Vercel обрывает запуск через 60 секунд, поэтому за один раз меняем столько, сколько успеваем,
  // и пишем отчёт заранее. Остальные объявления — при следующем нажатии Run.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 40_000;

  try {
    // 1. Все активные объявления кабинета вместе с креативами
    const ads: Json[] = [];
    let url: string | undefined =
      `${graph}/${account}/ads?fields=${encodeURIComponent(`id,name,effective_status,creative{${CREATIVE_FIELDS}}`)}` +
      `&effective_status=${encodeURIComponent(JSON.stringify(AD_STATUSES))}` +
      `&limit=50&access_token=${encodeURIComponent(token)}`;
    while (url) {
      const page: Json = await get(url);
      ads.push(...(page.data ?? []));
      url = page.paging?.next;
    }

    // 2. Размеры картинок — чтобы было видно, где возможна обрезка
    const sizes = new Map<string, string>();
    const allHashes = [...new Set(ads.flatMap((a) => imageHashes(a.creative ?? {})))];
    for (let i = 0; i < allHashes.length; i += 50) {
      try {
        const chunk = allHashes.slice(i, i + 50);
        const res = await get(
          `${graph}/${account}/adimages?fields=hash,width,height&limit=100` +
            `&hashes=${encodeURIComponent(JSON.stringify(chunk))}&access_token=${encodeURIComponent(token)}`,
        );
        for (const img of res.data ?? []) {
          if (img.width && img.height) {
            sizes.set(img.hash, `${img.width}×${img.height} (${ratioLabel(img.width, img.height)})`);
          }
        }
      } catch {
        // размеры — справочная информация, без них продолжаем
      }
    }

    // 3. По каждому объявлению: выключаем то, что включено
    for (const ad of ads) {
      if (onlyAdId && ad.id !== onlyAdId) continue;
      summary.ads++;
      const creative: Json = ad.creative ?? {};
      const row: Json = {
        adId: ad.id,
        adName: ad.name,
        creativeId: creative.id,
        kind: creativeKind(creative),
        images: imageHashes(creative).map((h) => sizes.get(h) ?? "размер неизвестен"),
      };

      if (!creative.degrees_of_freedom_spec) {
        summary.clean++;
        report.push({ ...row, aiEnabled: [], action: "улучшения не заданы — не трогаю" });
        continue;
      }
      const enabled = enabledFeatures(creative);
      row.aiEnabled = enabled;
      if (!needsFix(enabled)) {
        summary.clean++;
        report.push({ ...row, action: "ИИ-улучшения уже выключены" });
        continue;
      }
      summary.withAi++;

      const copy = buildCopy(creative, enabled);
      if (!copy) {
        summary.skipped++;
        report.push({ ...row, skipped: "не могу безопасно скопировать этот креатив — выключите улучшения вручную в Ads Manager" });
        continue;
      }
      if (!dryRun && Date.now() - startedAt > TIME_BUDGET_MS) {
        summary.remaining++;
        continue;
      }
      if (dryRun) {
        summary.wouldChange++;
        report.push({ ...row, action: "тестовый режим: выключил бы улучшения" });
        continue;
      }

      try {
        let newId = copies.get(creative.id);
        if (!newId) {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(copy)) params[k] = typeof v === "string" ? v : JSON.stringify(v);
          newId = String((await post(`${account}/adcreatives`, params)).id);
          copies.set(creative.id, newId);
        }
        // Объявление трогаем только после того, как новый креатив успешно создан
        await post(ad.id, { creative: JSON.stringify({ creative_id: newId }) });
        summary.changed++;
        report.push({ ...row, newCreativeId: newId, action: "улучшения выключены, креатив заменён" });
      } catch (e) {
        summary.errors++;
        report.push({ ...row, error: (e as Error).message, action: "объявление не изменено" });
      }
    }
  } catch (e) {
    return finish({ dryRun, error: (e as Error).message, summary, report }, 500);
  }

  return finish({ dryRun, onlyAdId: onlyAdId || undefined, checkedAt: new Date().toISOString(), summary, report });
}
