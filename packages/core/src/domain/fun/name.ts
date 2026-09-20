import type { RandomSource } from '../../ports/random-source.js';

const CN_SURNAMES = [
  '李',
  '王',
  '张',
  '刘',
  '陈',
  '杨',
  '赵',
  '黄',
  '周',
  '吴',
  '徐',
  '孙',
  '胡',
  '朱',
  '高',
  '林',
  '何',
  '郭',
  '马',
  '罗',
  '梁',
  '宋',
  '郑',
  '谢',
  '韩',
  '唐',
  '冯',
  '于',
  '董',
  '萧',
  '程',
  '曹',
  '袁',
  '邓',
  '许',
  '傅',
  '沈',
  '曾',
  '彭',
  '吕',
];

const CN_MALE_NAMES = [
  '伟',
  '强',
  '军',
  '杰',
  '涛',
  '明',
  '超',
  '勇',
  '辉',
  '刚',
  '峰',
  '磊',
  '浩',
  '波',
  '俊',
  '凯',
  '浩然',
  '志明',
  '天宇',
  '子豪',
  '文博',
  '星辰',
  '宇航',
  '致远',
  '泽洋',
  '俊杰',
  '博远',
  '思远',
];

const CN_FEMALE_NAMES = [
  '芳',
  '娜',
  '敏',
  '静',
  '秀',
  '娟',
  '英',
  '华',
  '慧',
  '巧',
  '美',
  '静文',
  '若曦',
  '雨婷',
  '梦琪',
  '依诺',
  '语嫣',
  '诗涵',
  '心怡',
  '子萱',
  '欣怡',
  '美琪',
  '雅涵',
  '思涵',
  '若彤',
  '佳怡',
  '文婷',
];

const EN_SURNAMES = [
  { en: 'Smith', cn: '史密斯' },
  { en: 'Johnson', cn: '约翰逊' },
  { en: 'Williams', cn: '威廉姆斯' },
  { en: 'Brown', cn: '布朗' },
  { en: 'Jones', cn: '琼斯' },
  { en: 'Miller', cn: '米勒' },
  { en: 'Davis', cn: '戴维斯' },
  { en: 'Wilson', cn: '威尔逊' },
  { en: 'Taylor', cn: '泰勒' },
  { en: 'Anderson', cn: '安德森' },
];

const EN_MALE_FIRST = [
  { en: 'James', cn: '詹姆斯' },
  { en: 'John', cn: '约翰' },
  { en: 'Robert', cn: '罗伯特' },
  { en: 'Michael', cn: '迈克尔' },
  { en: 'William', cn: '威廉' },
  { en: 'David', cn: '大卫' },
  { en: 'Richard', cn: '理查德' },
  { en: 'Thomas', cn: '托马斯' },
];

const EN_FEMALE_FIRST = [
  { en: 'Mary', cn: '玛丽' },
  { en: 'Patricia', cn: '帕特丽夏' },
  { en: 'Jennifer', cn: '珍妮弗' },
  { en: 'Linda', cn: '琳达' },
  { en: 'Elizabeth', cn: '伊丽莎白' },
  { en: 'Barbara', cn: '芭芭拉' },
  { en: 'Susan', cn: '苏珊' },
  { en: 'Jessica', cn: '杰西卡' },
];

const JP_SURNAMES = [
  { kanji: '佐藤', hiragana: 'さとう' },
  { kanji: '鈴木', hiragana: 'すずき' },
  { kanji: '高橋', hiragana: 'たかはし' },
  { kanji: '田中', hiragana: 'たなか' },
  { kanji: '渡辺', hiragana: 'わたなべ' },
  { kanji: '伊藤', hiragana: 'いとう' },
  { kanji: '山本', hiragana: 'やまもと' },
  { kanji: '中村', hiragana: 'なかむら' },
];

const JP_MALE_NAMES = [
  { kanji: '翔太', hiragana: 'しょうた' },
  { kanji: '蓮', hiragana: 'れん' },
  { kanji: '悠真', hiragana: 'ゆうま' },
  { kanji: '大翔', hiragana: 'ひろと' },
  { kanji: '健太', hiragana: 'けんた' },
  { kanji: '拓海', hiragana: 'たくみ' },
];

const JP_FEMALE_NAMES = [
  { kanji: '陽菜', hiragana: 'ひな' },
  { kanji: '結衣', hiragana: 'ゆい' },
  { kanji: '美咲', hiragana: 'みさき' },
  { kanji: '葵', hiragana: 'あおい' },
  { kanji: '凛', hiragana: 'りん' },
  { kanji: 'さくら', hiragana: 'さくら' },
];

const DND_ELF_NAMES = [
  '阿达玛尔·星语',
  '埃隆·银叶',
  '西尔维娅·月影',
  '法拉诺尔·晨露',
  '凯尔萨斯·炎风',
  '艾莉萨·碧落',
  '莉兰达·绿风',
  '凡蕾丝·日冕',
];

const DND_DWARF_NAMES = [
  '布鲁诺·战锤',
  '达格林·铁须',
  '托尔丁·岩盔',
  '索林·橡木盾',
  '黑尔加·铜心',
  '巴林·红石',
  '莫格林·烈酒',
  '丹德·重金',
];

const DND_ORC_NAMES = [
  '格罗姆·血吼',
  '杜隆坦·霜狼',
  '卡加斯·碎手',
  '奥格瑞姆·毁灭之锤',
  '古尔丹·暗影',
  '萨鲁法尔·铁拳',
  '布洛克斯·巨斧',
  '纳兹格林·战吼',
];

const DND_DAMARA_NAMES = ['阿列克·冬河', '米蕾娜·白松', '博里斯·霜径', '娜佳·晨钟'];

const DND_CALIMSHAN_NAMES = ['扎希尔·阿萨德', '莱拉·纳吉尔', '卡西姆·萨法', '法蒂玛·拉希德'];

const DND_RASHEMEN_NAMES = ['伊万·雷歌', '塔季扬娜·鹰雪', '米哈伊尔·黑林', '叶莲娜·风纹'];

const DND_SHOU_NAMES = ['梁远舟', '顾青岚', '沈月白', '陆昭明'];

const DND_SEA_NAMES = ['涟歌·潮汐', '深蓝·逐浪', '珊影·静湾', '沧鸣·远礁'];

const DND_GOBLIN_NAMES = ['咔嗒·铜扣', '吱牙·碎锅', '泥点·快脚', '嘎啦·亮帽'];

const DND_NAME_POOLS: Readonly<Record<string, readonly string[]>> = {
  达马拉: DND_DAMARA_NAMES,
  卡林珊: DND_CALIMSHAN_NAMES,
  莱瑟曼: DND_RASHEMEN_NAMES,
  受国: DND_SHOU_NAMES,
  精灵: DND_ELF_NAMES,
  矮人: DND_DWARF_NAMES,
  兽人: DND_ORC_NAMES,
  海族: DND_SEA_NAMES,
  地精: DND_GOBLIN_NAMES,
};

export async function generateRandomName(
  type: 'cn' | 'en' | 'jp',
  count: number,
  gender: 'M' | 'F' | 'any',
  random: RandomSource,
): Promise<string[]> {
  const names: string[] = [];
  const boundedCount = Math.max(1, Math.min(10, count));

  for (let i = 0; i < boundedCount; i++) {
    const isMale =
      gender === 'M' ? true : gender === 'F' ? false : (await random.integer(0, 1)) === 1;

    if (type === 'cn') {
      const sIdx = await random.integer(0, CN_SURNAMES.length - 1);
      const surname = CN_SURNAMES[sIdx] ?? '李';
      const namePool = isMale ? CN_MALE_NAMES : CN_FEMALE_NAMES;
      const nIdx = await random.integer(0, namePool.length - 1);
      const givenName = namePool[nIdx] ?? '华';
      names.push(`${surname}${givenName}`);
    } else if (type === 'en') {
      const sIdx = await random.integer(0, EN_SURNAMES.length - 1);
      const surname = EN_SURNAMES[sIdx] ?? { en: 'Smith', cn: '史密斯' };
      const namePool = isMale ? EN_MALE_FIRST : EN_FEMALE_FIRST;
      const nIdx = await random.integer(0, namePool.length - 1);
      const first = namePool[nIdx] ?? { en: 'John', cn: '约翰' };
      names.push(`${first.en} ${surname.en} (${first.cn}·${surname.cn})`);
    } else if (type === 'jp') {
      const sIdx = await random.integer(0, JP_SURNAMES.length - 1);
      const surname = JP_SURNAMES[sIdx] ?? { kanji: '田中', hiragana: 'たなか' };
      const namePool = isMale ? JP_MALE_NAMES : JP_FEMALE_NAMES;
      const nIdx = await random.integer(0, namePool.length - 1);
      const given = namePool[nIdx] ?? { kanji: '翔太', hiragana: 'しょうた' };
      names.push(`${surname.kanji} ${given.kanji} (${surname.hiragana} ${given.hiragana})`);
    }
  }

  return names;
}

export async function generateDndName(
  race: string,
  count: number,
  random: RandomSource,
): Promise<string[]> {
  const boundedCount = Math.max(1, Math.min(10, count));
  const lower = race.toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    elf: '精灵',
    dwarf: '矮人',
    orc: '兽人',
    goblin: '地精',
  };
  const key = aliases[lower] ?? race;
  const pool = DND_NAME_POOLS[key] ?? DND_ELF_NAMES;

  const names: string[] = [];
  for (let i = 0; i < boundedCount; i++) {
    const idx = await random.integer(0, pool.length - 1);
    names.push(pool[idx] ?? pool[0] ?? '无名旅者');
  }
  return names;
}
