// pinyin.js — 拼音数据（声母 / 韵母 / 声调 / 拼读 / 教学要点）
//
// 面向越南零基础学员：
//   1. 每个音素都配**例字**，让学员知道这个音出现在什么词里
//   2. 声调用「ma」四声演示，便于理解音调变化
//   3. 教学要点针对越南学员的常见发音难点
//
// audio 字段指向 audio/pinyin/ 下的 mp3（离线播放）

// ---------------------------------------------------------------- 声母（21 个，完整）
// sound = 呼读音（本音+一个韵母拼出的音节），零基础学员靠它建立「字母怎么读」的第一印象，
// 例如 b → bo、zh → zhi。这是汉语拼音教学的标准注音方式。
const PINYIN_INITIALS = [
  { id: 'b', display: 'b', sound: 'bo', audio: 'initial-b.mp3', labialType: 'bilabial', example: '爸 bà', tip: 'Âm hai môi', say: '玻' },
  { id: 'p', display: 'p', sound: 'po', audio: 'initial-p.mp3', labialType: 'bilabial', example: '朋 péng', tip: 'Hai môi bật hơi', say: '坡' },
  { id: 'm', display: 'm', sound: 'mo', audio: 'initial-m.mp3', labialType: 'bilabial', example: '妈 mā', tip: 'Hai môi vang', say: '摸' },
  { id: 'f', display: 'f', sound: 'fo', audio: 'initial-f.mp3', labialType: 'labiodental', example: '飞 fēi', tip: 'Âm môi răng', say: '佛' },
  { id: 'd', display: 'd', sound: 'de', audio: 'initial-d.mp3', labialType: 'alveolar', example: '大 dà', tip: 'Âm đầu lưỡi', say: '得' },
  { id: 't', display: 't', sound: 'te', audio: 'initial-t.mp3', labialType: 'alveolar', example: '他 tā', tip: 'Đầu lưỡi bật hơi', say: '特' },
  { id: 'n', display: 'n', sound: 'ne', audio: 'initial-n.mp3', labialType: 'alveolar', example: '你 nǐ', tip: 'Đầu lưỡi vang', say: '呢' },
  { id: 'l', display: 'l', sound: 'le', audio: 'initial-l.mp3', labialType: 'lateral', example: '来 lái', tip: 'Đầu lưỡi bên', say: '勒' },
  { id: 'g', display: 'g', sound: 'ge', audio: 'initial-g.mp3', labialType: 'velar', example: '哥 gē', tip: 'Âm cuối lưỡi', say: '哥' },
  { id: 'k', display: 'k', sound: 'ke', audio: 'initial-k.mp3', labialType: 'velar', example: '看 kàn', tip: 'Cuối lưỡi bật hơi', say: '科' },
  { id: 'h', display: 'h', sound: 'he', audio: 'initial-h.mp3', labialType: 'velar', example: '好 hǎo', tip: 'Cuối lưỡi khí', say: '喝' },
  { id: 'j', display: 'j', sound: 'ji', audio: 'initial-j.mp3', labialType: 'alveolopalatal', example: '家 jiā', tip: 'Âm đầu lưỡi khum', say: '机' },
  { id: 'q', display: 'q', sound: 'qi', audio: 'initial-q.mp3', labialType: 'alveolopalatal', example: '去 qù', tip: 'Đầu lưỡi khum bật hơi', say: '欺' },
  { id: 'x', display: 'x', sound: 'xi', audio: 'initial-x.mp3', labialType: 'alveolopalatal', example: '学 xué', tip: 'Đầu lưỡi khum khí', say: '西' },
  { id: 'zh', display: 'zh', sound: 'zhi', audio: 'initial-zh.mp3', labialType: 'retroflex', example: '中 zhōng', tip: 'Lưỡi cuộn lên', say: '知' },
  { id: 'ch', display: 'ch', sound: 'chi', audio: 'initial-ch.mp3', labialType: 'retroflex', example: '吃 chī', tip: 'Lưỡi cuộn, bật hơi', say: '吃' },
  { id: 'sh', display: 'sh', sound: 'shi', audio: 'initial-sh.mp3', labialType: 'retroflex', example: '书 shū', tip: 'Lưỡi cuộn, khí', say: '诗' },
  { id: 'r', display: 'r', sound: 'ri', audio: 'initial-r.mp3', labialType: 'retroflex', example: '热 rè', tip: 'Lưỡi cuộn, vang', say: '日' },
  { id: 'z', display: 'z', sound: 'zi', audio: 'initial-z.mp3', labialType: 'dental', example: '在 zài', tip: 'Lưỡi phẳng', say: '资' },
  { id: 'c', display: 'c', sound: 'ci', audio: 'initial-c.mp3', labialType: 'dental', example: '才 cái', tip: 'Lưỡi phẳng, bật hơi', say: '雌' },
  { id: 's', display: 's', sound: 'si', audio: 'initial-s.mp3', labialType: 'dental', example: '三 sān', tip: 'Lưỡi phẳng, khí', say: '思' },
];

// ---------------------------------------------------------------- 韵母（36 个，完整）
const PINYIN_FINALS = [
  // 单韵母 6
  { id: 'a', display: 'a', audio: 'final-a1.mp3', group: 'simple', example: '啊 ā', tip: '单韵母', say: '阿' },
  { id: 'o', display: 'o', audio: 'final-o1.mp3', group: 'simple', example: '哦 ó', tip: '单韵母', say: '哦' },
  { id: 'e', display: 'e', audio: 'final-e1.mp3', group: 'simple', example: '鹅 é', tip: '单韵母', say: '鹅' },
  { id: 'i', display: 'i', audio: 'final-i1.mp3', group: 'simple', example: '衣 yī', tip: '单韵母', say: '衣' },
  { id: 'u', display: 'u', audio: 'final-u1.mp3', group: 'simple', example: '乌 wū', tip: '单韵母', say: '乌' },
  { id: 'ü', display: 'ü', audio: 'final-v1.mp3', group: 'simple', example: '鱼 yú', tip: '单韵母 ü', say: '鱼' },
  // 复韵母 9
  { id: 'ai', display: 'ai', audio: 'final-ai1.mp3', group: 'compound', example: '爱 ài', tip: '复韵母', say: '哀' },
  { id: 'ei', display: 'ei', audio: 'final-ei1.mp3', group: 'compound', example: '给 gěi', tip: '复韵母', say: '诶' },
  { id: 'ao', display: 'ao', audio: 'final-ao1.mp3', group: 'compound', example: '好 hǎo', tip: '复韵母', say: '奥' },
  { id: 'ou', display: 'ou', audio: 'final-ou1.mp3', group: 'compound', example: '有 yǒu', tip: '复韵母', say: '欧' },
  { id: 'ie', display: 'ie', audio: 'final-ie1.mp3', group: 'compound', example: '写 xiě', tip: '复韵母', say: '椰' },
  { id: 'üe', display: 'üe', audio: 'final-ve1.mp3', group: 'compound', example: '月 yuè', tip: '复韵母 üe', say: '约' },
  { id: 'an', display: 'an', audio: 'final-an1.mp3', group: 'nasal', example: '安 ān', tip: '前鼻韵母', say: '安' },
  { id: 'en', display: 'en', audio: 'final-en1.mp3', group: 'nasal', example: '恩 ēn', tip: '前鼻韵母', say: '恩' },
  { id: 'in', display: 'in', audio: 'final-in1.mp3', group: 'nasal', example: '心 xīn', tip: '前鼻韵母', say: '音' },
  { id: 'un', display: 'un', audio: 'final-un1.mp3', group: 'nasal', example: '春 chūn', tip: '前鼻韵母', say: '温' },
  { id: 'ün', display: 'ün', audio: 'final-vn1.mp3', group: 'nasal', example: '云 yún', tip: '前鼻韵母 ün', say: '晕' },
  { id: 'ang', display: 'ang', audio: 'final-ang1.mp3', group: 'nasal', example: '昂 áng', tip: '后鼻韵母', say: '昂' },
  { id: 'eng', display: 'eng', audio: 'final-eng1.mp3', group: 'nasal', example: '灯 dēng', tip: '后鼻韵母', say: '鞥' },
  { id: 'ing', display: 'ing', audio: 'final-ing1.mp3', group: 'nasal', example: '星 xīng', tip: '后鼻韵母', say: '英' },
  { id: 'ong', display: 'ong', audio: 'final-ong1.mp3', group: 'nasal', example: '中 zhōng', tip: '后鼻韵母', say: '中' },
  // 复韵母+鼻韵母 8
  { id: 'ia', display: 'ia', audio: 'final-ia1.mp3', group: 'mixed', example: '家 jiā', tip: '复韵母', say: '鸭' },
  { id: 'ua', display: 'ua', audio: 'final-ua1.mp3', group: 'mixed', example: '花 huā', tip: '复韵母', say: '蛙' },
  { id: 'uo', display: 'uo', audio: 'final-uo1.mp3', group: 'mixed', example: '多 duō', tip: '复韵母', say: '窝' },
  { id: 'uai', display: 'uai', audio: 'final-uai1.mp3', group: 'mixed', example: '快 kuài', tip: '复韵母', say: '歪' },
  { id: 'ui', display: 'ui', audio: 'final-ui1.mp3', group: 'mixed', example: '水 shuǐ', tip: '复韵母', say: '威' },
  { id: 'iu', display: 'iu', audio: 'final-iu1.mp3', group: 'mixed', example: '六 liù', tip: '复韵母', say: '优' },
  { id: 'ian', display: 'ian', audio: 'final-ian1.mp3', group: 'mixed', example: '天 tiān', tip: '前鼻韵母', say: '烟' },
  { id: 'iang', display: 'iang', audio: 'final-iang1.mp3', group: 'mixed', example: '想 xiǎng', tip: '后鼻韵母', say: '羊' },
  { id: 'uang', display: 'uang', audio: 'final-uang1.mp3', group: 'mixed', example: '光 guāng', tip: '后鼻韵母', say: '汪' },
  { id: 'ueng', display: 'ueng', audio: 'final-ueng1.mp3', group: 'mixed', example: '翁 wēng', tip: '后鼻韵母', say: '翁' },
  // 特殊 2
  { id: 'er', display: 'er', audio: 'final-er1.mp3', group: 'special', example: '儿 ér', tip: '特殊韵母', say: '儿' },
  { id: 'ê', display: 'ê', audio: 'final-e1.mp3', group: 'special', example: '欸 ē', tip: '特殊韵母 ê', say: '欸' },
];

// ---------------------------------------------------------------- 声调（4）
const PINYIN_TONES = [
  { id: 'tone1', display: 'mā', mark: 'Thanh 1 · 第一声', audio: 'tone-ma1.mp3', example: '妈 mā', tip: 'Cao, phẳng · 高平', say: '妈' },
  { id: 'tone2', display: 'má', mark: 'Thanh 2 · 第二声', audio: 'tone-ma2.mp3', example: '麻 má', tip: 'Cao, lên · 高升', say: '麻' },
  { id: 'tone3', display: 'mǎ', mark: 'Thanh 3 · 第三声', audio: 'tone-ma3.mp3', example: '马 mǎ', tip: 'Thấp rồi lên · 低降', say: '马' },
  { id: 'tone4', display: 'mà', mark: 'Thanh 4 · 第四声', audio: 'tone-ma4.mp3', example: '骂 mà', tip: 'Cao rồi xuống · 高降', say: '骂' },
];

// ---------------------------------------------------------------- 拼读练习（声母+韵母+声调 = 音节）
const PINYIN_SYLLABLES = [
  { text: 'bā', parts: ['b', 'a', '1'], example: '八 bā' },
  { text: 'mā', parts: ['m', 'a', '1'], example: '妈 mā' },
  { text: 'dà', parts: ['d', 'a', '4'], example: '大 dà' },
  { text: 'tā', parts: ['t', 'a', '1'], example: '他 tā' },
  { text: 'nǐ', parts: ['n', 'i', '3'], example: '你 nǐ' },
  { text: 'hǎo', parts: ['h', 'ao', '3'], example: '好 hǎo' },
  { text: 'lǎo', parts: ['l', 'ao', '3'], example: '老 lǎo' },
  { text: 'chī', parts: ['ch', 'i', '1'], example: '吃 chī' },
  { text: 'shū', parts: ['sh', 'u', '1'], example: '书 shū' },
  { text: 'zhōng', parts: ['zh', 'ong', '1'], example: '中 zhōng' },
  { text: 'guó', parts: ['g', 'uo', '2'], example: '国 guó' },
  { text: 'xué', parts: ['x', 'üe', '2'], example: '学 xué' },
  { text: 'jiā', parts: ['j', 'ia', '1'], example: '家 jiā' },
  { text: 'qù', parts: ['q', 'ü', '4'], example: '去 qù' },
  { text: 'shuǐ', parts: ['sh', 'ui', '3'], example: '水 shuǐ' },
  { text: 'nián', parts: ['n', 'ian', '2'], example: '年 nián' },
];

// ---------------------------------------------------------------- 教学要点（越南学员常见难点）
const PINYIN_TIPS = [
  {
    title: '平舌与翘舌要分清',
    desc: 'z / c / s 是平舌（舌尖平放），zh / ch / sh 是翘舌（舌尖上翘）。越南语没有这个区别，需要刻意练习。',
    titleVi: 'Phân biệt âm đầu lưỡi thòi và lưỡi cuộn',
    descVi: 'z / c / s là âm đầu lưỡi thòi (đầu lưỡi đặt phẳng); zh / ch / sh là âm đầu lưỡi cuộn (đầu lưỡi cong lên). Tiếng Việt không có sự phân biệt này, cần luyện tập có chủ đích.',
    titleEn: 'Flat vs. retroflex initials',
    descEn: 'z / c / s are flat (tongue tip flat); zh / ch / sh are retroflex (tongue tip curled up). Vietnamese has no such contrast — practise it deliberately.',
  },
  {
    title: 'j / q / x 不要读成 z / c / s',
    desc: '这三个声母发音时舌面靠近硬腭，类似越南语的「gi–kh–ti」，若读成 z/c/s 会听起来像「资–次–思」。',
    titleVi: 'Đừng đọc j / q / x thành z / c / s',
    descVi: 'Ba âm đầu này phát âm bằng lưỡi áp sát vòm hàm cứng, gần với "gi–kh–ti" của tiếng Việt. Nếu đọc thành z/c/s sẽ nghe như "tư–từ–tư".',
    titleEn: 'Do not read j / q / x as z / c / s',
    descEn: 'These three initials are articulated with the tongue blade against the hard palate, like Vietnamese "gi–kh–ti". Read as z/c/s they sound like "tse–tsu–tsse".',
  },
  {
    title: 'ü 上两点不能省',
    desc: 'j/q/x + ü 要写成 ju/qu/xu 去掉两点，否则读错。例如「去 qù」实为 q + ü。',
    titleVi: 'Không được bỏ hai chấm trên của ü',
    descVi: 'Khi j/q/x đi với ü thì phải viết thành ju/qu/xu (bỏ hai chấm), nếu không sẽ đọc sai. Ví dụ "去 qù" thực ra là q + ü.',
    titleEn: 'Never drop the dots on ü',
    descEn: 'After j/q/x, ü is written ju/qu/xu with the dots omitted, otherwise you will mispronounce. E.g. 去 qù is actually q + ü.',
  },
  {
    title: '第三声要降到底',
    desc: '越南语没有三声，读 mǎ（马）时容易读成 má（麻）。要明显降到底再回升。',
    titleVi: 'Thanh ngang ba phải hạ hẳn xuống',
    descVi: 'Tiếng Việt không có thanh ngang ba, nên đọc mǎ (马) dễ thành má (麻). Hãy hạ giọng hẳn xuống đáy rồi mới vang lên.',
    titleEn: 'Tone 3 must fall all the way',
    descEn: 'Vietnamese has no dipping tone, so mǎ (马) easily becomes má (麻). Drop the pitch clearly to the bottom before rising.',
  },
  {
    title: '前鼻音与后鼻音',
    desc: 'an/en/in/ün 是前鼻音（舌尖抵上齿龈），ang/eng/ing 是后鼻音（舌根上抬），区别在于收音位置。',
    titleVi: 'Phân biệt mũi trước và mũi sau',
    descVi: 'an/en/in/ün là mũi trước (đầu lưỡi chạm chân răng trên); ang/eng/ing là mũi sau (gốc lưỡi nhô lên). Khác nhau ở vị trí âm cuối.',
    titleEn: 'Front vs. back nasals',
    descEn: 'an/en/in/ün are front nasals (tongue tip at the alveolar ridge); ang/eng/ing are back nasals (tongue root raised). The difference is where the nasal ends.',
  },
  {
    title: '整体认读音节',
    desc: 'zhi chi shi ri zi ci si yi wu yu ye yue yuan yin yun ying 直接读出，不用拼。',
    titleVi: 'Âm tiết đọc liền',
    descVi: 'zhi chi shi ri zi ci si yi wu yu ye yue yuan yin yun ying đọc thẳng ra, không cần ghép âm.',
    titleEn: 'Whole-syllable readings',
    descEn: 'zhi chi shi ri zi ci si yi wu yu ye yue yuan yin yun ying are read as a whole — no blending required.',
  },
];

// 韵母分组标签（供 UI 分组展示）
const PINYIN_FINAL_GROUPS = [
  { key: 'simple', label: '单韵母', labelVi: 'Nguyên âm đơn' },
  { key: 'compound', label: '复韵母', labelVi: 'Nguyên âm phức' },
  { key: 'nasal', label: '鼻韵母', labelVi: 'Nguyên âm mũi' },
  { key: 'mixed', label: '复韵母+鼻韵母', labelVi: 'Phức + mũi' },
  { key: 'special', label: '特殊韵母', labelVi: 'Nguyên âm đặc biệt' },
];

// 声母唇形分组（讲解用）
const PINYIN_INITIAL_GROUPS = [
  { key: 'bilabial', label: '双唇音', labelVi: 'Hai môi (b p m)' },
  { key: 'labiodental', label: '唇齿音', labelVi: 'Môi răng (f)' },
  { key: 'dental', label: '平舌音', labelVi: 'Lưỡi phẳng (z c s)' },
  { key: 'alveolar', label: '舌尖中音', labelVi: 'Đầu lưỡi (d t n l)' },
  { key: 'retroflex', label: '翘舌音', labelVi: 'Lưỡi cuộn (zh ch sh r)' },
  { key: 'alveolopalatal', label: '舌面音', labelVi: 'Đầu lưỡi khum (j q x)' },
  { key: 'velar', label: '舌根音', labelVi: 'Cuối lưỡi (g k h)' },
  { key: 'lateral', label: '边音', labelVi: 'Lưỡi bên (l)' },
];