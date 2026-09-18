import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type KeepDropType,
  applyKeepDrop,
  createWebCryptoRandomSource,
  parseDiceExpression,
  rollDice,
} from '@dicefunc/core';

export interface SimulateOptions {
  scene?: string | undefined;
  message?: string | undefined;
  fixture?: string | undefined;
}

interface LocalParseResult {
  faces: number;
  count: number;
  keepDrop?: KeepDropType | undefined;
  keepCount?: number | undefined;
  modifier: number;
  reason?: string | undefined;
}

function parseExpressionString(raw: string): LocalParseResult | null {
  const trimmed = raw.trim();
  const pattern = /^(\d+)?d(\d+)(?:\s*(kl|kh|dl|dh)\s*(\d+))?([+-]\d+)?(?:\s+(.+))?$/i;
  const match = trimmed.match(pattern);

  if (!match) {
    const singleNumPattern = /^(\d+)(?:\s+(.+))?$/;
    const singleMatch = trimmed.match(singleNumPattern);
    if (singleMatch?.[1]) {
      return {
        faces: Number.parseInt(singleMatch[1], 10),
        count: 1,
        modifier: 0,
        reason: singleMatch[2]?.trim(),
      };
    }
    return null;
  }

  const countStr = match[1];
  const facesStr = match[2];
  const keepDropOp = match[3];
  const keepCountStr = match[4];
  const modifierStr = match[5];
  const reason = match[6]?.trim();

  if (!facesStr) {
    return null;
  }

  const count = countStr ? Number.parseInt(countStr, 10) : 1;
  const faces = Number.parseInt(facesStr, 10);
  const keepCount = keepCountStr ? Number.parseInt(keepCountStr, 10) : undefined;
  const modifier = modifierStr ? Number.parseInt(modifierStr, 10) : 0;

  if (Number.isNaN(count) || count <= 0 || Number.isNaN(faces) || faces <= 0) {
    return null;
  }

  const keepDrop = keepDropOp ? (keepDropOp.toLowerCase() as KeepDropType) : undefined;

  return {
    faces,
    count,
    keepDrop,
    keepCount,
    modifier,
    reason,
  };
}

export async function runSimulate(options: SimulateOptions): Promise<void> {
  if (options.fixture) {
    const fixturePath = path.resolve(options.fixture);
    let hasData = false;
    if (fs.existsSync(fixturePath)) {
      const stat = fs.statSync(fixturePath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(fixturePath);
        hasData = entries.length > 0;
      } else if (stat.isFile()) {
        const content = fs.readFileSync(fixturePath, 'utf-8').trim();
        hasData = content.length > 0;
      }
    }
    if (!hasData) {
      console.log(`提示：无 fixture 数据 (${options.fixture})，将基于消息内容直接模拟。`);
    }
  }

  const message = options.message || '.r 1d100';
  const scene = options.scene || 'groupAt';

  const diceCmdMatch = message.match(/^\s*\.?(?:r|roll)(?:\s+(.*))?$/i);
  if (!diceCmdMatch) {
    console.log(`非骰点命令尚未支持: ${message}`);
    return;
  }

  const exprStr = diceCmdMatch[1]?.trim() || '1d100';

  let parsed: LocalParseResult | null = null;
  try {
    if (typeof parseDiceExpression === 'function') {
      const res = parseDiceExpression(exprStr);
      if (res?.success && res.expression) {
        parsed = {
          faces: res.expression.faces,
          count: res.expression.count,
          keepDrop: res.expression.keepDrop,
          keepCount: res.expression.keepCount,
          modifier: res.expression.modifier ?? 0,
          reason: res.expression.reason,
        };
      }
    }
  } catch {
    parsed = null;
  }

  if (!parsed) {
    parsed = parseExpressionString(exprStr);
  }

  if (!parsed) {
    console.error(`无法解析掷骰表达式: ${exprStr}`);
    process.exit(1);
  }

  const randomSource = createWebCryptoRandomSource();
  const rawRolls = await rollDice(parsed.faces, parsed.count, randomSource);

  let finalRolls = rawRolls;
  if (parsed.keepDrop && parsed.keepCount) {
    finalRolls = applyKeepDrop(rawRolls, parsed.keepDrop, parsed.keepCount);
  }

  const rollSum = finalRolls.reduce((sum, n) => sum + n, 0);
  const total = rollSum + parsed.modifier;

  console.log(`场景: ${scene}`);
  console.log(`消息: ${message}\n`);
  console.log('模拟掷骰结果:');
  console.log(`  表达式: ${exprStr}`);
  console.log(`  出目明细: [${rawRolls.join(', ')}]`);
  if (parsed.keepDrop && parsed.keepCount) {
    console.log(`  保留操作: ${parsed.keepDrop} ${parsed.keepCount} -> [${finalRolls.join(', ')}]`);
  }
  if (parsed.modifier !== 0) {
    console.log(`  修正值: ${parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier}`);
  }
  console.log(`  最终出目: ${total}`);
  if (parsed.reason) {
    console.log(`  原因: ${parsed.reason}`);
  }
}
