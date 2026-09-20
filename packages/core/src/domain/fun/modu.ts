export interface CnmodsModuleSummary {
  readonly keyId: number;
  readonly title: string;
  readonly article: string;
  readonly moduleVersion?: string | undefined;
  readonly moduleAge?: string | undefined;
  readonly occurrencePlace?: string | undefined;
}

export interface CnmodsSearchResponseData {
  readonly list: readonly CnmodsModuleSummary[];
  readonly totalElements: number;
  readonly totalPages: number;
}

export interface CnmodsModuleDetail {
  readonly keyId: number;
  readonly title: string;
  readonly article: string;
  readonly moduleAge: string;
  readonly occurrencePlace: string;
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly minDuration: number;
  readonly maxDuration: number;
  readonly original: boolean;
  readonly opinion: string;
}

export async function fetchCnmodsSearch(
  keyword: string,
  page = 1,
  isRec = false,
  author = '',
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = 5000,
): Promise<CnmodsSearchResponseData | null> {
  const url = new URL('https://www.cnmods.net/prod-api/index/moduleListPage.do');
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', '7');

  if (isRec) {
    url.searchParams.set('command', 'true');
  }
  if (author) {
    url.searchParams.set('article', author);
  } else if (keyword) {
    url.searchParams.set('title', keyword);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetcher(url.toString(), {
      method: 'GET',
      headers: {
        Referer: 'https://www.cnmods.net/web/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      code?: number;
      data?: {
        list?: Array<{
          keyId: number;
          title: string;
          article: string;
          moduleVersion?: string;
          moduleAge?: string;
          occurrencePlace?: string;
        }>;
        totalElements?: number;
        totalPages?: number;
      };
    };

    const inner = data?.data;
    if (!inner || !Array.isArray(inner.list)) {
      return null;
    }

    return {
      list: inner.list.map((item) => ({
        keyId: item.keyId,
        title: item.title,
        article: item.article,
        ...(item.moduleVersion ? { moduleVersion: item.moduleVersion } : {}),
        ...(item.moduleAge ? { moduleAge: item.moduleAge } : {}),
        ...(item.occurrencePlace ? { occurrencePlace: item.occurrencePlace } : {}),
      })),
      totalElements: inner.totalElements ?? inner.list.length,
      totalPages: inner.totalPages ?? 1,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCnmodsDetail(
  keyId: string,
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = 5000,
): Promise<CnmodsModuleDetail | null> {
  const url = new URL('https://www.cnmods.net/prod-api/index/moduleDetail.do');
  url.searchParams.set('keyId', keyId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetcher(url.toString(), {
      method: 'GET',
      headers: {
        Referer: 'https://www.cnmods.net/web/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      data?: {
        module?: {
          keyId: number;
          title: string;
          article: string;
          moduleAge: string;
          occurrencePlace: string;
          minAmount: number;
          maxAmount: number;
          minDuration: number;
          maxDuration: number;
          original: boolean;
          opinion: string;
        };
      };
    };

    const mod = data?.data?.module;
    if (!mod) {
      return null;
    }

    const cleanOpinion = mod.opinion ? mod.opinion.replace(/<[^>]*>/g, '').trim() : '';

    return {
      keyId: mod.keyId,
      title: mod.title,
      article: mod.article,
      moduleAge: mod.moduleAge ?? '',
      occurrencePlace: mod.occurrencePlace ?? '',
      minAmount: mod.minAmount ?? 1,
      maxAmount: mod.maxAmount ?? 4,
      minDuration: mod.minDuration ?? 1,
      maxDuration: mod.maxDuration ?? 4,
      original: Boolean(mod.original),
      opinion: cleanOpinion,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatCnmodsSearchResult(page: number, data: CnmodsSearchResponseData): string {
  if (data.list.length === 0) {
    return '什么也没发现';
  }

  const lines = data.list.map((item) => {
    const ver = item.moduleVersion === 'coc6th' ? '[coc6]' : '';
    const agePlace = `${item.moduleAge ?? ''}${item.occurrencePlace ?? ''}`.trim();
    return `[${item.keyId}]${ver}${item.title} ${agePlace} - by ${item.article}`;
  });

  return `来自cnmods的搜索结果 - ${page}/${data.totalPages}页${data.totalElements}项:\n${lines.join('\n')}`;
}

export function formatCnmodsDetail(item: CnmodsModuleDetail): string {
  const ori = item.original ? '是' : '否';
  return (
    `[${item.keyId}]${item.title}\n` +
    `作者: ${item.article}\n` +
    `背景: ${item.moduleAge},${item.occurrencePlace}\n` +
    `规模: ${item.minAmount}-${item.maxAmount}人，${item.minDuration}-${item.maxDuration}时\n` +
    `原创: ${ori}\n` +
    `简介: ${item.opinion}\n` +
    `PC端链接：https://www.cnmods.net/web/moduleDetail?keyId=${item.keyId}\n` +
    `移动端链接：https://www.cnmods.net/mobile/moduleDetail?keyId=${item.keyId}`
  );
}
