import { type Card, type Deck, createDeck } from './deck.js';

const TAROT_CARDS: readonly Card[] = [
  { id: '0', text: '0 - 愚者 (The Fool)', weight: 1 },
  { id: '1', text: 'I - 魔术师 (The Magician)', weight: 1 },
  { id: '2', text: 'II - 女祭司 (The High Priestess)', weight: 1 },
  { id: '3', text: 'III - 女皇 (The Empress)', weight: 1 },
  { id: '4', text: 'IV - 皇帝 (The Emperor)', weight: 1 },
  { id: '5', text: 'V - 教皇 (The Hierophant)', weight: 1 },
  { id: '6', text: 'VI - 恋人 (The Lovers)', weight: 1 },
  { id: '7', text: 'VII - 战车 (The Chariot)', weight: 1 },
  { id: '8', text: 'VIII - 力量 (Strength)', weight: 1 },
  { id: '9', text: 'IX - 隐士 (The Hermit)', weight: 1 },
  { id: '10', text: 'X - 命运之轮 (Wheel of Fortune)', weight: 1 },
  { id: '11', text: 'XI - 正义 (Justice)', weight: 1 },
  { id: '12', text: 'XII - 倒吊人 (The Hanged Man)', weight: 1 },
  { id: '13', text: 'XIII - 死神 (Death)', weight: 1 },
  { id: '14', text: 'XIV - 节制 (Temperance)', weight: 1 },
  { id: '15', text: 'XV - 恶魔 (The Devil)', weight: 1 },
  { id: '16', text: 'XVI - 塔 (The Tower)', weight: 1 },
  { id: '17', text: 'XVII - 星星 (The Star)', weight: 1 },
  { id: '18', text: 'XVIII - 月亮 (The Moon)', weight: 1 },
  { id: '19', text: 'XIX - 太阳 (The Sun)', weight: 1 },
  { id: '20', text: 'XX - 审判 (Judgement)', weight: 1 },
  { id: '21', text: 'XXI - 世界 (The World)', weight: 1 },
];

const FATE_CARDS: readonly Card[] = [
  { id: 'da_ji', text: '大吉', weight: 1 },
  { id: 'zhong_ji', text: '中吉', weight: 2 },
  { id: 'xiao_ji', text: '小吉', weight: 3 },
  { id: 'ji', text: '吉', weight: 4 },
  { id: 'mo_ji', text: '末吉', weight: 2 },
  { id: 'xiong', text: '凶', weight: 1 },
  { id: 'da_xiong', text: '大凶', weight: 1 },
];

const BUILTIN_DECKS: readonly Deck[] = [
  createDeck({
    id: 'tarot',
    name: '塔罗牌 (大阿卡那)',
    cards: TAROT_CARDS,
  }),
  createDeck({
    id: 'fate',
    name: '命运签',
    cards: FATE_CARDS,
  }),
];

export function getBuiltinDeck(id: string): Deck | undefined {
  return BUILTIN_DECKS.find((d) => d.id === id.toLowerCase());
}

export function listBuiltinDecks(): readonly Deck[] {
  return BUILTIN_DECKS;
}
