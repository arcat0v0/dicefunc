export interface CocRuleCheckOutcome {
  readonly successRank: number;
  readonly criticalSuccessValue: number;
}

export interface CocHouseRuleDef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly desc: string;
}

export const COC_HOUSE_RULES: readonly CocHouseRuleDef[] = [
  {
    id: '0',
    key: '0',
    name: '规则书规则',
    desc: '出1大成功\n不满50出96-100大失败，满50出100大失败(COC7规则书)',
  },
  {
    id: '1',
    key: '1',
    name: '常用规则一',
    desc: '不满50出1大成功，满50出1-5大成功\n不满50出96-100大失败，满50出100大失败',
  },
  {
    id: '2',
    key: '2',
    name: '国内常用规则',
    desc: '出1-5且判定成功为大成功\n出96-100且判定失败为大失败',
  },
  {
    id: '3',
    key: '3',
    name: '严格规则',
    desc: '出1-5大成功\n出96-100大失败(即大成功/大失败时无视判定结果)',
  },
  {
    id: '4',
    key: '4',
    name: '无大成功规则',
    desc: '出1-5且≤(成功率/10)为大成功\n不满50出>=96+(成功率/10)为大失败，满50出100大失败',
  },
  {
    id: '5',
    key: '5',
    name: '老版规则',
    desc: '出1-2且≤(成功率/5)为大成功\n不满50出96-100大失败，满50出99-100大失败',
  },
  {
    id: 'dg',
    key: 'dg',
    name: 'DeltaGreen',
    desc: '出1或检定成功基础上个位十位相同为大成功\n出100或检定失败基础上个位十位相同为大失败\n此规则无困难成功或极难成功',
  },
];

const RULE_ID_BY_KEY: Record<string, string> = Object.fromEntries(
  COC_HOUSE_RULES.map((r) => [r.key, r.id]),
);

export function resolveCocHouseRule(key: string): CocHouseRuleDef | undefined {
  const id = RULE_ID_BY_KEY[key.toLowerCase()];
  if (id === undefined) {
    return undefined;
  }
  return COC_HOUSE_RULES.find((r) => r.id === id);
}

export function resultCheckBase(
  ruleId: string,
  d100: number,
  attrValue: number,
): CocRuleCheckOutcome {
  const rule = ruleId === 'dg' ? 'dg' : ruleId;
  let criticalSuccessValue = 1;
  let fumbleValue = 100;

  const successPass = d100 <= attrValue ? 1 : -1;

  switch (rule) {
    case '0':
      if (attrValue < 50) {
        fumbleValue = 96;
      }
      break;
    case '1':
      if (attrValue >= 50) {
        criticalSuccessValue = 5;
      }
      if (attrValue < 50) {
        fumbleValue = 96;
      }
      break;
    case '2':
      criticalSuccessValue = 5;
      if (attrValue < criticalSuccessValue) {
        criticalSuccessValue = attrValue;
      }
      fumbleValue = 96;
      if (attrValue >= fumbleValue) {
        fumbleValue = attrValue + 1;
        if (fumbleValue > 100) {
          fumbleValue = 100;
        }
      }
      break;
    case '3':
      criticalSuccessValue = 5;
      fumbleValue = 96;
      break;
    case '4':
      criticalSuccessValue = Math.floor(attrValue / 10);
      if (criticalSuccessValue > 5) {
        criticalSuccessValue = 5;
      }
      fumbleValue = 96 + Math.floor(attrValue / 10);
      if (fumbleValue > 100) {
        fumbleValue = 100;
      }
      break;
    case '5':
      criticalSuccessValue = Math.floor(attrValue / 5);
      if (criticalSuccessValue > 2) {
        criticalSuccessValue = 2;
      }
      if (attrValue < 50) {
        fumbleValue = 96;
      } else {
        fumbleValue = 99;
      }
      break;
    case 'dg':
      criticalSuccessValue = 1;
      fumbleValue = 100;
      break;
  }

  let successRank = successPass;

  if (successPass === 1 || d100 <= criticalSuccessValue) {
    if (d100 <= Math.floor(attrValue / 2)) {
      successRank = 2;
    }
    if (d100 <= Math.floor(attrValue / 5)) {
      successRank = 3;
    }
    if (d100 <= criticalSuccessValue) {
      successRank = 4;
    }
  } else if (d100 >= fumbleValue) {
    successRank = -2;
  }

  if (rule === '0' || rule === '1' || rule === '2') {
    if (d100 === 1) {
      successRank = 4;
    }
  }

  if (d100 === 100 && rule === '0') {
    successRank = -2;
  }

  if (rule === '3') {
    if (d100 <= criticalSuccessValue) {
      successRank = 4;
    }
    if (d100 >= fumbleValue) {
      successRank = -2;
    }
  }

  if (rule === 'dg') {
    const numUnits = d100 % 10;
    const numTens = Math.floor((d100 % 100) / 10);
    const dgCheck = numUnits === numTens;

    if (successRank > 0) {
      successRank = dgCheck ? 4 : 1;
    } else {
      successRank = dgCheck ? -2 : -1;
    }

    if (d100 === 1) {
      successRank = 4;
    }
  }

  return { successRank, criticalSuccessValue };
}
