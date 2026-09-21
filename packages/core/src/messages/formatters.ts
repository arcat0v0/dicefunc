import type { CnmodsModuleDetail, CnmodsSearchResponseData } from '../domain/fun/modu.js';
import type { Coc7CardAttributes } from '../domain/rules/coc7/character-gen.js';
import type {
  Dnd5eCardAttributes,
  Dnd5eFreeAllocationCard,
} from '../domain/rules/dnd5e/character-gen.js';
import type { MessageCatalog } from './catalog.js';

function formatCoc7CardBody(catalog: MessageCatalog, card: Coc7CardAttributes): string {
  return catalog.format('coc.card.body', {
    str: card.str,
    dex: card.dex,
    pow: card.pow,
    con: card.con,
    app: card.app,
    edu: card.edu,
    siz: card.siz,
    int: card.int,
    luk: card.luk,
    hp: card.hp,
    db: card.db,
    baseTotal: card.baseTotal,
    totalWithLuck: card.totalWithLuck,
  });
}

export function formatCoc7CardSingle(
  catalog: MessageCatalog,
  actorName: string,
  card: Coc7CardAttributes,
): string {
  return catalog.format('coc.card.header', {
    actor: actorName,
    cards: formatCoc7CardBody(catalog, card),
  });
}

export function formatCoc7CardBatch(
  catalog: MessageCatalog,
  actorName: string,
  cards: readonly Coc7CardAttributes[],
): string {
  return catalog.format('coc.card.header', {
    actor: actorName,
    cards: cards.map((card) => formatCoc7CardBody(catalog, card)).join('\n\n'),
  });
}

export function formatDnd5eFreeCard(
  catalog: MessageCatalog,
  actorName: string,
  cards: readonly Dnd5eFreeAllocationCard[],
): string {
  const lines = cards.map((card) =>
    catalog.format('dnd.card.free_line', {
      numbers: card.numbers.join(', '),
      total: card.total,
    }),
  );
  return catalog.format('dnd.card.free_header', {
    actor: actorName,
    cards: lines.join('\n'),
  });
}

export function formatDnd5ePresetCard(
  catalog: MessageCatalog,
  actorName: string,
  cards: readonly Dnd5eCardAttributes[],
): string {
  const lines = cards.map((card) =>
    catalog.format('dnd.card.preset_line', {
      str: card.str,
      con: card.con,
      dex: card.dex,
      int: card.int,
      wis: card.wis,
      cha: card.cha,
      total: card.total,
    }),
  );
  return catalog.format('dnd.card.preset_header', {
    actor: actorName,
    cards: lines.join('\n'),
  });
}

export function formatCnmodsSearchResult(
  catalog: MessageCatalog,
  page: number,
  data: CnmodsSearchResponseData,
): string {
  if (data.list.length === 0) {
    return catalog.format('fun.modu.empty');
  }

  const lines = data.list.map((item) =>
    catalog.format('fun.modu.search_item', {
      id: item.keyId,
      version: item.moduleVersion === 'coc6th' ? catalog.format('fun.modu.version.coc6') : '',
      title: item.title,
      agePlace: `${item.moduleAge ?? ''}${item.occurrencePlace ?? ''}`.trim(),
      author: item.article,
    }),
  );
  return catalog.format('fun.modu.search_result', {
    page,
    totalPages: data.totalPages,
    totalElements: data.totalElements,
    items: lines.join('\n'),
  });
}

export function formatCnmodsDetail(catalog: MessageCatalog, item: CnmodsModuleDetail): string {
  return catalog.format('fun.modu.detail', {
    id: item.keyId,
    title: item.title,
    author: item.article,
    age: item.moduleAge,
    place: item.occurrencePlace,
    minAmount: item.minAmount,
    maxAmount: item.maxAmount,
    minDuration: item.minDuration,
    maxDuration: item.maxDuration,
    original: catalog.format(item.original ? 'fun.modu.yes' : 'fun.modu.no'),
    opinion: item.opinion,
  });
}
