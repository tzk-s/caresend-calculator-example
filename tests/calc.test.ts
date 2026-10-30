/**
 * 試算ロジック（calc.ts）のテスト
 *
 * 画面を通さずに確認したいもの:
 *  - 入力値の境界（下限・上限・範囲外・小数・負数・全角・先頭の 0）
 *  - 計算式・地域の割合の端数処理（四捨五入）・消費税の端数処理（切り捨て）
 */
import { describe, it, expect } from 'vitest';
import { TABLE_SPECS, type MasterItem } from '../src/simulator/rates';
import { LIMITS, calculateEstimate, parseCondition, formatYen } from '../src/simulator/calc';

const MAX_HOURLY_RATE = TABLE_SPECS.jobs.max;

describe('parseCondition', () => {
  it.each(Object.entries(LIMITS))('%s: 下限・上限ちょうどは有効、その外側は無効', (key, { min, max }) => {
    const field = key as keyof typeof LIMITS;
    expect(parseCondition(field, String(min))).toEqual({ ok: true, value: min });
    expect(parseCondition(field, String(max))).toEqual({ ok: true, value: max });
    expect(parseCondition(field, String(min - 1)).ok).toBe(false);
    expect(parseCondition(field, String(max + 1)).ok).toBe(false);
  });

  it('空欄・小数・負数・文字は理由つきでエラー', () => {
    expect(parseCondition('headcount', ' ')).toEqual({ ok: false, message: '入力してください' });
    expect(parseCondition('headcount', '1.5')).toEqual({ ok: false, message: '半角の整数で入力してください' });
    expect(parseCondition('headcount', '-1').ok).toBe(false);
    expect(parseCondition('headcount', 'abc').ok).toBe(false);
  });

  it('「020」「01」のような先頭の 0 はエラー（0 単体は範囲外として扱う）', () => {
    expect(parseCondition('headcount', '020')).toEqual({ ok: false, message: '先頭の0を除いて入力してください' });
    expect(parseCondition('headcount', '01')).toEqual({ ok: false, message: '先頭の0を除いて入力してください' });
    expect(parseCondition('daysPerMonth', '０２０')).toEqual({ ok: false, message: '先頭の0を除いて入力してください' });
    expect(parseCondition('headcount', '0')).toEqual({ ok: false, message: '1〜20の範囲で入力してください' });
  });

  it('全角数字は半角として受け付ける', () => {
    expect(parseCondition('daysPerMonth', '２０')).toEqual({ ok: true, value: 20 });
  });
});

describe('calculateEstimate', () => {
  const job: MasterItem = { id: 'a', label: '介護福祉士', value: 2400, sortOrder: 1 };
  const base: MasterItem = { id: 'other', label: 'その他の地域', value: 100, sortOrder: 1 };

  it('単価 × 時間 × 日数 × 人数 に消費税 10% を足す', () => {
    const estimate = calculateEstimate(base, job, 2, 8, 20);
    expect(estimate.monthlyHoursPerPerson).toBe(160);
    expect(estimate.subtotal).toBe(768000);
    expect(estimate.tax).toBe(76800);
    expect(estimate.total).toBe(844800);
  });

  it('人数・時間・日数・単価のどれを変えても比例して変わる', () => {
    const one = calculateEstimate(base, job, 1, 8, 20).subtotal;
    expect(calculateEstimate(base, job, 3, 8, 20).subtotal).toBe(one * 3);
    expect(calculateEstimate(base, job, 1, 4, 20).subtotal).toBe(one / 2);
    expect(calculateEstimate(base, job, 1, 8, 10).subtotal).toBe(one / 2);
    expect(calculateEstimate(base, { ...job, value: 4800 }, 1, 8, 20).subtotal).toBe(one * 2);
  });

  it('地域の割合を時間単価に掛け、1 円未満は四捨五入する', () => {
    expect(calculateEstimate({ ...base, value: 115 }, job, 1, 1, 1).hourlyRate).toBe(2760);
    // 1999 × 1.05 = 2098.95 → 2099
    expect(calculateEstimate({ ...base, value: 105 }, { ...job, value: 1999 }, 1, 1, 1).hourlyRate).toBe(2099);
    // 1990 × 1.05 = 2089.5 → 2090
    expect(calculateEstimate({ ...base, value: 105 }, { ...job, value: 1990 }, 1, 1, 1).hourlyRate).toBe(2090);
  });

  it('地域の割合を変えると月額も比例して変わる', () => {
    const standard = calculateEstimate(base, job, 2, 8, 20).subtotal;
    expect(calculateEstimate({ ...base, value: 150 }, job, 2, 8, 20).subtotal).toBe(standard * 1.5);
  });

  it('消費税の 1 円未満は切り捨てる', () => {
    const estimate = calculateEstimate(base, { ...job, value: 1999 }, 1, 1, 1);
    expect(estimate.tax).toBe(199);
    expect(estimate.total).toBe(2198);
  });

  it('すべて上限値でも整数の範囲で正確に計算できる', () => {
    const { headcount, hoursPerDay, daysPerMonth } = LIMITS;
    const estimate = calculateEstimate(
      { ...base, value: TABLE_SPECS.regions.max },
      { ...job, value: MAX_HOURLY_RATE },
      headcount.max,
      hoursPerDay.max,
      daysPerMonth.max
    );
    expect(Number.isSafeInteger(estimate.total)).toBe(true);
    expect(estimate.subtotal).toBe(MAX_HOURLY_RATE * 3 * 20 * 12 * 23);
  });

  it('金額は 3 桁区切りで表示する', () => {
    expect(formatYen(844800)).toBe('844,800');
  });
});
