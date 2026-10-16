// Адреса магазинов для текстов объявлений. Новый магазин — новая строка в нужном городе.
// id совпадает со store_id на сайте и в событиях пикселя.

// lat/lng — координаты торгового центра для гео-круга вокруг магазина
export type AdStore = { id: string; ru: string; kz: string; aliases?: string[]; lat?: number; lng?: number };
export type AdCity = { slug: string; name: string; stores: AdStore[] };

export const adCities: AdCity[] = [
  {
    slug: "almaty",
    name: "Алматы",
    stores: [
      { id: "almaty-forum", lat: 43.2341076, lng: 76.9357949, ru: "📍 Алматы, ТРК Forum, пр. Сейфуллина, 617", kz: "📍 Алматы, ТРК Forum, Сейфуллин даңғылы, 617" },
      { id: "almaty-sputnik", lat: 43.2121981, lng: 76.8421001, ru: "📍 Алматы, Sputnik Mall, мкр. Мамыр-1, 8а", kz: "📍 Алматы, Sputnik Mall, Мамыр-1 шағын ауданы, 8а" },
      { id: "almaty-adk", lat: 43.2329441, lng: 76.8794576, ru: "📍 Алматы, ТРК ADK, ул. Сатпаева, 90", kz: "📍 Алматы, ТРК ADK, Сәтбаев көшесі, 90" },
      { id: "almaty-aport-east", lat: 43.3141539, lng: 77.0235319, ru: "📍 Алматы, Aport Mall East, Кульджинский тракт, 106", kz: "📍 Алматы, Aport Mall East, Құлжа тракты, 106" },
      { id: "almaty-dostyk-plaza", lat: 43.2333933, lng: 76.9568196, ru: "📍 Алматы, Dostyk Plaza, мкр. Самал-2, 111", kz: "📍 Алматы, Dostyk Plaza, Самал-2 шағын ауданы, 111" },
      { id: "almaty-aport", lat: 43.2341162, lng: 76.777293, ru: "📍 Алматы, Молл Апорт, Ташкентский тракт, 17к", kz: "📍 Алматы, Молл Апорт, Ташкент тракты, 17к" },
      { id: "almaty-mega", lat: 43.2016282, lng: 76.8929335, ru: "📍 Алматы, Mega Alma-Ata, ул. Розыбакиева, 247а", kz: "📍 Алматы, Mega Alma-Ata, Розыбакиев көшесі, 247а" },
      { id: "almaty-mega-park", lat: 43.2640471, lng: 76.9295358, ru: "📍 Алматы, MEGA Park, ул. Макатаева, 127/1", kz: "📍 Алматы, MEGA Park, Мақатаев көшесі, 127/1" },
    ],
  },
  {
    slug: "astana",
    name: "Астана",
    stores: [
      { id: "astana-mega-silk-way", lat: 51.0891784, lng: 71.407207, ru: "📍 Астана, MEGA Silk Way, пр. Кабанбай батыра, 62", kz: "📍 Астана, MEGA Silk Way, Қабанбай батыр даңғылы, 62" },
      { id: "astana-khan-shatyr", lat: 51.1324556, lng: 71.4038654, ru: "📍 Астана, Хан Шатыр, пр. Туран, 37", kz: "📍 Астана, Хан Шатыр, Тұран даңғылы, 37" },
    ],
  },
  {
    slug: "shymkent",
    name: "Шымкент",
    stores: [{ id: "shymkent-plaza", lat: 42.3151959, lng: 69.5878913, ru: "📍 Шымкент, Shymkent Plaza, пл. Аль-Фараби, 3/1", kz: "📍 Шымкент, Shymkent Plaza, Әл-Фараби алаңы, 3/1" }],
  },
  {
    slug: "karaganda",
    name: "Караганда",
    stores: [
      { id: "karaganda-global-city", lat: 49.8065446, lng: 73.152444, aliases: ["karaganda-global"], ru: "📍 Караганда, Global City, 134-й учётный квартал, ст921", kz: "📍 Қарағанды, Global City, 134-есептік квартал, ст921" },
      { id: "karaganda-tsum", lat: 49.8035403, lng: 73.0864409, ru: "📍 Караганда, ЦУМ, пр. Бухар-жырау, 53/8", kz: "📍 Қарағанды, ЦУМ, Бұқар жырау даңғылы, 53/8" },
    ],
  },
  {
    slug: "atyrau",
    name: "Атырау",
    stores: [{ id: "atyrau-infinity", lat: 47.1069569, lng: 51.8835025, ru: "📍 Атырау, Infinity Mall, пр. Сатпаева, 43а", kz: "📍 Атырау, Infinity Mall, Сәтбаев даңғылы, 43а" }],
  },
  {
    slug: "aktau",
    name: "Актау",
    stores: [{ id: "aktau-saya-park", lat: 43.6519172, lng: 51.1542535, ru: "📍 Актау, Saya Park, 10-й микрорайон, 3", kz: "📍 Ақтау, Saya Park, 10-шағын аудан, 3" }],
  },
  {
    slug: "ust-kamenogorsk",
    name: "Усть-Каменогорск",
    stores: [{ id: "ust-kamenogorsk-maxi-mall", lat: 49.9196347, lng: 82.6279871, ru: "📍 Усть-Каменогорск, Maxi Mall, пр. Сатпаева, 51", kz: "📍 Өскемен, Maxi Mall, Сәтбаев даңғылы, 51" }],
  },
  {
    slug: "petropavlovsk",
    name: "Петропавловск",
    stores: [{ id: "petropavlovsk-dostyq", lat: 54.8699945, lng: 69.1266102, ru: "📍 Петропавловск, Dostyq Mall, ул. М. Жумабаева, 91", kz: "📍 Петропавл, Dostyq Mall, М. Жұмабаев көшесі, 91" }],
  },
  {
    slug: "uralsk",
    name: "Уральск",
    stores: [{ id: "uralsk-abaya", ru: "📍 Уральск, пр. Абая, 101/1", kz: "📍 Орал, Абай даңғылы, 101/1" }],
  },
];

// Метки, которые ставятся в тексте объявления-образца
export const PLACEHOLDERS_RU = ["{АДРЕСА_RU}", "{ADDR_RU}"];
export const PLACEHOLDERS_KZ = ["{АДРЕСА_KZ}", "{ADDR_KZ}"];

// Адрес сайта: ссылки на него в копиях переводятся на страницу нужного города
export const SITE_HOSTS = ["kotofeyi.site", "www.kotofeyi.site"];

// Метки для адреса одного магазина (а не всех магазинов города)
export const PLACEHOLDERS_STORE_RU = ["{АДРЕС_RU}"];
export const PLACEHOLDERS_STORE_KZ = ["{АДРЕС_KZ}"];
