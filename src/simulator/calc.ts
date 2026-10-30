/**
 * 派遣料金の試算ロジック（DOM に依存しない純粋関数）
 *
 * 画面制御（ui.ts）と分けておくことで、
 * 単価・地域の割合・上限値の変更や境界値をユニットテストだけで確認できる（tests/calc.test.ts）。
 */
import type { MasterItem } from './rates';

/** 入力値の上限・下限。フォームの案内文（ui.ts）もここから生成する。 */
export const LIMITS = {
  headcount: { min: 1, max: 20 },
  hoursPerDay: { min: 1, max: 12 },
  daysPerMonth: { min: 1, max: 23 },
} as const;

export type ConditionKey = keyof typeof LIMITS;

/** 消費税率（%）。整数で持ち、小数の誤差を避ける。 */
export const TAX_RATE_PERCENT = 10;

export interface Estimate {
  region: MasterItem;
  job: MasterItem;
  /** 地域の割合を反映した時間単価（円・税抜） */
  hourlyRate: number;
  headcount: number;
  hoursPerDay: number;
  daysPerMonth: number;
  /** 1 人あたりの月間稼働時間 */
  monthlyHoursPerPerson: number;
  /** 税抜の月額 */
  subtotal: number;
  tax: number;
  /** 税込の月額 */
  total: number;
}

/**
 * フォームの値（文字列）を検証して整数に変換する。
 * 全角数字は半角に直す。空欄・小数・先頭の 0・範囲外はエラーメッセージを返す。
 */
export const parseCondition = (
  key: ConditionKey,
  raw: string
): { ok: true; value: number } | { ok: false; message: string } => {
  const { min, max } = LIMITS[key];
  // 日本語入力のまま打たれた全角数字は半角として受け付ける
  const value = raw.trim().replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  if (value === '') return { ok: false, message: '入力してください' };
  if (!/^\d+$/.test(value)) return { ok: false, message: '半角の整数で入力してください' };
  // 「020」のような先頭の 0 は打ち間違いの可能性が高いため、20 と読み替えずにエラーにする
  if (/^0\d/.test(value)) return { ok: false, message: '先頭の0を除いて入力してください' };

  const number = Number(value);
  if (number < min || number > max) return { ok: false, message: `${min}〜${max}の範囲で入力してください` };
  return { ok: true, value: number };
};

/**
 * 月額を計算する。
 * 時間単価 = 職種の単価 × 地域の割合（1 円未満は四捨五入）。消費税の 1 円未満は切り捨て。
 */
export const calculateEstimate = (
  region: MasterItem,
  job: MasterItem,
  headcount: number,
  hoursPerDay: number,
  daysPerMonth: number
): Estimate => {
  const hourlyRate = Math.round((job.value * region.value) / 100);
  const monthlyHoursPerPerson = hoursPerDay * daysPerMonth;
  const subtotal = hourlyRate * monthlyHoursPerPerson * headcount;
  const tax = Math.floor((subtotal * TAX_RATE_PERCENT) / 100);
  return {
    region,
    job,
    hourlyRate,
    headcount,
    hoursPerDay,
    daysPerMonth,
    monthlyHoursPerPerson,
    subtotal,
    tax,
    total: subtotal + tax,
  };
};

const yenFormatter = new Intl.NumberFormat('ja-JP');

/** 12345 → 「12,345」 */
export const formatYen = (value: number): string => yenFormatter.format(value);
