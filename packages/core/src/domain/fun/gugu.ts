import type { RandomSource } from '../../ports/random-source.js';

export interface GuguEntry {
  readonly template: string;
  readonly author: string;
}

export const GUGU_ENTRIES: readonly GuguEntry[] = [
  {
    template: '{$t玩家}为了拯救公主前往了巨龙的巢穴，还没赶回来！',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '{$t玩家}在来开团的路上被巨龙叼走了！', author: '鹊鹊结合实际经历创作' },
  {
    template: '来的路上出现了哥布林劫匪！{$t玩家}大概是赶不过来了！',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '咕咕咕~广场上的鸽子把{$t玩家}叼回了巢穴~', author: '鹊鹊结合实际经历创作' },
  {
    template: '为了拯救不慎滑落下水道的一元硬币，{$t玩家}化身搜救队英勇赶赴！',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '{$t玩家}睡着了——zzzzzzzz......', author: '鹊鹊结合实际经历创作' },
  {
    template: '在聚会上完全喝断片的{$t玩家}被半兽人三兄弟抬走咯~！♡',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '{$t玩家}在地铁上睡着了，不断前行的车厢逐渐带他来到了最终站点...mogeko~！',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '今天绿色章鱼俱乐部有活动，来不了了呢——by{$t玩家}', author: '鹊鹊结合实际经历创作' },
  {
    template:
      '“喂？跑团？啊，抱歉可能有点事情来不了了”你听着{$t玩家}电话背景音里一阵阵未知语言咏唱的声音，开始明白他现在很忙。',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '给{$t玩家}打电话的时候，自己关注的vtb的电话也正好响了起来...',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '因为被长发龙男逼到了小巷子，{$t玩家}大概没心思思考别的事情了。',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '在海边散步的时候，突然被触手拉入海底的{$t玩家}！', author: '鹊鹊结合实际经历创作' },
  {
    template: '“来不了了，对不起...”电话对面的{$t玩家}房间里隐约传来阵阵喘息。',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '黄色雨衣团真是赛高~！综上所述今天要去参加活动，来不了了哦~！——by{$t玩家}',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '{$t玩家}正在看书，啊！不好！他被知识的巨浪冲走了！搜救队——！！！',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '为了帮助突然晕倒的程序员木落，{$t玩家}错过了开团时间，撑住啊木落！！！',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template:
      '由于尝试邪神召唤而来到异界的{$t玩家}，好了，这下该怎么回去呢？距离开团还有5...3...1...',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template:
      '不慎穿越的{$t玩家}！但是接下来还有团！这一切该如何是好？《心跳！穿越到异世界了这下不得不咕咕掉跑团了呢~！》好评发售~！',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '因为海豹一直缠着{$t玩家}，所以只好先陪他玩啦——', author: '鹊鹊结合实际经历创作' },
  {
    template: '开开心心准备开团的时候，几只大蜘蛛破窗而入！啊！{$t玩家}被他们劫走了！！！',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template:
      '“没想到食尸鬼俱乐部的大家不是化妆特效...以后可能再也没法儿一起玩了...”{$t玩家}发来了这种意义不明的短信。',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template:
      '“走在马路上被突如其来的龙娘威胁了，现在在小巷子里！！！请大家带一万金币救我！！！”{$t玩家}在电话里这样说。',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template: '因为沉迷vtb而完全忘记开团的{$t玩家}，毕竟太可爱了所以原谅他吧~！',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template:
      '观看海豹顶球的时候站的太近被溅了一身水，换衣服的功夫{$t玩家}发现开团时间已经错过了。',
    author: '鹊鹊结合实际经历创作',
  },
  {
    template:
      '不知为什么平坦的路面上会躺着一只海豹，就那样玩着手机没注意就被绊倒昏过去了！可怜的{$t玩家}！',
    author: '鹊鹊结合实际经历创作',
  },
  { template: '{$t玩家}去依盖队大本营给大家抢香蕉了。', author: 'yumeno结合实际经历创作' },
  {
    template: '“我家金鱼淹死了，要去处理一下，晚点再来”原来如此，节哀{$t玩家}！',
    author: 'yumeno结合实际经历创作',
  },
  {
    template:
      '“我家狗在学校被老师请家长，今天不来了”这条{$t玩家}的短信让你打开手机开始搜索狗学校。',
    author: 'yumeno结合实际经历创作',
  },
  {
    template: '“钱不够坐车回家，待我走回去先”{$t玩家}你其实知道手机可以支付车费的吧？',
    author: 'yumeno结合实际经历创作',
  },
  { template: '救命！我变成鸽子了！——by{$t玩家}的短信。', author: 'yumeno结合实际经历创作' },
  {
    template: '老板让我现在回去加班，我正在写辞呈。{$t玩家}一边内卷一边对着电话这样说。',
    author: 'yumeno结合实际经历创作',
  },
  {
    template: '键盘坏了，快递还没送到，今晚不开——by{$t玩家}的短信。',
    author: 'yumeno结合实际经历创作',
  },
];

export async function getRandomGugu(
  random: RandomSource,
  actorName: string,
  showAuthor = false,
): Promise<string> {
  const index = await random.integer(0, GUGU_ENTRIES.length - 1);
  const entry = GUGU_ENTRIES[index] ?? GUGU_ENTRIES[0];
  const text = entry ? entry.template.replaceAll('{$t玩家}', actorName) : '咕咕咕~';
  if (showAuthor && entry) {
    return `🕊️: ${text}\n    ——${entry.author}`;
  }
  return `🕊️: ${text}`;
}
