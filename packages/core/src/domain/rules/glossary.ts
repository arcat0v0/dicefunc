export interface RuleGlossaryEntry {
  readonly id: number;
  readonly title: string;
  readonly ruleSet: 'coc7' | 'dnd5e' | 'general';
  readonly keywords: readonly string[];
  readonly content: string;
}

export const BUILTIN_RULE_GLOSSARY: readonly RuleGlossaryEntry[] = [
  {
    id: 1,
    title: '理智检定 (Sanity Check / SC)',
    ruleSet: 'coc7',
    keywords: ['sc', '理智', 'san', '理智检定', '疯狂'],
    content:
      '调查员目睹令人震惊或超自然的恐怖景象时须进行理智检定。投掷1D100，小于等于当前理智值则成功，否则失败。根据场景扣除相应理智值。单次损失≥5点可能陷入临时疯狂；单日累计损失≥初始1/5陷入不定性疯狂；理智归0则永久疯狂。',
  },
  {
    id: 2,
    title: '成功度判定 (COC7)',
    ruleSet: 'coc7',
    keywords: ['大成功', '困难成功', '极难成功', '常规成功', '大失败', '成功度'],
    content:
      'COC7检定出目判定阶梯：出目1为大成功；出目≤技能/5为极难成功；出目≤技能/2为困难成功；出目≤技能为常规成功；出目>技能为失败。技能<50时出目≥96为大失败；技能≥50时出目100为大失败。',
  },
  {
    id: 3,
    title: '奖励骰与惩罚骰 (Bonus / Penalty Dice)',
    ruleSet: 'coc7',
    keywords: ['奖励骰', '惩罚骰', '奖惩骰', 'bonus', 'penalty', 'b1', 'p1'],
    content:
      '有利或不利条件下的检定。投掷1个个位数骰和多个十位数骰（1+奖惩骰数量），组合后取最小值（奖励骰）或最大值（惩罚骰）作为出目。00与0组合计为100。',
  },
  {
    id: 4,
    title: '技能成长检定 (Skill Growth / .en)',
    ruleSet: 'coc7',
    keywords: ['成长', '技能成长', 'en', '改善'],
    content:
      '跑团幕间调查员在成功使用过的技能上可进行成长检定。投掷1D100，若出目大于当前技能值或出目>95，则成长成功，投掷1D10并将点数加到该技能上。技能值可通过此方式超过100%。',
  },
  {
    id: 5,
    title: '死亡豁免 (Death Saving Throw / .ds)',
    ruleSet: 'dnd5e',
    keywords: ['死亡豁免', 'ds', '伤势稳定', '气绝', '昏迷'],
    content:
      'DND5e角色生命值降至0且未直接死亡时，每回合开始进行死亡豁免检定。投掷1D20无加值：≥10成功，<10失败；出目20回复1点HP并苏醒；出目1计2次失败。累计3次成功伤势稳定，累计3次失败角色死亡。',
  },
  {
    id: 6,
    title: '先攻与战斗轮 (Initiative / .init)',
    ruleSet: 'dnd5e',
    keywords: ['先攻', 'init', 'ri', '战斗轮', '回合'],
    content:
      '战斗开始时每位参战者投掷先攻：1D20+敏捷调整值。先攻值高者先行动。战斗以轮（Round，约6秒）为单位，由主持人按先攻降序推进每位参战者的回合（Turn）。',
  },
  {
    id: 7,
    title: '生命值与临时生命 (HP & TempHP)',
    ruleSet: 'dnd5e',
    keywords: ['hp', '生命值', '临时生命', 'temphp', '伤害', '治疗'],
    content:
      '角色受到伤害时，优先扣减临时生命值（TempHP），扣至0后的过量伤害再扣减当前HP。治疗加血不能超过最大生命值上限（MaxHP）。临时生命不可叠加，仅取最高值。',
  },
  {
    id: 8,
    title: '休息机制 (Rest / 短休与长休)',
    ruleSet: 'dnd5e',
    keywords: ['长休', '短休', 'longrest', 'rest', '恢复'],
    content:
      '长休（Long Rest）需至少8小时：生命值完全回满，临时生命清空，死亡豁免标记重置，所有已用法术位恢复。短休（Short Rest）需至少1小时：可通过消耗生命骰回复HP。',
  },
  {
    id: 9,
    title: '法术位 (Spell Slots / .ss)',
    ruleSet: 'dnd5e',
    keywords: ['法术位', 'ss', 'spell', '施法', '环阶'],
    content:
      '施法者每日拥有的各环阶施法资源配额（1~9环）。施展特定环阶法术须消耗相应环阶（或更高环阶）的一个法术位。完成长休后所有法术位完全恢复。',
  },
  {
    id: 10,
    title: '属性调整值 (Ability Modifier)',
    ruleSet: 'dnd5e',
    keywords: ['属性调整值', '调整值', 'modifier', '属性值', '力量', '敏捷'],
    content:
      'DND5e核心六维属性推算调整值公式：Modifier = Math.floor((Attribute - 10) / 2)。例如16力量调整值为+3，8敏捷调整值为-1。',
  },
  {
    id: 11,
    title: '通用骰式与重复投掷',
    ruleSet: 'general',
    keywords: ['骰式', 'roll', 'r', 'rd', '重复', 'n#'],
    content:
      '通用掷骰接受 NdM、加减乘除和括号；N# 前缀用于重复独立投掷。省略骰面时使用会话默认骰面。涉及状态变更的指令不应通过重复前缀批量执行。',
  },
  {
    id: 12,
    title: '角色卡库与当前绑定',
    ruleSet: 'general',
    keywords: ['角色卡', 'pc', 'character', '绑定', 'load', 'save'],
    content:
      '角色卡归属于当前身份。创建、保存、加载、改名和删除都按所有权校验；群内当前卡绑定只影响该身份在该会话中的规则指令。',
  },
  {
    id: 13,
    title: '可信暗骰身份绑定',
    ruleSet: 'general',
    keywords: ['暗骰', 'rh', 'rah', 'rch', '绑定', 'rhbind'],
    content:
      '群聊暗骰结果只发送到经过挑战绑定的 C2C 身份。若私聊投递不可用，结果不会退回群内公开，避免泄露隐藏检定。',
  },
  {
    id: 14,
    title: 'COC7 对抗检定',
    ruleSet: 'coc7',
    keywords: ['对抗', 'rav', 'rcv', '成功度'],
    content:
      '对抗检定先比较双方成功等级；等级相同再比较技能值，仍相同则平局。代骰目标必须来自平台已验证的提及身份和其绑定角色卡。',
  },
  {
    id: 15,
    title: 'DND5E 技能与熟练加值',
    ruleSet: 'dnd5e',
    keywords: ['熟练', '技能', '豁免', 'proficiency', 'buff'],
    content:
      '技能检定由 d20、父属性调整值、技能数值和熟练加值组成。半熟练与熟练分别按熟练加值的一半和全部计算，临时加值单独叠加。',
  },
  {
    id: 16,
    title: '无放回牌堆',
    ruleSet: 'general',
    keywords: ['牌堆', 'draw', 'deck', '抽牌'],
    content:
      '内置牌堆按会话维护无放回状态。牌抽尽前不会重复；reset 只重置当前会话抽取状态，不会重新加载编译期资源。',
  },
  {
    id: 17,
    title: '跑团日志与私有归档',
    ruleSet: 'general',
    keywords: ['日志', 'log', '归档', '下载'],
    content:
      '日志正文记录到私有存储并异步归档。下载必须由授权身份申请短期令牌；删除先撤销令牌并进入不可下载状态，再清理对象和数据库正文。',
  },
];

export interface SearchGlossaryResult {
  readonly query: string;
  readonly matches: readonly RuleGlossaryEntry[];
}

export function searchRuleGlossary(query: string, limit = 3): SearchGlossaryResult {
  const q = query.trim().toLowerCase();
  if (!q) {
    return { query, matches: [] };
  }
  const idMatch = /^#?(\d+)$/.exec(q);
  if (idMatch) {
    const id = Number.parseInt(idMatch[1] ?? '', 10);
    const entry = BUILTIN_RULE_GLOSSARY.find((candidate) => candidate.id === id);
    return { query, matches: entry ? [entry] : [] };
  }

  const scored: Array<{ entry: RuleGlossaryEntry; score: number }> = [];

  for (const entry of BUILTIN_RULE_GLOSSARY) {
    let score = 0;
    const titleLower = entry.title.toLowerCase();

    if (titleLower === q) {
      score += 100;
    } else if (titleLower.includes(q)) {
      score += 50;
    }

    for (const kw of entry.keywords) {
      const kwLower = kw.toLowerCase();
      if (kwLower === q) {
        score += 80;
      } else if (kwLower.includes(q)) {
        score += 30;
      }
    }

    if (entry.content.toLowerCase().includes(q)) {
      score += 10;
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    query,
    matches: scored.slice(0, limit).map((s) => s.entry),
  };
}

export function listRuleGlossary(
  ruleSet?: RuleGlossaryEntry['ruleSet'],
): readonly RuleGlossaryEntry[] {
  return ruleSet
    ? BUILTIN_RULE_GLOSSARY.filter((entry) => entry.ruleSet === ruleSet)
    : BUILTIN_RULE_GLOSSARY;
}
