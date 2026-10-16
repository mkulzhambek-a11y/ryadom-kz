// Правила исправления текстов объявлений (скрипт /api/text-fix).
// Текст объявления состоит из двух блоков: казахского и русского, каждый со своими адресами.

const RU_HEAD = /^К+отофей — удобная/;
const KZ_HEAD = /^К+отофей — балаңызға/;

const RU_PROMO = /^(До 31 октября )?[−-]\s?30% на кажд\S+ втор\S+ (товар|вещь) в чеке\.?\*?$/i;
const KZ_PROMO = /^(31 қазанға дейін )?[Чч]ектегі әр(бір)? екінші тауарға [−-]\s?30%\.?\*?$/i;
const RU_ONLY_STORES = /^Акция действует только в магазинах\.?$/i;
const KZ_ONLY_STORES = /^Акция тек дүкендерде (жарамды|қолданылады)\.?$/i;

const RU_PROMO_NEW = "До 31 октября −30% на каждую вторую вещь в чеке.";
const RU_ONLY_NEW = "Акция действует только в магазинах.";
const KZ_PROMO_NEW = "31 қазанға дейін чектегі әрбір екінші тауарға −30%.";
const KZ_ONLY_NEW = "Акция тек дүкендерде қолданылады.";

function fixBlock(block: string, lang: "ru" | "kz"): string {
  const promo = lang === "ru" ? RU_PROMO : KZ_PROMO;
  const only = lang === "ru" ? RU_ONLY_STORES : KZ_ONLY_STORES;
  const promoNew = lang === "ru" ? RU_PROMO_NEW : KZ_PROMO_NEW;
  const onlyNew = lang === "ru" ? RU_ONLY_NEW : KZ_ONLY_NEW;

  let lines = block.split("\n").map((l) => l.trim());
  lines = lines.map((l) => l.replace(/^К+отофей/, "Котофей"));
  const hasPromo = lines.some((l) => promo.test(l));
  if (hasPromo) {
    lines = lines.filter((l) => !only.test(l)); // строку «только в магазинах» ставим заново сразу после скидки
    const out: string[] = [];
    for (const l of lines) {
      if (promo.test(l)) out.push(promoNew, onlyNew);
      else out.push(l);
    }
    lines = out;
  }
  // оформление: после заголовка пустая строка, перед первым адресом пустая строка, без двойных пустых строк
  const head = lines.findIndex((l) => l !== "");
  if (head >= 0 && lines[head + 1] !== "") lines.splice(head + 1, 0, "");
  const firstAddr = lines.findIndex((l) => l.startsWith("📍"));
  if (firstAddr > 0 && lines[firstAddr - 1] !== "") lines.splice(firstAddr, 0, "");
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

/** Исправленный текст. kzFirst — казахский блок первым (для объявлений с пометкой kz). */
export function fixText(text: string, kzFirst: boolean): string {
  const lines = text.split("\n");
  const ruStart = lines.findIndex((l) => RU_HEAD.test(l.trim()));
  const kzStart = lines.findIndex((l) => KZ_HEAD.test(l.trim()));
  if (ruStart < 0 || kzStart < 0) {
    // текст не в обычном формате — правим только опечатку
    return text.replace(/(^|\n)К+отофей/g, "$1Котофей");
  }
  const cut = (from: number, to: number) => lines.slice(from, to).join("\n");
  const ru = ruStart > kzStart ? cut(ruStart, lines.length) : cut(ruStart, kzStart);
  const kz = kzStart > ruStart ? cut(kzStart, lines.length) : cut(kzStart, ruStart);
  const ruFixed = fixBlock(ru, "ru");
  const kzFixed = fixBlock(kz, "kz");
  return kzFirst ? `${kzFixed}\n\n${ruFixed}` : `${ruFixed}\n\n${kzFixed}`;
}

export const isKzAd = (name: string) => /(^|[\s\-_])kz($|[\s\-_])/i.test(name);
