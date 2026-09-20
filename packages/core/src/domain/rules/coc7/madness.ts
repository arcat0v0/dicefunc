import type { RandomSource } from '../../../ports/random-source.js';
import { lookupFearSymptom, lookupManiaSymptom } from './symptoms.js';

export type MadnessKind = 'temporal' | 'summary';

export interface MadnessSymptomResult {
  readonly kind: MadnessKind;
  readonly optionRoll: number;
  readonly extraRoll1: number;
  readonly extraRoll2?: number | undefined;
  readonly expressionText: string;
  readonly description: string;
}

const TEMPORAL_SYMPTOM_TEMPLATES: Record<number, string> = {
  1: '失忆：调查员会发现自己只记得最后身处的安全地点，却没有任何来到这里的记忆。例如，调查员前一刻还在家中吃着早饭，下一刻就已经直面着不知名的怪物。这将会持续 1D10={d1} 轮。',
  2: '假性残疾：调查员陷入了心理性的失明，失聪以及躯体缺失感中，持续 1D10={d1} 轮。',
  3: '暴力倾向：调查员陷入了六亲不认的暴力行为中，对周围的敌人与友方进行着无差别的攻击，持续 1D10={d1} 轮。',
  4: '偏执：调查员陷入了严重的偏执妄想之中。有人在暗中窥视着他们，同伴中有人背叛了他们，没有人可以信任，万事皆虚。持续 1D10={d1} 轮',
  5: '人际依赖：守秘人适当参考调查员的背景中重要之人的条目，调查员因为一些原因而将他人误认为了他重要的人并且努力的会与那个人保持那种关系，持续 1D10={d1} 轮',
  6: '昏厥：调查员当场昏倒，并需要 1D10={d1} 轮才能苏醒。',
  7: '逃避行为：调查员会用任何的手段试图逃离现在所处的位置，即使这意味着开走唯一一辆交通工具并将其它人抛诸脑后，调查员会试图逃离 1D10={d1} 轮。',
  8: '歇斯底里：调查员表现出大笑，哭泣，嘶吼，害怕等的极端情绪表现，持续 1D10={d1} 轮。',
  9: '恐惧：调查员通过一次 D100 或者由守秘人选择，来从恐惧症状表中选择一个恐惧源，就算这一恐惧的事物是并不存在的，调查员的症状会持续 1D10={d1} 轮。',
  10: '躁狂：调查员通过一次 D100 或者由守秘人选择，来从躁狂症状表中选择一个躁狂的诱因，这个症状将会持续 1D10={d1} 轮。',
};

const SUMMARY_SYMPTOM_TEMPLATES: Record<number, string> = {
  1: '失忆：回过神来，调查员们发现自己身处一个陌生的地方，并忘记了自己是谁。记忆会随时间恢复。',
  2: '被窃：调查员在 1D10={d1} 小时后恢复清醒，发觉自己被盗，身体毫发无损。如果调查员携带着宝贵之物（见调查员背景），做幸运检定来决定其是否被盗。所有有价值的东西无需检定自动消失。',
  3: '遍体鳞伤：调查员在 1D10={d1} 小时后恢复清醒，发现自己身上满是拳痕和瘀伤。生命值减少到疯狂前的一半，但这不会造成重伤。调查员没有被窃。这种伤害如何持续到现在由守秘人决定。',
  4: '暴力倾向：调查员陷入强烈的暴力与破坏欲之中。调查员回过神来可能会理解自己做了什么也可能毫无印象。调查员对谁或何物施以暴力，他们是杀人还是仅仅造成了伤害，由守秘人决定。',
  5: '极端信念：查看调查员背景中的思想信念，调查员会采取极端和疯狂的表现手段展示他们的思想信念之一。比如一个信教者会在地铁上高声布道。',
  6: '重要之人：考虑调查员背景中的重要之人，及其重要的原因。在 1D10={d1} 小时或更久的时间中，调查员将不顾一切地接近那个人，并为他们之间的关系做出行动。',
  7: '被收容：调查员在精神病院病房或警察局牢房中回过神来，他们可能会慢慢回想起导致自己被关在这里的事情。',
  8: '逃避行为：调查员恢复清醒时发现自己在很远的地方，也许迷失在荒郊野岭，或是在驶向远方的列车或长途汽车上。',
  9: '恐惧：调查员患上一个新的恐惧症状。在恐惧症状表上骰 1 个 D100 来决定症状，或由守秘人选择一个。调查员在 1D10={d1} 小时后回过神来，并开始为避开恐惧源而采取任何措施。',
  10: '狂躁：调查员患上一个新的狂躁症状。在狂躁症状表上骰 1 个 d100 来决定症状，或由守秘人选择一个。调查员会在 1D10={d1} 小时后恢复理智。在这次疯狂发作中，调查员将完全沉浸于其新的狂躁症状。这症状是否会表现给旁人则取决于守秘人和此调查员。',
};

function interpolate(template: string, d1: number): string {
  return template.replaceAll('{d1}', String(d1));
}

export async function rollMadnessSymptom(
  kind: MadnessKind,
  random: RandomSource,
): Promise<MadnessSymptomResult> {
  const optionRoll = await random.integer(1, 10);
  const extraRoll1 = await random.integer(1, 10);
  const expressionText = `1D10=${optionRoll}`;

  const templates = kind === 'temporal' ? TEMPORAL_SYMPTOM_TEMPLATES : SUMMARY_SYMPTOM_TEMPLATES;
  const template = templates[optionRoll] ?? '';
  let description = interpolate(template, extraRoll1);

  let extraRoll2: number | undefined;
  if (optionRoll === 9 || optionRoll === 10) {
    extraRoll2 = await random.integer(1, 100);
    const symptom =
      optionRoll === 9 ? lookupFearSymptom(extraRoll2) : lookupManiaSymptom(extraRoll2);
    description += `\n1D100=${extraRoll2}\n${symptom}`;
  }

  return {
    kind,
    optionRoll,
    extraRoll1,
    ...(extraRoll2 !== undefined ? { extraRoll2 } : {}),
    expressionText,
    description,
  };
}
