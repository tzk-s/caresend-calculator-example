/**
 * 料金表 CSV の検証（rates.ts）のテスト
 *
 * 画面を通さずに確認したいもの:
 *  - CSV の書き方の揺れ（引用符・CRLF・BOM・Shift_JIS）を受け付け、壊れた書き方は不採用にすること
 *  - 職種・地域 CSV の検証（列不足・ID 重複・値の不正）で「誤った料金を出さない」こと
 *
 * CSV の解析自体は csv-parse が行う。ここでは「解析結果を計算に渡してよいか」の判断を確認する。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMasterTable, decodeCsv, TABLE_SPECS } from '../src/simulator/rates';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = 'id,label,hourly_rate,sort_order,enabled';
const MAX_HOURLY_RATE = TABLE_SPECS.jobs.max;
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const parseRateTable = (text: string) => parseMasterTable(text, TABLE_SPECS.jobs);
const errorsOf = (text: string) => {
  const result = parseRateTable(text);
  return result.ok ? [] : result.errors;
};

describe('CSV の書き方', () => {
  it('引用符で囲んだカンマ・エスケープされた " を 1 セルとして読む', () => {
    const result = parseRateTable(csv('a,"職種A, 日勤",2000,1,1', 'b,"職種""B""",2100,2,1'));
    expect(result.ok && result.items.map(item => item.label)).toEqual(['職種A, 日勤', '職種"B"']);
  });

  it('BOM・CRLF・末尾の空行を無視する', () => {
    const result = parseRateTable(`\ufeff${HEADER}\r\na,職種A,2000,1,1\r\n\r\n`);
    expect(result.ok && result.items.map(item => item.id)).toEqual(['a']);
  });

  it('途中に空行があっても、エラーの行番号は CSV 上の実際の行を指す', () => {
    const errors = errorsOf(`${HEADER}\na,職種A,2000,1,1\n\nb,職種B,abc,2,1`);
    expect(errors.map(error => error.line)).toEqual([4]);
  });

  it.each([
    ['値の途中の引用符', 'a,職種A,2"4"00,1,1'],
    ['閉じたあとに文字が続く', 'a,職種A,"24"00,1,1'],
    ['閉じていない引用符', 'a,職種A,2400,1,"1'],
  ])('%s は料金表全体を不採用にし、行番号を返す', (_, row) => {
    const errors = errorsOf(csv(row));
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(2);
    expect(errors[0].message).toContain('CSV の形式が正しくありません');
  });

  it('列が足りない行は、空の列として検証エラーになる', () => {
    expect(errorsOf(csv('a,職種A,2000')).map(error => error.message)).toEqual([
      'sort_order「」は整数で入力してください',
      'enabled「」は 1 または 0 で入力してください',
    ]);
  });

  it('CSV が空なら不採用', () => {
    expect(errorsOf('')).toEqual([{ line: 1, message: 'CSV が空です' }]);
  });
});

describe('parseMasterTable（職種）', () => {
  it.each([
    ['rates.csv', TABLE_SPECS.jobs],
    ['regions.csv', TABLE_SPECS.regions],
  ])('同梱の %s が検証を通る', (file, spec) => {
    const text = fs.readFileSync(path.join(root, 'public/data', file), 'utf8');
    expect(parseMasterTable(text, spec).ok).toBe(true);
  });

  it('enabled=0 の行を除外し、sort_order の昇順に並べる', () => {
    const result = parseRateTable(csv('b,職種B,2000,20,1', 'a,職種A,1500,10,1', 'c,職種C,3000,5,0'));
    expect(result.ok && result.items.map(rate => rate.id)).toEqual(['a', 'b']);
  });

  it('列の順番が入れ替わっていても列名で読む', () => {
    const result = parseRateTable('enabled,hourly_rate,id,sort_order,label\n1,2000,a,1,職種A');
    expect(result.ok && result.items[0]).toEqual({ id: 'a', label: '職種A', value: 2000, sortOrder: 1 });
  });

  it('Excel で入りがちな「2,400」や全角数字の単価を受け付ける', () => {
    const result = parseRateTable(csv('a,職種A,"2,400",1,1', 'b,職種B,２１００,2,1'));
    expect(result.ok && result.items.map(rate => rate.value)).toEqual([2400, 2100]);
  });

  it('必須列が無ければ不採用', () => {
    expect(errorsOf('id,label,sort_order,enabled\na,職種A,1,1')[0].message).toContain('hourly_rate');
  });

  it('ID の重複を行番号つきで検出する', () => {
    const errors = errorsOf(csv('a,職種A,2000,1,1', 'a,職種A2,2100,2,1'));
    expect(errors).toEqual([{ line: 3, message: 'id「a」が 2 行目と重複しています' }]);
  });

  it.each([
    ['空欄', ''],
    ['0 円', '0'],
    ['マイナス', '-100'],
    ['小数', '2000.5'],
    ['文字', '2千円'],
    ['上限超え', String(MAX_HOURLY_RATE + 1)],
  ])('単価が不正（%s）なら料金表全体を不採用にする', (_, rate) => {
    const result = parseRateTable(csv('a,職種A,2000,1,1', `b,職種B,${rate},2,1`));
    expect(result.ok).toBe(false);
  });

  it('単価の上限ちょうどは受け付ける', () => {
    expect(parseRateTable(csv(`a,職種A,${MAX_HOURLY_RATE},1,1`)).ok).toBe(true);
  });

  it('非表示（enabled=0）の行に不備があっても不採用にする', () => {
    expect(parseRateTable(csv('a,職種A,2000,1,1', 'b,職種B,abc,2,0')).ok).toBe(false);
  });

  it('enabled・id・label の不正値を検出する', () => {
    expect(errorsOf(csv('a,職種A,2000,1,yes')).length).toBe(1);
    expect(errorsOf(csv('Care Staff,職種A,2000,1,1')).length).toBe(1);
    expect(errorsOf(csv('a,,2000,1,1')).length).toBe(1);
  });

  it('表示できる職種が 0 件なら不採用', () => {
    expect(parseRateTable(csv('a,職種A,2000,1,0')).ok).toBe(false);
    expect(parseRateTable(HEADER).ok).toBe(false);
  });
});

describe('parseMasterTable（地域）', () => {
  const regions = (...rows: string[]) =>
    parseMasterTable(['id,label,rate_percent,sort_order,enabled', ...rows].join('\n'), TABLE_SPECS.regions);

  it('値の列は rate_percent を読む（hourly_rate 列は不要）', () => {
    const result = regions('tokyo,東京都,115,1,1');
    expect(result.ok && result.items[0].value).toBe(115);
  });

  it('割合の下限・上限ちょうどは有効、その外側は無効', () => {
    expect(regions('a,A,50,1,1').ok).toBe(true);
    expect(regions('a,A,300,1,1').ok).toBe(true);
    expect(regions('a,A,49,1,1').ok).toBe(false);
    expect(regions('a,A,301,1,1').ok).toBe(false);
  });

  it('職種 CSV を地域として読み込むと列不足で不採用', () => {
    const result = parseMasterTable(csv('a,職種A,2000,1,1'), TABLE_SPECS.regions);
    expect(!result.ok && result.errors[0].message).toContain('rate_percent');
  });
});

describe('decodeCsv', () => {
  it('UTF-8 と Shift_JIS（Excel の既定保存）のどちらも読める', () => {
    const utf8 = new TextEncoder().encode('介護');
    // 「介護」の Shift_JIS バイト列
    const sjis = new Uint8Array([0x89, 0xee, 0x8c, 0xec]);
    expect(decodeCsv(utf8.buffer as ArrayBuffer)).toBe('介護');
    expect(decodeCsv(sjis.buffer)).toBe('介護');
  });
});

